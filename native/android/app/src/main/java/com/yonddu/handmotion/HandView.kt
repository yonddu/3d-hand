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
 * The Quest-style hand (assets/hand.html, three.js + the MIT WebXR hand model)
 * in a see-through WebView over the camera preview. Fed on the UI thread.
 * ready turns true once the page answers "ok"; until then (or if it never
 * does) the caller keeps drawing the plain points.
 */
/** One hand for the page: side, camera-space points (63), palm (m), body-pose elbow (u, v, farther 0/1) or null. */
data class MeshHand(val side: String, val cam: DoubleArray, val palm: Double, val elbow: DoubleArray? = null)

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

    fun show(width: Int, height: Int, hands: List<MeshHand>) {
        if (busy) return // the page has not drawn the last one yet: skip, never queue up
        val (fw, fh) = HandPlace.focal(width.toDouble() / height)
        val list = JSONArray()
        for (hand in hands) {
            val pts = JSONArray()
            hand.cam.forEach { pts.put(Math.round(it * 1e5) / 1e5) }
            val o = JSONObject().put("side", hand.side).put("cam", pts).put("palm", hand.palm)
            hand.elbow?.let { e -> o.put("elbow", JSONArray().put(e[0]).put(e[1]).put(e[2])) }
            list.put(o)
        }
        val json = JSONObject().put("w", width).put("h", height).put("fw", fw).put("fh", fh).put("hands", list).toString()
        busy = true
        evaluateJavascript("window.setHands ? setHands($json) : 'missing'") { answer ->
            busy = false
            if (answer == "\"ok\"") ready = true else if (answer != "\"loading\"") lastError = "손 모델: $answer"
        }
    }

    /**
     * The user's own hand model (GLB / glTF / FBX bytes) instead of the Quest hand.
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

    /** Back to the built-in Quest hand. */
    fun resetModel() { evaluateJavascript("window.modelReset && modelReset()", null) }
}
