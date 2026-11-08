// Finger bend correction (v0.68): a small learned model from MediaPipe's 3D hand points to the
// finger bends the Meta Quest measured on the same moves (truth). Trained on Quest pair 2
// (6.5 min, 2026-11-09), tested on pair 1 (2 min, not used in training): bend error vs Quest
// 19.8 deg (app v0.67) -> 6.6 deg. Input only the hand's own shape (turn-free): every point and
// bone in the palm frame + the 14 bone-to-bone angles; a left hand is mirrored to a right one.
// Output: 14 signed bends in degrees (+ = toward the palm), Quest-style (angle between bones):
// thumb MCP, thumb IP, then index / middle / ring / pinky MCP, PIP, DIP.
import M from './fingercorr.json';

const f32 = (s) => { const b = atob(s); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return new Float32Array(u.buffer); };
const MU = f32(M.mu); const SD = f32(M.sd);
const LAYERS = M.layers.map((l) => ({ w: f32(l.w), b: f32(l.b), i: l.i, o: l.o }));
const BONES = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [0, 9], [9, 10], [10, 11], [11, 12], [0, 13], [13, 14], [14, 15], [15, 16], [0, 17], [17, 18], [18, 19], [19, 20]];
const TRI = [[1, 2, 3], [2, 3, 4], [0, 5, 6], [5, 6, 7], [6, 7, 8], [0, 9, 10], [9, 10, 11], [10, 11, 12], [0, 13, 14], [13, 14, 15], [14, 15, 16], [0, 17, 18], [17, 18, 19], [18, 19, 20]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const nrm = (a) => Math.hypot(a[0], a[1], a[2]);
const gelu = (x) => 0.5 * x * (1 + Math.tanh(0.7978845608028654 * (x + 0.044715 * x * x * x)));

// world: MediaPipe world points as sent (63 numbers, metres, MediaPipe axes); side 'left'/'right'.
export function features(world, side) {
  const W = [];
  for (let j = 0; j < 21; j++) W.push([(side === 'left' ? -1 : 1) * world[3 * j], world[3 * j + 1], world[3 * j + 2]]);
  let y = sub(W[9], W[0]); const sc = nrm(y); y = y.map((v) => v / sc);
  let x = sub(W[5], W[17]); const xy = dot(x, y); x = x.map((v, i) => v - y[i] * xy); const xn = nrm(x); x = x.map((v) => v / xn);
  const z = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
  const out = new Float32Array(137); let k = 0;
  for (let j = 0; j < 21; j++) { const d = sub(W[j], W[0]); out[k++] = dot(d, x) / sc; out[k++] = dot(d, y) / sc; out[k++] = dot(d, z) / sc; }
  for (const [a, b] of BONES) { const d = sub(W[b], W[a]); const n = nrm(d) || 1; out[k++] = dot(d, x) / n; out[k++] = dot(d, y) / n; out[k++] = dot(d, z) / n; }
  for (const [a, b, c] of TRI) { const u = sub(W[b], W[a]); const v = sub(W[c], W[b]); out[k++] = Math.acos(Math.max(-1, Math.min(1, dot(u, v) / (nrm(u) * nrm(v) || 1)))); }
  return out;
}

export function predictBends(world, side) {
  if (!world || world.length < 63) return null;
  let h = features(world, side);
  for (let i = 0; i < 137; i++) h[i] = (h[i] - MU[i]) / SD[i];
  if (!h.every(Number.isFinite)) return null;
  LAYERS.forEach((L, li) => {
    const o = new Float32Array(L.o);
    for (let j = 0; j < L.o; j++) o[j] = L.b[j];
    for (let i = 0; i < L.i; i++) { const v = h[i]; if (!v) continue; const r = i * L.o; for (let j = 0; j < L.o; j++) o[j] += v * L.w[r + j]; }
    if (li < LAYERS.length - 1) for (let j = 0; j < L.o; j++) o[j] = gelu(o[j]);
    h = o;
  });
  return Array.from(h, (v) => v * M.yscale);
}
