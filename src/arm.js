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
const WRIST_SOFT = (40 * Math.PI) / 180; // wrist bend allowed before the forearm turns
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
export function armLocals(S0, E0, W, handQ) {
  const S = S0.clone();
  const reach = (UPPER + FORE) * 0.999;
  if (S.distanceTo(W) > reach) S.sub(W).setLength(reach).add(W);
  let E = solveElbow(S, W, E0);
  // A wrist bent past ~40 degrees reads as broken in first person (and pinches
  // the skin), so turn the forearm toward the hand's own line and let the
  // shoulder follow by up to SHRUG. Beyond that the wrist keeps the rest.
  const back = Y.clone().applyQuaternion(handQ).negate(); // wrist -> elbow if the wrist were straight
  const ik = E.clone().sub(W).normalize();
  const bend = ik.angleTo(back);
  if (bend > WRIST_SOFT) {
    const axis = new THREE.Vector3().crossVectors(ik, back);
    if (axis.lengthSq() > 1e-10) {
      axis.normalize();
      const tryTurn = (f) => {
        const dir = ik.clone().applyAxisAngle(axis, (bend - WRIST_SOFT) * f);
        const e = W.clone().addScaledVector(dir, FORE);
        const s = e.clone().add(S.clone().sub(e).setLength(UPPER));
        return { e, s, shift: s.distanceTo(S) };
      };
      let best = tryTurn(1);
      if (best.shift > SHRUG) {
        let lo = 0;
        let hi = 1;
        for (let i = 0; i < 12; i++) {
          const mid = (lo + hi) / 2;
          if (tryTurn(mid).shift > SHRUG) hi = mid;
          else lo = mid;
        }
        best = tryTurn(lo);
      }
      E = best.e;
      S.copy(best.s);
    }
  }
  const fore = segmentQuat(E, W, handQ);
  // The upper arm rolls with the forearm so the elbow bends without twisting the skin.
  const upper = segmentQuat(S, E, fore);
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
    this.bones.hand = bone(`${P}Hand`, this.bones.fore, FORE);

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
      for (let j = 0; j < 3; j++) {
        skinIndex[i * 4 + j] = j + 1; // bones: 0 shoulder, 1 arm, 2 forearm, 3 hand
        skinWeight[i * 4 + j] = arm.weights[i * 3 + j];
      }
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
    B.hand.quaternion.identity();
    this.group.updateMatrixWorld(true);
    const skeleton = new THREE.Skeleton([B.shoulder, B.arm, B.fore, B.hand]);
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
    } else {
      target = solveElbow(this.shoulder, wrist, wrist.clone().addScaledVector(handY, -FORE));
      this.source = 'ik';
    }
    this.elbow.lerp(target, 0.35);
    return this.pose(wrist, handQuat);
  }

  // Pose the bones for this wrist, using the current elbow hint (no smoothing).
  pose(wrist, handQuat) {
    this.wrist.copy(wrist);
    this.lastHandQ = handQuat.clone();
    const L = armLocals(this.shoulder, this.elbow, wrist, handQuat);
    this.solved = L;
    const B = this.bones;
    B.shoulder.position.copy(L.S);
    B.arm.quaternion.copy(L.arm);
    B.fore.quaternion.copy(L.fore);
    B.hand.quaternion.copy(L.hand);
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
