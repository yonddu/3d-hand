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
