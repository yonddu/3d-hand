package com.yonddu.handmotion

/** Bounded display window; raw recording is independent and never filtered by it. */
class Timing(private val capacity: Int = 120) {
    private val frames = ArrayDeque<DoubleArray>()
    fun add(atMs: Double, preprocessMs: Double, inferMs: Double, callbackMs: Double) {
        frames.addLast(doubleArrayOf(atMs, preprocessMs, inferMs, callbackMs))
        if (frames.size > capacity) frames.removeFirst()
    }
    fun clear() = frames.clear()
    fun fps(): Double {
        if (frames.size < 2) return 0.0
        val elapsed = frames.last()[0] - frames.first()[0]
        return if (elapsed > 0) (frames.size - 1) * 1000.0 / elapsed else 0.0
    }
    fun percentile(column: Int, fraction: Double): Double {
        if (frames.isEmpty()) return 0.0
        val values = frames.map { it[column] }.sorted()
        return values[((values.size - 1) * fraction).toInt()]
    }
}
