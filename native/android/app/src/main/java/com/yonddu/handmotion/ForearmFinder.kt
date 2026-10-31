package com.yonddu.handmotion

import android.graphics.Bitmap
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Forearm direction straight from the camera picture (port of the web app's
 * src/forearm.js). The forearm is usually in the frame, running from the
 * wrist to the edge of the picture, with the same skin colour as the hand:
 * learn that colour from the palm, then look around the wrist (away from the
 * fingers) for the longest unbroken run of it.
 */
class ForearmFinder {
    private var w = 0
    private var h = 0
    private var px = IntArray(0)

    /** Takes the frame once (scaled to 160 px wide; small is enough for a forearm). */
    fun grab(frame: Bitmap) {
        val sw = 160
        val sh = max(1, (sw.toDouble() * frame.height / frame.width).roundToInt())
        val small = Bitmap.createScaledBitmap(frame, sw, sh, true)
        w = sw; h = sh
        if (px.size != w * h) px = IntArray(w * h)
        small.getPixels(px, 0, w, 0, 0, w, h)
        if (small !== frame) small.recycle()
    }

    private fun chroma(x: Double, y: Double): DoubleArray? {
        val xi = x.roundToInt(); val yi = y.roundToInt()
        if (xi < 0 || yi < 0 || xi >= w || yi >= h) return null
        val c = px[yi * w + xi]
        val r = (c shr 16 and 255).toDouble(); val g = (c shr 8 and 255).toDouble(); val b = (c and 255).toDouble()
        return doubleArrayOf(0.299 * r + 0.587 * g + 0.114 * b, 128 - 0.169 * r - 0.331 * g + 0.5 * b, 128 + 0.5 * r - 0.419 * g - 0.081 * b)
    }

    /**
     * lm: the hand's normalized picture points (x, y, z per point, 63).
     * Returns (dx, dy, confidence): the forearm's direction from the wrist in
     * picture pixels (x right, y down, unit length), or null.
     */
    fun find(lm: DoubleArray): DoubleArray? {
        if (w == 0) return null
        fun p(i: Int) = doubleArrayOf(lm[i * 3] * w, lm[i * 3 + 1] * h)
        val wrist = p(0); val mid = p(9)
        val palm = hypot(mid[0] - wrist[0], mid[1] - wrist[1])
        if (palm < 4) return null
        val samples = ArrayList<DoubleArray>()
        for ((a, b) in listOf(0 to 5, 0 to 9, 0 to 13, 0 to 17, 5 to 17, 1 to 5, 9 to 13)) for (t in listOf(0.35, 0.5, 0.65)) {
            val x = (lm[a * 3] + (lm[b * 3] - lm[a * 3]) * t) * w
            val y = (lm[a * 3 + 1] + (lm[b * 3 + 1] - lm[a * 3 + 1]) * t) * h
            for ((dx, dy) in listOf(0 to 0, 1 to 0, 0 to 1, -1 to 0, 0 to -1)) chroma(x + dx, y + dy)?.let { samples += it }
        }
        if (samples.size < 20) return null
        val mean = DoubleArray(3) { k -> samples.sumOf { it[k] } / samples.size }
        val sd = DoubleArray(3) { k -> sqrt(samples.sumOf { (it[k] - mean[k]) * (it[k] - mean[k]) } / samples.size) }
        val tolCb = 2.5 * max(sd[1], 2.0) + 3
        val tolCr = 2.5 * max(sd[2], 2.0) + 3
        val tolY = 3 * max(sd[0], 8.0) + 25
        fun isSkin(x: Double, y: Double): Boolean? {
            val c = chroma(x, y) ?: return null // off the picture: the arm leaves the frame here
            return abs(c[1] - mean[1]) < tolCb && abs(c[2] - mean[2]) < tolCr && abs(c[0] - mean[0]) < tolY
        }
        val hull = listOf(0, 1, 2, 5, 9, 13, 17).map { p(it) }
        fun inHand(x: Double, y: Double): Boolean {
            var inside = false
            var j = hull.size - 1
            for (i in hull.indices) {
                val (xi, yi) = hull[i][0] to hull[i][1]; val (xj, yj) = hull[j][0] to hull[j][1]
                if ((yi > y) != (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside
                j = i
            }
            return inside
        }
        val back = atan2(wrist[1] - mid[1], wrist[0] - mid[0])
        val r0 = 0.3 * palm; val r1 = 2.6 * palm; val step = max(1.0, palm / 12)
        val runs = ArrayList<Pair<Double, Double>>()
        for (da in -70..70 step 5) {
            val a = back + Math.toRadians(da.toDouble())
            val c = cos(a); val s = sin(a)
            var run = 0.0; var miss = 0; var r = r0
            while (r <= r1) {
                val x = wrist[0] + c * r; val y = wrist[1] + s * r
                if (!inHand(x, y)) {
                    val k = isSkin(x, y)
                    if (k == null) { run = r1; break } // reached the picture's edge still on skin
                    if (k) { run = r; miss = 0 } else if (++miss > 2) break
                }
                r += step
            }
            // Wrists bend less than they could: prefer lines close to the hand's own.
            runs += a to run * (0.75 + 0.25 * cos(Math.toRadians(da.toDouble())))
        }
        val best = runs.maxOf { it.second }
        if (best < 0.9 * palm) return null
        // Average the near-best rays (the forearm is wide).
        var sx = 0.0; var sy = 0.0
        for ((a, run) in runs) if (run >= 0.85 * best) { sx += cos(a) * run; sy += sin(a) * run }
        val n = hypot(sx, sy).takeIf { it > 0 } ?: return null
        return doubleArrayOf(sx / n, sy / n, min(1.0, best / (2 * palm)))
    }
}
