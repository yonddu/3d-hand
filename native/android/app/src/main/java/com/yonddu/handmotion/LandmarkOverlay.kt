package com.yonddu.handmotion

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.view.View
import kotlin.math.min

class LandmarkOverlay(context: Context) : View(context) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.CYAN; strokeWidth = 3f }
    private val armPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(255, 160, 40); strokeWidth = 8f; strokeCap = Paint.Cap.ROUND }
    private var hands: List<List<Pair<Float, Float>>> = emptyList()
    private var arms: List<Pair<Pair<Float, Float>, Pair<Float, Float>>> = emptyList()
    private var frameWidth = 1
    private var frameHeight = 1
    /** arms: forearm / upper arm lines in normalized picture points (ArmRig.projectLine). */
    fun update(points: List<List<Pair<Float, Float>>>, armLines: List<Pair<Pair<Float, Float>, Pair<Float, Float>>>, width: Int, height: Int) {
        hands = points; arms = armLines; frameWidth = width; frameHeight = height; invalidate()
    }
    override fun onDraw(canvas: Canvas) {
        val scale = min(width.toFloat() / frameWidth, height.toFloat() / frameHeight)
        val ox = (width - frameWidth * scale) / 2
        val oy = (height - frameHeight * scale) / 2
        canvas.save()
        canvas.clipRect(ox, oy, ox + frameWidth * scale, oy + frameHeight * scale)
        for ((a, b) in arms) canvas.drawLine(ox + a.first * frameWidth * scale, oy + a.second * frameHeight * scale,
            ox + b.first * frameWidth * scale, oy + b.second * frameHeight * scale, armPaint)
        canvas.restore()
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
}
