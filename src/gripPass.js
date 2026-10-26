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
import { replanMirrors } from './mirrorPass.js';

const RESET_GAP = 0.6; // seconds unseen after which the solver starts afresh, as live

const CHUNK = 15; // frames solved between breaks, so the page keeps drawing
const ARM_PAD = 20; // frames before and after a re-faced palm whose forearm is solved again

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
// and drops `solveIn`. onProgress(0..1) is told how far it is. makeArm(side)
// gives an ArmRig set up as the one used while filming, for the forearms of
// frames whose palm now faces the other way (mirrorPass.js).
export async function replanGrips(frames, onProgress = () => {}, makeArm = null) {
  const sides = ['left', 'right'];
  replanMirrors(frames);
  let done = 0;
  const total = frames.length * sides.length * 2;
  for (const side of sides) {
    const solver = new HandSolver(new HandRig(side));
    const run = async (plan) => {
      const log = [];
      const poses = [];
      const wrists = [];
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
        wrists[i] = solver.rig.wrist.quaternion.toArray();
      }
      return { log, poses, wrists };
    };
    const live = await run(null);
    const replan = live.log.some(Boolean);
    if (!replan) done += frames.length;
    const planned = replan ? await run(planGrips(live.log)) : live;
    const q0 = new THREE.Quaternion();
    const q1 = new THREE.Quaternion();
    const qf = new THREE.Quaternion();
    frames.forEach((f, i) => {
      const h = f.hands[side];
      if (!h || !live.poses[i] || !planned.poses[i]) return;
      if (h.solveIn && h.solveIn.remirrored) {
        // The palm faces the other way now: what was recorded is no base.
        h.fingers = { ...planned.poses[i] };
        h.handQ = planned.wrists[i];
        return;
      }
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
  if (makeArm) for (const side of sides) resolveArms(frames, side, makeArm);
  for (const f of frames) for (const side of sides) if (f.hands[side]) delete f.hands[side].solveIn;
  onProgress(1);
  return frames;
}

// The forearm turns with the palm: around each stretch of re-faced frames the
// arm is solved again from the hand, starting from the arm as filmed.
function resolveArms(frames, side, makeArm) {
  const flagged = frames.map((f) => !!(f.hands[side] && f.hands[side].solveIn && f.hands[side].solveIn.remirrored));
  let i = 0;
  while (i < frames.length) {
    if (!flagged[i]) {
      i++;
      continue;
    }
    let a = i;
    let b = i;
    for (let j = i; j < frames.length && j <= b + ARM_PAD; j++) if (flagged[j]) b = j;
    a = Math.max(0, a - ARM_PAD);
    b = Math.min(frames.length - 1, b + ARM_PAD);
    const arm = makeArm(side);
    const before = frames[a - 1] && frames[a - 1].hands[side];
    if (before && before.shoulder && before.elbow) arm.setFromSaved(before);
    for (let k = a; k <= b; k++) {
      const h = frames[k].hands[side];
      if (!h || !h.solveIn) continue;
      const q = new THREE.Quaternion().fromArray(h.handQ);
      if (h.solveIn.shoulder) arm.shoulder.fromArray(h.solveIn.shoulder);
      else arm.shoulder.copy(arm.homeShoulder);
      const hint = h.solveIn.elbow ? new THREE.Vector3().fromArray(h.solveIn.elbow) : null;
      arm.update(new THREE.Vector3().fromArray(h.wrist), q, hint);
      if (arm.fixedHandQ) q.copy(arm.fixedHandQ);
      const m = arm.measure(q);
      Object.assign(h, { handQ: q.toArray(), upperQ: m.upperArmQuat, foreQ: m.forearmQuat, elbow: m.elbow, shoulder: m.shoulder });
    }
    i = b + 1;
  }
}
