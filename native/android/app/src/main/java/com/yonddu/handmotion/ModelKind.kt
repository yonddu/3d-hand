package com.yonddu.handmotion

/** Model file kind from its first bytes: "glb", "fbx" (binary or text), "gltf", "zip" or null. */
object ModelKind {
    fun of(b: ByteArray): String? {
        fun starts(s: String, at: Int = 0) = b.size >= at + s.length && s.indices.all { b[at + it] == s[it].code.toByte() }
        if (starts("glTF")) return "glb"
        if (starts("Kaydara FBX Binary")) return "fbx"
        if (starts("PK\u0003\u0004")) return "zip"
        val head = String(b, 0, minOf(b.size, 4096), Charsets.UTF_8).trimStart('\uFEFF', ' ', '\t', '\r', '\n')
        if (head.startsWith(";") && (head.contains("FBX") || head.contains("FBXHeaderExtension"))) return "fbx"
        if (head.contains("FBXHeaderExtension")) return "fbx"
        if (head.startsWith("{") && head.contains("\"asset\"")) return "gltf"
        return null
    }
}
