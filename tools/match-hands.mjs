// Which MediaPipe detection belongs to which drawn hand in a synthetic render
// (tools/synth-render.mjs). One rule for both the training crops
// (tools/palm/crops_cube.py runs this file) and the scoring
// (tools/synth-eval.mjs), so the crops and the score see the same pairs.
//
// A detection and a drawn hand are compared over all 21 points in the
// picture (mean distance, in units of the drawn hand's wrist to middle
// knuckle length), not by the wrist alone, and never by MediaPipe's left/right
// label (it is often wrong, and the renders are not mirrored). Pairs are one
// to one: a detection gives at most one hand and a hand takes at most one
// detection. A pair is kept only when it is sure:
//   - close: mean distance under MAX_COST;
//   - not the other hand's: the detection is at least RATIO times closer to
//     this hand than to any other drawn hand, and at least MIN_GAP closer
//     (one detection over two clasped or crossed hands fits both, and is left
//     out; the gap keeps two hands drawn on the same points, both costs near
//     0, from passing the ratio as 0 >= 2 * 0: review 2026-10-27);
// The best one-to-one choice is taken (most sure pairs, then least distance),
// so a second, duplicate detection of the same hand is simply left over.
//
//   node tools/match-hands.mjs <file.jsonl>   prints, line by line, [[truth index, detection index], ...] or null
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// One-hand renders (seed 9): a detection of the hand is within 0.4 of it for
// 95%, the worst 1% at 0.6 and over (MediaPipe misreading the hand).
export const MAX_COST = 0.5;
export const RATIO = 2;
export const MIN_GAP = 0.05;

// Truth hands of one render: a two-hand render (SYNTH_TWO) holds one per hand.
export const truthHands = (r) => (r.truth.two ? r.truth.hands : [r.truth]);

export function pointCost(image, lm, aspect = 1) {
  const sx = aspect;
  const size = Math.max(Math.hypot((image[9][0] - image[0][0]) * sx, image[9][1] - image[0][1]), 1e-3);
  let sum = 0;
  for (let j = 0; j < 21; j++) sum += Math.hypot((image[j][0] - lm[j][0]) * sx, image[j][1] - lm[j][1]);
  return sum / 21 / size;
}

// truths: [{ image: 21 x [x, y] }], dets: [{ lm: 21 x [x, y, ...] }], both in
// picture units (0..1 of width and height); aspect = width / height.
// Returns [[truth index, detection index], ...].
export function matchHands(truths, dets, aspect = 1) {
  const C = truths.map((t) => dets.map((d) => pointCost(t.image, d.lm, aspect)));
  const sure = (ti, di) => C[ti][di] < MAX_COST && truths.every((_, o) => o === ti || (C[o][di] >= RATIO * C[ti][di] && C[o][di] - C[ti][di] >= MIN_GAP));
  let best = { pairs: [], cost: 0 };
  const walk = (ti, used, pairs, cost) => {
    if (ti === truths.length) {
      if (pairs.length > best.pairs.length || (pairs.length === best.pairs.length && cost < best.cost)) best = { pairs: pairs.slice(), cost };
      return;
    }
    walk(ti + 1, used, pairs, cost); // this hand left without a detection
    for (let di = 0; di < dets.length; di++) {
      if (used.has(di) || !sure(ti, di)) continue;
      used.add(di);
      pairs.push([ti, di]);
      walk(ti + 1, used, pairs, cost + C[ti][di]);
      pairs.pop();
      used.delete(di);
    }
  };
  walk(0, new Set(), [], 0);
  return best.pairs;
}

export function matchRender(r) {
  return matchHands(truthHands(r), r.mp || [], r.aspect || 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // By line, null for a line that is not a render, and for all but the last
  // line of a picture name written twice (a render resumed after a stop
  // draws that picture again, so only the last line describes the file).
  const rs = fs
    .readFileSync(process.argv[2], 'utf8')
    .split('\n')
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null; // empty, or cut short on the shared folder
      }
    });
  const last = new Map(rs.map((r, n) => [r && r.id, n]));
  const out = rs.map((r, n) => (r && last.get(r.id) === n ? matchRender(r) : null));
  process.stdout.write(JSON.stringify(out));
}
