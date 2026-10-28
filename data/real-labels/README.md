# Real hand labels (human-checked finger states)

These are 1680 hand crops from the user's own takes. The app's `save-crops` option keeps every 5th frame. Each crop is 64x64 in the app and is enlarged to 192 here. The wrist is at the bottom and the middle finger points up. Each sheet has 20 crops, and each crop is marked with its id.

Why we need them: the app's picture models (finger curl and joint cubes) learned only from rendered hands. On real video they read every finger as about 20-27 deg bent, while MediaPipe reads 30-60 deg (improve/29). Without real answers we can neither score nor fix them.

## Files
- `sheets/sheet_NNN.jpg`: the crops, ids `c0001`..`c1680`.
- `labels.csv`: one row per crop. The columns `id, sheet, take, t, hand, use` are filled already. Fill in the rest.
- `use`: `train` or `score`. Rows marked `score` (takes pen_grip_02-41, thumb_on_index_00-39) are only for checking. They are never used for fitting or training.

## What to fill
| column | values | meaning |
|---|---|---|
| thumb, index, middle, ring, pinky | `0` `1` `2` `3` `x` | 0 straight (whole finger within ~20 deg of flat). 1 half bent (clearly bent, tip not touching the palm). 2 curled (tip folded into or near the palm, a fist finger). 3 pointing at the camera (finger looks short because it points toward or away from the lens, not bent). x cannot see it (hidden behind an object or another finger, blurred, out of crop). |
| thumb_touch | `none` `index` `middle` `ring` `pinky` `object` `x` | what the thumb tip is touching |
| view | `back` `palm` `side` | which side of the hand faces the camera |
| sure | `1` `2` `3` | 3 sure, 2 probably, 1 guess |
| note | free text | e.g. "holding bottle", "motion blur" |

## Rules
- Judge only from the picture. Do not use MediaPipe points, the app's output, or the GLB motion.
- If you are unsure, write `x`, or give your best class with `sure` = 1. Never fill a cell to make the table look complete.
- Neighbouring ids are 1/6 s apart in the same take. Use them to tell "bent" from "pointing at the camera", but label each crop as it looks.
- Do not change the filled columns, row order, or any file outside `data/real-labels/`.

Made by `tools/export-crops.py`.

## Status (2026-10-28)
`labels.csv` holds a GPT first pass. The owner checked the 20 hardest crops and judged nearly all wrong; sheet 079 is also wrong on a spot check. Do NOT use these labels for scoring or training.
