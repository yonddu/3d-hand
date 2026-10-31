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
import java.io.File

/** Native-only detection baseline. No JavaScript, rig priors or NPU claims. */
class MainActivity : ComponentActivity() {
    private val worker = Executors.newSingleThreadExecutor()
    private val exportWorker = Executors.newSingleThreadExecutor()
    private val uiQueued = AtomicBoolean(false)
    private var landmarker: HandLandmarker? = null // accessed only on worker
    private var provider: ProcessCameraProvider? = null
    private lateinit var preview: PreviewView
    private lateinit var overlay: LandmarkOverlay
    private lateinit var status: TextView
    private lateinit var recordButton: Button
    private lateinit var handsButton: Button
    @Volatile private var maxHands = 2
    private var recordedMaxHands = 2
    private lateinit var backendButton: Button
    @Volatile private var backend = Delegate.GPU
    private var recordedBackend = "mediapipe-gpu"
    private lateinit var saveButton: Button
    private lateinit var fbxButton: Button
    @Volatile private var fbxBusy = false
    private var pendingFbx: File? = null
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

    private val saveFbxDocument = registerForActivityResult(ActivityResultContracts.CreateDocument("application/octet-stream")) { uri ->
        val file = pendingFbx
        pendingFbx = null
        exportWorker.execute {
            try {
                if (uri != null && file != null) {
                    contentResolver.openOutputStream(uri)?.use { out -> file.inputStream().use { it.copyTo(out) } }
                        ?: error("저장 파일을 열 수 없습니다.")
                    runOnUiThread { if (!destroyed) Toast.makeText(this, "FBX 뼈대 애니메이션 저장 완료", Toast.LENGTH_LONG).show() }
                }
            } catch (e: Exception) { showError("FBX 저장 실패: ${e.message}") }
            finally {
                file?.delete(); fbxBusy = false
                runOnUiThread { if (!destroyed) fbxButton.isEnabled = !recording && frames.length() > 0 }
            }
        }
    }

    private fun exportFbx() {
        if (fbxBusy || recording) return
        fbxBusy = true; fbxButton.isEnabled = false
        worker.execute {
            try {
                val snapshot = (0 until frames.length()).map { f ->
                    val frame = frames.getJSONObject(f)
                    val entries = frame.getJSONArray("hands")
                    val points = mutableMapOf<String, DoubleArray>()
                    val image = mutableMapOf<String, DoubleArray>()
                    val scores = mutableMapOf<String, Double>()
                    for (h in 0 until entries.length()) {
                        val hand = entries.getJSONObject(h)
                        val side = hand.getString("label")
                        val score = hand.optDouble("score", 0.0)
                        val p = hand.getJSONArray("world")
                        if (side in listOf("left", "right") && p.length() == 63 && score >= (scores[side] ?: -1.0)) {
                            points[side] = DoubleArray(63) { p.getDouble(it) }; scores[side] = score
                            val lm = hand.optJSONArray("lm")
                            if (lm != null && lm.length() == 63) image[side] = DoubleArray(63) { lm.getDouble(it) } else image.remove(side)
                        }
                    }
                    val iw = frame.optDouble("imageWidth", frameWidth.toDouble())
                    val ih = frame.optDouble("imageHeight", frameHeight.toDouble())
                    RawHandFrame(frame.getDouble("t"), points, image, iw / ih)
                }
                exportWorker.execute {
                    var file: File? = null
                    try {
                        val bytes = RawFbx.encode(snapshot)
                        file = File.createTempFile("raw-fbx-", ".fbx", cacheDir)
                        file.writeBytes(bytes)
                        val readyFile = file
                        runOnUiThread {
                            if (destroyed) { readyFile.delete(); fbxBusy = false }
                            else { pendingFbx = readyFile; saveFbxDocument.launch("hand-native-${System.currentTimeMillis()}.fbx") }
                        }
                    } catch (e: Exception) {
                        file?.delete(); fbxBusy = false
                        showError("FBX 생성 실패: ${e.message}")
                        runOnUiThread { if (!destroyed) fbxButton.isEnabled = !recording && frames.length() > 0 }
                    }
                }
            } catch (e: Exception) {
                fbxBusy = false; showError("FBX 기록 읽기 실패: ${e.message}")
                runOnUiThread { if (!destroyed) fbxButton.isEnabled = !recording && frames.length() > 0 }
            }
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
            text = "Hand Motion · 네이티브 v0.9\n손 + 손목·팔 뼈대 · GPU / CPU 비교"
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
                fbxButton.isEnabled = false
                if (recording) {
                    recording = false
                    worker.execute { runOnUiThread {
                        recordButton.text = "새 측정"; recordButton.isEnabled = true
                        saveButton.isEnabled = frames.length() > 0
                        fbxButton.isEnabled = frames.length() > 0 && !fbxBusy
                    } }
                } else worker.execute {
                    frames = JSONArray(); timing.clear(); startedAt = 0
                    processed = 0; empty = 0; errors = 0
                    recordedMaxHands = maxHands
                    recordedBackend = "mediapipe-" + backend.name.lowercase(Locale.ROOT)
                    recording = true
                    runOnUiThread {
                        recordButton.text = "측정 중지"; recordButton.isEnabled = true
                        saveButton.isEnabled = false
                        fbxButton.isEnabled = false
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
        fbxButton = Button(this).apply {
            text = "FBX 저장"; isEnabled = false
            setOnClickListener { exportFbx() }
        }
        backendButton = Button(this).apply {
            text = "CPU로 전환"; isEnabled = false
            setOnClickListener {
                recording = false
                recordButton.text = "새 측정"
                saveButton.isEnabled = frames.length() > 0
                fbxButton.isEnabled = frames.length() > 0 && !fbxBusy
                backend = if (backend == Delegate.GPU) Delegate.CPU else Delegate.GPU
                startModel()
            }
        }
        buttons.addView(recordButton); buttons.addView(saveButton); buttons.addView(fbxButton)
        root.addView(backendButton)
        handsButton = Button(this).apply {
            text = "현재 두 손 · 한 손 비교로 전환"; isEnabled = false
            setOnClickListener {
                recording = false
                recordButton.text = "새 측정"
                saveButton.isEnabled = frames.length() > 0
                fbxButton.isEnabled = frames.length() > 0 && !fbxBusy
                maxHands = if (maxHands == 2) 1 else 2
                startModel()
            }
        }
        root.addView(handsButton)
        root.addView(buttons)
        val note = TextView(this).apply {
            text = "측정 중지 → FBX 저장 (원본 손 관절 + 손목·아래팔·위팔 뼈대)\n팔은 어깨 위치 가정 + 팔꿈치 계산 · 손 메시 없음"
            textSize = 12f
        }
        root.addView(note)
        setContentView(root)
        startModel()
    }

    private fun startModel() {
        ready = false
        recordButton.isEnabled = false
        backendButton.isEnabled = false
        handsButton.isEnabled = false
        provider?.unbindAll()
        status.text = "${backend.name} 모델 준비 중…"
        worker.execute {
            try {
                landmarker?.close()
                landmarker = null
                timing.clear(); processed = 0; empty = 0; errors = 0
                lastTimestamp = -1
                val options = HandLandmarker.HandLandmarkerOptions.builder()
                    .setBaseOptions(BaseOptions.builder()
                        .setModelAssetPath("hand_landmarker.task")
                        .setDelegate(backend).build())
                    .setRunningMode(RunningMode.VIDEO)
                    .setNumHands(maxHands)
                    .setMinHandDetectionConfidence(0.5f)
                    .setMinHandPresenceConfidence(0.5f)
                    .setMinTrackingConfidence(0.5f)
                    .build()
                landmarker = HandLandmarker.createFromOptions(this, options)
                ready = true
                runOnUiThread {
                    if (!destroyed) {
                        recordButton.isEnabled = true
                        handsButton.isEnabled = true
                        handsButton.text = if (maxHands == 2) "현재 두 손 · 한 손 비교로 전환" else "현재 한 손만 추적 · 두 손으로 전환"
                        backendButton.isEnabled = true
                        backendButton.text = if (backend == Delegate.GPU) "CPU로 전환" else "GPU로 전환"
                        startCamera()
                    }
                }
            } catch (e: Exception) {
                showError("${backend.name} 시작 실패: ${e.message}\n다른 실행 방식을 선택할 수 있습니다.")
                runOnUiThread { if (!destroyed) {
                    backendButton.isEnabled = true
                    backendButton.text = if (backend == Delegate.GPU) "CPU로 전환" else "GPU로 전환"
                } }
            }
        }
    }

    @SuppressLint("MissingPermission")
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
                                    .put("imageWidth", upright.width).put("imageHeight", upright.height)
                                    .put("maxHands", recordedMaxHands).put("delegate", recordedBackend)
                                    .put("sourceWidth", image.width).put("sourceHeight", image.height)
                                    .put("rotationDegrees", rotate)
                                    .put("preprocessMs", preMs).put("inferenceMs", inferMs)
                                    .put("callbackToResultMs", callbackMs))
                                if (frames.length() >= 9000) {
                                    recording = false
                                    runOnUiThread {
                                        recordButton.text = "새 측정"; saveButton.isEnabled = true; fbxButton.isEnabled = !fbxBusy
                                        Toast.makeText(this, "9000프레임에 도달해 측정을 중지했습니다. 기록을 저장하세요.", Toast.LENGTH_LONG).show()
                                    }
                                }
                            }
                            val points = result.landmarks().map { hand -> hand.map { Pair(it.x(), it.y()) } }
                            val w = frameWidth; val h = frameHeight
                            // Forearm and upper arm hung from each hand (ArmRig), as picture lines.
                            val aspect = w.toDouble() / h
                            val arms = result.landmarks().indices.mapNotNull { i ->
                                val side = result.handedness()[i][0].categoryName().lowercase(Locale.ROOT)
                                val world = DoubleArray(63).also { a -> result.worldLandmarks()[i].forEachIndexed { j, q -> a[j * 3] = q.x().toDouble(); a[j * 3 + 1] = q.y().toDouble(); a[j * 3 + 2] = q.z().toDouble() } }
                                val img = DoubleArray(63).also { a -> result.landmarks()[i].forEachIndexed { j, q -> a[j * 3] = q.x().toDouble(); a[j * 3 + 1] = q.y().toDouble(); a[j * 3 + 2] = q.z().toDouble() } }
                                val joints = RawFbx.joints(RawHandFrame(0.0, mapOf(side to world), mapOf(side to img), aspect), side) ?: return@mapNotNull null
                                val sh = joints.copyOfRange(0, 3); val el = joints.copyOfRange(3, 6); val wr = joints.copyOfRange(6, 9)
                                listOfNotNull(ArmRig.projectLine(el, wr, aspect), ArmRig.projectLine(sh, el, aspect))
                            }.flatten()
                            val now = SystemClock.uptimeMillis()
                            val updateStats = now - lastUi >= 300
                            if (updateStats) lastUi = now
                            val summary = if (updateStats) String.format(Locale.KOREA,
                                "%s · Android %s · %s 요청 · 최대 %d손\n입력 %d×%d · 처리 %.1f FPS · 손 %d개\n전처리 p50 %.1fms · 추론 p50 %.1fms / p95 %.1fms\n분석 콜백→결과 p50 %.1fms\n처리 %d · 손 없음 %d · 오류 %d · 기록 %d",
                                Build.MODEL, Build.VERSION.RELEASE, backend.name, maxHands, w, h, timing.fps(), points.size,
                                timing.percentile(1, .5), timing.percentile(2, .5), timing.percentile(2, .95),
                                timing.percentile(3, .5), processed, empty, errors, frames.length()) else null
                            if (uiQueued.compareAndSet(false, true)) runOnUiThread {
                                try {
                                    if (!destroyed) {
                                        overlay.update(points, arms, w, h)
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
        .put("backend", recordedBackend)
        .put("maxHands", recordedMaxHands)
        .put("imageWidth", frameWidth).put("imageHeight", frameHeight)
        .put("acceleratorExecutionVerified", false)
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
        pendingFbx?.delete()
        exportWorker.shutdown()
        super.onDestroy()
    }
}
