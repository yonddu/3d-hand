// Clean a recorded take once the whole clip is known.
//
// Frame by frame, the tracker sometimes misreads a hand for a moment: the palm
// reads as flipped for a few frames, one finger joint jumps 60 degrees and
// back, the hand drops out for two frames. Live, nothing can be done until it
// has happened. A recording is processed after filming, so every frame can be
// checked against the frames on both sides of it, as a person scrubbing the
// clip would: a pose that the frames before and after both disagree with is a
// misread, not motion. Misreads are replaced from their neighbours, short
// dropouts are filled, and the motion is smoothed forward and backward so it
// does not lag.

const SIDES = ['left', 'right'];
const MIN_RUN = 4; // a hand seen for fewer frames than this is a false find
const MAX_GAP = 8; // dropouts up to this many frames are filled in
const WRIST_WIN = 4; // frames on each side used to judge the palm
const WRIST_FLIP = 50; // degrees from its neighbours: a misread palm
const WRIST_JUMP = 0.08; // metres from its neighbours: a misread position
const MAX_SWAP = 24; // a hand briefly read as the other hand, up to this many frames
const SWAP_NEAR = 0.08; // metres: where the other hand just was
const BONE_WIN = 3;
const BONE_SPIKE = 30; // degrees
const SIGMA = { wrist: 1.6, bone: 1.3, pos: 2.5 }; // smoothing, in frames

const isQuat = (k) => k.endsWith('Q');
const POS_KEYS = ['wrist', 'elbow', 'shoulder'];

function qdot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
}
function qangle(a, b) {
  return (2 * Math.acos(Math.min(1, Math.abs(qdot(a, b))))) / (Math.PI / 180);
}
function qnorm(q) {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return q.map((v) => v / l);
}
function qslerp(a, b, u) {
  let d = qdot(a, b);
  const s = d < 0 ? -1 : 1;
  d = Math.abs(d);
  if (d > 0.9995) return qnorm(a.map((v, i) => v + (s * b[i] - v) * u));
  const th = Math.acos(d);
  const wa = Math.sin((1 - u) * th) / Math.sin(th);
  const wb = (s * Math.sin(u * th)) / Math.sin(th);
  return a.map((v, i) => v * wa + b[i] * wb);
}
const vlerp = (a, b, u) => a.map((v, i) => v + (b[i] - v) * u);

// Weighted mean of nearby quaternions (all turned to the centre's hemisphere).
function qmean(qs, ws, centre) {
  const m = [0, 0, 0, 0];
  qs.forEach((q, j) => {
    const s = qdot(q, centre) < 0 ? -ws[j] : ws[j];
    for (let i = 0; i < 4; i++) m[i] += q[i] * s;
  });
  return qnorm(m);
}
// The one quaternion closest to all the others (a median for rotations).
function qmedoid(qs) {
  let best = qs[0];
  let bestCost = Infinity;
  for (const a of qs) {
    let c = 0;
    for (const b of qs) c += qangle(a, b);
    if (c < bestCost) {
      bestCost = c;
      best = a;
    }
  }
  return best;
}

function cloneHand(h) {
  return JSON.parse(JSON.stringify(h));
}

// Hand pose between two recorded hands (u from 0 at a to 1 at b).
export function lerpHand(a, b, u) {
  const h = cloneHand(u < 0.5 ? a : b);
  for (const k of Object.keys(h)) {
    if (!Array.isArray(a[k]) || !Array.isArray(b[k]) || a[k].length !== b[k].length) continue;
    if (k === 'landmarks') continue;
    h[k] = a[k].length === 4 && isQuat(k) ? qslerp(a[k], b[k], u) : vlerp(a[k], b[k], u);
  }
  for (const n of Object.keys(h.fingers || {})) {
    if (a.fingers[n] && b.fingers[n]) h.fingers[n] = qslerp(a.fingers[n], b.fingers[n], u);
  }
  return h;
}

// Runs of consecutive frames in which the hand is present: [start, end].
function runsOf(hands) {
  const runs = [];
  let s = -1;
  hands.forEach((h, i) => {
    if (h && s < 0) s = i;
    if (!h && s >= 0) {
      runs.push([s, i - 1]);
      s = -1;
    }
  });
  if (s >= 0) runs.push([s, hands.length - 1]);
  return runs;
}

function cleanSide(hands, swapped) {
  // 1. Short dropouts are filled, short false finds removed.
  let runs = runsOf(hands);
  for (let r = 1; r < runs.length; r++) {
    const [, e0] = runs[r - 1];
    const [s1] = runs[r];
    let fromSwap = true;
    for (let i = e0 + 1; i < s1; i++) fromSwap = fromSwap && swapped[i];
    if (s1 - e0 - 1 <= (fromSwap ? MAX_SWAP : MAX_GAP)) {
      for (let i = e0 + 1; i < s1; i++) hands[i] = lerpHand(hands[e0], hands[s1], (i - e0) / (s1 - e0));
    }
  }
  for (const [s, e] of runsOf(hands)) if (e - s + 1 < MIN_RUN) for (let i = s; i <= e; i++) hands[i] = null;
  runs = runsOf(hands);

  for (const [s, e] of runs) {
    // 2. Misread palms: a palm turned far from where the frames before AND
    // the frames after say it is, while those two agree with each other (or
    // a hand jumped away from both). Fast real motion passes, since there
    // the frames before and after disagree. Such a frame is rebuilt from the
    // good frames on both sides.
    const bad = [];
    const medPos = (win) => [0, 1, 2].map((c) => {
      const v = win.map((h) => h.wrist[c]).sort((p, q) => p - q);
      return v[v.length >> 1];
    });
    const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
    for (let i = s; i <= e; i++) {
      const before = [];
      const after = [];
      for (let j = Math.max(s, i - WRIST_WIN); j < i; j++) before.push(hands[j]);
      for (let j = i + 1; j <= Math.min(e, i + WRIST_WIN); j++) after.push(hands[j]);
      if (!before.length || !after.length) {
        bad[i] = false;
        continue;
      }
      const qb = qmedoid(before.map((h) => h.handQ));
      const qa = qmedoid(after.map((h) => h.handQ));
      const q = hands[i].handQ;
      const turned = qangle(q, qb) > WRIST_FLIP && qangle(q, qa) > WRIST_FLIP && qangle(qa, qb) < WRIST_FLIP;
      const pb = medPos(before);
      const pa = medPos(after);
      const p = hands[i].wrist;
      const jumped = dist(p, pb) > WRIST_JUMP && dist(p, pa) > WRIST_JUMP && dist(pa, pb) < WRIST_JUMP;
      bad[i] = turned || jumped;
    }
    const good = [];
    for (let i = s; i <= e; i++) if (!bad[i]) good.push(i);
    if (good.length) {
      const fixed = hands.slice();
      for (let i = s; i <= e; i++) {
        if (!bad[i]) continue;
        let a = -1;
        let b = -1;
        for (const g of good) {
          if (g < i) a = g;
          else if (b < 0) b = g;
        }
        if (a < 0) fixed[i] = cloneHand(hands[b]);
        else if (b < 0) fixed[i] = cloneHand(hands[a]);
        else fixed[i] = lerpHand(hands[a], hands[b], (i - a) / (b - a));
      }
      for (let i = s; i <= e; i++) hands[i] = fixed[i];
    }

    // 3. One joint jumping away and back: replaced by its neighbours' median.
    const names = Object.keys(hands[s].fingers || {});
    for (const n of names) {
      const orig = [];
      for (let i = s; i <= e; i++) orig[i] = hands[i].fingers[n];
      for (let i = s; i <= e; i++) {
        const win = [];
        for (let j = Math.max(s, i - BONE_WIN); j <= Math.min(e, i + BONE_WIN); j++) if (orig[j]) win.push(orig[j]);
        const med = qmedoid(win);
        if (qangle(orig[i], med) > BONE_SPIKE) hands[i].fingers[n] = med.slice();
      }
    }

    // 4. Smoothing, forward and backward (no lag): a short Gaussian window.
    const smoothQ = (get, set, sigma) => {
      const src = [];
      for (let i = s; i <= e; i++) src[i] = get(hands[i]);
      const R = Math.ceil(sigma * 2.5);
      for (let i = s; i <= e; i++) {
        if (!src[i]) continue;
        const qs = [];
        const ws = [];
        for (let j = Math.max(s, i - R); j <= Math.min(e, i + R); j++) {
          if (!src[j]) continue;
          qs.push(src[j]);
          ws.push(Math.exp(-((j - i) ** 2) / (2 * sigma * sigma)));
        }
        set(hands[i], qmean(qs, ws, src[i]));
      }
    };
    const smoothV = (key, sigma) => {
      const src = [];
      for (let i = s; i <= e; i++) src[i] = Array.isArray(hands[i][key]) ? hands[i][key].slice() : null;
      const R = Math.ceil(sigma * 2.5);
      for (let i = s; i <= e; i++) {
        if (!src[i]) continue;
        const m = src[i].map(() => 0);
        let wsum = 0;
        for (let j = Math.max(s, i - R); j <= Math.min(e, i + R); j++) {
          if (!src[j] || src[j].length !== m.length) continue;
          const w = Math.exp(-((j - i) ** 2) / (2 * sigma * sigma));
          src[j].forEach((v, c) => (m[c] += v * w));
          wsum += w;
        }
        hands[i][key] = m.map((v) => v / wsum);
      }
    };
    for (const k of Object.keys(hands[s])) {
      if (isQuat(k) && Array.isArray(hands[s][k]) && hands[s][k].length === 4) {
        smoothQ((h) => (Array.isArray(h[k]) ? h[k] : null), (h, q) => (h[k] = q), SIGMA.wrist);
      }
    }
    for (const k of POS_KEYS) smoothV(k, SIGMA.pos);
    for (const n of names) smoothQ((h) => h.fingers[n] || null, (h, q) => (h.fingers[n] = q), SIGMA.bone);
  }
  return hands;
}

// frames: [{ t, hands: { left, right } }] in time order, evenly spaced.
// Returns new frames; the input is left as it was.
export function cleanTake(frames) {
  const out = frames.map((f) => ({ ...f, hands: { ...f.hands } }));
  const swapped = { left: out.map(() => false), right: out.map(() => false) };
  // 0. The tracker sometimes names one hand as the other for a few frames:
  // a short run of one hand, alone in the frame, where the other hand was
  // just before and after it. Those frames belong to the other hand, whose
  // gap is then filled from its own frames.
  for (const side of SIDES) {
    const other = side === 'left' ? 'right' : 'left';
    const hs = out.map((f) => f.hands[side]);
    const os = out.map((f) => f.hands[other]);
    for (const [s, e] of runsOf(hs)) {
      if (e - s + 1 >= MAX_SWAP) continue;
      let alone = true;
      for (let i = s; i <= e; i++) alone = alone && !os[i];
      if (!alone) continue;
      let a = s - 1;
      while (a >= 0 && !os[a] && s - a <= MAX_SWAP) a--;
      let b = e + 1;
      while (b < out.length && !os[b] && b - e <= MAX_SWAP) b++;
      if (a < 0 || b >= out.length || !os[a] || !os[b] || b - a - 1 > MAX_SWAP) continue;
      const near = (h, o) => Math.hypot(...h.wrist.map((v, c) => v - o.wrist[c])) < SWAP_NEAR;
      if (!near(hs[s], os[a]) || !near(hs[e], os[b])) continue;
      for (let i = s; i <= e; i++) out[i].hands[side] = null;
      for (let i = a + 1; i < b; i++) swapped[other][i] = true;
    }
  }
  for (const side of SIDES) {
    const hands = cleanSide(out.map((f) => (f.hands[side] ? cloneHand(f.hands[side]) : null)), swapped[side]);
    hands.forEach((h, i) => (out[i].hands[side] = h));
  }
  return out;
}
