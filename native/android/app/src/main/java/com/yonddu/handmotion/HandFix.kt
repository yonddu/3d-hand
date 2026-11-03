package com.yonddu.handmotion

import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * User rule for the saved 21-joint hand (FBX): no finger joint bends toward the back of the hand,
 * each stays at least MIN_DEG toward the palm. MediaPipe's world points bend back in 5-27 % of
 * finger joints (depth misread). A joint read past BACK_DEG backward is a flipped read and is
 * mirrored forward; a smaller backward bend is held at MIN_DEG. The rest of the finger turns about
 * the joint (bone lengths kept). Fingers: about the knuckle line; thumb MCP/IP: about
 * bone x (joint -> middle of the palm), the way the thumb folds across the palm.
 */
object HandFix {
    private const val MIN_DEG = 5.0
    private const val BACK_DEG = 35.0
    private const val CAP_DEG = 100.0
    private val FINGERS = listOf(intArrayOf(0, 5, 6, 7, 8), intArrayOf(0, 9, 10, 11, 12), intArrayOf(0, 13, 14, 15, 16), intArrayOf(0, 17, 18, 19, 20))
    private val THUMB = intArrayOf(1, 2, 3, 4)

    private fun v(p: DoubleArray, i: Int) = doubleArrayOf(p[i * 3], p[i * 3 + 1], p[i * 3 + 2])
    private fun sub(a: DoubleArray, b: DoubleArray) = doubleArrayOf(a[0] - b[0], a[1] - b[1], a[2] - b[2])
    private fun dot(a: DoubleArray, b: DoubleArray) = a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
    private fun cross(a: DoubleArray, b: DoubleArray) = doubleArrayOf(a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])
    private fun scale(a: DoubleArray, s: Double) = doubleArrayOf(a[0] * s, a[1] * s, a[2] * s)
    private fun norm(a: DoubleArray): DoubleArray? { val l = sqrt(dot(a, a)); return if (l < 1e-9) null else scale(a, 1 / l) }

    /** Rodrigues: v turned by ang about the unit axis k. */
    private fun rot(x: DoubleArray, k: DoubleArray, ang: Double): DoubleArray {
        val c = cos(ang); val s = sin(ang); val kx = cross(k, x); val kd = dot(k, x) * (1 - c)
        return doubleArrayOf(x[0] * c + kx[0] * s + k[0] * kd, x[1] * c + kx[1] * s + k[1] * kd, x[2] * c + kx[2] * s + k[2] * kd)
    }

    /** One joint: chain[j] is the joint, chain[j-1] the point before; turns chain[j+1..] if needed. */
    private fun fixJoint(p: DoubleArray, chain: IntArray, j: Int, axisOf: (DoubleArray, DoubleArray) -> DoubleArray?) {
        val at = v(p, chain[j])
        val u = norm(sub(at, v(p, chain[j - 1]))) ?: return
        val w = norm(sub(v(p, chain[j + 1]), at)) ?: return
        val ax = axisOf(u, at) ?: return
        val inPlane = norm(sub(w, scale(ax, dot(w, ax)))) ?: return
        val flex = Math.toDegrees(atan2(dot(cross(u, inPlane), ax), dot(u, inPlane)))
        if (flex >= MIN_DEG) return
        val want = if (flex < -BACK_DEG) minOf(-flex, CAP_DEG) else MIN_DEG
        val turn = Math.toRadians(want - flex)
        for (k in j + 1 until chain.size) {
            val q = rot(sub(v(p, chain[k]), at), ax, turn)
            for (c in 0..2) p[chain[k] * 3 + c] = at[c] + q[c]
        }
    }

    /** 63 world values (MediaPipe order), corrected copy. side: the real hand ("left"/"right"). */
    fun noBackBend(world: DoubleArray, side: String): DoubleArray {
        if (world.size < 63) return world
        val p = world.copyOf()
        val w0 = v(p, 0)
        val sgn = if (side == "left") -1.0 else 1.0
        val palm = norm(cross(sub(v(p, 5), w0), sub(v(p, 17), w0)))?.let { scale(it, sgn) } ?: return p // palm side
        val lat = norm(sub(v(p, 5), v(p, 17))) ?: return p
        val mid = norm(sub(v(p, 9), w0)) ?: return p
        val sg = if (dot(cross(mid, palm), lat) >= 0) 1.0 else -1.0
        val fingerAxis = { u: DoubleArray, _: DoubleArray -> norm(sub(lat, scale(u, dot(lat, u))))?.let { scale(it, sg) } }
        for (chain in FINGERS) for (j in 1..3) fixJoint(p, chain, j, fingerAxis)
        val ctr = doubleArrayOf((w0[0] + p[15] + p[51]) / 3, (w0[1] + p[16] + p[52]) / 3, (w0[2] + p[17] + p[53]) / 3)
        val thumbAxis = { u: DoubleArray, at: DoubleArray -> norm(cross(u, sub(ctr, at))) }
        for (j in 1..2) fixJoint(p, THUMB, j, thumbAxis)
        return p
    }

    /**
     * Whole take (user: fix the flicker using the frames before and after). Per hand, over each run
     * of frames it is seen in (gaps > 0.3 s split runs): the per-frame fix, then per point a median
     * over +-2 frames (one-off misreads) and a Gaussian over +-SIGMA s, then the fix again so the
     * smoothing cannot leave a joint bent back. hv/hf4.py on 4 takes: points moving > 1.5 cm in one
     * frame 170/833/474/288 (raw) -> 29/77/184/278, back-bent joints 0.
     */
    private const val SIGMA = 0.12
    fun cleanTake(frames: List<RawHandFrame>): List<RawHandFrame> {
        val out = frames.map { it.hands.toMutableMap() }
        for (side in listOf("left", "right")) {
            var i = 0
            while (i < frames.size) {
                if (frames[i].hands[side] == null) { i++; continue }
                var j = i
                while (j + 1 < frames.size && frames[j + 1].hands[side] != null && frames[j + 1].t - frames[j].t < 0.3) j++
                val idx = (i..j).toList()
                val fixed = idx.map { noBackBend(frames[it].hands.getValue(side), side) }
                val n = fixed.size
                val med = Array(n) { a -> DoubleArray(63) { c ->
                    val win = (maxOf(0, a - 2)..minOf(n - 1, a + 2)).map { fixed[it][c] }.sorted()
                    win[win.size / 2]
                } }
                for (a in 0 until n) {
                    val ta = frames[idx[a]].t
                    val acc = DoubleArray(63); var wsum = 0.0
                    for (b in 0 until n) {
                        val dt = frames[idx[b]].t - ta
                        if (kotlin.math.abs(dt) > 3 * SIGMA) continue
                        val w = kotlin.math.exp(-0.5 * (dt / SIGMA) * (dt / SIGMA))
                        for (c in 0 until 63) acc[c] += w * med[b][c]
                        wsum += w
                    }
                    for (c in 0 until 63) acc[c] /= wsum
                    out[idx[a]][side] = noBackBend(acc, side)
                }
                i = j + 1
            }
        }
        return frames.indices.map { RawHandFrame(frames[it].t, out[it]) }
    }
}
