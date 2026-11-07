# Quest hand recorder (native OpenXR, no browser)

Why: in the Quest browser the WebXR session kept going to the background (browser window back in
front, "immersive web experience still running" dialog), also with the official three.js hand
example, so quest.html could not record. This app records the same data without a browser.

- C++ NativeActivity, Khronos OpenXR loader (Maven org.khronos.openxr:openxr_loader_for_android, Apache-2.0),
  XR_EXT_hand_tracking (26 joints incl. palm), XR_FB_passthrough if present, GLES3 points.
- Output: /sdcard/Download/quest-hands-YYYYMMDD-HHMMSS.jsonl (else the app's own files dir).
  Line 1 = header (joints, row = px py pz qx qy qz qw radius, space stage|local, startWall ms);
  frame lines {t ms from first hand frame, wall ms, head [7], hands {left, right: 26 x row|null}} at <= ~60/s;
  mark lines {mark: "index-tips", t, wall} when both index tips touch (gap < 1 cm, open > 3 cm);
  event lines (focused / unfocused / end).
- In view: left joints blue, right green, touching index tips yellow, red dot = recording, one yellow
  dot per mark along the top, grey centre dot = no hand.
- Build: CI workflow quest-android.yml (artifact quest-hand-recorder). Install: developer mode + adb/SideQuest.
