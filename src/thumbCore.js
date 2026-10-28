// The thumb never goes through another finger's bone core in the finished
// take (user 2026-10-28: skin may press in, but a finger's middle, its bone,
// can never be passed through; thumb laid on the index sinking into it, take
// thumb_on_index_00-39 12 s and 15 s). The solver's finger walls are soft and
// the thumb push-out after the passes turns only the thumb's base, so a thumb
// pinched between two fingers stays in. Here, last, where the thumb's bone
// line comes within CORE of another finger's (each finger's core a share of
// its radius), its four joint angles (base bend and spread, middle and end
// bend) are moved as little as they can be, inside their limits, until the
// cores are clear.
import * as THREE from 'three';
import { BONES, RADIUS, segDist } from './collide.js';
import { BODY, bodyPoints } from './handBody.js';
import { limitsFor, sideSign } from './skeleton.js';
import { THUMB_BACK } from './clampBack.js';

const CORE = +(globalThis.process?.env?.CORE ?? 0.45); // share of each finger's radius that is bone core
const STEPS = 60;
const W_CORE = +(globalThis.process?.env?.W_CORE ?? 4); // a mm into a core
const W_TOUCH = +(globalThis.process?.env?.W_TOUCH ?? 0.5); // a touch's mm off the skin against a mm into a core
const STEP0 = 2; // degrees, first try per joint
const W_MOVE = 1 / 400; // cost of one degree moved, squared, against one mm into the core, squared
const D2R = Math.PI / 180;
const e = new THREE.Euler();
const q = new THREE.Quaternion();

export function coreDepth(rig, scale = Math.hypot(...BODY[rig.side].base.middle) / 0.09, touch = null) {
  const P = bodyPoints(rig).map((v) => [v.x, v.y, v.z]);
  let sum = 0;
  let worst = 0;
  // A touch (contactPass.js): the thumb's end bone rests on that finger's
  // skin, neither sunk in nor off it.
  if (touch) {
    const reach = (RADIUS.thumb + RADIUS[touch.key]) * scale;
    const d = Math.min(...BONES[touch.key].map(([t0, t1]) => segDist(P[3], P[4], P[t0], P[t1])));
    sum += W_TOUCH * touch.w * ((d - reach) * 1000) ** 2;
  }
  for (const key of ['index', 'middle', 'ring', 'pinky']) {
    const reach = (RADIUS.thumb + RADIUS[key]) * CORE * scale;
    for (const [s0, s1] of BONES.thumb) for (const [t0, t1] of BONES[key]) {
      const d = reach - segDist(P[s0], P[s1], P[t0], P[t1]);
      if (d > 0) {
        sum += W_CORE * (d * 1000) ** 2;
        worst = Math.max(worst, d);
      }
    }
  }
  return { sum, worst };
}

// frames: finished frames; rigFor(side): a HandRig; touches: contactPass.js
// findTouches or null. Touches first: each touch frame's change to the four
// angles is found, then averaged over SMOOTH frames each way (frames without
// a touch count as no change), so the thumb settles onto the finger instead
// of shaking with each frame's own best fit. Then the cores, frame by frame.
// Changes thumb bones in place (copies of the finger maps); returns the frames.
const SMOOTH = +(globalThis.process?.env?.SMOOTH ?? 3);
export function clearThumbCore(frames, rigFor, touches = null) {
  for (const side of ['left', 'right']) {
    const rig = rigFor(side);
    const scale = Math.hypot(...BODY[side].base.middle) / 0.09;
    const links = rig.chains.thumb;
    const s = sideSign(side);
    const lim = [
      [Math.max(limitsFor('thumb', 0)[0], THUMB_BACK[0]), limitsFor('thumb', 0)[1]],
      [Math.max(limitsFor('thumb', 0)[2], THUMB_BACK[1]), limitsFor('thumb', 0)[3]],
      limitsFor('thumb', 1).slice(0, 2),
      limitsFor('thumb', 2).slice(0, 2),
    ];
    // The hand's thumb as four angles (degrees) and the bones' other turns.
    const read = (h) => {
      rig.setPose({ bones: h.fingers });
      // Each thumb bone as Euler(flex, roll, -abd * side, 'XZY') on its rest turn (fit.js localFrom).
      const eul = links.map((l) => e.setFromQuaternion(l.restLocal.clone().invert().multiply(l.bone.quaternion), 'XZY').toArray().slice(0, 3));
      return { eul, x: [eul[0][0], -eul[0][2] * s, eul[1][0], eul[2][0]].map((v) => v / D2R) };
    };
    const put = (eul, x) => {
      const v = [[x[0] * D2R, eul[0][1], -x[1] * s * D2R], [x[2] * D2R, eul[1][1], eul[1][2]], [x[3] * D2R, eul[2][1], eul[2][2]]];
      links.forEach((l, k) => {
        e.set(v[k][0], v[k][1], v[k][2], 'XZY');
        l.bone.quaternion.copy(l.restLocal).multiply(q.setFromEuler(e));
      });
      rig.group.updateMatrixWorld(true);
    };
    const write = (f, h) => {
      const fingers = { ...h.fingers };
      for (const l of links) fingers[l.bone.name] = l.bone.quaternion.toArray();
      f.hands[side] = { ...h, fingers };
    };
    // The least change of the four angles that clears the cores (and holds a touch).
    const solve = (eul, start, touch) => {
      const cost = (x) => {
        put(eul, x);
        let c = coreDepth(rig, scale, touch).sum;
        x.forEach((v, i) => (c += W_MOVE * (v - start[i]) ** 2));
        return c;
      };
      const clamp = (x) => x.map((v, i) => Math.min(Math.max(v, Math.min(lim[i][0], start[i])), Math.max(lim[i][1], start[i])));
      let x = start.slice();
      let best = cost(x);
      let step = STEP0;
      for (let it = 0; it < STEPS && step > 0.05; it++) {
        let moved = false;
        for (let i = 0; i < 4; i++) for (const dir of [1, -1]) {
          const y = x.slice();
          y[i] += dir * step;
          const z = clamp(y);
          const c = cost(z);
          if (c < best) {
            best = c;
            x = z;
            moved = true;
          }
        }
        if (!moved) step /= 2;
      }
      return x;
    };
    const usable = (f) => {
      const h = f.hands && f.hands[side];
      return h && h.fingers && links.every((l) => h.fingers[l.bone.name]) ? h : null;
    };
    if (touches) {
      const delta = frames.map((f, fi) => {
        const h = usable(f);
        if (!h) return null;
        const touch = touches[side][fi];
        if (!touch) return [0, 0, 0, 0];
        const { eul, x } = read(h);
        return solve(eul, x, touch).map((v, i) => v - x[i]);
      });
      frames.forEach((f, fi) => {
        const h = usable(f);
        if (!h || !delta[fi]) return;
        const avg = [0, 0, 0, 0];
        let n = 0;
        for (let j = fi - SMOOTH; j <= fi + SMOOTH; j++) {
          if (!delta[j]) continue;
          delta[j].forEach((v, i) => (avg[i] += v));
          n++;
        }
        if (!avg.some((v) => Math.abs(v) > 1e-6)) return;
        const { eul, x } = read(h);
        put(eul, x.map((v, i) => Math.min(Math.max(v + avg[i] / n, Math.min(lim[i][0], v)), Math.max(lim[i][1], v))));
        write(f, h);
      });
    }
    frames.forEach((f) => {
      const h = usable(f);
      if (!h) return;
      rig.setPose({ bones: h.fingers });
      if (coreDepth(rig, scale).worst <= 0) return;
      const { eul, x } = read(h);
      put(eul, solve(eul, x, null));
      write(f, h);
    });
  }
  return frames;
}
