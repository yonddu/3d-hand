package com.yonddu.handmotion

import kotlin.math.atan2
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.tan

/**
 * The forearm over time, the web app's ArmRig.followElbow (src/arm.js):
 * bending the wrist turns the hand about the wrist while the wrist stays put,
 * so the forearm keeps its place and the hand shows the bend. Moving the arm
 * carries the wrist, and the forearm then eases back onto the hand's line.
 * The picture's forearm line only pulls gently (sleeves, desks). The bend
 * stays inside the wrist's range. Pinning the forearm to the hand's line
 * swung the whole forearm with every wrist bend (web v40, and native v0.9/0.10).
 *
 * One per hand side, fed frames in time order (t in seconds).
 */
class ArmFollower {
    private var dir: DoubleArray? = null // camera space, wrist -> elbow, unit
    private var lastPivot: DoubleArray? = null
    private var calm: DoubleArray? = null
    private var lastT = Double.NaN

    fun reset() { dir = null; lastPivot = null; calm = null; lastT = Double.NaN }

    /** cam: the hand's 21 camera-space points (63). seen: the picture's forearm direction or null. */
    fun step(t: Double, cam: DoubleArray, seen: DoubleArray?): DoubleArray {
        val pivot = doubleArrayOf(cam[0], cam[1], cam[2])
        val dt = if (lastT.isNaN()) 1.0 else (t - lastT)
        lastT = t
        val f = (dt * 30).coerceIn(0.0, 3.0) // web numbers are per frame at 30 fps
        val jump = lastPivot?.let { ArmRig.len(ArmRig.sub(pivot, it)) } ?: Double.POSITIVE_INFINITY
        lastPivot = pivot
        val lost = jump > 0.15 || dt > 0.5 || dt <= 0
        // Wrist travel through a light average, so tracking jitter does not count as moving.
        val was = if (lost || calm == null) pivot else calm!!
        val now = lerp(was, pivot, 1 - 0.7.pow(f))
        calm = now
        val travel = ArmRig.len(ArmRig.sub(was, now)) / max(f, 1e-3) // m per 30 fps frame

        // Hand frame: y wrist -> middle root, x across the knuckles, z out of the palm plane.
        val y = unit(ArmRig.sub(doubleArrayOf(cam[27], cam[28], cam[29]), pivot)) ?: return dir ?: ArmRig.handBack(cam)
        val across = ArmRig.sub(doubleArrayOf(cam[15], cam[16], cam[17]), doubleArrayOf(cam[51], cam[52], cam[53]))
        val z = unit(ArmRig.cross(across, y)) ?: return dir ?: ArmRig.handBack(cam)
        val x = ArmRig.cross(y, z)
        fun toHand(d: DoubleArray) = doubleArrayOf(ArmRig.dot(d, x), ArmRig.dot(d, y), ArmRig.dot(d, z))
        val rest = doubleArrayOf(0.0, -1.0, 0.0)

        var d = if (lost || dir == null) rest else toHand(dir!!)
        if (d[1] > -0.2) d = rest // a forearm ahead of the hand is no wrist bend
        // Ease back onto the hand's line while the wrist travels (past 4 mm a frame;
        // 2.4 cm or more: a third of the way each frame); a still wrist keeps its bend.
        val perFrame = 0.002 + 0.3 * ((travel - 0.004) / 0.02).coerceIn(0.0, 1.0)
        val ease = 1 - (1 - perFrame).pow(f)
        if (seen != null) {
            val h = toHand(seen)
            if (h[1] < -0.2) d = lerp(d, h, 1 - 0.92.pow(f))
        }
        d = lerp(d, rest, ease)
        // Wrist range: flexion / extension 75 / 65 (the larger both ways: the palm side is not
        // told apart here), deviation 30 either way.
        val down = max(-d[1], 1e-3)
        val fe = atan2(d[2], down).coerceIn(-FLEX, FLEX)
        val dv = atan2(d[0], down).coerceIn(-DEV, DEV)
        val hd = unit(doubleArrayOf(tan(dv), -1.0, tan(fe)))!!
        val out = unit(ArmRig.add(ArmRig.add(ArmRig.scale(x, hd[0]), ArmRig.scale(y, hd[1])), ArmRig.scale(z, hd[2])))!!
        dir = out
        return out
    }

    private fun lerp(a: DoubleArray, b: DoubleArray, k: Double) = DoubleArray(3) { a[it] + (b[it] - a[it]) * min(max(k, 0.0), 1.0) }
    private fun unit(a: DoubleArray): DoubleArray? { val l = ArmRig.len(a); return if (l > 1e-9) ArmRig.scale(a, 1 / l) else null }

    companion object {
        private const val FLEX = 75.0 * Math.PI / 180
        private const val DEV = 30.0 * Math.PI / 180
    }
}
