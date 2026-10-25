// One Euro filter (Casiez et al. 2012): low lag when moving fast, strong
// smoothing when nearly still. Good fit for landmark jitter.

class LowPass {
  constructor() { this.y = null; }
  filter(x, a) {
    this.y = this.y === null ? x : a * x + (1 - a) * this.y;
    return this.y;
  }
}

function alpha(cutoff, dt) {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

export class OneEuro {
  constructor(params) {
    this.params = params; // shared object: { minCutoff, beta, dCutoff, lead?, maxLead? }
    this.x = new LowPass();
    this.dx = new LowPass();
    this.last = null;
  }
  reset() {
    this.x = new LowPass();
    this.dx = new LowPass();
    this.last = null;
  }
  filter(value, t) {
    const { minCutoff, beta, dCutoff } = this.params;
    if (this.last === null) {
      this.last = t;
      this.dx.filter(0, 1);
      return this.x.filter(value, 1);
    }
    const dt = Math.max(1e-3, t - this.last);
    this.last = t;
    const prev = this.x.y;
    const d = (value - prev) / dt;
    const ed = this.dx.filter(d, alpha(dCutoff, dt));
    const cutoff = minCutoff + beta * Math.abs(ed);
    const y = this.x.filter(value, alpha(cutoff, dt));
    // Prediction: lead the smoothed value along its (smoothed) velocity to
    // make up for the time the camera, the tracker and the smoothing take.
    // The filter's own state stays unpredicted, so this cannot run away.
    const { lead = 0, maxLead = 0 } = this.params;
    return lead ? y + Math.max(-maxLead, Math.min(maxLead, ed * lead)) : y;
  }
}

// Filters an array of N 3D points (flat x,y,z per point).
export class PointSetFilter {
  constructor(count, params) {
    this.filters = Array.from({ length: count * 3 }, () => new OneEuro(params));
  }
  reset() { this.filters.forEach((f) => f.reset()); }
  filter(points, t) {
    return points.map((p, i) => [
      this.filters[i * 3].filter(p[0], t),
      this.filters[i * 3 + 1].filter(p[1], t),
      this.filters[i * 3 + 2].filter(p[2], t),
    ]);
  }
}
