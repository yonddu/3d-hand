// Checks of the two-hand separation (src/handBody.js separateHands) on the
// cases an outside review found (2026-10-27): the hand nearer the camera
// stays nearer frame by frame, a correction does not leak across frames with
// no hands or a gap in time, and a wrist at the camera itself gives no NaN.
// Then the palm against the other hand's finger bones (collide.js slabDepth)
// on a made-up palm: in front, behind, beside the edge (missed before
// 2026-10-27), off a corner, just touching, apart, and a bone across it.
//
//   node tools/test-collide.mjs
import { HandRig } from '../src/handRig.js';
import { separateHands, handsDepth } from '../src/handBody.js';
import { palmFrame, slabDepth, PALM_FRONT, PALM_BACK } from '../src/collide.js';

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
// A palm 100 mm from wrist to middle knuckle, knuckles at x = +-35 mm (the
// box reaches 5 mm past them: -40..40), facing +z; an index finger bone.
{
  const mm = (v) => v.map((c) => c / 1000);
  const f = palmFrame([0, 0, 0], mm([35, 100, 0]), mm([-35, 100, 0]), mm([0, 100, 0]), [0, 0, 1]);
  const r = 0.0085;
  const ball = (c) => slabDepth(mm(c), mm(c), r, f) * 1000;
  const near = (got, want, what) => check(Math.abs(got - want) < 0.01, `${what}: ${got.toFixed(2)} mm (want ${want})`);
  const F = PALM_FRONT * 1000;
  const B = PALM_BACK * 1000;
  near(ball([45, 50, 0]), 3.5, 'beside the palm edge, 5 mm out');
  near(ball([0, 50, F + 5]), 3.5, 'in front, 5 mm off the palm');
  near(ball([0, 50, -B - 5]), 3.5, 'behind, 5 mm off the back');
  near(ball([0, 50, F - 2]), r * 1000 + 2, 'in the palm, 2 mm under its front');
  near(ball([45, 95, F + 5]), 0, 'off a corner, 5 mm out on each axis (8.7 mm away)');
  near(ball([43, 93, F + 3]), r * 1000 - Math.sqrt(27), 'off a corner, 3 mm out on each axis');
  near(ball([48.5, 50, 0]), 0, 'just touching the edge');
  near(ball([0, 50, F + 8.5]), 0, 'just touching the front');
  near(ball([100, 50, 0]), 0, 'apart');
  near(slabDepth(mm([-60, 50, 20]), mm([60, 50, -20]), r, f) * 1000, r * 1000 + Math.min(F, B), 'a bone through the palm, both ends outside');
  near(slabDepth(mm([-60, 50, F + 20]), mm([60, 50, F + 20]), r, f) * 1000, 0, 'a bone passing 20 mm in front');
}
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
