// Where the forearm runs, from how people really hold their arms.
//
// One camera sees the hand well and the forearm poorly: the wrist's bend is
// the guess. The arm pose dictionary (armPoses.js, real movements keyed and
// in-betweened) says, for a hand at this place in front of the body and
// turned this way, which way the forearm went in those poses. The poses
// nearest in wrist position and hand orientation vote for the forearm's
// direction in the hand's frame; the arm rig leans toward that instead of
// a straight wrist, as far as the nearest poses agree with the reading.
import * as THREE from 'three';
import { ARM_POSES, armPoseJoints } from './armPoses.js';
import { TWO_HAND_MOTIONS } from './twoHandMotions.js';

const KEYS = ['sFlex', 'sAbd', 'hRot', 'elbow', 'pron', 'wFlex', 'wDev'];
// Each arm of the two-hand movements (keys hold [right, left]): how an arm
// is held while the hands work together, clasped, crossed or on one tool.
function twoHandPoses(side) {
  const k = side === 'right' ? 0 : 1;
  const out = [];
  for (const row of TWO_HAND_MOTIONS) row[6].forEach((key, i) => out.push({ id: `${row[0]}/${i}`, arm: Object.fromEntries(KEYS.map((n, j) => [n, key[k][j]])) }));
  return out;
}

const POS_SIGMA = 0.12; // metres of wrist position that count as one unit of mismatch
const ROT_SIGMA = (30 * Math.PI) / 180; // and of hand turn
const NEAREST = 12;
const MAX_COST = 4; // a nearest pose further off than this says nothing

export class ArmPrior {
  constructor(side, shoulder, poses = ARM_POSES.concat(twoHandPoses(side))) {
    this.side = side;
    this.entries = poses.map((p) => {
      const j = armPoseJoints(p.arm, side, shoulder);
      const dir = j.E.clone().sub(j.W).normalize().applyQuaternion(j.handQ.clone().invert());
      return { id: p.id, W: j.W, Q: j.handQ, dir };
    });
  }

  // wrist: scene position; handQ: hand orientation (scene). Returns the
  // forearm direction in the hand's frame and how much to trust it (0..1),
  // or null when no pose is near.
  guess(wrist, handQ) {
    const best = [];
    for (const e of this.entries) {
      const dp = wrist.distanceTo(e.W) / POS_SIGMA;
      const dq = handQ.angleTo(e.Q) / ROT_SIGMA;
      const cost = dp * dp + dq * dq;
      if (best.length < NEAREST || cost < best[best.length - 1].cost) {
        best.push({ e, cost });
        best.sort((a, b) => a.cost - b.cost);
        if (best.length > NEAREST) best.pop();
      }
    }
    if (!best.length || best[0].cost > MAX_COST) return null;
    const dir = new THREE.Vector3();
    let wsum = 0;
    for (const { e, cost } of best) {
      const w = Math.exp(-0.5 * cost);
      dir.addScaledVector(e.dir, w);
      wsum += w;
    }
    const len = dir.length() / wsum; // 1 when the nearest poses agree
    return { dir: dir.normalize(), trust: Math.exp(-0.5 * best[0].cost) * len, ids: best.slice(0, 3).map((b) => b.e.id) };
  }
}
