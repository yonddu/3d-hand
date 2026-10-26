// Model fitting: the whole finger is posed at once.
//
// The per-bone solver reads each bone's direction on its own, so one noisy
// point bends one joint wrongly and the rules on top (limits, coupling,
// contact) pull against it. Here, as in headset hand tracking, the hand model
// itself is fitted to the camera: every frame we look for the joint angles
// whose finger lands closest to the tracked points, while staying a real
// finger (inside its range, joints moving together, close to the last frame).
// Errors are spread over the chain the way a real finger would take them, and
// the picture plane counts more than depth, which a single camera only guesses.
import * as THREE from 'three';
import { limitsFor, sideSign } from './skeleton.js';
import { F as FINGER_SHAPES, T as THUMB_SHAPES } from './shapes.js';
import { segDist, palmDepth } from './collide.js';
export { ROOT };

const D2R = Math.PI / 180;
const Y = new THREE.Vector3(0, 1, 0);

// Weights (residuals are in palm lengths for points, radians for angles).
const W_DATA = 5; // a 1 cm miss weighs about as much as a 30 degree prior
const W_DEPTH = 0.1; // depth counts far less than the picture plane (a camera cannot measure it)
const W_LIMIT = 4; // past a joint limit: a hard wall, softened for the solver
const W_DIP = 0.9; // DIP follows PIP (one tendon)
const W_IP = 0.35; // thumb IP follows its MCP
const W_CONVERGE = 0.5; // bent fingers lean toward the middle of the hand
const W_ROLL = 1.2; // knuckles barely turn about their length
const W_TIME = 0.03; // stay near the last frame, lightly (the point filters already smooth)
const W_CLOSE = 0.8; // hidden joints follow the natural closing path
const W_SHAPE = 0.7; // hidden joints take the nearest basic shape
const W_PICTURE = 0.5; // the bend read from the picture (fingerCurl.js), per PICTURE_SD of its spread
const PICTURE_SD = 20; // degrees
const W_SOLID = 40; // per palm length of one finger's bone inside another's (fingers are solid)
const SQUEEZE = 0.005; // m two fingers may press into each other (skin gives; a folded thumb lies on the index)
const RIG_PALM = 0.09; // m, the scale solid overlaps are weighed on
const ROOT = 0.35; // fraction of a finger's first bone left out of the solid check
const RESEED = 30; // degrees between seeds before both are tried
const BENT_THUMB = 40; // degrees at the thumb's MCP and IP for the bent start
const BENT_GAIN = 0.2; // the bent fit must cost this much less to win (0.6 shook a thumb pinching a book)
const PIP_PER_MCP = 1.1; // closing a fist: PIP bends a little more than the knuckle
const DIP_PER_PIP = 0.67;
const IP_PER_MCP = 0.9;
const CONVERGE = { index: -5, middle: 0, ring: 5, pinky: 10 };
const ROLL_MAX = { thumb: [20, 12], finger: [12] };

// Parameter layout per finger: [jointIndex, kind] with kind flex/abd/roll.
function layout(key) {
  return key === 'thumb'
    ? [[0, 'flex'], [0, 'abd'], [0, 'roll'], [1, 'flex'], [1, 'abd'], [1, 'roll'], [2, 'flex']]
    : [[0, 'flex'], [0, 'abd'], [0, 'roll'], [1, 'flex'], [2, 'flex']];
}

const _e = new THREE.Euler();
const _qe = new THREE.Quaternion();
const _qr = new THREE.Quaternion();

// Local rotation of one bone from its angles (degrees; abd toward the thumb).
export function localFrom(link, side, flex, abd, roll) {
  _e.set(flex * D2R, 0, -abd * sideSign(side) * D2R, 'XZY');
  const q = link.restLocal.clone().multiply(_qe.setFromEuler(_e));
  if (roll) q.multiply(_qr.setFromAxisAngle(Y, roll * D2R));
  return q;
}

function anglesOf(theta, lay) {
  const a = [{ flex: 0, abd: 0, roll: 0 }, { flex: 0, abd: 0, roll: 0 }, { flex: 0, abd: 0, roll: 0 }];
  lay.forEach(([k, kind], i) => (a[k][kind] = theta[i]));
  return a;
}

// Joint positions (relative to the knuckle) for a set of angles.
function forward(theta, ctx) {
  const ang = anglesOf(theta, ctx.lay);
  let g = ctx.wristQ.clone();
  const pts = [];
  const p = new THREE.Vector3();
  const locals = [];
  for (let k = 0; k < 3; k++) {
    const local = localFrom(ctx.chain[k], ctx.side, ang[k].flex, ang[k].abd, ang[k].roll);
    locals.push(local);
    g = g.multiply(local);
    p.addScaledVector(Y.clone().applyQuaternion(g), ctx.len[k]);
    pts.push(p.clone());
  }
  return { pts, locals, ang };
}

function residuals(theta, ctx) {
  const { pts, ang } = forward(theta, ctx);
  const r = [];
  // Data: each joint against its tracked point.
  for (let k = 0; k < 3; k++) {
    const w = (W_DATA * ctx.conf[k] * (1 - 0.85 * ctx.hidden[k])) / ctx.palm;
    const d = pts[k].clone().sub(ctx.obs[k]);
    r.push(d.x * w, d.y * w, d.z * w * (ctx.depthW ?? W_DEPTH));
  }
  // Joint limits.
  for (let k = 0; k < 3; k++) {
    const [fMin, fMax, aMin, aMax] = ctx.limits[k];
    const over = (v, lo, hi) => (v < lo ? v - lo : v > hi ? v - hi : 0) * D2R * W_LIMIT;
    r.push(over(ang[k].flex, fMin, fMax), over(ang[k].abd, aMin, aMax));
  }
  // Motion model.
  const t = THREE.MathUtils.smoothstep(ang[0].flex, 15, 75);
  if (ctx.key === 'thumb') {
    r.push((ang[2].flex - IP_PER_MCP * ang[1].flex) * D2R * W_IP);
    r.push(ang[0].roll * D2R * W_ROLL * 0.5, ang[1].roll * D2R * W_ROLL);
  } else {
    const wd = W_DIP * (0.5 + 0.5 * THREE.MathUtils.smoothstep(ang[1].flex, 10, 60));
    r.push((ang[2].flex - DIP_PER_PIP * ang[1].flex) * D2R * wd);
    // Hidden middle joint: it bends the way a closing finger bends.
    const pip = Math.min(PIP_PER_MCP * Math.max(ang[0].flex, 0), 100);
    r.push((ang[1].flex - pip) * D2R * W_CLOSE * ctx.hidden[1]);
    r.push((ang[0].abd - CONVERGE[ctx.key] * t) * D2R * W_CONVERGE * t);
    // Roll is unreliable once the fingertip is hidden in a fist.
    r.push(ang[0].roll * D2R * W_ROLL * (1 + 4 * t));
  }
  // Hidden joints: the basic hand shape that the seen joints match best.
  if (ctx.shape) {
    theta.forEach((v, i) => {
      const k = ctx.lay[i][0];
      if (ctx.hidden[k] > 0) r.push((v - ctx.shape[i]) * D2R * W_SHAPE * ctx.hidden[k]);
    });
  }
  // Solid fingers: this finger's bones stay out of the others' (the thumb's
  // first bone, under the palm's skin, is not checked).
  if (ctx.walls) {
    const model = forward(theta, { ...ctx, len: ctx.rigLen }).pts;
    const pts3 = [[0, 0, 0], ...model.map((v) => [v.x, v.y, v.z])];
    for (let k = ctx.key === 'thumb' ? 1 : 0; k < 3; k++) {
      let deep = 0;
      // A finger's first bone from a third along: neighbouring knuckles sit
      // about two radii apart, so their roots always touch.
      const from = k === 0 ? pts3[1].map((v) => v * ROOT) : pts3[k];
      for (const w of ctx.walls) deep = Math.max(deep, w.reach - segDist(from, pts3[k + 1], w.p, w.q));
      r.push((Math.max(0, deep - SQUEEZE) / RIG_PALM) * W_SOLID);
    }
  }
  // The palm is solid too: the end joints stay out of it.
  if (ctx.palmSlab && ctx.rigBase) {
    const model = forward(theta, { ...ctx, len: ctx.rigLen }).pts;
    const b = ctx.rigBase;
    for (const k of [1, 2]) {
      const p = [model[k].x + b[0], model[k].y + b[1], model[k].z + b[2]];
      r.push((Math.max(0, palmDepth(p, ctx.radius, ctx.palmSlab) - SQUEEZE) / RIG_PALM) * W_SOLID);
    }
  }
  // The bends the picture shows, each as sure as the network says it is.
  if (ctx.picture) {
    for (let k = 0; k < 3; k++) {
      const { flex, sd } = ctx.picture[k];
      r.push((ang[k].flex - flex) * D2R * W_PICTURE * (PICTURE_SD / Math.max(sd, 5)));
    }
  }
  // Time: unsure tracking leans on the last frame.
  if (ctx.prev) {
    const unsure = 1 - Math.min(...ctx.conf);
    const w = W_TIME * (1 + unsure);
    theta.forEach((v, i) => r.push((v - ctx.prev[i]) * D2R * w));
  }
  return r;
}

// Damped Gauss-Newton with a numeric Jacobian; a finger has 5 to 7 angles.
function minimise(theta, ctx, iterations = 12) {
  let x = theta.slice();
  let r = residuals(x, ctx);
  let cost = r.reduce((s, v) => s + v * v, 0);
  let lambda = 1e-3;
  const n = x.length;
  const h = 0.05; // degrees
  for (let it = 0; it < iterations; it++) {
    const J = [];
    for (let i = 0; i < n; i++) {
      const xp = x.slice();
      xp[i] += h;
      const rp = residuals(xp, ctx);
      J.push(rp.map((v, j) => (v - r[j]) / h));
    }
    // (JᵀJ + λ diag) δ = -Jᵀr
    const A = Array.from({ length: n }, () => new Array(n).fill(0));
    const b = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = i; j < n; j++) {
        let s = 0;
        for (let m = 0; m < r.length; m++) s += J[i][m] * J[j][m];
        A[i][j] = A[j][i] = s;
      }
      let s = 0;
      for (let m = 0; m < r.length; m++) s += J[i][m] * r[m];
      b[i] = -s;
    }
    let improved = false;
    for (let tries = 0; tries < 4 && !improved; tries++) {
      const M = A.map((row, i) => row.map((v, j) => (i === j ? v * (1 + lambda) + 1e-9 : v)));
      const delta = solveLinear(M, b.slice());
      if (!delta) break;
      const xn = x.map((v, i) => v + THREE.MathUtils.clamp(delta[i], -30, 30));
      const rn = residuals(xn, ctx);
      const cn = rn.reduce((s, v) => s + v * v, 0);
      if (cn < cost) {
        x = xn;
        r = rn;
        cost = cn;
        lambda = Math.max(lambda / 3, 1e-6);
        improved = true;
      } else lambda *= 8;
    }
    if (!improved) break;
  }
  return x;
}

function solveLinear(A, b) {
  const n = b.length;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let i = c + 1; i < n; i++) if (Math.abs(A[i][c]) > Math.abs(A[p][c])) p = i;
    if (Math.abs(A[p][c]) < 1e-12) return null;
    [A[c], A[p]] = [A[p], A[c]];
    [b[c], b[p]] = [b[p], b[c]];
    for (let i = c + 1; i < n; i++) {
      const f = A[i][c] / A[c][c];
      for (let j = c; j < n; j++) A[i][j] -= f * A[c][j];
      b[i] -= f * b[c];
    }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = b[i];
    for (let j = i + 1; j < n; j++) s -= A[i][j] * x[j];
    x[i] = s / A[i][i];
  }
  return x;
}

// Fit one finger. P: tracked points (rig orientation), wristQ: palm frame,
// conf: per-bone confidence, prev: last frame's angles for this finger or null.
// Returns { theta, locals, ang } (angles in degrees, abd toward the thumb).
// picture: this finger's joint bends read from the pixels ([{ flex, sd }] x3,
// fingerCurl.js) or null. solid: the other fingers' bones already placed,
// [{ p, q, reach }] (points in P's space, reach = the two radii summed), which
// this finger's bones must stay out of.
// The solid check runs on the hand model's own bones (rigBase: this finger's
// base from the wrist, rigLen: its bone lengths), the shape that is drawn
// and exported, not on the tracked points' lengths.
// palmSlab: the palm on the model (collide.js palmFrame, from the wrist),
// which the finger's end joints may not sink into.
export function fitFinger({ finger, chain, side, P, wristQ, conf, palm, prev, start, useLimits, occluded = null, prior = null, picture = null, solid = null, radius = 0, rigBase = null, rigLen = null, palmSlab = null }) {
  const J = finger.joints;
  const base = P[J[0]];
  const obs = [1, 2, 3].map((k) => P[J[k]].clone().sub(base));
  const len = [0, 1, 2].map((k) => P[J[k + 1]].distanceTo(P[J[k]]));
  const lay = layout(finger.key);
  const limits = [0, 1, 2].map((k) => (useLimits ? limitsFor(finger.key, k) : [-180, 180, -180, 180]));
  const rollMax = finger.key === 'thumb' ? ROLL_MAX.thumb : ROLL_MAX.finger;
  const hidden = hiddenJoints(finger, P, wristQ, occluded);
  // A grip guessed from the whole hand (gripPrior.js) when there is one, else the
  // basic shape this finger's seen joints match.
  const shape = Math.max(...hidden) < 0.05 ? null : prior || nearestShape(finger.key, start, hidden);
  // Obstacles relative to this finger's base on the model.
  const walls = solid && rigBase ? solid.map(({ p, q, reach }) => ({ p: [p[0] - rigBase[0], p[1] - rigBase[1], p[2] - rigBase[2]], q: [q[0] - rigBase[0], q[1] - rigBase[1], q[2] - rigBase[2]], reach: reach + radius })) : null;
  const ctx = { key: finger.key, chain, side, wristQ, obs, len, conf, palm, lay, limits, prev, hidden, shape, picture, walls, rigLen, rigBase, palmSlab, radius };
  // Start from the last frame, or from the fresh reading when that already
  // fits better (the hand moved fast, or was just found again).
  const cost = (x) => residuals(x, ctx).reduce((s, v) => s + v * v, 0);
  const seed = prev && cost(prev) <= cost(start) ? prev : start;
  let theta = minimise(seed.slice(), ctx);
  // When the two seeds are far apart, the one that started worse may still
  // end better: after a one-frame glitch the last frame can sit in a curled
  // pose the solver cannot climb out of (fingers stayed curled for several
  // frames after a bad reading while the palm turned).
  // Measured from where the fit ended, not where it began: two near seeds can
  // still slide into the other answer, and checking only the seeds let the
  // thumb swap between a folded and an open fit every other frame (v67, user
  // take thumb_fold_07-33: folded thumb shown opening).
  const other = seed === start ? prev : start;
  if (other && Math.max(...other.map((v, i) => Math.abs(v - theta[i]))) > RESEED) {
    const alt = minimise(other.slice(), ctx);
    // The two can fit the picture equally (a finger curled toward the camera
    // looks like a straight one leaning away); the depth the points were
    // lifted with (lift.js chose it from the hand's shape) settles it.
    const full = (x) => residuals(x, { ...ctx, depthW: 1 }).reduce((t, v) => t + v * v, 0);
    if (full(alt) < full(theta)) theta = alt;
  }
  // A straight thumb and a thumb bent at both joints can sit in two separate
  // dips of the fit, and both seeds (last frame, fresh reading) may start in
  // the straight one: the fresh reading's thumb angles stay near zero on a
  // folded thumb seen from above. Try the bent start too and keep it when it
  // clearly fits better (v67, user take thumb_fold_07-33).
  if (finger.key === 'thumb' && theta[3] + theta[6] < BENT_THUMB) {
    const bent = theta.slice();
    bent[3] = bent[6] = BENT_THUMB;
    const alt = minimise(bent, ctx);
    if (cost(alt) < BENT_GAIN * cost(theta)) theta = alt;
  }
  // Hard walls after the soft fit (limits) and the roll range.
  theta = theta.map((v, i) => {
    const [k, kind] = lay[i];
    if (kind === 'roll') return THREE.MathUtils.clamp(v, -rollMax[k], rollMax[k]);
    if (!useLimits) return v;
    const [fMin, fMax, aMin, aMax] = limits[k];
    return kind === 'flex' ? THREE.MathUtils.clamp(v, fMin - 3, fMax + 3) : THREE.MathUtils.clamp(v, aMin - 2, aMax + 2);
  });
  const { locals, ang } = forward(theta, ctx);
  // The model's joints from the wrist, base to tip, for the fingers fitted after.
  const joints = rigBase && rigLen ? [rigBase.slice(), ...forward(theta, { ...ctx, len: rigLen }).pts.map((v) => [v.x + rigBase[0], v.y + rigBase[1], v.z + rigBase[2]])] : null;
  return { theta, locals, ang, joints };
}

// How hidden each joint of a finger is (0 seen .. 1 a guess), base to tip.
export function hiddenJoints(finger, P, wristQ, occluded = null) {
  const J = finger.joints;
  const base = P[J[0]];
  const obs0 = P[J[1]].clone().sub(base);
  // Which tracked points are guesses. Seen from the back of the hand (the
  // first-person view), a finger bent at the knuckle hides its last two
  // joints inside the fist; the camera has no picture of them and the tracker
  // tends to guess them half open. The knuckle and first bone stay visible,
  // so their bend is trusted and the hidden joints follow it along the path a
  // closing finger takes, instead of the guess.
  const palmN = new THREE.Vector3(0, 0, 1).applyQuaternion(wristQ);
  const along = new THREE.Vector3(0, 1, 0).applyQuaternion(wristQ);
  const knuckleBend = Math.atan2(obs0.dot(palmN), obs0.dot(along)) / D2R;
  // Any view, not only the back of the hand: on rendered hands with known
  // poses (tools/synth-eval.mjs) MediaPipe put the end joints of a finger
  // bent past 80 deg a third of a palm too open even facing the camera.
  const tucked = finger.key === 'thumb' ? 0 : THREE.MathUtils.smoothstep(knuckleBend, 35, 70);
  // Joints behind another finger or the palm (seen in the picture, lift.js).
  const occ = (k) => (occluded ? occluded[J[k + 1]] || 0 : 0);
  return [occ(0), Math.max(tucked, occ(1)), Math.max(tucked, occ(2))];
}

// The basic shape (shapes.js) closest to this reading, judged on the seen
// joints only; null when every joint is seen.
function nearestShape(key, theta, hidden) {
  if (Math.max(...hidden) < 0.05) return null;
  const lay = layout(key);
  const shapes = key === 'thumb'
    ? Object.values(THUMB_SHAPES)
    : Object.values(FINGER_SHAPES).map(([m, p, d]) => [m, theta[1], 0, p, d]);
  let best = null;
  let bestCost = Infinity;
  for (const sh of shapes) {
    let c = 0;
    lay.forEach(([k, kind], i) => {
      if (kind === 'roll') return;
      c += (1 - hidden[k]) * (theta[i] - sh[i]) ** 2;
    });
    if (c < bestCost) {
      bestCost = c;
      best = sh;
    }
  }
  return best;
}

export function startAngles(key) {
  return new Array(layout(key).length).fill(0);
}
