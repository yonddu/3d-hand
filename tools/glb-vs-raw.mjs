// Saved animation vs MediaPipe's own reading in the same GLB: per joint bend
// (angle between bones, no depth tricks) frame to frame. Answers "is the
// finished hand jumpier / straighter than what MediaPipe saw?".
//
//   node tools/glb-vs-raw.mjs take.glb
import fs from 'fs';
import { measureGlb } from './glb-pierce.mjs';

const path = process.argv[2];
const b = fs.readFileSync(path);
const jl = b.readUInt32LE(12);
const json = JSON.parse(b.subarray(20, 20 + jl).toString());
const raw = (json.scenes?.[0]?.extras || {}).raw || json.nodes.find((n) => n.extras && n.extras.raw).extras.raw;

// Joint bends: [a, b, c] = angle at b between a->b and b->c (0 = straight).
const JOINTS = [];
for (let f = 0; f < 5; f++) { const r = 1 + 4 * f; JOINTS.push([0, r, r + 1], [r, r + 1, r + 2], [r + 1, r + 2, r + 3]); }
const NAMES = ['T-cmc', 'T-mcp', 'T-ip', 'I-mcp', 'I-pip', 'I-dip', 'M-mcp', 'M-pip', 'M-dip', 'R-mcp', 'R-pip', 'R-dip', 'P-mcp', 'P-pip', 'P-dip'];
const bend = (P, [a, b2, c]) => {
  const u = [0, 1, 2].map((k) => P[b2][k] - P[a][k]);
  const v = [0, 1, 2].map((k) => P[c][k] - P[b2][k]);
  const d = u.reduce((s, x, k) => s + x * v[k], 0) / Math.hypot(...u) / Math.hypot(...v);
  return (Math.acos(Math.max(-1, Math.min(1, d))) * 180) / Math.PI;
};

const JUMP = +(process.env.JUMP || 30);
const side = process.env.SIDE || 'right';
const rawS = [];
for (const f of raw.frames) {
  const h = f.hands.find((x) => x.label === side);
  if (!h) continue;
  const P = []; for (let i = 0; i < 21; i++) P.push([h.world[3 * i], h.world[3 * i + 1], h.world[3 * i + 2]]);
  rawS.push({ t: f.t, b: JOINTS.map((j) => bend(P, j)) });
}
const glbS = [];
const Side = side[0].toUpperCase() + side.slice(1);
measureGlb(path, (t, seen) => { if (seen[Side]) glbS.push({ t, b: JOINTS.map((j) => bend(seen[Side].L, j)) }); });

// Line up the two clocks on the index PIP.
const at = (S, t) => { let best = null; for (const s of S) if (!best || Math.abs(s.t - t) < Math.abs(best.t - t)) best = s; return best && Math.abs(best.t - t) < 0.05 ? best : null; };
let off = 0, bestErr = Infinity;
for (let o = -3; o <= 3; o += 0.033) {
  let e = 0, n = 0;
  for (let i = 0; i < glbS.length; i += 3) { const r = at(rawS, glbS[i].t + o); if (r) { e += Math.abs(r.b[4] - glbS[i].b[4]); n++; } }
  if (n > glbS.length / 6 && e / n < bestErr) { bestErr = e / n; off = o; }
}
const jumps = (S) => { const per = NAMES.map(() => 0); let all = 0; for (let i = 1; i < S.length; i++) { if (S[i].t - S[i - 1].t > 0.1) continue; S[i].b.forEach((x, k) => { if (Math.abs(x - S[i - 1].b[k]) > JUMP) { per[k]++; all++; } }); } return { all, per }; };
const jr = jumps(rawS), jg = jumps(glbS);
console.log(`${side}: raw ${rawS.length} frames, saved ${glbS.length} frames, clock offset ${off.toFixed(2)} s`);
console.log(`bend jumps >${JUMP} deg/frame: MediaPipe ${jr.all}, saved ${jg.all}`);
const mean = NAMES.map(() => [0, 0, 0]);
for (const g of glbS) { const r = at(rawS, g.t + off); if (!r) continue; g.b.forEach((x, k) => { mean[k][0] += x; mean[k][1] += r.b[k]; mean[k][2]++; }); }
console.log('joint    saved  MP   (mean bend deg)  jumps saved/MP');
NAMES.forEach((n, k) => console.log(n.padEnd(7), (mean[k][0] / mean[k][2]).toFixed(0).padStart(5), (mean[k][1] / mean[k][2]).toFixed(0).padStart(4), '            ', jg.per[k], '/', jr.per[k]));
if (process.env.SEC) {
  for (let s = 0; s < 25; s += +process.env.SEC) {
    const G = glbS.filter((g) => g.t + off >= s && g.t + off < s + +process.env.SEC);
    if (!G.length) continue;
    const row = [4, 7, 10].map((k) => { let a = 0, m = 0, n = 0; for (const g of G) { const r = at(rawS, g.t + off); if (r) { a += g.b[k]; m += r.b[k]; n++; } } return `${NAMES[k]} ${(a / n).toFixed(0)}/${(m / n).toFixed(0)}`; });
    console.log(`${s}s`, row.join('  '));
  }
}
