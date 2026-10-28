# GPT 코드 작업 인수인계 (2026-10-28, v103 기준)

아래 "GPT에게 줄 글"을 그대로 붙여 넣으면 돼요. GPT는 저장소를 읽을 수만 있고 올릴 수는 없으니, 결과는 패치 파일(diff)로 받아서 저(Claude)에게 주세요. 제가 회귀 검사를 돌리고 통과한 것만 올립니다.

---

## GPT에게 줄 글

You are helping on https://github.com/yonddu/3d-hand (Hand Motion Studio): phone camera video -> MediaPipe hand landmarks -> a 3D hand rig -> GLB animation. Plain ES modules, three.js 0.170, @mediapipe/tasks-vision 0.10.21, esbuild (`node build.mjs`). App HTML source is `app.html` (build writes `index.html`, `app.bundle.js`).

**You cannot push.** Deliver every change as one unified diff (`git diff` format) against the current `main`, plus a short note: what changed, why, what you expect it to change in the numbers below. The owner's other assistant applies it and runs the checks.

**Hard rules (never break):**
1. No paid APIs, services or models. Only free resources under commercial-use licences (MIT, Apache-2.0, BSD). No NC / research-only licences. No MANO, InterHand, HaGRID inside the app.
2. Never raise regression limits, never use `--accept`, never exclude takes or time windows to pass. Only the owner may approve a trade-off.
3. Never claim depth that one camera cannot see as correct.
4. Do not fix things by stronger global smoothing, by changing SWITCH_VOTES, or by fixed-length frame holds.
5. Do not carry time state across a left/right ID change, a hand reappearing, or a scene cut. Exception (owner rule): a hand appearing away from the picture edge right after all hands were lost is the same hand.
6. Do not open a folded thumb or pull apart a real pinch to avoid a collision.
7. The review screen shows only the Quest-style hand (no debug cubes or colours).
8. Tell the owner before anything makes the app heavier (download size or per-frame time).

**How changes are judged.** `npm run regress` replays every saved take in `data/takes/` (the owner's real recordings; GLB files carry the raw MediaPipe readings in the root node extras) (`tools/replay.mjs`) against `tools/regress-baseline.json` and `tools/regress-issues.json`. Takes listed in `tools/regress-split.json` are score-only: never tune on them. Improvement order: measure -> pick ONE most frequent error type -> write the predicted effect BEFORE changing code -> change only that -> re-measure -> keep only if better. Records of past attempts are in `docs/improve/` (Korean/English); do not retry anything listed as reverted there without a new idea.

**Current state (v103):**
- Finished-take passes, in this order (main.js and replay.mjs): cleanTake -> stillPass -> separateFrames -> separateHands -> clampBack -> findTouches -> clearThumbCore.
- Picture models (src/fingerCurl.js, src/jointCube.js; 64x64 crops, trained on renders only) are ON (`PICTURE_MODELS` in main.js). Known flaw: they read real fingers ~22 deg bent everywhere. 128 crops were tried and are no better on renders (candidates in vendor/models/candidates/).
- Their convolutions run on the GPU via WebGL2 (src/gpuNet.js, check: `node tools/test-gpu-net.mjs`).
- The owner's phone: MediaPipe's own GPU delegate finds no hands, so the hand model runs on the CPU (tracker.js preferCPU, localStorage hms.gpuNoHands).
- Open problems: palm mirror choice (palm vs back facing) causes apparent backward finger folds; thumb floats instead of covering the index in a fist; MediaPipe loses the hand when grabbing a cup.

**Task for you now:** (owner fills in)

---

## Claude 메모
- GPT 패치를 받으면: `git apply` -> `node build.mjs` -> `npm run regress` -> 숫자 보고 -> 통과하고 나아진 것만 올리기.
- 다음 후보 작업: 60fps 녹화 + 반전 프레임 두 번째 판독을 후보로 저장(1단계, 아직 사용자 승인 전).
