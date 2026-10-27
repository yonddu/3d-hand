// Checks of the two-hand separation (src/handBody.js separateHands) on the
// cases an outside review found (2026-10-27): the hand nearer the camera
// stays nearer frame by frame, a correction does not leak across frames with
// no hands or a gap in time, and a wrist at the camera itself gives no NaN.
//
//   node tools/test-collide.mjs
import { HandRig } from '../src/handRig.js';
import { separateHands, handsDepth } from '../src/handBody.js';

let fails = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) fails++;
};
const rigs = { left: new HandRig('left'), right: new HandRig('right') };
const rest = (side) => {
  const r = rigs[side];
  r.resetPose();
  return { fingers: r.getPose().bones, handQ: r.wrist.quaternion.toArray() };
};
const hand = (side, wrist) => ({ ...rest(side), wrist, elbow: [wrist[0], wrist[1] - 0.25, wrist[2] + 0.05] });
const make = (rows) => rows.map(([t, l, r]) => ({ t, hands: { left: l && hand('left', l), right: r && hand('right', r) } }));
const dist = (p) => Math.hypot(...p);

// Overlapping hands at about 40 cm: some overlap to start with.
const L0 = [-0.004, 0, -0.4];
const R0 = [0.004, 0, -0.4];
{
  const [f] = make([[0, L0, R0]]);
  check(handsDepth(rigs, f.hands.left, f.hands.right).depth > 0.001, 'overlapping hands are found overlapping');
}
// Order kept per frame: frame 4 has the right hand nearer, the rest the left.
{
  const rows = [];
  for (let i = 0; i < 9; i++) rows.push(i === 4 ? [i / 30, [-0.004, 0, -0.41], [0.004, 0, -0.39]] : [i / 30, [-0.004, 0, -0.39], [0.004, 0, -0.41]]);
  const frames = make(rows);
  const before = frames.map((f) => dist(f.hands.left.wrist) < dist(f.hands.right.wrist));
  separateHands(frames, (s) => new HandRig(s));
  const after = frames.map((f) => dist(f.hands.left.wrist) < dist(f.hands.right.wrist));
  check(before.every((b, i) => b === after[i]), 'the hand nearer the camera stays nearer in every frame');
}
// No leak across a frame with no hands and a long gap in time.
{
  const far = [[-0.3, 0, -0.5], [0.3, 0, -0.5]];
  const frames = make([[0, L0, R0], [0.033, null, null], [0.066, ...far]]);
  separateHands(frames, (s) => new HandRig(s));
  const moved = dist(frames[2].hands.left.wrist.map((v, k) => v - far[0][k]));
  check(moved < 1e-9, 'hands apart after a gap are not moved by the overlap before it');
}
// A wrist at the camera: nothing becomes NaN.
{
  const frames = make([[0, [0, 0, 0], [0, 0, -0.005]]]);
  separateHands(frames, (s) => new HandRig(s));
  const vals = [...frames[0].hands.left.wrist, ...frames[0].hands.right.wrist];
  check(vals.every(Number.isFinite), 'a wrist at the camera gives no NaN');
}
// Separation lowers the overlap.
{
  const frames = make([[0, L0, R0]]);
  const d0 = handsDepth(rigs, frames[0].hands.left, frames[0].hands.right).depth;
  separateHands(frames, (s) => new HandRig(s));
  const d1 = handsDepth(rigs, frames[0].hands.left, frames[0].hands.right).depth;
  check(d1 < d0, `overlap lowered (${(d0 * 1000).toFixed(1)} -> ${(d1 * 1000).toFixed(1)} mm)`);
}
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
