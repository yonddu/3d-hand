# 2026-11-11 Quest hand skin app (q-skin) — Claude

User direction (2026-11-10/11): drop camera tracking as main path. In the Quest itself: put own game
arm / character skin (GLB/FBX) on tracked hands, record, save GLB+FBX (Unreal/Unity/Blender
first-person camera choice kept), items (gun/sword) held and exported, only SIZE editable,
results auto-uploaded to Google Drive (user chose Drive over Dropbox).

Branch `quest-skin` (from codex/native-s25-baseline), code in `native/quest-skin/` (Godot 4.5.1 +
GodotOpenXRVendors 4.2.0), CI `.github/workflows/quest-skin.yml`.

| version | commit | CI run | state |
|---|---|---|---|
| q-skin 0.1 | first commit | 42935964541 | built; Linux plugin lib wrongly removed -> Meta export options ignored |
| q-skin 0.2 | second commit | 42936370606 (artifact 13818417392, APK 87 MB) | PASS, manifest has HAND_TRACKING + handtracking feature + files permission. NOT tried on Quest |
| q-skin 0.3 | 03a014f | 42937040698 (artifact 13819271308) | PASS; elbow IK from head pose. NOT tried on Quest |

Verified offline: tests/retarget_test.gd on quest-hands-20261108-235035.jsonl: bone direction 0.0 deg,
back of hand 0.0 deg, index tip 2.5 cm off (skin proportions), both hands; names_test 20/20.

Open / next: passthrough feature not in manifest (background black); full character
(one instance for both hands) + mirror; recording -> GLB/FBX export with engine camera choice;
items + controller mode; Drive (device-code login drive.file upload, skins by share link);
fingertip contact correction.

## 2026-11-14: paused
User decided the final route: Unreal 5.6 OpenXR hand tracking (Quest via Link, developer runtime
features on) drives the main character's hand bones live; poses / Take Recorder -> FBX. This Godot app
(q-skin 0.3) is paused and was never run on a Quest. Its retarget math (rest-frame offsets from bone
direction + back of hand, thumb roll 88 deg, elbow IK from head) is to be ported to an Unreal component.
Setup doc: https://claude.ai/artifact/GtFjsC5UgiorzDv3dLoTrp
