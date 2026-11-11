# Hand Skin — Quest app (Godot 4.5)

Goal (user, 2026-11-10/11): in the Quest itself, put the user's own game arm / character skin
(GLB/FBX) on their tracked hands, record, save GLB + FBX for Unreal/Unity/Blender, auto-upload to
Google Drive. Camera (phone MediaPipe) tracking is no longer the main path.

- Engine: Godot 4.5.1 (MIT) + GodotOpenXRVendors 4.2.0 (Meta loader, hand tracking permission,
  passthrough). Built by `.github/workflows/quest-skin.yml` (artifact `quest-hand-skin`).
  Fixed debug key in `ci/debug.keystore` so updates install over the old APK.
- `bone_map.gd` (HandBoneMap): finds hand/finger/forearm/upper-arm bones by name
  (Mixamo, Unreal `index_01_l`, Godot/VRM `LeftIndexProximal`, Blender `f_index.01.L`).
  `tests/names_test.gd` checks 20 names.
- `skin_rig.gd` (SkinRig): rotation-copy retarget. Each mapped bone = Quest joint frame x offset;
  offset comes from the skin's rest pose (bone direction, back of hand from index/little
  positions, thumb rolled 88 deg = Quest thumb nail axis measured on the pair recordings).
  Skin keeps its own lengths; whole skeleton moved so the hand bone sits on the tracked wrist.
  Auto size = median user wrist->middle tip / skin length; `user_scale` is the only skin edit.
  A left-only skin is mirrored for the right hand (root scale -x, X axis of frames flipped).
- `tests/retarget_test.gd`: feeds a q0.1 jsonl recording into SkinRig and reports bone
  direction error vs Quest. 2026-11-11 on quest-hands-20261108-235035 (6000 bone samples per hand):
  direction 0.0 deg, back of hand 0.0 deg, index tip 2.5 cm off (skin proportions), both hands.
  `godot --headless --path native/quest-skin --script res://tests/retarget_test.gd -- <jsonl>`
- Default skin: `skins/hand_left.glb.bin` = user's gauntlet2_rigged_left.glb (raw bytes, loaded
  at runtime by the same GLTFDocument path as user files).
- Forearm/upper arm follow the wrist frame rigidly for now (elbow IK = step 3).

Not yet verified on the Quest.
