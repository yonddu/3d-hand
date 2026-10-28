// Checks tracker.js dropGhost: a second hand that appears inside the box of
// the one already tracked waits GHOST_FRAMES frames; a hand tracked on its
// own, or one appearing elsewhere, is taken at once.
//   node tools/test-ghost.mjs
import { HandTracker } from '../src/tracker.js';

// A flat open hand: wrist at (x, y), fingers up, s = size.
const hand = (side, x, y, s = 0.2) => {
  const lm = [];
  for (let k = 0; k < 21; k++) {
    const f = k ? Math.floor((k - 1) / 4) : 2;
    const j = k ? ((k - 1) % 4) + 1 : 0;
    lm.push({ x: x + (f - 2) * 0.2 * s, y: y - j * 0.25 * s, z: 0 });
  }
  return { side, score: 0.9, landmarks: lm, world: lm.map((p) => ({ ...p })), chiral: 0 };
};
const fail = [];
const want = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fail.push(what); };
const run = (steps) => {
  const tr = new HandTracker({});
  // How many hands each frame keeps (sides are settled later, resolveSides).
  return steps.map((hs, i) => tr.keepSides(hs(), i * 33).length);
};

// Right hand alone, then a "left" reading of it on top, 13 frames.
let out = run([...Array(5).fill(() => [hand('right', 0.8, 0.6)]), ...Array(13).fill(() => [hand('right', 0.8, 0.6), hand('left', 0.78, 0.55, 0.15)])]);
want(out.slice(5, 14).every((n) => n === 1), 'reading on top of the tracked hand is held back for 9 frames');
want(out[14] === 2 && out[17] === 2, 'and taken from the 10th frame on');

// The same, broken up: frames apart by less than 400 ms still count up.
out = run([...Array(5).fill(() => [hand('right', 0.8, 0.6)]), () => [hand('right', 0.8, 0.6), hand('left', 0.78, 0.55, 0.15)], () => [hand('right', 0.8, 0.6)]]);
want(out[5] === 1 && out[6] === 1, 'one-frame reading on top is dropped');

// The other label decides which one is new, though its wrist is closer.
{
  const tr = new HandTracker({});
  for (let i = 0; i < 5; i++) tr.keepSides([hand('right', 0.8, 0.6)], i * 33);
  const kept = tr.keepSides([hand('right', 0.76, 0.6), hand('left', 0.775, 0.58, 0.15)], 5 * 33);
  want(kept.length === 1 && kept[0].landmarks[0].x === 0.76, 'the hand under the other label is the one held back, though its wrist is closer');
}

// A second hand coming in at the picture's edge is taken at once.
out = run([...Array(5).fill(() => [hand('right', 0.8, 0.6)]), () => [hand('right', 0.8, 0.6), hand('left', 0.06, 0.6)]]);
want(out[5] === 2, 'a hand coming in at the edge is taken at once');
// One appearing apart in the middle of the picture waits like one on top (take left_pop2_02-04).
out = run([...Array(5).fill(() => [hand('right', 0.8, 0.6)]), ...Array(12).fill(() => [hand('right', 0.8, 0.6), hand('left', 0.4, 0.6)])]);
want(out.slice(5, 14).every((n) => n === 1) && out[14] === 2, 'a hand appearing in the middle is held back 9 frames, then taken');
// But a hand found again soon after both were tracked is taken at once.
out = run([...Array(5).fill(() => [hand('right', 0.8, 0.6), hand('left', 0.4, 0.6)]), ...Array(10).fill(() => [hand('right', 0.8, 0.6)]), () => [hand('right', 0.8, 0.6), hand('left', 0.4, 0.6)]]);
want(out[15] === 2, 'a hand found again within 2 s of two hands is taken at once');

// Two hands tracked apart, then one over the other (clasped): both stay.
out = run([...Array(5).fill(() => [hand('right', 0.7, 0.6), hand('left', 0.3, 0.6)]), ...Array(5).fill(() => [hand('right', 0.7, 0.6), hand('left', 0.69, 0.57, 0.15)])]);
want(out.slice(5).every((n) => n === 2), 'hands tracked on their own are never held back when they overlap');

// Both appearing together on the first frame: nothing to hold them against.
out = run([() => [hand('right', 0.7, 0.6), hand('left', 0.69, 0.57, 0.15)]]);
want(out[0] === 2, 'two hands appearing together are both taken');

// A hand missed for one frame is still remembered: found again in the same
// place under the other label, it keeps its side (user take 2026-10-28 06:15,
// right hand turned left for 5.6 s after a single empty frame).
{
  const tr = new HandTracker({});
  for (let i = 0; i < 5; i++) tr.keepSides([hand('right', 0.5, 0.6)], i * 33);
  tr.keepSides([], 5 * 33);
  const sides = [6, 7].map((i) => tr.keepSides([hand('left', 0.49, 0.6)], i * 33)[0].side);
  want(sides.every((s) => s === 'right'), `a hand found again after an empty frame keeps its side (${sides.join(', ')})`);
}

if (fail.length) process.exit(1);
console.log('all ghost checks pass');
