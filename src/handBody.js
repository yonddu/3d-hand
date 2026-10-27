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
import { handOverlaps, palmFrame } from './collide.js';

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
// Closest points of segments p1-q1 and p2-q2 (THREE.Vector3).
function closest(p1, q1, p2, q2) {
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
}
export function separateThumb(rig, scale = Math.hypot(...BODY[rig.side].base.middle) / 0.09) {
  const RADIUS = { thumb: 0.0095, index: 0.0085, middle: 0.0085, ring: 0.008, pinky: 0.007 };
  const BONES = { index: [[5, 6], [6, 7], [7, 8]], middle: [[9, 10], [10, 11], [11, 12]], ring: [[13, 14], [14, 15], [15, 16]], pinky: [[17, 18], [18, 19], [19, 20]] };
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

// One hand kept out of the other (clasped, stacked or interlaced hands: user
// take 2026-10-27 03:59). Where the hands overlap on the drawn model, they are
// moved apart along the camera's line of sight, each along its own wrist's
// ray, so both stay where they are in the picture: how far each hand is from
// the camera is the one thing the picture cannot tell. The hand already
// nearer the camera stays nearer. Shifts are eased over neighbouring frames
// like separateFrames. frames: finished frames (cleanTake); changes wrist and
// elbow of each hand frame.
const HANDS_MIN = 0.001; // m inside before anything is moved
const HANDS_STEPS = 8;
const HANDS_MAX = 0.03; // m the two hands may be moved apart in all: past that the overlap is not one of depth (interlaced fingers)
export function handPoints(rig, h) {
  rig.setPose({ bones: h.fingers });
  rig.group.position.fromArray(h.wrist);
  rig.wrist.quaternion.fromArray(h.handQ);
  return bodyPoints(rig).map((v) => v.toArray());
}
function handFrame(L, side) {
  const w = new THREE.Vector3(...L[0]);
  const n = new THREE.Vector3(...L[5]).sub(w).cross(new THREE.Vector3(...L[17]).sub(w)).normalize();
  if (side === 'left') n.negate();
  return palmFrame(L[0], L[5], L[17], L[9], n.toArray());
}
export function handsDepth(rigs, hl, hr) {
  const A = handPoints(rigs.left, hl);
  const B = handPoints(rigs.right, hr);
  const scale = Math.hypot(...BODY.right.base.middle) / 0.09;
  const hits = handOverlaps(A, B, handFrame(A, 'left'), handFrame(B, 'right'), scale, 0);
  const near = (P) => P.reduce((s, p) => s + Math.hypot(...p), 0) / P.length;
  return { depth: hits.length ? hits[0].depth : 0, leftNearer: near(A) < near(B) };
}
// Runs of frames that are eased together: both hands seen, no gap in time
// longer than RUN_GAP, and (for the hands' order in depth) the same hand
// nearer the camera. Corrections never cross from one run into another
// (review 2026-10-27: a neighbour's push, sign and all, flipped which hand
// was in front; a push leaked across frames with no hands).
const RUN_GAP = 0.15; // s
function runsOf(frames, key = () => 0) {
  const run = [];
  let id = -1;
  frames.forEach((f, i) => {
    const both = f.hands.left && f.hands.right && f.hands.left.fingers && f.hands.right.fingers;
    if (!both) {
      run.push(null);
      return;
    }
    const prev = i > 0 && run[i - 1] !== null;
    if (!prev || f.t - frames[i - 1].t > RUN_GAP || key(i) !== key(i - 1)) id++;
    run.push(id);
  });
  return run;
}
// Widen each frame's value to the largest in its run within SEP_SPREAD
// frames, then average over the same window: a correction eases in and out.
function easeInRuns(vals, run, size, widen, mean) {
  const near = (i, src) => {
    const out = [];
    for (let j = Math.max(0, i - SEP_SPREAD); j <= Math.min(vals.length - 1, i + SEP_SPREAD); j++) if (run[j] === run[i] && src[j] !== null) out.push(src[j]);
    return out;
  };
  const wide = vals.map((v, i) => (v === null ? null : near(i, vals).reduce((m, x) => (size(x) > size(m) ? x : m), widen)));
  return vals.map((v, i) => (v === null ? null : mean(near(i, wide))));
}
export function separateHands(frames, makeRig) {
  const rigs = { left: (sepRigs.left ||= makeRig('left')), right: (sepRigs.right ||= makeRig('right')) };
  // How far (m) the two hands move apart along their rays each frame, and
  // which one is nearer the camera (it stays nearer).
  const order = [];
  const gap = frames.map((f, i) => {
    const hl = f.hands.left;
    const hr = f.hands.right;
    if (!hl || !hr || !hl.fingers || !hr.fingers) return null;
    const a = { ...hl };
    const b = { ...hr };
    let total = 0;
    for (let s = 0; s < HANDS_STEPS; s++) {
      const r = handsDepth(rigs, a, b);
      if (order[i] === undefined) order[i] = r.leftNearer;
      if (r.depth < HANDS_MIN) break;
      total = Math.min(total + r.depth + 0.001, HANDS_MAX);
      a.wrist = along(hl.wrist, order[i] ? -total / 2 : total / 2);
      b.wrist = along(hr.wrist, order[i] ? total / 2 : -total / 2);
      if (total >= HANDS_MAX) break;
    }
    return total;
  });
  const run = runsOf(frames, (i) => order[i]);
  const eased = easeInRuns(gap, run, (x) => x, 0, (xs) => xs.reduce((s, x) => s + x, 0) / xs.length);
  eased.forEach((g, i) => {
    if (!g) return;
    const d = order[i] ? -g / 2 : g / 2; // the left hand's move back
    const f = frames[i];
    f.hands.left = moveBack(f.hands.left, d);
    f.hands.right = moveBack(f.hands.right, -d);
  });
  return crossFingers(frames, rigs);
}

// Fingers of one hand kept out of the other's (interlaced fingers, which
// moving the hands apart cannot undo). Each step turns the two fingers in
// deepest at their bases, each half the way out from the other, within
// CROSS_MAX of where they were; a step that does not lessen the deepest
// overlap is taken back. Turns are eased over the frames around, as in
// separateFrames.
const CROSS_STEPS = 6;
const CROSS_MAX = (15 * Math.PI) / 180; // a knuckle's sideways play
const CROSS_BONES = { thumb: [[2, 3], [3, 4]], index: [[5, 6], [6, 7], [7, 8]], middle: [[9, 10], [10, 11], [11, 12]], ring: [[13, 14], [14, 15], [15, 16]], pinky: [[17, 18], [18, 19], [19, 20]] };
const CROSS_RADIUS = { thumb: 0.0095, index: 0.0085, middle: 0.0085, ring: 0.008, pinky: 0.007 };
const KNUCKLE = { thumb: 1, index: 5, middle: 9, ring: 13, pinky: 17 };
function crossFingers(frames, rigs) {
  const scale = Math.hypot(...BODY.right.base.middle) / 0.09;
  const keys = Object.keys(CROSS_BONES);
  const angle = (q) => 2 * Math.acos(Math.min(1, Math.abs(q.w)));
  // corr[i] = { left: { key: quaternion }, right: {...} } or null
  const corr = frames.map((f) => {
    const hl = f.hands.left;
    const hr = f.hands.right;
    if (!hl || !hr || !hl.fingers || !hr.fingers) return null;
    const hands = { left: hl, right: hr };
    for (const side of ['left', 'right']) handPoints(rigs[side], hands[side]);
    const start = {};
    for (const side of ['left', 'right']) for (const k of keys) start[side + k] = rigs[side].chains[k][0].bone.quaternion.clone();
    const worstOf = () => {
      const A = bodyPoints(rigs.left);
      const B = bodyPoints(rigs.right);
      let worst = null;
      for (const a of keys) for (const b of keys) {
        const reach = (CROSS_RADIUS[a] + CROSS_RADIUS[b]) * scale;
        for (const [s0, s1] of CROSS_BONES[a]) for (const [t0, t1] of CROSS_BONES[b]) {
          const [c1, c2] = closest(A[s0], A[s1], B[t0], B[t1]);
          const depth = reach - c1.distanceTo(c2);
          if (depth > SEP_MIN && (!worst || depth > worst.depth)) worst = { depth, a, b, c1, c2, A, B };
        }
      }
      return worst;
    };
    let last = Infinity;
    let undo = null;
    // One more look than there are steps, so the last step is checked too.
    for (let step = 0; step <= CROSS_STEPS; step++) {
      const w = worstOf();
      const total = w ? w.depth : 0;
      if (total >= last) {
        for (const [side, k, q] of undo) rigs[side].chains[k][0].bone.quaternion.copy(q);
        break;
      }
      last = total;
      if (!w || step === CROSS_STEPS) break;
      const out = w.c1.clone().sub(w.c2);
      if (out.lengthSq() < 1e-12) break;
      out.normalize();
      undo = [];
      for (const [side, key, c, P, dir] of [['left', w.a, w.c1, w.A, 1], ['right', w.b, w.c2, w.B, -1]]) {
        const bone = rigs[side].chains[key][0].bone;
        undo.push([side, key, bone.quaternion.clone()]);
        const pivot = P[KNUCKLE[key]];
        const from = c.clone().sub(pivot);
        const to = c.clone().addScaledVector(out, (dir * w.depth) / 2).sub(pivot);
        if (from.lengthSq() < 1e-10) continue;
        const R = new THREE.Quaternion().setFromUnitVectors(from.normalize(), to.normalize());
        bone.parent.updateMatrixWorld(true);
        const parent = bone.parent.getWorldQuaternion(new THREE.Quaternion());
        const next = bone.quaternion.clone().premultiply(parent.clone().invert().multiply(R).multiply(parent));
        // Within the knuckle's play from where the finger was.
        const s0 = start[side + key];
        const d = next.clone().multiply(s0.clone().invert());
        if (angle(d) > CROSS_MAX) next.copy(new THREE.Quaternion().slerp(d, CROSS_MAX / angle(d)).multiply(s0));
        bone.quaternion.copy(next);
      }
      for (const side of ['left', 'right']) rigs[side].group.updateMatrixWorld(true);
    }
    const out = { left: {}, right: {} };
    for (const side of ['left', 'right']) for (const k of keys) {
      const d = rigs[side].chains[k][0].bone.quaternion.clone().multiply(start[side + k].clone().invert());
      if (angle(d) > 1e-4) out[side][k] = d;
    }
    return out;
  });
  const run = runsOf(frames);
  const mean = (qs) => {
    const avg = new THREE.Vector4();
    for (const x of qs) {
      const sg = x.w < 0 ? -1 : 1;
      avg.x += x.x * sg;
      avg.y += x.y * sg;
      avg.z += x.z * sg;
      avg.w += x.w * sg;
    }
    return new THREE.Quaternion(avg.x, avg.y, avg.z, avg.w).normalize();
  };
  for (const side of ['left', 'right']) for (const k of keys) {
    const name = rigs[side].chains[k][0].bone.name;
    const c = corr.map((x) => (x ? x[side][k] || new THREE.Quaternion() : null));
    easeInRuns(c, run, angle, new THREE.Quaternion(), mean).forEach((turn, i) => {
      if (!turn || angle(turn) < 1e-4) return;
      const h = frames[i].hands[side];
      if (!h.fingers[name]) return;
      h.fingers = { ...h.fingers, [name]: turn.multiply(new THREE.Quaternion().fromArray(h.fingers[name])).toArray() };
    });
  }
  return frames;
}
// A point moved d (m) further from the camera along its own ray.
function along(p, d) {
  const L = Math.hypot(...p);
  if (!(L > 1e-6)) return p.slice(); // no line of sight from the camera itself
  return p.map((v) => v * (1 + d / L));
}
function moveBack(h, d) {
  const off = along(h.wrist, d).map((v, k) => v - h.wrist[k]);
  const out = { ...h, wrist: h.wrist.map((v, k) => v + off[k]) };
  if (h.elbow) out.elbow = h.elbow.map((v, k) => v + off[k]);
  return out;
}
