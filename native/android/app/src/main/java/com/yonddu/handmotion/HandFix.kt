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
    private const val THUMB_MIN_DEG = -25.0
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
    private fun fixJoint(p: DoubleArray, chain: IntArray, j: Int, axisOf: (DoubleArray, DoubleArray) -> DoubleArray?, minDeg: Double = MIN_DEG, backDeg: Double = BACK_DEG) {
        val at = v(p, chain[j])
        val u = norm(sub(at, v(p, chain[j - 1]))) ?: return
        val w = norm(sub(v(p, chain[j + 1]), at)) ?: return
        val ax = axisOf(u, at) ?: return
        val inPlane = norm(sub(w, scale(ax, dot(w, ax)))) ?: return
        val flex = Math.toDegrees(atan2(dot(cross(u, inPlane), ax), dot(u, inPlane)))
        if (flex >= minDeg) return
        val want = if (flex < -backDeg) minOf(-flex, CAP_DEG) else minDeg
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
        // thumb MCP / IP: up to THUMB_MIN_DEG toward the back (user, v0.67), never read as flipped:
        // the Quest shows the thumb end bending back in many frames (pair1 p5 -47 deg)
        for (j in 1..2) fixJoint(p, THUMB, j, thumbAxis, THUMB_MIN_DEG, Double.MAX_VALUE)
        return p
    }

    /**
     * Each joint (parent first) turned so its Quest-style bend (angle between the bones, sign: toward
     * the palm) equals target (degrees, FingerCorr order); the rest of the finger turns with it, in the
     * bone plane it already has. Bend sign per side as in the Quest pairs (thumb opposite to fingers).
     */
    fun setBends(world: DoubleArray, side: String, target: DoubleArray?): DoubleArray {
        if (target == null || world.size < 63 || target.size < 14) return world
        val p = world.copyOf()
        val w0 = v(p, 0)
        val sgn = if (side == "left") -1.0 else 1.0
        val palm = norm(cross(sub(v(p, 5), w0), sub(v(p, 17), w0)))?.let { scale(it, sgn) } ?: return p
        val lat0 = norm(sub(v(p, 5), v(p, 17))) ?: return p
        val mid = norm(sub(v(p, 9), w0)) ?: return p
        val sg = if (dot(cross(mid, palm), lat0) >= 0) 1.0 else -1.0
        val ctr = doubleArrayOf((w0[0] + p[15] + p[51]) / 3, (w0[1] + p[16] + p[52]) / 3, (w0[2] + p[17] + p[53]) / 3)
        for (k in 0 until 14) {
            val want = target[k]; if (!want.isFinite()) continue
            val chain = if (k < 2) THUMB else FINGERS[(k - 2) / 3]
            val j = if (k < 2) k + 1 else (k - 2) % 3 + 1
            for (pass in 0..1) { // a nearly straight joint has no bone plane: turn about a set axis, then once more in the plane
                val at = v(p, chain[j]); val u = sub(at, v(p, chain[j - 1])); val w = sub(v(p, chain[j + 1]), at)
                val cal = (if (k < 2) -1.0 else 1.0) * sgn
                val lat = scale(sub(v(p, 5), v(p, 17)), cal)
                val un = norm(u) ?: break; val wn = norm(w) ?: break
                var ax = norm(cross(u, w))
                val flat = ax == null || sqrt(dot(cross(un, wn), cross(un, wn))) < 0.05
                if (flat) {
                    ax = if (k < 2) norm(cross(un, sub(ctr, at))) else norm(sub(lat0, scale(un, dot(lat0, un))))?.let { scale(it, sg) }
                    ax ?: break
                }
                if (dot(ax!!, lat) < 0) ax = scale(ax, -1.0)
                val g = Math.toDegrees(kotlin.math.acos(dot(un, wn).coerceIn(-1.0, 1.0)))
                val s0 = if (dot(cross(u, w), lat) >= 0) g else -g
                val turn = Math.toRadians(want - s0)
                for (m in j + 1 until chain.size) {
                    val q = rot(sub(v(p, chain[m]), at), ax, turn)
                    for (c in 0..2) p[chain[m] * 3 + c] = at[c] + q[c]
                }
                if (!flat) break
            }
        }
        return p
    }

    /** setBends with the learned model, then the user rules; MediaPipe points as they come. */
    fun corrected(world: DoubleArray, side: String): DoubleArray =
        noBackBend(if (useModel) setBends(world, side, FingerCorr.predict(world, side)) else world, side)
    var useModel = true

    /**
     * MediaPipe sometimes calls a hand the other hand for a frame or two (it then reads it mirrored,
     * palm for back). Such a short run (<= FLIP_FRAMES) of one side while that hand's other side is
     * missing is dropped, and every gap up to GAP_S in a hand is filled between its neighbours.
     */
    private const val FLIP_FRAMES = 3
    private const val GAP_S = 0.3
    fun mendLabels(frames: List<RawHandFrame>): List<RawHandFrame> {
        val out = frames.map { it.hands.toMutableMap() }
        val drop = ArrayList<Pair<String, IntRange>>() // decided on the frames as they came
        for (side in listOf("left", "right")) {
            val other = if (side == "left") "right" else "left"
            var i = 0
            while (i < frames.size) {
                if (frames[i].hands[side] == null) { i++; continue }
                var j = i
                while (j + 1 < frames.size && frames[j + 1].hands[side] != null) j++
                val n = j - i + 1
                if (n <= FLIP_FRAMES && (i..j).all { frames[it].hands[other] == null }) {
                    val around = (maxOf(0, i - 10)..minOf(frames.size - 1, j + 10)).count { frames[it].hands[other] != null }
                    if (around >= 2 * n) drop += side to (i..j) // the other hand all around: this is it, misnamed
                }
                i = j + 1
            }
        }
        for ((side, r) in drop) for (k in r) out[k].remove(side)
        for (side in listOf("left", "right")) {
            var last = -1
            for (i in out.indices) {
                val p = out[i][side] ?: continue
                if (last >= 0 && i - last > 1 && frames[i].t - frames[last].t <= GAP_S) {
                    val a = out[last].getValue(side); val ta = frames[last].t; val tb = frames[i].t
                    for (k in last + 1 until i) { val f = (frames[k].t - ta) / (tb - ta); out[k][side] = DoubleArray(63) { a[it] + (p[it] - a[it]) * f } }
                }
                last = i
            }
        }
        return frames.indices.map { RawHandFrame(frames[it].t, out[it]) }
    }

    /**
     * Whole take (user: fix the flicker using the frames before and after). Per hand, over each run
     * of frames it is seen in (gaps > 0.3 s split runs): the per-frame fix, then per point a median
     * over +-2 frames (one-off misreads) and a Gaussian over +-SIGMA s, then the fix again so the
     * smoothing cannot leave a joint bent back. hv/hf4.py on 4 takes: points moving > 1.5 cm in one
     * frame 170/833/474/288 (raw) -> 29/77/184/278, back-bent joints 0.
     */
    private const val SIGMA = 0.12
    fun cleanTake(frames0: List<RawHandFrame>): List<RawHandFrame> {
        val frames = mendLabels(frames0)
        val out = frames.map { it.hands.toMutableMap() }
        for (side in listOf("left", "right")) {
            var i = 0
            while (i < frames.size) {
                if (frames[i].hands[side] == null) { i++; continue }
                var j = i
                while (j + 1 < frames.size && frames[j + 1].hands[side] != null && frames[j + 1].t - frames[j].t < 0.3) j++
                val idx = (i..j).toList()
                val fixed = idx.map { corrected(frames[it].hands.getValue(side), side) }
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
