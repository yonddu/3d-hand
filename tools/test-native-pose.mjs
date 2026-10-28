import assert from 'node:assert/strict';
import * as THREE from 'three';
import { HandRig } from '../src/handRig.js';
import { FINGERS, restLandmarks } from '../src/skeleton.js';
import { nativeHands, retargetNative, validNativeHand, unpackPoints } from '../src/nativePose.js';

function reading(P, side) {
  const flat = P.flatMap(p => [p.x, -p.y, -p.z]);
  return { label: side, score: .9, world: flat, lm: flat.slice() };
}
function directions(rig, P) {
  rig.group.updateMatrixWorld(true);
  for (const f of FINGERS) for (let k = 0; k < 3; k++) {
    const q = rig.chains[f.key][k].bone.getWorldQuaternion(new THREE.Quaternion());
    const got = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    const want = P[f.joints[k + 1]].clone().sub(P[f.joints[k]]).normalize();
    assert.ok(got.distanceTo(want) < 1e-8, `${rig.side} ${f.key} ${k} follows observed direction`);
  }
}
for (const side of ['left', 'right']) {
  const rig = new HandRig(side);
  const base = restLandmarks(side).map(p => new THREE.Vector3(...p));
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(.8, -1.2, .4));
  // Non-rigid finger bends and strong palm rotation must both pass through.
  const P = base.map(p => p.clone().applyQuaternion(q).add(new THREE.Vector3(.1, -.2, .03)));
  P[8].add(new THREE.Vector3(.01, .02, -.03));
  P[4].add(new THREE.Vector3(-.02, -.03, .01));
  const h = reading(P, side);
  assert.equal(retargetNative(rig, h), true); directions(rig, P);
  const snapshot = rig.getPose();
  retargetNative(rig, reading(base, side));
  retargetNative(rig, h);
  assert.deepEqual(rig.getPose(), snapshot, 'no previous pose/state can change the same reading');
  const fresh = new HandRig(side); retargetNative(fresh, h);
  assert.deepEqual(fresh.getPose(), snapshot, 'reappearance starts independently');
  assert.deepEqual(unpackPoints(h.world).map(v => v.toArray()), P.map(v => v.toArray()));
  for (const broken of [{ ...h, world: h.world.slice(3) }, { ...h, world: h.world.map(() => 0) }, { ...h, world: h.world.map((v, i) => i === 2 ? NaN : v) }]) assert.equal(validNativeHand(broken), false);
  const low = { ...h, score: .1 };
  assert.equal(nativeHands([low, h])[side], h);
  assert.equal(Object.keys(nativeHands([low, h])).length, 1, 'duplicate label never invents another hand');
}
assert.deepEqual(nativeHands([]), {}, 'lost hands yield no fabricated pose');
console.log('Native pose: both hands, each bone direction, statelessness, malformed input and ambiguous labels PASS');
