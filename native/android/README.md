# Android native measurement baseline

Target device: Samsung Galaxy S25 SM-S931N, Snapdragon 8 Elite (SM8750), Android 16.

This is the first native measurement app, **not the complete 3D studio and not NPU inference**. It runs CameraX and MediaPipe HandLandmarker 0.10.21 directly, with the same task asset and confidence thresholds as the web app. The default delegate is GPU, with an explicit CPU comparison button. It does not silently fall back when GPU creation fails. The screen labels NPU as not applied. No WebView, JavaScript pose fitting, picture networks, collision passes, GLB rendering, network permission, cloud inference or paid service is included.

## Install and use

Download `hand-motion-native-baseline` from the successful Android native baseline GitHub Actions run. Unzip and install `app-debug.apk`. Allow installation from the browser/files app if Android requests it, then grant camera access. Android Studio, a Qualcomm account and the QNN SDK are not needed on the phone.

1. Hold the phone still and show a hand in the rear camera.
2. Tap **측정 시작**, repeat opening/closing, turning and pinching, then tap **측정 중지**.
3. Tap **기록 저장** and choose a location. The JSON contains device/SoC/Android information, raw normalized and world landmarks, handedness, and timing. Camera pixels/audio are not saved.
4. The JSON's `raw` object is compatible with the existing `tools/replay.mjs` reader, although this app does not run the web rig or its frame passes.

This is a diagnostic camera screen showing original 21-point detections, not the Studio's Quest-hand review screen.

## What the numbers mean

- Preprocessing: YUV-to-Bitmap conversion, viewport cropping and rotation. This is intentionally measured CPU copying, **not zero-copy**.
- Inference: synchronous native MediaPipe call, including its own preprocessing and tracking/palm detector.
- Callback-to-result: analyzer entry to result; not camera-exposure-to-display motion latency.
- FPS: completed analyzed frames divided by elapsed wall time, not reciprocal model execution time.
- The display uses a rolling 120-sample window. Recorded raw frames are independent of that display window.
- Live CameraX uses KEEP_ONLY_LATEST. Busy processing can drop camera frames. This is not an offline every-frame benchmark, and results cannot be called all-camera-frame recall.
- Recording stops explicitly at 9000 processed frames and asks the user to save; frames are not silently evicted.
- The phone cannot run in this CI runner. Compilation/tests do not certify camera alignment, speed, accuracy, thermal behavior or NPU operation.

## Build

Java 17, Android SDK 35, Gradle 8.11.1. From this directory:

```sh
gradle :app:testDebugUnitTest :app:assembleDebug :app:lintDebug
```

The Gradle asset task copies the existing repo's `vendor/models/hand_landmarker.task` without downloading/replacing it. The APK packages only arm64-v8a, API 31+, target SDK 35 (runs on Android 16). Versions are pinned. The workflow builds a debug APK with the standard debug certificate; it is a test install, not a Play release. Future upgrades must keep signing identity or require reinstalling.

## NPU next step

NNAPI is deprecated as of Android 15. For this device investigate LiteRT CompiledModel + Qualcomm QNN HTP v79 rather than assuming NNAPI selects an NPU.

MediaPipe Tasks HandLandmarker does not expose an NPU delegate switch. QNN integration is not achieved by renaming CPU to NPU: extract/inspect the palm and landmark TFLite submodels, validate supported operators, port the preprocessing and decode/tracking graph, compare tensor outputs and final 21 points against native CPU on identical saved inputs, and profile actual delegated partitions/fallback. Do not promise 100% NPU or zero-copy.

Qualcomm runtime redistribution terms must be checked for the exact version. This change does not bundle Qualcomm proprietary runtime libraries or accept a vendor license. No new vendor SDK is claimed to satisfy the owner's MIT/Apache/BSD rule.

Before adding QNN, account for native libraries/APK growth, additional memory, compilation time and warm-up. GPU/NPU inference does not automatically accelerate CPU rig fitting or fix inaccurate 3D geometry.

Official references:
- https://developer.android.com/ndk/guides/neuralnetworks
- https://developers.google.com/edge/litert/next/npu
- https://developers.google.com/edge/litert/next/qualcomm
- https://developers.google.com/edge/mediapipe/solutions/vision/hand_landmarker/android
- https://developer.android.com/media/camera/camerax/analyze

## Licenses

CameraX/AndroidX and MediaPipe are Apache-2.0; the official hand tracking model card also identifies Apache-2.0. The Apache license is included in the APK assets. Preserve upstream notices and inspect all transitive binary notices before a commercial release. This baseline is not a completed third-party license audit.

- https://github.com/google-ai-edge/mediapipe/blob/master/LICENSE
- https://storage.googleapis.com/mediapipe-assets/Model%20Card%20Hand%20Tracking%20(Lite_Full)%20with%20Fairness%20Oct%202021.pdf

## Product requirement (owner 2026-10-28)

The final native Studio must retain the familiar recording/review/hand-pose controls and export skeletal GLB animation for games. This separate benchmark is a temporary engineering tool, not a replacement product UI. Porting detection must preserve the 21-point coordinate/hand-ID conventions and compare final GLB bone names, bind pose, units, timing, finger tracks and hidden-hand behavior with the web exporter. NPU speed alone is not completion. Existing Quest-only review presentation remains the target; raw landmark overlay belongs only to diagnostics.

## GPU-first sequence

Owner decision: native MediaPipe GPU first; compare CPU, consider NPU only if still too slow. Switching delegate stops recording and recreates the model on the same worker thread, including GPU context setup/use/close. A stopped recording retains its original backend label for saving. Starting a new measurement clears the old recording. Selecting a delegate alone does not certify actual hardware utilization; exports mark acceleratorExecutionVerified=false.

## S25 first measurement and one/two-hand experiment

Owner screenshots (not synchronized inputs): GPU requested 14.1 FPS, inference p50 49.3ms/p95 56.6ms, preprocessing p50 25.2ms, callback-to-result p50 75.2ms; CPU requested 11.9 FPS, inference p50 69.9ms/p95 89.3ms, preprocessing 14.3ms, callback-to-result 85.1ms. These do not prove hardware utilization or landmark accuracy. Different input poses, short windows, warm-up and device load can affect the comparison.

Prediction before change: v0.10.21's graph only suppresses palm detection when previously tracked hand rectangles reach numHands. With numHands=2 and one visible hand, palm detection can run each frame. A deliberately selected one-hand mode should reduce repeated palm detection during stable one-hand tracking. No numeric FPS improvement is claimed before a physical-device test.

The default remains two hands. The added button explicitly switches between maxHands=1 and 2, recreating the model and stopping recording. One-hand mode cannot track a second hand; it is not an equivalent two-hand performance result and must never filter regression takes. Saved recordings preserve their original backend and maximum-hand setting. New diagnostics display upright input dimensions and save source dimensions/rotation. No thresholds, pose priors, input resizing policy, global smoothing or temporal holds change.

Reference (the actual pinned MediaPipe release):
https://github.com/google-ai-edge/mediapipe/blob/v0.10.21/mediapipe/tasks/cc/vision/hand_landmarker/hand_landmarker_graph.cc

Before an APK update, save any wanted measurement. CI debug signing identities are not yet persisted, so Android may require uninstalling the previous test app before installing a new build; this does not affect the web Studio.

## Owner rollback (2026-10-29)

Version 0.5 restores the exact version 0.2 raw MediaPipe measurement implementation (e4246c2) and removes the Quest hand, arms, WebView Studio, JS retargeting and GLB UI added in 0.3/0.4. GPU/CPU and one/two-hand comparison, original 21-point overlay and JSON recording remain. Version code increases only to permit replacement of newer test builds; it is not a new tracking feature. The web application and generated bundles are restored to the pre-Studio versions. Further pose investigation is stopped at the owner's request. No claim is made that removing Studio resolves Samsung's separate sideload security warning.

## Version 0.6: actual existing web pipeline (2026-10-29)

Owner authorized reapplying the existing web hand/wrist/arm behavior using native detection input. This version does **not** restore the rejected nativePose/nativeArm/nativeStudio implementation from versions 0.3/0.4. Instead the packaged entry imports actual `src/main.js`; all HandSolver, lift, fit, filters, RealHand, ArmRig, skin seam, exportGlb and finished-take pass implementations remain unchanged from main.

HandTracker's existing post-detection code is extracted verbatim into acceptResult and called by both its normal browser detect method and the native input adapter. Native arrays retain original x/y/z coordinates; axis conversion happens once in main.js fromMediaPipe. Native input passes original upright dimensions and the rear-camera first-person convention. The render tick calls the same fromMediaPipe -> feed path; all existing live defaults (lift, fit, limits, filters, hand contacts, arms/wrist behavior) stay enabled. Recording stop uses the same replanGrips -> cleanTake -> stillPass -> separateFrames -> separateHands -> clampBack -> findTouches -> clearThumbCore sequence. Existing review and game GLB exporter are used directly.

Only input/output integration differs: native detector results replace browser detection, native result dimensions replace video dimensions, source/camera-file controls that cannot run without camera pixels are hidden, and output uses Android CreateDocument with bounded chunked GLB/JSON transfer (64 MiB maximum). Native code does not provide body-pose or forearm pixels, so the web engine follows its existing null-elbow/object fallback. Picture networks only ran during web offline pixel analysis; that camera-pixel path is unavailable here and no substitute picture predictions are invented. This implements the **existing web live pipeline**, not all-frame offline video processing or newly improved occlusion inference.

Raw native measurement remains available. Switching modes/backgrounding/model restart stops active Studio recording and resets its tracking/filter state. Disappearance resets state before another hand inherits it. Only delivered input results produce recorded keys, with native timestamps and pipeline metadata stored in GLB extras. Save before closing the app. External navigation/resources and local file/content access are blocked, and no internet permission is added. Three.js and WebXR model MIT notices accompany packaged assets.

Prediction before editing: replacing the rejected independent retargeter with the existing shared web pipeline should reproduce the web live behavior for the same landmarks. It does not establish the correctness of hidden depth or improve the web engine's existing errors. Rendering/pose processing add per-frame cost and about 2 MiB uncompressed JS/HTML/mesh assets plus WebKit; this was disclosed before implementation. Actual S25 appearance/FPS/heat/file saving must be tested on-device.

Checks: 40-frame browser-detect/native-accept comparison yields identical processed hands and raw coordinates. Chromium integration confirms actual lift/fit/limits/contact settings, fitted solver state, shared arm skin/wrist bend source, native recording through all existing finished-take passes, review and a skeletal GLB. Shared pose/math/export modules are unchanged. Existing supplied 23 regression GLBs retain swap13 flip154 jump3639 gsw308 fjump442 fflip5 asnap10 unsure12111; full regression still fails only for 18 missing baseline JSON takes, including both holdouts. No limit/exclusion/split/baseline changes. Main merge remains gated on the full corpus/regression.

The sideload security warning and debug-signature update limitation are separate from pose behavior; no bypass or warning removal is claimed.
