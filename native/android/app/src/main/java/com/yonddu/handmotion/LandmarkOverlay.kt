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
    private var frameWidth = 1
    private var frameHeight = 1
    fun update(points: List<List<Pair<Float, Float>>>, width: Int, height: Int) {
        hands = points; frameWidth = width; frameHeight = height; invalidate()
    }
    override fun onDraw(canvas: Canvas) {
        val scale = min(width.toFloat() / frameWidth, height.toFloat() / frameHeight)
        val ox = (width - frameWidth * scale) / 2
        val oy = (height - frameHeight * scale) / 2
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
