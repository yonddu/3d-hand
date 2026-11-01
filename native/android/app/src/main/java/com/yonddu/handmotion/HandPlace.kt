package com.yonddu.handmotion

import kotlin.math.abs
import kotlin.math.max
import kotlin.math.sqrt
import kotlin.math.tan

/**
 * Puts a raw MediaPipe hand in front of the camera for drawing the Quest-style
 * hand over the picture (hand.html). Camera space: meters, x right, y down,
 * z forward (MediaPipe's image axes). The camera's field of view is assumed
 * (66 degrees across the long side, as the web app's src/camera.js).
 *
 * 1. place: the translation that best lays MediaPipe's own 3D hand (world
 *    points) over its picture points (least squares, translation only).
 * 2. onRays: each point moved onto its picture ray at its depth, so the drawn
 *    hand lies over the seen hand, then the whole hand nearer or further along
 *    the rays (the picture does not change) until its palm is MediaPipe's palm.
 */
object HandPlace {
    private const val LONG_FOV = 66.0 * Math.PI / 180
    private const val MIN_Z = 0.12
    private const val MAX_Z = 1.5

    /** Focal lengths in normalized image width / height units for a frame of aspect width / height. */
    fun focal(aspect: Double): Pair<Double, Double> {
        val fw = max(1.0, 1 / aspect) * 0.5 / tan(LONG_FOV / 2)
        return Pair(fw, fw * aspect)
    }

    /** world: 63 metric values; image: 63 normalized (x, y, z). Camera-space translation, or null. */
    fun place(world: DoubleArray, image: DoubleArray, aspect: Double): DoubleArray? {
        val (fw, fh) = focal(aspect)
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
        val tz = t[2].coerceIn(MIN_Z, MAX_Z)
        var sx = 0.0; var sy = 0.0
        for (j in 0 until 21) {
            sx += (image[j * 3] - 0.5) * (world[j * 3 + 2] + tz) / fw - world[j * 3]
            sy += (image[j * 3 + 1] - 0.5) * (world[j * 3 + 2] + tz) / fh - world[j * 3 + 1]
        }
        return doubleArrayOf(sx / 21, sy / 21, tz)
    }

    /** The hand's 21 camera-space points (63) on their picture rays, or null. */
    fun onRays(world: DoubleArray, image: DoubleArray, aspect: Double): DoubleArray? {
        val t = place(world, image, aspect) ?: return null
        val (fw, fh) = focal(aspect)
        val cam = DoubleArray(63)
        for (j in 0 until 21) {
            val z = max(world[j * 3 + 2] + t[2], 0.02)
            cam[j * 3] = (image[j * 3] - 0.5) * z / fw
            cam[j * 3 + 1] = (image[j * 3 + 1] - 0.5) * z / fh
            cam[j * 3 + 2] = z
        }
        val k = palm(world) / max(dist(cam, 9, 0), 1e-6)
        if (!k.isFinite() || k <= 0) return null
        for (i in cam.indices) cam[i] *= k
        return cam
    }

    /** Wrist -> middle-finger root (m). */
    fun palm(p: DoubleArray) = dist(p, 9, 0)

    private fun dist(p: DoubleArray, a: Int, b: Int): Double {
        val dx = p[a * 3] - p[b * 3]; val dy = p[a * 3 + 1] - p[b * 3 + 1]; val dz = p[a * 3 + 2] - p[b * 3 + 2]
        return sqrt(dx * dx + dy * dy + dz * dz)
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
}
