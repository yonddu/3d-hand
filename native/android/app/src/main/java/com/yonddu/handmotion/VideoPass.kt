package com.yonddu.handmotion

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Matrix
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import com.google.mediapipe.framework.image.BitmapImageBuilder
import com.google.mediapipe.tasks.core.BaseOptions
import com.google.mediapipe.tasks.core.Delegate
import com.google.mediapipe.tasks.vision.core.RunningMode
import com.google.mediapipe.tasks.vision.handlandmarker.HandLandmarker
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Record -> analyse: the take's video (recorded at the camera's 30 fps while measuring) read
 * again frame by frame, every frame through MediaPipe (live analysis keeps up with only 12-18 fps
 * and drops the rest). Frames come out in the same form as live recorded frames.
 */
object VideoPass {
    private const val BATCH = 8

    /** Presentation times (us) of the video's frames, in order (no decoding). */
    private fun frameTimes(path: String): LongArray {
        val ex = MediaExtractor()
        try {
            ex.setDataSource(path)
            val track = (0 until ex.trackCount).firstOrNull {
                ex.getTrackFormat(it).getString(MediaFormat.KEY_MIME)?.startsWith("video/") == true
            } ?: return LongArray(0)
            ex.selectTrack(track)
            val list = ArrayList<Long>()
            while (true) { val t = ex.sampleTime; if (t < 0) break; list.add(t); ex.advance() }
            list.sort()
            return list.toLongArray()
        } finally { ex.release() }
    }

    /**
     * Every frame of [file] through a fresh hand landmarker. [portrait]: the live pictures were
     * upright portrait (a landscape frame is turned by the video's rotation). [side] maps
     * MediaPipe's label to the real hand. [progress] gets (done, total).
     */
    fun run(context: Context, file: File, maxHands: Int, delegate: Delegate, portrait: Boolean,
            side: (String) -> String, progress: (Int, Int) -> Unit, cancelled: () -> Boolean): JSONArray {
        val times = frameTimes(file.path)
        val out = JSONArray()
        if (times.isEmpty()) return out
        val mmr = MediaMetadataRetriever()
        val landmarker = HandLandmarker.createFromOptions(context, HandLandmarker.HandLandmarkerOptions.builder()
            .setBaseOptions(BaseOptions.builder().setModelAssetPath("hand_landmarker.task").setDelegate(delegate).build())
            .setRunningMode(RunningMode.VIDEO)
            .setNumHands(maxHands)
            .setMinHandDetectionConfidence(0.5f)
            .setMinHandPresenceConfidence(0.5f)
            .setMinTrackingConfidence(0.3f)
            .build())
        try {
            mmr.setDataSource(file.path)
            val count = mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_FRAME_COUNT)?.toIntOrNull() ?: times.size
            val total = minOf(count, times.size)
            val rotation = mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toIntOrNull() ?: 0
            val params = MediaMetadataRetriever.BitmapParams().apply { preferredConfig = Bitmap.Config.ARGB_8888 }
            val t0 = times[0]
            var lastMs = -1L
            var i = 0
            while (i < total && !cancelled()) {
                val n = minOf(BATCH, total - i)
                val batch: List<Bitmap> = try { mmr.getFramesAtIndex(i, n, params) } catch (e: Exception) {
                    (0 until n).mapNotNull { k -> try { mmr.getFrameAtIndex(i + k, params) } catch (e2: Exception) { null } }
                }
                for ((k, raw) in batch.withIndex()) {
                    val turn = if (portrait != (raw.height >= raw.width)) (if (rotation != 0) rotation else 90) else 0
                    val img = if (turn == 0) raw else Bitmap.createBitmap(raw, 0, 0, raw.width, raw.height,
                        Matrix().apply { postRotate(turn.toFloat()) }, true).also { raw.recycle() }
                    val us = times[i + k] - t0
                    val ms = maxOf(us / 1000, lastMs + 1); lastMs = ms
                    val w = img.width; val h = img.height
                    val input = BitmapImageBuilder(img).build()
                    val result = try { landmarker.detectForVideo(input, ms) } finally { input.close() } // close() recycles img
                    val hands = JSONArray()
                    result.landmarks().forEachIndexed { j, points ->
                        val category = result.handedness()[j][0]
                        val lm = JSONArray()
                        points.forEach { lm.put(it.x().toDouble()).put(it.y().toDouble()).put(it.z().toDouble()) }
                        val world = JSONArray()
                        result.worldLandmarks()[j].forEach { world.put(it.x().toDouble()).put(it.y().toDouble()).put(it.z().toDouble()) }
                        hands.put(JSONObject().put("label", side(category.categoryName()))
                            .put("score", category.score().toDouble()).put("lm", lm).put("world", world))
                    }
                    out.put(JSONObject().put("t", us / 1e6).put("hands", hands)
                        .put("imageWidth", w).put("imageHeight", h)
                        .put("maxHands", maxHands).put("delegate", "mediapipe-" + delegate.name.lowercase())
                        .put("source", "video"))
                }
                i += n
                progress(i, total)
            }
        } finally {
            landmarker.close()
            mmr.release()
        }
        return out
    }
}
