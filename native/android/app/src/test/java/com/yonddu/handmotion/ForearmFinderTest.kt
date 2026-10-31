package com.yonddu.handmotion

import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** A skin-coloured hand with a forearm running down-right on a grey wall, like the user's screenshot. */
class ForearmFinderTest {
    private val w = 160
    private val h = 284
    private val skin = (0xFF shl 24) or (0xD8 shl 16) or (0xA8 shl 8) or 0x90
    private val wall = (0xFF shl 24) or (0x9A shl 16) or (0x9A shl 8) or 0x96

    private fun picture(): IntArray {
        val px = IntArray(w * h) { wall }
        fun disc(cx: Double, cy: Double, r: Double) {
            for (y in 0 until h) for (x in 0 until w) if ((x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r) px[y * w + x] = skin
        }
        // Palm around (70, 130), forearm from the wrist (90, 160) to the bottom-right corner.
        disc(70.0, 130.0, 22.0)
        var t = 0.0
        while (t <= 1.0) { disc(90 + 70 * t, 160 + 124 * t, 14.0); t += 0.01 }
        return px
    }

    private fun hand(): DoubleArray {
        // Wrist at (90,160); fingers up-left.
        val pts = Array(21) { doubleArrayOf(90.0, 160.0) }
        val base = mapOf(1 to (80.0 to 150.0), 2 to (72.0 to 140.0), 5 to (60.0 to 115.0), 9 to (66.0 to 110.0),
            13 to (73.0 to 108.0), 17 to (82.0 to 110.0))
        for (j in 1 until 21) {
            val root = when (j) { in 1..4 -> 1; in 5..8 -> 5; in 9..12 -> 9; in 13..16 -> 13; else -> 17 }
            val (bx, by) = base[root] ?: base.getValue(1)
            val k = (j - root).toDouble()
            pts[j] = doubleArrayOf(bx - 6 * k, by - 8 * k)
        }
        pts[2] = doubleArrayOf(72.0, 140.0)
        return DoubleArray(63) { i -> if (i % 3 == 2) 0.0 else pts[i / 3][i % 3] / (if (i % 3 == 0) w else h) }
    }

    @Test
    fun findsTheForearmRunningDownRight() {
        val f = ForearmFinder()
        f.load(picture(), w, h)
        val r = f.find(hand())
        assertNotNull("no forearm found", r)
        r!!
        assertTrue("dx ${r[0]}", r[0] > 0.3)
        assertTrue("dy ${r[1]}", r[1] > 0.5)
    }

    @Test
    fun handsAtThePictureEdgeDoNotThrow() {
        val f = ForearmFinder()
        f.load(picture(), w, h)
        for (shift in listOf(-1.2, -0.6, 0.0, 0.6, 1.2)) {
            val lm = hand().also { a -> for (j in 0 until 21) { a[j * 3] += shift; a[j * 3 + 1] += shift } }
            f.find(lm)
        }
    }
}
