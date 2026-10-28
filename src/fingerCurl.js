// Finger curl read from the hand's pixels: the 15 joint flexions (thumb
// CMC/MCP/IP, then MCP/PIP/DIP of index..pinky, degrees) and how sure the
// network is of each (its own error estimate, degrees). MediaPipe's points
// read curled fingers too open (tools/synth-eval.mjs); the picture shows the
// fold. Trained on painted renders (tools/palm/train_curl.py), same crop as
// the palm/back model (palmFace.js).
import { half, conv, fetchModel } from './palmFace.js';
import { gpuConvs } from './gpuNet.js';

// Two crop sizes (tools/palm/train.py): 64, or 128 with one more halving
// first. Which one a model file is follows from its number of weights.
const LAYERS_FOR = {
  64: [
    [3, 16],
    [16, 32],
    [32, 48],
    [48, 64],
  ],
  128: [
    [3, 16],
    [16, 16],
    [16, 32],
    [32, 48],
    [48, 64],
  ],
};
const count = (layers, outs) => layers.reduce((n, [ci, co]) => n + 9 * ci * co + co, 0) + (16 * 64 + 1) * 2 * outs;
const KEYS = ['thumb', 'index', 'middle', 'ring', 'pinky'];

// One picture network of this shape (the curl model, jointCube.js): loads its
// weights once from url; run(rgba) gives its 2*outs raw outputs (means, then
// log spreads), or null before the weights have loaded. size(): the crop side
// it reads (palmFace.js cutHand), known once loaded. The convolutions run on
// the GPU where WebGL2 allows (gpuNet.js), else in plain JS.
export function pictureNet(url, outs) {
  let weights = null;
  let loading = null;
  let S = 64;
  let LAYERS = LAYERS_FOR[64];
  let gpu = null;
  const load = (base = '') => {
    if (!loading) {
      loading = fetchModel(url, base)
        .then((buf) => {
          const h = new Uint16Array(buf);
          S = Number(Object.keys(LAYERS_FOR).find((k) => count(LAYERS_FOR[k], outs) === h.length));
          if (!S) throw new Error(`${url}: ${h.length} weights fit no known layout`);
          LAYERS = LAYERS_FOR[S];
          const all = new Float32Array(h.length);
          for (let i = 0; i < h.length; i++) all[i] = half(h[i]);
          let o = 0;
          const take = (n) => all.subarray(o, (o += n));
          const w = LAYERS.map(([ci, co]) => ({ ci, co, w: take(9 * ci * co), b: take(co) }));
          const n = 16 * LAYERS[LAYERS.length - 1][1];
          w.push({ n, w: take(n * 2 * outs), b: take(2 * outs) });
          gpu = gpuConvs(w.slice(0, LAYERS.length), S);
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
    if (gpu) x = gpu(x);
    else {
      let size = S;
      for (let l = 0; l < LAYERS.length; l++) {
        x = conv(x, size, weights[l]);
        size /= 2;
      }
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
  return { load, run, ready: () => !!weights, size: () => S, gpu: () => !!gpu };
}

const J = 15;
const SCALE = 90;
const net = pictureNet('vendor/models/finger_curl.bin', J);

// Loads the weights once (about 150 KB); later calls return the same promise.
export const loadFingerCurl = net.load;
export const fingerCurlReady = net.ready;
export const fingerCurlSize = net.size; // crop side it reads (64 or 128)

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
