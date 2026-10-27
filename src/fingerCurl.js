// Finger curl read from the hand's pixels: the 15 joint flexions (thumb
// CMC/MCP/IP, then MCP/PIP/DIP of index..pinky, degrees) and how sure the
// network is of each (its own error estimate, degrees). MediaPipe's points
// read curled fingers too open (tools/synth-eval.mjs); the picture shows the
// fold. Trained on painted renders (tools/palm/train_curl.py), same crop as
// the palm/back model (palmFace.js).
import { half, conv, fetchModel } from './palmFace.js';

const S = 64;
const LAYERS = [
  [3, 16],
  [16, 32],
  [32, 48],
  [48, 64],
];
const KEYS = ['thumb', 'index', 'middle', 'ring', 'pinky'];

// One picture network of this shape (the curl model, jointCube.js): loads its
// weights once from url; run(rgba) gives its 2*outs raw outputs (means, then
// log spreads), or null before the weights have loaded.
export function pictureNet(url, outs) {
  let weights = null;
  let loading = null;
  const load = (base = '') => {
    if (!loading) {
      loading = fetchModel(url, base)
        .then((buf) => {
          const h = new Uint16Array(buf);
          const all = new Float32Array(h.length);
          for (let i = 0; i < h.length; i++) all[i] = half(h[i]);
          let o = 0;
          const take = (n) => all.subarray(o, (o += n));
          const w = LAYERS.map(([ci, co]) => ({ ci, co, w: take(9 * ci * co), b: take(co) }));
          const n = 16 * LAYERS[3][1];
          w.push({ n, w: take(n * 2 * outs), b: take(2 * outs) });
          weights = w;
        })
        .catch((err) => {
          loading = null; // tried again on the next call
          throw err;
        });
    }
    return loading;
  };
  const run = (rgba) => {
    if (!weights) return null;
    let x = new Float32Array(S * S * 3);
    for (let i = 0, j = 0; i < S * S; i++, j += 4) {
      x[i * 3] = rgba[j] / 255 - 0.5;
      x[i * 3 + 1] = rgba[j + 1] / 255 - 0.5;
      x[i * 3 + 2] = rgba[j + 2] / 255 - 0.5;
    }
    let size = S;
    for (let l = 0; l < LAYERS.length; l++) {
      x = conv(x, size, weights[l]);
      size /= 2;
    }
    const { n, w, b } = weights[LAYERS.length];
    const o = Array.from(b);
    for (let i = 0; i < n; i++) {
      const v = x[i];
      if (v === 0) continue;
      const row = i * 2 * outs;
      for (let c = 0; c < 2 * outs; c++) o[c] += v * w[row + c];
    }
    return o;
  };
  return { load, run, ready: () => !!weights };
}

const J = 15;
const SCALE = 90;
const net = pictureNet('vendor/models/finger_curl.bin', J);

// Loads the weights once (about 150 KB); later calls return the same promise.
export const loadFingerCurl = net.load;
export const fingerCurlReady = net.ready;

// rgba: the 64x64 crop (palmFace.js cutHand). Returns { thumb: [{ flex, sd }
// x3], index: [...], ... } or null before the weights have loaded.
export function fingerCurl(rgba) {
  const o = net.run(rgba);
  if (!o) return null;
  const out = {};
  KEYS.forEach((k, f) => {
    out[k] = [0, 1, 2].map((i) => ({
      flex: o[f * 3 + i] * SCALE,
      sd: Math.exp(Math.min(2, Math.max(-4, o[J + f * 3 + i]))) * SCALE,
    }));
  });
  return out;
}
