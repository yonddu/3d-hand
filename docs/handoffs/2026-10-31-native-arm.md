# 2026-10-31 — 네이티브 v0.9: 손목·아래팔·위팔 뼈대 (Claude)

## 요청
사용자: "지금 리깅이 손만 되는데 전처럼 팔목이랑 팔까지 나오게 해야함. 메타퀘스트 손은 그냥 없는걸로." GitHub에 바로 올리고 APK 링크 요청.

## 한 것 (브랜치 codex/native-s25-baseline, PR #2 draft, main 미병합)
- `ArmRig.kt` 새로 추가. 원본 MediaPipe 21점은 바꾸지 않음.
  - 손 배치: 손의 world 점(미터)을 화면 점에 맞도록 평행이동만 최소제곱으로 구함. 시야각 66°(긴 변) 가정 = 웹 `src/camera.js`와 같음. 깊이 0.12~1.5 m 밖이면 가장자리로 고정.
  - 어깨: 1인칭 고정 위치(카메라 기준 옆 0.18, 아래 0.24, 뒤 0.06 m) = 웹 `ArmRig`.
  - 팔꿈치: 2관절 IK(위팔 0.29, 아래팔 0.26 m = 웹 `armMesh.js`). 굽는 방향은 손목 뒤로 손 방향을 이은 쪽. 손목이 닿지 않으면 어깨가 따라감(웹 shrug와 같은 규칙).
  - 포즈 모델·스무딩·회전 제한 없음. 웹의 손목 가동 범위 제한·팔 사전(armPrior)은 아직 옮기지 않음.
- 화면: 주황색 아래팔·위팔 선(카메라 뒤쪽은 잘림). 손 점·선은 그대로.
- FBX: `LeftArm`→`LeftForeArm`→`LeftHand`(=손목)→손가락. 양손 46관절 위치 애니메이션. 손이 안 보이면 Arm 스케일 0.
- JSON 기록에 프레임별 `imageWidth/imageHeight` 추가.
- versionCode 9, `0.9-native-arm`.

## 검증
- 코드 커밋 `25b7001` (첫 커밋 ed4b89b는 Kotlin null 타입 오류로 빌드 실패, 고침).
- [Android CI run 41218395930](https://github.com/yonddu/3d-hand/actions/runs/41218395930): 빌드·JVM 테스트(팔 길이·IK 테스트 추가)·Lint·ufbx 독립 재읽기 PASS, 46관절, 최대 위치 오차 2.34e-08 m(파일 직렬화 정확도일 뿐).
- [APK ZIP](https://github.com/yonddu/3d-hand/actions/runs/41218395930/artifacts/13049166379), 17,233,963 bytes, 2026-11-14 만료. 풀면 app-debug.apk.
- 실제 폰에서 팔 모양이 자연스러운지는 사용자 확인 전.
- 팔은 보이지 않는 부분을 계산한 추정이다. 실제 팔꿈치 위치라고 말하면 안 된다.

## 같은 날 main
- `data/takes/`에 빠져 있던 raw_take*.json 18개 추가(93a5fff). 저장소 폴더로 `node tools/regress.mjs data/takes/` 전체 41 테이크·30 문제 통과, held-out 2개 포함.
