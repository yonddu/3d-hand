// Hand shape recognition. Joint points alone leave a fist loose: the thumb's
// joints are small and hidden, and the model never says that the fingers
// touch. So the shape is recognised first (fist, pointing, V), from how far
// each finger reaches compared with its knuckle, and the solver is pulled
// toward a clean anatomical pose of that shape, the way Quest's hand
// tracking leans on pose priors. Open and in-between hands stay as tracked.
//
// Template angles are [flex, abduction toward the thumb] in degrees per bone
// (thumb: CMC, MCP, IP; fingers: MCP, PIP, DIP), the solver's convention.

const CURLED = {
  // Fingers converge in a fist: index leans to the middle, ring and pinky to it.
  index: [[88, -3], [100, 0], [62, 0]],
  middle: [[90, 0], [100, 0], [64, 0]],
  ring: [[90, 4], [100, 0], [62, 0]],
  pinky: [[88, 8], [98, 0], [60, 0]],
};
const STRAIGHT = { index: [[0, 0], [0, 0], [0, 0]], middle: [[0, 0], [0, 0], [0, 0]] };
// Thumb folded over the index and middle middle phalanges.
const THUMB_WRAP = [[40, 0], [50, 0], [32, 0]];

export const SHAPES = {
  fist: { label: '주먹', pose: { thumb: THUMB_WRAP, ...CURLED } },
  point: { label: '가리키기', pose: { thumb: THUMB_WRAP, ...CURLED, index: STRAIGHT.index } },
  victory: {
    label: '브이',
    pose: { thumb: THUMB_WRAP, ...CURLED, index: [[0, 7], [0, 0], [0, 0]], middle: [[0, -7], [0, 0], [0, 0]] },
  },
};

const TIPS = { index: [5, 8], middle: [9, 12], ring: [13, 16], pinky: [17, 20] };
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const clamp01 = (x) => Math.max(0, Math.min(1, x));

// 0 = straight, 1 = fully curled, from tip-to-wrist over knuckle-to-wrist.
export function curls(P) {
  const out = {};
  for (const [k, [mcp, tip]] of Object.entries(TIPS)) {
    const r = dist(P[tip], P[0]) / Math.max(dist(P[mcp], P[0]), 1e-4);
    out[k] = clamp01((1.75 - r) / (1.75 - 1.1));
  }
  return out;
}

export function shapeScores(P) {
  const c = curls(P);
  const curled = (...k) => Math.min(...k.map((x) => c[x]));
  const straight = (...k) => Math.min(...k.map((x) => 1 - c[x]));
  return {
    fist: curled('index', 'middle', 'ring', 'pinky'),
    point: Math.min(straight('index'), curled('middle', 'ring', 'pinky')),
    victory: Math.min(straight('index', 'middle'), curled('ring', 'pinky')),
  };
}

// Per hand: smoothed scores, so the shape fades in and out instead of popping.
export class ShapeTracker {
  constructor() {
    this.scores = { fist: 0, point: 0, victory: 0 };
  }

  reset() {
    for (const k of Object.keys(this.scores)) this.scores[k] = 0;
  }

  // Returns { name, weight } or null. weight is how strongly to pull toward it.
  update(P) {
    const s = shapeScores(P);
    for (const k of Object.keys(this.scores)) this.scores[k] += (s[k] - this.scores[k]) * 0.35;
    let best = null;
    for (const [k, v] of Object.entries(this.scores)) if (!best || v > best.v) best = { k, v };
    // Start pulling at 0.45 and reach full strength at 0.8.
    const weight = clamp01((best.v - 0.45) / 0.35);
    return weight > 0 ? { name: best.k, label: SHAPES[best.k].label, weight, pose: SHAPES[best.k].pose } : null;
  }
}
