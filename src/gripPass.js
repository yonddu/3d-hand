// Hidden fingers in a filmed take, read with the whole clip known.
//
// While filming, a grip for the hidden fingers can only be chosen from the
// frames so far. Once the clip is done, each stretch of hidden fingers is
// read both ways (gripPrior.js planGrips): the frames before and after it,
// the whole hold, and the size of what the hand closed on. The take is solved
// once more with those grips and the change is laid onto the recorded fingers,
// so the contact fixes made while filming (realHand.js) are kept.
import * as THREE from 'three';
import { HandRig } from './handRig.js';
import { HandSolver } from './solver.js';
import { planGrips } from './gripPrior.js';

const RESET_GAP = 0.6; // seconds unseen after which the solver starts afresh, as live

const CHUNK = 15; // frames solved between breaks, so the page keeps drawing

// A break that also runs in a page out of view (timers there wait a second).
function pause() {
  return new Promise((resolve) => {
    if (typeof MessageChannel === 'undefined') return setTimeout(resolve, 0);
    const ch = new MessageChannel();
    ch.port1.onmessage = () => resolve();
    ch.port2.postMessage(0);
  });
}

// frames: recorded frames whose hands carry `solveIn` (the solver's input:
// points P as [x, y, z] and the solve options). Changes the frames in place
// and drops `solveIn`. onProgress(0..1) is told how far it is.
export async function replanGrips(frames, onProgress = () => {}) {
  const sides = ['left', 'right'];
  let done = 0;
  const total = frames.length * sides.length * 2;
  for (const side of sides) {
    const solver = new HandSolver(new HandRig(side));
    const run = async (plan) => {
      const log = [];
      const poses = [];
      let last = -1e9;
      for (let i = 0; i < frames.length; i++) {
        if (++done % CHUNK === 0) {
          onProgress(done / total);
          await pause();
        }
        const f = frames[i];
        const h = f.hands[side];
        log[i] = null;
        if (!h || !h.solveIn) continue;
        if (f.t - last > RESET_GAP) solver.reset();
        last = f.t;
        const { P, opts } = h.solveIn;
        const o = { ...opts, smoothing: false };
        if (plan) o.plan = plan[i] || null;
        solver.solve(P.map((p) => new THREE.Vector3(...p)), o);
        log[i] = solver.gripIn || null;
        poses[i] = solver.rig.getPose().bones;
      }
      return { log, poses };
    };
    const live = await run(null);
    if (!live.log.some(Boolean)) {
      done += frames.length;
      continue;
    }
    const planned = await run(planGrips(live.log));
    const q0 = new THREE.Quaternion();
    const q1 = new THREE.Quaternion();
    const qf = new THREE.Quaternion();
    frames.forEach((f, i) => {
      const h = f.hands[side];
      if (!h || !live.poses[i] || !planned.poses[i]) return;
      for (const name of Object.keys(h.fingers || {})) {
        const a = live.poses[i][name];
        const b = planned.poses[i][name];
        if (!a || !b) continue;
        // recorded * (live^-1 * planned)
        q0.fromArray(a).invert();
        q1.fromArray(b);
        h.fingers[name] = qf.fromArray(h.fingers[name]).multiply(q0.multiply(q1)).normalize().toArray();
      }
    });
  }
  for (const f of frames) for (const side of sides) if (f.hands[side]) delete f.hands[side].solveIn;
  onProgress(1);
  return frames;
}
