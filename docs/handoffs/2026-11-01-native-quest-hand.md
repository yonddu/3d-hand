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

## v0.27 (2026-11-02, native 5aa44c9) — fingers at palm/back flips

User take hand-native-1793609342413.json (123 frames, 16.6 fps, NO label swap; converted copy
project files native/take-flip-1793609342413.json): at flips (frames 12, 68, 98) MediaPipe world
reads curled fingers with a flipped knuckle line (PIP/DIP 150–170°), seenBend called them
"backward" and the clamp made them straight. Now `BACK_MAX` 35°: a middle/end joint bent back
more than that (knuckle: more than 55°) is taken as the forward bend. `HMS_NOBACKFIX`.
PIP |model − MP| user take 21.2 → 1.5°, curled-but-straight 103 → 0 / 492; nat1 37 → 0; fbx1 2 → 0.
Harness: hv/bendcmp.py (take, shotm log).
User then asked for the web way (record, analyse the whole take, view the corrected result).
Proposed: record 30 fps video, offline re-detect every frame, whole-take corrections, play back
the final motion; warned ~60 MB/min video, analysis 1–2× take length. Awaiting answer.

## v0.28 (2026-11-02, native bb2e00c) — game build: fixed hand

User goal: first-person sword (kukri) swing for their game; the arm is always
gauntlet_rigged_left.glb. Options without skin fit, CPU switch, model loading.
- assets/hand_model.glb = gauntlet v1 + kukri (user's tf2_hd_kukri_remade.glb, Sketchfab Standard,
  TF2/Valve design: told user to check rights before release) as a static mesh child of LeftHand.
  Built in scratchpad viewer/comb.js (handle centre source (0,-4.5,0.3), length 1.25 palm widths,
  rotated 180° about y: blade out of the thumb side, edge (knife −z) forward = hand +z, at the
  mean finger root, 0.3 palm toward the palm side), then the knife's 4 images swapped back to the
  original bytes (exporter re-encode made 32 MB). Copy: project files native/gauntlet_kukri_left.glb.
- MainActivity.loadBuiltInModel (waits for window.modelBegin) at start; main.js fitOn default off
  (HMS_FIT turns it on). Options no longer show backend/model/side/bake/fit buttons (objects kept).
- Swing capture: recommended phone gyro/accel recording (decision card open, not built).

## v0.29–v0.30 (2026-11-02, native d6550e1, 70589ab)

- v0.29 user: fingers must never go past the back of the hand. Knuckle (MCP) range 0..100°
  (was −30..100; HMS_MCPBACK = old). MP read knuckles bent back >5° in 115/492 (flip take),
  70/448 (nat1), 64/1460 (fbx1).
- v0.30 user: right hand is the standard. assets/hand_model.glb = gauntlet+kukri mirrored with
  tools/autorig/mirror_glb.py (main repo; S=diag(1,−1,1): positions/normals/tangents(w too),
  winding, node matrices + inverse binds S·M·S, Left→Right names). Copy: project files
  native/gauntlet_kukri_right.glb. Saved GLBs now carry RightHand* bones.

## v0.31 (2026-11-02, native b57b810) — weapon toggle

User concept: a tool for the ARM ACTIONS of a first-person action game (kukri swings now,
punches later). Options "무기: 쿠크리 / 맨손" → main.js `setProp` hides meshes named Kukri* on
the template and instances; `exportGlb` drops hidden meshes (pairs built first). Next ideas:
punch = elbow extension toward the screen (hand size → distance, shoulder IK), fast actions need
offline 30 fps or phone-sensor capture (both on hold until the user says go).

## v0.32 (2026-11-02, native 2c82781) — real left/right with the back camera

User screenshot: a right hand was drawn as a left hand. MediaPipe handedness assumes a mirrored
selfie picture; the app films with the BACK camera, so MP "Left" = the user's right hand.
MainActivity `realSide()` swaps the label for live sides and saved takes (take JSON
`"labels": "real"`). Takes saved before v0.32 carry MP's raw (inverted) labels. This also puts
the first-person shoulder on the right side. Title now shows the installed versionName
(was hardcoded v0.22). Not phone-verified.

## v0.33 (2026-11-02, native 43fa82b, CI 41431184410) — record → re-analyse → correct → review

User: the live hand/screen twists; record, correct, show the natural result (phone-as-sword
idea dropped). While measuring, CameraX also records video (Recorder, HD, cacheDir/take.mp4;
bind falls back to no video). On stop: camera unbound, VideoPass.kt (MediaExtractor frame
times + MediaMetadataRetriever.getFramesAtIndex batches of 8, landscape frames turned upright,
fresh VIDEO-mode HandLandmarker) re-reads EVERY frame; frames replaced unless the video found
< half the live hand frames; file deleted. Then prepareTake: frames fed with `collect: true`,
page `recFinish()` runs hand-view/clean.js (tracks by picture position, one side per track by
score vote, tracks < 0.25 s / 5 frames dropped, per-point Hampel ±4 samples 3 MAD (min 12 mm
world / 25 mm cam), gaps < 0.3 s interpolated) and poses for export; `reviewPlay()` loops the
export-smoothed snapshots (custom.applySnapshot). '보정 재생' button; '실시간 보기' stops it.
Cleaner alone on old live takes: export jumps nat1 74→75, fbx1 11→15, u4 75→75; raw MP palm
turns 17°/frame on nat1 at 12 fps (flips are real but squeezed into 1–2 frames), so the gain
must come from the 30 fps re-read. Analysis time ≈ video length × (decode + detect); video
~5 Mbit/s temp. HMS_NOCLEAN skips clean.js. Not phone-verified.

## v0.34 (2026-11-02, native c41fc8f + 88b2b76) — my hand by default, skins optional, hand/body switch

User: remove the kukri and the built-in gauntlet; default = the user's own hand (MediaPipe
points/lines); a skin (rigged GLB/FBX) is optional ('스킨 추가' in Options + model-hand side
button). assets/hand_model.glb deleted (APK −20 MB; copies stay in project files
native/gauntlet_kukri_right.glb). '몸 추적' is now a SWITCH: hand tracking OR body tracking
(startModel creates only one landmarker; analyzer handles a null hand result; VideoPass
`body` param re-reads the video with Pose). During the video re-read a centred notice
(BUSY_TEXT: 화면 보정 중입니다 … 완료되면 훨씬 깔끔) shows frame progress. Without a skin,
'보정 재생' plays the re-read take as points (playPoints, overlay). Not phone-verified.
Concept discussion same day: user wants a monetizable phone app; plan doc (Quest 3 as teacher,
phone filmed together, correction model) https://claude.ai/artifact/5WnGYCBcrR5pKN4EkLwpNn —
not started. Retarget onto other skins is NOT proven visually (only equal bend numbers).

## v0.35 (2026-11-02, native 31d6bee + fix 134d21b) — full-body skin from body tracking
- User: add features from Kalidokit (MIT) / SysMocap (MPL-2.0). Ideas only, no code copied.
  Kalidokit's hand solver NOT used (measured worse 2026-10-26: 23.1 vs 20.2 deg).
- hand-view/body.js: humanoid bones by name (Mixamo, Unreal, Rigify, VRoid J_Bip) or from the
  VRM 0.x/1.0 humanoid map in the glTF JSON (no three-vrm). Hips on their picture ray (depth =
  torso world length / picture length), size = median of 45 frames, turn from hip + shoulder
  lines, limb bones aimed at Pose directions (visibility >= 0.5), head by the ears.
- One skin can drive hands, body or both ('스킨 추가'). Record -> clean -> review -> GLB works
  for body ('전신'). hand.html +9 KB.
- Headless check: Vanguard (Mixamo FBX) + three-vrm-girl (VRM) follow T / arms down / mixed
  poses; 50-frame body take exported. Not phone-verified.
- v0.34's CI failed: `overlay` inside a Button.apply block resolved to View.getOverlay();
  fixed with this@MainActivity.overlay (134d21b).
- Next promised: manual bone mapping in options for rigs auto-detection misses.

## v0.36 (2026-11-02, native e52d1c1, CI 41542379862) — depth filter + sideways 15 deg
- User asked (GPT-style list reviewed): stronger z filter, finger sideways +-15. Measured on nat1/fbx1/u4 with user_g1.
- Live One Euro: world z cutoff x0.5 (OE_ZK, HMS_OEZ). Live jumps >15 deg 202/159/183 -> 187/147/186; lag vs raw +1.2..1.7 deg mean. Kept.
- clean.js smoothZ (record->correct): no gain (0.08 s: 73/14/73 -> 75/14/74), OFF (Z_SIGMA 0, HMS_ZSIGMA to test).
- PIP/DIP sideways SIDE_RAD 20 -> 15: exported jumps 75/15/75 -> 73/14/73. Kept.
- Rejected after review: bone-length z = ±sqrt(L²-dx²-dy²) (old web lift, sign is the error); palm side from handedness (labels flip at flips; world palm vs picture disagree only 2/117 in take-flip).
- Harness: scratchpad hv/exp5.cjs (ZS env), live2.cjs (OEZ, LOUT), lcmp.py, gdiff.py.

## v0.37 (8fcb749, 6b758e6, fix a96057a) — rig screen (user marks MediaPipe's 21 points)
- Options -> '리깅 잡기 화면': separate full screen (camera unbound, title/status/buttons/preview/overlay hidden).
  hand-view/rig.js openEditor: point names (0 손목 WRIST .. 20 새끼 끝 PINKY_TIP), tap = point between ray
  entry/exit of the skin, TransformControls X/Y/Z arrows, 1-finger turn (view follows current point),
  pinch zoom, tap a point to fix it, model side button. Saved localStorage hms.rig.<file name>, applied on load.
- applyRig: model with >=16 bones -> each point to nearest bone head (CustomHand rigMap, node indices);
  no bones -> Mixamo-named bones on the points + skin (top-4 nearest segments, falloff 0.06 palm).
- Headless: gauntlet with true points = identical export to name auto-detection; gauntlet stripped of
  rig + 4 mm jitter rebuilt, follows nat1 like the original (images native/v0.37-rig-*.png).
- Kotlin gotcha (twice now): `overlay` inside Button.apply = View.getOverlay(); use this@MainActivity.overlay.

## v0.38 (5844855) — thumb tip meets the touched fingertip
- custom.js touch(): MP thumb tip within 0.2 palm of a fingertip (leave 0.28) -> CCD on the 3 thumb bones
  (12 x 40 deg, ease 0.25) to MP's offset from that tip (scaled to model palm). HMS_NOTOUCH.
- Gap error (palms) nat1/fbx1/u4 0.72/1.08/0.97 -> 0.30/0.56/0.12; live jumps 226/264/194 -> 244/309/207;
  GLB jumps 104/87/98 -> 89/87/97.
- FINDING: pre-v0.32 takes (nat1/fbx1/u4) carry MediaPipe labels = opposite hand. Use *_sw.json (sides
  swapped) in scratchpad hv/. v0.25-v0.36 numbers were measured on the mirrored labels.

## v0.39 (0034925) — body contacts
- body.js contacts(): planted foot (picture speed < 0.35 torso/s, leave 0.7) held at plant place via
  two-bone leg reach; wrist near other wrist / head / own hip (< 0.16 torso, leave 0.24) -> arm reach to
  the person's offset (claps meet halfway). HMS_NOCONTACT. Clock = frame t (reset on time jump).
- Synthetic (hv/body3.cjs): foot drift Vanguard 5.3 -> 0 %, VRM 10.0 -> 0 % torso; clap gap error
  0.159 -> 0 / 0.026 -> 0. No real body take yet.

## v0.40 (54378a9) — rig screen guide
- User asked: tell people to put rig points on JOINTS (fold lines), not mid-segment; name + position per point; MediaPipe colour/name example beside the model.
- rig.js: POINTS now [ko, en, where]; header says "관절(접히는 곳), 손가락 두께 한가운데"; colour legend per finger (wrist white, thumb red, index orange, middle green, ring blue, pinky purple — same as the 3D markers).
- Guide panel (top right, under header): 2D MediaPipe palm-view hand with all 21 numbered dots (filled = placed, ring = current; mirrored for "모델: 오른손") + names of the current finger's 4 points. Bottom label shows "위치: ..." text.
- hand.html 752,526 bytes (+~5 KB). Screenshot native/v0.40-rig-guide.png. Not phone-verified.

## v0.41 (fcb68ea) — rig screen arrows slower + pan
- User: XYZ arrows too fast; fixed model centre makes it hard; asked for two-finger move = move view.
- Cause of speed: the camera chased the dragged point every frame, so drags ran away (60 px finger -> point moved 0.313 model units, ~3.7x the finger).
- Now: arrow drag = 0.3x finger (FINE in rig.js; 60 px -> 0.025, 17.7 px on screen), camera target frozen while tc.dragging; two fingers moving together pan 1:1 in screen plane (pinch still zooms); '화면 가운데로' button resets pan. Test: scratchpad hv/dragtest.cjs (mouse drag; synthetic touch events break TransformControls pointer capture).

## v0.42 — rig screen: pick points in any order
- User: choose which point to place, not 0..20 in order. Tapping a dot or a name in the MediaPipe example panel selects that point; placing no longer auto-advances (the point stays selected; tapping the model again moves it). Test: scratchpad hv/picktest.cjs (12/4/17 picked, stays on 17 after placing).

## v0.43 — rig screen: steady view
- User: the view keeps shifting when placing points. Removed the camera chase of the selected point and the auto-zoom (frameHand is a no-op). Only turn / two-finger pan / pinch move the view. Test hv/viewtest.cjs: placed point drift over 4 more taps 61 px -> 0 px.

## v0.44 (4b98de3) — rig markers half size
- User asked for placed-point spheres half as big: marker size*0.006, palm*0.025 (current point x1.5).

## v0.45 (67b02a4) — body (MediaPipe Pose) + free rig screens
- Options: three buttons — 손 리깅 (21 hand points), 몸 리깅 (17 Pose points: 0,7,8,11-16,23-28,31,32), 기타 리깅 (free points → rigged GLB). Kotlin openRig(kind) local fun in onCreate; HandView.rigOpen(kind), rigGlb().
- rig.js openEditor({kind}): per-kind colours/lines/example panel/text. Body 'left' = model's own left (front view: screen right). Free: '새 점 추가' adds a point whose parent = current point; output {kind:'free', pts, parents}.
- applyBodyRig: bones >= 8 → mapBodyBones (limbs nearest bone heads; head nearest; neck = nearest bone on the head's ancestor chain — nearest-to-shoulder-mid picked the collarbone; spine/chest/upperChest = bones between hips and neck) → VRM-style map into CustomBody. No bones → buildBody (Mixamo names) + bindBones skin.
- Storage: localStorage hms.rig.<file> (hand), hms.bodyrig.<file>, hms.freerig.<file>. Unrigged file with both hand and body rigs: body wins (one made skeleton per skin).
- Headless checks (scratchpad hv/bodyprep.py, bodyrig.cjs, bcmp.py, freetest.cjs): three-vrm-girl points from its VRM joints → same bones as VRM map, sway hand/foot path diff 0.00 % torso; bones stripped → 19 bones made, constant 10-11 % offset, skin follows (native/v0.45-body-rig-bare-vs-original.png); free 7 points → 7-bone tree GLB; hand rig export byte-identical to v0.44. hand.html 767 KB (+14 KB). Not phone-verified.

## v0.46 — hand rig: tree-based bone matching
- User phone screenshots (gauntlet, v0.45): rigged glove fingers did not follow. Reproduced: greedy nearest-bone mapping breaks at ~20 % bone-length point error (wrist -> Thumb1, fingers swapped; 6-10/16 wrong).
- rig.js mapByTree: hand = bone with 5-9 branches (within 2 levels) near point 0; branch = path into biggest subtree; each finger's MCP/PIP/DIP vs 3 consecutive branch bones (+0.15 palm per offset), best finger->branch permutation. Greedy = fallback. window.lastHandRig shows the mapping (debug).
- Tests (hv/perturb.py, maptest.cjs, mapeval.sh): 0/16 wrong for noise 0.2/0.35 and mid-bone 0.5 on 3 models; noisy-point export 33.5 deg mean error -> 0.01. Exact points byte-identical.

## v0.47 (747bca5) — 'MediaPipe as is' finger option + measured trade-off
- User GLB (hand-anim-1793715474637.glb: in-app built 21 bones, skin follows bones) "fingers do their own thing, not aligned"; asked how other games apply MediaPipe.
- New metric (hv/errtest.cjs, HMS_DEBUG inst.err): picture distance model joint -> MP point, % palm. Rules (default) fbx1/nat1/u4 27.8/36.4/48.7; HMS_PURE=3 (every bone aimed at MP direction) 19.4/31.0/38.5. Proper Mixamo gauntlet same pattern (31.1->23.9 ...). PURE=1 (knuckle only) 26.5/36.0/44.7; PURE=2 (other joints only) 22.8/30.3/36.0 but jumps x2.
- Cost of PURE=3: live jumps>15 300/223/194 -> 271/305/333; exported GLB jumps 71/75/90 -> 61/160/175, max 150 deg (depth flips). Old takes are 12-18 fps live; new 30 fps re-read takes not measured yet.
- Options button '손가락: MediaPipe 그대로 / 앱 보정 규칙' (SharedPreferences pure + localStorage hms.pure; window.setPure). Default = rules; default export byte-identical.
- Remaining error also at finger ROOTS (8-13 % palm): model palm/knuckle shape vs user's (편 손 보정 fit).

## v0.48 (64b3d34) — as-is fingers: no back bend, min 5 deg
- User: fingers must never go toward the back; keep slightly bent (>0) so front/back is decided.
- custom.js HMS_PURE branch: non-thumb joints flex >= MIN_FLEX_DEG 5 (knuckle in palm frame; middle/end via bendOf about model knuckle line). HMS_PUREBACK 2 = clamp (default), 1 = mirror back bend to forward (worse: 31.0/41.3/51.6, jumps 609/386/310), 0 = none. HMS_MINFLEX test override.
- fbx1/nat1/u4: picture err 24.7/35.6/45.2 (rules 27.8/36.4/48.7, as-is free 19.4/31.0/38.5); live jumps 267/183/184 (rules 300/223/194); GLB jumps 172/68/77 max 47-65 (rules 71/75/90 max 22-39, free 61/160/175 max 139-150). MIN 10: err 23.5/35.8/46.8 jumps 331/203/180.

## v0.49 (f7a0d6f, CI 41671792169, artifact 13249067007) — fist under-fold; test-take side mistake
- User: "MediaPipe shows a tight fist, skin folds less than half". hv/bendtest.cjs (fist frames, MP vs model bone vs MESH=1 skinned-vertex bends): skin follows bones (u.glb auto weights fine). Rules mode: DIP = 2/3 PIP + MCP 100 / PIP 115 caps -> 70-90 % of MP fold (u4 pinky 108/136/128 -> 76/107/73). v0.48 as-is mode bug: back clamp held deep folds at 5 deg (u4 pinky mid/end 136/128 -> 43/36).
- Fix (user chose): HMS_PUREBACK 3 default — back read past BACK_MAX 35 = flipped deep fold, taken forward; small back -> MIN_FLEX 5. u4 pinky -> 98/97. fbx1/nat1/u4 err 18.1/29.5/40.9 % palm, live jumps 244/272/259 (v0.48: 18.1/30.4/43.3, 229/243/223; rules 18.6/30.9/42.9, 164/190/184). Rules HMS_NOCOUPLE (not shipped): 18.3/30.2/42.1, jumps 214/217/227.
- CORRECTION: v0.47/v0.48 numbers used hv/*_sw.json (labels swapped). On the original labels the fit is much better (rules fbx1 18.6 vs 27.8 %, jumps 164 vs 300) and fist knuckles read palm-ward; on _sw they read backward. Use the original fbx1/nat1/u4.
- OPEN, important: those takes (u4 = raw MP labels, pre-v0.32) have MP label 'right' + right-hand chirality in world AND picture x. Live now sends realSide() (= swapped), i.e. the _sw state, for custom.js posing. Suspect v0.32 inverted the skin posing side (fists read backward -> clamped straight). Needs a post-v0.32 raw take (fist, labels real) to confirm before changing anything.

## v0.50 — real side fix (undo v0.32 label swap)
- User take hand-native-1793726967306.json (v0.49, right-hand fist, 222 frames, "labels":"real") was labelled 'left'; its points fold like a right hand (126/133 folded frames; world and picture x agree). So MediaPipe Tasks' raw label already equals the real side on this back-camera pipeline, and v0.32's realSide() swap mirrored the skin onto the wrong side.
- Same take, u.glb: rules err 38.4 -> 24.0 % palm, live jumps 147 -> 49; as-is 35.8 -> 23.1, jumps 416 -> 113 (hv/n49.json app labels vs n49_sw.json fixed).
- realSide() now keeps MediaPipe's label; new takes "labels":"mp". Takes from v0.32-v0.49 ("labels":"real") are SWAPPED. v0.31 "right hand drawn as left" screenshot cause was not re-checked (the built-in gauntlet is gone since v0.34).

## v0.51 (6b558bf) — edge-on hold
- User: fingers move on their own while slowly turning palm <-> back. hv/errtest2.cjs: frames within 2 of an edge-on picture (|sin| wrist->index root vs wrist->pinky root < 0.15; 5-24 % of frames) held 25-62 % of live jumps. World palm facing vs picture order otherwise agree (2 disagreements in 4 takes).
- custom.js after touch: edge < EDGE_ON 0.25 and fresh -> root turn (wrist kept) and all animNodes slerp prev -> new by EDGE_K 0.3. Live jumps n49_sw/fbx1/nat1/u4 rules 49/164/190/184 -> 43/152/129/148, as-is 113/244/272/259 -> 99/227/205/220; error within +-0.8 % palm. HMS_EDGE=0 off; 0.15 or K 0.15 were weaker.
- User idea (palm as a solid box deciding front/back/side, fingers kept in its frame): fingers already are in the palm frame; the box's facing is what flips edge-on. Next step if needed: whole-take palm-facing plan over the recorded take (like web mirrorPlan) in the record->correct pass.

## v0.52 (7a5c53f) — palm prism display option
- User: triangular solid on the palm (wrist, index root, pinky root), one colour per face. main.js palmPrism (prismScene drawn after the main render with cleared depth, so it shows over the skin): palm red, back blue, thumb side yellow, knuckles green, pinky side purple; palm side = +(P5-P0)x(P17-P0) for right, - for left; half thickness 0.12 x wrist->middle root. Options '손바닥 도형' (prefs prism / localStorage hms.prism / setPalmPrism). Display only.
- Render: /mnt/project-files/hand-motion-studio/native/v0.52-palm-prism.png (user fist take n49_sw, frames 10-140: palm -> thumb side edge-on -> back). Script hv/prismshot.cjs.
- Told the user an invisible cube cannot settle front/back (its turn comes from the same points); real cues = sticker/glove, pixel model, or whole-take plan.

## v0.53 (a54a6aa) — prism removed, edge-on thumb check
- User removed the palm prism (v0.52 reverted). User idea: right hand thumb is always on one side (joint structure) -> facing is decided. Measured on 67 edge-on frames (4 takes): 2D side of thumb tip vs wrist->middle-root line agrees with MP palm facing 63/67; the 4 disagreements are the frames where the palm turned ~91 deg in one frame (MP flip); fingertip side 58/67. custom.js edge block: disagreement -> EDGE_K 0 for that frame (HMS_NOTHUMBCUE off). Jumps rules 43/152/129/148 -> 43/152/128/148, as-is 99/227/205/220 -> 99/227/200/213. Small because v0.51 hold already damped them.
- Not done: thumb never bent back + min flex (user asked; thumb flex axis differs from fingers, offered).

## v0.54 (f4c2fd8) — no back bend anywhere, >= 5 deg toward the palm
- User: thumb never bends back and stays slightly bent; other fingers the same, then test and build.
- Thumb MCP/IP (both modes): flex about (bone before) x (joint -> middle of model palm: hand, index root, pinky root); palm-normal axis read the fist thumb mostly as 0/-30 (wrong axis), the across-palm axis reads it forward. flex < 5 -> 5; < -BACK_MAX -> mirrored forward (cap 90). Pre-clamp histogram via window.HMS_TFLEX (hv/tflex.cjs).
- Rules mode: MCP/PIP/DIP min 0 -> MIN_FLEX_DEG 5 (coupled DIP too). As-is mode already had it.
- Jumps rules 43/152/128/148 -> 39/145/128/145 (err +0..0.7 % palm); as-is 99/227/200/213 -> 98/225/202/212. Options label updated.

## v0.55 (19ac74b) — skin proportion option visible again
- User: hand shape odd, skin vs MediaPipe size. Rotations are copied, so overall size is not the problem; proportions (finger lengths, knuckle/root positions) are. The fitHand button existed but was never added to the layout (and its label claimed on while main.js fitOn defaults off), so fit was always off.
- Options button '스킨 비율: 내 손에 맞춤 / 모델 그대로' (prefs fit, default off). Fit on (hv/errtest3.cjs FIT=1): err n49_sw/fbx1/nat1/u4 24.2/18.9/32.2/42.9 -> 14.6/5.5/19.2/27.2 % palm; live jumps 39/145/128/145 -> 49/139/143/182. Saved GLB keeps model proportions (screen != GLB with fit on); bakeFitted exists for a fitted model.

## v0.56 (add8531) — FBX 21 joints: no back bend
- User: MediaPipe's own rig goes past the back of the hand. Counted on raw world points (knuckle-line axis): joints bent back > 5 deg = 5-27 % (n49 MCP/PIP/DIP 6/11/7 %, u4 23/25/27 %). (A palm-normal axis wrongly reads curled DIPs as back: 50 %.)
- HandFix.kt noBackBend on the world points the FBX is built from (MainActivity startModel snapshot): fingers about knuckle line, thumb MCP/IP across the palm; < -35 mirrored forward, else >= 5; rest of finger rotated about the joint. Python twin hv/handfix.py: back joints -> 0, lengths exact; point moves > 1.5 cm/frame 170/833/474/288 -> 249/868/585/467 (clamp-only variant 228/853/562/456). Picture overlay is 2D (back bends are depth only, invisible there).

## v0.57 (2740739) — FBX whole-take clean
- User asked for the before/after-frames fix. Median of joint flex over time did NOT lower point jumps (hv/handfix2.py, R 1-3); smoothing positions relative to the wrist was worse (MP world origin is the hand centre, wrist jitters).
- HandFix.cleanTake: per hand run (gap > 0.3 s splits): per-frame noBackBend -> per-point median +-2 frames -> Gaussian sigma 0.12 s (absolute world points) -> noBackBend again. hv/hf4.py: moves > 1.5 cm/frame raw 170/833/474/288 -> 29/77/184/278, back 0, mean shift 0.5-1.0 cm. Applied in startModel before RawFbx.encode.

## v0.58 (592a51f) — rig point check + first-use step guide
- User GLB (gauntlet2 mesh) had collapsed rig points (finger segments 0.01-0.27 palm, 85 % verts on the wrist bone). Tap placement already used the mid-thickness (ray entry/exit midpoint), so bad points come from arrow drags / one-view picks.
- rig.js: 완료 first runs checkHand (segment < 0.12 palm, pairs < 0.06 palm, point outside the mesh by 6-ray parity unless a surface is within 0.1 palm); shows a red list, button becomes "그래도 완료" (second press finishes); moving a point resets. window.lastRigCheck for tests. Test hv/rigcheck.cjs: good g1 points 0 warnings; collapsed points 14 (13 short + 1 outside), second press closes.
- MainActivity: step bar (1 스킨, 2 리깅, 3 편 손, 4 측정, 5 저장) + guide text + main/alt button under the status; steps advance on model load (ok -> 3, no bones -> 2), rig done, calibration, record stop; any step tappable. Old buttons and options unchanged. Not phone-verified.

## v0.59 (98df380) — hand rig = 11 points
- User: hand-placed joints make the GLB joints bend wrong. Editor now asks only wrist + 5 roots + 5 tips; middle joints go on the root->tip line at 0.44/0.72 (thumb 0.35/0.67; ratios from the two hand-rigged gauntlets, whose fingers are 0.97-1.0 straight), then centred in the finger thickness by 2 cross rays. A middle joint tapped/dragged by hand is kept (saved rigs keep theirs). hv/autotest.cjs: auto vs hand-placed mean 4.5 % (g1) / 3.0 % (g2) palm, thumb 7-10 %. Not phone-verified.

## v0.60 (caa11ef) — finger mode: MediaPipe angle copy (default)
- User: rig points (own or external) never match MediaPipe exactly; a few joints of mismatch twist grasp/open. Cause: direction mode (HMS_PURE=3) aims bones at MediaPipe's directions, so bends happen about MediaPipe's axis, not the model's hinge. Rules mode bends about the model hinge but DIP = 2/3 PIP.
- Angle copy = rules with HMS_NOCOUPLE (window.setFingerMode 0 rules / 1 angle / 2 directions; Kotlin pref fingerMode, old pure pref -> 2). n49 fist knuckle/mid/end MP vs model: index 58/80/69 -> rules 59/79/53, angle 59/79/60; pinky 73/81/88 -> 68/78/52 / 68/78/81. Jumps>15 n49/fbx1/nat1/u4: rules 39/145/128/145, angle 60/187/146/172, directions 98/225/202/212. Not phone-verified.

## v0.61 (4a4f16f)
- Rig guide panel shows only the 11 tap points (middle joints hidden); prev/next and 완료 count over those 11.

## v0.62 (df5295b) — 16:9 game-screen check
- Guide steps now 1 스킨 2 리깅 3 편 손 4 측정 5 재생 6 가로 7 저장. Step 6: SENSOR_LANDSCAPE (manifest configChanges keeps the activity), only the skin view letterboxed to 16:9 (main.js wideView), corrected take looping. Game camera (main.js gameCam): engine presets Unreal 90 h / Unity 60 v / Blender 39.6 h (50 mm on 36 mm), FOV +-5, hand distance +-0.05 m; mean wrist of the take placed at (0.2 right, 0.17 down, 0.45 ahead). Prefs gameEngine/gameFov/gameZ. Headless renders hv/widetest.cjs. Not phone-verified.

## 2026-11-03 quest.html (Quest teacher step 1)
- Web repo root quest.html (Pages yonddu.github.io/3d-hand/quest.html): Quest Browser WebXR (immersive-ar passthrough, else vr), hand-tracking required, local-floor. Records <=60 fps: 25 joints [px,py,pz,qx,qy,qz,qw,radius] per hand + head pose + wall clock; pinch marks (thumb-index tip <1.5 cm close, >3 cm open) for phone sync; JSON download on session end (Meta button), format hms-quest-hands-1. Recording list doc https://claude.ai/artifact/X9vEFmKnj3Rur4MtaGiPhr. Not tried on a Quest yet (container cannot reach Pages).

## v0.63 (d796dec) — landscape app
- User: portrait awkward, game is landscape. Manifest sensorLandscape; mainCol horizontal: stage left, 300 dp scrolling side column (title, step bar 2-line labels, status, guide, buttons vertical). Step 6 = hide side column + 16:9 game cam (no rotation). Rig editor landscape: ui right 300 px, guide top-left, camera.setViewOffset(+150 px). Camera analysis/video follow display rotation (existing code). Not phone-verified: check picture orientation and skin direction first.
- v0.64 (67de522): user wanted buttons at the bottom: step bar top, view middle, bottom row = guide text + guide buttons + record/review/cal/options; rig editor compact bottom bar (13 px buttons), view offset removed.

## v0.65 (f17d0fc) — rig skin weights along the skin
- User: auto weights break the hand graphics. Old rig.js weights = straight-line nearest bone segment, blend max(0.06 palm, 0.5 * nearest): far forearm skin (nearest ~3 palm) blended onto finger bones, so a fist bent the forearm; skin leaked across finger gaps.
- hand-view/weights.js surfaceWeights (used by buildSkeleton + bindBones): vertices welded by position (UV seams), each starts on its straight-nearest bone, distance to other bones = Dijkstra over mesh edges from that bone's seeds; blend capped 0.25 palm; bones unreachable over the skin = straight + 0.5 palm. window.HMS_OLDWEIGHT = old method (tests only), window.lastWeights = stats/ms.
- Gauntlet v1 / v2 (unrig_g1 + g1_pts, gauntlet2 stripped + its pts), fist edges stretched/squashed >1.5x: 5.66/2.87% -> 3.16/1.55%, worst 73x/89x -> 12x/9x; cross-finger weights 14.0/4.2% -> 1.7/0.4%; same with 5-10% point noise. A see-through (ray) seed test was tried: v2 fist 6.4% (layered plates hide the bones), dropped. ~0.2 s per 21k-vertex mesh desktop. Test bench scratchpad wt/ (entry.js runTest, run.cjs, shot.cjs). Image project-files native/v0.65-surface-weights.png. Built-in hand_model.glb (autorig build.py) unchanged. Not phone-verified.
- quest.html v5 (38b4f32): user saw points briefly behind the browser window; minimising it showed the panel, then the take ended and the browser came back. Fix guesses (not verified on a Quest): canvas appended to the page, name input blurred before requestSession (focused text box may keep the keyboard/browser in front), pagehide no longer ends the session, "VR로 시작" button (immersive-vr), session.visibilityState log (panel, status after save, JSON "visibility"). IWER: 225 frames / 6 s, 3 pinches, 0 errors.
- quest.html v6 (f830635): head-following panel (frames, hands, input sources), VR grid + cube. User: browser window returns right after entering VR in both our page and the official three.js webxr_vr_handinput example -> Quest/browser side. Asked user to reboot, set boundary, clear notifications/site data, update; fallback native Quest APK recorder.

## Quest hand recorder q0.1 (native f3c8f4a, CI run 42382425873 PASS, artifact 13578610506)
- Browser WebXR unusable on the user's Quest (session pushed to background, also three.js example). native/quest: C++ NativeActivity + Khronos OpenXR loader 1.1.61 (Maven prefab), XR_EXT_hand_tracking 26 joints, XR_FB_passthrough, GLES3 points. Writes /sdcard/Download/quest-hands-*.jsonl (header + frame lines <=60/s + index-tip touch marks + focus events). Workflow .github/workflows/quest-android.yml. Compiles in CI; NOT device-verified (no headset here).

## 2026-11-08 finger limit removal check (native angle-copy mode, not shipped)
Test flag HMS_NOLIMIT (patch only, scratchpad nolimit.patch) skipped MCP/PIP/DIP min/max, backfix, side limit. gauntlet2, takes n49/fbx1/nat1/u4 (_sw):
- jumps >15 deg/frame total: limits on 775, off 894 (+15%), off + thumb limits off 898, MCP -30 deg back allowed 810 (+5%).
- distance to MediaPipe's own points (% palm) mean: 22.8/23.3/32.8/46.3 -> 20.8/22.8/31.6/39.5 (MP is not truth).
- readings the limits act on: MCP bent back >20 deg 66/4/51/64% (fbx1/n49/nat1/u4), middle joints back >20 deg 21/1/17/11%, middle joints past 115 deg u4 27%.
Kept limits; thumb limits change almost nothing.

## v0.66 (c9580e0, code 68): body mode + body model without recognised body bones opens the body rig screen (guide rig step too); rig example panel 76 px left. CI run 42431657674 passed, artifact 13598175888. Not phone-verified.

## 2026-11-08 open palm looks awkward (user) - findings, nothing shipped
- Thumb: open-hand MP reads thumb MCP/IP median -9..+4 deg (55-100% below +5). HMS_THUMBMIN=-25: thumb tip err 37->34/52->48/63->60, jumps same. Decision card posted.
- Main cause: backfix (joint read >35 deg back, MCP >55) flips open-hand back reads into curls (fbx1_sw frames 253/255; open index DIP 35 vs MP 34->9 without). HMS_NOBACKFIX: jumps 775->419 but fists open (fbx1 fist index 65->12).
- Tried picture rule (tip projected past knuckle t>1.3/1.6 => no flip, patch scratchpad backctx.patch): fbx1 open fixed, nat1/u4 fist folds drop (u4 ring 93->23 at 1.3). Not kept. Asked user for an open/close palm take.

## v0.67 (8838ec1, code 69): THUMB_MIN_DEG +5 -> -25 (user card: thumb may open 25 deg toward back). CI 42444592816 pass, artifact 13602883796. Not phone-verified. Backfix open-vs-fist rule still open (needs user open/close palm take).

## 2026-11-08 Quest pair1: first real ground truth
Quest q0.1 installed via phone + Bugjaeger (PC USB failed). File: Quest browser can't see app-created Download files; shell `cp` to .txt fixed it.
pair1 = quest-hands-20261108-235035.jsonl (123.6 s, 36 fps, both hands) + phone video KakaoTalk_20261109_000604335.mp4 (1080p30, 125.8 s, top-down desk). Index-touch marks were before the video, so sync by hand-openness cross-correlation: video t = quest t - 2.70 s (corr 0.91). Files + scripts: /mnt/project-files/hand-motion-studio/quest/pair1/.
Finger bend error vs Quest (14 joints x 2 hands, ~3450 frames): MP raw signed 24.0 deg, app v0.67 (angle copy, gauntlet2) 19.8 (corr 0.55, >30 deg 22%). Variants: NOBACKFIX 19.5, BACKCTX 1.3/1.6 19.5/19.6, NOLIMIT 20.1, MCPBACK 19.8, PURE 20.7. Rules are not the bottleneck; next = more pairs + learned correction (target <=10 deg).

## 2026-11-09 Quest pair2 (6.5 min) + v0.68 learned finger bends (native 9bade34, code 70)
pair2 = quest-hands-20261109-010459.jsonl + KakaoTalk_20261109_012036291.mp4 (393.7 s), video t = quest t + 5.57 s. Files /mnt/project-files/hand-motion-studio/quest/pair2/. MP raw 27.1, app v0.67 21.3, NOBACKFIX 20.4.
Correction model (scripts + model: /mnt/project-files/hand-motion-studio/quest/corr/): MLP 137-128-128-14 (gelu tanh) from MP world points (palm-frame points + bones + 14 angles, left mirrored, turn-free) to Quest signed bends. Trained on ALL pair2 (choices on pair2 80/20 time split), tested once on pair1: 6.6 deg (>30 deg 1.7%, corr 0.93); constant pose 25.3, per-joint linear 20.9, ridge 8.2.
v0.68 app: hand-view/fingercorr.js(+.json, 0.2 MB) runs per hand on the RAW world points (filtered points 12.8 vs raw 11.1 on pair2); custom.js angle copy uses the learned bend for finger MCP/PIP/DIP (skips backfix) and thumb MCP/IP size (seen plane). Limits (minR 5, MCP 100, PIP/DIP 115, thumb -25) unchanged. HMS_NOCORR = old. pair1 in app: record 19.0 -> 11.4, live 19.4 -> 11.7 (thumb 16, MCP 14, PIP 8, DIP 10), >30 deg 20% -> 8%. Jumps 4 old takes 779 -> 376.
Tried, not kept: model wrist->knuckle tilt on MCP (17.1 -> 17.3), signed thumb about palm-fold axis (13.4 -> 14.9). Gap model 6.6 vs app 11.4: Quest truth bends BACK often (index MCP <0 in 31% of frames, DIP 9-25%), user rule forbids back bends (test flag HMS_CORRBACK: MCP -30 / PIP-DIP -20, not measured: app bends are unsigned). Raw 21-joint FBX (HandFix.kt) does not use the model yet. Caveat: one person, one desk setup, Quest itself is camera-based.

## v0.69 (220f3b0, code 71) + v0.69.1 (541a60b, code 72), 2026-11-09
- User reported "skin + rig gone" after v0.68: was a Meshy download picked as .zip (user's mistake). v0.68 page loads the same on PC (h67 vs h68 identical for unrig_g1.glb and the new Meshy FBX: "no bones" -> rig step).
- v0.69 rig.js: green arrow out of the palm (right hand = +z of wrist/index/middle/pinky frame, left = -z, same as custom.js palmSign), side button renamed "손바닥 방향 뒤집기 (지금: 왼손/오른손)"; test hook rigEditor.view. Image project-files native/v0.69-palm-arrow.png.
- v0.69.1 MainActivity + ModelKind.kt: model kind from first bytes (glTF / Kaydara FBX Binary / text FBX / glTF JSON / PK zip), extension fixed if missing; zip gets its own message. ModelKindTest. User: FBX not even listed in the Android picker (only GLB) -> told to browse ☰ -> storage -> extracted folder (picker Recent/Downloads views skip extracted files). CI 42562703345 pass, artifact 13650530392. Not phone-verified.
- User's new model: Meshy_AI_Steampunk_Gauntlet_20261109 (FBX 5 MB, no bones, textures as separate PNG).

## v0.70 (32d14ee, code 73), 2026-11-09: hand rig forearm bone
User: Meshy steampunk gauntlet (reaches to elbow, no bones) - "arm flies about". buildSkeleton made hand bones only, so the sleeve turned with the wrist. rig.js elbowOf(): skin reaching > FORE_MIN 1.2 palms behind the wrist (against wrist->middle root) -> <Side>ForeArm bone at 0.92 of the way to the middle of the far end; hand is its child; forearm segment in skin weights. custom.js findForearm/firstPersonElbow then hold the sleeve. Saved rigs rebuild it on model reload. g1 unrigged + g1_pts, take nat1, frames 20+: sleeve turn/frame mean 6.2 -> 5.0, p95 17.9 -> 14.3, >15 deg 9 -> 4 (scratchpad hv/fa/sleeve.py). HMS_NOFOREARM = old. CI needed 5 attempts (Gradle / Kotlin download 504), artifact 13654857203. Not phone-verified.

## v0.71 (native 1339c0f, code 74), 2026-11-09: steady forearm for any model
User (v0.70, Meshy steampunk gauntlet g3.fbx): arm "flies away and comes back" every hand turn; must not depend on the model. Measured on the user's own points (pose.glb IBMs, mesh space -> model space (100x, 100z, -100y)): auto elbow was 5.1 palms from the wrist (sleeve ~5.8 palms), and the forearm took the hand's FULL roll (R = setFromUnitVectors(was, fd) * Wq): twist up to 32 deg/frame, the main part; swing only up to 7 deg. Fix, both general (not per model):
- rig.js elbowOf: elbow at most ELBOW_MAX 2.8 palms from the wrist (direction to the far-end centroid); sleeve beyond rides the forearm bone. HMS_LONGFORE = old.
- custom.js rollOf: forearm keeps FORE_TWIST 0.5 of the palm's roll about the forearm line (ref = medial direction carried from -z to fd by least turn, blind only for a forearm pointing at the camera; unwrapped vs inst.lastRoll, within +-270 deg). Applies to every model with a forearm bone. HMS_FULLTWIST = old.
Numbers (scratchpad hv/fa/elbow.py, takes nat1/u4/fbx1/n49, frames 20+): user model sleeve turn >15 deg/frame 17 -> 1, twist max 32/31/25/10 -> 16/14/12/5 deg, elbow max move 0.57 -> 0.38 palms (nat1); rigged gauntlet2 >15 deg 4 -> 1. No visible wrist candy-wrap in shots. Rest pose question (user): palm frames from both point sets cancel any start-angle difference, fingers are absolute palm-frame angles, so a rest offset gives a constant tilt, not per-turn jumps. Remaining: very long sleeves still swing past the elbow (an upper-arm bone would fix). Not phone-verified.

## v0.72 (native d28bb2f, code 75), 2026-11-09: FBX save gets the learned finger model
User (v0.71 FBX hand-native-*.fbx): "still whips around, thumb barely moves". The native "FBX 저장" button = RawFbx: MediaPipe world points through HandFix.cleanTake (rules + median/Gaussian), a separate path from the app view/GLB (custom.js) - v0.68 model and v0.70/71 forearm never reached it (FBX has no arm). Now:
- FingerCorr.kt: same MLP as hand-view/fingercorr.js, weights app/src/main/resources/fingercorr.bin ('FCR1' header, f32), matches Python 1e-10 deg.
- HandFix.setBends: each joint turned (in its bone plane; nearly straight: set axis, then a 2nd in-plane pass) to the Quest-style bend (angle between bones, sign cross.(P5-P17), thumb sign opposite to fingers, left opposite to right). corrected() = setBends(model) then noBackBend; HandFix.useModel flag.
- noBackBend thumb MCP/IP: min -25 deg (user v0.67 rule), never flipped (Quest thumb IP p5 -47).
- mendLabels: a <=3-frame run of one side while the other side is missing there and present >= 2x around it (+-10 frames) is dropped; gaps <= 0.3 s filled linearly (user FBX: 1-frame RightHand at frame 184 = 6.13 s).
Held-out Quest pair1, real Kotlin cleanTake (compiled locally with /opt/gradle-8.14.3/lib kotlin-compiler-embeddable, scratchpad fbxfix/Check2.kt): bend error 20.2 -> 9.5, thumb MCP 17.3 -> 6.2, thumb IP 32.5 -> 11.2, fingers 19.5 -> 9.6, >30 deg 22.8% -> 4.7%, points >1.5 cm/frame 229 -> 121. Thumb rules alone don't help (min -25 without model 20.6). Test FingerCorrTest (3). CI run 42599545836, artifact 13665660921. Not phone-verified.
Open: user FBX whole hand turns 120 deg (3.7-4.0 s) and 150 deg in 0.17 s (6.0 s, same moment as the label flip) - asked the user whether they really flipped the hand. Palm/back confusion rules looped before (improve/19, 21); better = Quest takes with hand flips to learn wrist orientation.

## v0.73 (native 81fe691, code 76), 2026-11-09: GLB root in the model's units
User GLB hand-anim (v0.72, Meshy g3 rig, 16 s): "the arm spins". Wrist box 0.1 palm over the take while the elbow travelled 18 palms: custom.js snapshot() added the scene's metres (hand ~0.3-0.5 m from the camera) to model units unconverted, so a cm model (FBX, mesh scale 100) kept the hand nailed and the forearm swung about it (per-frame turns were small, max 5 deg - it was the whole path). Root position is now pos / scale (model units, real distance at model size), applySnapshot = p * scale. HMS_OLDROOT = old. g3 on nat1: wrist travel box 0.1 -> 3.2 palms, elbow max 0.38 -> 0.25 palm/frame (u4 0.30 -> 0.16). Models in metres were unaffected (scale ~1). Measure tool: scratchpad hv/fa/elbow.py (SPAN=1 travel, DEC=1 swing/twist).

## v0.74 (native 68c1c9f, code 77), 2026-11-09: fist thumb contact on finger joints
User: in a fist the thumb doesn't come down toward the palm far enough to wrap index/middle. No angle limit was the cause (HMS_NOTHUMBLIM / NOTHUMBBACK: no change). Fist thumb bends (n49_sw, gauntlet2) MP 47/41/56 (CMC/MCP/IP) -> app 52/37/32; the model's thumb IP is small in fists (Quest |IP| in fists mean 27; note Quest thumb IP sign vs MP is unreliable: corr -0.1..-0.2, the lat-based sign is ill-defined for the thumb; app uses |cv|). MediaPipe's thumb tip in fist frames lies over index PIP 27, middle PIP 27, index DIP 19 of 90 (fingertip 1), but touch() only used fingertips. Now contact points = PIP, DIP, tip of each finger, TOUCH_IN/OUT 0.3/0.38 (was 0.2/0.28). n49 fist frames: thumb tip off from MP-relative spot mean 0.61 -> 0.39 palm, p90 1.70 -> 0.70 (scratchpad hv/touchtest.cjs). 4 takes errtest3 jumps 361 -> 370 (+2.5%), picture error same/lower. HMS_TIPTOUCH + HMS_TOUCHIN=0.2 = old. Not phone-verified. Better route: Quest takes with fists to learn the thumb.
