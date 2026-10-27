// Checks of tools/match-hands.mjs on small made-up renders: no detection, one,
// two, crossed hands, a duplicate detection, MediaPipe's left/right label
// wrong, one detection over two clasped hands, and a detection far away.
//
//   node tools/test-match.mjs
import { matchHands } from './match-hands.mjs';

let fails = 0;
const check = (got, want, what) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok ? '' : `: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
  if (!ok) fails++;
};
// A hand in the picture: wrist at (x, y), fingers up, about 0.1 tall,
// mirrored for the left hand.
const hand = (x, y, side = 'right') => {
  const m = side === 'left' ? -1 : 1;
  const p = [[0, 0]];
  for (let f = 0; f < 5; f++) for (let k = 1; k <= 4; k++) p.push([m * (0.02 * (f - 1.5) + (f === 0 ? -0.01 * k : 0)), -0.025 * k - (f ? 0.04 : 0)]);
  return p.map(([dx, dy]) => [x + dx, y + dy]);
};
const truth = (x, y, side) => ({ side, image: hand(x, y, side) });
// A detection: the hand's points a little off, with any label.
const det = (x, y, side, label, off = 0.004) => ({ label, lm: hand(x, y, side).map(([a, b], j) => [a + off * Math.sin(j), b + off * Math.cos(j), 0]) });

const L = truth(0.3, 0.6, 'left');
const R = truth(0.7, 0.6, 'right');
check(matchHands([L, R], []), [], 'no detection: nothing');
check(matchHands([L, R], [det(0.3, 0.6, 'left', 'Left')]), [[0, 0]], 'one detection on the left hand: left only');
check(matchHands([L, R], [det(0.7, 0.6, 'right', 'Right'), det(0.3, 0.6, 'left', 'Left')]), [[0, 1], [1, 0]], 'two detections in either order');
check(matchHands([L, R], [det(0.3, 0.6, 'left', 'Right'), det(0.7, 0.6, 'right', 'Left')]), [[0, 0], [1, 1]], 'labels wrong: matched by the points, not the label');
// Crossed: the left hand drawn on the right of the picture.
const Lx = truth(0.62, 0.6, 'left');
const Rx = truth(0.38, 0.6, 'right');
check(matchHands([Lx, Rx], [det(0.38, 0.6, 'right', 'Left'), det(0.62, 0.6, 'left', 'Right')]), [[0, 1], [1, 0]], 'crossed hands');
// The same hand detected twice, nearly the same points.
check(
  matchHands([L, R], [det(0.3, 0.6, 'left', 'Left', 0.006), det(0.3, 0.6, 'left', 'Left', 0.003), det(0.7, 0.6, 'right', 'Right')]),
  [[0, 1], [1, 2]],
  'duplicate detection: the closer one used, the other left over',
);
// Clasped: both hands drawn nearly in the same place and the same outline in
// the picture (palms together seen edge-on), one detection fits both.
const Lc = { side: 'left', image: hand(0.5, 0.6, 'left') };
const Rc = { side: 'right', image: hand(0.505, 0.6, 'left') };
check(matchHands([Lc, Rc], [det(0.5, 0.6, 'left', 'Left')]), [], 'one detection over two clasped hands: left out');
// Overlapping but told apart: the detection fits one hand far better.
const Lo = truth(0.45, 0.6, 'left');
const Ro = truth(0.55, 0.62, 'right');
check(matchHands([Lo, Ro], [det(0.55, 0.62, 'right', 'Left')]), [[1, 0]], 'one detection, hands overlapping but clearly the right one');
check(matchHands([L, R], [det(0.5, 0.2, 'right', 'Right')]), [], 'a detection far from both hands: nothing');
check(matchHands([{ side: 'right', image: R.image }], [det(0.7, 0.6, 'right', 'Right')]), [[0, 0]], 'one-hand render');
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
