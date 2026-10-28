# Kalidokit 손가락 회전 계산 비교 (2026-10-26)

출처: Kalidokit 1.1.5 (https://github.com/yeemachine/kalidokit), MIT License, Copyright (c) 2021 yeemachine.
비교 대상: dist/HandSolver/index.js (HandSolver.solve, rigFingers).

## Kalidokit 방식
- 각 관절 굽힘 = 앞뒤 뼈 사이 3D 각도(acos) 하나. 부호 없음, 옆으로 벌림(외전) 없음.
- MCP는 손목-관절-다음관절 각도 (손바닥 뼈 축이 아님).
- 엄지는 그 한 값을 손으로 맞춘 배율로 3축에 나눠 넣음. 손목은 손바닥 세 점의 roll/pitch/yaw에 배율·제한값.

## 측정 (가상 개발용 seed1, 손가락 4개 x 3관절, 정답 각도와의 평균 오차)
| 방식 | 오차 | 접힌 관절(60도+) 치우침 |
|---|---|---|
| 우리 solver.js | 20.22 | -30.6 |
| Kalidokit (MediaPipe world) | 23.10 | -23.6 |
| Kalidokit (우리 lift 점) | 23.99 | -25.3 |

관절별: Kalidokit은 곧은 관절을 +22~30도 굽게 읽음 (부호 없는 각도라 잡음이 항상 굽힘으로 더해짐).
깊게 접힌 끝마디(DIP)만 Kalidokit이 나음: 오차 26.5 vs 우리 32.8.

## 좁은 후보 시험: 끝마디만, Kalidokit 값이 T도 이상이면 그 값 사용
T 50/60/70/80/90 -> 21.68 / 21.61 / 21.49 / 21.34 / 21.12. 모두 우리(20.22)보다 나쁨.

## 결론
가져올 부분 없음. 코드 변경 없음 (그래서 앱 코드에 들어간 Kalidokit 코드도 없음).
