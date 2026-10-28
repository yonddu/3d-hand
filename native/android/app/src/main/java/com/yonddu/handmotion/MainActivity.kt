package com.yonddu.handmotion

import android.annotation.SuppressLint
import android.Manifest
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Matrix
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.view.Gravity
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.core.UseCaseGroup
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import com.google.mediapipe.framework.image.BitmapImageBuilder
import com.google.mediapipe.tasks.core.BaseOptions
import com.google.mediapipe.tasks.core.Delegate
import com.google.mediapipe.tasks.vision.core.RunningMode
import com.google.mediapipe.tasks.vision.handlandmarker.HandLandmarker
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.Locale

/** Native-only detection baseline. No JavaScript, rig priors or NPU claims. */
class MainActivity : ComponentActivity() {
    private val worker = Executors.newSingleThreadExecutor()
    private val uiQueued = AtomicBoolean(false)
    private var landmarker: HandLandmarker? = null // accessed only on worker
    private var provider: ProcessCameraProvider? = null
    private lateinit var preview: PreviewView
    private lateinit var overlay: LandmarkOverlay
    private lateinit var status: TextView
    private lateinit var recordButton: Button
    private lateinit var saveButton: Button
    private val timing = Timing()
    @Volatile private var ready = false
    @Volatile private var recording = false
    @Volatile private var destroyed = false
    private var frames = JSONArray()
    private var startedAt = 0L
    private var lastTimestamp = -1L
    private var lastUi = 0L
    private var errors = 0
    private var processed = 0
    private var empty = 0
    private var frameWidth = 1
    private var frameHeight = 1
    private var pendingExport: String? = null

    private val permission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) startCamera() else status.text = "카메라 권한이 필요합니다."
    }
    private val saveDocument = registerForActivityResult(ActivityResultContracts.CreateDocument("application/json")) { uri ->
        val data = pendingExport
        pendingExport = null
        if (uri != null && data != null) worker.execute {
            try {
                contentResolver.openOutputStream(uri)?.use { it.write(data.toByteArray(Charsets.UTF_8)) }
                    ?: error("저장 파일을 열 수 없습니다.")
                runOnUiThread { Toast.makeText(this, "측정 기록 저장 완료", Toast.LENGTH_LONG).show() }
            } catch (e: Exception) { showError("저장 실패: ${e.message}") }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(16, 16, 16, 16)
            setOnApplyWindowInsetsListener { view, insets ->
                view.setPadding(16, insets.systemWindowInsetTop + 16, 16, insets.systemWindowInsetBottom + 16)
                insets
            }
        }
        val title = TextView(this).apply {
            text = "Hand Motion · 네이티브 측정\nCPU 기준 / NPU 미적용"
            textSize = 18f
        }
        root.addView(title)
        val stage = FrameLayout(this)
        preview = PreviewView(this).apply {
            scaleType = PreviewView.ScaleType.FIT_CENTER
            implementationMode = PreviewView.ImplementationMode.COMPATIBLE
        }
        overlay = LandmarkOverlay(this)
        stage.addView(preview, FrameLayout.LayoutParams(-1, -1))
        stage.addView(overlay, FrameLayout.LayoutParams(-1, -1))
        root.addView(stage, LinearLayout.LayoutParams(-1, 0, 1f))
        status = TextView(this).apply { text = "손 검출 모델 준비 중…"; textSize = 14f }
        root.addView(status)
        val buttons = LinearLayout(this).apply { gravity = Gravity.CENTER }
        recordButton = Button(this).apply {
            text = "측정 시작"; isEnabled = false
            setOnClickListener {
                isEnabled = false
                if (recording) {
                    recording = false
                    worker.execute { runOnUiThread {
                        recordButton.text = "새 측정"; recordButton.isEnabled = true
                        saveButton.isEnabled = frames.length() > 0
                    } }
                } else worker.execute {
                    frames = JSONArray(); timing.clear(); startedAt = 0
                    processed = 0; empty = 0; errors = 0
                    recording = true
                    runOnUiThread {
                        recordButton.text = "측정 중지"; recordButton.isEnabled = true
                        saveButton.isEnabled = false
                    }
                }
            }
        }
        saveButton = Button(this).apply {
            text = "기록 저장"; isEnabled = false
            setOnClickListener {
                worker.execute {
                    val report = buildReport()
                    runOnUiThread {
                        pendingExport = report
                        saveDocument.launch("hand-native-${System.currentTimeMillis()}.json")
                    }
                }
            }
        }
        buttons.addView(recordButton); buttons.addView(saveButton)
        root.addView(buttons)
        val note = TextView(this).apply {
            text = "후면 카메라 · 원본 관절점 확인용\n카메라 영상은 저장하지 않습니다. 모델은 기기 안에서 실행합니다."
            textSize = 12f
        }
        root.addView(note)
        setContentView(root)
        worker.execute {
            try {
                val options = HandLandmarker.HandLandmarkerOptions.builder()
                    .setBaseOptions(BaseOptions.builder()
                        .setModelAssetPath("hand_landmarker.task")
                        .setDelegate(Delegate.CPU).build())
                    .setRunningMode(RunningMode.VIDEO)
                    .setNumHands(2)
                    .setMinHandDetectionConfidence(0.5f)
                    .setMinHandPresenceConfidence(0.5f)
                    .setMinTrackingConfidence(0.5f)
                    .build()
                landmarker = HandLandmarker.createFromOptions(this, options)
                ready = true
                runOnUiThread {
                    if (!destroyed) { recordButton.isEnabled = true; startCamera() }
                }
            } catch (e: Exception) { showError("모델 시작 실패: ${e.message}") }
        }
    }

    @SuppressLint("MissingPermission") // Runtime permission is checked before asynchronous binding.
    private fun startCamera() {
        if (!ready || destroyed) return
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            permission.launch(Manifest.permission.CAMERA); return
        }
        preview.post {
            if (destroyed) return@post
            val future = ProcessCameraProvider.getInstance(this)
            future.addListener({
                if (destroyed) return@addListener
                try {
                    val camera = future.get()
                    provider = camera
                    val previewUseCase = Preview.Builder().build().also { it.setSurfaceProvider(preview.surfaceProvider) }
                    val analysis = ImageAnalysis.Builder()
                        .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                        .setTargetAspectRatio(androidx.camera.core.AspectRatio.RATIO_16_9)
                        .build()
                    analysis.setAnalyzer(worker) { image ->
                        val entered = SystemClock.elapsedRealtimeNanos()
                        var source: Bitmap? = null
                        var cropped: Bitmap? = null
                        var upright: Bitmap? = null
                        try {
                            // Deliberately measured CPU baseline, not a zero-copy claim.
                            source = image.toBitmap()
                            val rect = image.cropRect
                            cropped = Bitmap.createBitmap(source, rect.left, rect.top, rect.width(), rect.height())
                            val rotate = image.imageInfo.rotationDegrees
                            upright = if (rotate == 0) cropped else Bitmap.createBitmap(cropped, 0, 0,
                                cropped.width, cropped.height, Matrix().apply { postRotate(rotate.toFloat()) }, true)
                            val inferenceStart = SystemClock.elapsedRealtimeNanos()
                            val timestamp = maxOf(SystemClock.uptimeMillis(), lastTimestamp + 1)
                            lastTimestamp = timestamp
                            val input = BitmapImageBuilder(upright).build()
                            val result = try { landmarker!!.detectForVideo(input, timestamp) } finally { input.close() }
                            val finished = SystemClock.elapsedRealtimeNanos()
                            val preMs = (inferenceStart - entered) / 1e6
                            val inferMs = (finished - inferenceStart) / 1e6
                            val callbackMs = (finished - entered) / 1e6
                            val at = finished / 1e6
                            frameWidth = upright.width; frameHeight = upright.height
                            timing.add(at, preMs, inferMs, callbackMs)
                            processed++
                            if (result.landmarks().isEmpty()) empty++
                            if (recording) {
                                if (startedAt == 0L) startedAt = entered
                                val hands = JSONArray()
                                result.landmarks().forEachIndexed { i, points ->
                                    val category = result.handedness()[i][0]
                                    val lm = JSONArray()
                                    points.forEach { lm.put(it.x().toDouble()).put(it.y().toDouble()).put(it.z().toDouble()) }
                                    val world = JSONArray()
                                    result.worldLandmarks()[i].forEach { world.put(it.x().toDouble()).put(it.y().toDouble()).put(it.z().toDouble()) }
                                    hands.put(JSONObject().put("label", category.categoryName().lowercase(Locale.ROOT))
                                        .put("score", category.score().toDouble()).put("lm", lm).put("world", world))
                                }
                                frames.put(JSONObject().put("t", (entered - startedAt) / 1e9).put("hands", hands)
                                    .put("preprocessMs", preMs).put("inferenceMs", inferMs)
                                    .put("callbackToResultMs", callbackMs))
                                if (frames.length() >= 9000) {
                                    recording = false
                                    runOnUiThread {
                                        recordButton.text = "새 측정"; saveButton.isEnabled = true
                                        Toast.makeText(this, "9000프레임에 도달해 측정을 중지했습니다. 기록을 저장하세요.", Toast.LENGTH_LONG).show()
                                    }
                                }
                            }
                            val points = result.landmarks().map { hand -> hand.map { Pair(it.x(), it.y()) } }
                            val w = frameWidth; val h = frameHeight
                            val now = SystemClock.uptimeMillis()
                            val updateStats = now - lastUi >= 300
                            if (updateStats) lastUi = now
                            val summary = if (updateStats) String.format(Locale.KOREA,
                                "%s · Android %s\n처리 %.1f FPS · 손 %d개\n전처리 p50 %.1fms · 추론 p50 %.1fms / p95 %.1fms\n분석 콜백→결과 p50 %.1fms\n처리 %d · 손 없음 %d · 오류 %d · 기록 %d",
                                Build.MODEL, Build.VERSION.RELEASE, timing.fps(), points.size,
                                timing.percentile(1, .5), timing.percentile(2, .5), timing.percentile(2, .95),
                                timing.percentile(3, .5), processed, empty, errors, frames.length()) else null
                            if (uiQueued.compareAndSet(false, true)) runOnUiThread {
                                try {
                                    if (!destroyed) {
                                        overlay.update(points, w, h)
                                        if (summary != null) status.text = summary
                                    }
                                } finally { uiQueued.set(false) }
                            }
                        } catch (e: Exception) {
                            errors++
                            if (errors == 1) showError("프레임 처리 오류: ${e.message}")
                        } finally {
                            if (upright != null && upright !== cropped) upright.recycle()
                            if (cropped != null && cropped !== source) cropped.recycle()
                            source?.recycle()
                            image.close()
                        }
                    }
                    val group = UseCaseGroup.Builder().addUseCase(previewUseCase).addUseCase(analysis)
                    preview.viewPort?.let { group.setViewPort(it) }
                    camera.unbindAll()
                    camera.bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA, group.build())
                } catch (e: Exception) { showError("카메라 시작 실패: ${e.message}") }
            }, ContextCompat.getMainExecutor(this))
        }
    }

    private fun buildReport(): String = JSONObject()
        .put("schema", "hms-native-baseline-v1")
        .put("device", JSONObject().put("model", Build.MODEL).put("soc", Build.SOC_MODEL)
            .put("android", Build.VERSION.RELEASE).put("sdk", Build.VERSION.SDK_INT))
        .put("backend", "mediapipe-cpu")
        .put("npuVerified", false)
        .put("preprocessing", "CameraX YUV to Bitmap, viewport crop, rotation; CPU copies included")
        .put("timingScope", "analysis callback to synchronous result; excludes sensor exposure and display presentation")
        .put("liveBackpressure", "KEEP_ONLY_LATEST; camera frames may be dropped, not an offline all-frame pass")
        .put("raw", JSONObject().put("aspect", frameWidth.toDouble() / frameHeight)
            .put("firstPerson", true).put("swap", false).put("rightOnImageRight", true)
            .put("offline", false).put("frames", frames))
        .toString()

    private fun showError(message: String) = runOnUiThread { if (!destroyed) status.text = message }

    override fun onDestroy() {
        destroyed = true
        recording = false
        provider?.unbindAll()
        worker.execute { landmarker?.close(); landmarker = null }
        worker.shutdown()
        super.onDestroy()
    }
}
