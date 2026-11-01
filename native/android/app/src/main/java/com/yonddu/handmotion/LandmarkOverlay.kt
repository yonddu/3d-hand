package com.yonddu.handmotion

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.view.View
import kotlin.math.min

class LandmarkOverlay(context: Context) : View(context) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.CYAN; strokeWidth = 3f }
    private var hands: List<List<Pair<Float, Float>>> = emptyList()
    private var body: List<Triple<Float, Float, Float>> = emptyList()
    private val bodyPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(255, 196, 64); strokeWidth = 4f }
    private var frameWidth = 1
    private var frameHeight = 1
    /** body: MediaPipe Pose's 33 points (x, y, visibility), or empty. */
    fun update(points: List<List<Pair<Float, Float>>>, pose: List<Triple<Float, Float, Float>>, width: Int, height: Int) {
        hands = points; body = pose; frameWidth = width; frameHeight = height; invalidate()
    }
    override fun onDraw(canvas: Canvas) {
        val scale = min(width.toFloat() / frameWidth, height.toFloat() / frameHeight)
        val ox = (width - frameWidth * scale) / 2
        val oy = (height - frameHeight * scale) / 2
        if (body.size >= 33) {
            fun seen(i: Int) = body[i].third >= MIN_SEEN
            fun bp(i: Int) = Pair(ox + body[i].first * frameWidth * scale, oy + body[i].second * frameHeight * scale)
            for ((a, b) in BODY_LINES) if (seen(a) && seen(b)) {
                val p = bp(a); val q = bp(b)
                canvas.drawLine(p.first, p.second, q.first, q.second, bodyPaint)
            }
            for (i in 0 until 33) if (seen(i)) { val p = bp(i); canvas.drawCircle(p.first, p.second, 6f, bodyPaint) }
        }
        for (hand in hands) {
            fun point(i: Int) = Pair(ox + hand[i].first * frameWidth * scale, oy + hand[i].second * frameHeight * scale)
            for (root in listOf(1, 5, 9, 13, 17)) {
                val ids = listOf(0, root, root + 1, root + 2, root + 3)
                ids.zipWithNext().forEach { (a, b) ->
                    val p = point(a); val q = point(b)
                    canvas.drawLine(p.first, p.second, q.first, q.second, paint)
                }
            }
            hand.indices.forEach { val p = point(it); canvas.drawCircle(p.first, p.second, 5f, paint) }
        }
    }

    companion object {
        private const val MIN_SEEN = 0.5f
        // MediaPipe Pose: face, shoulders-arms-hands, trunk, legs-feet.
        private val BODY_LINES = listOf(0 to 2, 2 to 7, 0 to 5, 5 to 8, 9 to 10,
            11 to 12, 11 to 13, 13 to 15, 15 to 17, 15 to 19, 15 to 21, 17 to 19, 12 to 14, 14 to 16, 16 to 18, 16 to 20, 16 to 22, 18 to 20,
            11 to 23, 12 to 24, 23 to 24, 23 to 25, 25 to 27, 27 to 29, 29 to 31, 27 to 31, 24 to 26, 26 to 28, 28 to 30, 30 to 32, 28 to 32)
    }
}
