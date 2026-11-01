package com.yonddu.handmotion

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.webkit.WebView
import org.json.JSONArray
import org.json.JSONObject

/**
 * The Quest-style hand (assets/hand.html, three.js + the MIT WebXR hand model)
 * in a see-through WebView over the camera preview. Fed on the UI thread.
 * ready turns true once the page answers "ok"; until then (or if it never
 * does) the caller keeps drawing the plain points.
 */
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

    /** hands: (side, camera-space points 63, palm m). */
    fun show(width: Int, height: Int, hands: List<Triple<String, DoubleArray, Double>>) {
        if (busy) return // the page has not drawn the last one yet: skip, never queue up
        val (fw, fh) = HandPlace.focal(width.toDouble() / height)
        val list = JSONArray()
        for ((side, cam, palm) in hands) {
            val pts = JSONArray()
            cam.forEach { pts.put(Math.round(it * 1e5) / 1e5) }
            list.put(JSONObject().put("side", side).put("cam", pts).put("palm", palm))
        }
        val json = JSONObject().put("w", width).put("h", height).put("fw", fw).put("fh", fh).put("hands", list).toString()
        busy = true
        evaluateJavascript("window.setHands ? setHands($json) : 'missing'") { answer ->
            busy = false
            if (answer == "\"ok\"") ready = true else if (answer != "\"loading\"") lastError = "손 모델: $answer"
        }
    }
}
