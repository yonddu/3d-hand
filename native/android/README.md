# Android native measurement baseline

Target device: Samsung Galaxy S25 SM-S931N, Snapdragon 8 Elite (SM8750), Android 16.

Version 0.4 includes an offline **hybrid Quest-style Studio** to the original native measurement app. CameraX and MediaPipe HandLandmarker 0.10.21 remain native (GPU requested by default, explicit CPU comparison). The same task asset and confidence thresholds are retained. No automatic CPU fallback and no NPU support are added.

The packaged WebView reuses `app.html`, three.js, `RealHand` and the existing skeletal GLB exporter. A separate `src/nativeStudio.js` entry never imports the web tracker or picture networks. It maps each native world-landmark segment directly to a bone direction in `src/nativePose.js`, without lift, fitting, synergy, anatomical clamps, finger temporal filters, collisions or finished-take passes. The owner has now explicitly restored the existing web arm/wrist path, described below. `RealHand(correctPose:false)` also bypasses its display-time contact/thumb corrections. Existing web defaults are retained.

Prediction before this change: removing all those extra pose stages from the native path should prevent those stages from distorting the detected pose. It cannot improve MediaPipe's original 3D estimates or recover hidden fingers. No numerical accuracy/FPS improvement is claimed before a device recording. Fixed model bone lengths differ from the person's actual hand, so direct direction mapping does not guarantee pixel-perfect joint positions.

Studio provides the familiar recording dock, take review/playback and **저장 (GLB)**. It records one key per native result actually delivered to JavaScript (a bounded latest-result transport may skip results; it never synthesizes 30 FPS). Original detection timestamps, landmarks, backend and max-hand settings ride in GLB extras. Camera images/audio are not stored. The camera-only diagnostic JSON recording remains separate. No new learned model is included.

Wrist placement uses a fixed work plane, not measured absolute depth. Arm transforms in the GLB are inferred to support the existing game skeleton, not tracked by a body model. The native exporter bypasses short-gap hand visibility filling; version 0.4 applies the same arm/wrist roll limit as the web UI and exporter. A missing hand is hidden immediately. Hand-overlap prediction is deliberately deferred. Finger retargeting is stateless; the restored arm and wrist-anchor state resets on loss, label-side changes, explicit swap, model restart, pause and review transitions. Duplicate same-side readings keep only the more confident reading, with no invented second hand. A user-controlled left/right swap is available before recording.

Android saves GLB through its document picker using bounded base64 chunks into an app-private temporary file (64 MiB maximum), not unsupported WebView blob downloads. External navigation/resources and file/content access are blocked; all JS, three.js and meshes ship in APK assets via WebViewAssetLoader. Three.js MIT and WebXR mesh MIT notices are included alongside Apache notices. No internet permission is added. Active takes are in memory: save before closing the app. Backgrounding, changing execution mode or leaving Studio stops active Studio recording without erasing a completed take.

## Original measurement screen

The raw 21-point diagnostic view is still available using **원본 관절점 측정 화면으로**. Its delegate and hand-count settings are shared with Studio.

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

Java 17, Android SDK 35, Gradle 8.11.1. From the repository first run `npm ci` and `node tools/build-native.mjs`; then from this directory:

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

## Validation and release gate (2026-10-29)

`node tools/test-native-pose.mjs` checks exact per-bone direction for both sides under strong rotation/non-rigid finger bends, stateless reappearance, invalid inputs and duplicate labels. `node tools/test-native-studio.mjs` is the browser integration check with a stub Android bridge; it does not test physical camera/GPU or Android document-provider behavior. Build native assets first; Playwright 1.56.1 + Chromium are needed only for that development check.

The new native JS/HTML/mesh assets total about 1.55 MiB uncompressed before APK compression, plus AndroidX WebKit library overhead. Runtime adds a WebGL hand renderer and per-result retargeting; physical S25 frame time and thermal behavior must be measured. This increase was reported before implementation. No additional inference models are packaged.

Full web regression is still blocked by 18 absent baseline JSON recordings (raw_take2..17.json, raw_w2take2..3.json). The corpus gate remains mandatory; no limit/exclusion/baseline changes are allowed. A native test APK is not permission to merge until the full corpus and regression pass.

## Version 0.4: existing web arms and wrists only

Owner scope: restore the previously implemented web arms/wrists; keep direct native fingers and defer occlusion prediction. The shared `src/arm.js` implementation is unchanged. Native Studio now uses its `ArmRig.update`, existing arm-pose prior, shoulder/elbow IK, wrist/forearm roll limits, forearm twist helpers, wrist bend correctives and below-elbow Quest skin. The hand/arm seam uses the same wrist loop, shared normals and half-bend source as main.js. No debug joint markers are displayed.

`src/nativeArm.js` uses the existing non-AR web wrist placement formula (model palm size / image palm segments, with the same depth caps and work plane) and exactly the existing anchor filter parameters. This restores wrist position filtering only, not finger filtering or stronger global smoothing. It is a model-relative placement estimate, not true camera depth. The hand-only native detector provides no body pose or image-derived forearm-line hint, so ArmRig takes the same null-elbow-hint fallback used by the web app when no elbow is available. Native does not add a pose model.

The wrist rotation can now be limited exactly as the existing web arm path limits it; finger-local rotations stay untouched. Captured frames, review and GLB use this same arm/wrist pose. GLB/raw extras identify `armPipeline: web-arm-wrist-v1`. Loss still hides both hand and arm immediately, and export still does not fill lost-hand gaps. Upper arms remain hidden/faded by default as in the web app's below-elbow view; the game export retains its established full arm skeleton.

Prediction before editing: the visible wrist/forearm seam and arm pose should match the existing web fallback rather than the previous hand-only preview, while finger-local rotations remain identical. Added runtime cost is the existing arm prior/IK and arm skin rendering; no new model assets/dependencies. The owner was informed before implementation. Physical-device cost/appearance are not yet measured.

Validation: test-native-arm.mjs compares both sides against the existing ArmRig/filter path, checks unchanged finger locals, and compares reset/reappearance against a fresh instance. Native browser integration additionally checks arm skin visibility, no debug elbow marker, hidden arms on loss and matching GLB wrist/finger rotations. The missing-18-take full-regression merge gate remains unchanged.
