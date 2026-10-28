# improve/26 — thumb remembers which side of each finger it is on (2026-10-28)

User (00:38): rig points and bone lines cross and go through; can't it be blocked? (pencil grip: thumb through index and on into middle)
Cause (code): handBody.js separateThumb pushes the thumb out along the shortest way (c1 - c2). A thumb that sank past a finger's middle, or whose depth flipped in one frame, is pushed out the far side; a one-frame flip with no overlap in either frame is never seen at all.
Change: separateFrames keeps, per thumb bone x finger bone, the side the thumb was on (hand frame). Close (< 2 reach) and on the other side now = crossed: depth reach + dist, pushed back toward the old side. Forgotten past 3 reach or when the hand is unseen.
Prediction (before measuring): five cases tpierce 30 -> 24 or lower; regress all pass (pencil pierce no worse); held-out 200/33 unchanged (no two-finger contact there).
Result: six takes (5 cases + pencil) tpierce 69 -> 105 (v1), 71 (v2, only crossings across a bone's middle). Without the final clamp 68 -> 75. Prediction not met -> reverted.
Reading: crossings are not where the piercing comes from. separateThumb turns only the thumb BASE; where getting out of one finger sinks it into another (pencil grip: index pad above, middle below) the turn is taken back and the thumb stays in.
Next try (improve/27): when the base turn is taken back, turn the thumb MCP instead.
improve/27 (MCP turn when base turn is taken back, spread like the base): six takes tpierce 69 -> 77. Reverted.
