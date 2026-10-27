// Two hands working together, when the camera loses one of them.
//
// Clasped, interlaced or crossed hands hide each other, and the tracker then
// often finds only one hand (or one blend of both). A hand that was with the
// other hand just before and just after did not leave: it is still held to
// the hand that is seen. So for each frame with one hand, where the two
// hands were together on one side of it or both, the missing hand is put
// where it sits relative to the seen hand:
//  - feedback: the way the two hands sat relative to each other in the
//    frames before and after, blended across the stretch;
//  - feedforward: the two-hand movements people make (twoHandMotions.js,
//    both arms solved inside the joint ranges) say which relative poses are
//    possible for the seen hand where it is. The further a frame is from the
//    frames that showed both hands, the more the nearest such pose counts.
import * as THREE from 'three';
import { TWO_HAND_MOTIONS } from './twoHandMotions.js';
import { armPoseJoints } from './armPoses.js';

const NEAR = 0.18; // metres between wrists: the hands were together
const MAX_FILL = 120; // frames (4 s) a hand can stay hidden and still be filled
const KEEP = 0.03; // metres: a lone hand changes which hand it is only past this margin
const RAMP = 12; // frames from the last frame with both hands until the data counts fully
const W_DATA = 0.6; // at most this share of the relative pose comes from the data
const POS_SIGMA = 0.12; // seen hand vs the data's hand: metres per unit of mismatch
const ROT_SIGMA = (30 * Math.PI) / 180;
const REL_POS = 0.05; // relative pose vs the blended one: metres per unit
const REL_ROT = (25 * Math.PI) / 180;
const REL_LOOSE = 9; // relative poses count three sigmas wide: the lift's own depth is the doubt
const CANDIDATES = 24;
const KEYS = ['sFlex', 'sAbd', 'hRot', 'elbow', 'pron', 'wFlex', 'wDev'];
const SHOULDER = { right: new THREE.Vector3(0.18, -0.24, 0.06), left: new THREE.Vector3(-0.18, -0.24, 0.06) };
const other = (s) => (s === 'left' ? 'right' : 'left');

let table = null;
// Every key of every two-hand movement, seen from each hand: where that hand
// is (for matching the seen hand) and where the other hand is relative to it.
function data() {
  if (table) return table;
  table = { left: [], right: [] };
  for (const row of TWO_HAND_MOTIONS) {
    for (const [r, l] of row[6]) {
      const arm = (v) => Object.fromEntries(KEYS.map((k, i) => [k, v[i]]));
      const J = { right: armPoseJoints(arm(r), 'right', SHOULDER.right), left: armPoseJoints(arm(l), 'left', SHOULDER.left) };
      for (const s of ['left', 'right']) {
        const a = J[s];
        const b = J[other(s)];
        table[s].push({ id: row[0], W: a.W, Q: a.handQ, rel: relOf(a.W, a.handQ, b.W, b.handQ) });
      }
    }
  }
  return table;
}

function relOf(wa, qa, wb, qb) {
  const inv = qa.clone().invert();
  return { p: wb.clone().sub(wa).applyQuaternion(inv), q: inv.multiply(qb) };
}
const vec = (a) => new THREE.Vector3(a[0], a[1], a[2]);
const quat = (a) => new THREE.Quaternion(a[0], a[1], a[2], a[3]);
const gap = (h, k) => Math.hypot(h.wrist[0] - k.wrist[0], h.wrist[1] - k.wrist[1], h.wrist[2] - k.wrist[2]);

// For a seen hand at (w, q): the movements whose same hand is nearest
// there (CANDIDATES), and among them the relative pose nearest to `rel`.
// fit (0..1) says how much it counts: how close the seen hand is to that
// movement's hand, and, loosely, how close the two relative poses are.
function nearest(side, w, q, rel) {
  const near = [];
  for (const e of data()[side]) {
    const dp = w.distanceTo(e.W) / POS_SIGMA;
    const dq = q.angleTo(e.Q) / ROT_SIGMA;
    const c = dp * dp + dq * dq;
    if (near.length < CANDIDATES || c < near[near.length - 1].c) {
      near.push({ e, c });
      near.sort((x, y) => x.c - y.c);
      if (near.length > CANDIDATES) near.pop();
    }
  }
  let best = null;
  for (const n of near) {
    const rp = rel.p.distanceTo(n.e.rel.p) / REL_POS;
    const rq = rel.q.angleTo(n.e.rel.q) / REL_ROT;
    const r = rp * rp + rq * rq;
    if (!best || r < best.r) best = { e: n.e, c: n.c, r };
  }
  return best ? { e: best.e, fit: Math.exp(-0.5 * best.c) * Math.exp(-0.5 * best.r / REL_LOOSE) } : null;
}

// frames: [{t, hands: {left, right}}] with hands {wrist, handQ, fingers,
// upperQ, foreQ, elbow, shoulder, ...}. lerpHand(a, b, u) blends two hands
// (cleanTake.js). Fills in place; returns { filled, fromData } frame counts
// and the filled frames' times.
export function fillTogether(frames, lerpHand) {
  const both = (i) => frames[i].hands.left && frames[i].hands.right;
  const lone = (i) => !!frames[i].hands.left !== !!frames[i].hands.right;
  let filled = 0;
  let fromData = 0;
  const times = [];
  let i = 0;
  while (i < frames.length) {
    if (!lone(i)) {
      i++;
      continue;
    }
    let s = i;
    while (i < frames.length && lone(i)) i++;
    const e = i - 1;
    const a = s - 1 >= 0 && both(s - 1) ? s - 1 : -1;
    const b = e + 1 < frames.length && both(e + 1) ? e + 1 : -1;
    if (e - s + 1 > MAX_FILL) continue;
    const together = (k) => k >= 0 && gap(frames[k].hands.left, frames[k].hands.right) < NEAR;
    if (!together(a) && !together(b)) continue;
    const end = (k, side) => (k >= 0 ? frames[k].hands[side] : null);
    // Which hand each lone find is: the one whose path between the ends it
    // is nearer, holding the last answer unless the other is clearly nearer.
    const guess = (side, k) => {
      const A = end(a, side);
      const B = end(b, side);
      if (A && B) return lerpHand(A, B, (k - a) / (b - a)).wrist;
      return (A || B).wrist;
    };
    let last = null;
    for (let k = s; k <= e; k++) {
      const h = frames[k].hands.left || frames[k].hands.right;
      const d = { left: Math.hypot(...h.wrist.map((v, c) => v - guess('left', k)[c])), right: Math.hypot(...h.wrist.map((v, c) => v - guess('right', k)[c])) };
      let seen = d.left < d.right ? 'left' : 'right';
      if (last && seen !== last && d[seen] > d[last] - KEEP) seen = last;
      last = seen;
      const hid = other(seen);
      // A find named as the other hand was solved on the other hand's rig:
      // its finger bones carry that hand's names and frames, which the clean-up
      // and the export cannot read as this hand's (user take 2026-10-27 02:46:
      // the clean-up stopped on a left hand with right-hand bones, and the
      // take was saved unsmoothed, shaking). It is taken from this hand's own
      // frames at either end, moved to where it was seen.
      const was = frames[k].hands.left ? 'left' : 'right';
      let found = h;
      if (was !== seen) {
        const A = end(a, seen);
        const B = end(b, seen);
        found = A && B ? lerpHand(A, B, (k - a) / (b - a)) : JSON.parse(JSON.stringify(A || B));
        const shift = h.wrist.map((v, c) => v - found.wrist[c]);
        found.wrist = h.wrist.slice();
        if (Array.isArray(found.elbow)) found.elbow = found.elbow.map((v, c) => v + shift[c]);
      }
      frames[k].hands = { [seen]: found, [hid]: null };
      // Feedback: the hidden hand relative to the seen one at each end.
      const rels = [a, b].map((x) => (x >= 0 ? relOf(vec(end(x, seen).wrist), quat(end(x, seen).handQ), vec(end(x, hid).wrist), quat(end(x, hid).handQ)) : null));
      const u = a >= 0 && b >= 0 ? (k - a) / (b - a) : a >= 0 ? 0 : 1;
      const R0 = rels[0] || rels[1];
      const R1 = rels[1] || rels[0];
      const rel = { p: R0.p.clone().lerp(R1.p, u), q: R0.q.clone().slerp(R1.q, u) };
      const ws = vec(found.wrist);
      const qs = quat(found.handQ);
      // Feedforward: lean toward the nearest relative pose people make.
      const away = Math.min(a >= 0 ? k - a : Infinity, b >= 0 ? b - k : Infinity);
      // The arm rig lets the shoulder follow the body; the data's arms hang
      // from a fixed shoulder, so the seen hand is matched from its own shoulder.
      const sh = Array.isArray(found.shoulder) ? vec(found.shoulder) : SHOULDER[seen];
      const near = nearest(seen, ws.clone().sub(sh).add(SHOULDER[seen]), qs, rel);
      if (near) {
        const w = W_DATA * Math.min(1, away / RAMP) * near.fit;
        if (w > 0.2) fromData++;
        rel.p.lerp(near.e.rel.p, w);
        rel.q.slerp(near.e.rel.q, w);
      }
      const base = a >= 0 && b >= 0 ? lerpHand(end(a, hid), end(b, hid), u) : JSON.parse(JSON.stringify(end(a >= 0 ? a : b, hid)));
      const wrist = rel.p.clone().applyQuaternion(qs).add(ws);
      const shift = [wrist.x - base.wrist[0], wrist.y - base.wrist[1], wrist.z - base.wrist[2]];
      base.wrist = wrist.toArray();
      base.handQ = qs.clone().multiply(rel.q).toArray();
      if (Array.isArray(base.elbow)) base.elbow = base.elbow.map((v, c) => v + shift[c]);
      frames[k].hands[hid] = base;
      filled++;
      times.push(frames[k].t);
    }
  }
  return { filled, fromData, times };
}
