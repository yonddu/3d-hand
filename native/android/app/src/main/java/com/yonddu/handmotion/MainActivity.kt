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
import com.google.mediapipe.tasks.vision.poselandmarker.PoseLandmarker
import com.google.mediapipe.tasks.vision.poselandmarker.PoseLandmarkerResult
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
    private var poseLandmarker: PoseLandmarker? = null // accessed only on worker; null = pose off or failed
    @Volatile private var poseOn = false // separate option (user: body tracking when needed)
    private var poseMs = 0.0
    private var provider: ProcessCameraProvider? = null
    private lateinit var preview: PreviewView
    private lateinit var overlay: LandmarkOverlay
    private lateinit var handView: HandView
    private lateinit var status: TextView
    private lateinit var recordButton: Button
    private lateinit var handsButton: Button
    private lateinit var poseButton: Button
    private lateinit var modelButton: Button
    private lateinit var modelInfo: TextView
    private var customModel = false
    private lateinit var sideButton: Button
    private var modelChoice = 0 // index into MODEL_HANDS
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
    @Volatile private var lastError = ""
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

    private val openModel = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri == null) return@registerForActivityResult
        exportWorker.execute {
            try {
                val name = contentResolver.query(uri, arrayOf(android.provider.OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
                    if (c.moveToFirst()) c.getString(0) else null
                } ?: "model.glb"
                val lower = name.lowercase(Locale.ROOT)
                require(lower.endsWith(".glb") || lower.endsWith(".gltf") || lower.endsWith(".fbx")) { "GLB, glTF(파일 하나) 또는 FBX만 열 수 있습니다: $name" }
                val bytes = contentResolver.openInputStream(uri)!!.use { it.readBytes() }
                require(bytes.size <= 60 * 1024 * 1024) { "60 MB보다 큰 모델은 열지 않습니다" }
                runOnUiThread {
                    if (destroyed) return@runOnUiThread
                    modelButton.isEnabled = false
                    modelButton.text = "손 모델 불러오는 중… (${bytes.size / 1024} KB)"
                    handView.loadModel(name, bytes) { result ->
                        modelButton.isEnabled = true
                        if (result.startsWith("ok:")) {
                            customModel = true
                            modelChoice = 0
                            sideButton.text = MODEL_HANDS[0].second
                            sideButton.visibility = android.view.View.VISIBLE
                            modelButton.text = "Quest 손으로 되돌리기"
                            modelInfo.text = "내 손 모델: " + result.removePrefix("ok:")
                        } else {
                            modelButton.text = "내 손 모델 불러오기 (GLB/FBX)"
                            modelInfo.text = "손 모델 열기 실패: " + result.removePrefix("error:")
                        }
                    }
                }
            } catch (e: Exception) {
                runOnUiThread { if (!destroyed) modelInfo.text = "손 모델 열기 실패: ${e.message}" }
            }
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
                    val scores = mutableMapOf<String, Double>()
                    for (h in 0 until entries.length()) {
                        val hand = entries.getJSONObject(h)
                        val side = hand.getString("label")
                        val score = hand.optDouble("score", 0.0)
                        val p = hand.getJSONArray("world")
                        if (side in listOf("left", "right") && p.length() == 63 && score >= (scores[side] ?: -1.0)) {
                            points[side] = DoubleArray(63) { p.getDouble(it) }; scores[side] = score
                        }
                    }
                    RawHandFrame(frame.getDouble("t"), points)
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
            text = "Hand Motion · 네이티브 v0.14.1\nQuest 손 / 내 손 모델 + MediaPipe Pose · GPU / CPU 비교"
            textSize = 18f
        }
        root.addView(title)
        val stage = FrameLayout(this)
        preview = PreviewView(this).apply {
            scaleType = PreviewView.ScaleType.FIT_CENTER
            implementationMode = PreviewView.ImplementationMode.COMPATIBLE
        }
        overlay = LandmarkOverlay(this)
        handView = HandView(this)
        stage.addView(preview, FrameLayout.LayoutParams(-1, -1))
        stage.addView(handView, FrameLayout.LayoutParams(-1, -1))
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
        poseButton = Button(this).apply {
            text = "몸 추적(MediaPipe Pose) 켜기"; isEnabled = false
            setOnClickListener {
                recording = false
                recordButton.text = "새 측정"
                saveButton.isEnabled = frames.length() > 0
                fbxButton.isEnabled = frames.length() > 0 && !fbxBusy
                poseOn = !poseOn
                startModel()
            }
        }
        root.addView(poseButton)
        modelButton = Button(this).apply {
            text = "내 손 모델 불러오기 (GLB/FBX)"
            setOnClickListener {
                if (customModel) {
                    handView.resetModel(); customModel = false
                    sideButton.visibility = android.view.View.GONE
                    text = "내 손 모델 불러오기 (GLB/FBX)"; modelInfo.text = ""
                } else openModel.launch(arrayOf("*/*"))
            }
        }
        root.addView(modelButton)
        sideButton = Button(this).apply {
            visibility = android.view.View.GONE
            setOnClickListener {
                modelChoice = (modelChoice + 1) % MODEL_HANDS.size
                val (choice, label) = MODEL_HANDS[modelChoice]
                text = label
                handView.modelHand(choice) { note -> if (note.isNotEmpty()) modelInfo.text = modelInfo.text.lines().first() + "\n" + note }
            }
        }
        root.addView(sideButton)
        modelInfo = TextView(this).apply { textSize = 12f }
        root.addView(modelInfo)
        root.addView(buttons)
        val note = TextView(this).apply {
            text = "측정 중지 → FBX 저장 (원본 손 관절, 팔 없음) · 기록 JSON에 몸 33점 포함\n화면 손: MediaPipe 점에 그대로 맞춘 Quest 손 모양 · 몸: MediaPipe Pose 선"
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
        poseButton.isEnabled = false
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
                poseLandmarker?.close()
                poseLandmarker = null
                if (poseOn) try {
                    // MediaPipe Pose (lite, Apache-2.0): the body's 33 points, one person.
                    poseLandmarker = PoseLandmarker.createFromOptions(this, PoseLandmarker.PoseLandmarkerOptions.builder()
                        .setBaseOptions(BaseOptions.builder().setModelAssetPath("pose_landmarker_lite.task").setDelegate(backend).build())
                        .setRunningMode(RunningMode.VIDEO)
                        .setNumPoses(1)
                        .setMinPoseDetectionConfidence(0.5f)
                        .setMinPosePresenceConfidence(0.5f)
                        .setMinTrackingConfidence(0.5f)
                        .build())
                } catch (e: Exception) { lastError = "포즈 모델 시작 실패: ${e.message}" }
                ready = true
                runOnUiThread {
                    if (!destroyed) {
                        recordButton.isEnabled = true
                        handsButton.isEnabled = true
                        poseButton.isEnabled = true
                        poseButton.text = if (poseOn) "몸 추적 켜짐 · 끄기" else "몸 추적(MediaPipe Pose) 켜기"
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
                            val uw = upright.width; val uh = upright.height
                            val input = BitmapImageBuilder(upright).build()
                            // MPImage.close() recycles the bitmap it wraps: nothing reads upright after this.
                            var pose: PoseLandmarkerResult? = null
                            var handsDone = 0L
                            val result = try {
                                landmarker!!.detectForVideo(input, timestamp).also {
                                    handsDone = SystemClock.elapsedRealtimeNanos()
                                    // The body on the same picture, before close() recycles it.
                                    pose = try { poseLandmarker?.detectForVideo(input, timestamp) } catch (e: Throwable) {
                                        lastError = "포즈: ${e.javaClass.simpleName} ${e.message}"; null
                                    }
                                }
                            } finally { input.close() }
                            val finished = SystemClock.elapsedRealtimeNanos()
                            poseMs = if (poseLandmarker != null) (finished - handsDone) / 1e6 else 0.0
                            val preMs = (inferenceStart - entered) / 1e6
                            val inferMs = (finished - inferenceStart) / 1e6
                            val callbackMs = (finished - entered) / 1e6
                            val at = finished / 1e6
                            frameWidth = uw; frameHeight = uh
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
                                val bodyJson = pose?.takeIf { it.landmarks().isNotEmpty() }?.let { r ->
                                    val lm = JSONArray(); val world = JSONArray()
                                    r.landmarks()[0].forEach { q -> lm.put(q.x().toDouble()).put(q.y().toDouble()).put(q.z().toDouble()).put(q.visibility().orElse(0f).toDouble()) }
                                    r.worldLandmarks().getOrNull(0)?.forEach { q -> world.put(q.x().toDouble()).put(q.y().toDouble()).put(q.z().toDouble()) }
                                    JSONObject().put("lm", lm).put("world", world)
                                }
                                frames.put(JSONObject().put("t", (entered - startedAt) / 1e9).put("hands", hands)
                                    .apply { if (bodyJson != null) put("pose", bodyJson) }
                                    .put("imageWidth", uw).put("imageHeight", uh)
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
                            // Body points (x, y, visibility); empty when pose is off or sees nobody.
                            val body = pose?.landmarks()?.firstOrNull()?.map { Triple(it.x(), it.y(), it.visibility().orElse(0f)) } ?: emptyList()
                            val w = frameWidth; val h = frameHeight
                            // The Quest-style hand: each hand's points in front of the camera (HandPlace).
                            val aspect = w.toDouble() / h
                            val meshHands = try { result.landmarks().indices.mapNotNull { i ->
                                val side = result.handedness()[i][0].categoryName().lowercase(Locale.ROOT)
                                val world = DoubleArray(63).also { a -> result.worldLandmarks()[i].forEachIndexed { j, q -> a[j * 3] = q.x().toDouble(); a[j * 3 + 1] = q.y().toDouble(); a[j * 3 + 2] = q.z().toDouble() } }
                                val img = DoubleArray(63).also { a -> result.landmarks()[i].forEachIndexed { j, q -> a[j * 3] = q.x().toDouble(); a[j * 3 + 1] = q.y().toDouble(); a[j * 3 + 2] = q.z().toDouble() } }
                                HandPlace.onRays(world, img, aspect)?.let { Triple(side, it, HandPlace.palm(world)) }
                            } } catch (e: Throwable) {
                                lastError = "손 배치: ${e.javaClass.simpleName} ${e.message}"
                                emptyList()
                            }
                            val now = SystemClock.uptimeMillis()
                            val updateStats = now - lastUi >= 300
                            if (updateStats) lastUi = now
                            val summary = if (updateStats) String.format(Locale.KOREA,
                                "%s · Android %s · %s 요청 · 최대 %d손\n입력 %d×%d · 처리 %.1f FPS · 손 %d개 · 몸 %s\n전처리 p50 %.1fms · 추론 p50 %.1fms / p95 %.1fms\n분석 콜백→결과 p50 %.1fms\n처리 %d · 손 없음 %d · 오류 %d · 기록 %d",
                                Build.MODEL, Build.VERSION.RELEASE, backend.name, maxHands, w, h, timing.fps(), points.size,
                                if (!poseOn) "꺼짐" else if (body.isEmpty()) "없음" else String.format(Locale.KOREA, "있음(%.0fms)", poseMs),
                                timing.percentile(1, .5), timing.percentile(2, .5), timing.percentile(2, .95),
                                timing.percentile(3, .5), processed, empty, errors, frames.length()) +
                                (if (lastError.isNotEmpty()) "\n마지막 오류: $lastError" else "") else null
                            if (uiQueued.compareAndSet(false, true)) runOnUiThread {
                                try {
                                    if (!destroyed) {
                                        handView.show(w, h, meshHands)
                                        // Plain points until the hand model draws (or if it cannot).
                                        overlay.update(if (handView.ready) emptyList() else points, body, w, h)
                                        if (handView.lastError.isNotEmpty()) lastError = handView.lastError
                                        if (summary != null) status.text = summary
                                    }
                                } finally { uiQueued.set(false) }
                            }
                        } catch (e: Throwable) {
                            errors++
                            lastError = "${e.javaClass.simpleName} ${e.message} @ ${e.stackTrace.firstOrNull { it.className.contains("handmotion") }?.let { "${it.fileName}:${it.lineNumber}" } ?: ""}"
                            showError("프레임 처리 오류 $errors: $lastError")
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
        worker.execute { landmarker?.close(); landmarker = null; poseLandmarker?.close(); poseLandmarker = null }
        worker.shutdown()
        pendingFbx?.delete()
        exportWorker.shutdown()
        super.onDestroy()
    }

    companion object {
        /** Which hand the loaded model is (button cycles): bone names, right, left, never mirror. */
        private val MODEL_HANDS = listOf(
            "auto" to "모델 손: 자동 (뼈 이름, 모르면 오른손) · 바꾸기",
            "right" to "모델 손: 오른손 · 왼손엔 좌우 반전 · 바꾸기",
            "left" to "모델 손: 왼손 · 오른손엔 좌우 반전 · 바꾸기",
            "none" to "모델 손: 반전 안 함 (양손 그대로) · 바꾸기")
    }
}
