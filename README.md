# Hand Motion Studio (1단계 프로토타입)

스마트폰/웹캠 카메라로 양손(21관절 x 2)을 추적하고, 랜드마크를 **게임 캐릭터에 바로 쓸 수 있는 관절 회전(쿼터니언)** 으로 바꿔 Three.js 리깅 손 모델에 적용한 뒤, 포즈를 JSON으로 저장/불러오는 웹 앱입니다.

## 실행

빌드된 `index.html`과 `vendor/`(Three.js, MediaPipe wasm, 손 모델)가 모두 들어 있어 인터넷 없이도 돌아갑니다. 정적 서버로만 열면 됩니다.

```bash
npm install        # esbuild 등 개발 도구 (소스를 고칠 때만 필요)
npm run build      # app.html + src/ -> index.html, dist/artifact/
python3 -m http.server 8080   # 또는 npm start
# 브라우저에서 http://localhost:8080
```

- `file://`로 직접 열면 ES 모듈과 wasm이 막히므로 꼭 서버로 여세요.
- **스마트폰 카메라는 HTTPS에서만 열립니다.** 폰으로 쓰려면 GitHub Pages / Netlify / Cloudflare Pages 같은 HTTPS 정적 호스팅에 폴더째 올리거나, PC에서 `npx localtunnel --port 8080` 같은 터널을 쓰세요.
- 촬영: 폰을 거치대에 세우고 "후면 카메라"를 선택한 뒤 양손을 카메라 앞에 뻗습니다. 손에 왼손/오른손이 반대로 붙으면 "왼손·오른손 바꾸기"를 켜세요.

## 화면 구성

- **입력**: 데모(카메라 없이 가상 손 데이터를 같은 파이프라인에 흘림) / 카메라 / 동영상 파일
- **시점**: 1인칭(게임에서 보이는 손) / 카메라 시점, 마우스·터치로 회전/줌
- **관절 엔진**: 가동 범위 제한, 떨림 보정(One Euro min cutoff), 반응 속도(beta), 관절 점/원본 랜드마크 비교, 귀신 손 재질
- **관절 각도**: 손가락별 1~3관절 굽힘/벌림 각도(°)와 신뢰도
- **포즈**: 캡처(즉시 / 3초 타이머 / Space), 보기, JSON 저장, JSON 불러오기, 전체 내보내기. 목록은 브라우저 localStorage에 저장됩니다.

## 구조

```
app.html           화면 마크업 + CSS (build.mjs가 index.html로 감쌈)
src/
  skeleton.js      랜드마크 인덱스, 손가락 정의, 관절 제한, 기준 손 비율, 본 이름(Mixamo 규칙)
  tracker.js       MediaPipe Hand Landmarker (VIDEO 모드, 양손, GPU→CPU 폴백, 좌우 판정 정리)
  filters.js       One Euro 필터 (관절 떨림 보정)
  solver.js        랜드마크 → 본 회전 (손바닥 기준 좌표계, 굽힘/벌림 분해, 관절 제한, 신뢰도)
  handRig.js       절차적 리깅 손: THREE.Skeleton + SkinnedMesh, 포즈 읽기/쓰기
  demo.js          가상 손 동작 생성기 (편 손, 주먹, 가리키기, 브이, 귀신 손, 집기)
  pose.js          포즈 JSON 포맷, 로컬 라이브러리
  main.js          씬, UI, 프레임 루프
vendor/            three 0.170.0, @mediapipe/tasks-vision 0.10.21, hand_landmarker.task (float16)
build.mjs          index.html(독립 실행) + dist/artifact/(claude.ai 데모용) 생성
```

### 관절 회전 계산 방식 (solver.js)

1. 손목(0)·검지 MCP(5)·중지 MCP(9)·소지 MCP(17)로 손바닥 좌표계를 만들어 손목 회전을 구합니다. (+Y 손가락 방향, +Z 손바닥 법선)
2. 각 뼈마다 관측된 방향(자식 관절 − 관절)을 **이미 풀린 부모 뼈의 기준 자세 좌표계**로 옮깁니다.
3. 그 방향을 굽힘(로컬 X축 회전)과 벌림(로컬 Z축 회전) 두 각도로 분해하고, 해부학적 범위로 자릅니다. (예: 손가락 PIP 0~115°, 벌림 0°)
4. 비틀림 없는 회전으로 다시 조립해 `restLocal * swing` 형태의 로컬 쿼터니언을 만듭니다.
5. 뼈 길이가 기준값에서 갑자기 벗어나면(가림, 원근 왜곡) 신뢰도를 낮추고 그 뼈는 더 천천히 따라가게 합니다.

랜드마크 자체는 One Euro 필터로 먼저 떨림을 줄입니다.

### 포즈 JSON

```jsonc
{
  "format": "hand-motion-studio.pose", "version": 1, "name": "귀신 손 01",
  "skeleton": { "id": "hms-hand-v1", "naming": "mixamo", "units": "meters", ... },
  "hands": {
    "left": {
      "position": [x, y, z],              // 씬에서 손목 위치
      "wrist":    [x, y, z, w],           // LeftHand 회전
      "bones":    { "LeftHandIndex1": [x, y, z, w], ... },  // 로컬 회전 (바인드 회전 포함)
      "delta":    { "LeftHandIndex1": [x, y, z, w], ... },  // 바인드 자세 대비 회전 (리타게팅용)
      "angles":   { "index": [{ "flex": 39.6, "abd": -15.3 }, ...], ... },   // 사람이 읽는 각도(°)
      "landmarks": [[x, y, z], ...]       // 원본 3D 랜드마크 21개 (보정 전)
    },
    "right": { ... }
  }
}
```

본 이름은 Mixamo 규칙(`LeftHandThumb1..4`, `RightHandIndex1..4` …)이라 Mixamo 계열 캐릭터로 옮기기 쉽습니다. 뼈는 로컬 +Y 방향, 굽힘은 로컬 +X 회전입니다.

## 알려진 한계

- 손가락 비틀림(twist)은 계산하지 않습니다. 엄지 회전은 근사치입니다.
- 손목 위치의 깊이는 화면상 손 크기로 추정해 절반만 반영합니다.
- 리깅 손 비율은 성인 평균값 고정입니다. (사용자 손 길이 보정은 다음 단계 후보)
- 손가락이 서로 가리면 MediaPipe 3D 추정 자체가 흔들립니다. 신뢰도 표시와 가동 범위 제한으로 줄이지만 완전히 없애지는 못합니다.

## 다음 단계 후보

연속 모션 녹화 → 키프레임 편집 → GLB(AnimationClip) 내보내기 → 캐릭터 리타게팅.
