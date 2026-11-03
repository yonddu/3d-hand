package com.yonddu.handmotion

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.webkit.WebView
import org.json.JSONArray
import org.json.JSONObject

/**
 * The user's hand model page (assets/hand.html, three.js; nothing drawn until a model is loaded)
 * in a see-through WebView over the camera preview. Fed on the UI thread.
 * ready turns true once the page answers "ok"; until then (or if it never
 * does) the caller keeps drawing the plain points.
 */
/** One hand for the page: side, camera-space points (63), palm (m), body-pose elbow (u, v, farther 0/1) or null,
 *  MediaPipe world points (63, m; the page turns the model's bones by their directions). */
data class MeshHand(val side: String, val cam: DoubleArray, val palm: Double, val elbow: DoubleArray? = null, val world: DoubleArray? = null)

@SuppressLint("SetJavaScriptEnabled")
class HandView(context: Context) : WebView(context) {
    @Volatile var ready = false
        private set
    @Volatile var lastError = ""
        private set
    private var busy = false

    init {
        setBackgroundColor(Color.TRANSPARENT)
        settings.javaScriptEnabled = true
        settings.allowFileAccess = false
        isVerticalScrollBarEnabled = false
        isHorizontalScrollBarEnabled = false
        val html = context.assets.open("hand.html").bufferedReader().use { it.readText() }
        loadDataWithBaseURL("https://hand.local/", html, "text/html", "utf-8", null)
    }

    /** Live frames are not drawn while a recorded frame is shown (choosing a still pose). */
    @Volatile var frozen = false

    fun show(width: Int, height: Int, hands: List<MeshHand>, body: JSONObject? = null) {
        if (busy || frozen) return // the page has not drawn the last one yet: skip, never queue up
        val json = handsJson(width, height, hands, body?.let { JSONObject().put("body", it) })
        busy = true
        evaluateJavascript("window.setHands ? setHands($json) : 'missing'") { answer ->
            busy = false
            if (answer == "\"ok\"") ready = true else if (answer != "\"loading\"") lastError = "손 모델: $answer"
        }
    }

    private fun handsJson(width: Int, height: Int, hands: List<MeshHand>, extra: JSONObject?): String {
        val (fw, fh) = HandPlace.focal(width.toDouble() / height)
        val list = JSONArray()
        for (hand in hands) {
            val pts = JSONArray()
            hand.cam.forEach { pts.put(Math.round(it * 1e5) / 1e5) }
            val o = JSONObject().put("side", hand.side).put("cam", pts).put("palm", hand.palm)
            hand.elbow?.let { e -> o.put("elbow", JSONArray().put(e[0]).put(e[1]).put(e[2])) }
            hand.world?.let { wp -> val a = JSONArray(); wp.forEach { a.put(Math.round(it * 1e5) / 1e5) }; o.put("world", a) }
            list.put(o)
        }
        val o = extra ?: JSONObject()
        return o.put("w", width).put("h", height).put("fw", fw).put("fh", fh).put("hands", list).toString()
    }

    /** One recorded frame, drawn (frozen view) or only posed and kept for export (record). UI thread. */
    fun showRecorded(width: Int, height: Int, hands: List<MeshHand>, t: Double, index: Int, record: Boolean, collect: Boolean = false, body: JSONObject? = null, done: () -> Unit) {
        val extra = JSONObject().put("t", t).put("fi", index).put("record", record).put("noRender", record || collect)
        if (body != null) extra.put("body", body)
        if (collect) extra.put("collect", true)
        evaluateJavascript("window.setHands ? setHands(${handsJson(width, height, hands, extra)}) : 'missing'") { done() }
    }

    /** "편 손 캘리브레이션": the next frame's hands are the open hands. */
    fun calibrate(done: (String) -> Unit) { evaluateJavascript("window.calibrateOpen ? calibrateOpen() : ''") { done(it.trim('"')) } }
    /** On screen: the model's skeleton fitted to the user's hand (skin on the hand) or as modelled. */
    fun setProp(on: Boolean) { evaluateJavascript("window.setProp && setProp($on)", null) }

    fun setPure(on: Boolean) { evaluateJavascript("window.setPure && setPure($on)", null) }
    fun setFingerMode(m: Int) { evaluateJavascript("window.setFingerMode && setFingerMode($m)", null) }
    fun fitHand(on: Boolean) { evaluateJavascript("window.fitHand && fitHand($on)", null) }
    fun clearCalibration() { evaluateJavascript("window.calibrateClear && calibrateClear()", null) }
    fun recBegin(done: () -> Unit) { evaluateJavascript("window.recBegin ? recBegin() : ''") { done() } }
    /** After every frame was fed with collect: the whole take cleaned (clean.js) and posed. done gets the counts (JSON). */
    fun recFinish(done: (String) -> Unit) { evaluateJavascript("window.recFinish ? recFinish() : 'error:old page'") { done(it.trim('"').replace("\\\"", "\"")) } }
    /** The corrected, smoothed take played in a loop (what the GLB saves). done gets "ok:<frames>:<s>" or "error:..". */
    fun reviewPlay(done: (String) -> Unit) { evaluateJavascript("window.reviewPlay ? reviewPlay() : 'error:old page'") { done(it.trim('"')) } }
    fun reviewStop() { evaluateJavascript("window.reviewStop && reviewStop()", null) }
    /** On: the view letterboxed to 16:9 (game screen), same camera height; off: back to the camera picture shape. */
    /** Game camera for the 16:9 view: fov in degrees (horizontal when h), wrist spot from the eye in metres. */
    fun gameCam(fov: Double, h: Boolean, z: Double) { evaluateJavascript("window.gameCam && gameCam({fov:$fov,h:$h,z:$z})", null) }
    fun wideView(on: Boolean) { evaluateJavascript("window.wideView && wideView($on)", null) }

    /**
     * The model as GLB: mode "anim" (bone turns over the recorded frames) or "pose" (the
     * recorded frame nearest index). done gets ("ok:<side>:<frames>:<index>:<bytes>", bytes) or ("error:...", null).
     */
    fun exportGlb(mode: String, index: Int, done: (String, ByteArray?) -> Unit) = pullGlb("window.exportBegin ? exportBegin('$mode', $index) : 'error:화면 준비 안 됨'", done)

    /** The loaded model rebuilt to the user's measured hand (bones = MediaPipe's), as a GLB. */
    fun bakeModel(done: (String, ByteArray?) -> Unit) = pullGlb("window.bakeBegin ? bakeBegin() : 'error:화면 준비 안 됨'", done)

    /** The GLB the free rig screen made (bones on the user's points). */
    fun rigGlb(done: (String, ByteArray?) -> Unit) = pullGlb("window.rigGlbBegin ? rigGlbBegin() : 'error:화면 준비 안 됨'", done)

    private fun pullGlb(begin: String, done: (String, ByteArray?) -> Unit) {
        val main = Handler(Looper.getMainLooper())
        val size = 512 * 1024
        fun pull(n: Int, i: Int, sb: StringBuilder, st: String) {
            if (i == n) { evaluateJavascript("exportDone()", null); done(st, Base64.decode(sb.toString(), Base64.NO_WRAP)); return }
            evaluateJavascript("exportChunk($i, $size)") { piece -> sb.append(piece.trim('"')); pull(n, i + 1, sb, st) }
        }
        fun poll(left: Int) {
            evaluateJavascript("window.exportStatus || ''") { answer ->
                val st = answer.trim('"')
                when {
                    st == "working" && left > 0 -> main.postDelayed({ poll(left - 1) }, 300)
                    st.startsWith("ok:") -> evaluateJavascript("exportChunks($size)") { n -> pull(n.toIntOrNull() ?: 0, 0, StringBuilder(), st) }
                    else -> done(if (st == "working") "error:시간 초과" else st, null)
                }
            }
        }
        evaluateJavascript(begin) { answer ->
            val st = answer.trim('"')
            if (st == "working") poll(400) else done(st, null)
        }
    }

    /**
     * The user's own hand model (GLB / glTF / FBX bytes), drawn over the MediaPipe points.
     * done gets "ok:<summary>" or "error:<reason>". UI thread.
     */
    fun loadModel(name: String, bytes: ByteArray, done: (String) -> Unit) {
        val b64 = Base64.encodeToString(bytes, Base64.NO_WRAP)
        val pieces = b64.chunked(512 * 1024)
        val main = Handler(Looper.getMainLooper())
        fun poll(left: Int) {
            evaluateJavascript("window.modelStatus || ''") { answer ->
                val st = answer.trim('"')
                if (st == "loading" && left > 0) main.postDelayed({ poll(left - 1) }, 300)
                else done(if (st == "loading") "error:시간 초과" else st)
            }
        }
        fun send(i: Int) {
            if (i == pieces.size) { evaluateJavascript("modelEnd()") { poll(200) }; return }
            evaluateJavascript("modelChunk('${pieces[i]}')") { send(i + 1) }
        }
        evaluateJavascript("window.modelBegin ? modelBegin(${JSONObject.quote(name)}) : 'missing'") { answer ->
            if (answer != "\"ok\"") done("error:손 화면이 아직 준비되지 않았습니다") else send(0)
        }
    }

    /** Which hand the loaded model is: auto / left / right / none (never mirror). done gets a short note. */
    fun modelHand(choice: String, done: (String) -> Unit) {
        evaluateJavascript("window.modelHand ? modelHand('$choice') : ''") { done(it.trim('"')) }
    }

    /**
     * The rig screen (page draws the loaded skin full size with the 21 point names). done gets
     * "done:ok:<model summary>", "cancel" or "error:<reason>" when the user leaves it. UI thread.
     */
    fun rigOpen(kind: String, done: (String) -> Unit) {
        val main = Handler(Looper.getMainLooper())
        fun poll() {
            evaluateJavascript("window.rigStatus || ''") { answer ->
                val st = answer.trim('"').replace("\\\"", "\"")
                if (st == "open") main.postDelayed({ poll() }, 400) else done(st)
            }
        }
        evaluateJavascript("window.rigOpen ? rigOpen('$kind') : 'error:이전 화면 버전'") { answer ->
            val st = answer.trim('"')
            if (st == "open") main.postDelayed({ poll() }, 400) else done(st)
        }
    }

    /** Drop the loaded model (only the MediaPipe points stay). */
    fun resetModel() { evaluateJavascript("window.modelReset && modelReset()", null) }
}
