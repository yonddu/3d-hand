package com.yonddu.handmotion

import org.junit.Assert.*
import org.junit.Test

class FingerCorrTest {
    // pair1 frame (left hand), expected bends from the Python/JS model (fingercorr.json)
    private val world = doubleArrayOf(-0.00199121772, 0.04957835, 0.0447777174, 0.0187782422, 0.0312631056, 0.0276075043, 0.0305988435, 0.0171422511, 0.0197366457, 0.0424524471, 0.00604781741, 0.00206750864, 0.0528134182, -0.00489935325, -0.0148584722, 0.00346217351, -0.00131645938, -0.00841132924, 0.0162870977, -0.0110830637, -0.0170661081, 0.0255022086, -0.0297251251, -0.00798946619, 0.0255192071, -0.0516817085, 0.00296419673, -0.00201363466, 0.000168905462, -0.00367840892, -0.00471903989, -0.0209979564, -0.00653938856, -0.010021694, -0.0451858081, -0.00255159033, -0.0130058611, -0.0734679401, 0.0146199362, -0.0035918036, -0.000503385498, 0.00350778108, -0.0118241478, -0.0128517058, 0.00242293021, -0.0209337976, -0.0343771763, 0.00755650736, -0.0267210454, -0.0611385666, 0.0184324849, -0.00677342387, 0.00543751335, 0.0209243093, -0.0171368774, -0.00360825262, 0.0176079758, -0.026756689, -0.0206370186, 0.0191329848, -0.0316180736, -0.0351743586, 0.0177563783)
    private val want = doubleArrayOf(23.265347, 6.157345, 5.231341, 7.147147, -2.667709, -10.860219, 6.010561, -4.732141, -14.567423, 8.229752, 0.414460, -20.581267, 14.735055, -6.971256)

    @Test fun modelMatchesReference() {
        val got = FingerCorr.predict(world, "left")!!
        for (k in 0 until 14) assertEquals("bend $k", want[k], got[k], 1e-3)
    }

    @Test fun setBendsHitsTargets() {
        val target = DoubleArray(14) { if (it < 2) 20.0 + it else 30.0 + it }
        val p = HandFix.setBends(world, "left", target)
        val again = HandFix.setBends(p, "left", target) // already there: nothing moves
        for (i in p.indices) assertEquals(p[i], again[i], 1e-7)
        for (b in listOf(0 to 5, 5 to 6, 6 to 7, 1 to 2, 2 to 3, 3 to 4)) { // bone lengths kept
            fun len(q: DoubleArray) = Math.sqrt((0..2).sumOf { c -> (q[b.second * 3 + c] - q[b.first * 3 + c]).let { it * it } })
            assertEquals(len(world), len(p), 1e-9)
        }
    }

    @Test fun oneFrameOtherHandIsMended() {
        val frames = (0..6).map { f ->
            val h = mutableMapOf<String, DoubleArray>()
            if (f == 3) h["right"] = world.copyOf() else h["left"] = DoubleArray(63) { world[it] + f * 0.001 }
            RawHandFrame(f / 30.0, h)
        }
        val out = HandFix.mendLabels(frames)
        assertNull(out[3].hands["right"])
        val mid = out[3].hands["left"]!!
        assertEquals(world[0] + 0.003, mid[0], 1e-9)
    }
}
