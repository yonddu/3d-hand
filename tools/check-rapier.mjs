// Cross-check of src/collide.js against Rapier (@dimforge/rapier3d-compat,
// Apache-2.0, a dev dependency only: the app never loads it). The same
// capsules and palm box are handed to Rapier's contact query, and the depths
// compared, for finger bone against finger bone (segDist, used by overlaps
// and handOverlaps) and finger bone against the other hand's palm box
// (slabDepth). They should agree to 0.2 mm.
//
// A bone is handed to Rapier as a row of balls along it (one every 0.5 mm, then
// 50 times finer around the deepest), and the deepest ball counts: Rapier's own capsule query in 0.21.0
// gave wrong depths in some cases (two bone lines crossing: 0 where both
// brute force and its own balls say 15 mm; a bone clipping a box corner:
// 20.6 mm where both say 4.7 mm). Its ball queries are exact, and the
// deepest ball is the capsule's depth as collide.js means it (deepest point,
// its nearest way out). How often the capsule query disagrees with its own
// balls is printed, as a note on Rapier, not a failure.
// Made-up cases first (seeded, the same every run), then every frame of the
// saved takes (GLB animation as the user sees it, tools/glb-pierce.mjs).
//
//   node tools/check-rapier.mjs [takes folder]
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { BONES, RADIUS, segDist, slabDepth, palmFrame, PALM_FRONT, PALM_BACK, PALM_BAND } from '../src/collide.js';
import { measureGlb } from './glb-pierce.mjs';

await RAPIER.init();
const folder = process.argv[2] || '/mnt/project-files/hand-motion-studio/takes/';
const TOL = 0.0002; // m: 0.2 mm
const PIERCE = 0.008; // as tools/replay.mjs and glb-pierce.mjs
const KEYS = Object.keys(BONES);
let fails = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) fails++;
};

// A capsule around segment p-q (Rapier's capsule lies along its local y).
const Y = new THREE.Vector3(0, 1, 0);
function capsule(p, q, r) {
  const a = new THREE.Vector3(...p);
  const b = new THREE.Vector3(...q);
  const d = b.clone().sub(a);
  const len = d.length();
  const rot = len > 1e-9 ? new THREE.Quaternion().setFromUnitVectors(Y, d.clone().normalize()) : new THREE.Quaternion();
  const c = a.add(b).multiplyScalar(0.5);
  return { shape: new RAPIER.Capsule(Math.max(len / 2, 1e-6), r), pos: { x: c.x, y: c.y, z: c.z }, rot: { x: rot.x, y: rot.y, z: rot.z, w: rot.w } };
}
// The palm box slabDepth uses, from a palmFrame.
function palmBox(f, scale = 1) {
  const half = [(f.hi - f.lo) / 2, ((PALM_BAND[1] - PALM_BAND[0]) * f.L) / 2, ((PALM_FRONT + PALM_BACK) * scale) / 2];
  const mid = [(f.hi + f.lo) / 2, ((PALM_BAND[1] + PALM_BAND[0]) * f.L) / 2, ((PALM_FRONT - PALM_BACK) * scale) / 2];
  const u = new THREE.Vector3(...f.u);
  const v = new THREE.Vector3(...f.v);
  const n = new THREE.Vector3(...f.n);
  const c = new THREE.Vector3(...f.o).addScaledVector(u, mid[0]).addScaledVector(v, mid[1]).addScaledVector(n, mid[2]);
  // A box is the same mirrored: a right-handed turn of the same axes.
  const rot = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(u, v, u.clone().cross(v)));
  return { shape: new RAPIER.Cuboid(...half), pos: { x: c.x, y: c.y, z: c.z }, rot: { x: rot.x, y: rot.y, z: rot.z, w: rot.w } };
}
// Rapier's depth (m, 0 when apart).
function depth(A, B) {
  const c = A.shape.contactShape(A.pos, A.rot, B.shape, B.pos, B.rot, 0);
  return c && c.distance < 0 ? -c.distance : 0;
}
const I = { x: 0, y: 0, z: 0, w: 1 };
const balls = {};
const ballAt = (r, x) => ({ shape: (balls[r] ||= new RAPIER.Ball(r)), pos: { x: x[0], y: x[1], z: x[2] }, rot: I });
const lerp = (p, q, t) => p.map((v, k) => v + (q[k] - v) * t);
const STEP = 0.0005; // m between balls, then 50 times finer around the deepest
// Deepest of f(t) over t in 0..1 for a bone of length len: every STEP, then
// finer around the best.
function deepest(len, f) {
  const n = Math.max(2, Math.ceil(len / STEP));
  let bt = 0;
  let best = -Infinity;
  for (let i = 0; i <= n; i++) {
    const v = f(i / n);
    if (v > best) [best, bt] = [v, i / n];
  }
  for (let i = -50; i <= 50; i++) {
    const t = Math.min(1, Math.max(0, bt + i / (50 * n)));
    best = Math.max(best, f(t));
  }
  return best;
}
const len = (p, q) => Math.hypot(...q.map((v, k) => v - p[k]));
// A bone p-q of radius r as a row of Rapier balls against another shape.
function rowDepth(p, q, r, B) {
  return Math.max(0, deepest(len(p, q), (t) => {
    const A = ballAt(r, lerp(p, q, t));
    return depth(A, B);
  }));
}
// Bone against bone: a row of balls on each (the capsule query is the one
// in doubt), every pair on a 1 mm grid, then a 20 x 20 finer grid around the
// deepest pair.
function rowRow(p1, q1, r1, p2, q2, r2) {
  const n1 = Math.max(2, Math.ceil(len(p1, q1) / 0.001));
  const n2 = Math.max(2, Math.ceil(len(p2, q2) / 0.001));
  const at = (s, t) => depth(ballAt(r1, lerp(p1, q1, s)), ballAt(r2, lerp(p2, q2, t)));
  let best = 0;
  let bs = 0;
  let bt = 0;
  for (let i = 0; i <= n1; i++) for (let j = 0; j <= n2; j++) {
    const v = at(i / n1, j / n2);
    if (v > best) [best, bs, bt] = [v, i / n1, j / n2];
  }
  for (let i = -20; i <= 20; i++) for (let j = -20; j <= 20; j++) {
    best = Math.max(best, at(Math.min(1, Math.max(0, bs + i / (20 * n1))), Math.min(1, Math.max(0, bt + j / (20 * n2)))));
  }
  return best;
}
let capsuleOff = 0;
let capsuleN = 0;
const noteCapsule = (native, row) => {
  capsuleN++;
  if (Math.abs(native - row) > TOL) capsuleOff++;
};

// Running tallies: largest gap, and how often one says "pierced" (> PIERCE)
// and the other not.
const tally = () => ({ n: 0, worst: 0, at: null, disagree: 0, hits: 0 });
const note = (t, ours, theirs, where) => {
  t.n++;
  const g = Math.abs(ours - theirs);
  if (g > t.worst) [t.worst, t.at] = [g, `${where}: ours ${(ours * 1000).toFixed(2)} mm, Rapier ${(theirs * 1000).toFixed(2)} mm`];
  if (ours > PIERCE !== theirs > PIERCE) t.disagree++;
  if (ours > PIERCE) t.hits++;
};
const show = (name, t) => console.log(`${name}: ${t.n} pairs, ${t.hits} pierced (> 8 mm), worst gap ${(t.worst * 1000).toFixed(3)} mm${t.at ? ` (${t.at})` : ''}, pierced by one only ${t.disagree}`);

// --- made-up cases -----------------------------------------------------------
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const pt = (s) => [(rnd() - 0.5) * s, (rnd() - 0.5) * s, (rnd() - 0.5) * s];
{
  const t = tally();
  for (let i = 0; i < 3000; i++) {
    const [a, b] = [KEYS[i % 5], KEYS[(i * 3 + 1) % 5]];
    const p1 = pt(0.06);
    const q1 = p1.map((v) => v + (rnd() - 0.5) * 0.05);
    const p2 = pt(0.06);
    const q2 = p2.map((v) => v + (rnd() - 0.5) * 0.05);
    const ours = Math.max(0, RADIUS[a] + RADIUS[b] - segDist(p1, q1, p2, q2));
    // Far apart: no need for the rows.
    if (ours === 0 && segDist(p1, q1, p2, q2) > RADIUS[a] + RADIUS[b] + 0.002) continue;
    const row = rowRow(p1, q1, RADIUS[a], p2, q2, RADIUS[b]);
    noteCapsule(depth(capsule(p1, q1, RADIUS[a]), capsule(p2, q2, RADIUS[b])), row);
    note(t, ours, row, `made-up ${a}-${b} #${i}`);
  }
  show('made-up finger-finger', t);
  check(t.worst < TOL && !t.disagree, 'finger against finger: collide.js = Rapier (made-up)');
}
{
  const t = tally();
  // A palm 95 mm long, knuckles 70 mm apart, turned and placed anyhow.
  for (let i = 0; i < 3000; i++) {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rnd() * 6.3, rnd() * 6.3, rnd() * 6.3));
    const at = (x, y, z) => new THREE.Vector3(x, y, z).applyQuaternion(q).add(new THREE.Vector3(0, 0, -0.4)).toArray();
    const f = palmFrame(at(0, 0, 0), at(0.035, 0.095, 0), at(-0.035, 0.09, 0), at(0, 0.095, 0), new THREE.Vector3(0, 0, 1).applyQuaternion(q).toArray());
    const local = [(rnd() - 0.5) * 0.12, rnd() * 0.12, (rnd() - 0.5) * 0.06];
    const p = at(...local);
    const qq = at(...local.map((v) => v + (rnd() - 0.5) * 0.05));
    const r = RADIUS[KEYS[i % 5]];
    const ours = slabDepth(p, qq, r, f);
    const box = palmBox(f);
    const row = rowDepth(p, qq, r, box);
    noteCapsule(depth(capsule(p, qq, r), box), row);
    note(t, ours, row, `made-up palm #${i}`);
  }
  show('made-up finger-palm', t);
  check(t.worst < TOL && !t.disagree, 'finger against palm: collide.js = Rapier (made-up)');
}

// --- saved takes ---------------------------------------------------------------
const glbs = fs.existsSync(folder) ? fs.readdirSync(folder).filter((f) => f.endsWith('.glb')) : [];
if (!glbs.length) console.log(`no takes in ${folder}: skipped`);
else {
  const ff = tally();
  const fp = tally();
  for (const g of glbs) {
    measureGlb(path.join(folder, g), (time, seen) => {
      if (!seen.Left || !seen.Right) return;
      const sc = (seen.Left.scale + seen.Right.scale) / 2;
      const where = `${g} ${time.toFixed(2)} s`;
      const A = seen.Left.L;
      const B = seen.Right.L;
      for (const a of KEYS) for (const b of KEYS) {
        for (const [s0, s1] of BONES[a]) for (const [t0, t1] of BONES[b]) {
          const reach = (RADIUS[a] + RADIUS[b]) * sc;
          const dist = segDist(A[s0], A[s1], B[t0], B[t1]);
          if (dist > reach + 0.002) continue; // far apart: both 0, no need for the rows
          const row = rowRow(A[s0], A[s1], RADIUS[a] * sc, B[t0], B[t1], RADIUS[b] * sc);
          noteCapsule(depth(capsule(A[s0], A[s1], RADIUS[a] * sc), capsule(B[t0], B[t1], RADIUS[b] * sc)), row);
          note(ff, Math.max(0, reach - dist), row, `${where} L${a}-R${b}`);
        }
      }
      for (const [P, f] of [[A, seen.Right.pf], [B, seen.Left.pf]]) {
        for (const k of KEYS) for (const [s0, s1] of BONES[k]) {
          const ours = slabDepth(P[s0], P[s1], RADIUS[k] * sc, f, sc);
          // Over 2 mm clear of the box: both 0 (the made-up cases check apart ones).
          if (!ours && !slabDepth(P[s0], P[s1], RADIUS[k] * sc + 0.002, f, sc)) continue;
          const box = palmBox(f, sc);
          const row = rowDepth(P[s0], P[s1], RADIUS[k] * sc, box);
          noteCapsule(depth(capsule(P[s0], P[s1], RADIUS[k] * sc), box), row);
          note(fp, ours, row, `${where} ${k} in palm`);
        }
      }
    });
  }
  console.log(`${glbs.length} takes`);
  show('takes finger-finger (two hands)', ff);
  show('takes finger-palm', fp);
  check(ff.worst < TOL && !ff.disagree, 'finger against finger: collide.js = Rapier (takes)');
  check(fp.worst < TOL && !fp.disagree, 'finger against palm: collide.js = Rapier (takes)');
}
console.log(`note on Rapier: its capsule query differed from its own balls by over 0.2 mm in ${capsuleOff} of ${capsuleN} pairs`);
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
