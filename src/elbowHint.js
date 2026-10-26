// Where the elbow is, from what the camera saw: the body pose model's elbow
// or, failing that, the forearm's line in the picture (forearm.js). Shared by
// the app (main.js) and the take replay (tools/replay.mjs), which gets the
// same inputs from the recording, so a recorded arm can be replayed.
import * as THREE from 'three';
import { handFrameQuat } from './handRig.js';

export const POSE_ARM = { left: { shoulder: 11, elbow: 13, wrist: 15 }, right: { shoulder: 12, elbow: 14, wrist: 16 } };
const KEEP = [11, 12, 13, 14, 15, 16]; // shoulders, elbows, wrists
const WRIST_REST_EXT = 5; // degrees of wrist extension held without thinking (arm.js REST_EXT)
const HAND_LINE = 1; // share of the forearm direction kept from the forearm's own line (rest: toward the shoulder)

// The arm points of a pose result, small enough to keep with every frame.
export function compactPose(pose) {
  if (!pose || !pose.landmarks) return null;
  const r = (v) => Math.round(v * 1000) / 1000;
  return KEEP.map((i) => {
    const p = pose.landmarks[i];
    return [r(p.x), r(p.y), r(p.visibility ?? 0), r(pose.world[i].z)];
  });
}

export function expandPose(c) {
  if (!c) return null;
  const landmarks = [];
  const world = [];
  KEEP.forEach((i, k) => {
    const [x, y, visibility, z] = c[k];
    landmarks[i] = { x, y, visibility };
    world[i] = { z };
  });
  return { landmarks, world };
}

// First person: the elbow seen by the pose model, on its camera ray. Its
// place in the picture is reliable; its depth from one camera is not, so it
// stays near the wrist's distance.
export function poseElbowAR(pose, hand, wristDist, ray) {
  if (!pose || !pose.landmarks) return null;
  const ids = POSE_ARM[hand.side];
  const e = pose.landmarks[ids.elbow];
  const w = pose.landmarks[ids.wrist];
  const hw = hand.landmarks[0];
  if ((e.visibility ?? 0) < 0.5 || Math.hypot(w.x - hw.x, w.y - hw.y) > 0.2) return null;
  const dz = THREE.MathUtils.clamp(pose.world[ids.elbow].z - pose.world[ids.wrist].z, -0.08, 0.08);
  return ray(e).multiplyScalar(Math.max(0.1, wristDist + dz));
}

// First person: the forearm's line in the picture (f: { dir, confidence },
// forearm.js) fixes the forearm to a plane through the camera; within it,
// the depth slant is taken from the usual reach back toward the shoulder.
export function lineElbow(f, hand, world, anchor, ray, aspect, arm) {
  if (!f || f.confidence < 0.45) return null;
  const a = hand.landmarks[0];
  const along = ray(a).normalize();
  const next = ray({ x: a.x + f.dir[0] * 0.05, y: a.y + f.dir[1] * 0.05 * aspect }).normalize();
  const n = new THREE.Vector3().crossVectors(along, next).normalize();
  const across = new THREE.Vector3().crossVectors(n, along).normalize(); // in the picture, toward the arm
  if (across.dot(next.clone().sub(along)) < 0) across.negate();
  const guess = arm.homeShoulder.clone().sub(anchor).normalize();
  const reach = along.clone().multiplyScalar(guess.dot(along)).addScaledVector(across, Math.max(guess.dot(across), 0.35)).normalize();
  // The picture fixes the plane the forearm lies in, not where in it. Within
  // the plane keep the forearm where it already is: taking the hand's line
  // here (v40-v41) pulled the forearm after every wrist bend, so a bent wrist
  // never showed (user GLB: wrist flexion stuck at -5 deg).
  const held = arm.elbow.clone().sub(anchor);
  let pref;
  if (held.length() > 0.13 && held.length() < 0.39) pref = held.normalize();
  else {
    const q = handFrameQuat(world, hand.side);
    const ext = THREE.MathUtils.degToRad(WRIST_REST_EXT);
    pref = new THREE.Vector3(0, -Math.cos(ext), -Math.sin(ext)).applyQuaternion(q);
  }
  pref.addScaledVector(n, -pref.dot(n));
  const a1 = Math.min(pref.dot(along), 0.2); // the elbow is not much farther away than the wrist
  const c1 = Math.max(pref.dot(across), 0.35); // and runs toward the arm in the picture
  const lineDir = along.clone().multiplyScalar(a1).addScaledVector(across, c1).normalize();
  const dir = reach.lerp(lineDir, HAND_LINE).normalize();
  return anchor.clone().addScaledVector(dir, 0.26);
}
