package com.yonddu.handmotion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test
import kotlin.math.sin

class HandPlaceTest {
    @Test
    fun pointsLieOnTheirPictureRaysWithMediaPipesPalm() {
        val aspect = 720.0 / 1280
        val (fw, fh) = HandPlace.focal(aspect)
        // A hand-ish cloud 0.4 m away; the picture points disagree a little with it (as MediaPipe's do).
        val world = DoubleArray(63) { i -> val j = i / 3; when (i % 3) { 0 -> 0.01 * sin(j * 1.3); 1 -> -0.005 * j; else -> 0.002 * (j % 4) } }
        val image = DoubleArray(63) { i ->
            val j = i / 3; val z = world[j * 3 + 2] + 0.4
            when (i % 3) { 0 -> 0.5 + fw * (world[j * 3] + 0.03) / z + 0.004 * sin(j.toDouble()); 1 -> 0.5 + fh * (world[j * 3 + 1] + 0.02) / z; else -> 0.0 }
        }
        val cam = HandPlace.onRays(world, image, aspect)
        assertNotNull(cam)
        cam!!
        for (j in 0 until 21) {
            assertEquals(image[j * 3], 0.5 + fw * cam[j * 3] / cam[j * 3 + 2], 1e-9)
            assertEquals(image[j * 3 + 1], 0.5 + fh * cam[j * 3 + 1] / cam[j * 3 + 2], 1e-9)
        }
        assertEquals(HandPlace.palm(world), HandPlace.palm(cam), 1e-9)
    }
}
