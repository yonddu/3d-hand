// Native-only, stateless retargeting. No learned picture prior, constraints,
// temporal filters, collision correction or hidden-finger inference.
import * as THREE from 'three';
import { FINGERS } from './skeleton.js';
import { handFrameQuat } from './handRig.js';

export function unpackPoints(flat) {
  if (!Array.isArray(flat) || flat.length !== 63 || !flat.every(Number.isFinite)) return null;
  return Array.from({ length: 21 }, (_, i) => new THREE.Vector3(flat[i * 3], -flat[i * 3 + 1], -flat[i * 3 + 2]));
}

export function validNativeHand(h) {
  if (!h || !['left', 'right'].includes(h.label)) return false;
  const P = unpackPoints(h.world);
  if (!P || !Array.isArray(h.lm) || h.lm.length !== 63 || !h.lm.every(Number.isFinite)) return false;
  if (new THREE.Vector3().crossVectors(P[5].clone().sub(P[0]), P[17].clone().sub(P[0])).lengthSq() < 1e-12) return false;
  return FINGERS.every(f => f.joints.slice(0, -1).every((j, k) => P[j].distanceToSquared(P[f.joints[k + 1]]) > 1e-12));
}

export function retargetNative(rig, hand) {
  if (!validNativeHand(hand)) return false;
  const P = unpackPoints(hand.world);
  const wristQ = handFrameQuat(P, rig.side);
  rig.wrist.quaternion.copy(wristQ);
  rig.cup = 0;
  const Y = new THREE.Vector3(0, 1, 0);
  for (const f of FINGERS) {
    let parent = wristQ.clone();
    rig.chains[f.key].forEach((link, k) => {
      const rest = parent.clone().multiply(link.restLocal);
      const want = P[f.joints[k + 1]].clone().sub(P[f.joints[k]]).normalize();
      const swing = new THREE.Quaternion().setFromUnitVectors(Y.clone().applyQuaternion(rest), want);
      const global = swing.multiply(rest);
      link.bone.quaternion.copy(parent.clone().invert().multiply(global));
      parent = global;
    });
  }
  return true;
}

// Preserve labels from MediaPipe. Duplicate labels are ambiguous: retain the
// more confident reading, never invent a second side from screen position.
export function nativeHands(hands = []) {
  const out = {};
  for (const h of hands) if (validNativeHand(h) && (!out[h.label] || (h.score || 0) > (out[h.label].score || 0))) out[h.label] = h;
  return out;
}
