// Hand skeleton definition shared by the rig, the solver and the demo generator.
//
// Coordinate system (rig space, right-handed, meters):
//   +Y  wrist -> middle finger (finger direction)
//   +Z  palm normal (out of the palm)
//   +X  Y x Z  (thumb side for the right hand, pinky side for the left hand)
// Bones point along their local +Y; flexion (curling toward the palm) is a
// positive rotation about the bone's local +X, abduction a rotation about +Z.

export const SIDES = ['left', 'right'];

// MediaPipe Hand Landmarker indices.
export const LM = {
  WRIST: 0,
  THUMB_CMC: 1, THUMB_MCP: 2, THUMB_IP: 3, THUMB_TIP: 4,
  INDEX_MCP: 5, INDEX_PIP: 6, INDEX_DIP: 7, INDEX_TIP: 8,
  MIDDLE_MCP: 9, MIDDLE_PIP: 10, MIDDLE_DIP: 11, MIDDLE_TIP: 12,
  RING_MCP: 13, RING_PIP: 14, RING_DIP: 15, RING_TIP: 16,
  PINKY_MCP: 17, PINKY_PIP: 18, PINKY_DIP: 19, PINKY_TIP: 20,
};

export const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [0, 17], [17, 18], [18, 19], [19, 20],
];

// Each finger: the four landmarks its bones run through (joint 1..3 + tip).
// joints[k] is the landmark at the base of bone k, joints[k+1] its child.
export const FINGERS = [
  { key: 'thumb', label: '엄지', mixamo: 'Thumb', joints: [1, 2, 3, 4], jointNames: ['CMC', 'MCP', 'IP'] },
  { key: 'index', label: '검지', mixamo: 'Index', joints: [5, 6, 7, 8], jointNames: ['MCP', 'PIP', 'DIP'] },
  { key: 'middle', label: '중지', mixamo: 'Middle', joints: [9, 10, 11, 12], jointNames: ['MCP', 'PIP', 'DIP'] },
  { key: 'ring', label: '약지', mixamo: 'Ring', joints: [13, 14, 15, 16], jointNames: ['MCP', 'PIP', 'DIP'] },
  { key: 'pinky', label: '소지', mixamo: 'Pinky', joints: [17, 18, 19, 20], jointNames: ['MCP', 'PIP', 'DIP'] },
];

// Active range of motion in degrees, per finger and joint (MCP, PIP, DIP; for
// the thumb CMC, MCP, IP): [flexMin, flexMax, abdMin, abdMax]. Negative flexion
// is hyperextension (bending backward). Abduction is toward the thumb side as
// positive (mirrored per hand by the solver). Editable in the options panel.
// Flexion follows the clinical ROM table (MCP 90 / 0, PIP 100 / 0, DIP 90 / 0,
// thumb MCP 60 / 0, thumb IP 80 / 0); abduction and the thumb CMC are typical values.
export const DEFAULT_LIMITS = {
  thumb: [[-30, 55, -35, 45], [0, 60, -10, 10], [0, 80, 0, 0]],
  index: [[0, 90, -12, 20], [0, 100, 0, 0], [0, 90, 0, 0]],
  middle: [[0, 90, -15, 15], [0, 100, 0, 0], [0, 90, 0, 0]],
  ring: [[0, 90, -18, 10], [0, 100, 0, 0], [0, 90, 0, 0]],
  pinky: [[0, 90, -30, 10], [0, 100, 0, 0], [0, 90, 0, 0]],
};
const copyLimits = (L) => Object.fromEntries(Object.entries(L).map(([k, v]) => [k, v.map((r) => r.slice())]));
export const LIMITS = copyLimits(DEFAULT_LIMITS);

export function limitsFor(fingerKey, k) {
  return LIMITS[fingerKey][k];
}

export function setLimits(L) {
  for (const key of Object.keys(DEFAULT_LIMITS)) {
    LIMITS[key] = DEFAULT_LIMITS[key].map((def, k) => {
      const row = L && L[key] && L[key][k];
      return Array.isArray(row) && row.length === 4 && row.every(Number.isFinite) ? row.slice() : def.slice();
    });
  }
}

// Bone names follow the Mixamo convention so poses can be retargeted later
// (LeftHand, LeftHandIndex1..4, RightHandThumb1..4, ...).
export function wristName(side) {
  return side === 'left' ? 'LeftHand' : 'RightHand';
}
export function boneName(side, finger, k) {
  return `${wristName(side)}${finger.mixamo}${k + 1}`;
}

// Canonical adult right hand (meters), palm facing +Z, thumb on +X.
const RIGHT_REST = [
  [0.000, 0.000, 0.000],
  [0.024, 0.026, 0.008], [0.044, 0.052, 0.016], [0.058, 0.077, 0.020], [0.068, 0.099, 0.022],
  [0.024, 0.090, 0.000], [0.028, 0.131, 0.000], [0.030, 0.154, 0.000], [0.031, 0.173, 0.000],
  [0.003, 0.094, 0.000], [0.003, 0.139, 0.000], [0.003, 0.166, 0.000], [0.003, 0.187, 0.000],
  [-0.017, 0.088, 0.000], [-0.020, 0.129, 0.000], [-0.022, 0.154, 0.000], [-0.023, 0.174, 0.000],
  [-0.035, 0.078, 0.000], [-0.040, 0.108, 0.000], [-0.042, 0.127, 0.000], [-0.043, 0.145, 0.000],
];

// +1 when the thumb is on +X in rig space.
export function sideSign(side) {
  return side === 'right' ? 1 : -1;
}

export function restLandmarks(side) {
  const s = sideSign(side);
  return RIGHT_REST.map(([x, y, z]) => [x * s, y, z]);
}

// Approximate finger radii (meters) for the procedural mesh.
export const RADII = {
  thumb: [0.0115, 0.0095, 0.0085],
  index: [0.0088, 0.0080, 0.0072],
  middle: [0.0090, 0.0082, 0.0074],
  ring: [0.0085, 0.0077, 0.0070],
  pinky: [0.0075, 0.0068, 0.0062],
};
