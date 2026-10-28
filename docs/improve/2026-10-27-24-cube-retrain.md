# improve/24 — cube model retrain with unused renders seed11 + seed22 (2026-10-27)

User chose option A (23:19): retrain the joint cube model, no new downloads, cost 0, renders already made (MIT hand model + procedural skin).
Error type: cube "along" sign wrong on the bones where lift's lean choice is decided (improve/23: 68.7% right, oracle would give -1.1 deg).
Change: training set v3 (seed9 + seed21 lines 1-2400) + seed11 (976 crops) + seed22 (two-hand). Same network, same size (211 KB), same steps (8000).
Score-only unchanged: seed10 (m_cube10) + seed21 lines 2401-3000 (m_two_score). Nothing chosen on them.

Prediction (written before training):
- along wrong side, score-only: seed10 8.1% -> 7.3% or lower; two 5.5% -> 5.2% or lower.
- joint angle error, score-only (fit only, lift unchanged): 17.34 / 17.67 -> 17.25 / 17.60 or lower, neither worse.
- If kept, re-test the cube vote in lift (improve/23 forms) as a separate step.
Keep only if score-only joint angle is better on both (or one better, other within 0.03).

## Result — NOT KEPT (v3 stays)
Train 474 held-back crops; v5 = v3 data + seed11 (976) + seed22 (903), 8000 steps, same net.
along wrong side, score-only: seed10 8.1% -> 7.4% (pred 7.3%, close), two 5.5% -> 6.0% (pred 5.2%, worse).
Joint angle, score-only: 17.34 -> 17.42, 17.67 -> 17.79 (both worse; pred 17.25/17.60). Reverted: vendor/models/joint_cube.bin unchanged (v3).
Reading: ~1900 more crops of the same renders don't lift the model; per README rule, no more renders of this kind. The cube depth route stops here unless the input changes (e.g. 128 crops, deferred) or real labelled photos appear.
v5 weights kept at scratchpad cube_v5.bin only (not shipped).
