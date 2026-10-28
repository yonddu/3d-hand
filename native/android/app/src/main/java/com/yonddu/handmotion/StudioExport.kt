package com.yonddu.handmotion

import android.util.Base64
import android.webkit.JavascriptInterface
import java.io.File
import java.io.FileOutputStream
import java.util.UUID

/** Only packaged, offline Studio code can access this bridge. No filesystem paths from JS. */
class StudioExport(private val cache: File, private val onReady: () -> Unit,
                   private val onSave: (File, String) -> Unit) {
    private var token: String? = null
    private var file: File? = null
    private var stream: FileOutputStream? = null
    private var expected = 0
    private var written = 0
    private var filename = "motion.glb"
    private var pickerOpen = false

    @JavascriptInterface fun ready() = onReady()

    @JavascriptInterface @Synchronized fun beginExport(name: String, size: Int): String {
        if (token != null || pickerOpen || size !in 20..(64 * 1024 * 1024)) return ""
        val id = UUID.randomUUID().toString()
        val target = File.createTempFile("hms-glb-", ".glb", cache)
        return try {
            stream = FileOutputStream(target); file = target; token = id
            expected = size; written = 0
            filename = name.substringAfterLast('/').substringAfterLast('\\')
                .replace(Regex("[^\\p{L}\\p{N}_.-]"), "_").take(100).let { if (it.endsWith(".glb")) it else "$it.glb" }
            id
        } catch (_: Exception) { target.delete(); "" }
    }

    @JavascriptInterface @Synchronized fun appendExport(id: String, chunk: String): Boolean {
        if (id != token || stream == null || chunk.length > 32768) return false
        return try {
            val bytes = Base64.decode(chunk, Base64.NO_WRAP)
            if (bytes.size > 24576 || written + bytes.size > expected) return false
            stream!!.write(bytes); written += bytes.size; true
        } catch (_: Exception) { false }
    }

    @JavascriptInterface @Synchronized fun finishExport(id: String): Boolean {
        if (id != token || written != expected || stream == null) return false
        return try {
            stream!!.close(); stream = null
            val target = file ?: return false
            // Reject accidental non-GLB transfers before opening Android's picker.
            val magic = target.inputStream().use { input -> ByteArray(4).also { input.read(it) } }
            if (!magic.contentEquals(byteArrayOf(0x67, 0x6c, 0x54, 0x46))) { cancelExport(id); return false }
            pickerOpen = true
            onSave(target, filename); true
        } catch (_: Exception) { cancelExport(id); false }
    }

    @JavascriptInterface @Synchronized fun cancelExport(id: String) {
        if (id != token || pickerOpen) return
        clear()
    }

    @Synchronized fun clear() {
        stream?.close(); stream = null; file?.delete(); file = null
        token = null; pickerOpen = false; expected = 0; written = 0
    }
}
