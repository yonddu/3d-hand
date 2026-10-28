// contactPass.js findTouches: a touch only when the thumb came to the finger
// and stayed; a thumb resting near the finger from the start, or passing over
// it in the picture while apart in depth, is no touch; it eases in and out.
//   node tools/test-touch.mjs
import * as THREE from 'three';
import { HandRig } from '../src/handRig.js';
import { findTouches } from '../src/contactPass.js';
import { localFrom } from '../src/fit.js';

let fails = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) fails++;
};
const side = 'right';
const rig = new HandRig(side);
// A thumb pose by how far it is turned across (CMC flexion), index bent to meet it.
let ABD = 20;
const pose = (cmc, wrist = [0, 0, -0.4]) => {
  const fingers = {};
  for (const [key, chain] of Object.entries(rig.chains)) chain.forEach((l, k) => (fingers[l.bone.name] = localFrom(l, side, 0, 0, 0).toArray()));
  const c = rig.chains;
  fingers[c.thumb[0].bone.name] = localFrom(c.thumb[0], side, cmc, ABD, 0).toArray();
  fingers[c.thumb[1].bone.name] = localFrom(c.thumb[1], side, 20, 0, 0).toArray();
  fingers[c.index[0].bone.name] = localFrom(c.index[0], side, 45, 0, 0).toArray();
  fingers[c.index[1].bone.name] = localFrom(c.index[1], side, 45, 0, 0).toArray();
  return { wrist, handQ: [0, 0, 0, 1], fingers };
};
const take = (cmcs) => cmcs.map((cmc, i) => ({ t: i / 30, hands: { [side]: pose(cmc) } }));
// Find the thumb angle that rests it on the index (skin gap ~0) and one well apart.
import { BONES, RADIUS, segDist } from '../src/collide.js';
import { handPoints, BODY } from '../src/handBody.js';
const gapAt = (cmc) => {
  const P = handPoints(rig, pose(cmc));
  return Math.min(...BONES.index.map(([a, b]) => segDist(P[3], P[4], P[a], P[b]))) - (RADIUS.thumb + RADIUS.index) * (Math.hypot(...BODY[side].base.middle) / 0.09);
};
let touchAt = null;
for (const abd of [20, 30, 40, 10, 0, -10]) {
  ABD = abd;
  for (let a = -20; a <= 55 && touchAt === null; a += 0.25) if (Math.abs(gapAt(a)) < 0.002) touchAt = a;
  if (touchAt !== null) break;
}
console.log('  thumb spread', ABD, 'gap at rest', touchAt !== null ? (gapAt(touchAt) * 1000).toFixed(1) + ' mm' : '-');
check(touchAt !== null, `a thumb angle that rests on the index exists (${touchAt})`);
const apart = [-20, -10, 0, 10, 20, 30, 40, 50].map((a) => [a, gapAt(a)]).sort((p, q) => q[1] - p[1])[0][0];
check(gapAt(apart) > 0.02, `and one well apart (${apart}, gap ${(gapAt(apart) * 1000).toFixed(0)} mm)`);
const ramp = (n) => [...Array(n).keys()].map((i) => apart + ((touchAt - apart) * i) / (n - 1));
const rigFor = (s) => new HandRig(s);
const ws0 = (t) => t.filter(Boolean).map((x) => x.w.toFixed(1)).join(',');
// Comes to the finger over 10 frames, stays 20, leaves.
const t1 = findTouches(take([...Array(5).fill(apart), ...ramp(10), ...Array(20).fill(touchAt), ...ramp(10).reverse(), ...Array(5).fill(apart)]), rigFor)[side];
const on = t1.map((x) => (x ? x.key : null));
check(on.slice(17, 33).every((k) => k === 'index'), 'came and stayed: touching the index while resting on it');
check(on.slice(0, 8).every((k) => !k) && on.slice(-5).every((k) => !k), 'not touching while apart');
const ws = t1.filter(Boolean).map((x) => x.w);
check(ws.length > 0 && ws[0] < 0.5 && ws[ws.length - 1] < 0.5 && Math.max(...ws) === 1, `eased in and out (first ${ws[0]?.toFixed(2)}, last ${ws[ws.length - 1]?.toFixed(2)})`);
// Resting there from the first frame, never having come: no touch.
const t2 = findTouches(take(Array(30).fill(touchAt)), rigFor)[side];
check(t2.every((x) => !x), 'resting near from the start (never came): no touch');
// Unseen frames start afresh.
const frames = take([...Array(5).fill(apart), ...ramp(10), ...Array(10).fill(touchAt)]);
frames.splice(15, 0, { t: 0.5, hands: {} });
const t3 = findTouches(frames, rigFor)[side];
check(!t3[16] && !t3[17], 'a hand seen again does not carry the touch over');
if (fails) {
  console.log(`${fails} failed`);
  process.exit(1);
}
console.log('all passed');
