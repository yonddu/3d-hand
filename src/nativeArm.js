// Native Studio's arm/wrist path reuses the existing web ArmRig and work-plane
// placement. It never edits finger-local rotations or estimates hidden hands.
import * as THREE from 'three';
import { restLandmarks } from './skeleton.js';
import { focalW } from './camera.js';
import { PointSetFilter } from './filters.js';

const SEGMENTS = [[0,5], [0,9], [0,17], [5,17], [5,9], [9,17]];
const R = restLandmarks('right');
const LENGTHS = SEGMENTS.map(([i,j]) => Math.hypot(...R[i].map((v,k) => v - R[j][k])));
// Same values as main.js anchorParams, not stronger global/finger smoothing.
const ANCHOR = { minCutoff: .6, beta: 2, dCutoff: 1, lead: .05, maxLead: .04 };
export function webWristAnchor(hand, aspect) {
  const focal = focalW(aspect);
  let depth = Infinity;
  SEGMENTS.forEach(([i,j], k) => {
    const a = hand.lm.slice(i * 3, i * 3 + 2), b = hand.lm.slice(j * 3, j * 3 + 2);
    const pixels = Math.hypot(b[0] - a[0], (b[1] - a[1]) / aspect);
    depth = Math.min(depth, focal * LENGTHS[k] / Math.max(pixels, 1e-3));
  });
  depth = THREE.MathUtils.clamp(depth, .18, 1.2);
  const k = .42 / focal;
  return new THREE.Vector3((hand.lm[0] - .5) * k, -(hand.lm[1] - .5) / aspect * k, -(.42 + .5 * (depth - .42)));
}

export class NativeArmDriver {
  constructor(arm) {
    this.arm = arm;
    this.initialElbow = arm.elbow.clone();
    this.anchor = new PointSetFilter(1, ANCHOR);
    this.reset();
  }
  reset() {
    const arm = this.arm;
    this.anchor.reset();
    arm.shoulder.copy(arm.homeShoulder);
    arm.elbow.copy(this.initialElbow);
    arm.wrist.set(0,0,0);
    arm.lastPivot = arm.calmPivot = arm.fixedHandQ = arm.lastHandQ = null;
    arm.result = arm.solved = null;
    arm.priorIds = null; arm.priorTrust = 0;
    arm.source = 'ik'; arm.follow = false; arm.opts = { side: arm.side };
    this.lastT = null;
  }
  update(rig, hand, aspect, t) {
    const raw = webWristAnchor(hand, aspect);
    const [position] = this.anchor.filter([raw.toArray()], t);
    rig.group.position.fromArray(position);
    const arm = this.arm;
    arm.shoulder.copy(arm.homeShoulder);
    arm.update(rig.group.position, rig.wrist.quaternion, null);
    // Exactly the web wrist/forearm roll limit; finger locals stay untouched.
    if (arm.fixedHandQ) rig.wrist.quaternion.copy(arm.fixedHandQ);
    this.lastT = t;
  }
}
