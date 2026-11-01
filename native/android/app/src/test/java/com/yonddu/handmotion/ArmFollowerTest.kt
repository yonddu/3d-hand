package com.yonddu.handmotion

import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.acos
import kotlin.math.cos
import kotlin.math.sin

class ArmFollowerTest {
    /** Hand with the wrist at w, fingers along (sin a, -cos a, 0) (up the picture), knuckles across x. */
    private fun hand(w: DoubleArray, a: Double): DoubleArray {
        val y = doubleArrayOf(sin(a), -cos(a), 0.0)
        val x = doubleArrayOf(cos(a), sin(a), 0.0)
        val cam = DoubleArray(63) { w[it % 3] }
        fun set(j: Int, p: DoubleArray) { for (k in 0..2) cam[j * 3 + k] = p[k] }
        val m = ArmRig.add(w, ArmRig.scale(y, 0.09))
        set(9, m); set(5, ArmRig.add(m, ArmRig.scale(x, 0.02))); set(17, ArmRig.add(m, ArmRig.scale(x, -0.04)))
        return cam
    }

    private fun angle(a: DoubleArray, b: DoubleArray) = Math.toDegrees(acos((ArmRig.dot(a, b) / (ArmRig.len(a) * ArmRig.len(b))).coerceIn(-1.0, 1.0)))

    @Test
    fun bendingTheWristKeepsTheForearm() {
        val f = ArmFollower()
        val w = doubleArrayOf(0.0, 0.0, 0.4)
        var t = 0.0
        var first: DoubleArray? = null
        repeat(10) { first = f.step(t, hand(w, 0.0), null); t += 1.0 / 30 }
        // Bend the wrist 50 degrees over half a second, wrist still.
        var last = first!!
        for (i in 1..15) { last = f.step(t, hand(w, Math.toRadians(50.0 * i / 15)), null); t += 1.0 / 30 }
        assertTrue("forearm swung ${angle(first!!, last)} deg", angle(first!!, last) < 8)
    }

    @Test
    fun movingTheArmBringsTheForearmBackOnTheHandLine() {
        val f = ArmFollower()
        var t = 0.0
        repeat(10) { f.step(t, hand(doubleArrayOf(0.0, 0.0, 0.4), 0.0), null); t += 1.0 / 30 }
        val a = Math.toRadians(40.0)
        var last = DoubleArray(3)
        for (i in 1..30) { last = f.step(t, hand(doubleArrayOf(0.02 * i, 0.0, 0.4), a), null); t += 1.0 / 30 }
        val line = doubleArrayOf(-sin(a), cos(a), 0.0)
        assertTrue("off the hand line ${angle(line, last)} deg", angle(line, last) < 10)
    }
}
