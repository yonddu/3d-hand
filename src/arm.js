// Forearm and elbow.
//
// With the phone at the eyes, the elbows are usually below the frame, so the
// elbow is solved the way Quest does it: two-bone IK from an estimated
// shoulder to the tracked wrist, with the bend direction taken from the hand
// (the forearm continues behind the wrist along the hand's -Y). When the pose
// model does see the elbow, its position is used instead.
//
// Scene space: camera (eyes) at the origin looking down -Z, +Y up, meters.
import * as THREE from 'three';
import { sideSign } from './skeleton.js';
import { UPPER, FORE, buildArm } from './armMesh.js';

export { UPPER, FORE };
// The wrist is an ellipsoid (radiocarpal) joint: it flexes/extends and tilts
// toward the thumb or the little finger, but does not twist. Pronation lives in
// the forearm (segmentQuat rolls it with the hand). Range of motion in degrees.
const WRIST_ROM = { flex: 70, ext: 60, radial: 20, ulnar: 35 };
const ELBOW_MAX = (150 * Math.PI) / 180; // elbow flexion 150, extension 0
const COMFORT = 0.6; // share of the range the IK view uses before turning the forearm
const SHRUG = 0.12; // how far the shoulder may move to keep the wrist natural (m)
const Y = new THREE.Vector3(0, 1, 0);

// Bind pose shared with the GLB export: arm straight forward (-Z), palm down.
export const ARM_BIND = new THREE.Quaternion()
  .setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2)
  .multiply(new THREE.Quaternion().setFromAxisAngle(Y, Math.PI));

// Fixed-length arm for shoulder S, wrist W (scene space) and hand rotation:
// the elbow hint E only says which way the elbow points. A wrist beyond reach
// pulls the shoulder after it (a shrug) instead of stretching the arm.
// Returns bone-local rotations for Arm (under an unrotated Shoulder), ForeArm, Hand.
// opts: comfort (share of the wrist range before the forearm turns), shrug
// (shoulder travel), direct (elbow hint is the real forearm line), side.
export function armLocals(S0, E0, W, handQ, { comfort = COMFORT, shrug = SHRUG, direct = false, side = 'right' } = {}) {
  const S = S0.clone();
  let E;
  if (direct) {
    // The elbow hint is the real forearm line (pose model or hand direction):
    // keep it and let the upper arm hang from it toward the shoulder.
    E = W.clone().add(E0.clone().sub(W).setLength(FORE));
    S.copy(E).add(S0.clone().sub(E).setLength(UPPER));
  } else {
    const reach = (UPPER + FORE) * 0.999;
    if (S.distanceTo(W) > reach) S.sub(W).setLength(reach).add(W);
    E = solveElbow(S, W, E0);
  }
  // Keep the hand inside the wrist's range relative to the forearm. The hand
  // rotation is what the camera saw, so the forearm is the one that turns,
  // with the shoulder following by up to `shrug`.
  const ik = E.clone().sub(W).normalize(); // wrist -> elbow
  const want = wristClamp(ik, handQ, side, comfort);
  const bend = ik.angleTo(want);
  if (bend > 1e-4) {
    const axis = new THREE.Vector3().crossVectors(ik, want);
    if (axis.lengthSq() > 1e-12) {
      axis.normalize();
      const tryTurn = (f) => {
        const dir = ik.clone().applyAxisAngle(axis, bend * f);
        const e = W.clone().addScaledVector(dir, FORE);
        const s = e.clone().add(S.clone().sub(e).setLength(UPPER));
        return { e, s, shift: s.distanceTo(S) };
      };
      let best = tryTurn(1);
      if (best.shift > shrug) {
        let lo = 0;
        let hi = 1;
        for (let i = 0; i < 12; i++) {
          const mid = (lo + hi) / 2;
          if (tryTurn(mid).shift > shrug) hi = mid;
          else lo = mid;
        }
        best = tryTurn(lo);
      }
      E = best.e;
      S.copy(best.s);
    }
  }
  // Elbow flexes 0..150 degrees: a sharper fold swings the upper arm open.
  const upperDir = E.clone().sub(S).normalize();
  const foreDir = W.clone().sub(E).normalize();
  const fold = upperDir.angleTo(foreDir);
  if (fold > ELBOW_MAX) {
    const axis = new THREE.Vector3().crossVectors(foreDir, upperDir);
    if (axis.lengthSq() > 1e-12) {
      upperDir.copy(foreDir).applyAxisAngle(axis.normalize(), ELBOW_MAX);
      S.copy(E).addScaledVector(upperDir, -UPPER);
    }
  }
  const fore = segmentQuat(E, W, handQ);
  const upper = upperQuat(S, E, W, fore);
  return {
    S,
    E,
    upperQ: upper,
    foreQ: fore,
    arm: upper.clone(),
    fore: upper.clone().invert().multiply(fore),
    hand: fore.clone().invert().multiply(handQ),
  };
}

// The elbow is a hinge: the upper arm's local X is the bend axis, oriented so
// flexion is always a positive rotation about it and the forearm only adds
// its pronation twist on top. Game rigs then get an elbow that never bends
// backward, whichever way the palm faces. A nearly straight arm has no bend
// plane, so there the upper arm takes its roll from the forearm instead.
function upperQuat(S, E, W, fore) {
  const y = E.clone().sub(S).normalize();
  const f = W.clone().sub(E).normalize();
  const perp = f.clone().addScaledVector(y, -f.dot(y));
  const loose = segmentQuat(S, E, fore);
  const bent = perp.length();
  if (bent < 0.03) return loose;
  const z = perp.normalize();
  const x = new THREE.Vector3().crossVectors(y, z);
  const hinge = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
  const k = THREE.MathUtils.smoothstep(bent, 0.03, 0.12);
  if (hinge.dot(loose) < 0) loose.set(-loose.x, -loose.y, -loose.z, -loose.w);
  return loose.slerp(hinge, k);
}

// Wrist -> elbow direction pulled back inside the wrist's elliptical range of
// motion. Hand frame: +Y toward the fingers, +Z out of the palm, thumb on
// +X for the right hand (-X for the left).
export function wristClamp(toElbow, handQ, side = 'right', scale = 1) {
  const f = toElbow.clone().negate().applyQuaternion(handQ.clone().invert()); // forearm line in hand space
  const s = sideSign(side);
  // Swing of the forearm line away from the hand's +Y, as an angle plus a
  // direction in the hand's X/Z plane (stable even past 90 degrees).
  const theta = Math.acos(THREE.MathUtils.clamp(f.y, -1, 1));
  const side2 = new THREE.Vector2(f.x, f.z);
  if (theta < 1e-6 || side2.lengthSq() < 1e-12) return toElbow.clone().normalize();
  side2.normalize();
  const flex = -side2.y * theta; // + flexion (palm side), - extension
  const dev = -side2.x * s * theta; // + radial (thumb side), - ulnar
  const d2r = Math.PI / 180;
  const lf = (flex > 0 ? WRIST_ROM.flex : WRIST_ROM.ext) * d2r * scale;
  const ld = (dev > 0 ? WRIST_ROM.radial : WRIST_ROM.ulnar) * d2r * scale;
  const r = Math.hypot(flex / lf, dev / ld);
  if (r <= 1) return toElbow.clone().normalize();
  const t = theta / r;
  const v = new THREE.Vector3(side2.x * Math.sin(t), Math.cos(t), side2.y * Math.sin(t));
  return v.applyQuaternion(handQ).negate();
}

export class ArmRig {
  constructor(side) {
    this.side = side;
    const s = sideSign(side);
    // Shoulder relative to the eyes: down, out to the side, a little behind.
    this.shoulder = new THREE.Vector3(0.18 * s, -0.24, 0.06);
    this.homeShoulder = this.shoulder.clone(); // first person: phone at the eyes
    this.elbow = new THREE.Vector3(0.2 * s, -0.4, -0.15); // elbow hint (pose model or IK pole), smoothed
    this.wrist = new THREE.Vector3();
    this.source = 'ik';
    this.result = null;
    this.solved = null;
    this.mesh = null;
    this.showUpper = false;
    // Passthrough view: the graphic arm must lie on the real one, so the
    // forearm follows the hand's line (or the seen elbow) and the shoulder is free.
    this.follow = false;
    this.opts = {};

    this.group = new THREE.Group();
    this.group.name = `${side}Arm`;
    const P = side === 'left' ? 'Left' : 'Right';
    const bone = (name, parent, y = 0) => {
      const b = new THREE.Bone();
      b.name = name;
      b.position.y = y;
      parent.add(b);
      return b;
    };
    this.bones = {};
    this.bones.shoulder = bone(`${P}Shoulder`, this.group);
    this.bones.arm = bone(`${P}Arm`, this.bones.shoulder);
    this.bones.fore = bone(`${P}ForeArm`, this.bones.arm, UPPER);
    // A helper halfway through the wrist bend (screen only, not exported):
    // skin over the wrist follows it, so a bent wrist rounds over two half
    // turns instead of folding flat in one.
    this.bones.mid = bone(`${P}WristMid`, this.bones.fore, FORE);
    this.bones.hand = bone(`${P}Hand`, this.bones.mid, 0);

    const jointGeo = new THREE.SphereGeometry(0.008, 12, 8);
    const jointMat = new THREE.MeshBasicMaterial({ color: 0x3fd0c9, depthTest: false, transparent: true });
    this.elbowDot = new THREE.Mesh(jointGeo, jointMat);
    this.elbowDot.renderOrder = 10;
    this.group.add(this.elbowDot);
  }

  // Build the arm skin from the hand's wrist border (armMesh.wristLoop()).
  setSkin(loop, material) {
    const arm = buildArm(loop);
    this.skinData = arm;
    const n = arm.position.length / 3;
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(arm.position);
    const nor = new Float32Array(arm.normal);
    const v = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      v.fromArray(pos, i * 3).applyQuaternion(ARM_BIND).toArray(pos, i * 3);
      v.fromArray(nor, i * 3).applyQuaternion(ARM_BIND).toArray(nor, i * 3);
    }
    const skinIndex = new Uint16Array(n * 4);
    const skinWeight = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      // bones: 0 shoulder, 1 arm, 2 forearm, 3 wrist helper, 4 hand. The hand's
      // share is split: the forearm side of the bend goes to the helper.
      const h = arm.weights[i * 3 + 2];
      const toHand = THREE.MathUtils.smoothstep(h, 0.35, 1) * h;
      skinIndex.set([1, 2, 3, 4], i * 4);
      skinWeight.set([arm.weights[i * 3], arm.weights[i * 3 + 1], h - toHand, toHand], i * 4);
    }
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndex, 4));
    g.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));
    g.setAttribute('wristFade', new THREE.BufferAttribute(new Float32Array(arm.fadeElbow), 1));
    g.setIndex(new THREE.BufferAttribute(arm.index, 1));

    if (this.mesh) {
      this.group.remove(this.mesh);
      this.mesh.geometry.dispose();
    }
    // Bind with the bones in the bind pose, then go back to the current pose.
    const B = this.bones;
    B.shoulder.position.set(0, 0, 0);
    B.shoulder.quaternion.identity();
    B.arm.quaternion.copy(ARM_BIND);
    B.fore.quaternion.identity();
    B.mid.quaternion.identity();
    B.hand.quaternion.identity();
    this.group.updateMatrixWorld(true);
    const skeleton = new THREE.Skeleton([B.shoulder, B.arm, B.fore, B.mid, B.hand]);
    this.mesh = new THREE.SkinnedMesh(g, material);
    this.mesh.name = `${this.side}ArmMesh`;
    this.mesh.frustumCulled = false;
    this.group.add(this.mesh);
    this.mesh.bind(skeleton, new THREE.Matrix4());
    this.setVisible(this.visible ?? true, this.showUpper, this.elbowDot.visible);
    if (this.solved) this.pose(this.wrist, this.lastHandQ);
  }

  setMaterial(material) {
    if (this.mesh) this.mesh.material = material;
  }

  // wrist: scene position of the wrist joint; handQuat: wrist bone rotation in
  // scene space; elbowHint: elbow seen by the pose model (scene space) or null.
  update(wrist, handQuat, elbowHint = null) {
    const handY = Y.clone().applyQuaternion(handQuat);
    let target;
    if (elbowHint) {
      target = elbowHint.clone();
      this.source = 'pose';
    } else if (this.follow) {
      // First person with no elbow in view: the forearm runs back toward the
      // shoulder (two-bone IK), bending the way the hand points; the wrist
      // range then decides how far the hand may bend off that line.
      target = solveElbow(this.shoulder, wrist, wrist.clone().addScaledVector(handY, -FORE));
      this.source = 'hand';
    } else {
      target = solveElbow(this.shoulder, wrist, wrist.clone().addScaledVector(handY, -FORE));
      this.source = 'ik';
    }
    // Live passthrough: the forearm lies on the seen line and the shoulder is free.
    this.opts = !this.follow ? { side: this.side } : elbowHint ? { direct: true, comfort: 1, shrug: 2, side: this.side } : { comfort: 0.8, shrug: 0.2, side: this.side };
    this.elbow.lerp(target, 0.35);
    return this.pose(wrist, handQuat);
  }

  // Pose the bones for this wrist, using the current elbow hint (no smoothing).
  pose(wrist, handQuat) {
    this.wrist.copy(wrist);
    this.lastHandQ = handQuat.clone();
    const L = armLocals(this.shoulder, this.elbow, wrist, handQuat, this.opts);
    this.solved = L;
    const B = this.bones;
    B.shoulder.position.copy(L.S);
    B.arm.quaternion.copy(L.arm);
    B.fore.quaternion.copy(L.fore);
    B.mid.quaternion.identity().slerp(L.hand, 0.5);
    B.hand.quaternion.copy(B.mid.quaternion).invert().multiply(L.hand);
    this.elbowDot.position.copy(L.E);
    this.result = this.measure(handQuat);
    return this.result;
  }

  // Joint angles a game rig needs, in degrees.
  measure(handQuat) {
    if (!this.solved) this.pose(this.wrist, handQuat);
    const L = this.solved;
    const upperDir = L.E.clone().sub(L.S).normalize();
    const foreDir = this.wrist.clone().sub(L.E).normalize();
    const elbowFlex = THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(upperDir.dot(foreDir), -1, 1)));
    // Wrist relative to the forearm frame.
    const rel = L.foreQ.clone().invert().multiply(handQuat);
    const handYInFore = Y.clone().applyQuaternion(rel);
    const wristFlex = THREE.MathUtils.radToDeg(Math.atan2(handYInFore.z, handYInFore.y));
    const wristDeviation = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(-handYInFore.x, -1, 1))) * sideSign(this.side);
    return {
      source: this.source,
      shoulder: L.S.toArray(),
      elbow: L.E.toArray(),
      wrist: this.wrist.toArray(),
      elbowFlex,
      wristFlex,
      wristDeviation,
      upperArmQuat: L.upperQ.toArray(),
      forearmQuat: L.foreQ.toArray(),
    };
  }

  setFromSaved(arm) {
    this.shoulder.fromArray(arm.shoulder);
    this.elbow.fromArray(arm.elbow);
    this.wrist.fromArray(arm.wrist);
  }

  // arm: show the arm skin; upper: show it up to the shoulder (else it fades
  // out above the elbow); joints: elbow marker.
  setVisible(arm, upper, joints) {
    this.visible = arm;
    this.showUpper = upper;
    this.elbowDot.visible = joints;
    if (!this.mesh) return;
    this.mesh.visible = arm;
    const fade = this.mesh.geometry.attributes.wristFade;
    fade.array.set(upper ? this.skinData.fadeUpper : this.skinData.fadeElbow);
    fade.needsUpdate = true;
  }
}

// Rotation whose +Y runs from a to b. With twistQuat, rolled about that axis so
// its X matches twistQuat's X (the forearm following the hand's pronation).
export function segmentQuat(a, b, twistQuat = null) {
  const dir = b.clone().sub(a).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(Y, dir);
  if (twistQuat) {
    const handX = new THREE.Vector3(1, 0, 0).applyQuaternion(twistQuat);
    const meshX = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    const px = handX.addScaledVector(dir, -handX.dot(dir)).normalize();
    const angle = Math.atan2(new THREE.Vector3().crossVectors(meshX, px).dot(dir), meshX.dot(px));
    q.premultiply(new THREE.Quaternion().setFromAxisAngle(dir, angle));
  }
  return q;
}

// Two-bone IK: elbow position for shoulder S and wrist W, bending toward the
// pole point P (here: where the hand says the forearm goes).
export function solveElbow(S, W, P) {
  const sw = W.clone().sub(S);
  let d = sw.length();
  const dir = sw.clone().normalize();
  d = THREE.MathUtils.clamp(d, Math.abs(UPPER - FORE) + 1e-3, UPPER + FORE - 1e-4);
  // Distance from S along S->W to the elbow's circle, and the circle radius.
  const a = (UPPER * UPPER - FORE * FORE + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, UPPER * UPPER - a * a));
  const toPole = P.clone().sub(S);
  const bend = toPole.addScaledVector(dir, -toPole.dot(dir));
  if (bend.lengthSq() < 1e-8) bend.set(0, -1, 0).addScaledVector(dir, -dir.y);
  bend.normalize();
  return S.clone().addScaledVector(dir, a).addScaledVector(bend, h);
}
