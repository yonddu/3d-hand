import assert from 'node:assert/strict';
import * as THREE from 'three';
import { ArmRig } from '../src/arm.js';
import { HandRig } from '../src/handRig.js';
import { PointSetFilter } from '../src/filters.js';
import { NativeArmDriver, webWristAnchor } from '../src/nativeArm.js';
import { retargetNative } from '../src/nativePose.js';
import { restLandmarks } from '../src/skeleton.js';

for (const side of ['left', 'right']) {
  const arm = new ArmRig(side), rig = new HandRig(side), driver = new NativeArmDriver(arm);
  const reference = new ArmRig(side);
  const filter = new PointSetFilter(1, { minCutoff:.6, beta:2, dCutoff:1, lead:.05, maxLead:.04 });
  const P = restLandmarks(side);
  let lastHand;
  for (let i = 0; i < 4; i++) {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(.2*i, .7*i, -.3*i));
    const hand = { label:side, world:P.flatMap(p => { const v = new THREE.Vector3(...p).applyQuaternion(q); return [v.x,-v.y,-v.z]; }), lm:P.flatMap(([x,y,z]) => [.5+x+i*.03,.6-y,z]) };
    retargetNative(rig, hand);
    const fingers = structuredClone(rig.getPose().bones);
    const sourceQ = rig.wrist.quaternion.clone();
    const raw = webWristAnchor(hand, 9/16);
    const [position] = filter.filter([raw.toArray()], i*.1);
    reference.shoulder.copy(reference.homeShoulder);
    reference.update(new THREE.Vector3(...position), sourceQ, null);
    driver.update(rig, hand, 9/16, i*.1);
    assert.deepEqual(rig.group.position.toArray(), position);
    assert.deepEqual(arm.result, reference.result, 'same ArmRig path as existing web');
    assert.ok(rig.wrist.quaternion.angleTo(reference.fixedHandQ || sourceQ) < 1e-7);
    assert.deepEqual(rig.getPose().bones, fingers, 'arm/wrist update does not change finger locals');
    lastHand = hand;
  }
  driver.reset(); retargetNative(rig, lastHand); driver.update(rig,lastHand,9/16,1);
  const freshArm = new ArmRig(side), freshRig = new HandRig(side), fresh = new NativeArmDriver(freshArm);
  retargetNative(freshRig,lastHand); fresh.update(freshRig,lastHand,9/16,1);
  assert.deepEqual(arm.result,freshArm.result,'reappearing hand has fresh arm state');
  assert.deepEqual(rig.getPose(),freshRig.getPose(),'reappearing wrist has fresh anchor filter');
}
console.log('Native arms: both sides match existing web ArmRig/wrist path, fingers unchanged, reset PASS');
