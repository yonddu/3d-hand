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

// The palm is placed first, as one rigid piece: its world shape is turned and
// scaled until it covers the palm in the picture. Lifting each knuckle from
// the wrist on its own cannot tell a palm seen edge-on from a flat one (every
// knuckle would sit at the wrist's depth), and a flat palm seen edge-on flips
// between facing toward and away from the camera with the smallest wobble.
// A picture of a tilted palm fits two poses, mirror images in depth; the one
// the last frame had is kept (motion is continuous), unless the palm passes
// edge-on or flat, where the two meet and the world reading may switch it.
const PALM_PTS = [0, 5, 9, 13, 17];
const SAME_POSE = 25; // degrees between the two mirror poses: they are one pose
const SWITCH_VOTES = 8; // frames the world reading must disagree before a switch

function fitPalm(world, u) {
  const v3 = (i) => [world[i].x, world[i].y, world[i].z];
  const sub = (a, b) => a.map((x, n) => x - b[n]);
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const unit = (a) => {
    const l = Math.hypot(...a) || 1;
    return a.map((x) => x / l);
  };
  const W = PALM_PTS.map(v3);
  const cw = [0, 1, 2].map((n) => W.reduce((t, p) => t + p[n], 0) / W.length);
  const cu = [0, 1].map((n) => PALM_PTS.reduce((t, i) => t + u[i][n], 0) / PALM_PTS.length);
  // Palm frame of the world shape: along the middle finger, across, normal.
  const e1 = unit(sub(W[2], W[0]));
  const nW = unit(cross(sub(W[1], W[0]), sub(W[4], W[0])));
  const e2 = cross(nW, e1);
  const loc = W.map((p) => {
    const d = sub(p, cw);
    return [dot(d, e1), dot(d, e2), dot(d, nW)];
  });
  // Picture = A · (palm-plane coordinates), least squares (2x2).
  let Suu = 0, Suv = 0, Svv = 0;
  const S = [[0, 0], [0, 0]];
  loc.forEach(([pu, pv], j) => {
    const q = [u[PALM_PTS[j]][0] - cu[0], u[PALM_PTS[j]][1] - cu[1]];
    Suu += pu * pu;
    Suv += pu * pv;
    Svv += pv * pv;
    for (let r = 0; r < 2; r++) {
      S[r][0] += q[r] * pu;
      S[r][1] += q[r] * pv;
    }
  });
  const det = Suu * Svv - Suv * Suv;
  if (Math.abs(det) < 1e-12) return null;
  const inv = [[Svv / det, -Suv / det], [-Suv / det, Suu / det]];
  const A = S.map((row) => [row[0] * inv[0][0] + row[1] * inv[1][0], row[0] * inv[0][1] + row[1] * inv[1][1]]);
  // Columns of a scaled rotation: equal length, at right angles. Their depth
  // parts z1, z2 follow, up to one sign (the mirror pose).
  const a = [A[0][0], A[1][0]];
  const b = [A[0][1], A[1][1]];
  const P = a[0] * a[0] + a[1] * a[1];
  const Q = b[0] * b[0] + b[1] * b[1];
  const R = a[0] * b[0] + a[1] * b[1];
  const x = (Q - P + Math.sqrt((Q - P) ** 2 + 4 * R * R)) / 2;
  const s = Math.sqrt(P + x); // picture units per metre
  if (!(s > 1e-6)) return null;
  let z1 = Math.sqrt(Math.max(x, 0));
  let z2 = z1 > 1e-6 ? -R / z1 : Math.sqrt(Math.max(P - Q, 0));
  const pose = (sg) => {
    const c1 = [a[0], a[1], sg * z1];
    const c2 = [b[0], b[1], sg * z2];
    const c3 = cross(c1, c2).map((v) => v / s);
    const n = unit(c3);
    // Depth of each palm point (metres, relative to the wrist).
    const z = loc.map(([pu, pv, pw]) => (c1[2] * pu + c2[2] * pv + c3[2] * pw) / s);
    return { n, z: z.map((v) => v - z[0]) };
  };
  return { k: 1 / s, poses: [pose(1), pose(-1)], nWorld: nW };
}

// world: 21 {x,y,z} (MediaPipe world, metres), image: 21 {x,y} (0..1),
// aspect: frame width / height, memory: an object kept per hand between
// frames (or null). Returns 21 {x,y,z} in MediaPipe world axes
// (x right, y down, z away from the camera), wrist at the origin.
export function liftToPicture(world, image, aspect, side = null, memory = null) {
  const len = (a, b) => Math.hypot(world[a].x - world[b].x, world[a].y - world[b].y, world[a].z - world[b].z);
  // Picture units: x scaled by the aspect so both axes share one unit.
  const u = image.map((p) => [p.x * aspect, p.y]);
  const d2 = (a, b) => Math.hypot(u[a][0] - u[b][0], u[a][1] - u[b][1]);
  const palmFit = fitPalm(world, u);
  let k;
  let palmZ = null;
  if (palmFit) {
    k = palmFit.k;
    const [p0, p1] = palmFit.poses;
    const dotN = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const worldPick = dotN(p0.n, palmFit.nWorld) >= dotN(p1.n, palmFit.nWorld) ? 0 : 1;
    let pick = worldPick;
    const apart = Math.acos(Math.max(-1, Math.min(1, dotN(p0.n, p1.n)))) / (Math.PI / 180);
    if (memory && memory.n && apart > SAME_POSE) {
      const keep = dotN(p0.n, memory.n) >= dotN(p1.n, memory.n) ? 0 : 1;
      memory.votes = keep === worldPick ? 0 : (memory.votes || 0) + 1;
      pick = memory.votes >= SWITCH_VOTES ? worldPick : keep;
      if (pick === worldPick) memory.votes = 0;
    } else if (memory) memory.votes = 0;
    palmZ = palmFit.poses[pick].z;
    if (memory) memory.n = palmFit.poses[pick].n;
  } else {
    // Scale: palm segments' metric length over their picture length (median).
    const ratios = [];
    for (const [a, b] of PALM) {
      const d = d2(a, b);
      if (d > 1e-4) ratios.push(len(a, b) / d);
    }
    if (!ratios.length) return world;
    ratios.sort((p, q) => p - q);
    k = ratios[Math.floor(ratios.length / 2)];
  }
  if (memory && !memory.signs) memory.signs = [];
  // Each finger bone: its picture offset, plus a depth offset that keeps the
  // bone at its world length. Depth is the one thing a picture cannot tell:
  // the bone leans toward or away from the camera. A finger bone takes the
  // lean that bends its joint toward the palm (fingers do not bend backward
  // or sideways past their range); otherwise it keeps last frame's lean, and
  // the world reading decides only when it clearly leans one way.
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
    const palmIdx = palmZ ? PALM_PTS.indexOf(i) : -1;
    if (palmIdx > 0) {
      out[i] = { x, y, z: palmZ[palmIdx] };
    } else {
      const dx = x - out[p].x;
      const dy = y - out[p].y;
      const L = len(i, p);
      const room = Math.sqrt(Math.max(L * L - dx * dx - dy * dy, 0));
      const wz = world[i].z - world[p].z;
      let sign = wz >= 0 ? 1 : -1;
      const last = memory && memory.signs[i];
      if (last && Math.abs(wz) < 0.3 * L) sign = last;
      const finger = i >= 6 && p !== 0 && palmN && room > 1e-4;
      if (finger) {
        // Parent bone direction, and the palm side perpendicular to it.
        const gp = PARENT[p];
        const dp = unit(sub(out[p], out[gp]));
        const np = unit(palmN.map((v, n) => v - dot(palmN, dp) * dp[n]));
        const bend = (sg) => dot(unit([dx, dy, sg * room]), np);
        const a = bend(sign);
        const b = bend(-sign);
        if (a < -0.1 && b > a) sign = -sign; // that lean would bend it backward
      }
      if (memory && room > 0.25 * L) memory.signs[i] = sign;
      out[i] = { x, y, z: out[p].z + sign * room };
    }
    if (i === 17 && side) {
      // Palm normal (toward the palm side) once the palm's points are placed.
      const a = sub(out[5], out[0]);
      const b = sub(out[17], out[0]);
      palmN = unit(side === 'right' ? cross(a, b) : cross(b, a));
    }
  }
  return out;
}
