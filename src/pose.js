// Pose capture format + local pose library.
import { anglesFromRig } from './solver.js';

export const POSE_FORMAT = 'hand-motion-studio.pose';
export const POSE_VERSION = 1;
const STORAGE_KEY = 'hms.poses.v1';

export function capturePose(name, rigs, rawLandmarks) {
  const hands = {};
  for (const side of ['left', 'right']) {
    const rig = rigs[side];
    if (!rig.group.visible) continue;
    const p = rig.getPose();
    hands[side] = {
      position: round(p.position),
      wrist: round(p.wrist),
      // Local bone rotations (bind rotation included), quaternion [x, y, z, w].
      bones: mapValues(p.bones, round),
      // Same rotations relative to the bind pose: apply these on top of any
      // character hand whose bones follow the same axes.
      delta: mapValues(rig.getPoseDelta(), round),
      // Human-readable joint angles in degrees.
      angles: mapValues(anglesFromRig(rig), (list) =>
        list.map(({ flex, abd }) => ({ flex: +flex.toFixed(1), abd: +abd.toFixed(1) })),
      ),
      landmarks: rawLandmarks[side] ? rawLandmarks[side].map((v) => round([v.x, v.y, v.z])) : null,
    };
  }
  return {
    format: POSE_FORMAT,
    version: POSE_VERSION,
    name,
    createdAt: new Date().toISOString(),
    skeleton: {
      id: 'hms-hand-v1',
      naming: 'mixamo',
      units: 'meters',
      axes: 'right-handed, +Y up; bones point along local +Y, flexion = +X rotation',
    },
    hands,
  };
}

export function validatePose(obj) {
  if (!obj || obj.format !== POSE_FORMAT) throw new Error('Hand Motion Studio 포즈 파일이 아닙니다.');
  if (!obj.hands || (!obj.hands.left && !obj.hands.right)) throw new Error('파일에 손 데이터가 없습니다.');
  return obj;
}

export function applyPose(pose, rigs) {
  for (const side of ['left', 'right']) {
    const h = pose.hands[side];
    rigs[side].group.visible = !!h;
    if (h) rigs[side].setPose(h);
  }
}

// --- library (this browser only) ---------------------------------------------

export function loadLibrary() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function saveLibrary(list) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

function round(arr) {
  return arr.map((x) => +x.toFixed(5));
}

function mapValues(obj, fn) {
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, fn(v)]));
}
