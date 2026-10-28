// When the thumb touches a finger, over the whole finished take (user
// 2026-10-28). A touch is taken only when the thumb came to the finger and
// then stayed on it: the skin of the thumb's end within TOUCH of the
// finger's for ENTER frames, after the gap closed by APPROACH over the
// frames before; it lasts until the gap opens past LEAVE for EXIT frames.
// (The drawn points' x, y are the picture's, so the picture's own distance
// is already in the gap.) A hand at rest has every finger still, so
// "moving together" alone would call every near pair a touch; coming
// together first is what tells a touch from fingers that only pass over one
// another in the picture. One finger per frame, the nearest. thumbCore.js
// then holds the thumb on that finger's skin, neither in nor off it.
// MediaPipe gives no per-joint confidence, so the hidden-joint signal is not
// used here.
import { segDist, RADIUS, BONES } from './collide.js';
import { BODY, handPoints } from './handBody.js';

const TOUCH = 0.004; // m skin gap that counts as touching
const LEAVE = 0.012; // m skin gap that ends a touch
const APPROACH = 0.006; // m the gap closed by over the BEFORE frames before a touch starts
const BEFORE = 8;
const ENTER = 3;
const EXIT = 3;
const RAMP = +(globalThis.process?.env?.RAMP ?? 5); // frames a touch eases in and out over
const KEYS = ['index', 'middle', 'ring', 'pinky'];

// frames: finished frames; rigFor(side): HandRig. Returns { left: [{ key, w } | null per frame], right: [...] }.
export function findTouches(frames, rigFor) {
  const out = { left: frames.map(() => null), right: frames.map(() => null) };
  for (const side of ['left', 'right']) {
    const rig = rigFor(side);
    const scale = Math.hypot(...BODY[side].base.middle) / 0.09;
    // Skin gap of the thumb's end bone to each finger, per frame.
    const g = frames.map((f) => {
      const h = f.hands && f.hands[side];
      if (!h || !h.fingers || !h.wrist || !h.handQ) return null;
      const P = handPoints(rig, h);
      return Object.fromEntries(KEYS.map((k) => {
        const reach = (RADIUS.thumb + RADIUS[k]) * scale;
        let gap = Infinity;
        for (const [t0, t1] of BONES[k]) gap = Math.min(gap, segDist(P[3], P[4], P[t0], P[t1]) - reach);
        return [k, { gap }];
      }));
    });
    let on = null;
    let run = 0;
    g.forEach((cur, i) => {
      if (!cur) {
        on = null; // a hand seen again starts afresh
        run = 0;
        return;
      }
      if (on) {
        const c = cur[on];
        if (c.gap > LEAVE) run++;
        else run = 0;
        if (run >= EXIT) {
          on = null;
          run = 0;
        }
      }
      if (!on) {
        // The nearest finger the thumb lies on, for ENTER frames, having come to it.
        const k = KEYS.filter((k) => cur[k].gap < TOUCH).sort((a, b) => cur[a].gap - cur[b].gap)[0];
        const held = k && [...Array(ENTER).keys()].every((j) => g[i - j] && g[i - j][k].gap < TOUCH);
        // ...over frames all seen (not across a gap where the hand was lost).
        const from = i - ENTER - BEFORE + 1;
        const was = from >= 0 && g.slice(from, i + 1).every(Boolean) ? g[from] : null;
        const came = held && was && was[k].gap - cur[k].gap > APPROACH;
        if (came) {
          on = k;
          run = 0;
          for (let j = 0; j < ENTER; j++) out[side][i - j] = k;
        }
      }
      if (on) {
        // The nearest finger now, if the thumb slid along to the next one.
        const k = KEYS.filter((k) => cur[k].gap < TOUCH).sort((a, b) => cur[a].gap - cur[b].gap)[0];
        if (k) on = k;
        out[side][i] = on;
      }
    });
    // Eased in and out over RAMP frames, so the thumb settles onto the finger
    // and lifts off it instead of snapping.
    const keys = out[side];
    out[side] = keys.map((k, i) => {
      if (!k) return null;
      let a = 0;
      while (a < RAMP && keys[i - a - 1] === k) a++;
      let b = 0;
      while (b < RAMP && keys[i + b + 1] === k) b++;
      return { key: k, w: Math.min(1, (a + 1) / (RAMP + 1), (b + 1) / (RAMP + 1)) };
    });
  }
  return out;
}
