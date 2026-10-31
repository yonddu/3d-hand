package com.yonddu.handmotion

import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.roundToLong
import org.junit.Assert.*
import org.junit.Test

class RawFbxTest {
    @Test fun rawSkeletonBinaryAndIndependentFixture() {
        val frames = (0..4).map { f ->
            val hands = mutableMapOf<String, DoubleArray>()
            val image = mutableMapOf<String, DoubleArray>()
            for (side in listOf("left", "right")) if (!(side == "left" && f == 2)) {
                hands[side] = DoubleArray(63) { i ->
                    val j=i/3;when(i%3){0->(if(side=="left")-.03 else .03)+j*.002+f*.003;1->-j*.004-f*.002;else->-.02+j*.001+f*.002}
                }
                // Picture points of that hand about 40 cm in front of the camera.
                val (fw, fh) = ArmRig.focal(9.0 / 16)
                image[side] = DoubleArray(63) { i ->
                    val p = hands.getValue(side); val j = i / 3; val z = p[j * 3 + 2] + 0.4
                    when (i % 3) { 0 -> 0.5 + fw * (p[j * 3] + (if (side == "left") -0.1 else 0.1)) / z; 1 -> 0.5 + fh * (p[j * 3 + 1] + 0.05) / z; else -> 0.0 }
                }
            }
            RawHandFrame(3.0+f*.1,hands,image)
        }
        val bytes=RawFbx.encode(frames,"RawFixture")
        assertEquals("Kaydara FBX Binary  ",bytes.copyOfRange(0,20).toString(Charsets.US_ASCII))
        assertEquals(7400,ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).getInt(23))
        val text=bytes.toString(Charsets.ISO_8859_1)
        assertTrue(text.contains("RightHandIndex2"));assertTrue(text.contains("LeftHandPinky4"))
        assertTrue(text.contains("RightForeArm"));assertTrue(text.contains("LeftArm"))
        assertFalse(text.contains("Geometry"));assertFalse(text.contains("SkinningType"))
        val dir=File("build/fbx-fixtures").apply{mkdirs()};File(dir,"raw.fbx").writeBytes(bytes)
        // Times + presence + all original world positions for an independent importer.
        val n=RawFbx.JOINTS*3
        val ref=ByteBuffer.allocate(8+frames.size*(8+2*(4+n*8))).order(ByteOrder.LITTLE_ENDIAN)
        ref.putInt(frames.size).putInt(RawFbx.JOINTS)
        frames.forEach { frame ->
            // Evaluate at the same integer FBX tick as the encoded key.
            // Floating subtraction may fall just before a stepped reappearance key.
            ref.putDouble(((frame.t-frames[0].t)*46186158000.0).roundToLong()/46186158000.0)
            listOf("left","right").forEach { side ->
                val p=RawFbx.joints(frame,side);ref.putInt(if(p==null)0 else 1)
                for(i in 0 until n)ref.putDouble(if(p==null)0.0 else if(i%3==0)p[i] else -p[i])
            }
        }
        File(dir,"raw-reference.bin").writeBytes(ref.array())
    }
    @Test fun armReachesTheWristFromTheShoulder() {
        val world = DoubleArray(63) { i -> val j = i / 3; when (i % 3) { 0 -> j * .002; 1 -> -j * .004; else -> 0.0 } }
        val (fw, fh) = ArmRig.focal(9.0 / 16)
        val image = DoubleArray(63) { i -> val j = i / 3; when (i % 3) { 0 -> 0.5 + fw * (world[j * 3] + 0.1) / 0.4; 1 -> 0.5 + fh * (world[j * 3 + 1] + 0.05) / 0.4; else -> 0.0 } }
        val t = ArmRig.place(world, image, 9.0 / 16)!!
        assertEquals(0.1, t[0], 1e-6); assertEquals(0.05, t[1], 1e-6); assertEquals(0.4, t[2], 1e-6)
        val cam = ArmRig.cameraPoints(world, t)
        val (s, e) = ArmRig.arm("right", cam)
        assertEquals(ArmRig.UPPER, ArmRig.len(ArmRig.sub(e, s)), 1e-6)
        assertEquals(ArmRig.FORE, ArmRig.len(ArmRig.sub(doubleArrayOf(cam[0], cam[1], cam[2]), e)), 1e-6)
        assertTrue("elbow below the wrist", e[1] > cam[1])
    }
    @Test fun rejectsEmptyOrInvalidTimeline() {
        try{RawFbx.encode(emptyList());fail("empty must fail")}catch(_:IllegalArgumentException){}
        try{RawFbx.encode(listOf(RawHandFrame(0.0,emptyMap())));fail("no hands must fail")}catch(_:IllegalArgumentException){}
        val p=DoubleArray(63){it*.001}
        try{RawFbx.encode(listOf(RawHandFrame(1.0,mapOf("right" to p)),RawHandFrame(0.0,mapOf("right" to p))));fail("time order must fail")}catch(_:IllegalArgumentException){}
    }
}
