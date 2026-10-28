package com.yonddu.handmotion

import org.junit.Assert.assertEquals
import org.junit.Test

class TimingTest {
    @Test fun fpsUsesWallTimeIncludingGaps() {
        val timing = Timing()
        timing.add(0.0, 1.0, 10.0, 12.0)
        timing.add(100.0, 1.0, 10.0, 12.0)
        timing.add(200.0, 1.0, 10.0, 12.0)
        assertEquals(10.0, timing.fps(), 0.001)
    }
    @Test fun windowEvictsOldSamplesAndResetClearsThem() {
        val timing = Timing(2)
        timing.add(0.0, 99.0, 99.0, 99.0)
        timing.add(100.0, 2.0, 4.0, 6.0)
        timing.add(200.0, 3.0, 5.0, 7.0)
        assertEquals(4.0, timing.percentile(2, 0.5), 0.001)
        assertEquals(5.0, timing.percentile(2, 1.0), 0.001)
        timing.clear()
        assertEquals(0.0, timing.fps(), 0.001)
    }
}
