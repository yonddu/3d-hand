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
import { addDepthPrepass } from './prepass.js';
import { ArmPrior } from './armPrior.js';

export { UPPER, FORE };
// The wrist is an ellipsoid (radiocarpal) joint: it flexes/extends and tilts
// toward the thumb or the little finger, but does not twist. Pronation lives in
// the forearm (segmentQuat rolls it with the hand). Range of motion in degrees.
const WRIST_ROM = { flex: 70, ext: 60, radial: 20, ulnar: 35 };
const ELBOW_MAX = (150 * Math.PI) / 180; // elbow flexion 150, extension 0
const COMFORT = 0.6; // share of the range the IK view uses before turning the forearm
const SHRUG = 0.12; // how far the shoulder may move to keep the wrist natural (m)
const Y = new THREE.Vector3(0, 1, 0);
// Forearm twist helpers: the roll is shared evenly by the elbow, these and
// the wrist, so neighbouring joints differ by at most 160/(n+2) degrees.
const TWISTS = 5;
// Forearm roll allowed either side of thumb up: pronation/supination ~80-90
// degrees plus slack for shoulder rotation and the guessed elbow.
// Where the hand turns on the forearm, along the hand from the tracked wrist
// point (m). MediaPipe's wrist point sits on the forearm side of the crease;
// the wrist bends at the carpal bones, further into the heel of the hand
// (user: the bend showed ~2 cm too far up the forearm).
export const WRIST_PIVOT = 0.015;
export function wristPivot(wrist, handQuat) {
  return new THREE.Vector3(0, WRIST_PIVOT, 0).applyQuaternion(handQuat).add(wrist);
}
// A hand border loop (armMesh.wristLoop) moved into the pivot's frame.
export function pivotLoop(loop) {
  return { ...loop, points: loop.points.map((p) => p.clone().setY(p.y - WRIST_PIVOT)) };
}
// Wrist extension held without thinking. The dictionary median is 10 deg,
// but seen from the eyes a straight forearm-hand line reads as right.
const REST_EXT = (5 * Math.PI) / 180;
const PRIOR_GAIN = 1.5; // how fast the arm-pose prior's trust reaches full weight
const BEND_SIDES = [[0, 1], [0, -1], [1, 0], [-1, 0]]; // (x, z) in the forearm's frame
const BEND_BULGE = 0.004; // m of outward push on the inside of a right-angle wrist bend (1.2 cm stood out as a ridge, user)
const WRIST_FLEX = (75 * Math.PI) / 180;
const WRIST_EXT = (65 * Math.PI) / 180;
const WRIST_DEV = (30 * Math.PI) / 180;
const ROLL_LIMIT = (110 * Math.PI) / 180;

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
    // Twist helpers along the forearm (screen only, not exported): turning the
    // palm down rolls the radius around the ulna, so the skin twists a little
    // at the elbow and most at the wrist. Spread over three joints, a full
    // pronation never wrings the skin flat in one place.
    this.bones.twists = [];
    let parent = this.bones.fore;
    for (let k = 0; k < TWISTS; k++) {
      parent = bone(`${P}ForeArmTwist${k + 1}`, parent, FORE / (TWISTS + 1));
      this.bones.twists.push(parent);
    }
    this.bones.mid = bone(`${P}WristMid`, parent, FORE / (TWISTS + 1));
    this.bones.hand = bone(`${P}Hand`, this.bones.mid, 0);

    const jointGeo = new THREE.SphereGeometry(0.008, 12, 8);
    const jointMat = new THREE.MeshBasicMaterial({ color: 0x3fd0c9, depthTest: false, transparent: true });
    this.elbowDot = new THREE.Mesh(jointGeo, jointMat);
    this.elbowDot.renderOrder = 10;
    this.group.add(this.elbowDot);
  }

  // Build the arm skin from the hand's wrist border (armMesh.wristLoop()).
  setSkin(loop, material) {
    const arm = buildArm(pivotLoop(loop));
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
      // bones: 0 shoulder, 1 arm, 2 forearm, then the twist helpers, the
      // wrist helper and the hand. The forearm's share is spread over the
      // forearm chain by how far down the forearm the vertex is; the hand's
      // share is split, the forearm side of the bend going to the wrist helper.
      const MID = 3 + TWISTS;
      const h = arm.weights[i * 3 + 2];
      const f = arm.weights[i * 3 + 1];
      const u = THREE.MathUtils.clamp(((arm.position[i * 3 + 1] - UPPER) / FORE) * (TWISTS + 1), 0, TWISTS + 1); // 0 elbow .. wrist
      const k = Math.min(Math.floor(u), TWISTS);
      const t = u - k;
      // The arm side of the bend takes at most the helper's half turn; the
      // heel of the hand makes the rest (RealHand bend bone), so the bend
      // straddles the border.
      const w = { 1: arm.weights[i * 3], [MID]: h };
      w[2 + k] = (w[2 + k] || 0) + f * (1 - t);
      w[3 + k] = (w[3 + k] || 0) + f * t;
      const top = Object.entries(w).filter(([, x]) => x > 0).sort((a, b) => b[1] - a[1]).slice(0, 4);
      const sum = top.reduce((a, [, x]) => a + x, 0) || 1;
      for (let j = 0; j < 4; j++) {
        skinIndex[i * 4 + j] = top[j] ? +top[j][0] : 0;
        skinWeight[i * 4 + j] = top[j] ? top[j][1] / sum : 0;
      }
    }
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndex, 4));
    g.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));
    g.setAttribute('wristFade', new THREE.BufferAttribute(new Float32Array(arm.fadeElbow), 1));
    g.setAttribute('skinDQ', new THREE.BufferAttribute(new Float32Array(n).fill(1), 1)); // dual quaternion skinning (realHand withWristFade)
    // Wrist bend correctives: skin on the inside of the bend bunches outward
    // instead of folding into the wrist (user: bending the hand back dented
    // the back of the wrist). One target per side (+z palm, -z back, +x, -x),
    // the push along the skin's normal peaking mid-bend-zone and zero at the
    // hand's border, so the seam with the hand stays closed.
    g.morphAttributes.position = BEND_SIDES.map((dir) => {
      const d = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        const h = arm.weights[i * 3 + 2];
        const zone = 4 * h * (1 - h);
        if (zone <= 0) continue;
        const nx = arm.normal[i * 3];
        const nz = arm.normal[i * 3 + 2];
        const l = Math.hypot(nx, nz) || 1;
        const facing = Math.max(0, (nx * dir[0] + nz * dir[1]) / l) ** 1.5;
        v.set(nx / l, 0, nz / l).multiplyScalar(BEND_BULGE * zone * facing).applyQuaternion(ARM_BIND).toArray(d, i * 3);
      }
      return new THREE.BufferAttribute(d, 3);
    });
    g.morphTargetsRelative = true;
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
    B.twists.forEach((b) => b.quaternion.identity());
    B.mid.quaternion.identity();
    B.hand.quaternion.identity();
    this.group.updateMatrixWorld(true);
    const skeleton = new THREE.Skeleton([B.shoulder, B.arm, B.fore, ...B.twists, B.mid, B.hand]);
    this.mesh = new THREE.SkinnedMesh(g, material);
    this.mesh.name = `${this.side}ArmMesh`;
    this.mesh.frustumCulled = false;
    this.group.add(this.mesh);
    this.mesh.bind(skeleton, new THREE.Matrix4());
    addDepthPrepass(this.mesh);
    this.setVisible(this.visible ?? true, this.showUpper, this.elbowDot.visible);
    if (this.solved) this.pose(this.wrist, this.lastHandQ);
  }

  setMaterial(material) {
    if (!this.mesh) return;
    this.mesh.material = material;
    addDepthPrepass(this.mesh);
  }

  // wrist: scene position of the wrist joint; handQuat: wrist bone rotation in
  // scene space; elbowHint: elbow seen by the pose model (scene space) or null.
  update(wrist, handQuat, elbowHint = null) {
    const handY = Y.clone().applyQuaternion(handQuat);
    const pivot = wristPivot(wrist, handQuat);
    let target;
    // People hold the wrist nearly straight (a little extended): the forearm
    // continues the hand's line. Reaching back to a guessed shoulder bent the
    // wrist sideways whenever the phone was held another way (user: "nobody's
    // wrist bends like that").
    const palmN = new THREE.Vector3(0, 0, 1).applyQuaternion(handQuat);
    const back = handY.clone().multiplyScalar(-Math.cos(REST_EXT)).addScaledVector(palmN, -Math.sin(REST_EXT));
    // Real arm poses with the hand here and turned this way say how the
    // wrist is usually bent (armPrior.js): the forearm's resting line leans
    // that way, as far as those poses agree. On held-out movements this
    // halved the wrist-bend error of a straight wrist (t159: 26 -> 14 deg
    // on bent wrists).
    this.prior ||= new ArmPrior(this.side, this.homeShoulder);
    const guess = this.prior.guess(pivot, handQuat);
    this.priorIds = guess ? guess.ids : null;
    if (guess) back.lerp(guess.dir.clone().applyQuaternion(handQuat), Math.min(1, guess.trust * PRIOR_GAIN)).normalize();
    if (this.follow) {
      target = this.followElbow(pivot, handQuat, back, elbowHint);
      this.source = elbowHint ? 'pose' : 'hand';
    } else if (elbowHint) {
      target = elbowHint.clone();
      this.source = 'pose';
    } else {
      target = solveElbow(this.shoulder, pivot, pivot.clone().addScaledVector(back, FORE));
      this.source = 'ik';
    }
    // Live passthrough: the forearm lies on the seen line and the shoulder is free.
    this.opts = !this.follow ? { side: this.side } : { direct: true, comfort: 1, shrug: 2, side: this.side };
    // In first person the elbow comes from the hand itself; easing it made
    // the forearm trail the hand, a bent wrist whenever the hand moved.
    this.elbow.lerp(target, this.follow ? 1 : 0.35);
    return this.pose(wrist, handQuat);
  }

  // First person: where the elbow is now. Bending the wrist turns the hand
  // about the wrist while the wrist itself stays put, so the forearm keeps
  // its place (the elbow holds still) and the hand shows the bend. Moving
  // the arm carries the wrist, and the forearm then eases back onto the
  // hand's line, the way a relaxed wrist rides. Either way the bend stays
  // within the wrist's range. Pinning the forearm to the hand's line (v40)
  // swung the whole forearm with every wrist bend (user).
  followElbow(pivot, handQuat, back, hint) {
    const inv = handQuat.clone().invert();
    const rest = back.clone().applyQuaternion(inv);
    let d = this.elbow.clone().sub(pivot);
    const len = d.length();
    const jump = this.lastPivot ? this.lastPivot.distanceTo(pivot) : Infinity;
    this.lastPivot = pivot.clone();
    // Travel of the wrist, read through a light average so tracking jitter
    // (a few mm frame to frame) does not count as the arm moving.
    const was = jump > 0.15 || !this.calmPivot ? pivot.clone() : this.calmPivot.clone();
    this.calmPivot = was.clone().lerp(pivot, 0.3);
    const travel = was.distanceTo(this.calmPivot);
    // Lost track, a new take or a jump: start on the hand's line.
    if (!(len > FORE * 0.5 && len < FORE * 1.5) || jump > 0.15) d = rest.clone();
    else d.divideScalar(len).applyQuaternion(inv);
    if (d.y > -0.2) d.copy(rest); // a forearm ahead of the hand is no wrist bend
    // Ease back onto the line while the wrist travels (past 4 mm a frame;
    // 2.4 cm or more: a third of the way each frame); a still
    // wrist keeps its bend, with only a slow drift.
    const ease = 0.002 + 0.3 * THREE.MathUtils.clamp((travel - 0.004) / 0.02, 0, 1);
    if (hint) {
      // A seen elbow (pose model, or the forearm line in the picture) pulls
      // gently; on its own it is too noisy to set the forearm (sleeve, desk).
      const h = hint.clone().sub(pivot).normalize().applyQuaternion(inv);
      if (h.y < -0.2) d.lerp(h, 0.08);
    }
    d.lerp(rest, Math.min(ease, 1));
    // Wrist range (hand frame: +z palm side): flexion 75, extension 65,
    // deviation 30 either way.
    const down = Math.max(-d.y, 1e-3);
    const fe = THREE.MathUtils.clamp(Math.atan2(d.z, down), -WRIST_EXT, WRIST_FLEX);
    const dv = THREE.MathUtils.clamp(Math.atan2(d.x, down), -WRIST_DEV, WRIST_DEV);
    d.set(Math.tan(dv), -1, Math.tan(fe)).normalize().applyQuaternion(handQuat);
    const target = pivot.clone().addScaledVector(d, FORE);
    target.z = Math.min(target.z, -0.06); // never between the eye and the phone
    return target;
  }

  // Pose the bones for this wrist, using the current elbow hint (no smoothing).
  pose(wrist, handQuat) {
    this.wrist.copy(wrist);
    const { L, fixedQ } = limitedArmLocals(this.shoulder, this.elbow, wristPivot(wrist, handQuat), handQuat, this.opts);
    this.fixedHandQ = fixedQ;
    if (fixedQ) handQuat = fixedQ;
    this.lastHandQ = handQuat.clone();
    this.solved = L;
    const B = this.bones;
    B.shoulder.position.copy(L.S);
    B.arm.quaternion.copy(L.arm);
    // Forearm = bend (swing) then roll about its own axis (twist), the roll
    // shared out along the forearm's helpers. The same turn can be read as a
    // roll one way or the other way round (a quaternion gives it anywhere in
    // +-360 degrees); the forearm only turns within pronation/supination, so
    // the roll is taken within half a turn of neutral (thumb up). Palm down
    // and palm up are then reached through thumb up, never through thumb
    // down, and the twist never wraps inside the range of motion.
    const roll = rollOf(L, (-sideSign(this.side) * Math.PI) / 2);
    const twist = (k) => new THREE.Quaternion().setFromAxisAngle(Y, roll * k);
    const swing = L.fore.clone().multiply(twist(1).invert());
    const step = 1 / (TWISTS + 2);
    B.fore.quaternion.copy(swing).multiply(twist(step));
    B.twists.forEach((b) => b.quaternion.copy(twist(step)));
    const half = new THREE.Quaternion().slerp(L.hand, 0.5);
    B.mid.quaternion.copy(twist(step)).multiply(half);
    B.hand.quaternion.copy(half).invert().multiply(L.hand);
    this.elbowDot.position.copy(L.E);
    if (this.mesh && this.mesh.morphTargetInfluences) {
      // The hand tips toward the inside of the bend.
      const hy = Y.clone().applyQuaternion(L.hand);
      const tip = Math.hypot(hy.x, hy.z) || 1;
      const amount = Math.min(Math.acos(THREE.MathUtils.clamp(hy.y, -1, 1)) / (Math.PI / 2), 1.2);
      BEND_SIDES.forEach((dir, k) => (this.mesh.morphTargetInfluences[k] = amount * Math.max(0, (hy.x * dir[0] + hy.z * dir[1]) / tip)));
    }
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
    // + radial (toward the thumb, +X on the right hand), - ulnar.
    const wristDeviation = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(handYInFore.x, -1, 1))) * sideSign(this.side);
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

// armLocals with the forearm's turn kept in range.
// The forearm turns the palm at most ~90 degrees each way from thumb up
// (pronation/supination). A hand read further round than ROLL_LIMIT would
// need the forearm wrung past its range, which no arm can do: the reading is
// wrong (usually the hand seen turned the other way), so the hand is turned
// back about the forearm to the edge of the range. fixedQ is that hand
// rotation (null when the reading was in range); callers show it.
export function limitedArmLocals(S, E, wrist, handQuat, opts) {
  let L = armLocals(S, E, wrist, handQuat, opts);
  const neutral = (-sideSign(opts.side) * Math.PI) / 2; // thumb up, from palm up (roll 0)
  const off = rollOf(L, neutral) - neutral;
  if (Math.abs(off) <= ROLL_LIMIT) return { L, fixedQ: null };
  const axis = wrist.clone().sub(L.E).normalize(); // elbow -> wrist
  const fixedQ = new THREE.Quaternion().setFromAxisAngle(axis, -(off - Math.sign(off) * ROLL_LIMIT)).multiply(handQuat);
  return { L: armLocals(S, E, wrist, fixedQ, opts), fixedQ };
}

// Forearm roll taken within 180 degrees of neutral.
function rollOf(L, neutral) {
  return neutral + THREE.MathUtils.euclideanModulo(2 * Math.atan2(L.fore.y, L.fore.w) - neutral + Math.PI, 2 * Math.PI) - Math.PI;
}
