// Forearm direction straight from the camera picture. In first person the
// pose model never sees the shoulders, so it cannot place the elbow; but the
// forearm itself is usually in the frame, running from the wrist to the edge
// of the picture. Its skin has the same colour as the hand, which the hand
// landmarks tell us exactly, so: learn the hand's skin colour from the palm,
// then look around the wrist (away from the fingers) for the longest unbroken
// run of that colour. That run is the forearm's line in the picture.

const W = 160; // analysis width in pixels; small is enough for a forearm

export class ForearmFinder {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.frameAt = -1;
  }

  // Grab the current video frame once per detection.
  grab(video, stamp) {
    if (stamp === this.frameAt || !video.videoWidth) return !!this.data;
    const h = Math.round((W * video.videoHeight) / video.videoWidth);
    if (this.canvas.width !== W || this.canvas.height !== h) {
      this.canvas.width = W;
      this.canvas.height = h;
    }
    this.ctx.drawImage(video, 0, 0, W, h);
    this.data = this.ctx.getImageData(0, 0, W, h).data;
    this.frameAt = stamp;
    return true;
  }

  chroma(x, y) {
    const w = this.canvas.width;
    const h = this.canvas.height;
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= w || yi >= h) return null;
    const i = (yi * w + xi) * 4;
    const r = this.data[i];
    const g = this.data[i + 1];
    const b = this.data[i + 2];
    const Y = 0.299 * r + 0.587 * g + 0.114 * b;
    return [Y, 128 - 0.169 * r - 0.331 * g + 0.5 * b, 128 + 0.5 * r - 0.419 * g - 0.081 * b];
  }

  // L: 21 normalized hand landmarks. Returns { dir: [dx, dy] in pixels of the
  // normalized picture (x right, y down, unit length), confidence } or null.
  find(L) {
    if (!this.data) return null;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const px = (p) => [p.x * w, p.y * h];
    const wrist = px(L[0]);
    const mid = px(L[9]);
    const palm = Math.hypot(mid[0] - wrist[0], mid[1] - wrist[1]);
    if (palm < 4) return null;

    // Skin colour from the palm: points between the wrist and the knuckles.
    const samples = [];
    for (const [a, b] of [[0, 5], [0, 9], [0, 13], [0, 17], [5, 17], [1, 5], [9, 13]]) {
      for (const t of [0.35, 0.5, 0.65]) {
        const p = [L[a].x + (L[b].x - L[a].x) * t, L[a].y + (L[b].y - L[a].y) * t];
        for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [-1, 0], [0, -1]]) {
          const c = this.chroma(p[0] * w + dx, p[1] * h + dy);
          if (c) samples.push(c);
        }
      }
    }
    if (samples.length < 20) return null;
    const mean = [0, 1, 2].map((k) => samples.reduce((s, c) => s + c[k], 0) / samples.length);
    const sd = [0, 1, 2].map((k) => Math.sqrt(samples.reduce((s, c) => s + (c[k] - mean[k]) ** 2, 0) / samples.length));
    const tolCb = 2.5 * Math.max(sd[1], 2) + 3;
    const tolCr = 2.5 * Math.max(sd[2], 2) + 3;
    const tolY = 3 * Math.max(sd[0], 8) + 25;
    const isSkin = (x, y) => {
      const c = this.chroma(x, y);
      if (!c) return null; // off the picture: the arm leaves the frame here
      return Math.abs(c[1] - mean[1]) < tolCb && Math.abs(c[2] - mean[2]) < tolCr && Math.abs(c[0] - mean[0]) < tolY;
    };

    // Rays from the wrist, in the half away from the fingers.
    const back = Math.atan2(wrist[1] - mid[1], wrist[0] - mid[0]);
    const r0 = 0.3 * palm;
    const r1 = 2.6 * palm;
    const step = Math.max(1, palm / 12);
    const runs = [];
    // Inside the hand's outline the colour is the hand's own: skip it.
    const hull = [0, 1, 2, 5, 9, 13, 17].map((i) => px(L[i]));
    const inHand = (x, y) => {
      let inside = false;
      for (let i = 0, j = hull.length - 1; i < hull.length; j = i++) {
        const [xi, yi] = hull[i];
        const [xj, yj] = hull[j];
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
      return inside;
    };
    for (let da = -70; da <= 70; da += 5) {
      const a = back + (da * Math.PI) / 180;
      const c = Math.cos(a);
      const s = Math.sin(a);
      let run = 0;
      let miss = 0;
      for (let r = r0; r <= r1; r += step) {
        const x = wrist[0] + c * r;
        const y = wrist[1] + s * r;
        if (inHand(x, y)) continue;
        const k = isSkin(x, y);
        if (k === null) {
          run = r1; // reached the edge of the picture while still on skin
          break;
        }
        if (k) {
          run = r;
          miss = 0;
        } else if (++miss > 2) break;
      }
      // Wrists bend less than they could: prefer lines close to the hand's own.
      runs.push({ a, run: run * (0.75 + 0.25 * Math.cos((da * Math.PI) / 180)) });
    }
    const best = Math.max(...runs.map((r) => r.run));
    if (best < 0.9 * palm) return null;
    // Average the directions of the near-best rays (the forearm is wide).
    let sx = 0;
    let sy = 0;
    for (const { a, run } of runs) {
      if (run < 0.85 * best) continue;
      sx += Math.cos(a) * run;
      sy += Math.sin(a) * run;
    }
    const n = Math.hypot(sx, sy) || 1;
    // Back to normalized picture units (x and y scaled by the same pixel size).
    return { dir: [sx / n, sy / n], confidence: Math.min(1, best / (2 * palm)) };
  }
}
