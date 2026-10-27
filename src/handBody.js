// The drawn and saved hand's own bones (the MIT hand model as realHand.js
// binds it to the rig, read from a saved GLB's skeleton): each finger's base
// from the wrist in the wrist bone's frame (+z toward the palm) and its three
// bone lengths, base to tip (m). The solid fingers (solver.js, fit.js) are
// kept apart on this shape, not on the solver rig's, which is longer in the
// palm and holds the thumb's base 14 mm further toward the back of the hand:
// walls on the rig let the model's thumb pass into the fingers.
// The two models are not exact mirrors (the left index is 3 mm shorter).
import * as THREE from 'three';
import { FINGERS } from './skeleton.js';

export const BODY = {
  right: {
    base: { thumb: [0.0246, 0.022, 0.0218], index: [0.021, 0.0741, 0.0078], middle: [0, 0.0767, 0], ring: [-0.0195, 0.0695, 0.0015], pinky: [-0.0377, 0.0586, 0.0065] },
    len: { thumb: [0.0325, 0.0338, 0.0149], index: [0.0453, 0.0243, 0.0116], middle: [0.0469, 0.0275, 0.0122], ring: [0.0429, 0.0266, 0.0119], pinky: [0.0346, 0.0203, 0.0119] },
  },
  left: {
    base: { thumb: [-0.0244, 0.022, 0.0219], index: [-0.0209, 0.0776, 0.0079], middle: [0, 0.0767, 0], ring: [0.0195, 0.0695, 0.0014], pinky: [0.0377, 0.0586, 0.0062] },
    len: { thumb: [0.0325, 0.0338, 0.0149], index: [0.0419, 0.0243, 0.0116], middle: [0.0469, 0.0275, 0.0122], ring: [0.0429, 0.0266, 0.0119], pinky: [0.0346, 0.0203, 0.0119] },
  },
};

// The model's 21 joints for a posed solver rig (its bones' turns on the
// model's bone lengths), in world space, MediaPipe order; for checking what
// is drawn (tools/replay.mjs).
export function bodyPoints(rig) {
  rig.group.updateMatrixWorld(true);
  const body = BODY[rig.side];
  const out = [rig.wrist.localToWorld(new THREE.Vector3())];
  for (const finger of FINGERS) {
    let p = new THREE.Vector3(...body.base[finger.key]);
    const pts = [p.clone()];
    const q = new THREE.Quaternion();
    rig.chains[finger.key].forEach((link, k) => {
      q.multiply(link.bone.quaternion);
      const child = rig.boneByLandmark[finger.joints[k + 1]].position.clone().normalize();
      p = p.clone().add(child.multiplyScalar(body.len[finger.key][k]).applyQuaternion(q));
      pts.push(p);
    });
    for (const v of pts) out.push(rig.wrist.localToWorld(v.clone()));
  }
  return out;
}
