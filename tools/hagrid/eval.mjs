// Finger read errors on real HaGRID photos (tools/hagrid/detect.mjs), with
// the gesture label as the truth: which fingers a "fist", "like", "peace"...
// holds straight and which folded. Validation only, never for tuning
// constants (the photos are third person, the app is first person).
//
//   node tools/hagrid/eval.mjs <detect.jsonl> [--thresh 90]
//
// Each gesture hand is read three ways, all measured the same way (the bend
// at each finger joint from joint positions, summed along the finger):
//   mp     MediaPipe's own world points
//   app    the app's lift + fit, no picture models
//   cubes  the app as it runs on a recording: + finger curl and joint cube models
import fs from 'fs';
import * as THREE from 'three';
import { liftToPicture } from '../../src/lift.js';
import { HandRig } from '../../src/handRig.js';
import { HandSolver } from '../../src/solver.js';
import { withCubes } from '../../src/jointCube.js';
import { HandTracker, chirality } from '../../src/tracker.js';

const args = process.argv.slice(2);
const THRESH = args.includes('--thresh') ? +args[args.indexOf('--thresh') + 1] : 90;
const FINGERS = ['index', 'middle', 'ring', 'pinky'];
const CHAINS = { thumb: [1, 2, 3, 4], index: [0, 5, 6, 7, 8], middle: [0, 9, 10, 11, 12], ring: [0, 13, 14, 15, 16], pinky: [0, 17, 18, 19, 20] };
// 1 straight, 0 folded, per index/middle/ring/pinky; thumb: 1 out, 0 folded, null not scored.
const TRUTH = {
  fist: { f: [0, 0, 0, 0], thumb: null },
  like: { f: [0, 0, 0, 0], thumb: 1 },
  dislike: { f: [0, 0, 0, 0], thumb: 1 },
  palm: { f: [1, 1, 1, 1], thumb: 1 },
  stop: { f: [1, 1, 1, 1], thumb: 1 },
  four: { f: [1, 1, 1, 1], thumb: 0 },
  one: { f: [1, 0, 0, 0], thumb: null },
  peace: { f: [1, 1, 0, 0], thumb: null },
  two_up: { f: [1, 1, 0, 0], thumb: null },
  rock: { f: [1, 0, 0, 1], thumb: null },
  call: { f: [0, 0, 0, 1], thumb: 1 },
  little_finger: { f: [0, 0, 0, 1], thumb: null },
};
const deg = (r) => (r * 180) / Math.PI;
// Summed bend along each finger, degrees.
function curls(P) {
  const out = {};
  for (const [k, c] of Object.entries(CHAINS)) {
    let s = 0;
    for (let i = 1; i < c.length - 1; i++) s += deg(P[c[i]].clone().sub(P[c[i - 1]]).angleTo(P[c[i + 1]].clone().sub(P[c[i]])));
    out[k] = s;
  }
  return out;
}

const solvers = { left: new HandSolver(new HandRig('left')), right: new HandSolver(new HandRig('right')) };
function solve(h, side, aspect, picture) {
  const world = h.world.map(([x, y, z]) => ({ x, y, z }));
  const image = h.lm.map(([x, y, z]) => ({ x, y, z }));
  const raw = liftToPicture(world, image, aspect, side, {}, false);
  const P = raw.map((p) => new THREE.Vector3(p.x, -p.y, -p.z));
  const solver = solvers[side];
  solver.reset();
  solver.solve(P, { limits: true, fit: true, cup: raw.cup || 0, occluded: raw.occluded || null, smoothing: false, picture });
  solver.rig.group.position.set(0, 0, 0);
  return solver.rig.landmarkPositions();
}

const WAYS = ['mp', 'app', 'cubes'];
const tot = { photos: 0, found: 0 };
const per = {};
// Which way the finger reads go wrong: a folded finger read straight, or a
// straight one read folded, per finger.
const miss = Object.fromEntries(WAYS.map((w) => [w, Object.fromEntries(FINGERS.map((k) => [k, { opened: 0, folded: 0 }]))]));
const add = (g, way, key, ok) => {
  const c = ((per[g] ||= {})[way] ||= { n: 0, wrong: 0, tn: 0, twrong: 0, hands: 0, handsWrong: 0 });
  if (key === 'hand') {
    c.hands++;
    if (!ok) c.handsWrong++;
  } else if (key === 'thumb') {
    c.tn++;
    if (!ok) c.twrong++;
  } else {
    c.n++;
    if (!ok) c.wrong++;
  }
};
for (const l of fs.readFileSync(args.find((a) => !a.startsWith('--') && a !== String(THRESH)), 'utf8').split('\n')) {
  if (!l.trim()) continue;
  const r = JSON.parse(l);
  const truth = TRUTH[r.gesture];
  if (!truth) continue;
  tot.photos++;
  // The hand inside the gesture's box (x, y, w, h of the photo).
  const box = r.boxes[r.labels.indexOf(r.gesture)];
  const inBox = (h) => h.lm.filter(([x, y]) => x >= box[0] && x <= box[0] + box[2] && y >= box[1] && y <= box[1] + box[3]).length;
  const h = r.mp.filter((q) => inBox(q) >= 15).sort((a, b) => inBox(b) - inBox(a))[0];
  if (!h) continue;
  tot.found++;
  // Left or right as the app decides it for a third person picture: the
  // label, unless the hand's 3D shape clearly says otherwise.
  const world = h.world.map(([x, y, z]) => ({ x, y, z }));
  const hand = { side: h.label.toLowerCase(), landmarks: h.lm.map(([x, y, z]) => ({ x, y, z })), world, chiral: chirality(world) };
  HandTracker.prototype.keepSides.call({ tracks: [] }, [hand], 0);
  const side = hand.side;
  const read = {
    mp: curls(h.world.map(([x, y, z]) => new THREE.Vector3(x, -y, -z))),
    app: curls(solve(h, side, r.aspect, null)),
    // P is lift's picture frame, not turned: its line of sight is +z (jointCube.js withCubes)
    cubes: curls(solve(h, side, r.aspect, withCubes(h.curl, h.cube, [0, 0, 1]))),
  };
  for (const way of WAYS) {
    let all = true;
    FINGERS.forEach((k, i) => {
      const ok = (read[way][k] < THRESH ? 1 : 0) === truth.f[i];
      all &&= ok;
      if (!ok) miss[way][k][truth.f[i] ? 'folded' : 'opened']++;
      add(r.gesture, way, k, ok);
    });
    if (truth.thumb !== null) {
      const ok = (read[way].thumb < THRESH * 0.6 ? 1 : 0) === truth.thumb;
      all &&= ok;
      add(r.gesture, way, 'thumb', ok);
    }
    add(r.gesture, way, 'hand', all);
  }
}

const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1).padStart(5) + '%' : '    -');
console.log(`photos ${tot.photos}, gesture hand found by MediaPipe in ${tot.found} (${pct(tot.found, tot.photos).trim()}); folded = summed finger bend >= ${THRESH} deg`);
console.log('finger read wrong (index..pinky) / thumb wrong / whole hand wrong, per way: mp | app | cubes');
const sum = Object.fromEntries(WAYS.map((w) => [w, { n: 0, wrong: 0, tn: 0, twrong: 0, hands: 0, handsWrong: 0 }]));
for (const [g, c] of Object.entries(per)) {
  console.log(`  ${g.padEnd(14)} n ${String(c.mp.hands).padStart(4)}  ` + WAYS.map((w) => `${pct(c[w].wrong, c[w].n)} ${pct(c[w].twrong, c[w].tn)} ${pct(c[w].handsWrong, c[w].hands)}`).join(' | '));
  for (const w of WAYS) for (const k of Object.keys(sum[w])) sum[w][k] += c[w][k];
}
console.log(`  ${'ALL'.padEnd(14)} n ${String(sum.mp.hands).padStart(4)}  ` + WAYS.map((w) => `${pct(sum[w].wrong, sum[w].n)} ${pct(sum[w].twrong, sum[w].tn)} ${pct(sum[w].handsWrong, sum[w].hands)}`).join(' | '));
console.log('wrong finger reads by kind (folded read straight / straight read folded): mp | app | cubes');
for (const k of FINGERS) console.log(`  ${k.padEnd(7)} ` + WAYS.map((w) => `${String(miss[w][k].opened).padStart(4)} ${String(miss[w][k].folded).padStart(4)}`).join(' | '));
