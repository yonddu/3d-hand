// Joint angle error on the synthetic renders (tools/synth-render.mjs): the
// true pose of the drawn hand against what the pipeline (lift.js + solver.js)
// makes of MediaPipe's reading of the picture. A training aid only: the real
// score stays on the score-only takes (regress-split.json).
//
//   node tools/synth-eval.mjs [synthetic folder or .jsonl ...] [--worst N] [--score]
//
// A folder is read without its score-only files (regress-split.json
// syntheticHoldout), which only --score reads, and then only as totals.
//
// Angles are measured on joint positions, so they do not depend on how either
// side names its angles: the bend at each finger joint (15 per hand), and the
// way the palm faces in the camera's view. Reported for the raw MediaPipe
// world reading too, to show what the pipeline adds or loses.
import fs from 'fs';
import path from 'path';
import * as THREE from 'three';
import { liftToPicture } from '../src/lift.js';
import { HandRig, handFrameQuat } from '../src/handRig.js';
import { HandSolver } from '../src/solver.js';
import { GESTURES } from '../src/gestures.js';

const CHAINS = { thumb: [0, 1, 2, 3, 4], index: [0, 5, 6, 7, 8], middle: [0, 9, 10, 11, 12], ring: [0, 13, 14, 15, 16], pinky: [0, 17, 18, 19, 20] };
const FLIP = 90; // palm facing off by more than this: the hand shown turned over
const deg = (r) => (r * 180) / Math.PI;
const V = (a) => new THREE.Vector3(a[0], a[1], a[2]);

// Bend at each joint along each finger, degrees.
function bends(P) {
  const out = {};
  for (const [k, c] of Object.entries(CHAINS)) {
    out[k] = [];
    for (let i = 1; i < 4; i++) out[k].push(deg(P[c[i]].clone().sub(P[c[i - 1]]).angleTo(P[c[i + 1]].clone().sub(P[c[i]]))));
  }
  return out;
}
const palmNormal = (P, side) => new THREE.Vector3(0, 0, 1).applyQuaternion(handFrameQuat(P, side));

const args = process.argv.slice(2);
const score = args.includes('--score');
const worstN = !score && args.includes('--worst') ? +args[args.indexOf('--worst') + 1] : 0;
const splitFile = path.join(path.dirname(new URL(import.meta.url).pathname), 'regress-split.json');
const held = new Set(fs.existsSync(splitFile) ? JSON.parse(fs.readFileSync(splitFile, 'utf8')).syntheticHoldout || [] : []);
const inputs = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--worst');
if (!inputs.length) inputs.push('/mnt/project-files/hand-motion-studio/synthetic/');
const lines = [];
for (const a of inputs) {
  const list = fs.statSync(a).isDirectory() ? fs.readdirSync(a).filter((f) => f.endsWith('.jsonl') && held.has(f) === score).map((f) => path.join(a, f)) : [a];
  for (const f of list) for (const l of fs.readFileSync(f, 'utf8').split('\n')) if (l.trim()) lines.push(JSON.parse(l));
}

const catOf = Object.fromEntries(GESTURES.map((g) => [g.id, g.category]));
const solvers = { left: new HandSolver(new HandRig('left')), right: new HandSolver(new HandRig('right')) };
const sum = { n: 0, found: 0, label: 0, bend: 0, bendN: 0, raw: 0, face: [], rawFace: [], flips: 0, rawFlips: 0, unsure: 0, unsureFlips: 0 };
const perJoint = {};
// Finger middle and end joints by how bent they truly are: does the
// pipeline open curled fingers or curl straight ones?
const byBend = [0, 1, 2, 3, 4].map(() => ({ n: 0, bias: 0, e: 0 }));
// The score: the app's own joint angles (flexion, as gestures.js and the
// solver name them) against the angles the drawn hand was posed with.
const ANG = { thumb: [0, 3, 6], finger: [0, 3, 4] };
const angle = { e: 0, n: 0, curled: 0, curledN: 0 };
const perCat = {};
const rows = [];
for (const s of lines) {
  sum.n++;
  const t = s.truth;
  // The detection nearest the drawn wrist.
  const tw = t.image[0];
  const hits = s.mp.map((h) => ({ h, d: Math.hypot(h.lm[0][0] - tw[0], h.lm[0][1] - tw[1]) })).sort((a, b) => a.d - b.d);
  if (!hits.length || hits[0].d > 0.1) continue;
  sum.found++;
  const h = hits[0].h;
  const side = t.side;
  // MediaPipe labels assume a mirrored selfie picture; this one is not mirrored.
  if (h.label.toLowerCase() !== side) sum.label++;
  const world = h.world.map(([x, y, z]) => ({ x, y, z }));
  const image = h.lm.map(([x, y, z]) => ({ x, y, z }));
  const memory = {};
  const raw = liftToPicture(world, image, s.aspect, side, memory, true);
  const P = raw.map((p) => new THREE.Vector3(p.x, -p.y, -p.z));
  const solver = solvers[side];
  solver.reset();
  const res = solver.solve(P, { limits: true, fit: true, cup: raw.cup || 0, occluded: raw.occluded || null, smoothing: false });
  const rig = solver.rig;
  rig.group.position.set(0, 0, 0);
  const out = rig.landmarkPositions();
  const truth = t.joints.map(V);
  const mpW = h.world.map(([x, y, z]) => new THREE.Vector3(x, -y, -z));
  for (const k of Object.keys(CHAINS)) {
    [0, 1, 2].forEach((i) => {
      const tv = t.h[k][ANG[k === 'thumb' ? 'thumb' : 'finger'][i]];
      const d = res.angles[k][i].flex - tv;
      angle.e += Math.abs(d);
      angle.n++;
      if (k !== 'thumb' && i > 0 && tv >= 60) {
        angle.curled += d;
        angle.curledN++;
      }
    });
  }
  const bT = bends(truth);
  const bO = bends(out);
  const bM = bends(mpW);
  let e = 0;
  let eRaw = 0;
  for (const k of Object.keys(bT)) {
    bT[k].forEach((v, i) => {
      const d = Math.abs(bO[k][i] - v);
      e += d;
      eRaw += Math.abs(bM[k][i] - v);
      const key = `${k}${i}`;
      (perJoint[key] ||= { e: 0, raw: 0, n: 0, bias: 0 }).e += d;
      perJoint[key].bias += bO[k][i] - v;
      if (i > 0 && k !== 'thumb') {
        const b = byBend[Math.min(4, Math.floor(v / 20))];
        b.n++;
        b.bias += bO[k][i] - v;
        b.e += d;
      }
      perJoint[key].raw += Math.abs(bM[k][i] - v);
      perJoint[key].n++;
    });
  }
  e /= 15;
  eRaw /= 15;
  sum.bend += e;
  sum.raw += eRaw;
  sum.bendN++;
  const nT = palmNormal(truth, side);
  // landmarkPositions is world space with the solved wrist turn applied.
  const faceOut = deg(palmNormal(out, side).angleTo(nT));
  const faceRaw = deg(palmNormal(mpW, side).angleTo(nT));
  sum.face.push(faceOut);
  sum.rawFace.push(faceRaw);
  if (faceOut > FLIP) sum.flips++;
  if (faceRaw > FLIP) sum.rawFlips++;
  const unsure = !!(raw.mirror && raw.mirror.unsure);
  if (unsure) {
    sum.unsure++;
    if (faceOut > FLIP) sum.unsureFlips++;
  }
  const base = t.shape.split('~')[0];
  const cat = catOf[base] || '?';
  const c = (perCat[cat] ||= { e: 0, n: 0, flips: 0 });
  c.e += e;
  c.n++;
  if (faceOut > FLIP) c.flips++;
  rows.push({ id: s.id, side, shape: t.shape, arm: t.arm, bend: e, face: faceOut, unsure });
}

const med = (a) => (a.length ? a.slice().sort((x, y) => x - y)[a.length >> 1] : NaN);
const f1 = (v) => v.toFixed(1);
console.log(`samples ${sum.n}, MediaPipe found the hand in ${sum.found} (${f1((100 * sum.found) / Math.max(1, sum.n))}%), labelled the other side in ${sum.label}`);
console.log(`JOINT ANGLE ERROR ${(angle.e / Math.max(1, angle.n)).toFixed(2)} deg (app angles vs posed, 15 joints)   curled finger joints (60+ deg) read ${f1(angle.curled / Math.max(1, angle.curledN))} deg off`);
console.log(`joint bend error  pipeline ${f1(sum.bend / sum.bendN)} deg   raw MediaPipe world ${f1(sum.raw / sum.bendN)} deg   (mean over 15 joints)`);
console.log(`palm facing error pipeline median ${f1(med(sum.face))} deg, turned over (>${FLIP}) ${sum.flips}   raw MediaPipe median ${f1(med(sum.rawFace))} deg, turned over ${sum.rawFlips}`);
console.log(`frames marked unsure (facing) ${sum.unsure}, of them turned over ${sum.unsureFlips}; turned over without the mark ${sum.flips - sum.unsureFlips}`);
// bias: the mean signed error (+ bent more than true); a large one at the
// knuckles can also come from where each side puts the wrist and knuckles.
if (score) process.exit(0); // score-only files: totals only
console.log('per joint, base to tip (pipeline / raw MediaPipe, pipeline bias):');
for (const k of ['thumb', 'index', 'middle', 'ring', 'pinky']) console.log(`  ${k.padEnd(7)} ${[0, 1, 2].map((i) => { const j = perJoint[`${k}${i}`]; return j ? `${f1(j.e / j.n)}/${f1(j.raw / j.n)} (${j.bias >= 0 ? '+' : ''}${f1(j.bias / j.n)})` : '-'; }).join('  ')}`);
console.log('finger middle/end joints by true bend (error, bias):');
byBend.forEach((b, i) => b.n && console.log(`  ${String(i * 20).padStart(2)}-${i * 20 + 20} deg  n ${String(b.n).padStart(5)}  ${f1(b.e / b.n)} deg  (${b.bias >= 0 ? '+' : ''}${f1(b.bias / b.n)})`));
console.log('per hand shape category (bend error, turned over):');
for (const [k, c] of Object.entries(perCat).sort((a, b) => b[1].e / b[1].n - a[1].e / a[1].n)) console.log(`  ${k.padEnd(12)} n ${String(c.n).padStart(4)}  ${f1(c.e / c.n)} deg  ${c.flips}`);
if (worstN) {
  console.log('worst samples:');
  for (const r of rows.sort((a, b) => b.bend - a.bend).slice(0, worstN)) console.log(`  ${r.id} ${r.side} ${r.shape} (${r.arm}) bend ${f1(r.bend)} face ${f1(r.face)}${r.unsure ? ' unsure' : ''}`);
}
