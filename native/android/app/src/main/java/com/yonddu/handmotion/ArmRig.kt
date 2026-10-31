package com.yonddu.handmotion

import kotlin.math.abs
import kotlin.math.max
import kotlin.math.sqrt
import kotlin.math.tan

/**
 * Wrist and arm for the raw MediaPipe hand, the way the web app did it
 * (src/arm.js, src/camera.js): the phone is at the eyes, the shoulder sits at
 * a fixed place below and beside the camera, and the elbow comes from
 * two-bone IK between that shoulder and the tracked wrist. The hand's own 21
 * points are not changed, only placed in front of the camera.
 *
 * Camera space: meters, x right, y down, z forward (MediaPipe's image axes).
 * An estimate: the camera's field of view is assumed (66 degrees across the
 * long side) and the elbow is not seen, only solved.
 */
object ArmRig {
    const val UPPER = 0.29 // shoulder -> elbow (m), web armMesh.js
    const val FORE = 0.26 // elbow -> wrist (m)
    private const val LONG_FOV = 66.0 * Math.PI / 180
    private const val NEAR = 0.05 // m: lines closer than this to the camera are cut
    private const val MIN_Z = 0.12
    private const val MAX_Z = 1.5

    /** Shoulder relative to the eyes: down, out to the side, a little behind (web ArmRig). */
    fun shoulder(side: String): DoubleArray = doubleArrayOf(if (side == "left") -0.18 else 0.18, 0.24, -0.06)

    /** Focal lengths in normalized image width / height units for a frame of aspect width / height. */
    fun focal(aspect: Double): Pair<Double, Double> {
        val fw = max(1.0, 1 / aspect) * 0.5 / tan(LONG_FOV / 2)
        return Pair(fw, fw * aspect)
    }

    /**
     * Camera-space translation of the hand's world points so they project onto
     * its picture points (least squares, translation only: MediaPipe's world
     * points already share the camera's axes). world: 63 metric values,
     * image: 63 normalized values (x, y, z) or more. null if unsolvable.
     */
    fun place(world: DoubleArray, image: DoubleArray, aspect: Double): DoubleArray? {
        val (fw, fh) = focal(aspect)
        // Rows a·T = b for T = (tx, ty, tz).
        val ata = Array(3) { DoubleArray(3) }
        val atb = DoubleArray(3)
        fun row(a0: Double, a1: Double, a2: Double, b: Double) {
            val a = doubleArrayOf(a0, a1, a2)
            for (r in 0..2) { for (c in 0..2) ata[r][c] += a[r] * a[c]; atb[r] += a[r] * b }
        }
        for (j in 0 until 21) {
            val u = image[j * 3] - 0.5
            val v = image[j * 3 + 1] - 0.5
            val x = world[j * 3]; val y = world[j * 3 + 1]; val z = world[j * 3 + 2]
            row(fw, 0.0, -u, u * z - fw * x)
            row(0.0, fh, -v, v * z - fh * y)
        }
        val t = solve3(ata, atb) ?: return null
        if (!t.all { it.isFinite() }) return null
        if (t[2] in MIN_Z..MAX_Z) return t
        // Depth out of reach: keep it at the edge and fit only the sideways shift.
        val tz = t[2].coerceIn(MIN_Z, MAX_Z)
        var sx = 0.0; var sy = 0.0
        for (j in 0 until 21) {
            sx += (image[j * 3] - 0.5) * (world[j * 3 + 2] + tz) / fw - world[j * 3]
            sy += (image[j * 3 + 1] - 0.5) * (world[j * 3 + 2] + tz) / fh - world[j * 3 + 1]
        }
        return doubleArrayOf(sx / 21, sy / 21, tz)
    }

    /** The hand's 21 points in camera space. */
    fun cameraPoints(world: DoubleArray, t: DoubleArray) = DoubleArray(63) { world[it] + t[it % 3] }

    /**
     * Shoulder and elbow for a hand whose camera-space points are cam (63).
     * The elbow bends toward where the forearm would go if it continued the
     * hand's line behind the wrist (wrist minus middle knuckle). A wrist beyond
     * reach pulls the shoulder toward it (a shrug) instead of stretching the arm.
     */
    fun arm(side: String, cam: DoubleArray): Pair<DoubleArray, DoubleArray> {
        val w = doubleArrayOf(cam[0], cam[1], cam[2])
        var s = shoulder(side)
        val reach = (UPPER + FORE) * 0.999
        val sw = sub(w, s)
        if (len(sw) > reach) s = sub(w, scale(sw, reach / len(sw)))
        val back = sub(w, doubleArrayOf(cam[27], cam[28], cam[29]))
        val pole = if (len(back) > 1e-6) add(w, scale(back, FORE / len(back))) else add(w, doubleArrayOf(0.0, 0.2, 0.0))
        return Pair(s, elbow(s, w, pole))
    }

    /** Two-bone IK (web arm.js solveElbow): elbow on its circle, on the pole's side. */
    fun elbow(s: DoubleArray, w: DoubleArray, pole: DoubleArray): DoubleArray {
        val sw = sub(w, s)
        val dir = scale(sw, 1 / max(len(sw), 1e-9))
        val d = len(sw).coerceIn(abs(UPPER - FORE) + 1e-3, UPPER + FORE - 1e-4)
        val a = (UPPER * UPPER - FORE * FORE + d * d) / (2 * d)
        val h = sqrt(max(0.0, UPPER * UPPER - a * a))
        val toPole = sub(pole, s)
        var bend = sub(toPole, scale(dir, dot(toPole, dir)))
        if (len(bend) < 1e-4) bend = sub(doubleArrayOf(0.0, 1.0, 0.0), scale(dir, dir[1])) // down
        bend = scale(bend, 1 / max(len(bend), 1e-9))
        return add(add(s, scale(dir, a)), scale(bend, h))
    }

    /**
     * The picture line from a to b (camera space), cut where it passes behind
     * the camera, as normalized image points, or null if all of it is behind.
     */
    fun projectLine(a: DoubleArray, b: DoubleArray, aspect: Double): Pair<Pair<Float, Float>, Pair<Float, Float>>? {
        if (a[2] < NEAR && b[2] < NEAR) return null
        fun cut(p: DoubleArray, q: DoubleArray): DoubleArray {
            if (p[2] >= NEAR) return p
            val k = (NEAR - p[2]) / (q[2] - p[2])
            return add(p, scale(sub(q, p), k))
        }
        val (fw, fh) = focal(aspect)
        fun px(p: DoubleArray) = Pair((0.5 + fw * p[0] / p[2]).toFloat(), (0.5 + fh * p[1] / p[2]).toFloat())
        return Pair(px(cut(a, b)), px(cut(b, a)))
    }

    private fun solve3(m: Array<DoubleArray>, b: DoubleArray): DoubleArray? {
        val a = Array(3) { r -> DoubleArray(4) { c -> if (c < 3) m[r][c] else b[r] } }
        for (c in 0..2) {
            val p = (c..2).maxByOrNull { abs(a[it][c]) }!!
            if (abs(a[p][c]) < 1e-12) return null
            val tmp = a[c]; a[c] = a[p]; a[p] = tmp
            for (r in 0..2) if (r != c) {
                val f = a[r][c] / a[c][c]
                for (k in c..3) a[r][k] -= f * a[c][k]
            }
        }
        return DoubleArray(3) { a[it][3] / a[it][it] }
    }

    fun add(a: DoubleArray, b: DoubleArray) = DoubleArray(3) { a[it] + b[it] }
    fun sub(a: DoubleArray, b: DoubleArray) = DoubleArray(3) { a[it] - b[it] }
    fun scale(a: DoubleArray, k: Double) = DoubleArray(3) { a[it] * k }
    fun dot(a: DoubleArray, b: DoubleArray) = a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
    fun len(a: DoubleArray) = sqrt(dot(a, a))
}
