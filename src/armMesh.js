// Arm skin that grows out of the hand's wrist opening.
//
// The hand model is cut open at the wrist (RealHand), and this loft starts on
// exactly those border vertices, then widens through the forearm, elbow and
// upper arm with anatomical cross-sections. Built in the bind pose: arm
// straight along its bones' +Y, which at the wrist is the hand's +Y, so hand
// space (x, y, z) is arm space (x, UPPER + FORE + y, z).
import * as THREE from 'three';
import { borderLoops } from './meshOps.js';

export const UPPER = 0.29; // shoulder -> elbow
export const FORE = 0.26; // elbow -> wrist
const WRIST_A = UPPER + FORE;
// The wrist bends over this much skin, ending at the hand's border (which is
// cut 1.5 cm above the joint), so the bend straddles the joint. Real skin
// creases within ~3 cm of the wrist; a longer blend moved the visible bend
// down onto the forearm.
const WRIST_BEND = 0.035;

// Cross-section [width across the hand (x), thickness (z)] by distance from the shoulder.
const PROFILE = [
  [-0.04, 0.112, 0.112],
  [0.0, 0.11, 0.11],
  [0.06, 0.1, 0.1],
  [0.14, 0.09, 0.094], // biceps
  [0.23, 0.078, 0.074],
  [0.29, 0.074, 0.068], // elbow
  [0.34, 0.075, 0.064], // forearm muscle belly
  [0.4, 0.068, 0.054],
  [0.47, 0.06, 0.044],
];

function catmull(keys, a, col) {
  let i = 0;
  while (i < keys.length - 2 && keys[i + 1][0] < a) i++;
  const k0 = keys[Math.max(0, i - 1)];
  const k1 = keys[i];
  const k2 = keys[i + 1];
  const k3 = keys[Math.min(keys.length - 1, i + 2)];
  const t = THREE.MathUtils.clamp((a - k1[0]) / (k2[0] - k1[0]), 0, 1);
  const p0 = k0[col];
  const p1 = k1[col];
  const p2 = k2[col];
  const p3 = k3[col];
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
}

// Wrist border of a hand skin given in hand-bone space ({position, normal, index}).
// Returns the ordered border (points, normals, skin vertex ids) and, per border
// vertex, the hand surface's slope there: how far it drifts in x/z per meter
// going down the arm, so the arm can leave the border at the same angle.
export function wristLoop(skin) {
  if (skin && skin.index) {
    const P = [];
    for (let i = 0; i < skin.position.length; i += 3) P.push(new THREE.Vector3().fromArray(skin.position, i));
    const T = [];
    for (let t = 0; t < skin.index.length; t += 3) T.push([skin.index[t], skin.index[t + 1], skin.index[t + 2]]);
    const loops = borderLoops({ P, T });
    const meanY = (l) => l.reduce((s, v) => s + P[v].y, 0) / l.length;
    const loop = loops.filter((l) => l.length >= 8).sort((a, b) => meanY(a) - meanY(b))[0];
    if (loop) {
      // Hand cross-section a little above the border: where the surface is
      // heading, read from the real geometry rather than one noisy neighbor.
      const by = meanY(loop);
      const section = sliceY(P, T, by + 0.012);
      const c = loop.reduce((s, v) => s.add(P[v]), new THREE.Vector3()).divideScalar(loop.length);
      const slopes = loop.map((v) => {
        const up = section.length ? rayHit(section, c, P[v].x - c.x, P[v].z - c.z) : null;
        if (!up) return new THREE.Vector2();
        const dy = up.y - P[v].y;
        return new THREE.Vector2((P[v].x - up.x) / dy, (P[v].z - up.z) / dy).clampLength(0, 0.6);
      });
      return {
        ids: loop,
        points: loop.map((v) => P[v].clone()),
        normals: loop.map((v) => new THREE.Vector3().fromArray(skin.normal, v * 3)),
        slopes,
      };
    }
  }
  // No open wrist (procedural hand): an ellipse just inside its forearm stub.
  const points = [];
  const normals = [];
  const slopes = [];
  for (let i = 0; i < 32; i++) {
    const a = (i / 32) * Math.PI * 2;
    points.push(new THREE.Vector3(0.026 * Math.cos(a), -0.008, 0.017 * Math.sin(a)));
    normals.push(new THREE.Vector3(Math.cos(a), 0, Math.sin(a)).normalize());
    slopes.push(new THREE.Vector2());
  }
  return { ids: null, points, normals, slopes };
}

// Segments where the plane y = Y cuts the triangles.
function sliceY(P, T, Y) {
  const segs = [];
  for (const tri of T) {
    const pts = [];
    for (let i = 0; i < 3; i++) {
      const a = P[tri[i]];
      const b = P[tri[(i + 1) % 3]];
      if ((a.y - Y) * (b.y - Y) < 0) pts.push(a.clone().lerp(b, (Y - a.y) / (b.y - a.y)));
    }
    if (pts.length === 2) segs.push(pts);
  }
  return segs;
}

// Outermost crossing of the ray from c along (dx, dz) with the segments.
function rayHit(segs, c, dx, dz) {
  let best = null;
  let bestT = 0;
  for (const [a, b] of segs) {
    const ax = a.x - c.x;
    const az = a.z - c.z;
    const ex = b.x - a.x;
    const ez = b.z - a.z;
    const den = dx * ez - dz * ex;
    if (Math.abs(den) < 1e-12) continue;
    const t = (ax * ez - az * ex) / den;
    const s = (ax * dz - az * dx) / den;
    if (t > 0 && s >= 0 && s <= 1 && t > bestT) {
      bestT = t;
      best = a.clone().lerp(b, s);
    }
  }
  return best;
}

// loop: from wristLoop(). Returns geometry data in arm (bind) space.
export function buildArm(loop, { ringSize = 64 } = {}) {
  const L = loop.points.length;
  const c = loop.points.reduce((s, p) => s.add(p), new THREE.Vector3()).divideScalar(L);
  const lx = Math.max(...loop.points.map((p) => p.x)) - Math.min(...loop.points.map((p) => p.x));
  const lz = Math.max(...loop.points.map((p) => p.z)) - Math.min(...loop.points.map((p) => p.z));
  const nx = (p) => (p.x - c.x) / lx;
  const nz = (p) => (p.z - c.z) / lz;

  // First ring: evenly spaced angles, each landing on the border polygon (its
  // outermost crossing), so the rings stay ordered whatever the border's
  // vertex spacing. Slope is interpolated along the border edge.
  const R = ringSize;
  const ring0 = [];
  const ring0S = [];
  for (let j = 0; j < R; j++) {
    const th = (j / R) * Math.PI * 2;
    const dx = Math.cos(th);
    const dz = Math.sin(th);
    let best = null;
    for (let i = 0; i < L; i++) {
      const a = loop.points[i];
      const b = loop.points[(i + 1) % L];
      const ax = nx(a);
      const az = nz(a);
      const ex = nx(b) - ax;
      const ez = nz(b) - az;
      const den = dx * ez - dz * ex;
      if (Math.abs(den) < 1e-9) continue;
      const t = (ax * ez - az * ex) / den; // along the ray
      const s = (ax * dz - az * dx) / den; // along the edge
      if (t > 0 && s >= -1e-6 && s <= 1 + 1e-6 && (!best || t > best.t)) best = { t, i, s: THREE.MathUtils.clamp(s, 0, 1) };
    }
    const i0 = best ? best.i : 0;
    const i1 = (i0 + 1) % L;
    const f = best ? best.s : 0;
    const q = loop.points[i0].clone().lerp(loop.points[i1], f);
    const slope = loop.slopes[i0].clone().lerp(loop.slopes[i1], f);
    // The hand narrows toward the wrist; carrying that taper on down the arm
    // pinches a dent just past the border. Keep only slopes that widen.
    const out = new THREE.Vector2(q.x - c.x, q.z - c.z).normalize();
    const o = slope.dot(out);
    if (o < 0) slope.addScaledVector(out, -o);
    ring0.push(q);
    ring0S.push(slope);
  }

  const cy = ring0.reduce((s, p) => s + p.y, 0) / R;
  const aLoop = WRIST_A + cy;
  // The border is in the heel of the hand; the wrist joint below it is the
  // narrowest place, and the forearm widens again above it.
  const profile = [...PROFILE, [aLoop - 0.055, lx * 1.0, lz * 1.04], [aLoop - 0.015, lx * 0.95, lz * 0.99], [aLoop, lx, lz], [aLoop + 0.03, lx, lz]];

  // Ring stations, dense near the wrist and the elbow.
  const stations = [aLoop];
  let a = aLoop;
  while (a > 0) {
    const nearJoint = aLoop - a < 0.06 || Math.abs(a - UPPER) < 0.06;
    a -= nearJoint ? 0.005 : 0.01;
    stations.push(Math.max(0, a));
  }

  // Vertex layout: the hand's own border vertices first (shared exactly, so the
  // seam is watertight), then R vertices per ring up the arm.
  const base = (r) => (r === 0 ? 0 : L + (r - 1) * R);
  const n = L + (stations.length - 1) * R;
  const position = new Float32Array(n * 3);
  const weights = new Float32Array(n * 3); // [arm, fore, hand]
  const fadeUpper = new Float32Array(n);
  const fadeElbow = new Float32Array(n);
  const SE = 2.15; // superellipse exponent: a touch flatter-sided than an ellipse, like a forearm
  stations.forEach((a, r) => {
    const wFore = THREE.MathUtils.smoothstep(a, UPPER - 0.045, UPPER + 0.045);
    const wHand = THREE.MathUtils.smoothstep(a, aLoop - WRIST_BEND, aLoop); // skin the wrist bend carries
    const setAttrs = (v) => {
      weights[v * 3] = 1 - wFore;
      weights[v * 3 + 1] = wFore - wHand;
      weights[v * 3 + 2] = wHand;
      fadeUpper[v] = THREE.MathUtils.smoothstep(a, 0.0, 0.12);
      fadeElbow[v] = THREE.MathUtils.smoothstep(a, UPPER - 0.07, UPPER + 0.01);
    };
    if (r === 0) {
      loop.points.forEach((q, i) => {
        position.set([q.x, q.y + WRIST_A, q.z], i * 3);
        setAttrs(i);
      });
      return;
    }
    const u = aLoop - a; // distance up the arm from the wrist border
    const k = THREE.MathUtils.smoothstep(u, 0, 0.08); // border shape -> anatomical section
    const h = THREE.MathUtils.smoothstep(u, 0, 0.025); // leave the border along the hand's own slope
    const w = catmull(profile, a, 1);
    const t = catmull(profile, a, 2);
    for (let j = 0; j < R; j++) {
      const q = ring0[j];
      const ox = q.x - c.x;
      const oz = q.z - c.z;
      const th = (j / R) * Math.PI * 2;
      const cs = Math.cos(th);
      const sn = Math.sin(th);
      const ex = (w / 2) * Math.sign(cs) * Math.abs(cs) ** (2 / SE);
      const ez = (t / 2) * Math.sign(sn) * Math.abs(sn) ** (2 / SE);
      let x = c.x * (1 - k) + THREE.MathUtils.lerp(ox * (w / lx), ex, k);
      let z = c.z * (1 - k) + THREE.MathUtils.lerp(oz * (t / lz), ez, k);
      // Near the border, follow the straight continuation of the hand surface.
      x = THREE.MathUtils.lerp(q.x + ring0S[j].x * u, x, h);
      z = THREE.MathUtils.lerp(q.z + ring0S[j].y * u, z, h);
      const v = base(r) + j;
      position.set([x, cy - u + WRIST_A, z], v * 3);
      setAttrs(v);
    }
  });

  const index = [];
  // Zip the border (L vertices, uneven angles) to the first ring (R, even angles).
  const TAU = Math.PI * 2;
  const ang = loop.points.map((p) => {
    const t = Math.atan2(nz(p), nx(p));
    return t < 0 ? t + TAU : t;
  });
  // Walk the border in increasing angle, starting from its vertex nearest angle 0.
  let dir = 0;
  for (let i = 0; i < L; i++) {
    let d = ang[(i + 1) % L] - ang[i];
    if (d > Math.PI) d -= TAU;
    if (d < -Math.PI) d += TAU;
    dir += d;
  }
  const order = [];
  const start = ang.indexOf(Math.min(...ang));
  for (let i = 0; i < L; i++) order.push(dir > 0 ? (start + i) % L : (start - i + L) % L);
  const unwrap = [];
  let prev = ang[order[0]];
  for (const i of order) {
    let t = ang[i];
    while (t < prev - 1e-9) t += TAU;
    unwrap.push(t);
    prev = t;
  }
  {
    let i = 0;
    let j = 0;
    const b1 = base(1);
    const A = (i) => order[i % L];
    const B = (j) => b1 + (j % R);
    const angA = (i) => unwrap[i % L] + (i >= L ? TAU : 0);
    const angB = (j) => (j / R) * TAU;
    while (i < L || j < R) {
      const nextA = i < L ? angA(i + 1) : Infinity;
      const nextB = j < R ? angB(j + 1) : Infinity;
      if (nextA <= nextB) {
        index.push(A(i), B(j), A(i + 1));
        i++;
      } else {
        index.push(A(i), B(j), B(j + 1));
        j++;
      }
    }
  }
  // Quads between the rings.
  for (let r = 1; r + 1 < stations.length; r++) {
    for (let i = 0; i < R; i++) {
      const a0 = base(r) + i;
      const a1 = base(r) + ((i + 1) % R);
      const b0 = base(r + 1) + i;
      const b1 = base(r + 1) + ((i + 1) % R);
      index.push(a0, b0, a1, a1, b0, b1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(position, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  // Winding: flip everything if a ring face points inward.
  const probe = base(2);
  const out = new THREE.Vector3(position[probe * 3] - c.x, 0, position[probe * 3 + 2] - c.z);
  if (out.dot(new THREE.Vector3().fromBufferAttribute(g.attributes.normal, probe)) < 0) {
    for (let i = 0; i < index.length; i += 3) [index[i + 1], index[i + 2]] = [index[i + 2], index[i + 1]];
    g.setIndex(index);
    g.computeVertexNormals();
  }

  // Seam: the border vertices exist in both meshes; give both the same normal.
  const normal = new Float32Array(g.attributes.normal.array);
  const seam = [];
  loop.points.forEach((p, i) => {
    const sn = new THREE.Vector3().fromArray(normal, i * 3).add(loop.normals[i]).normalize();
    sn.toArray(normal, i * 3);
    if (loop.ids) seam.push({ id: loop.ids[i], normal: sn });
  });
  return { position, normal, index: new Uint32Array(index), weights, fadeUpper, fadeElbow, seam, rings: stations.length, ringSize: R };
}
