# improve/23 — joint cube "along" as evidence in lift.js lean choice (2026-10-27)

User ask (22:45): use the cube direction as evidence where lift.js picks each finger's 8 lean combos.
History: tried once (improve/15 attempt 2, 624-image model) -> score-only worse, deferred until more renders. Model now v3 (seed 9 3000 + seed 21).
Prediction (written before scoring): score-only joint angle 17.34 / 17.67 (one / two hand) -> 17.2 or lower on one hand, two hand no worse.

Code (not kept): per bone in each combo, a = -(sign*room)/L (lift frame: camera is -z; flipped sign checked: dev 17.45-17.55, clearly wrong).
Forms tried on dev seed 11 (base 15.74):
- quadratic ((a - along)/asd)^2, weight 0.03-4: 15.75-15.97 (worse)
- confidence-weighted sign vote: 15.70-15.78 (noise)
- hard gate (asd < 0.15/0.2, |along| > 0.3), weight 2/8: 15.71-15.77 (noise)
Oracle (true along from the render): 15.74 -> 14.65 (-1.1 deg). So the slot is right; the readings are not good enough.
Diagnosis (dev seed 11): of 4229 bones where the oracle changes lift's choice, the model's sign is right on 68.7%; confident readings are right 93.5% but cover only 555 (13%).
Score-only (best dev form, gate 0.15 weight 2): 17.34 -> 17.47, 17.67 -> 17.54. Prediction not met -> reverted.
Real takes: none recorded since v93 carry picture readings, so replay can't test it on real video yet.
Next: only a better cube model on the ambiguous bones would help (needs renders/retraining, excluded by the current spec). Don't retry with the v3 model.
