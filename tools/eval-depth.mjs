// Depth misreads on the finished motion of filmed takes (what the GLB gets
// after cleanTake and the hand separation), for the user's thumb and folded
// finger reports. Per take:
//   snap    a finger's middle + end joints (thumb: MCP + IP) changing more than
//           SNAP deg within 3 frames (0.1 s; the clean-up spreads a snap over a
//           few) while the picture shows that finger still (moved under STILL
//           palm lengths): a depth misread
//   tpierce frames with the thumb inside another finger (more than PIERCE),
//           the deepest, and the longest run in frames
//   tback   frames with a thumb joint behind the back of the hand (wrist frame,
//           deeper than BACK below the knuckles' plane; the thumb can't go there)
//   stuck   fingers straight in the picture but bent past 60 deg (folded pose kept)
//   opened  fingers folded in the picture (tip back past the knuckle) but under 60 deg
//   off2d   mean distance of the 21 drawn joints from the picture's, in palm
//           lengths, after matching wrist and scale (weak perspective)
//   ms      replay time per frame
// It cannot tell the true depth: a monocular picture does not show it. These
// count what the picture rules out or what jumps without a cause in it.
//   node tools/eval-depth.mjs <take.glb ...> [--json]
import path from 'path';
import { readTake, replay } from './replay.mjs';
import { HandRig } from '../src/handRig.js';
import { BODY, bodyPoints } from '../src/handBody.js';
import { overlaps } from '../src/collide.js';

const SNAP = 60; // as replay.mjs pstill
const STILL = 0.12;
const SPAN = 3; // frames
const PIERCE = 0.008;
const BACK = 0.012; // m behind the knuckles' plane: the back of the hand's skin (collide.js PALM_BACK)
const BODY_SIZE = Math.hypot(...BODY.right.base.middle) / 0.09;
const CH = { thumb: [1, 2, 3, 4], index: [5, 6, 7, 8], middle: [9, 10, 11, 12], ring: [13, 14, 15, 16], pinky: [17, 18, 19, 20] };
const rigs = { left: new HandRig('left'), right: new HandRig('right') };

function pose(side, h) {
  const rig = rigs[side];
  rig.group.position.fromArray(h.wrist);
  rig.wrist.quaternion.fromArray(h.handQ);
  for (const chain of Object.values(rig.chains)) for (const l of chain) if (h.fingers[l.bone.name]) l.bone.quaternion.fromArray(h.fingers[l.bone.name]);
  return rig;
}
const ang = (P, a, b, c) => {
  const u = P[a].clone().sub(P[b]);
  const w = P[c].clone().sub(P[b]);
  return 180 - (u.angleTo(w) * 180) / Math.PI;
};
// Bend of the two outer joints of each finger, degrees.
const bends = (P) => Object.fromEntries(Object.entries(CH).map(([k, c]) => [k, ang(P, c[0], c[1], c[2]) + ang(P, c[1], c[2], c[3])]));

export function evalTake(file) {
  const take = readTake(file);
  const t0 = performance.now();
  const r = replay(take, { keep: true });
  const ms = (performance.now() - t0) / take.frames.length;
  const raw = take.frames;
  const pic = (fi, side) => {
    const f = raw[fi];
    if (!f) return null;
    // the detection the replay took for this side: nearest wrist to the drawn one is unknown here, so take the labelled one, else the only one
    const hs = f.hands;
    const h = hs.find((x) => x.label === side) || (hs.length === 1 ? hs[0] : null);
    if (!h) return null;
    const d = h.dims || 3;
    const out = [];
    for (let i = 0; i < 21; i++) out.push([h.lm[i * d] * take.aspect, h.lm[i * d + 1]]);
    return out;
  };
  const s = { frames: 0, snap: 0, snapDeg: 0, tpierce: 0, tdeep: 0, tback: 0, trun: 0, stuck: 0, opened: 0, off2d: 0, ms };
  const prev = { left: [], right: [] };
  const run = { left: 0, right: 0 };
  r.motion.forEach((f, fi) => {
    for (const side of ['left', 'right']) {
      const h = f.hands[side];
      const p2 = pic(fi, side);
      if (!h || !h.fingers) {
        prev[side] = [];
        run[side] = 0;
        continue;
      }
      s.frames++;
      const rig = pose(side, h);
      const P = rig.landmarkPositions();
      const B = bends(P);
      // thumb inside another finger
      const bp = bodyPoints(rig);
      if ([2, 3, 4].some((i) => rig.wrist.worldToLocal(bp[i].clone()).z < -BACK)) s.tback++;
      const th = overlaps(bp, BODY_SIZE, PIERCE).filter((o) => o.a === 'thumb' || o.b === 'thumb');
      if (th.length) {
        s.tpierce++;
        s.tdeep = Math.max(s.tdeep, ...th.map((o) => o.depth));
        run[side]++;
        s.trun = Math.max(s.trun, run[side]);
      } else run[side] = 0;
      if (p2) {
        const palm = Math.hypot(p2[9][0] - p2[0][0], p2[9][1] - p2[0][1]) || 1;
        // weak perspective: picture (x, down) vs drawn (x, up), from the wrist, best scale
        const R = P.map((v) => [v.x - P[0].x, -(v.y - P[0].y)]);
        const Q = p2.map((v) => [v[0] - p2[0][0], v[1] - p2[0][1]]);
        let num = 0;
        let den = 0;
        for (let i = 0; i < 21; i++) {
          num += R[i][0] * Q[i][0] + R[i][1] * Q[i][1];
          den += R[i][0] ** 2 + R[i][1] ** 2;
        }
        const k = num / (den || 1);
        let e = 0;
        for (let i = 0; i < 21; i++) e += Math.hypot(k * R[i][0] - Q[i][0], k * R[i][1] - Q[i][1]);
        s.off2d += e / 21 / palm;
        const d = (a, b) => Math.hypot(p2[a][0] - p2[b][0], p2[a][1] - p2[b][1]);
        for (const [key, c] of Object.entries(CH)) {
          if (key === 'thumb') continue;
          const pathL = d(c[0], c[1]) + d(c[1], c[2]) + d(c[2], c[3]);
          if (d(c[0], c[3]) > 0.95 * pathL && d(c[0], c[3]) > 0.8 * palm && B[key] > 60) s.stuck++;
          const a = [p2[c[0]][0] - p2[0][0], p2[c[0]][1] - p2[0][1]];
          const la = Math.hypot(...a) || 1;
          const back = ((p2[c[3]][0] - p2[c[0]][0]) * a[0] + (p2[c[3]][1] - p2[c[0]][1]) * a[1]) / la;
          if (la > 0.5 * palm && back < -0.05 * palm && B[key] < 60) s.opened++;
        }
        const hist = (prev[side] ||= []);
        const pp = hist.length >= SPAN ? hist[hist.length - SPAN] : null;
        if (pp && pp.p2 && f.t - pp.t < 0.15) {
          for (const [key, c] of Object.entries(CH)) {
            const moved = Math.max(...c.slice(1).map((i) => Math.hypot(Q[i][0] - pp.Q[i][0], Q[i][1] - pp.Q[i][1]))) / palm;
            const dB = Math.abs(B[key] - pp.B[key]);
            if (dB > SNAP && moved < STILL) {
              s.snap++;
              s.snapDeg += dB;
            }
          }
        }
        hist.push({ t: f.t, p2, Q, B });
        if (hist.length > SPAN) hist.shift();
      } else (prev[side] ||= []).push({ t: f.t, p2: null, B });
    }
  });
  s.off2d = s.frames ? s.off2d / s.frames : 0;
  s.tdeep = Math.round(s.tdeep * 1000);
  s.snapDeg = s.snap ? Math.round(s.snapDeg / s.snap) : 0;
  s.topen = r.marks.filter((m) => m.kind === 'topen').length;
  s.pstill = r.marks.filter((m) => m.kind === 'pstill').length;
  return { ...s, swap: r.swap, flip: r.flip, jump: r.jump, fjump: r.fjump };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  for (const f of files) {
    const s = evalTake(f);
    if (process.argv.includes('--json')) console.log(JSON.stringify({ take: path.basename(f), ...s }));
    else console.log(`${path.basename(f).padEnd(26)} snap ${s.snap} (${s.snapDeg} deg)  tpierce ${s.tpierce} deepest ${s.tdeep} mm longest ${s.trun} fr  tback ${s.tback}  stuck ${s.stuck}  opened ${s.opened}  off2d ${s.off2d.toFixed(3)}  topen ${s.topen}  pstill ${s.pstill}  fjump ${s.fjump}  jump ${s.jump}  ${s.ms.toFixed(1)} ms/fr`);
  }
}
