// clampBack.js: no finger joint past its backward limit in the finished take,
// the thumb's base kept at the corner in front of the back of the hand, and
// bends toward the palm left as they are.
//   node tools/test-clamp-back.mjs
import * as THREE from 'three';
import { HandRig } from '../src/handRig.js';
import { clampBack } from '../src/clampBack.js';
import { localFrom } from '../src/fit.js';

let fails = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) fails++;
};
const e = new THREE.Euler();
const angles = (link, v, side) => {
  e.setFromQuaternion(link.restLocal.clone().invert().multiply(new THREE.Quaternion().fromArray(v)), 'XZY');
  return { flex: (e.x * 180) / Math.PI, abd: (-e.z * 180) / Math.PI * (side === 'left' ? -1 : 1), roll: (e.y * 180) / Math.PI };
};
for (const side of ['right', 'left']) {
  const rig = new HandRig(side);
  const set = (key, k, flex, abd, roll = 0) => localFrom(rig.chains[key][k], side, flex, abd, roll).toArray();
  const fingers = {};
  fingers[rig.chains.index[0].bone.name] = set('index', 0, -10, 5, 3);
  fingers[rig.chains.index[1].bone.name] = set('index', 1, 40, 0);
  fingers[rig.chains.middle[1].bone.name] = set('middle', 1, -2.5, 0);
  fingers[rig.chains.thumb[0].bone.name] = set('thumb', 0, -30, -35);
  fingers[rig.chains.thumb[1].bone.name] = set('thumb', 1, 20, 0);
  const frames = [{ t: 0, hands: { [side]: { fingers } } }];
  const before = JSON.stringify(fingers);
  const out = clampBack(frames, (s) => new HandRig(s))[0].hands[side].fingers;
  check(JSON.stringify(fingers) === before, `${side}: input finger map not changed`);
  const a = (key, k) => angles(rig.chains[key][k], out[rig.chains[key][k].bone.name], side);
  const i0 = a('index', 0);
  check(Math.abs(i0.flex) < 0.01 && Math.abs(i0.abd - 5) < 0.01 && Math.abs(i0.roll - 3) < 0.01, `${side}: index knuckle bent back 10 -> 0, sideways and twist kept (${i0.flex.toFixed(2)}, ${i0.abd.toFixed(2)}, ${i0.roll.toFixed(2)})`);
  check(Math.abs(a('index', 1).flex - 40) < 0.01, `${side}: bend toward the palm kept`);
  check(Math.abs(a('middle', 1).flex) < 0.01, `${side}: 2.5 deg back (inside the solver's slack) -> 0`);
  const t0 = a('thumb', 0);
  check(Math.abs(t0.flex + 20) < 0.01 && Math.abs(t0.abd + 25) < 0.01, `${side}: thumb base -30/-35 -> -20/-25 (${t0.flex.toFixed(2)}, ${t0.abd.toFixed(2)})`);
  check(Math.abs(a('thumb', 1).flex - 20) < 0.01, `${side}: thumb MCP kept`);
}
if (fails) {
  console.log(`${fails} failed`);
  process.exit(1);
}
console.log('all passed');
