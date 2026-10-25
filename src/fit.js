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

const D2R = Math.PI / 180;
const Y = new THREE.Vector3(0, 1, 0);

// Weights (residuals are in palm lengths for points, radians for angles).
const W_DEPTH = 0.45; // depth counts less than the picture plane
const W_LIMIT = 4; // past a joint limit: a hard wall, softened for the solver
const W_DIP = 0.9; // DIP follows PIP (one tendon)
const W_IP = 0.35; // thumb IP follows its MCP
const W_CONVERGE = 0.5; // bent fingers lean toward the middle of the hand
const W_ROLL = 1.2; // knuckles barely turn about their length
const W_TIME = 0.12; // stay near the last frame; more when tracking is unsure
const W_CLOSE = 0.8; // hidden joints follow the natural closing path
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
    const w = (ctx.conf[k] * (1 - 0.85 * ctx.hidden[k])) / ctx.palm;
    const d = pts[k].clone().sub(ctx.obs[k]);
    r.push(d.x * w, d.y * w, d.z * w * W_DEPTH);
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
  // Time: unsure tracking leans on the last frame.
  if (ctx.prev) {
    const unsure = 1 - Math.min(...ctx.conf);
    const w = W_TIME * (1 + 6 * unsure);
    theta.forEach((v, i) => r.push((v - ctx.prev[i]) * D2R * w));
  }
  return r;
}

// Damped Gauss-Newton with a numeric Jacobian; a finger has 5 to 7 angles.
function minimise(theta, ctx, iterations = 8) {
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
export function fitFinger({ finger, chain, side, P, wristQ, conf, palm, prev, start, useLimits }) {
  const J = finger.joints;
  const base = P[J[0]];
  const obs = [1, 2, 3].map((k) => P[J[k]].clone().sub(base));
  const len = [0, 1, 2].map((k) => P[J[k + 1]].distanceTo(P[J[k]]));
  const lay = layout(finger.key);
  const limits = [0, 1, 2].map((k) => (useLimits ? limitsFor(finger.key, k) : [-180, 180, -180, 180]));
  const rollMax = finger.key === 'thumb' ? ROLL_MAX.thumb : ROLL_MAX.finger;
  // Which tracked points are guesses. Seen from the back of the hand (the
  // first-person view), a finger bent at the knuckle hides its last two
  // joints inside the fist; the camera has no picture of them and the tracker
  // tends to guess them half open. The knuckle and first bone stay visible,
  // so their bend is trusted and the hidden joints follow it along the path a
  // closing finger takes, instead of the guess.
  const palmN = new THREE.Vector3(0, 0, 1).applyQuaternion(wristQ);
  const along = new THREE.Vector3(0, 1, 0).applyQuaternion(wristQ);
  const backFacing = THREE.MathUtils.smoothstep(-palmN.z, 0.15, 0.5); // +z points at the camera
  const knuckleBend = Math.atan2(obs[0].dot(palmN), obs[0].dot(along)) / D2R;
  const tucked = finger.key === 'thumb' ? 0 : backFacing * THREE.MathUtils.smoothstep(knuckleBend, 35, 70);
  const hidden = [0, tucked, tucked];
  const ctx = { key: finger.key, chain, side, wristQ, obs, len, conf, palm, lay, limits, prev, hidden };
  // Start from the last frame, or from the fresh reading when that already
  // fits better (the hand moved fast, or was just found again).
  const cost = (x) => residuals(x, ctx).reduce((s, v) => s + v * v, 0);
  const seed = prev && cost(prev) <= cost(start) ? prev : start;
  let theta = minimise(seed.slice(), ctx);
  // Hard walls after the soft fit (limits) and the roll range.
  theta = theta.map((v, i) => {
    const [k, kind] = lay[i];
    if (kind === 'roll') return THREE.MathUtils.clamp(v, -rollMax[k], rollMax[k]);
    if (!useLimits) return v;
    const [fMin, fMax, aMin, aMax] = limits[k];
    return kind === 'flex' ? THREE.MathUtils.clamp(v, fMin - 3, fMax + 3) : THREE.MathUtils.clamp(v, aMin - 2, aMax + 2);
  });
  const { locals, ang } = forward(theta, ctx);
  return { theta, locals, ang };
}

export function startAngles(key) {
  return new Array(layout(key).length).fill(0);
}
