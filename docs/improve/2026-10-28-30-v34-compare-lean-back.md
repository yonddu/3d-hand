# improve/30: "v34 moved best" — old vs new solver, backward lean for bent fingers (2026-10-28)

The user felt the version right after the palm joints were added (v34, 573d9e0, 10-25 23:09) moved best.

## Compare (solve stage, same inputs, sides from current tracker, picture models off, right hand)
Driver: scratchpad oldsolve-repo.mjs (copy into tools/ to run; REPO=<checkout>).

| take | curl v34 / now (MP) | swings v34 / now |
|---|---|---|
| fist_cup_05-19 | 45.8 / 44.0 (50) | 71 / 112 |
| fist_thumb_05-26 | 49.7 / 40.7 (46) | 56 / 70 |
| pen_grip_02-41 | 42.6 / 43.9 (44) | 129 / 126 |
| thumb_on_index_00-39 | 45.7 / 46.9 (45) | 142 / 150 |

- Bisect on fist_cup: c5a6655 (10-26 02:14) dropped lift's "bend toward the palm" lean choice. Swings 72 -> 92 there. Later steps took it to 112 (v60 grip planning +11, v77/v80 +7).
- Grip prior off (NOGRIP): curl up (fist_cup 48.7), swings same or worse. Not the swing source.

## Tried: LEAN_BACK (lift combo cost when a world-bent finger, >40 deg, would fold backward)
- Prediction: fist swings down, held-out no worse.
- Solve stage: fist_cup swings 112 -> 97 (curl 44 -> 47), fist_thumb 70 -> 56 (41 -> 46).
- Full regress: held-out jump 200 -> 287, fjump 1 -> 7; 36 dev fails (user1 clips jump 192 -> 233). Same failure as improve/19's range rule. REVERTED (patch: scratchpad lean-back.patch).
- Lesson: in the finished pipeline, the backward-fold choice is often the right one when the palm mirror is wrong. A lean rule cannot fix a wrong mirror. Don't retry lift lean-side rules without fixing the mirror first.
