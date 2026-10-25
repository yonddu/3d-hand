// Held-object estimation and contact correction.
//
// Two sources describe the object:
//   camera - the object detector names it (cup, phone, ball, ...), which gives
//            its shape family and real size (see objects.js);
//   hand   - when nothing is recognized, the grip itself is read: a deep even
//            curl wraps a cylinder, a cupped hand holds a sphere, thumb and
//            index tips together pinch something small.
// The shape is then seated against the palm or between the pinching tips, and
// each finger's curl is adjusted so its pad rests on the surface, giving the
// hand pose that actually holds that object.
//
// Everything is computed in the wrist bone's local frame (rig hand frame:
// +Y toward the fingers, +Z out of the palm), so the object moves with the
// hand and can be saved with the pose.
import * as THREE from 'three';
import { FINGERS } from './skeleton.js';

const TIP = { thumb: 4, index: 8, middle: 12, ring: 16, pinky: 20 };
const SKIN = 0.008; // fingertip pad thickness: tip joint sits this far off the surface
const PALM_SKIN = 0.012; // palm joint plane -> palm skin
const STABLE_FRAMES = 8;
const Y = new THREE.Vector3(0, 1, 0);

export const OBJECT_LABEL = { cylinder: '원기둥', rod: '막대', sphere: '공', box: '상자', pinch: '집은 물체' };

export class GraspEstimator {
  constructor(rig, material) {
    this.rig = rig;
    this.current = null; // smoothed object
    this.candidate = null;
    this.streak = 0;
    const cyl = new THREE.CylinderGeometry(1, 1, 1, 40, 1, false);
    this.meshes = {
      cylinder: new THREE.Mesh(cyl, material),
      rod: new THREE.Mesh(cyl, material),
      sphere: new THREE.Mesh(new THREE.SphereGeometry(1, 40, 24), material),
      box: new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material),
      pinch: new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), material),
    };
    for (const m of Object.values(this.meshes)) {
      m.visible = false;
      m.renderOrder = 2;
      rig.wrist.add(m);
    }
  }

  reset() {
    this.current = null;
    this.candidate = null;
    this.streak = 0;
    this.render();
  }

  // Joint positions in wrist-local space.
  localJoints() {
    const rig = this.rig;
    rig.group.updateMatrixWorld(true);
    const inv = rig.wrist.matrixWorld.clone().invert();
    return rig.landmarkPositions().map((p) => p.applyMatrix4(inv));
  }

  // One step per frame after the solver has posed the rig.
  //   vision: result of objectForHand / manualObject, or null
  //   forced: true when the user picked the shape (skip the grip check)
  update({ correct = true, vision = null, forced = false, handOnly = false } = {}) {
    const J = this.localJoints();
    const f = handFeatures(J);
    let fit = null;
    if (vision && !handOnly && (forced || isGripping(f))) fit = placeObject(vision, J, f);
    if (!fit && !forced) fit = classify(J, f);

    const key = (o) => o && `${o.type}|${o.label || ''}`;
    if (fit && this.candidate && key(fit) === key(this.candidate)) this.streak++;
    else this.streak = fit ? 1 : 0;
    this.candidate = fit;

    if (!fit) {
      if (this.current) this.current.hold = (this.current.hold || 0) + 1;
      if (this.current && this.current.hold > STABLE_FRAMES) this.current = null;
    } else if (this.current && key(this.current) === key(fit)) {
      blend(this.current, fit, 0.25);
      this.current.hold = 0;
    } else if (this.streak >= (forced ? 1 : STABLE_FRAMES)) {
      this.current = cloneObj(fit);
    }

    if (this.current && correct && this.current.type !== 'pinch') this.correctContacts(this.current);
    this.render();
    return this.current;
  }

  // Scale each finger's flexion so its pad lands on the surface.
  correctContacts(obj) {
    const rig = this.rig;
    const inv = new THREE.Matrix4();
    for (const finger of FINGERS) {
      const links = rig.chains[finger.key];
      const base = links.map((l) => decompose(l));
      const tipBone = rig.boneByLandmark[TIP[finger.key]];
      const tipAt = (s) => {
        links.forEach((l, k) => setFlex(l, base[k].flex * s, base[k].abd));
        rig.group.updateMatrixWorld(true);
        inv.copy(rig.wrist.matrixWorld).invert();
        return new THREE.Vector3().setFromMatrixPosition(tipBone.matrixWorld).applyMatrix4(inv);
      };
      const gap = (s) => sdf(obj, tipAt(s)) - SKIN;
      const d0 = gap(1);
      // Fingers clearly not involved (a pointing finger, a thumb off to the
      // side) keep their tracked pose.
      const reach = finger.key === 'thumb' ? 0.045 : 0.04;
      if (d0 > reach || base.every((b) => Math.abs(b.flex) < 3)) {
        tipAt(1);
        continue;
      }
      // Inside -> open the finger (s < 1); outside -> close it (s > 1). Bisect.
      let lo = d0 < 0 ? 0.3 : 1;
      let hi = d0 < 0 ? 1 : finger.key === 'thumb' ? 2.2 : 1.6;
      const dLo = gap(lo);
      const dHi = gap(hi);
      if (Math.sign(dLo) === Math.sign(dHi)) {
        // Surface out of reach: get as close as the joint range allows.
        tipAt(Math.abs(dLo) < Math.abs(dHi) ? lo : hi);
        continue;
      }
      for (let i = 0; i < 10; i++) {
        const mid = (lo + hi) / 2;
        if (Math.sign(gap(mid)) === Math.sign(dLo)) lo = mid;
        else hi = mid;
      }
      tipAt((lo + hi) / 2);
    }
  }

  render() {
    const obj = this.current;
    for (const [type, m] of Object.entries(this.meshes)) m.visible = !!obj && obj.type === type;
    if (!obj) return;
    const m = this.meshes[obj.type];
    m.position.copy(obj.center);
    if (obj.type === 'cylinder' || obj.type === 'rod') {
      m.quaternion.setFromUnitVectors(Y, obj.axis);
      m.scale.set(obj.radius, obj.length, obj.radius);
    } else if (obj.type === 'box') {
      m.quaternion.copy(obj.quat);
      m.scale.fromArray(obj.size);
    } else {
      m.quaternion.identity();
      m.scale.setScalar(obj.radius);
    }
  }

  // Serializable copy (wrist-local, meters).
  toJSON() {
    const o = this.current;
    if (!o) return null;
    const r = (v) => +v.toFixed(4);
    const out = { type: o.type, label: o.label || null, source: o.source, center: o.center.toArray().map(r) };
    if (o.type === 'box') Object.assign(out, { quaternion: o.quat.toArray().map(r), size: o.size.map(r) });
    else out.radius = r(o.radius);
    if (o.axis) Object.assign(out, { axis: o.axis.toArray().map(r), length: r(o.length) });
    return out;
  }

  fromJSON(o) {
    if (!o) return this.reset();
    this.current = {
      type: o.type,
      label: o.label,
      source: o.source,
      center: new THREE.Vector3().fromArray(o.center),
      radius: o.radius || 0,
      axis: o.axis ? new THREE.Vector3().fromArray(o.axis) : null,
      length: o.length || 0,
      quat: o.quaternion ? new THREE.Quaternion().fromArray(o.quaternion) : null,
      size: o.size || null,
      hold: 0,
    };
    this.render();
  }
}

function cloneObj(o) {
  return {
    ...o,
    center: o.center.clone(),
    axis: o.axis && o.axis.clone(),
    quat: o.quat && o.quat.clone(),
    size: o.size && [...o.size],
    hold: 0,
  };
}

// --- seating a recognized object in the hand ---------------------------------------

// Some grip is needed before a nearby object counts as held.
function isGripping(f) {
  return f.avgCurl > 0.3 || f.pinch < 0.45;
}

function placeObject(v, J, f) {
  const Z = new THREE.Vector3(0, 0, 1);
  const knuckles = J[5].clone().add(J[9]).add(J[13]).add(J[17]).multiplyScalar(0.25);
  const palm = knuckles.clone().lerp(J[0], 0.35).addScaledVector(Z, PALM_SKIN);
  const across = J[17].clone().sub(J[5]).normalize();
  const pinchPoint = J[4].clone().add(J[8]).multiplyScalar(0.5);
  const pinching = f.pinch < 0.38 && f.curl[0] < 1.0;
  const base = { label: v.label, source: v.source || 'camera', axis: null, quat: null, size: null, radius: 0, length: 0 };

  if (v.shape === 'sphere') {
    // Fingertip grip of a small ball sits in front of the tips; a big ball fills the palm.
    const center = pinching && v.radius < 0.03 ? pinchPoint.clone() : palm.clone().addScaledVector(Z, v.radius);
    return { ...base, type: 'sphere', center, radius: v.radius };
  }
  if (v.shape === 'box') {
    // Back face on the palm, long side across the hand, fingers wrapping the
    // far long edge (how a phone or remote is held to look at it).
    const [w, l, t] = v.size;
    const quat = new THREE.Quaternion().setFromAxisAngle(Z, Math.PI / 2);
    const center = palm.clone().addScaledVector(Z, t / 2);
    center.y = J[6].y - w / 2 + 0.005;
    return { ...base, type: 'box', center, quat, size: [w, l, t] };
  }
  // cylinder / rod
  if (pinching && v.shape === 'rod') {
    // Pen-style: through the pinch, resting toward the thumb-index web.
    const web = J[2].clone().lerp(J[5], 0.5).addScaledVector(Z, 0.01);
    const axis = web.clone().sub(pinchPoint).normalize();
    const center = pinchPoint.clone().addScaledVector(axis, v.length * 0.3);
    return { ...base, type: 'rod', center, axis, radius: v.radius, length: v.length };
  }
  // Power grip: axis across the palm, surface against the palm skin.
  const center = palm.clone().addScaledVector(Z, v.radius);
  return { ...base, type: v.shape, center, axis: across, radius: v.radius, length: v.length };
}

// --- shape fitting ---------------------------------------------------------------

export function handFeatures(J) {
  const palmLen = J[0].distanceTo(J[9]);
  const curl = [[5, 8], [9, 12], [13, 16], [17, 20]].map(([mcp, tip]) =>
    1 - THREE.MathUtils.clamp((J[tip].y - J[mcp].y) / (palmLen * 0.95), -1, 1),
  );
  const avgCurl = curl.reduce((a, b) => a + b, 0) / 4;
  const curlSpread = Math.max(...curl) - Math.min(...curl);
  const tipZ = [8, 12, 16, 20].reduce((s, i) => s + J[i].z, 0) / 4 / palmLen;
  return { palmLen, curl, avgCurl, curlSpread, tipZ, pinch: J[4].distanceTo(J[8]) / palmLen, spread: J[8].distanceTo(J[20]) / palmLen };
}

function classify(J, f = handFeatures(J)) {
  // Pinch: thumb and index tips nearly touching, index not wrapped around
  // something (in a power grip the thumb often rests on the index too).
  if (f.pinch < 0.35 && f.curl[0] < 0.95) {
    const center = J[4].clone().add(J[8]).multiplyScalar(0.5);
    const radius = THREE.MathUtils.clamp((f.pinch * f.palmLen) / 2 - SKIN * 0.5, 0.006, 0.03);
    return { type: 'pinch', label: null, source: 'hand', center, radius, axis: null, length: 0 };
  }
  // Wrapping grip: all four fingers bent by a similar amount, with the tips
  // standing off the palm (an empty fist folds the tips onto the palm, a claw
  // hooks them back toward the wrist; neither holds anything).
  if (f.curlSpread > 0.4 || f.avgCurl < 0.4 || f.avgCurl > 1.5 || f.tipZ < 0.35) return null;

  // Points the object surface should pass near: middle finger joints and the
  // palm. Tips are left out; contact correction lands them on the surface.
  const pads = [];
  for (const [mcp, pip, dip] of [[5, 6, 7], [9, 10, 11], [13, 14, 15], [17, 18, 19]]) {
    pads.push(J[pip], J[dip]);
    // Palm surface in front of the knuckle (palm normal is +Z in this frame).
    pads.push(J[mcp].clone().lerp(J[0], 0.25).add(new THREE.Vector3(0, 0, 0.018)));
  }

  // Deep curl wraps a handle or bottle; a shallow cupped curl holds a ball.
  if (f.avgCurl > 0.95) {
    const cyl = fitCylinder(J, pads);
    return cyl && cyl.radius > 0.008 && cyl.radius < 0.055 ? cyl : null;
  }
  const sph = fitSphere([...FINGERS.map((fi) => J[TIP[fi.key]]), J[9].clone().lerp(J[0], 0.3).add(new THREE.Vector3(0, 0, 0.02))]);
  return sph && sph.radius > 0.02 && sph.radius < 0.08 ? sph : null;
}

// Cylinder whose axis runs across the palm (index knuckle -> pinky knuckle).
function fitCylinder(J, pts) {
  const axis = J[17].clone().sub(J[5]).normalize();
  // 2D basis perpendicular to the axis.
  const u = new THREE.Vector3(0, 0, 1).sub(axis.clone().multiplyScalar(axis.z)).normalize();
  const v = new THREE.Vector3().crossVectors(axis, u);
  const origin = J[5].clone().add(J[17]).multiplyScalar(0.5);
  const p2 = pts.map((p) => {
    const d = p.clone().sub(origin);
    return [d.dot(u), d.dot(v)];
  });
  const circle = fitCircle(p2);
  if (!circle) return null;
  const center = origin.clone().add(u.clone().multiplyScalar(circle.cx)).add(v.clone().multiplyScalar(circle.cy));
  const length = J[5].distanceTo(J[17]) + 0.05;
  // The surface may not cut through a finger: the hand can't be inside it.
  // The pinky is skipped here; it is short and wraps a narrower part anyway.
  const nearest = Math.min(...p2.filter((_, i) => i < 9 || i > 10).map(([x, y]) => Math.hypot(x - circle.cx, y - circle.cy)));
  const radius = Math.min(circle.r, nearest) - SKIN;
  return { type: 'cylinder', label: null, source: 'hand', center, axis, radius, length, rms: circle.rms / Math.max(circle.r, 1e-3) };
}

// Algebraic (Kasa) circle fit.
function fitCircle(p) {
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0, sz = 0;
  const n = p.length;
  for (const [x, y] of p) {
    const z = x * x + y * y;
    sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; sxz += x * z; syz += y * z; sz += z;
  }
  const A = new THREE.Matrix3().set(sxx, sxy, sx, sxy, syy, sy, sx, sy, n);
  if (Math.abs(A.determinant()) < 1e-14) return null;
  const sol = new THREE.Vector3(sxz, syz, sz).applyMatrix3(A.clone().invert());
  const cx = sol.x / 2, cy = sol.y / 2;
  const r = Math.sqrt(Math.max(0, sol.z + cx * cx + cy * cy));
  const rms = Math.sqrt(p.reduce((s, [x, y]) => s + (Math.hypot(x - cx, y - cy) - r) ** 2, 0) / n);
  return { cx, cy, r, rms };
}

// Algebraic sphere fit.
function fitSphere(pts) {
  const n = pts.length;
  const M = new THREE.Matrix4();
  const e = new Array(16).fill(0);
  const b = [0, 0, 0, 0];
  for (const p of pts) {
    const row = [p.x, p.y, p.z, 1];
    const z = p.lengthSq();
    for (let i = 0; i < 4; i++) {
      b[i] += row[i] * z;
      for (let j = 0; j < 4; j++) e[i * 4 + j] += row[i] * row[j];
    }
  }
  M.set(...e);
  if (Math.abs(M.determinant()) < 1e-16) return null;
  const s = new THREE.Vector4(...b).applyMatrix4(M.clone().invert());
  const center = new THREE.Vector3(s.x / 2, s.y / 2, s.z / 2);
  const r = Math.sqrt(Math.max(0, s.w + center.lengthSq()));
  const rms = Math.sqrt(pts.reduce((acc, p) => acc + (p.distanceTo(center) - r) ** 2, 0) / n);
  return { type: 'sphere', label: null, source: 'hand', center, radius: r - SKIN, axis: null, length: 0, rms: rms / Math.max(r, 1e-3) };
}

function sdf(obj, p) {
  if (obj.type === 'cylinder' || obj.type === 'rod') {
    // Capped cylinder.
    const d = p.clone().sub(obj.center);
    const along = d.dot(obj.axis);
    const radial = d.addScaledVector(obj.axis, -along).length() - obj.radius;
    const cap = Math.abs(along) - obj.length / 2;
    return Math.min(Math.max(radial, cap), 0) + Math.hypot(Math.max(radial, 0), Math.max(cap, 0));
  }
  if (obj.type === 'box') {
    const q = p.clone().sub(obj.center).applyQuaternion(obj.quat.clone().invert());
    const e = [Math.abs(q.x) - obj.size[0] / 2, Math.abs(q.y) - obj.size[1] / 2, Math.abs(q.z) - obj.size[2] / 2];
    const outside = Math.hypot(...e.map((x) => Math.max(x, 0)));
    return outside + Math.min(Math.max(...e), 0);
  }
  return p.distanceTo(obj.center) - obj.radius;
}

function blend(cur, next, a) {
  cur.center.lerp(next.center, a);
  cur.radius += (next.radius - cur.radius) * a;
  if (cur.axis && next.axis) cur.axis.lerp(next.axis, a).normalize();
  cur.length += (next.length - cur.length) * a;
  if (cur.quat && next.quat) cur.quat.slerp(next.quat, a);
  if (cur.size && next.size) cur.size = cur.size.map((x, i) => x + (next.size[i] - x) * a);
}

// --- bone angle helpers (same convention as the solver) -------------------------

const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
function decompose(link) {
  _q.copy(link.restLocal).invert().multiply(link.bone.quaternion);
  _e.setFromQuaternion(_q, 'XZY');
  return { flex: THREE.MathUtils.radToDeg(_e.x), abd: _e.z };
}
function setFlex(link, flexDeg, abdRad) {
  _e.set(THREE.MathUtils.degToRad(flexDeg), 0, abdRad, 'XZY');
  link.bone.quaternion.copy(link.restLocal).multiply(_q.setFromEuler(_e));
}
