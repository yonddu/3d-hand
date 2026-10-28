# improve/29: pen grip take — fingers too straight, jumpy (2026-10-28)

Take: takes/pen_grip_02-41.glb (right hand, pen, mouse/keyboard/tv on desk). The user asked whether object points cause it.

## Findings
- Objects: the desk mouse was adopted as the held object in 413 of 899 hand-frames. The pen is never detected (COCO has no pen).
- Saved GLB vs MediaPipe world (tools/glb-vs-raw.mjs): bend jumps >15 deg/frame: MP 702, saved 12. Back-and-forth swings of 25-45 deg within 0.5 s in the saved GLB: 32.
- Curl by stage (replay, right hand, finger MCP/PIP mean): MP 43.9, lift 43.8, solve 31.6. With NOPIC: 41.6. With W_PICTURE=0: 34.1. With W_CUBE=0: 37.7.
- Old versions v70-v90 solve to 38-42, but their replay never read picture data. The app has applied the picture models since v79.
- Picture curl readings on real takes (3 takes with f.picture): mean 20-27 deg on every joint vs MP 30-60. Correlation with MP 0-0.5. Spread half of MP's. The models (trained on renders) do not read real fingers. They act as a "pull to ~22 deg" plus a steadying term.

## Tried
| try | curl (pen / thumb_on_index / left_pop2), MP 43.9/45.1/41.5 | swings | fjump |
|---|---|---|---|
| now | 29.7 / 38.2 / 28.7 | 27 / 37 / 33 | 21 / 33 / 11 |
| no picture | 39.2 / 45.1 / 36.5 | 40 / 48 / 50 | 51 / 115 / 76 |
| W_CUBE 0 | 35.7 / 41.9 / 34.2 | 23 / 30 / 32 | 23 / 68 / 31 |
| picture on hidden joints only | 36.4 / 44.2 / 33.8 | 55 / 53 / 58 | 55 / 113 / 71 |
| object only if it moves with the wrist | pen curl 29.7, swings 27 | regress dev jump 6274 -> 6927, fjump 2585 -> 2816, 50 fails (book_floor 98 -> 198); held-out same | REVERTED |
| speed limit from picture-point motion (K 400/250) | no swing change | | REVERTED |
| stillPass (hold a finger's mean pose while its palm-relative points stay within STILL) 0.08 | curl same | 16 / 34 / 28 | 18 / 41 / 10 |
| stillPass 0.1 | | pen 11 | pen 17 |
| stillPass 0.08 + picture hidden-only | 36.3 / 44.1 / 33.3 | 43 / 46 / 38 | 57 / 98 / 47 |

- MediaPipe world bends themselves (5-frame mean) swing 111 / 121 / 126 times. The finished output is already about 4x steadier.
- Prediction written before stillPass: pen/thumb swings halve, curl within 5 deg of MP, held-out no worse. Measured: swings 27 -> 11-16 (pen, about half), 37 -> 34 (thumb, not half). Curl is NOT restored (needs the picture terms off, which brings the jitter back).
- Experiments patch: scratchpad experiments-0328.patch (gate, PIC_HIDDEN, speedPass).

## Kept: v98 stillPass (final form)
- The first form compared each frame to the stretch's running mean. A slow real bend then dragged the mean along and turned into steps (hold share 70-97%). Changed: compare to the stretch's start (mean of the first 3 frames). Hold value = straight-line trend over the stretch. Smoothstep ramps of 6 frames on both sides of the ends. No hold while wrists are within 0.25 m (interlace hpierce 43 > 42 otherwise).
- Swings (finished, 25 deg back and forth within 0.5 s), off -> on: pen 16 -> 12, thumb_on_index 32 -> 23, left_pop2 32 -> 18, thumb_fold 34 -> 3. Curl unchanged.
- Regress all pass. Dev fjump 2585 -> 1280. Held-out fjump 33 -> 1 (other held-out numbers same).
- Risk: finger moves smaller than 0.08 palm in the picture become a straight trend. Watch for "tiny finger motion frozen" reports.

## GPT labelling
- data/real-labels (1680 crops, 84 sheets, labels.csv, README) pushed 252aaf9. Prompt: /mnt/project-files/hand-motion-studio/gpt-prompts/real-finger-labels.md. Score-only takes: pen_grip_02-41, thumb_on_index_00-39.
