# 2026-11-01 — 네이티브 v0.12: Quest 손 모양, 팔 제거

## 사용자 요청
- "저번처럼 메타퀘스트 손모양 나오게하는데 손목은 다시 없애자 손모양 폴리곤수 확인해주고"
- "팔 뼈대 손이랑 달라서 없애라고한거임" → v0.9~v0.11의 팔 뼈대(ArmRig/ArmFollower/ForearmFinder) 전부 제거.
- 질문: 예전 웹은 Quest 손 + 손목·팔뚝이 잘 됐는데 HaGRID가 없어서냐 → 아님. HaGRID는 점검용으로만 썼고 앱에 들어간 적 없음. 웹의 팔은 followElbow·팔뚝 선·armPrior·피부 입힌 팔 모델 덕분.

## 한 것 (코드 5646367, 브랜치 codex/native-s25-baseline, PR #2 draft)
- 손 모델 = 웹과 같은 MIT WebXR generic hand(vendor-hand/hand-*.glb): 한 손 삼각형 2,314 · 정점 1,360 · 관절 25(모두 형제 노드, 계층 없음).
- `native/android/hand-view/main.js` → esbuild로 `app/src/main/assets/hand.html`(817 KB, three.js 0.170 + GLB 인라인) 빌드해 커밋. CI는 JS를 빌드하지 않음. 투명 WebView(`HandView.kt`)가 PreviewView 위에 그림. 웹 ghost 재질(반투명) + 깊이 선패스(안쪽 면 줄무늬 제거).
- 포즈: 우리 솔버·스무딩·제한 없음. 손바닥 틀 = 손목/검지·중지·새끼 뿌리(점 기반 프레임 정렬), 손허리뼈(metacarpal)는 손바닥과 한 덩어리, 손가락 뼈는 모델 길이 유지 + 다음 관절의 MediaPipe 점을 향하도록 최소 회전(swing). 손 크기 = MediaPipe world 손바닥 길이.
- `HandPlace.kt`: world 점을 화면 점에 평행이동 최소제곱(시야각 66° 가정) → 각 점을 자기 화면 광선 위로(깊이 유지) → 손바닥 길이가 MediaPipe 손바닥이 되도록 광선 따라 전체 배율(화면은 그대로). 단위 테스트 HandPlaceTest.
- 모델 준비 전·오류 시 기존 하늘색 점 표시. 오류는 상태 줄 "마지막 오류".
- 손 선택은 MediaPipe 라벨 그대로(테이크 6개에서 world 점 손 방향성(chirality)과 라벨이 항상 일치).
- FBX: v0.8 형식(21관절 손만)으로 되돌림(RawFbx/RawFbxTest/check-raw-fbx.c를 ed4b89b^에서 복원). JSON에 imageWidth/imageHeight는 유지.
- versionCode 13, `0.12-native-quest-hand`.

## 검증
- 헤드리스 Chromium(swiftshader)으로 웹 테이크 raw_take2/12, raw_w2take2 프레임 렌더 → `/mnt/project-files/hand-motion-studio/native/v0.12-quest-hand-test.png`. 웹 테이크는 가로 16:9 영상(ASPECT=1.7778로 맞춰야 위치 맞음). 하네스: 세션 scratchpad hv/shot.cjs + lib.cjs(HandPlace JS 판).
- 알려진 모양 문제: 화면 점과 MediaPipe 3D 깊이가 크게 어긋나는 프레임은 손이 두툼/늘어나 보임(카메라 가까운 손). 손 모델이 사용자 손보다 굵음.
- [CI run 41356869193](https://github.com/yonddu/3d-hand/actions/runs/41356869193) PASS(빌드·JVM 테스트·Lint·ufbx 21관절). [APK ZIP](https://github.com/yonddu/3d-hand/actions/runs/41356869193/artifacts/13103174332) 17,564,963 bytes(+0.32 MB), 2026-11-15 만료.
- 폰 확인 전. WebView 그리기 지연(카메라보다 1프레임 늦을 수 있음)·속도 미측정.

## v0.13 (코드 2de822f) — 몸 추적(MediaPipe Pose) 별도 옵션
- 사용자: "여기에 mediapipe pose도 같이 넣자", "포즈 트레킹 옵션도 별도로 추가하란거임 내 몸트레킹도 필요해져서".
- 버튼 "몸 추적(MediaPipe Pose) 켜기"(기본 꺼짐). 켜면 PoseLandmarker lite(vendor/models/pose_landmarker_lite.task, Apache-2.0, 5.8 MB; gradle prepareHandModel이 같이 복사)를 손과 같은 GPU/CPU 방식, 1명, 같은 프레임(MPImage close 전)에 돌림.
- 화면: 몸 33점 주황 선·점(visibility ≥ 0.5). 상태 줄 "몸 있음(N ms)/없음/꺼짐".
- 기록 JSON 프레임마다 `pose: {lm: 33×(x,y,z,visibility), world: 33×(x,y,z)}`. FBX는 손만(몸 미포함).
- [CI run 41361313644](https://github.com/yonddu/3d-hand/actions/runs/41361313644) PASS. [APK ZIP](https://github.com/yonddu/3d-hand/actions/runs/41361313644/artifacts/13104959113) 22,540,567 bytes(+5.0 MB), 2026-11-15 만료. versionCode 14, `0.13-native-pose`. 폰 확인 전, 몸 켰을 때 FPS 미측정.
- 주의: 1인칭(폰을 눈앞에 들고 손만 찍음)에서는 몸이 거의 안 보여 Pose가 대부분 못 찾음. 몸 전체가 보이게 찍어야 함.

## v0.14 (2026-11-02, 코드 bfc15cb + 8e77b1c) — 내 손 모델 불러와서 MediaPipe로 움직이기
- 사용자: 우리 손 리깅(FBX)을 게임에 넣으니 손이 다 뭉개짐 → 게임의 모델링·리깅된 손을 앱으로 가져와 MediaPipe에 맞춰 시뮬레이션하는 기능 요청(Quest 손 불러오듯).
- 뭉개짐 원인(추정, 확인 필요): 우리 FBX는 21관절 **위치만** 애니메이션(회전 없음, v0.8 형식). 게임 리그는 뼈 **회전**으로 메시를 움직이므로 위치만 받으면 뼈 길이·방향이 깨짐. 다음 단계 후보 = 불러온 리그의 뼈 이름·축으로 회전 애니메이션 FBX 내보내기.
- "내 손 모델 불러오기 (GLB/FBX)" 버튼 → OpenDocument → 바이트(≤60 MB)를 base64 512 KB 조각으로 hand.html에 전달(HandView.loadModel, modelBegin/Chunk/End, modelStatus 폴링). "Quest 손으로 되돌리기"로 복귀. 아래 줄에 파일명·찾은 손·삼각형·메시·뼈 수 표시.
- `hand-view/custom.js`: 뼈 이름으로 손가락 찾기(thumb/index/middle/ring/pinky + left/right; Mixamo·Unreal·Rigify·Unity), 손가락마다 마지막 3개 뼈가 움직임(앞쪽은 손허리뼈로 손바닥과 함께, 이름이 tip/end/4로 끝나는 마지막 뼈는 끝점), 손 뼈 = 손가락 뿌리들의 공통 조상. 모델 전체를 손 뼈가 MediaPipe 손목에 오게, 손바닥 방향·크기를 맞춰 배치. 손가락 뼈는 부모 기준 최소 회전으로 다음 MediaPipe 점을 향함. 한쪽 손 모델은 반대 손에 좌우 반전. 모델 자체 재질 유지.
- FBX 주의: three FBXLoader가 Mixamo FBX에서 같은 이름의 길이 0 뼈를 자식으로 하나 더 만듦 → 부모와 이름 같은 뼈는 건너뜀(8e77b1c).
- 확인(헤드리스): 우리 웹 GLB(Mixamo 이름, 삼각형 18,066), three.js 예제 Samba Dancing.fbx(Mixamo, 삼각형 55,320, 양손) — 주먹·편 손이 점을 따라감. 이미지 `/mnt/project-files/hand-motion-studio/native/v0.14-own-hand-test.png`. 
- [CI run 41367192766](https://github.com/yonddu/3d-hand/actions/runs/41367192766) PASS. [APK ZIP](https://github.com/yonddu/3d-hand/actions/runs/41367192766/artifacts/13107414131) 22,570,284 bytes, 2026-11-16 만료. versionCode 15, `0.14-native-own-hand`. 폰 확인 전.
- 한계: 뼈 이름에 손가락 이름이 없으면 못 찾음(평평한 계층 WebXR식도 미지원). 손목 비틀림·손바닥 접힘(손허리뼈)은 따라가지 않음. 큰 모델(수십 MB)은 WebView 전달·표시가 느릴 수 있음.

## v0.14.1 + v0.15 (2026-11-02, 코드 caca28a, fde145f)
- 사용자: "손모델을 거울반전 시킬지 말지 기능도 있어야" → 모델 불러오면 "모델 손" 버튼: 자동(뼈 이름, 모르면 오른손) / 오른손 / 왼손 / 반전 안 함. 양손 파일은 자동에서 반전 안 함. (이전엔 방향 모르는 모델을 양손에 반전 없이 썼음.)
- 사용자: 어깨까지 있는 모델 → "팔꿈치까진 따라 움직이면 좋겠다". Pose로 손가락은 안 잡힘(Pose 손 점은 4개뿐) → 손가락은 Hand, 팔꿈치는 Pose.
- v0.15: 몸 추적 켜짐 + 모델에 아래팔 뼈(forearm/lowerarm/elbow 이름, twist/roll 제외)가 있으면: 화면에서 손목이 가장 가까운 Pose 팔(손목 15/16, 가시도 ≥0.3, 거리 <0.12)의 팔꿈치(13/14, 가시도 ≥0.5)를 사용. 팔꿈치 = 그 화면 광선 위, MediaPipe 손목에서 모델 아래팔 길이만큼(가깝/먼 쪽은 Pose world z, 카메라 뒤·너무 가까우면 먼 쪽). 모델을 팔꿈치 기준으로 돌려 아래팔이 손목에 닿게 하고 손 뼈는 화면 손바닥 방향으로 되돌림. 위팔은 모델 그대로(어깨 미추적).
- 확인: 헤드리스, Mixamo 이름 GLB + 가상 팔꿈치 → `/mnt/project-files/hand-motion-studio/native/v0.15-elbow-test.png`(왼쪽 팔꿈치 없음, 가운데·오른쪽 노란 점 = 팔꿈치).
- [CI run 41368983780](https://github.com/yonddu/3d-hand/actions/runs/41368983780) PASS. [APK ZIP](https://github.com/yonddu/3d-hand/actions/runs/41368983780/artifacts/13108651763) 22,573,694 bytes, 2026-11-16 만료. versionCode 17, `0.15-native-own-arm-elbow`. 폰 확인 전.

## v0.16 (2026-11-02, native 907dac9): Quest hand removed, points always shown

- User: "퀘스트손은 없어도 되는데 리깅포인트 그대로 보이게" + "glb 파일 로딩하면 그 스킨이 덮여야지".
  hand.html now draws only a loaded GLB/FBX (886 KB -> 631 KB), vendor-hand/ deleted,
  LandmarkOverlay always draws the MediaPipe points/lines (model skin drawn over the camera, points on top).
- User's Meshy AI "Shadow Gauntlet" GLB had NO skeleton (1 mesh, 21,008 verts, 31,210 tris, whole arm to
  shoulder, made by trimesh). custom.js now says so instead of "finger bones not found".
- Auto-rig: tools/autorig/ (load.py, joints.py, build.py; numpy only). joints.py finds finger centerlines
  from hand-tuned base/tip guesses (this mesh only: hand along +z, fingers spread in y, back of hand +x),
  MCP = 0.18 finger length inside the web, PIP/DIP at 0.33/0.66. build.py: Mixamo names
  (LeftArm/LeftForeArm/LeftHand/LeftHandIndex1..4), identity rest turns, weights 1/(d+4mm)^4 over the
  nearest bone + its parent/children only (no bleed between fingers). Output
  /mnt/project-files/hand-motion-studio/native/gauntlet_rigged_left.glb. Treated as LEFT (cuff emblem = back
  of hand); if the palm faces wrong, user picks 오른손 on the side button.
- Headless replay of user record hand-native-1793581459272.json (121 frames, 1 right hand, ~12 fps live)
  with the rigged gauntlet: follows the points incl. fist (v0.16-gauntlet-test.png). Not phone-verified.

## v0.17 (2026-11-02, native a7f8991): model finger lengths fitted to the user

- User: loaded gauntlet looks crushed because model and MediaPipe finger lengths differ.
  Measured on hand-native-1793581459272.json: at equal palm (wrist->middle MCP) the gauntlet's finger
  bones were 1.4-2.2x MediaPipe's (thumb 1.0-1.1x); MediaPipe per-frame finger length CV 27%.
- main.js calibrate(): per side, median MP world bone length / palm over the first 60 frames
  (refit at 5, 10, 20 .. 60 samples, then fixed). custom.js fitLengths(): each finger bone scaled evenly
  about its joint, clamp 0.5-1.6, child scale = q/q_parent. Record: index .58/.66/.64, middle .68/.64/.67,
  ring .51/.61/.64, pinky .50/.66/.62. Fingertips now end at the points (v0.17-length-fit.png);
  fingers thinner by the same factor. MeshHand carries world[63]. Not phone-verified.
- Open: knuckle spread (index MCP -> pinky MCP) model 0.87 palms vs MP 0.64 is NOT fitted.

## v0.18 (2026-11-02, native fffdcff): thickness kept, hinge PIP/DIP

- User (gauntlet v2, data/models/gauntlet2_rigged_left.glb): fingers twist / look odd, make them thicker.
- fitLengths now edits the rest pose: next joint position *= q, skin vertices move by
  sum(w * (shift + dir * clamp(along,0,len) * (q-1))) per finger bone, boneInverses *= T(-shift);
  each instance clones its geometry. Thickness = model's. Scales on the record (v2): thumb .94/1.29/1.24,
  index .77/.83/.88, middle .80/.78/.89, ring .65/.76/.85, pinky .56/.87/.86.
- pose(): PIP/DIP of index..pinky aim projected off the knuckle-line axis (restLat turned by parent),
  so no sideways bend / twist; MCP and thumb free. Points may sit slightly beside the fingertip when
  MediaPipe reads a sideways bend. Picture: native/v0.18-thick-hinge.png. Not phone-verified.

## v0.20 (2026-11-02, native 63bb5b7): rotation retarget (user spec, 7 items)

- User spec (likely GPT-written, given as [지시]): directions only, model bone lengths kept, no bone
  translation except wrist root; palm basis wrist->middle MCP + index->pinky MCP; no twist + joint limits;
  open-hand calibration button; keep last pose when lost; GLB rotation animation + still-pose GLB.
  v0.17-v0.19 length/knuckle fits REMOVED (contradict the spec).
- custom.js pose(inst, P, elbow, Wd): Wd = MP world points (three axes). First bones: seen dir in palm frame
  (+cal q0), MCP flex clamp -30..100. PIP/DIP: seenBend (flex about knuckle line; side clamp 20 deg, rest of
  the bend counted as flex, back only if < -10 deg) applied to model parent dir about its turned knuckle
  axis, flex 0..115. Thumb free. calibrate(): q0 per finger + flex/side offsets vs model rest. palmSign from
  model handedness (right +z). snapshot()/exportGlb() (GLTFExporter, root pos+quat + bone quat tracks).
- main.js: calibrateOpen/calibrateClear (localStorage hms.openHand.<side>), HOLD_MS 500, recBegin /
  exportBegin / exportChunk. MainActivity: model panel (calibration, GLB anim, SeekBar still pose,
  실시간 보기), replays saved frames incl. recorded pose elbow; minTrackingConfidence 0.3.
- Checks on hand-native-1793581459272.json: PIP/DIP bends of gauntlet v1, v2, Mixamo arm identical, median
  |model-MP| 0.4 deg (mean 9.6 = clamps). Picture distance 31-36% of palm (model lengths kept, by design).
  Exported GLB reloads (anim 9.0 s, 16 rotation + 1 root translation channel; bone translations = model).
  Files: native/v0.20-three-models.png, v0.20-exported-glb.png, v0.20-sample-pose.glb, v0.20-sample-anim.glb.
  Not phone-verified.

## v0.21 (2026-11-02, native 30b170a): options screen
- User: too many options, camera view squeezed. Camera screen: view, status (11sp), still-pose slider (model + recording),
  측정 / 편 손 보정 / 옵션. Options screen (ScrollView): back button, GPU/CPU, hands, pose, model load/side, info,
  GLB anim / JSON / FBX saves, notes. CI 41382928418 artifact 13114765015. Not phone-verified.

## v0.22 (2026-11-02, native a713c81): skin on my hand (screen) + rotation-only GLB
- User (frustrated, v0.20 static pose GLB + old raw FBX "다 엉망"): "그냥 내 손에 스킨 씌운다는 개념으로".
  Resolution: SCREEN = model skeleton fitted to the user (v0.19 fitLengths: lengths + knuckles from first 60
  frames, roots on points each frame, skin re-bound); TURNS = v0.20 rotation retarget; GLB = untouched
  template + turns (fit never touches export). Options toggle main.js fitHand(on) rebuilds instances.
- Also: DIP = 2/3 PIP (DIP_RATIO, side 0; HMS_NOCOUPLE to compare), still pose = per-joint quaternion
  median over +-0.5 s (POSE_WINDOW), anim Gaussian sigma 0.06 s both ways (smoothFrames, window 4 sigma).
- User's FBX (old position-only raw export, 365 frames 19.7 s) reconstructed to MP world (local deltas, y/z
  negated back) as test take scratch hv/fbx1.json. Picture distance: no fit 24.6%, fit 5.1% of palm; DIP>PIP
  38% -> 0%. Files native/v0.22-*.png/.glb. Old FBX export is still position-only (causes crushed rigs).

## v0.23 (2026-11-02, native d35b4c9) — model baked to the user's hand + first-person forearm

User: screen and game look different; "how do I build a character that fits MediaPipe"; then gave
gauntlet_rigged_left.glb: "make it like that". Also: "awkward, can't use it (wrist)".

- **Bake** (custom.js `bakeFitted`, main.js `window.bakeBegin`, Options button "이 모델을 내 손 비율로
  고쳐 저장 (GLB)"): a fresh non-mirrored instance of the loaded model gets `fitLengths` with the
  user's measured lengths/knuckles (`fitCal`, first 60 live frames; now measured even with the
  screen fit off), wide clamp (`inst.wide`: ratio 0.25..3, knuckle move <= 1 palm; right-hand
  knuckle z negated for a left model), rest turns, skins re-bound (`skeleton.calculateInverses`),
  exported with GLTFExporter. Re-loading that GLB = bones like MediaPipe's, so screen (fit off) =
  exported GLB. Result for gauntlet v1 + user's FBX take: project files
  native/gauntlet_myhand_left.glb (finger ratios index .55/.60/.82, pinky .47/.69/.65 of model).
- **Forearm without body pose** (`firstPersonElbow`): two-bone reach from the wrist to a shoulder at
  (±0.18, -0.28, 0.05) m camera space (upper arm 0.29, forearm = model forearm × scale, elbow pole
  down/out), wrist hand line clamped within 65° of the forearm. Before, the whole model turned with
  the palm (arm swung with every wrist turn). User FBX take: forearm turn/frame mean 3.10 → 1.57°,
  p95 11.8 → 6.1. `HMS_NOARM` flag = old behaviour. Not phone-verified.
- Harness: scratchpad hv/bake.cjs (take, model, out), shotf.cjs (prints window.lastFore with HMS_DEBUG).

## v0.24 (2026-11-02, native 3ac4d5a) — steadier hands

User GLB hand-anim-1793605873742.glb (gauntlet v1, not the baked model; 220 frames, 18.5 fps):
"graphics jump around". Parts jump frame to frame (Thumb2 154°, root 50° in one frame). Raw
MediaPipe itself jumps (nat1 native take, 11.9 fps: palm 16.7°/frame, p95 62°), so it is input
noise + low fps, not the retarget.
- Export (`exportGlb` anim): `medianFrames` ±2 frames per joint, then `smoothFrames` 0.12 s
  (was 0.06). Jumps >15°/frame: user GLB 336→57 (max 154→28), nat1 281→100, fbx1 170→23.
- Live: main.js `liveFilter` One Euro on cam + world points per side slot (min 1 Hz, beta 5,
  reset after 300 ms unseen); record replays unfiltered. Python sim: palm turn/frame −25..35 %,
  ~6 mm average offset. `HMS_NOFILTER` flag.
- Smoothed copy of the user's GLB: project files native/hand-anim-1793605873742-smoothed.glb.
- Open: low capture fps (12–18) on the phone; check what slows it (CPU MediaPipe? pose on?).

## v0.25 (2026-11-02, native ab3ae3f) — early web solver's steadiness

User: the early web Quest hand (0f1084d, before the arm) and later the web arm with wrist
looked much better. Why native is worse: native restarted from raw MediaPipe → retarget
(user's 10-28 "pure MP is better"), none of the web pipeline (One Euro, confidence slerp,
limits on every joint, wrist pivot/arm rules, correctives, purpose-made Quest mesh with wrist
fade) was ported, and the AI gauntlet mesh has no knuckle loops.
- Ported: per-bone live slerp 0.35 + 0.65·confidence (bone-length change vs running ref,
  web solver.js boneConfidence), only when the last pose is < 300 ms old; thumb cone (MCP 75°,
  IP 90° from the bone before). Flags HMS_NOCONF / HMS_NOTHUMBLIM. main.js window.debugSnap.
- Live jumps >15°/frame (scratchpad hv/live.cjs + livem.py): nat1 392 → 287 (filter) → 222;
  fbx1 442 → 242 → 152, max 107 → 83.
- Next candidate: port the web's final wrist/arm rules (wrist bends at carpal pivot, forearm
  holds while wrist bends, roll limit ±110° from thumb-up).

## v0.26 (2026-11-02, native 5a34198) — side kept through palm/back flips

User: "fingers get smashed every time I turn the palm over". nat1: MediaPipe labels the right
hand 'left' exactly at the flips (frames 10, 26–28 of 108); native posed it as the other,
mirrored instance (a second arm pops in, fingers inside out). main.js `keepSides` (before the
hand loop, so live + GLB export replay): a lone hand whose label's track is not near/recent,
where the other label was seen < 400 ms ago within 0.25 picture units (x/z, y/z), takes the
old label. `HMS_NOSTICKY` = off. Picture: project files native/v0.26-flip-side-fix.png.
Not handled: two hands both swapping; RawFbx (position FBX) still uses raw labels.
