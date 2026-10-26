// Landmarks -> bone rotations.
//
// For every bone we take the observed direction (child joint - joint), express
// it in the bone's rest frame under its already-solved parent, and decompose it
// into flexion (about local X) and abduction (about local Z). Clamping those
// two angles to anatomical limits and rebuilding a twist-free rotation gives
// joint data a game character can use directly, instead of raw points.
import * as THREE from 'three';
import { FINGERS, limitsFor, sideSign } from './skeleton.js';
import { handFrameQuat, cupQuat } from './handRig.js';
import { fitFinger, hiddenJoints } from './fit.js';
import { GraspPrior } from './gripPrior.js';

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const clamp = THREE.MathUtils.clamp;
const TOL_FLEX = 10; // degrees past a flexion limit still followed
const TOL_EXT = 5; // degrees of bending backward past the limit still followed
const MAX_ROLL = (12 * Math.PI) / 180; // knuckle axial rotation allowed
const TOL_ABD = 4; // degrees past a knuckle's side-bend limit still followed

const anyHidden = (hidden) => Object.values(hidden).some((h) => Math.max(...h) >= 0.05);
const _q = new THREE.Quaternion();
const _qi = new THREE.Quaternion();
const _d = new THREE.Vector3();
const _e = new THREE.Euler();

export class HandSolver {
  constructor(rig) {
    this.rig = rig;
    this.refLen = {}; // running reference length per bone, for confidence
    this.smoothed = new Map(); // bone -> last output quaternion
    this.fitPrev = {}; // finger -> last fitted angles (model fitting)
    this.grasp = new GraspPrior(); // grip guess for hidden fingers
  }

  reset() {
    this.refLen = {};
    this.smoothed.clear();
    this.fitPrev = {};
    this.grasp.reset();
  }

  // P: 21 THREE.Vector3 in rig orientation (any origin, meters).
  // Returns per-bone angles and confidences and writes rotations to the rig.
  solve(P, { limits = true, smoothing = true, synergy = true, fit = false, occluded = null, cup = 0, held = null, heldSize = null, plan } = {}) {
    const rig = this.rig;
    const side = rig.side;
    const wristQ = handFrameQuat(P, side);
    this.apply(rig.wrist, wristQ, smoothing ? 0.75 : 1);

    const angles = {};
    const confidence = {};
    const knuckle = synergy ? knuckleFlex(P, wristQ) : null;
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
          // Hinge joints (PIP, DIP, thumb IP) do not bend sideways at all: a
          // sideways reading there is noise, and following it reads as a
          // broken finger. Only the knuckles get a small band, and the index
          // never past its real reach toward the thumb.
          const hinge = aMin === 0 && aMax === 0;
          const tolLo = hinge ? 0 : TOL_ABD;
          const tolHi = hinge || finger.key === 'index' ? 0 : TOL_ABD;
          abdThumb = clamp(abdThumb, aMin - tolLo, aMax + tolHi);
          abd = -abdThumb * sideSign(side);
        }
        if (synergy) {
          [flex, abdThumb] = coupled(finger.key, k, flex, abdThumb, angles[finger.key], knuckle);
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
          // In a fist the fingertips are hidden and their points are guessed,
          // so the roll read from them is noise: it fades out as the knuckle bends.
          const trust = finger.key === 'thumb' ? 1 : 1 - THREE.MathUtils.smoothstep(flex, 30, 60);
          if (side > 0.25 && trust > 0) {
            const roll = clamp(Math.atan2(-c.x, c.z), -MAX_ROLL, MAX_ROLL) * THREE.MathUtils.smoothstep(side, 0.25, 0.5) * trust;
            local.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), roll));
          }
        }

        // Low-confidence bones move slower (they are likely occluded or mis-detected).
        // Model fitting (below) poses the bones; this pass only seeds it.
        const out = fit ? local : this.apply(link.bone, local, smoothing ? 0.35 + 0.65 * c : 1);
        parentG = parentG.multiply(out);
        angles[finger.key].push({ flex, abd: abdThumb });
        confidence[finger.key].push(c);
      });
    }
    rig.cup = fit ? cup : 0;
    if (fit) this.fitHand(P, wristQ, angles, confidence, { limits, smoothing, occluded, held, heldSize, plan });
    return { angles, confidence };
  }

  // Fit each finger of the hand model to the points (see fit.js), seeded by
  // the last frame or, the first time, by the per-bone reading.
  // plan: a grip chosen for this frame with the whole take known
  // (gripPrior.js planGrips), or null for none; left out, the grip is chosen
  // live from the frames so far.
  fitHand(P, wristQ, angles, confidence, { limits, smoothing, occluded, held, heldSize, plan }) {
    const rig = this.rig;
    const palm = P[0].distanceTo(P[9]);
    const starts = {};
    const frames = {};
    const hidden = {};
    for (const finger of FINGERS) {
      const a = angles[finger.key];
      starts[finger.key] = finger.key === 'thumb'
        ? [a[0].flex, a[0].abd, 0, a[1].flex, a[1].abd, 0, a[2].flex]
        : [a[0].flex, a[0].abd, 0, a[1].flex, a[2].flex];
      // Ring and little finger hang from metacarpals folded by the cupping.
      frames[finger.key] = wristQ.clone().multiply(cupQuat(rig.side, finger.key, rig.cup));
      hidden[finger.key] = hiddenJoints(finger, P, frames[finger.key], occluded);
    }
    // The grip the seen fingers point to, for the hidden ones (gripPrior.js).
    this.gripIn = { reading: starts, hidden, shape: held, size: heldSize, aperture: P[4].distanceTo(P[8]) * 1000 };
    let grip;
    if (plan === undefined) {
      grip = this.grasp.update(starts, hidden, held, heldSize);
      this.gripName = this.grasp.current ? this.grasp.current.name : '';
    } else {
      grip = plan && anyHidden(hidden) ? this.grasp.targets(plan, starts) : null;
      this.gripName = grip ? plan.name : '';
    }
    for (const finger of FINGERS) {
      const start = starts[finger.key];
      const prev = this.fitPrev[finger.key] || null;
      const chain = rig.chains[finger.key];
      const cupQ = cupQuat(rig.side, finger.key, rig.cup);
      const res = fitFinger({ finger, chain, side: rig.side, P, wristQ: frames[finger.key], conf: confidence[finger.key], palm, prev, start, useLimits: limits, occluded, prior: grip && grip[finger.key] });
      res.locals[0].premultiply(cupQ);
      this.fitPrev[finger.key] = res.theta;
      chain.forEach((link, k) => this.apply(link.bone, res.locals[k], smoothing ? 0.85 : 1));
      angles[finger.key] = res.ang.map(({ flex, abd }) => ({ flex, abd }));
    }
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

// --- motion model -------------------------------------------------------------
//
// Joint limits say what a hand can be pushed to; they do not say how it moves.
// Tendons and ligaments couple the joints, so real fingers follow nearly the
// same paths every time. These couplings are applied to the tracked angles,
// strongest where tracking is weakest (deep flexion, hidden fingertips):
//  - DIP follows PIP (one tendon flexes both; DIP ~ 2/3 of PIP),
//  - the thumb's IP follows its MCP,
//  - a bending finger stops spreading and leans toward the middle of the
//    hand (bent fingertips converge, which closes a fist inward),
//  - ring and little finger, and to a lesser degree the middle finger, are
//    pulled along by their neighbours (shared muscle bellies).

const DIP_PER_PIP = 0.67;
const DIP_COUPLING = 0.75;
const IP_PER_MCP = 0.9;
const IP_COUPLING = 0.35;
// Side bend toward the thumb (degrees) each finger ends up at when fully bent:
// index and little finger lean in toward the middle finger.
const CONVERGE = { index: -5, middle: 0, ring: 5, pinky: 10 };
// How much a knuckle is pulled toward its neighbours' mean bend.
const ENSLAVE = { index: 0, middle: 0.15, ring: 0.35, pinky: 0.2 };
const NEIGHBOURS = { middle: ['index', 'ring'], ring: ['middle', 'pinky'], pinky: ['ring', 'ring'] };

// Knuckle (MCP) bend of each finger straight from the points, for coupling.
function knuckleFlex(P, wristQ) {
  const Y = new THREE.Vector3(0, 1, 0).applyQuaternion(wristQ);
  const Z = new THREE.Vector3(0, 0, 1).applyQuaternion(wristQ);
  const out = {};
  for (const f of FINGERS) {
    if (f.key === 'thumb') continue;
    const d = P[f.joints[1]].clone().sub(P[f.joints[0]]);
    out[f.key] = Math.atan2(d.dot(Z), d.dot(Y)) * R2D;
  }
  return out;
}

// done: this finger's already solved joints ({ flex, abd } per joint).
function coupled(key, k, flex, abd, done, knuckle) {
  const ease = (x, a, b) => THREE.MathUtils.smoothstep(x, a, b);
  if (key === 'thumb') {
    if (k === 2 && done[1]) flex += (IP_PER_MCP * done[1].flex - flex) * IP_COUPLING;
    return [flex, abd];
  }
  if (k === 0) {
    const n = NEIGHBOURS[key];
    if (n && knuckle) {
      const mean = (knuckle[n[0]] + knuckle[n[1]]) / 2;
      flex += (mean - knuckle[key]) * ENSLAVE[key];
    }
    // Spread fades into the convergence direction as the knuckle bends.
    const t = ease(flex, 15, 75);
    abd += (CONVERGE[key] * t - abd) * t;
  } else if (k === 2 && done[1]) {
    // DIP rides on PIP; more so once the finger is clearly bending.
    const w = DIP_COUPLING * (0.5 + 0.5 * ease(done[1].flex, 10, 60));
    flex += (DIP_PER_PIP * done[1].flex - flex) * w;
  }
  return [flex, abd];
}
