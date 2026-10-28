// stillPass.js: a finger whose picture points stand still on the hand keeps
// one pose (the solver's swing is taken out), even while the whole hand moves
// in the picture; a finger whose points move is left as solved; hands on
// each other are left alone.
//   node tools/test-still.mjs
import { HandRig } from '../src/handRig.js';
import { stillPass } from '../src/stillPass.js';
import { localFrom } from '../src/fit.js';

let fails = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) fails++;
};
const side = 'right';
const rig = new HandRig(side);
const index = rig.chains.index[1].bone.name;
const fingersAt = (pip) => {
  const f = {};
  for (const chain of Object.values(rig.chains)) chain.forEach((l) => (f[l.bone.name] = localFrom(l, side, 10, 0, 0).toArray()));
  f[index] = localFrom(rig.chains.index[1], side, pip, 0, 0).toArray();
  return f;
};
// Picture points: a fixed hand shape, shifted/turned by the frame's hand move,
// the index tip (8) moved by tipMove(i) palm lengths.
const BASE = Array.from({ length: 21 }, (_, k) => [0.5 + 0.02 * ((k % 4) - 1.5) * Math.ceil(k / 4), 0.6 - 0.03 * (k % 4) - 0.01 * Math.ceil(k / 4)]);
const picAt = (i, tipMove = 0) => {
  const a = 0.01 * i, dx = 0.002 * i;
  return BASE.map(([x, y], k) => {
    const yy = k === 8 ? y - tipMove * 0.07 : y;
    return [0.5 + (x - 0.5) * Math.cos(a) - (yy - 0.6) * Math.sin(a) + dx, 0.6 + (x - 0.5) * Math.sin(a) + (yy - 0.6) * Math.cos(a)];
  });
};
const angle = (q) => (2 * Math.acos(Math.min(1, Math.abs(q[3]))) * 180) / Math.PI;
// Solver swing on a still finger: PIP 30 <-> 60 every few frames. The hold
// keeps a straight trend line, which a square wave tilts a little (< 8 deg
// over the whole stretch, no back and forth).
const swing = (i) => (i % 10 < 5 ? 30 : 60);
const take = (n, tip, other = null) => Array.from({ length: n }, (_, i) => ({ t: i / 30, hands: { [side]: { wrist: [0, 0, -0.4], fingers: fingersAt(swing(i)), pic: picAt(i, tip(i)) }, ...(other ? { left: other(i) } : {}) } }));
const out = {};
const still = stillPass(take(40, () => 0), () => rig, 1, out);
const mid = still.slice(8, 32).map((f) => angle(f.hands[side].fingers[index]));
check(Math.max(...mid) - Math.min(...mid) < 8, `still points, hand moving: swing 30 -> ${(Math.max(...mid) - Math.min(...mid)).toFixed(1)} deg`);
const moving = stillPass(take(40, (i) => i * 0.05), () => rig, 1);
const kept = moving.every((f, i) => Math.abs(angle(f.hands[side].fingers[index]) - angle(fingersAt(swing(i))[index])) < 0.5);
check(kept, 'tip moving on the hand: left as solved');
const near = stillPass(take(40, () => 0, () => ({ wrist: [0.1, 0, -0.4], fingers: fingersAt(20) })), () => rig, 1);
check(near.every((f, i) => Math.abs(angle(f.hands[side].fingers[index]) - angle(fingersAt(swing(i))[index])) < 0.5), 'other hand 10 cm away: left alone');
// A slow real bend: the tip creeps 0.01 palm a frame (a finger curling over 1.3 s)
// with the solver following it smoothly; it must stay smooth, not steps.
const creep = Array.from({ length: 40 }, (_, i) => ({ t: i / 30, hands: { [side]: { wrist: [0, 0, -0.4], fingers: fingersAt(20 + i), pic: picAt(i, i * 0.0096) } } }));
const crept = stillPass(creep, () => rig, 1).map((f) => angle(f.hands[side].fingers[index]));
const step = Math.max(...crept.slice(1).map((a, i) => Math.abs(a - crept[i])));
check(step < 2.5, `slow bend kept smooth: biggest step ${step.toFixed(1)} deg (solver 1 deg a frame)`);
check(out.holds > 0, `holds counted (${out.holds})`);
if (fails) process.exit(1);
