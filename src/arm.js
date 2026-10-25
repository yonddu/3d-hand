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

export const UPPER = 0.29; // shoulder -> elbow
export const FORE = 0.26; // elbow -> wrist
const Y = new THREE.Vector3(0, 1, 0);

export class ArmRig {
  constructor(side, material) {
    this.side = side;
    const s = sideSign(side);
    // Shoulder relative to the eyes: down, out to the side, a little behind.
    this.shoulder = new THREE.Vector3(0.18 * s, -0.24, 0.06);
    this.elbow = new THREE.Vector3(0.2 * s, -0.4, -0.15);
    this.wrist = new THREE.Vector3();
    this.source = 'ik';
    this.result = null;

    this.group = new THREE.Group();
    this.group.name = `${side}Arm`;
    // Forearm: narrow at the wrist, wider toward the elbow; faded like the hand.
    const fore = new THREE.CylinderGeometry(0.021, 0.034, 1, 24, 8, true);
    fore.translate(0, 0.5, 0); // base at the elbow, top at the wrist
    this.forearm = new THREE.Mesh(fore, material);
    const upper = new THREE.CylinderGeometry(0.037, 0.045, 1, 24, 1, true);
    upper.translate(0, 0.5, 0);
    this.upperArm = new THREE.Mesh(upper, material);
    this.upperArm.visible = false; // right next to the camera; shown only on request
    const jointGeo = new THREE.SphereGeometry(0.008, 12, 8);
    const jointMat = new THREE.MeshBasicMaterial({ color: 0x3fd0c9, depthTest: false, transparent: true });
    this.elbowDot = new THREE.Mesh(jointGeo, jointMat);
    this.elbowDot.renderOrder = 10;
    this.group.add(this.forearm, this.upperArm, this.elbowDot);
  }

  // wrist: scene position of the wrist joint; handQuat: wrist bone rotation in
  // scene space; elbowHint: elbow seen by the pose model (scene space) or null.
  update(wrist, handQuat, elbowHint = null) {
    this.wrist.copy(wrist);
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
    this.place(this.forearm, this.elbow, wrist, handQuat);
    this.place(this.upperArm, this.shoulder, this.elbow, null);
    this.elbowDot.position.copy(this.elbow);
    this.result = this.measure(handQuat);
    return this.result;
  }

  // Stretch a unit cylinder from a to b. Twist follows the hand when given.
  place(mesh, a, b, twistQuat) {
    const len = b.distanceTo(a);
    const q = segmentQuat(a, b, twistQuat);
    mesh.position.copy(a);
    mesh.quaternion.copy(q);
    mesh.scale.set(1, len, 1);
    mesh.userData.quat = q;
  }

  // Joint angles a game rig needs, in degrees.
  measure(handQuat) {
    const upperDir = this.elbow.clone().sub(this.shoulder).normalize();
    const foreDir = this.wrist.clone().sub(this.elbow).normalize();
    const elbowFlex = THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(upperDir.dot(foreDir), -1, 1)));
    // Wrist relative to the forearm frame.
    const foreQ = this.forearm.userData.quat || new THREE.Quaternion();
    const rel = foreQ.clone().invert().multiply(handQuat);
    const handYInFore = Y.clone().applyQuaternion(rel);
    const wristFlex = THREE.MathUtils.radToDeg(Math.atan2(handYInFore.z, handYInFore.y));
    const wristDeviation = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(-handYInFore.x, -1, 1))) * sideSign(this.side);
    return {
      source: this.source,
      shoulder: this.shoulder.toArray(),
      elbow: this.elbow.toArray(),
      wrist: this.wrist.toArray(),
      elbowFlex,
      wristFlex,
      wristDeviation,
      upperArmQuat: (this.upperArm.userData.quat || new THREE.Quaternion()).toArray(),
      forearmQuat: foreQ.toArray(),
    };
  }

  setFromSaved(arm) {
    this.shoulder.fromArray(arm.shoulder);
    this.elbow.fromArray(arm.elbow);
    this.wrist.fromArray(arm.wrist);
  }

  setVisible(fore, upper, joints) {
    this.forearm.visible = fore;
    this.upperArm.visible = upper;
    this.elbowDot.visible = joints;
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
