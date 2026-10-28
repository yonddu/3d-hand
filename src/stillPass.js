// A finger whose points stand still on the hand keeps one pose (user rule
// 2026-10-28: while the hand holds something and moves with it, the fingers
// barely move; the moment a finger's points move apart from that, they lead
// again). MediaPipe's points shake a little from frame to frame even on a
// still finger, and the solver turned that shake into bends swinging 25-45
// degrees back and forth (take pen_grip_02-41: 32 such swings in 23 s).
//
// On a finished take, per hand and finger: the finger's picture points are
// put on the palm (a 2D similarity fitted to the palm's points, so the hand
// may move, turn and come nearer), and a stretch where every point stays
// within STILL palm lengths of where it started, for at least MIN frames,
// is a hold. Inside a hold the finger's bones take the stretch's trend line,
// eased over RAMP frames at both ends. A point that leaves ends the hold at
// once, so real finger moves are kept. Not while the two hands are on each
// other (wrists within NEAR).
import { FINGERS } from './skeleton.js';

const env = globalThis.process?.env || {};
export const STILL = +(env.STILL || 0.08); // palm lengths (wrist to middle knuckle, in the picture)
const MIN = +(env.STILL_MIN || 8); // frames
const RAMP = +(env.STILL_RAMP || 6); // frames
const START = 3; // frames averaged for where a stretch starts
const PALM = [0, 5, 9, 13, 17];
const NEAR = +(env.STILL_NEAR || 0.25); // metres: wrists this close, the hands may be on each other (tracked wrists of interlaced hands sit ~20 cm apart)
const other = { left: 'right', right: 'left' };

// 2D similarity taking the palm points of `from` onto those of `to`:
// returns (p) => mapped point.
function palmMap(from, to) {
  const c = (L) => PALM.reduce((s, i) => [s[0] + L[i][0] / PALM.length, s[1] + L[i][1] / PALM.length], [0, 0]);
  const cf = c(from), ct = c(to);
  let a = 0, b = 0, n = 0;
  for (const i of PALM) {
    const x = from[i][0] - cf[0], y = from[i][1] - cf[1];
    const u = to[i][0] - ct[0], v = to[i][1] - ct[1];
    a += x * u + y * v;
    b += x * v - y * u;
    n += x * x + y * y;
  }
  a /= n || 1;
  b /= n || 1;
  return (p) => [a * (p[0] - cf[0]) - b * (p[1] - cf[1]) + ct[0], b * (p[0] - cf[0]) + a * (p[1] - cf[1]) + ct[1]];
}

const qMean = (qs) => {
  const s = [0, 0, 0, 0];
  for (const q of qs) {
    const sign = q[0] * qs[0][0] + q[1] * qs[0][1] + q[2] * qs[0][2] + q[3] * qs[0][3] < 0 ? -1 : 1;
    for (let k = 0; k < 4; k++) s[k] += sign * q[k];
  }
  const l = Math.hypot(...s) || 1;
  return s.map((x) => x / l);
};
// The turns' straight-line trend over a stretch (least squares per
// component on sign-matched quaternions): the swing goes, a slow real drift
// that stayed inside STILL stays. Returns (k) => turn at the stretch's k-th
// frame, or null.
const qLine = (qs) => {
  const ok = qs.filter(Boolean);
  if (!ok.length) return null;
  const ref = qMean(ok);
  const al = qs.map((q) => (q ? (q[0] * ref[0] + q[1] * ref[1] + q[2] * ref[2] + q[3] * ref[3] < 0 ? q.map((x) => -x) : q) : null));
  const ks = al.map((q, k) => (q ? k : null)).filter((k) => k !== null);
  const km = ks.reduce((s, k) => s + k, 0) / ks.length;
  const vk = ks.reduce((s, k) => s + (k - km) ** 2, 0) || 1;
  const mean = [0, 1, 2, 3].map((c) => ks.reduce((s, k) => s + al[k][c], 0) / ks.length);
  const slope = [0, 1, 2, 3].map((c) => ks.reduce((s, k) => s + (k - km) * (al[k][c] - mean[c]), 0) / vk);
  return (k) => {
    const q = mean.map((m, c) => m + slope[c] * (k - km));
    const l = Math.hypot(...q) || 1;
    return q.map((x) => x / l);
  };
};
const smooth = (x) => x * x * (3 - 2 * x);
const slerpish = (a, b, w) => {
  const sign = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3] < 0 ? -1 : 1;
  const s = a.map((x, k) => x * (1 - w) + sign * b[k] * w);
  const l = Math.hypot(...s) || 1;
  return s.map((x) => x / l);
};

// frames: finished frames ({ t, hands: { left, right } }, each hand with
// fingers by bone name and pic [[x, y] x 21], the picture points);
// rigFor(side): a HandRig for bone names; aspect: the picture's width over
// height as objects.js takes it (y / aspect is in x's units). Returns new frames; out.holds
// counts hold frames when given.
export function stillPass(frames, rigFor, aspect = 1, out = null) {
  const res = frames.map((f) => ({ ...f, hands: { ...f.hands } }));
  let holds = 0;
  for (const side of ['left', 'right']) {
    const rig = rigFor(side);
    const flat = new Map();
    const seen = (i) => {
      const h = frames[i].hands[side];
      if (!h || !h.fingers || !h.pic) return null;
      // Hands on each other: their fingers are kept apart frame by frame
      // (handBody.js separateHands), a held pose would undo that.
      const o = frames[i].hands[other[side]];
      if (o && o.wrist && h.wrist && Math.hypot(o.wrist[0] - h.wrist[0], o.wrist[1] - h.wrist[1], o.wrist[2] - h.wrist[2]) < NEAR) return null;
      if (!flat.has(i)) flat.set(i, h.pic.map((p) => [p[0], p[1] / aspect]));
      return { landmarks: flat.get(i) };
    };
    for (const finger of FINGERS) {
      const names = rig.chains[finger.key].map((l) => l.bone.name);
      const pts = finger.joints;
      let i = 0;
      while (i < frames.length) {
        if (!seen(i)) { i++; continue; }
        // Grow a stretch from i: every point of every frame, put on frame
        // i's palm, within STILL of where it was at the start (the mean of
        // the first frames, so one shaky start frame does not end it early).
        // Measured from the start, not from the stretch's running mean: a
        // slow real bend would drag the mean along and become steps.
        const ref = seen(i).landmarks;
        const palm = Math.hypot(ref[9][0] - ref[0][0], ref[9][1] - ref[0][1]) || 1e-3;
        const on = (j) => { const m = palmMap(seen(j).landmarks, ref); return pts.map((p) => m(seen(j).landmarks[p])); };
        const start = on(i).map((p) => [...p]);
        let n0 = 1;
        let j = i + 1;
        while (j < frames.length && seen(j) && frames[j].t - frames[j - 1].t < 0.1) {
          const P = on(j);
          if (P.some((p, k) => Math.hypot(p[0] - start[k][0] / n0, p[1] - start[k][1] / n0) > STILL * palm)) break;
          if (n0 < START) { P.forEach((p, k) => { start[k][0] += p[0]; start[k][1] += p[1]; }); n0++; }
          j++;
        }
        if (j - i >= MIN) {
          const line = Object.fromEntries(names.map((nm) => [nm, qLine(frames.slice(i, j).map((f) => f.hands[side].fingers[nm]))]));
          // Eased in and out over RAMP frames on both sides of the stretch's
          // ends (the frames just outside lean toward its end turns), so a
          // hold never makes a step against a neighbour.
          for (let k = Math.max(0, i - RAMP); k < Math.min(frames.length, j + RAMP); k++) {
            if (k < i || k >= j) { const h0 = res[k].hands[side]; if (!h0 || !h0.fingers || (k < i ? frames[i].t - frames[k].t : frames[k].t - frames[j - 1].t) > (RAMP + 1) / 30 + 0.02) continue; }
            const w = smooth(Math.min(1, (k - i + RAMP + 1) / (2 * RAMP + 1), (j - 1 - k + RAMP + 1) / (2 * RAMP + 1)));
            const h = res[k].hands[side];
            const fingers = { ...h.fingers };
            for (const nm of names) if (fingers[nm] && line[nm]) fingers[nm] = slerpish(fingers[nm], line[nm](Math.min(j - 1, Math.max(i, k)) - i), w);
            res[k].hands[side] = { ...h, fingers };
            if (k >= i && k < j) holds++;
          }
          i = j;
        } else i++;
      }
    }
  }
  if (out) out.holds = holds;
  return Object.assign(res, frames.together ? { together: frames.together } : {});
}

