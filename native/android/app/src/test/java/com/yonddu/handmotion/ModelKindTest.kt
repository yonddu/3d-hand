package com.yonddu.handmotion

import org.junit.Assert.assertEquals
import org.junit.Test

class ModelKindTest {
    private fun b(s: String) = s.toByteArray(Charsets.ISO_8859_1)

    @Test fun kindsFromFirstBytes() {
        assertEquals("glb", ModelKind.of(b("glTF\u0002\u0000\u0000\u0000")))
        assertEquals("fbx", ModelKind.of(b("Kaydara FBX Binary  \u0000\u001a\u0000")))
        assertEquals("fbx", ModelKind.of(b("; FBX 7.4.0 project file\nFBXHeaderExtension:  {")))
        assertEquals("gltf", ModelKind.of(b("{\n  \"asset\": {\"version\": \"2.0\"}}")))
        assertEquals("zip", ModelKind.of(b("PK\u0003\u0004rest")))
        assertEquals(null, ModelKind.of(b("hello")))
    }
}
