# 22. 손가락 깊이 기울기를 영상 전체 경로로 고르기 (2026-10-27)

**요청.** 사용자·GPT 제안: 접힌 엄지가 갑자기 펴지거나 다른 손가락 앞뒤로 잘못 넘어가는 문제. 충돌로 밀어내지 말고, 잘못된 깊이 후보를 고르는 원인을 고치기. 녹화 후 경로, 앞뒤 프레임 사용.

**확인한 원인 위치.**
- lift.js: 손가락마다 뼈 3개의 앞뒤 기울기 조합 8개 중 하나를 **그 프레임에서 바로 확정**해요. 근거는 MediaPipe 3D(추정 z)의 굽힘과 기울기, 엄지는 엄지 끝-검지 거리, 그리고 직전 조합 유지 보너스(LEAN_KEEP 4)와 직전 부호(LEAN_LAST 0.3)예요.
- 그래서 근거가 반대쪽으로 조금만 기울어도 접힘이 펴짐으로 바뀌어요. 바뀐 다음에는 유지 보너스가 오히려 잘못된 쪽을 붙잡아요.
- 손바닥 방향은 이미 mirrorPlan.js가 영상 전체 경로로 골라요. 손가락에는 그런 처리가 없어요.
- fit.js는 lift가 고른 점들을 출발점으로 삼아요. 그래서 lift의 잘못된 선택이 fit까지 이어져요.

**바꾸는 것 (이것 하나만).**
- lift.js: 조합마다 그 프레임 근거의 비용과 관절 굽힘을 내보내요(out.leans). 유지 보너스는 빼고 내보내요.
- 새 leanPlan.js: 손가락마다 8개 후보로 비터비를 돌려요.
  - 프레임 사이 비용은 "두 후보의 관절 굽힘 차이"예요(LEAN_TURN 30도).
  - 그래서 거의 같은 모양의 후보끼리는 자유롭게 바뀌고, 접힘↔펴짐은 여러 프레임의 근거가 쌓여야 바뀌어요.
  - 18프레임 넘게 안 보이면 경로를 새로 시작해요.
- 리플레이는 손바닥 계획 → 손가락 계획 → 최종 순서로 돌려요. LEANPLAN=0이면 예전과 같아요.
- 앱 반영은 리플레이에서 효과가 확인된 뒤에 해요.

**예측 (측정 전에 씀).** 기준은 eval-depth.mjs의 최종 동작(cleanTake 이후)이에요.
- 가만있는데 펴짐(snap): 5개 사례 합계 36 → 20 안팎 (약 절반)
- 엄지 관통 프레임: 28 → 비슷하거나 약간 감소 (관통은 충돌 처리가 주로 막고 있어서)
- 사진에서 접힌 손가락이 펴짐(opened): 395 → 약간 감소
- 사진에서 곧은데 굽음(stuck): 245 → 비슷 (펴는 동작 지연 위험: 늘면 안 됨)
- 2D 오차(off2d): 그대로 (±0.003)
- fjump·jump: 감소
- 처리 시간: 리플레이 약 1.4배 (lift만 한 번 더)
- 전체 회귀(book-turn-bounce, swap, hpierce): 나빠지지 않음

## Result (2026-10-27 23:xx) — NOT KEPT (patch saved)

Five cases, finished motion (tools/eval-depth.mjs), base -> plan + thumb pass + THUMB_TOUCH 16 + motion-scaled Z_TURN 0.15:
snap 36 -> 17, tpierce frames 28 -> 20, pstill 82 -> 44, fjump 163 -> 101, stuck 245 -> 230, opened 395 -> 302 (thumb_track 86 -> 9), off2d same, topen up on several takes, 5-7 -> 10-15 ms/frame.
Real held-out (guard): jump 200 -> 59, fjump 33 -> 4.
Prediction (snap and thumb pierce down, held-out no worse) met on those, BUT dev regress: 16 limit failures (user1 clip copies fjump ~103/97, raw_take9 jump 202/194, cup_drag fjump 84/69, left_pop jump 57/45, two_hands gsw 51/50, book_floor fjump 13/12). The plan follows frame evidence and starts folds ~0.4 s before the old hysteresis did; no ground truth says which is right.
Tried: Z_TURN 0.1/0.25/0.4, flat switch cost 2/4/8 -> failures remain.
Isolation: plan alone made thumb pierce worse (28 -> 62 with bend transition) and 18 fails; touch cost alone (LEANPLAN=0, THUMB_TOUCH 4) snap 37, tpierce 19.
Limits may not be raised (spec), so reverted. Patch: /mnt/project-files/hand-motion-studio/patches/lean-plan-step2.patch. eval-depth.mjs kept.
