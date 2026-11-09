package com.yonddu.handmotion

import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.acos
import kotlin.math.sqrt
import kotlin.math.tanh

/**
 * The learned finger bend model of the app view (hand-view/fingercorr.js, v0.68) for the saved FBX.
 * MLP 137-128-128-14 (gelu) from MediaPipe's world points (turn-free: points and bones in the palm
 * frame + 14 bone angles, a left hand mirrored) to the 14 bends the Meta Quest measured on the same
 * moves (degrees, + = toward the palm): thumb MCP, IP, then index / middle / ring / pinky MCP, PIP, DIP.
 * Weights: resources/fingercorr.bin (same numbers as fingercorr.json).
 */
object FingerCorr {
    private class Layer(val i: Int, val o: Int, val w: FloatArray, val b: FloatArray)
    private class Model(val mu: FloatArray, val sd: FloatArray, val layers: List<Layer>, val yscale: Float)
    private val model: Model? by lazy { runCatching { load() }.getOrNull() }

    private fun load(): Model {
        val bytes = FingerCorr::class.java.getResourceAsStream("/fingercorr.bin")!!.use { it.readBytes() }
        val b = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
        require(b.int == 0x46435231) { "fingercorr.bin" }
        val nIn = b.int; val nL = b.int; b.int
        val shapes = (0 until nL).map { b.int to b.int }
        val yscale = b.float
        fun floats(n: Int) = FloatArray(n) { b.float }
        val mu = floats(nIn); val sd = floats(nIn)
        val layers = shapes.map { (i, o) -> Layer(i, o, floats(i * o), floats(o)) }
        return Model(mu, sd, layers, yscale)
    }

    private val BONES = arrayOf(0 to 1, 1 to 2, 2 to 3, 3 to 4, 0 to 5, 5 to 6, 6 to 7, 7 to 8, 0 to 9, 9 to 10, 10 to 11, 11 to 12,
        0 to 13, 13 to 14, 14 to 15, 15 to 16, 0 to 17, 17 to 18, 18 to 19, 19 to 20)
    val TRI = arrayOf(intArrayOf(1, 2, 3), intArrayOf(2, 3, 4), intArrayOf(0, 5, 6), intArrayOf(5, 6, 7), intArrayOf(6, 7, 8),
        intArrayOf(0, 9, 10), intArrayOf(9, 10, 11), intArrayOf(10, 11, 12), intArrayOf(0, 13, 14), intArrayOf(13, 14, 15),
        intArrayOf(14, 15, 16), intArrayOf(0, 17, 18), intArrayOf(17, 18, 19), intArrayOf(18, 19, 20))

    private fun dot(a: DoubleArray, b: DoubleArray) = a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
    private fun sub(a: DoubleArray, b: DoubleArray) = doubleArrayOf(a[0] - b[0], a[1] - b[1], a[2] - b[2])
    private fun len(a: DoubleArray) = sqrt(dot(a, a))

    fun features(world: DoubleArray, side: String): DoubleArray {
        val m = if (side == "left") -1.0 else 1.0
        val w = Array(21) { j -> doubleArrayOf(m * world[3 * j], world[3 * j + 1], world[3 * j + 2]) }
        var y = sub(w[9], w[0]); val sc = len(y); y = DoubleArray(3) { y[it] / sc }
        var x = sub(w[5], w[17]); val xy = dot(x, y); x = DoubleArray(3) { x[it] - y[it] * xy }; val xn = len(x); x = DoubleArray(3) { x[it] / xn }
        val z = doubleArrayOf(x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0])
        val out = DoubleArray(137); var k = 0
        for (j in 0 until 21) { val d = sub(w[j], w[0]); out[k++] = dot(d, x) / sc; out[k++] = dot(d, y) / sc; out[k++] = dot(d, z) / sc }
        for ((a, c) in BONES) { val d = sub(w[c], w[a]); val n = len(d).takeIf { it > 0 } ?: 1.0; out[k++] = dot(d, x) / n; out[k++] = dot(d, y) / n; out[k++] = dot(d, z) / n }
        for (t in TRI) { val u = sub(w[t[1]], w[t[0]]); val v = sub(w[t[2]], w[t[1]]); val n = (len(u) * len(v)).takeIf { it > 0 } ?: 1.0; out[k++] = acos((dot(u, v) / n).coerceIn(-1.0, 1.0)) }
        return out
    }

    private fun gelu(x: Double) = 0.5 * x * (1 + tanh(0.7978845608028654 * (x + 0.044715 * x * x * x)))

    /** 14 bends (degrees) or null (no model / bad points). */
    fun predict(world: DoubleArray, side: String): DoubleArray? {
        val md = model ?: return null
        if (world.size < 63) return null
        val f = features(world, side)
        var h = DoubleArray(f.size) { (f[it] - md.mu[it]) / md.sd[it] }
        if (!h.all { it.isFinite() }) return null
        md.layers.forEachIndexed { li, l ->
            val o = DoubleArray(l.o) { l.b[it].toDouble() }
            for (i in 0 until l.i) { val v = h[i]; if (v == 0.0) continue; val r = i * l.o; for (j in 0 until l.o) o[j] += v * l.w[r + j] }
            if (li < md.layers.size - 1) for (j in 0 until l.o) o[j] = gelu(o[j])
            h = o
        }
        return DoubleArray(h.size) { h[it] * md.yscale }
    }
}
