# improve/28 — finger touch over the whole take (user proposal 2026-10-28 00:59, "둘다해버려")

User: touch = approach speed then moving together (relative speed ~0) for a few frames; occlusion as a hint; when confirmed, tie the two in the solver.
Review: still hand = every pair still, so the approach is the start condition; MediaPipe gives no per-joint confidence (hint dropped); tie at skin distance, not the same point (tip joints sit inside the finger: same point = cores through each other); thumb end to any finger bone (pencil grip), not only tip to tip.
Renders (truth, dev seeds 9+11): one frame alone can't tell touching from apart: picture distance catching 66% of touches also calls 24% of clearly-apart hands touching; depth readings worse. So the time rule is needed; it can't be scored on renders (single frames).
Change: contactPass.js findTouches on the finished take (skin gap < 4 mm for 3 frames after it closed by 6 mm over 8 frames before; ends past 12 mm for 3 frames; nearest finger; afresh after the hand is lost; eased in/out over 5 frames). thumbCore.js holds the thumb on that finger's skin (W_TOUCH 0.5 vs core 4), touch changes averaged over 3 frames each way, then cores frame by frame.
Prediction: seven thumb takes tpierce 80 -> 65 or lower, fjump no worse, tcore stays 0; regress all pass; held-out unchanged.
Result: tpierce 80 -> 61, fjump 242 -> 238, tcore 0, topen 2374 -> 2376, snap/pstill/jump same. User take thumb_on_index: 9 touches, fjump 29 same. Held-out 200/33 same (touches there: 1 and 2). Kept (v96).
First version (no smoothing): tpierce 64 but fjump 242 -> 323; a picture-overlap condition ended touches at 2 mm gaps (x, y distance <= 3D distance), dropped.
