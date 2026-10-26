// Palm or back of the hand toward the camera, read from the hand's pixels
// (nails, palm lines, knuckle wrinkles, the lighter palm) by a small network
// trained on painted renders of the hand model (tools/palm/train.py). Seen
// from the camera, that and where the thumb lies in the picture give left or
// right without MediaPipe's depth or label.
//
// The crop is cut as tools/palm/crops.py cuts it: turned so the wrist to
// middle knuckle line points up, square, 1.2x the hand's reach, 64x64.
const S = 64;
const LAYERS = [
  [3, 16],
  [16, 32],
  [32, 48],
  [48, 64],
];
const URL_BIN = 'vendor/models/palm_face.bin';

let weights = null;
let loading = null;

export function half(h) {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const f = h & 0x3ff;
  if (e === 0) return s * f * 2 ** -24;
  if (e === 31) return f ? NaN : s * Infinity;
  return s * (1 + f / 1024) * 2 ** (e - 15);
}

// Loads the weights once (about 120 KB); later calls return the same promise.
export function loadPalmFace(base = '') {
  if (!loading) {
    loading = fetch(base + URL_BIN)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`palm_face.bin ${r.status}`))))
      .then((buf) => {
        const h = new Uint16Array(buf);
        const all = new Float32Array(h.length);
        for (let i = 0; i < h.length; i++) all[i] = half(h[i]);
        let o = 0;
        const take = (n) => all.subarray(o, (o += n));
        weights = LAYERS.map(([ci, co]) => ({ ci, co, w: take(9 * ci * co), b: take(co) }));
        weights.push({ w: take(LAYERS[3][1]), b: take(1) });
      });
  }
  return loading;
}

export const palmFaceReady = () => !!weights;

// Corners (top-left, top-right, bottom-left) of the crop in pixels.
export function cropBox(lm, W, H) {
  const p = lm.map((q) => [q.x * W, q.y * H]);
  let ux = p[9][0] - p[0][0];
  let uy = p[9][1] - p[0][1];
  const n = Math.hypot(ux, uy) + 1e-9;
  ux /= n;
  uy /= n;
  const rx = -uy;
  const ry = ux;
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const [x, y] of p) {
    const u = x * rx + y * ry;
    const v = x * ux + y * uy;
    u0 = Math.min(u0, u);
    u1 = Math.max(u1, u);
    v0 = Math.min(v0, v);
    v1 = Math.max(v1, v);
  }
  const cu = (u0 + u1) / 2;
  const cv = (v0 + v1) / 2;
  const h = Math.max(u1 - u0, v1 - v0) * 0.6;
  const cx = cu * rx + cv * ux;
  const cy = cu * ry + cv * uy;
  return {
    tl: [cx - h * rx + h * ux, cy - h * ry + h * uy],
    tr: [cx + h * rx + h * ux, cy + h * ry + h * uy],
    bl: [cx - h * rx - h * ux, cy - h * ry - h * uy],
  };
}

let canvas = null;
let ctx = null;

// The 64x64 crop as RGBA bytes. source: a video, image or canvas.
export function cutHand(source, lm, W, H) {
  if (!canvas) {
    canvas = typeof document !== 'undefined' ? Object.assign(document.createElement('canvas'), { width: S, height: S }) : new OffscreenCanvas(S, S);
    ctx = canvas.getContext('2d', { willReadFrequently: true });
  }
  const { tl, tr, bl } = cropBox(lm, W, H);
  // Output pixel (x, y) shows source point tl + x/S (tr - tl) + y/S (bl - tl);
  // the canvas transform is the inverse map, set from its forward form.
  const a = [(tr[0] - tl[0]) / S, (tr[1] - tl[1]) / S];
  const b = [(bl[0] - tl[0]) / S, (bl[1] - tl[1]) / S];
  const det = a[0] * b[1] - a[1] * b[0];
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, S, S);
  ctx.setTransform(b[1] / det, -a[1] / det, -b[0] / det, a[0] / det, 0, 0);
  ctx.translate(-tl[0], -tl[1]);
  ctx.drawImage(source, 0, 0, W, H);
  return ctx.getImageData(0, 0, S, S).data;
}

// The crop as a small JPEG data URL, for recordings (scoring on real video).
export function cropJpeg(source, lm, W, H) {
  cutHand(source, lm, W, H);
  return canvas.toDataURL('image/jpeg', 0.8);
}

// 3x3 stride 2 convolution with TensorFlow/JAX 'SAME' padding for an even
// size (nothing before, one row/column after), then ReLU. HWC in and out.
export function conv(x, size, { ci, co, w, b }) {
  const os = size / 2;
  const y = new Float32Array(os * os * co);
  for (let oy = 0; oy < os; oy++) {
    for (let ox = 0; ox < os; ox++) {
      const out = (oy * os + ox) * co;
      for (let c = 0; c < co; c++) y[out + c] = b[c];
      for (let ky = 0; ky < 3; ky++) {
        const iy = oy * 2 + ky;
        if (iy >= size) continue;
        for (let kx = 0; kx < 3; kx++) {
          const ix = ox * 2 + kx;
          if (ix >= size) continue;
          const xin = (iy * size + ix) * ci;
          const wk = (ky * 3 + kx) * ci * co;
          for (let i = 0; i < ci; i++) {
            const v = x[xin + i];
            if (v === 0) continue;
            const wr = wk + i * co;
            for (let c = 0; c < co; c++) y[out + c] += v * w[wr + c];
          }
        }
      }
      for (let c = 0; c < co; c++) if (y[out + c] < 0) y[out + c] = 0;
    }
  }
  return y;
}

// > 0: the palm faces the camera, < 0: the back does; |value| is how sure
// (a logit: 2 is about 88%). null before the weights have loaded.
export function palmFacing(rgba) {
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
  const co = LAYERS[3][1];
  const last = weights[LAYERS.length];
  let z = last.b[0];
  for (let c = 0; c < co; c++) {
    let m = 0;
    for (let i = 0; i < size * size; i++) m += x[i * co + c];
    z += (m / (size * size)) * last.w[c];
  }
  return z;
}

// Left or right from the picture: which way round index and pinky knuckles
// lie from the wrist (the thumb's side), read against palm or back facing.
// facing: palmFacing's value. aspect: picture width / height.
export function sideFromPicture(lm, aspect, facing) {
  const ax = (lm[5].x - lm[0].x) * aspect;
  const ay = lm[5].y - lm[0].y;
  const bx = (lm[17].x - lm[0].x) * aspect;
  const by = lm[17].y - lm[0].y;
  const turn = ax * by - ay * bx;
  return turn < 0 === facing > 0 ? 'right' : 'left';
}
