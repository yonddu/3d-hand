// Fingers cannot pass through each other. Each finger bone is a capsule (a
// segment with a radius); two bones of different fingers closer than the sum
// of their radii are inside each other.
//
// Bones of the hand in MediaPipe landmark order: [from, to] point indices.
// The thumb's metacarpal (1-2) sits under the palm's skin, so it is left out.
export const BONES = {
  thumb: [[2, 3], [3, 4]],
  index: [[5, 6], [6, 7], [7, 8]],
  middle: [[9, 10], [10, 11], [11, 12]],
  ring: [[13, 14], [14, 15], [15, 16]],
  pinky: [[17, 18], [18, 19], [19, 20]],
};
// Radius of each finger (m), about half an adult finger's thickness.
export const RADIUS = { thumb: 0.0095, index: 0.0085, middle: 0.0085, ring: 0.008, pinky: 0.007 };
const KEYS = Object.keys(BONES);

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const clamp01 = (v) => Math.min(1, Math.max(0, v));

// Closest distance between segments p1-q1 and p2-q2 (arrays [x, y, z]).
export function segDist(p1, q1, p2, q2) {
  const d1 = sub(q1, p1);
  const d2 = sub(q2, p2);
  const r = sub(p1, p2);
  const a = dot(d1, d1);
  const e = dot(d2, d2);
  const f = dot(d2, r);
  let s;
  let t;
  if (a < 1e-12 && e < 1e-12) return Math.sqrt(dot(r, r));
  if (a < 1e-12) {
    s = 0;
    t = clamp01(f / e);
  } else {
    const c = dot(d1, r);
    if (e < 1e-12) {
      t = 0;
      s = clamp01(-c / a);
    } else {
      const b = dot(d1, d2);
      const den = a * e - b * b;
      s = den > 1e-12 ? clamp01((b * f - c * e) / den) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp01(-c / a);
      } else if (t > 1) {
        t = 1;
        s = clamp01((b - c) / a);
      }
    }
  }
  const c1 = [p1[0] + d1[0] * s, p1[1] + d1[1] * s, p1[2] + d1[2] * s];
  const c2 = [p2[0] + d2[0] * t, p2[1] + d2[1] * t, p2[2] + d2[2] * t];
  const d = sub(c1, c2);
  return Math.sqrt(dot(d, d));
}

// Overlaps between bones of different fingers, deepest first:
// [{ a, b, depth }] with a, b finger keys and depth in m. pts: 21 points
// ([x, y, z] or {x, y, z}) in meters. scale: the hand's size against an
// average adult's (radii scale with it).
export function overlaps(pts, scale = 1, min = 0) {
  const P = pts.map((p) => (Array.isArray(p) ? p : [p.x, p.y, p.z]));
  const out = [];
  for (let i = 0; i < KEYS.length; i++) {
    for (let j = i + 1; j < KEYS.length; j++) {
      const a = KEYS[i];
      const b = KEYS[j];
      const reach = (RADIUS[a] + RADIUS[b]) * scale;
      let deepest = 0;
      let bones = null;
      BONES[a].forEach(([s0, s1], i) => BONES[b].forEach(([t0, t1], j) => {
        const d = reach - segDist(P[s0], P[s1], P[t0], P[t1]);
        if (d > deepest) [deepest, bones] = [d, [i, j]];
      }));
      if (deepest > min) out.push({ a, b, depth: deepest, bones });
    }
  }
  return out.sort((x, y) => y.depth - x.depth);
}

// The palm as a slab: points of a finger may not sink into it. frame: wrist,
// index and pinky knuckles and the middle knuckle ([x, y, z]), and the palm
// side's direction (unit, toward where fingers fold). FRONT: from the bones'
// plane to the palm's skin; BACK: to the back of the hand's skin (m, adult).
export const PALM_FRONT = 0.012;
export const PALM_BACK = 0.012;
export function palmFrame(wrist, index, pinky, middle, toPalm) {
  const up = sub(middle, wrist);
  const L = Math.sqrt(dot(up, up));
  const v = up.map((c) => c / L);
  const nn = toPalm;
  // across = v x n, then re-orthogonalised
  let u = [v[1] * nn[2] - v[2] * nn[1], v[2] * nn[0] - v[0] * nn[2], v[0] * nn[1] - v[1] * nn[0]];
  const ul = Math.sqrt(dot(u, u)) || 1;
  u = u.map((c) => c / ul);
  const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const s = dot(n, nn) < 0 ? -1 : 1;
  const a1 = dot(sub(index, wrist), u);
  const a2 = dot(sub(pinky, wrist), u);
  return { o: wrist, u, v, n: n.map((c) => c * s), L, lo: Math.min(a1, a2) - 0.005, hi: Math.max(a1, a2) + 0.005 };
}
// How deep (m) a ball of radius r at p sits inside the palm (0 outside).
// Only the palm's middle (20-90% from wrist to knuckles): the knuckles
// themselves are where the fingers start.
export function palmDepth(p, r, f, scale = 1) {
  const d = sub(p, f.o);
  const a = dot(d, f.u);
  const b = dot(d, f.v) / f.L;
  if (a < f.lo || a > f.hi || b < 0.2 || b > 0.9) return 0;
  const h = dot(d, f.n);
  const front = PALM_FRONT * scale + r;
  const back = PALM_BACK * scale + r;
  if (h >= front || h <= -back) return 0;
  return front - h; // the way out is to the palm side
}

// One hand inside the other (clasped, stacked or interlaced hands): finger
// bones of A against finger bones of B, and each hand's finger joints against
// the other's palm slab (left by whichever face is nearer). A, B: 21 points
// each; fa, fb: their palmFrame()s. Returns the overlaps deeper than min.
export function handOverlaps(A, B, fa, fb, scale = 1, min = 0) {
  const PA = A.map((p) => (Array.isArray(p) ? p : [p.x, p.y, p.z]));
  const PB = B.map((p) => (Array.isArray(p) ? p : [p.x, p.y, p.z]));
  const out = [];
  for (const a of KEYS) {
    for (const b of KEYS) {
      const reach = (RADIUS[a] + RADIUS[b]) * scale;
      let deepest = 0;
      let bones = null;
      BONES[a].forEach(([s0, s1], i) => BONES[b].forEach(([t0, t1], j) => {
        const d = reach - segDist(PA[s0], PA[s1], PB[t0], PB[t1]);
        if (d > deepest) [deepest, bones] = [d, [i, j]];
      }));
      if (deepest > min) out.push({ kind: 'finger', a, b, depth: deepest, bones });
    }
  }
  const inPalm = (P, f, who) => {
    for (const k of KEYS) {
      let deepest = 0;
      for (const [s0, s1] of BONES[k]) for (const i of [s1, s0]) deepest = Math.max(deepest, slabDepth(P[i], RADIUS[k] * scale, f, scale));
      if (deepest > min) out.push({ kind: 'palm', a: who === 'a' ? k : 'palm', b: who === 'a' ? 'palm' : k, depth: deepest });
    }
  };
  inPalm(PA, fb, 'a');
  inPalm(PB, fa, 'b');
  return out.sort((x, y) => y.depth - x.depth);
}

// Like palmDepth, but the way out is through the nearer face (a hand coming
// from either side).
function slabDepth(p, r, f, scale) {
  const d = sub(p, f.o);
  const a = dot(d, f.u);
  const b = dot(d, f.v) / f.L;
  if (a < f.lo || a > f.hi || b < 0.2 || b > 0.9) return 0;
  const h = dot(d, f.n);
  const front = PALM_FRONT * scale + r;
  const back = PALM_BACK * scale + r;
  if (h >= front || h <= -back) return 0;
  return Math.min(front - h, h + back);
}
