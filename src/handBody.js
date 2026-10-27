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

// The thumb kept out of the other fingers on the drawn model, after
// everything that moves it (the solver's walls are soft, and the contact
// passes in realHand.js, pinches and the wrapped fist thumb, run after the
// solver with no walls at all: user take 2026-10-27 03:47, the thumb slipping
// in between the index and middle fingers whenever it touched the index).
// Each step turns the thumb at its base just enough to lift its deepest
// point out along the way out. Changes the rig's thumb bones; returns how
// deep (m) the thumb was in at the start.
const SEP_STEPS = 6;
const SEP_MIN = 0.001; // m inside before anything is moved
export function separateThumb(rig, scale = Math.hypot(...BODY[rig.side].base.middle) / 0.09) {
  const RADIUS = { thumb: 0.0095, index: 0.0085, middle: 0.0085, ring: 0.008, pinky: 0.007 };
  const BONES = { index: [[5, 6], [6, 7], [7, 8]], middle: [[9, 10], [10, 11], [11, 12]], ring: [[13, 14], [14, 15], [15, 16]], pinky: [[17, 18], [18, 19], [19, 20]] };
  const closest = (p1, q1, p2, q2) => {
    // Closest points of segments p1-q1 and p2-q2 (THREE.Vector3).
    const d1 = q1.clone().sub(p1);
    const d2 = q2.clone().sub(p2);
    const r = p1.clone().sub(p2);
    const a = d1.lengthSq();
    const e = d2.lengthSq();
    const f = d2.dot(r);
    const c = d1.dot(r);
    const b = d1.dot(d2);
    const den = a * e - b * b;
    let s = den > 1e-12 ? THREE.MathUtils.clamp((b * f - c * e) / den, 0, 1) : 0;
    let t = e > 1e-12 ? (b * s + f) / e : 0;
    if (t < 0) {
      t = 0;
      s = a > 1e-12 ? THREE.MathUtils.clamp(-c / a, 0, 1) : 0;
    } else if (t > 1) {
      t = 1;
      s = a > 1e-12 ? THREE.MathUtils.clamp((b - c) / a, 0, 1) : 0;
    }
    return [p1.clone().addScaledVector(d1, s), p2.clone().addScaledVector(d2, t)];
  };
  const base = rig.chains.thumb[0].bone;
  let first = 0;
  let lastTotal = Infinity;
  let undo = null;
  for (let step = 0; step < SEP_STEPS; step++) {
    const L = bodyPoints(rig);
    let worst = null;
    for (const [s0, s1] of [[2, 3], [3, 4]]) {
      for (const [key, bones] of Object.entries(BONES)) {
        const reach = (RADIUS.thumb + RADIUS[key]) * scale;
        for (const [t0, t1] of bones) {
          const [c1, c2] = closest(L[s0], L[s1], L[t0], L[t1]);
          const depth = reach - c1.distanceTo(c2);
          if (depth > SEP_MIN && (!worst || depth > worst.depth)) worst = { depth, c1, c2 };
        }
      }
    }
    // A turn out of one finger that sinks the thumb deeper into another
    // (a thumb lying across the curled fingers) is taken back, and that is
    // as far as it goes.
    const total = worst ? worst.depth : 0;
    if (total >= lastTotal) {
      base.quaternion.copy(undo);
      base.updateMatrixWorld(true);
      break;
    }
    lastTotal = total;
    if (!worst) break;
    if (step === 0) first = worst.depth;
    undo = base.quaternion.clone();
    const out = worst.c1.clone().sub(worst.c2);
    if (out.lengthSq() < 1e-12) break;
    const pivot = L[1];
    const from = worst.c1.clone().sub(pivot);
    const to = worst.c1.clone().addScaledVector(out.normalize(), worst.depth).sub(pivot);
    if (from.lengthSq() < 1e-10) break;
    const R = new THREE.Quaternion().setFromUnitVectors(from.normalize(), to.normalize());
    const parent = base.parent.getWorldQuaternion(new THREE.Quaternion());
    base.quaternion.premultiply(parent.clone().invert().multiply(R).multiply(parent));
    base.updateMatrixWorld(true);
  }
  return first;
}

// separateThumb over finished frames ([{ hands: { left, right } }] with
// fingers as bone name -> quaternion): the clean-up's smoothing blends
// separated frames and can sink the thumb in again. The turn each frame needs
// is spread over the frames around it (widened to the largest nearby, then
// averaged), so the thumb eases out instead of stepping (applied frame by
// frame it added finger steps: pencil take fjump 48 -> 72).
const SEP_SPREAD = 4; // frames each way
const sepRigs = {};
export function separateFrames(frames, makeRig) {
  for (const side of ['left', 'right']) {
    const rig = (sepRigs[side] ||= makeRig(side));
    const name = rig.chains.thumb[0].bone.name;
    // Turn of the thumb base each frame needs, in its parent's frame.
    const corr = frames.map((f) => {
      const h = f.hands[side];
      if (!h || !h.fingers || !h.fingers[name]) return null;
      rig.setPose({ bones: h.fingers });
      const before = rig.chains.thumb[0].bone.quaternion.clone();
      if (!(separateThumb(rig) > 0)) return new THREE.Quaternion();
      return rig.chains.thumb[0].bone.quaternion.clone().multiply(before.invert());
    });
    const angle = (q) => 2 * Math.acos(Math.min(1, Math.abs(q.w)));
    const near = (i, pick) => {
      const out = [];
      for (let j = Math.max(0, i - SEP_SPREAD); j <= Math.min(frames.length - 1, i + SEP_SPREAD); j++) if (corr[j]) out.push(pick(j));
      return out;
    };
    const wide = corr.map((c, i) => (c ? near(i, (j) => corr[j]).reduce((m, q) => (angle(q) > angle(m) ? q : m), new THREE.Quaternion()) : null));
    corr.forEach((c, i) => {
      if (!c) return;
      const qs = near(i, (j) => wide[j]);
      const avg = new THREE.Vector4();
      for (const q of qs) {
        const sgn = q.w < 0 ? -1 : 1;
        avg.x += q.x * sgn;
        avg.y += q.y * sgn;
        avg.z += q.z * sgn;
        avg.w += q.w * sgn;
      }
      const turn = new THREE.Quaternion(avg.x, avg.y, avg.z, avg.w).normalize();
      if (angle(turn) < 1e-4) return;
      const h = frames[i].hands[side];
      h.fingers = { ...h.fingers, [name]: turn.multiply(new THREE.Quaternion().fromArray(h.fingers[name])).toArray() };
    });
  }
  return frames;
}
