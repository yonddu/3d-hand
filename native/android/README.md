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
