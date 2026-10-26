// Which way the palm faces, chosen with the whole take known.
//
// A palm in the picture fits two poses, mirror images in depth (lift.js).
// Frame by frame, rules pick one: what MediaPipe's world reading says, that
// the forearm alone cannot turn the palm away from the body's midline, that
// the palm keeps facing the way it did. Each rule overruling the others
// (v50, v68) fixed one take and broke another. Here every rule only adds a
// cost, and the pose for each frame is the one on the path through the whole
// take that breaks the rules least (Viterbi): a turn is placed where the two
// poses meet, edge-on, before as well as after the frames that showed it.
//
// readings[i]: lift.js out.mirror for frame i ({ n: [n0, n1], nW, v }) or null
// when the hand was not seen. Returns, per frame, the palm normal to take (or
// null), for lift.js memory.want.

const W_WORLD = 1; // per frame, per unit the world reading prefers the other pose (0..2)
const W_REACH = 1; // per frame, per unit the palm faces away from the midline past LATERAL
const LATERAL = 0.05;
const W_TURN = 6; // per radian squared the palm turns from one frame to the next
const GAP = 18; // frames unseen after which the path starts afresh

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const turn = (a, b) => Math.acos(Math.max(-1, Math.min(1, dot(a, b))));

function unary(r, s) {
  let c = W_WORLD * Math.max(0, dot(r.n[1 - s], r.nW) - dot(r.n[s], r.nW));
  if (r.v) c += W_REACH * Math.max(0, -LATERAL - r.v[s]);
  return c;
}

export function planMirrors(readings) {
  const want = readings.map(() => null);
  let i = 0;
  while (i < readings.length) {
    if (!readings[i]) {
      i++;
      continue;
    }
    // One stretch: seen frames with gaps shorter than GAP.
    const idx = [];
    let miss = 0;
    for (let j = i; j < readings.length && miss < GAP; j++) {
      if (readings[j]) {
        idx.push(j);
        miss = 0;
      } else miss++;
    }
    const cost = [];
    const from = [];
    idx.forEach((fi, k) => {
      const r = readings[fi];
      cost[k] = [0, 1].map((s) => unary(r, s));
      from[k] = [0, 0];
      if (k === 0) return;
      const p = readings[idx[k - 1]];
      for (let s = 0; s < 2; s++) {
        let best = Infinity;
        for (let q = 0; q < 2; q++) {
          const c = cost[k - 1][q] + W_TURN * turn(p.n[q], r.n[s]) ** 2;
          if (c < best) {
            best = c;
            from[k][s] = q;
          }
        }
        cost[k][s] += best;
      }
    });
    let s = cost[idx.length - 1][0] <= cost[idx.length - 1][1] ? 0 : 1;
    for (let k = idx.length - 1; k >= 0; k--) {
      want[idx[k]] = readings[idx[k]].n[s];
      s = from[k][s];
    }
    i = idx[idx.length - 1] + 1;
  }
  return want;
}
