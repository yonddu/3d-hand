// Landmarks -> bone rotations.
//
// For every bone we take the observed direction (child joint - joint), express
// it in the bone's rest frame under its already-solved parent, and decompose it
// into flexion (about local X) and abduction (about local Z). Clamping those
// two angles to anatomical limits and rebuilding a twist-free rotation gives
// joint data a game character can use directly, instead of raw points.
import * as THREE from 'three';
import { FINGERS, limitsFor, sideSign } from './skeleton.js';
import { handFrameQuat } from './handRig.js';

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const clamp = THREE.MathUtils.clamp;
const TOL_FLEX = 10; // degrees past a flexion limit still followed
const TOL_EXT = 5; // degrees of bending backward past the limit still followed
const MAX_ROLL = (20 * Math.PI) / 180; // knuckle axial rotation allowed
const TOL_ABD = 4; // degrees past a knuckle's side-bend limit still followed

const _q = new THREE.Quaternion();
const _qi = new THREE.Quaternion();
const _d = new THREE.Vector3();
const _e = new THREE.Euler();

export class HandSolver {
  constructor(rig) {
    this.rig = rig;
    this.refLen = {}; // running reference length per bone, for confidence
    this.smoothed = new Map(); // bone -> last output quaternion
  }

  reset() {
    this.refLen = {};
    this.smoothed.clear();
  }

  // P: 21 THREE.Vector3 in rig orientation (any origin, meters).
  // Returns per-bone angles and confidences and writes rotations to the rig.
  solve(P, { limits = true, smoothing = true } = {}) {
    const rig = this.rig;
    const side = rig.side;
    const wristQ = handFrameQuat(P, side);
    this.apply(rig.wrist, wristQ, smoothing ? 0.75 : 1);

    const angles = {};
    const confidence = {};
    for (const finger of FINGERS) {
      const chain = rig.chains[finger.key];
      let parentG = wristQ.clone();
      angles[finger.key] = [];
      confidence[finger.key] = [];
      chain.forEach((link, k) => {
        const a = P[finger.joints[k]];
        const b = P[finger.joints[k + 1]];
        _d.subVectors(b, a);
        const len = _d.length();
        const c = this.boneConfidence(link.bone.name, len);
        _d.normalize();

        // Direction in the bone's rest frame.
        _q.copy(parentG).multiply(link.restLocal);
        _qi.copy(_q).invert();
        _d.applyQuaternion(_qi);

        let flex = Math.atan2(_d.z, _d.y) * R2D;
        let abd = Math.asin(clamp(-_d.x, -1, 1)) * R2D;
        // Positive abduction = toward the thumb side, for either hand.
        let abdThumb = -abd * sideSign(side);
        if (limits) {
          // The limits only stop what a hand cannot do. Tracking noise and the
          // difference between the model's joint axes and the person's put a
          // few degrees on top of real poses, so each range gets a tolerance
          // band; inside it the bone follows the tracked direction exactly.
          const [fMin, fMax, aMin, aMax] = limitsFor(finger.key, k);
          flex = clamp(flex, fMin - TOL_EXT, fMax + TOL_FLEX);
          // A finger bent at the knuckle cannot spread: the side ligaments
          // tighten, so a fist keeps its fingers together. Tracking guesses
          // the hidden fingers of a fist and spreads them, so the tolerance
          // shrinks with the bend too.
          const room = k === 0 && finger.key !== 'thumb' && flex > 0 ? Math.max(0, Math.cos(flex * D2R)) : 1;
          // Hinge joints (PIP, DIP, thumb IP) do not bend sideways at all: a
          // sideways reading there is noise, and following it reads as a
          // broken finger. Only the knuckles get a small band, and the index
          // never past its real reach toward the thumb.
          const hinge = aMin === 0 && aMax === 0;
          const tolLo = hinge ? 0 : TOL_ABD;
          const tolHi = hinge || finger.key === 'index' ? 0 : TOL_ABD;
          abdThumb = clamp(abdThumb, (aMin - tolLo) * room, (aMax + tolHi) * room);
          abd = -abdThumb * sideSign(side);
        }
        _e.set(flex * D2R, 0, abd * D2R, 'XZY');
        const local = link.restLocal.clone().multiply(new THREE.Quaternion().setFromEuler(_e));
        // Roll of a bone whose child is a hinge (finger MCP above the PIP,
        // thumb MCP above the IP): turn it about its own length so the child
        // bends in its own plane. Real knuckles rotate a little as they flex,
        // and without this the hinge below would have to bend sideways.
        const rollJoint = finger.key === 'thumb' ? k === 1 : k === 0;
        if (rollJoint && k + 2 < finger.joints.length) {
          const c = P[finger.joints[k + 2]].clone().sub(P[finger.joints[k + 1]]).normalize();
          c.applyQuaternion(parentG.clone().multiply(local).invert());
          const side = Math.hypot(c.x, c.z);
          if (side > 0.25) {
            const roll = clamp(Math.atan2(-c.x, c.z), -MAX_ROLL, MAX_ROLL) * THREE.MathUtils.smoothstep(side, 0.25, 0.5);
            local.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), roll));
          }
        }

        // Low-confidence bones move slower (they are likely occluded or mis-detected).
        const out = this.apply(link.bone, local, smoothing ? 0.35 + 0.65 * c : 1);
        parentG = parentG.multiply(out);
        angles[finger.key].push({ flex, abd: abdThumb });
        confidence[finger.key].push(c);
      });
    }
    return { angles, confidence };
  }

  apply(bone, target, alpha) {
    let prev = this.smoothed.get(bone);
    if (!prev) {
      prev = target.clone();
      this.smoothed.set(bone, prev);
    } else {
      prev.slerp(target, alpha);
    }
    bone.quaternion.copy(prev);
    return prev.clone();
  }

  // Bone length should stay constant; a sudden change means the 3D estimate
  // for this segment is unreliable (occlusion, foreshortening, swap).
  boneConfidence(name, len) {
    const ref = this.refLen[name];
    if (ref === undefined) {
      this.refLen[name] = len;
      return 1;
    }
    const ratio = len / Math.max(ref, 1e-4);
    const c = clamp(1 - Math.abs(ratio - 1) * 2.0, 0.15, 1);
    // Only learn from plausible samples.
    if (c > 0.6) this.refLen[name] = ref * 0.97 + len * 0.03;
    return c;
  }
}

// Read joint angles back from a rig (used when a saved pose is loaded).
export function anglesFromRig(rig) {
  const angles = {};
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  for (const finger of FINGERS) {
    angles[finger.key] = rig.chains[finger.key].map((link) => {
      q.copy(link.restLocal).invert().multiply(link.bone.quaternion);
      e.setFromQuaternion(q, 'XZY');
      return { flex: e.x * R2D, abd: -e.z * R2D * sideSign(rig.side) };
    });
  }
  return angles;
}
