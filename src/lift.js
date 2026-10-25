// Picture-true 3D points.
//
// MediaPipe gives two readings of the hand: picture points (x, y in the frame)
// and metric "world" points (a 3D guess). The picture points are the accurate
// ones; the world points often come out tilted or turned against what the
// camera shows, especially when the hand points at the camera. Headset
// trackers fit their hand model to the pictures, so here the 3D points are
// rebuilt from the picture: every point lands exactly where the camera saw
// it, each bone keeps its world length, and depth (which a single camera
// cannot measure) is chosen so joints bend the way a hand can.
//
// Weak perspective: the hand is small next to its distance from the camera,
// so one scale (metres per picture unit) is used for the whole hand.

// Parent of each landmark (wrist is the root).
const PARENT = [-1, 0, 1, 2, 3, 0, 5, 6, 7, 0, 9, 10, 11, 0, 13, 14, 15, 0, 17, 18, 19];
// Palm segments used to find the scale (they rarely all foreshorten at once).
// Palm points first (their normal guides the fingers), then the chains.
const ORDER = [1, 5, 9, 13, 17, 2, 3, 4, 6, 7, 8, 10, 11, 12, 14, 15, 16, 18, 19, 20];
const PALM = [[0, 5], [0, 9], [0, 13], [0, 17], [5, 17], [5, 9], [9, 13], [13, 17]];

// world: 21 {x,y,z} (MediaPipe world, metres), image: 21 {x,y} (0..1),
// aspect: frame width / height. Returns 21 {x,y,z} in MediaPipe world axes
// (x right, y down, z away from the camera), wrist at the origin.
export function liftToPicture(world, image, aspect, side = null) {
  const len = (a, b) => Math.hypot(world[a].x - world[b].x, world[a].y - world[b].y, world[a].z - world[b].z);
  // Picture units: x scaled by the aspect so both axes share one unit.
  const u = image.map((p) => [p.x * aspect, p.y]);
  const d2 = (a, b) => Math.hypot(u[a][0] - u[b][0], u[a][1] - u[b][1]);
  // Scale: palm segments' metric length over their picture length. The
  // median, so one foreshortened or misplaced segment does not set it.
  const ratios = [];
  for (const [a, b] of PALM) {
    const d = d2(a, b);
    if (d > 1e-4) ratios.push(len(a, b) / d);
  }
  if (!ratios.length) return world;
  ratios.sort((p, q) => p - q);
  const k = ratios[Math.floor(ratios.length / 2)];
  // Each bone: its picture offset, plus a depth offset that keeps the bone at
  // its world length. Depth is the one thing a picture cannot tell: the bone
  // leans toward or away from the camera. A finger bone takes the lean that
  // bends its joint toward the palm (fingers do not bend backward or
  // sideways past their range); the world reading only breaks ties, and
  // decides for the palm and thumb.
  const out = new Array(21);
  out[0] = { x: 0, y: 0, z: 0 };
  const sub = (a, b) => [a.x - b.x, a.y - b.y, a.z - b.z];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const unit = (a) => {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  };
  let palmN = null;
  for (const i of ORDER) {
    const p = PARENT[i];
    const x = (u[i][0] - u[0][0]) * k;
    const y = (u[i][1] - u[0][1]) * k;
    const dx = x - out[p].x;
    const dy = y - out[p].y;
    const L = len(i, p);
    const room = Math.sqrt(Math.max(L * L - dx * dx - dy * dy, 0));
    const wz = world[i].z - world[p].z;
    let sign = wz >= 0 ? 1 : -1;
    const finger = i >= 6 && p !== 0 && palmN && room > 1e-4;
    if (finger) {
      // Parent bone direction, and the palm side perpendicular to it.
      const gp = PARENT[p];
      const dp = unit(sub(out[p], out[gp]));
      const np = unit(palmN.map((v, n) => v - dot(palmN, dp) * dp[n]));
      const bend = (s) => dot(unit([dx, dy, s * room]), np);
      const a = bend(sign);
      const b = bend(-sign);
      if (a < -0.1 && b > a) sign = -sign; // the world lean would bend it backward
    }
    out[i] = { x, y, z: out[p].z + sign * room };
    if (i === 17 && side) {
      // Palm normal (toward the palm side) once the palm's points are placed.
      const a = sub(out[5], out[0]);
      const b = sub(out[17], out[0]);
      palmN = unit(side === 'right' ? cross(a, b) : cross(b, a));
    }
  }
  return out;
}
