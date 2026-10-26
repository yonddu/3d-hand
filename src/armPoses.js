// Whole-arm pose dictionary: shoulder -> elbow -> forearm twist -> wrist ->
// hand shape, as joint angles a game rig can use directly.
//
// Each entry pairs an arm posture with a hand shape from the gesture
// dictionary (gestures.js), so the wrist is never authored on its own: the
// hand sits where the forearm puts it. Angles are kept inside the clinical
// range the app uses (skeleton.js / arm.js); the wrist is clamped to its
// elliptical range, so flexion and deviation cannot both be at their limits.
//
// Angles in degrees:
//   sFlex   shoulder flexion (0 arm hanging, 90 forward, 180 overhead;
//           negative: the arm swung back, elbow behind the body, to -50)
//   sAbd    shoulder abduction (out to the side)
//   hRot    humeral rotation (+ internal: the forearm swings toward the body)
//   elbow   elbow flexion (0 straight .. 150)
//   pron    forearm rotation (+ pronation: palm down; - supination: palm up;
//           0: thumb up when the forearm points forward)
//   wFlex   wrist flexion (+ toward the palm, - extension)
//   wDev    wrist deviation (+ radial, toward the thumb; - ulnar)
import * as THREE from 'three';
import { UPPER, FORE } from './armMesh.js';
import { sideSign } from './skeleton.js';
import { MOTIONS, MOTION_CATEGORIES, expandMotion } from './armMotions.js';

export const ARM_ROM = {
  sFlex: [-50, 180], sAbd: [0, 150], hRot: [-70, 80], elbow: [0, 150], pron: [-80, 80],
  wFlex: [-60, 70], wDev: [-35, 20],
};
const WRIST = { flex: 70, ext: 60, radial: 20, ulnar: 35 };

// [id, name, category, hand gesture id, sFlex, sAbd, hRot, elbow, pron, wFlex, wDev, note]
const RAW = [
  // --- 생활 ---
  ['a-reachDown', '앞으로 뻗기 (손바닥 아래)', 'armDaily', 'hs-openB', 75, 5, 0, 20, 80, 0, 0],
  ['a-reachUp', '앞으로 뻗기 (손바닥 위)', 'armDaily', 'grip-flat', 75, 5, 0, 20, -80, 0, 0],
  ['a-shake', '악수 내밀기', 'armDaily', 'hs-openB', 40, 5, 0, 50, 0, 0, 0],
  ['a-watch', '손목시계 보기', 'armDaily', 'hs-S', 35, 10, 45, 110, 80, -10, 0],
  ['a-drink', '컵으로 마시기', 'armDaily', 'dl-cup', 40, 15, 25, 135, 10, -20, 5],
  ['a-knock', '노크하기', 'armDaily', 'dl-knock', 60, 10, 10, 90, 10, 20, 0],
  ['a-pushDoor', '문 밀기', 'armDaily', 'dl-push', 80, 5, 0, 30, 80, -55, 0],
  ['a-knob0', '문고리 돌리기 (시작)', 'armDaily', 'dl-knob', 50, 5, 10, 70, 45, 0, 0],
  ['a-knob1', '문고리 돌리기 (끝)', 'armDaily', 'dl-knob', 50, 5, 10, 70, -40, 0, 0],
  ['a-drawer', '서랍 당기기', 'armDaily', 'dl-drawer', 45, 5, 0, 70, 0, 5, 0],
  ['a-key0', '열쇠 돌리기 (시작)', 'armDaily', 'grip-key', 50, 5, 10, 75, 40, 0, 0],
  ['a-key1', '열쇠 돌리기 (끝)', 'armDaily', 'grip-key', 50, 5, 10, 75, -30, 0, 0],
  ['a-flashFwd', '손전등 앞으로 비추기', 'armDaily', 'dl-flashlight', 70, 5, 10, 35, 10, 0, -10],
  ['a-flashDown', '손전등 발밑 비추기', 'armDaily', 'dl-flashlight', 55, 5, 10, 60, 10, 30, -25],
  ['a-phone', '휴대폰 화면 보기', 'armDaily', 'dl-phoneHold', 25, 10, 30, 110, -40, -20, 0],
  ['a-write', '글씨 쓰기', 'armDaily', 'gt-20', 20, 10, 45, 100, 70, -25, -10],
  ['a-hammerUp', '망치 들어 올림', 'armDaily', 'grip-power', 35, 10, 10, 110, 5, -35, 15],
  ['a-hammerDown', '망치 내리침', 'armDaily', 'grip-power', 45, 10, 10, 80, 5, 25, -30],
  ['a-throw', '공 던지기 준비', 'armDaily', 'grip-sphere', 90, 80, -60, 90, 0, -40, 0],
  ['a-wave', '손 흔들기', 'armDaily', 'g-wave', 60, 40, -30, 100, -10, 0, 0],
  ['a-beckon', '이리 와 (손바닥 위)', 'armDaily', 'g-beckon', 45, 5, 10, 90, -80, 20, 0],
  ['a-point', '가리키기', 'armDaily', 'g-point', 85, 5, 0, 10, 60, 0, 0],
  ['a-thumbsUp', '엄지 척', 'armDaily', 'g-thumbsUp', 40, 5, 10, 90, 0, 0, 0],
  ['a-mouth', '입 막기', 'armDaily', 'dl-mouth', 40, 15, 60, 140, -10, -10, 0],
  ['a-shade', '햇빛 가리기 (이마)', 'armDaily', 'dl-eyes', 85, 35, 55, 130, 80, 0, 0],
  ['a-wall', '벽 짚기', 'armDaily', 'dl-wall', 85, 5, 0, 15, 80, -55, 0],
  ['a-shelf', '머리 위 선반 잡기', 'armDaily', 'grip-power', 160, 10, 0, 10, 40, 0, 0],
  ['a-ladder', '사다리 오르기', 'armDaily', 'dl-rung', 120, 10, 0, 40, 80, 10, 0],
  ['a-rope', '밧줄 당기기', 'armDaily', 'dl-rope', 60, 5, 0, 90, 0, 10, -15],
  ['a-salute', '경례', 'armDaily', 'g-salute', 80, 70, 60, 140, 60, 0, 0],

  // --- 물속·몸 쓰기 ---
  ['a-swimReach', '수영: 뻗기', 'armBody', 'dl-paddle', 160, 10, 10, 10, 70, 0, 0],
  ['a-swimPull', '수영: 당기기', 'armBody', 'dl-paddle', 90, 20, 30, 90, 80, 10, 0],
  ['a-swimPush', '수영: 밀어내기', 'armBody', 'dl-paddle', 20, 15, 10, 30, 80, -20, 0],
  ['a-wade', '물 헤치며 걷기', 'armBody', 'dl-part', 35, 25, 10, 30, 60, -20, 0],
  ['a-nose', '숨 참고 코 막기', 'armBody', 'dl-nose', 40, 15, 60, 145, 20, 0, 0],
  ['a-help', '손 뻗어 구조 요청', 'armBody', 'dl-help', 150, 10, 0, 10, 0, 0, 0],
  ['a-feel', '어둠 속 더듬기', 'armBody', 'dl-feel', 80, 10, 0, 30, 70, -20, 0],
  ['a-guard', '얼굴 막기', 'armBody', 'hs-openB', 70, 20, 50, 115, 60, -15, 0],
  ['a-grabLedge', '난간·턱 붙잡기', 'armBody', 'dl-rail', 130, 15, 0, 25, 80, 10, -10],
  ['a-scoop', '물 떠 올리기', 'armBody', 'dl-scoop', 30, 10, 20, 100, -75, -10, 0],
  ['a-candle', '촛불 들고 걷기', 'armBody', 'dl-candle', 35, 10, 15, 100, 5, -5, 0],


  // --- 운동 (오른팔) ---
  ['s-pitchCock', '투구: 공 든 팔 (코킹)', 'armSport', 'sp-fourSeam', 90, 90, -80, 90, 0, -45, 0],
  ['s-pitchRelease', '투구: 릴리스', 'armSport', 'sp-fourSeam', 110, 80, -20, 30, 30, 20, 0],
  ['s-pitchFollow', '투구: 팔로스루', 'armSport', 'sp-fourSeam', 60, 20, 60, 40, 80, 30, -10],
  ['s-batLoad', '타격: 배트 든 자세 (오른손)', 'armSport', 'sp-bat', 45, 60, 20, 110, 30, -20, 15],
  ['s-batContact', '타격: 임팩트', 'armSport', 'sp-bat', 40, 15, 0, 40, -60, -10, -15],
  ['s-foreReady', '테니스 포핸드: 테이크백', 'armSport', 'sp-tennisEast', 30, 50, -40, 60, 30, -30, 0],
  ['s-foreHit', '테니스 포핸드: 임팩트', 'armSport', 'sp-tennisEast', 40, 20, 10, 30, 0, -15, -10],
  ['s-serve', '테니스 서브: 트로피 자세', 'armSport', 'sp-tennisCont', 100, 90, -70, 100, 20, -30, 0],
  ['s-shootSet', '농구 슛: 셋 포인트', 'armSport', 'sp-shoot', 100, 15, 0, 95, -10, -60, 0],
  ['s-shootRelease', '농구 슛: 팔로스루', 'armSport', 'sp-follow', 140, 10, 0, 15, 10, 60, 0],
  ['s-setBall', '배구 토스', 'armSport', 'sp-set', 150, 25, -20, 90, -10, -50, 0],
  ['s-spike', '배구 스파이크 임팩트', 'armSport', 'sp-spike', 165, 20, 10, 15, 40, 20, 0],
  ['s-bump', '배구 리시브', 'armSport', 'sp-bump', 40, 5, 30, 5, -70, -10, -15],
  ['s-golfAddress', '골프 어드레스 (오른팔)', 'armSport', 'sp-golfOverlap', 40, 5, 40, 10, 10, 10, -15],
  ['s-golfTop', '골프 백스윙 탑 (오른팔)', 'armSport', 'sp-golfOverlap', 90, 60, -60, 90, 0, -40, 15],
  ['s-boxGuard', '복싱 가드', 'armSport', 'ma-boxGuard', 30, 20, 50, 130, 10, 0, 0],
  ['s-jab', '복싱 잽 (뻗은 주먹)', 'armSport', 'ma-boxGuard', 85, 10, 20, 5, 80, 0, -5],
  ['s-hook', '복싱 훅', 'armSport', 'ma-boxGuard', 90, 80, 20, 90, 70, 0, 0],
  ['s-upper', '복싱 어퍼컷', 'armSport', 'ma-boxGuard', 50, 20, 30, 95, -50, 0, 0],
  ['s-karateChop', '수도 치기', 'armSport', 'ma-knife', 70, 40, 10, 20, 0, 0, -20],
  ['s-palmStrike', '장저 치기', 'armSport', 'ma-palmHeel', 85, 10, 0, 10, 60, -55, 0],
  ['s-archDraw', '활쏘기: 시위 당김 (오른팔)', 'armSport', 'ar-draw', 90, 90, 0, 150, 30, 0, 0],
  ['s-bowling', '볼링 릴리스', 'armSport', 'sp-bowling', 20, 5, 0, 10, -60, -20, 0],
  ['s-pushup', '푸시업 아래 자세', 'armSport', 'ex-pushupPalm', 30, 45, 40, 90, 80, -60, 0],
  ['s-pullup', '철봉 매달리기', 'armSport', 'ex-chalk', 170, 15, 0, 0, 80, 0, 0],
  ['s-benchTop', '벤치프레스 위', 'armSport', 'ex-overhand', 90, 75, 0, 5, 80, -20, 0],
  ['s-curl', '덤벨 컬 위', 'armSport', 'ex-dumbbell', 15, 5, 0, 140, -70, 0, 0],
  ['s-row', '노 젓기 당김', 'armSport', 'ex-row', 40, 20, 20, 110, 70, 0, 0],
  ['s-freestyleEntry', '자유형: 손 입수', 'armSport', 'ex-swim', 165, 15, 20, 15, 60, 0, 0],
  ['s-climbReach', '클라이밍: 홀드 잡기', 'armSport', 'cl-halfCrimp', 150, 20, 0, 30, 80, 0, 0],
  ['s-throwDart', '다트 던지기 준비', 'armSport', 'sp-dart', 80, 10, 0, 110, 30, -30, 0],
];

// Systematic coverage: forearm rotation x wrist positions (elbow 70, arm
// forward), and elbow bend x forearm rotation with a straight wrist.
const PRON = [-80, -40, 0, 40, 80];
const WRIST_SET = [
  [-60, 0, '신전 최대'], [-30, 0, '신전'], [0, 0, '중립'], [35, 0, '굴곡'], [70, 0, '굴곡 최대'],
  [0, 20, '요측'], [0, -35, '척측'], [-30, 15, '신전+요측'], [35, -25, '굴곡+척측'],
];
const pronName = (p) => (p === 0 ? '중립' : p > 0 ? `회내 ${p}°` : `회외 ${-p}°`);
for (const p of PRON) {
  for (const [f, d, label] of WRIST_SET) {
    RAW.push([`rom-${p}-${f}-${d}`, `${pronName(p)} · 손목 ${label}`, 'armRom', 'nt-relaxed', 60, 10, 0, 70, p, f, d]);
  }
}
for (const e of [0, 45, 90, 135]) {
  for (const p of [-80, 0, 80]) RAW.push([`elb-${e}-${p}`, `팔꿈치 ${e}° · ${pronName(p)}`, 'armRom', 'nt-relaxed', 45, 10, 0, e, p, 0, 0]);
}
// Dart thrower's motion: the wrist's natural path, extension with radial
// tilt to flexion with ulnar tilt (hammering, casting, pouring).
for (let k = 0; k <= 6; k++) {
  const u = k / 6;
  RAW.push([`dart-${k}`, `다트 던지기 경로 ${k + 1}/7`, 'armRom', 'grip-power', 50, 10, 10, 90, 0, Math.round(-45 + 100 * u), Math.round(15 - 45 * u), '신전+요측 → 굴곡+척측']);
}

// Movements: every key posture and the steps between (armMotions.js).
for (const [id, name, category, hand, keys, note] of MOTIONS) {
  const steps = expandMotion(keys);
  steps.forEach(({ angles }, i) => RAW.push([`${id}-${i + 1}`, `${name} ${i + 1}/${steps.length}`, category, hand, ...angles, note]));
}

export const ARM_CATEGORIES = {
  armDaily: '팔 자세: 생활 동작',
  armBody: '팔 자세: 물속·몸 쓰기',
  armSport: '팔 자세: 운동',
  armRom: '팔 자세: 관절 범위 격자',
  ...MOTION_CATEGORIES,
};

const clamp = (v, [a, b]) => Math.min(b, Math.max(a, v));

// Wrist flexion/deviation pulled inside its elliptical range.
export function clampWrist(flex, dev) {
  const lf = flex >= 0 ? WRIST.flex : WRIST.ext;
  const ld = dev >= 0 ? WRIST.radial : WRIST.ulnar;
  const r = Math.hypot(flex / lf, dev / ld);
  return r <= 0.98 ? [flex, dev] : [(flex * 0.98) / r, (dev * 0.98) / r];
}

// A pose within this many degrees on every joint of an earlier one with the
// same hand shape adds nothing (movements often pass through the same
// posture): it is left out, so the dictionary has no repeats.
const SAME = 3;
const kept = [];
const RAW_UNIQUE = RAW.filter((r) => {
  const same = kept.some((k) => k[3] === r[3] && k.slice(4, 11).every((v, i) => Math.abs(v - r[4 + i]) <= SAME));
  if (!same) kept.push(r);
  return !same;
});
export const RAW_ARM_COUNT = RAW.length;

export const ARM_POSES = RAW_UNIQUE.map(([id, name, category, hand, sFlex, sAbd, hRot, elbow, pron, wFlex, wDev, note]) => {
  const [f, d] = clampWrist(clamp(wFlex, ARM_ROM.wFlex), clamp(wDev, ARM_ROM.wDev));
  const arm = {
    sFlex: clamp(sFlex, ARM_ROM.sFlex), sAbd: clamp(sAbd, ARM_ROM.sAbd), hRot: clamp(hRot, ARM_ROM.hRot),
    elbow: clamp(elbow, ARM_ROM.elbow), pron: clamp(pron, ARM_ROM.pron), wFlex: Math.round(f), wDev: Math.round(d),
  };
  const entry = { id, name, category, hand, arm };
  if (note) entry.note = note;
  return entry;
});

const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);
const rad = THREE.MathUtils.degToRad;

// Scene-space joints for an arm pose, shoulder at S (camera at the eyes
// looking down -Z, +Y up). Returns { S, E, W, handQ } with handQ the hand
// frame (+Y fingers, +Z out of the palm, thumb +X on the right hand).
export function armPoseJoints(arm, side, S) {
  const s = sideSign(side);
  // Upper arm: hanging, swung forward (flexion), then out to the side.
  const R = new THREE.Quaternion().setFromAxisAngle(Z, rad(arm.sAbd) * s).multiply(new THREE.Quaternion().setFromAxisAngle(X, rad(arm.sFlex)));
  const u = new THREE.Vector3(0, -1, 0).applyQuaternion(R);
  // Bend direction: forward from the upper arm, turned about it by humeral rotation.
  const b = new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion().setFromAxisAngle(Y, rad(arm.hRot) * s)).applyQuaternion(R);
  const f = u.clone().multiplyScalar(Math.cos(rad(arm.elbow))).addScaledVector(b, Math.sin(rad(arm.elbow))).normalize();
  const E = S.clone().addScaledVector(u, UPPER);
  const W = E.clone().addScaledVector(f, FORE);
  // Forearm frame: +Y along the forearm, +Z the palm, neutral = palm toward
  // the body's midline (thumb up when the forearm points forward).
  const hinge = new THREE.Vector3().crossVectors(u, b).normalize();
  const palm = hinge.clone().multiplyScalar(-s);
  palm.applyAxisAngle(f, -s * rad(arm.pron));
  palm.addScaledVector(f, -palm.dot(f)).normalize();
  const x = new THREE.Vector3().crossVectors(f, palm);
  const fore = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, f, palm));
  // Wrist: deviation about the palm normal, then flexion about the thumb axis.
  const wrist = new THREE.Quaternion().setFromAxisAngle(X, rad(arm.wFlex)).multiply(new THREE.Quaternion().setFromAxisAngle(Z, -s * rad(arm.wDev)));
  const handQ = fore.clone().multiply(wrist);
  return { S: S.clone(), E, W, handQ, foreQ: fore };
}

export function armPoseData() {
  return {
    format: 'hand-motion-studio.arm-poses',
    version: 1,
    angles: {
      sFlex: 'shoulder flexion (0 hanging, 90 forward)',
      sAbd: 'shoulder abduction',
      hRot: 'humeral rotation, + internal',
      elbow: 'elbow flexion',
      pron: 'forearm rotation, + pronation (palm down), - supination; 0 thumb up with the forearm forward',
      wFlex: 'wrist flexion, + toward the palm, - extension',
      wDev: 'wrist deviation, + radial, - ulnar',
      units: 'degrees',
    },
    rom: ARM_ROM,
    wristRom: WRIST,
    hand: 'gesture id in hand-motion-studio.gestures',
    categories: ARM_CATEGORIES,
    poses: ARM_POSES,
  };
}
