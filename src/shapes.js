// Basic finger and thumb shapes, as joint angles (degrees; layouts as in
// fit.js). The gesture dictionary is built from them, and the fit uses them
// for joints the camera cannot see: a hidden joint takes the shape whose
// seen joints match the hand best.

// Finger shapes: [mcpFlex, pipFlex, dipFlex].
export const F = {
  E: [0, 0, 0], // straight
  C: [85, 100, 70], // curled into the palm (fist)
  B: [85, 5, 5], // bent at the knuckle only
  H: [5, 95, 70], // hooked: knuckle straight, the rest curled (claw)
  R: [35, 45, 30], // rounded, as around a ball (C shape)
  O: [50, 60, 40], // rounded until the tip meets the thumb
  X: [25, 95, 65], // hooked index (ASL X)
  h: [50, 55, 35], // half closed
  K: [20, 15, 10], // slightly bent (relaxed)
  T: [70, 90, 50], // tucked under the thumb (ASL E, M, N)
};

// Thumb shapes.
export const T = {
  out: [0, 0, 0, 0, 0, 0, 0], // relaxed, out to the side
  L: [0, 40, 0, 0, 0, 0, 0], // swung wide (L, gun)
  side: [5, -30, 0, 5, 0, 0, 0], // against the side of the index (ASL A)
  up: [0, -15, 0, 0, 0, 0, 0], // raised along the hand (thumbs-up)
  across: [40, -30, 0, 40, 0, 0, 30], // folded across the palm (B, 4)
  wrap: [21, 0, -2, 41, -10, 0, 36], // over the curled index and middle (S, fist)
  tuck: [45, -30, 0, 55, 0, 0, 45], // under the curled fingertips (E)
  touchI: [35, -5, 0, 25, -10, 0, 20], // tip on the index tip (O, F, OK)
  touchM: [45, -15, 0, 30, -10, 0, 20], // on the middle tip
  touchR: [52, -22, 0, 35, -10, 0, 25], // on the ring tip
  touchP: [55, -30, 0, 40, -10, 0, 30], // on the little finger tip
  between: [30, -12, 0, 30, 0, 0, 5], // pushed between index and middle (fig, T)
  overIndex: [20, -20, 0, 15, -10, 0, 0], // pad across the bent index (finger heart)
  C: [25, 10, 0, 15, 0, 0, 15], // curved opposite the fingers (C)
  pinch: [30, 0, 0, 20, -8, 0, 15], // pad to pad with the index (pinch)
  key: [5, -25, 0, 25, 0, 0, 25], // pad on the side of the index (key grip)
  ext: [0, 20, 0, -10, 0, 0, -10], // stretched out (5, high five)
};

