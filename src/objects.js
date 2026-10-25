// What the camera says the hand is holding.
//
// MediaPipe's object detector (EfficientDet-Lite0, COCO classes) finds the
// object; we keep the detection that overlaps the hand, map its class to a
// shape template, and turn its bounding box into real-world size using the
// hand itself as the ruler (a palm is ~9.4 cm from wrist to middle knuckle).

// shape: cylinder | sphere | box | rod. Sizes in meters.
//   d: diameter range, len: length range, dims: typical box [width, length, thickness]
export const CATALOG = {
  cup: { label: '컵', shape: 'cylinder', d: [0.055, 0.1], len: [0.07, 0.14] },
  bottle: { label: '병', shape: 'cylinder', d: [0.045, 0.09], len: [0.12, 0.32] },
  vase: { label: '꽃병', shape: 'cylinder', d: [0.06, 0.14], len: [0.12, 0.35] },
  'wine glass': { label: '와인잔', shape: 'rod', d: [0.007, 0.012], len: [0.06, 0.1] },
  'hair drier': { label: '드라이기', shape: 'cylinder', d: [0.03, 0.05], len: [0.08, 0.14] },
  'sports ball': { label: '공', shape: 'sphere', d: [0.06, 0.24] },
  apple: { label: '사과', shape: 'sphere', d: [0.065, 0.1] },
  orange: { label: '오렌지', shape: 'sphere', d: [0.06, 0.1] },
  donut: { label: '도넛', shape: 'sphere', d: [0.07, 0.11] },
  'teddy bear': { label: '인형', shape: 'sphere', d: [0.1, 0.3] },
  'cell phone': { label: '휴대폰', shape: 'box', dims: [0.072, 0.15, 0.009] },
  remote: { label: '리모컨', shape: 'box', dims: [0.045, 0.18, 0.02] },
  book: { label: '책', shape: 'box', dims: [0.15, 0.22, 0.025] },
  mouse: { label: '마우스', shape: 'box', dims: [0.062, 0.11, 0.035] },
  knife: { label: '칼', shape: 'rod', d: [0.014, 0.022], len: [0.15, 0.3] },
  fork: { label: '포크', shape: 'rod', d: [0.008, 0.014], len: [0.15, 0.22] },
  spoon: { label: '숟가락', shape: 'rod', d: [0.008, 0.014], len: [0.14, 0.22] },
  scissors: { label: '가위', shape: 'rod', d: [0.015, 0.025], len: [0.12, 0.22] },
  toothbrush: { label: '칫솔', shape: 'rod', d: [0.01, 0.016], len: [0.15, 0.2] },
  banana: { label: '바나나', shape: 'rod', d: [0.03, 0.04], len: [0.15, 0.22] },
  carrot: { label: '당근', shape: 'rod', d: [0.02, 0.04], len: [0.12, 0.22] },
  'hot dog': { label: '핫도그', shape: 'rod', d: [0.03, 0.045], len: [0.12, 0.2] },
  'baseball bat': { label: '배트', shape: 'rod', d: [0.028, 0.04], len: [0.3, 0.85] },
  'tennis racket': { label: '라켓 손잡이', shape: 'rod', d: [0.025, 0.035], len: [0.12, 0.2] },
  umbrella: { label: '우산 손잡이', shape: 'rod', d: [0.02, 0.035], len: [0.1, 0.3] },
};

// Defaults when the user picks a shape by hand.
export const MANUAL = {
  cylinder: { label: '원기둥', shape: 'cylinder', d: [0.065, 0.065], len: [0.11, 0.11] },
  sphere: { label: '공', shape: 'sphere', d: [0.07, 0.07] },
  box: { label: '상자', shape: 'box', dims: [0.072, 0.15, 0.009] },
  rod: { label: '막대', shape: 'rod', d: [0.015, 0.015], len: [0.15, 0.15] },
};

const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));

// Detections (normalized boxes) -> the one this hand is holding, with size in meters.
// hand: { landmarks (normalized), world (meters) }, aspect = video width / height.
export function objectForHand(detections, hand, aspect) {
  if (!detections || !detections.length) return null;
  const xs = hand.landmarks.map((p) => p.x);
  const ys = hand.landmarks.map((p) => p.y);
  const hb = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
  let best = null;
  for (const d of detections) {
    const tpl = CATALOG[d.category];
    if (!tpl) continue;
    const ob = { x0: d.x, y0: d.y, x1: d.x + d.w, y1: d.y + d.h };
    const ix = Math.max(0, Math.min(hb.x1, ob.x1) - Math.max(hb.x0, ob.x0));
    const iy = Math.max(0, Math.min(hb.y1, ob.y1) - Math.max(hb.y0, ob.y0));
    const overlap = (ix * iy) / Math.max(1e-6, Math.min(d.w * d.h, (hb.x1 - hb.x0) * (hb.y1 - hb.y0)));
    if (overlap < 0.15) continue;
    const score = d.score * overlap;
    if (!best || score > best.rank) best = { ...d, tpl, rank: score };
  }
  if (!best) return null;

  // Meters per image-width unit at the hand's depth.
  const a = hand.landmarks[0];
  const b = hand.landmarks[9];
  const pix = Math.hypot(b.x - a.x, (b.y - a.y) / aspect);
  const w0 = hand.world[0];
  const w9 = hand.world[9];
  const real = Math.hypot(w9.x - w0.x, w9.y - w0.y, w9.z - w0.z) || 0.094;
  const mpu = real / Math.max(pix, 1e-3);
  const mw = best.w * mpu;
  const mh = (best.h / aspect) * mpu;
  return { category: best.category, score: best.score, ...measure(best.tpl, Math.max(mw, mh), Math.min(mw, mh)) };
}

// Template + measured long/short extent -> concrete dimensions.
export function measure(tpl, long, short) {
  const out = { label: tpl.label, shape: tpl.shape };
  if (tpl.shape === 'sphere') out.radius = clamp((long + short) / 2, tpl.d) / 2;
  else if (tpl.shape === 'box') {
    const [w, l, t] = tpl.dims;
    const k = Math.min(1.5, Math.max(0.6, long ? long / l : 1));
    out.size = [w * k, l * k, t];
  } else {
    out.radius = clamp(short || tpl.d[0], tpl.d) / 2;
    out.length = clamp(long || tpl.len[0], tpl.len);
  }
  return out;
}

export function manualObject(shape) {
  const tpl = MANUAL[shape];
  return tpl ? { category: shape, score: 1, ...measure(tpl, 0, 0) } : null;
}
