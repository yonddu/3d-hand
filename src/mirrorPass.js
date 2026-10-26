// Which way the palm faced in a filmed take, read with the whole clip known.
//
// While filming, each frame's palm is placed facing one of its two mirror
// poses from that frame and the ones before it (lift.js). Once the clip is
// done, the choice is made again over the whole take (mirrorPlan.js), and the
// frames whose palm should face the other way get their points lifted again.
// gripPass.js then solves those frames afresh (hand, fingers and forearm).
import { liftToPicture } from './lift.js';
import { planMirrors } from './mirrorPlan.js';

// frames: recorded frames whose hands carry `solveIn` with `relift` (the
// tracker's own reading: world, image, aspect, firstPerson, flip, mirror).
// Changes solveIn.P in place and marks those frames solveIn.remirrored.
// Returns how many frames changed.
export function replanMirrors(frames) {
  let changed = 0;
  for (const side of ['left', 'right']) {
    const hand = (f) => f.hands[side] && f.hands[side].solveIn && f.hands[side].solveIn.relift;
    const readings = frames.map((f) => (hand(f) ? hand(f).mirror || null : null));
    const want = planMirrors(readings);
    if (!readings.some((r, i) => r && want[i] && want[i] !== r.n[r.pick])) continue;
    // Lifted again in order, so each frame's bone leans follow the last.
    const memory = {};
    let last = -1e9;
    frames.forEach((f, i) => {
      const r = hand(f);
      if (!r) return;
      if (f.t - last > 1) for (const k of Object.keys(memory)) delete memory[k];
      last = f.t;
      memory.want = want[i];
      const out = liftToPicture(r.world, r.image, r.aspect, side, memory, r.firstPerson);
      const m = readings[i];
      if (!m || !want[i] || want[i] === m.n[m.pick]) return;
      const s = r.flip ? -1 : 1;
      f.hands[side].solveIn.P = out.map((p) => [s * p.x, -p.y, -s * p.z]);
      f.hands[side].solveIn.remirrored = true;
      changed++;
    });
  }
  return changed;
}
