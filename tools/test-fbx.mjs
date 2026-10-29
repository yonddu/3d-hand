import assert from "node:assert/strict";
import fs from "node:fs";
fs.mkdirSync("/tmp/fbx-check", { recursive: true });
import * as THREE from "three";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import { HandRig } from "../src/handRig.js";
import { ArmRig } from "../src/arm.js";
import { frameFromLive, buildMotionScene } from "../src/exportGlb.js";
import { exportFbx } from "../src/exportFbx.js";
const rigs = { left: new HandRig("left"), right: new HandRig("right") },
  arms = { left: new ArmRig("left"), right: new ArmRig("right") };
const skins = Object.fromEntries(
  Object.entries(rigs).map(([s, r]) => [s, r.exportSkin()]),
);
const frames = [];
for (let i = 0; i < 5; i++) {
  const hands = {};
  for (const s of ["left", "right"]) {
    const r = rigs[s],
      a = arms[s];
    r.group.position.set(s === "right" ? 0.12 : -0.12, -0.1, -0.42);
    r.wrist.quaternion
      .copy(r.wristRest)
      .multiply(
        new THREE.Quaternion().setFromEuler(
          new THREE.Euler(0.2 * i, 0.3 * i, -0.1 * i),
        ),
      );
    r.chains.index[1].bone.quaternion
      .copy(r.chains.index[1].restLocal)
      .multiply(
        new THREE.Quaternion().setFromAxisAngle(
          new THREE.Vector3(1, 0, 0),
          i * 0.25,
        ),
      );
    a.update(r.group.position, r.wrist.quaternion, null);
    if (a.fixedHandQ) r.wrist.quaternion.copy(a.fixedHandQ);
    hands[s] =
      s === "left" && (i === 0 || i === 4)
        ? null
        : frameFromLive(s, r, a, null);
  }
  frames.push({ t: 10 + i * 0.1, hands });
}
const options = { frames, skins, name: "FBX_Test", includeObjects: false };
const buffer = await exportFbx(options);
fs.writeFileSync("/tmp/fbx-check/motion.fbx", new Uint8Array(buffer));
assert.equal(new DataView(buffer).getUint32(23, true), 7400);
const imported = new FBXLoader().parse(buffer, "");
const mesh = imported.getObjectByName("HMS_ArmsMesh");
assert.ok(mesh?.isSkinnedMesh, "FBX has skinned mesh");
assert.ok(imported.getObjectByName("RightHandIndex2")?.isBone);
assert.equal(imported.animations.length, 1);
const source = buildMotionScene(options);
fs.writeFileSync(
  "/tmp/fbx-check/source.json",
  JSON.stringify({
    duration: source.clip.duration,
    bones: source.root
      .getObjectByName("HMS_ArmsMesh")
      .skeleton.bones.map((b) => b.name),
  }),
);
const mixerA = new THREE.AnimationMixer(source.root),
  mixerB = new THREE.AnimationMixer(imported);
mixerA.clipAction(source.clip).play();
mixerB.clipAction(imported.animations[0]).play();
let maxRotation = 0,
  maxPosition = 0;
for (const time of [0, 0.05, 0.1, 0.15, 0.2, 0.27, 0.35, 0.399]) {
  mixerA.setTime(time);
  mixerB.setTime(time);
  source.root.updateMatrixWorld(true);
  imported.updateMatrixWorld(true);
  for (const bone of [
    "LeftHand",
    "RightHand",
    "RightHandIndex2",
    "RightForeArm",
  ]) {
    const a = source.root.getObjectByName(bone),
      b = imported.getObjectByName(bone);
    if (a.getWorldScale(new THREE.Vector3()).lengthSq() > 1e-8)
      maxRotation = Math.max(
        maxRotation,
        a
          .getWorldQuaternion(new THREE.Quaternion())
          .angleTo(b.getWorldQuaternion(new THREE.Quaternion())),
      );
    maxPosition = Math.max(
      maxPosition,
      a
        .getWorldPosition(new THREE.Vector3())
        .distanceTo(b.getWorldPosition(new THREE.Vector3())),
    );
  }
}
console.log({
  bytes: buffer.byteLength,
  bones: mesh.skeleton.bones.length,
  duration: imported.animations[0].duration,
  maxRotationDegrees: (maxRotation * 180) / Math.PI,
  maxPositionMeters: maxPosition,
});
assert.ok(maxRotation < THREE.MathUtils.degToRad(0.2), "roundtrip rotations");
assert.ok(maxPosition < 0.001, "roundtrip positions/units");
// Independent ufbx validator reads these reference positions, not this JS loader.
const samples = [0, 0.05, 0.1, 0.15, 0.2, 0.27, 0.35, 0.399];
const sourceMesh = source.root.getObjectByName("HMS_ArmsMesh");
const count = sourceMesh.geometry.attributes.position.count;
const ref = new ArrayBuffer(8 + samples.length * (8 + count * 3 * 8));
const dv = new DataView(ref);
dv.setUint32(0, samples.length, true);
dv.setUint32(4, count, true);
let offset = 8;
for (const t of samples) {
  mixerA.setTime(t);
  source.root.updateMatrixWorld(true);
  sourceMesh.skeleton.update();
  dv.setFloat64(offset, t, true);
  offset += 8;
  for (let i = 0; i < count; i++) {
    const p = new THREE.Vector3().fromBufferAttribute(
      sourceMesh.geometry.attributes.position,
      i,
    );
    sourceMesh.applyBoneTransform(i, p);
    p.applyMatrix4(sourceMesh.matrixWorld);
    for (const x of p.toArray()) {
      dv.setFloat64(offset, x, true);
      offset += 8;
    }
  }
}
fs.writeFileSync("/tmp/fbx-check/reference.bin", new Uint8Array(ref));
console.log("FBX binary/skinned mesh/bones/animation/units roundtrip PASS");
