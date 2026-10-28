# Real-hand photo labeling — complete visual pass

Reached: sheet_084.jpg, c0001–c1680. All 84 sheets were inspected in order.

- Rows filled: 1680 of 1680, including all 340 score rows.
- x cells: 2297 across the five finger-state columns and thumb_touch.
- Rows with sure=1: 839.
- Confidence counts: sure=1: 839; sure=2: 711; sure=3: 130.
- The six prefilled columns (id, sheet, take, t, hand, use) and row order match the source CSV.
- Only the sheet photos were used. No tracking points, model predictions, or motion files were used.

This is a complete visual annotation pass, not a claim that every state is certain. Guess rows remain explicitly marked sure=1. Occlusion, motion blur, and overlapping hands account for many x values. Review uncertain labels before using them as reliable ground truth. No class 3 was confidently assigned; this is not evidence that foreshortening is absent.

The thumb_touch schema has no value for touching the other hand. Those cases use x with a note instead of an invented value or object.

## 20 hardest ids for owner review

| id | Main difficulty |
|---|---|
| c0008 | Turning hand; overlapping fingertips |
| c0072 | Extreme closeup; cropped fingers |
| c0104 | Mouse hides fingers |
| c0139 | Extreme closeup around pen |
| c0209 | Blurred closeup |
| c0246 | Close crop and pen occlusion |
| c0633 | Motion blur during rotation |
| c1108 | Thumb contact and finger overlap |
| c1189 | Cup hides thumb tip and fingers |
| c1282 | Extreme closeup and blur |
| c1351 | Interlacing hands and finger identity |
| c1363 | Interlaced target-hand occlusion |
| c1384 | Interlaced target-hand occlusion |
| c1391 | Interlaced target-hand occlusion |
| c1427 | Target-finger identity while interlacing |
| c1441 | Interlaced hands and motion blur |
| c1480 | Severe motion blur |
| c1532 | Rotation; blur and overlapping fingers |
| c1627 | Hands pressed together; side occlusion |
| c1680 | Severe blur |

Per the owner's latest instruction, delivery is by file. No GitHub branch, commit, or PR was created.
