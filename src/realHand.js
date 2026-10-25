// Realistic hand skin driven by the solver rig.
//
// The mesh is the WebXR "generic-hand" model (MIT, @webxr-input-profiles/assets),
// the same joint layout Quest hand tracking uses. Its joints are siblings under
// one armature, each with an armature-space transform, so we pose it with a
// small forward-kinematics pass: every phalanx takes the solved bone's frame
// (Y = bone direction, X = flex axis) times a constant calibration, and its
// position follows the model's own bone lengths.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FINGERS, sideSign, wristName, boneName } from './skeleton.js';
import { bakeSkin } from './exportGlb.js';
import { fromGeometry, clipPlane, subdivide, toGeometry } from './meshOps.js';

// Where the wrist is cut open for the arm, along the hand's -Y from the wrist joint (m).
const WRIST_CUT = 0.002;
import { basisQuat, handFrameQuat } from './handRig.js';

// WebXR joint names per finger: [metacarpal, proximal, intermediate/distal, distal/tip, tip].
const XR = {
  thumb: ['thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip'],
  index: ['index-finger-metacarpal', 'index-finger-phalanx-proximal', 'index-finger-phalanx-intermediate', 'index-finger-phalanx-distal', 'index-finger-tip'],
  middle: ['middle-finger-metacarpal', 'middle-finger-phalanx-proximal', 'middle-finger-phalanx-intermediate', 'middle-finger-phalanx-distal', 'middle-finger-tip'],
  ring: ['ring-finger-metacarpal', 'ring-finger-phalanx-proximal', 'ring-finger-phalanx-intermediate', 'ring-finger-phalanx-distal', 'ring-finger-tip'],
  pinky: ['pinky-finger-metacarpal', 'pinky-finger-phalanx-proximal', 'pinky-finger-phalanx-intermediate', 'pinky-finger-phalanx-distal', 'pinky-finger-tip'],
};

// Joints driven by the solver's three bones, plus the end joint they point to.
function drivenChain(key) {
  const names = XR[key];
  return key === 'thumb' ? names : names.slice(1); // thumb metacarpal moves; finger metacarpals are rigid
}

export async function loadHandGLB(source) {
  let buffer;
  if (source.base64) {
    const bin = atob(source.base64);
    buffer = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buffer[i] = bin.charCodeAt(i);
    buffer = buffer.buffer;
  } else {
    const res = await fetch(source.url);
    if (!res.ok) throw new Error(`hand model fetch failed: ${res.status}`);
    buffer = await res.arrayBuffer();
  }
  return new Promise((resolve, reject) => new GLTFLoader().parse(buffer, '', resolve, reject));
}

export class RealHand {
  constructor(gltf, rig, material) {
    this.rig = rig;
    this.side = rig.side;
    this.root = gltf.scene;
    this.root.name = `${this.side}RealHand`;
    this.joints = {};
    this.root.traverse((o) => {
      if (o.isBone) this.joints[o.name] = o;
      if (o.isSkinnedMesh) {
        this.mesh = o;
        o.frustumCulled = false;
        o.castShadow = true;
      }
    });
    this.setMaterial(material);

    // Rest transforms (armature space == parent space, the joints are siblings).
    this.restPos = {};
    this.restQuat = {};
    for (const [name, j] of Object.entries(this.joints)) {
      this.restPos[name] = j.position.clone();
      this.restQuat[name] = j.quaternion.clone();
    }
    const P = (n) => this.restPos[n];
    // Same landmark roles as MediaPipe: wrist, index/middle/pinky MCP.
    const frameLandmarks = [];
    frameLandmarks[0] = P('wrist');
    frameLandmarks[5] = P('index-finger-phalanx-proximal');
    frameLandmarks[9] = P('middle-finger-phalanx-proximal');
    frameLandmarks[17] = P('pinky-finger-phalanx-proximal');
    this.restFrame = handFrameQuat(frameLandmarks, this.side);
    this.restFrameInv = this.restFrame.clone().invert();
    this.refineMesh();
    this.addWristFade();

    // Calibration per driven joint: model rest rotation expressed in the
    // solver-style bone frame built from the model's own rest pose.
    this.calib = {};
    this.offset = {}; // child offset in that bone frame
    const s = sideSign(this.side);
    const handX = new THREE.Vector3(1, 0, 0).applyQuaternion(this.restFrame);
    const across = new THREE.Vector3(-0.55 * s, 0, 0.85).applyQuaternion(this.restFrame);
    for (const finger of FINGERS) {
      const chain = drivenChain(finger.key);
      for (let k = 0; k < 3; k++) {
        const a = chain[k];
        const b = chain[k + 1];
        const dir = P(b).clone().sub(P(a));
        const hint = finger.key === 'thumb' ? new THREE.Vector3().crossVectors(dir.clone().normalize(), across) : handX;
        const frame = basisQuat(dir, hint);
        const inv = frame.clone().invert();
        this.calib[a] = inv.clone().multiply(this.restQuat[a]);
        this.offset[a] = dir.clone().applyQuaternion(inv);
        if (k === 2) this.calib[b] = inv.clone().multiply(this.restQuat[b]); // tip follows the last bone
      }
    }
    this.modelPalm = P('middle-finger-phalanx-proximal').distanceTo(P('wrist'));
    this.lenScale = Object.fromEntries(FINGERS.map((f) => [f.key, [1, 1, 1]]));
    this.propSamples = 0;
    this.pinches = [];
    this.thumbWrap = 0;
    // Off while a recording plays back: its frames already carry the contacts.
    this.contacts = true;
  }

  setMaterial(material) {
    if (this.mesh) this.mesh.material = withWristFade(material);
  }

  // Open the capped wrist with a clean planar cut (the arm skin continues from
  // that border) and subdivide once for a smoother, higher-poly hand.
  refineMesh() {
    const old = this.mesh.geometry;
    const handY = new THREE.Vector3(0, 1, 0).applyQuaternion(this.restFrame);
    const k = handY.dot(this.restPos.wrist) - WRIST_CUT;
    const m = subdivide(clipPlane(fromGeometry(old), handY, k));
    this.mesh.geometry = toGeometry(m);
    old.dispose();
  }

  // Seam normals from the arm (hand-bone space) so hand and arm shade as one surface.
  setSeamNormals(seam) {
    const nrm = this.mesh.geometry.attributes.normal;
    const n = new THREE.Vector3();
    for (const { id, normal } of seam) {
      n.copy(normal).applyQuaternion(this.restFrame);
      nrm.setXYZ(id, n.x, n.y, n.z);
    }
    nrm.needsUpdate = true;
  }

  // Fade the wrist out only while no arm is attached to it.
  setWristFade(on) {
    const attr = this.mesh.geometry.attributes.wristFade;
    attr.array.set(on ? this.fade : this.fade.map(() => 1));
    attr.needsUpdate = true;
  }

  // Per-vertex 0..1 fade toward the cut at the wrist, like Quest hands.
  addWristFade() {
    const pos = this.mesh.geometry.attributes.position;
    const back = new THREE.Vector3(0, -1, 0).applyQuaternion(this.restFrame); // toward the forearm
    const wrist = this.restPos.wrist;
    const p = new THREE.Vector3();
    const along = new Float32Array(pos.count);
    let max = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      along[i] = p.fromBufferAttribute(pos, i).sub(wrist).dot(back);
      max = Math.max(max, along[i]);
    }
    this.fade = along.map((t) => 1 - THREE.MathUtils.smoothstep(t, max - 0.03, max));
    this.mesh.geometry.setAttribute('wristFade', new THREE.BufferAttribute(this.fade.slice(), 1));
  }

  // Copy the solver rig's pose onto the model. Call after the rig is posed.
  update() {
    const rig = this.rig;
    this.root.position.copy(rig.group.position);
    this.root.visible = rig.group.visible;

    // Palm: rigid transform taking the model's rest hand frame to the solved one.
    const palm = rig.wrist.quaternion.clone().multiply(this.restFrameInv);
    const wristRest = this.restPos.wrist;
    const placeRigid = (name) => {
      const j = this.joints[name];
      j.position.copy(this.restPos[name]).sub(wristRest).applyQuaternion(palm);
      j.quaternion.copy(palm).multiply(this.restQuat[name]);
    };
    placeRigid('wrist');
    for (const key of ['index', 'middle', 'ring', 'pinky']) placeRigid(XR[key][0]);

    // The contact passes below adjust the rig's finger bones. update() runs
    // every rendered frame but the solver only on new camera frames, so start
    // each pass from the solved pose: re-adjusting an adjusted pose drifts.
    const links = Object.values(rig.chains).flat();
    if (!this.solvedQ) {
      this.solvedQ = links.map((l) => l.bone.quaternion.clone());
      this.writtenQ = links.map((l) => l.bone.quaternion.clone());
    }
    links.forEach((l, i) => {
      if (l.bone.quaternion.equals(this.writtenQ[i])) l.bone.quaternion.copy(this.solvedQ[i]);
      else this.solvedQ[i].copy(l.bone.quaternion); // new pose from the solver
    });
    if (this.contacts) {
      this.closeFist();
      if (this.thumbWrap > 0) this.wrapThumb();
      if (this.pinches.length) this.solvePinches();
    }
    links.forEach((l, i) => this.writtenQ[i].copy(l.bone.quaternion));
    for (const finger of FINGERS) {
      const chain = drivenChain(finger.key);
      const { pos, boneQ } = this.chainPose(finger.key);
      for (let k = 0; k < 4; k++) {
        const j = this.joints[chain[k]];
        j.position.copy(pos[k]);
        j.quaternion.copy(boneQ[Math.min(k, 2)]).multiply(this.calib[chain[k]]);
      }
    }
  }

  // Joint positions (wrist at the origin, rig orientation) and bone frames of
  // one driven chain for the rig's current pose, with this hand's segment
  // lengths (the model's, scaled to the tracked person's proportions).
  chainPose(key) {
    const rig = this.rig;
    const chain = drivenChain(key);
    const links = rig.chains[key];
    const palm = rig.wrist.quaternion.clone().multiply(this.restFrameInv);
    const start = this.restPos[chain[0]].clone().sub(this.restPos.wrist).applyQuaternion(palm);
    const pos = [start];
    const boneQ = [];
    const q = rig.wrist.quaternion.clone();
    for (let k = 0; k < 3; k++) {
      q.multiply(links[k].bone.quaternion);
      boneQ.push(q.clone());
      pos.push(pos[k].clone().add(this.offset[chain[k]].clone().multiplyScalar(this.lenScale[key][k]).applyQuaternion(q)));
    }
    return { pos, boneQ };
  }

  // Segment lengths follow the tracked hand, so the graphic fingers bend at
  // the same places as the real ones. Ratios are relative to the palm length
  // (overall size stays the model's) and averaged slowly.
  setProportions(P) {
    const d = (a, b) => P[a].distanceTo(P[b]);
    const palm = d(0, 9);
    if (palm < 1e-4) return;
    const segs = { thumb: [1, 2, 3, 4], index: [5, 6, 7, 8], middle: [9, 10, 11, 12], ring: [13, 14, 15, 16], pinky: [17, 18, 19, 20] };
    for (const [key, J] of Object.entries(segs)) {
      // Lengths are only read from a fairly straight finger: bent, its
      // segments are foreshortened or hidden and their points are guesses.
      const dir = (a, b) => P[b].clone().sub(P[a]).normalize();
      const bend = dir(J[0], J[1]).angleTo(dir(J[1], J[2])) + dir(J[1], J[2]).angleTo(dir(J[2], J[3]));
      if (!(bend < 0.6)) continue;
      const chain = drivenChain(key);
      for (let k = 0; k < 3; k++) {
        const want = d(J[k], J[k + 1]) / palm / (this.offset[chain[k]].length() / this.modelPalm);
        if (!Number.isFinite(want)) continue;
        const cur = this.lenScale[key][k];
        const target = THREE.MathUtils.clamp(want, 0.8, 1.25);
        this.lenScale[key][k] = cur + (target - cur) * (this.propSamples < 30 ? 0.15 : 0.02);
      }
    }
    this.propSamples++;
  }

  // Fingertip contact. When the tracked thumb tip and a fingertip (nearly)
  // touch, the graphic tips are brought together too: tiny depth errors and
  // the model's own proportions otherwise leave a gap in an OK sign or pinch.
  setPinches(P) {
    const palm = P[0].distanceTo(P[9]);
    this.pinches = [];
    if (palm < 1e-4) return;
    for (const [key, tip] of [['index', 8], ['middle', 12], ['ring', 16], ['pinky', 20]]) {
      const r = P[4].distanceTo(P[tip]) / palm;
      const weight = THREE.MathUtils.clamp((0.42 - r) / 0.17, 0, 1);
      if (weight > 0) this.pinches.push({ key, weight });
    }
  }

  // Thumb over a fist. When the tracked fingers are curled and the tracked
  // thumb tip lies on them (not raised, as in a thumbs-up), the thumb is
  // wrapped over the backs of the index and middle middle phalanges. Seen from
  // behind, the thumb in a fist is mostly hidden, so the tracked thumb usually
  // hovers off the fingers or sinks into them; a real thumb rests on them.
  // Read from the solved model, not the raw points: in a fist seen from
  // behind the raw finger joints are guesses (usually too open), and the
  // solver has already replaced them with the closing path.
  setThumbWrap(P) {
    this.thumbWrap = 0;
    if (P[0].distanceTo(P[9]) < 1e-4) return;
    const M = {};
    for (const key of ['thumb', 'index', 'middle', 'ring', 'pinky']) M[key] = this.chainPose(key).pos;
    const palm = this.modelPalm;
    const bendAt = (pos, k) => pos[k].clone().sub(pos[k - 1]).normalize().angleTo(pos[k + 1].clone().sub(pos[k]).normalize());
    // PIP bend of index and middle, ~45 to ~85 degrees.
    const bent = THREE.MathUtils.smoothstep(Math.min(bendAt(M.index, 1), bendAt(M.middle, 1)), 0.8, 1.5);
    const toSeg = (q, a, b) => {
      const ab = b.clone().sub(a);
      const t = THREE.MathUtils.clamp(q.clone().sub(a).dot(ab) / ab.lengthSq(), 0, 1);
      return q.distanceTo(a.clone().addScaledVector(ab, t));
    };
    const tip = M.thumb[3];
    const near = Math.min(...['index', 'middle'].flatMap((k) => [toSeg(tip, M[k][0], M[k][1]), toSeg(tip, M[k][1], M[k][2])])) / palm;
    const onFingers = THREE.MathUtils.clamp((0.7 - near) / 0.3, 0, 1);
    // A wrapping thumb points across the hand toward the little finger, or is
    // bent at its MCP/IP; a raised one (thumbs-up) is straight and points
    // along the hand.
    const thumbDir = M.thumb[3].clone().sub(M.thumb[1]).normalize();
    const ulnar = M.pinky[0].clone().sub(M.index[0]).normalize();
    const thumbBend = bendAt(M.thumb, 1) + bendAt(M.thumb, 2);
    const across = Math.max(THREE.MathUtils.smoothstep(thumbDir.dot(ulnar), 0.12, 0.35), THREE.MathUtils.smoothstep(thumbBend, 0.8, 1.2));
    this.thumbWrap = bent * onFingers * across;
  }

  wrapThumb() {
    const rig = this.rig;
    const w = this.thumbWrap;
    const hand = this.modelPalm / 0.094; // the model's size relative to a typical palm
    const LIFT = 0.017 * hand; // finger radius + thumb radius: surfaces touching
    // A point on the back (outside of the bend) of a finger's middle phalanx.
    const backOf = (key, t) => {
      const { pos } = this.chainPose(key);
      const along = pos[2].clone().sub(pos[1]).normalize();
      const prox = pos[1].clone().sub(pos[0]).normalize();
      const back = prox.addScaledVector(along, -prox.dot(along));
      if (back.lengthSq() < 1e-8) return null;
      return pos[1].clone().lerp(pos[2], t).addScaledVector(back.normalize(), LIFT);
    };
    const ccd = (target, from, maxStep) => {
      const links = rig.chains.thumb;
      for (let k = from; k >= 0; k--) {
        const { pos, boneQ } = this.chainPose('thumb');
        const end = pos[from + 1];
        const toEnd = end.clone().sub(pos[k]);
        const toGoal = target.clone().sub(pos[k]);
        if (toEnd.lengthSq() < 1e-10 || toGoal.lengthSq() < 1e-10) continue;
        const R = new THREE.Quaternion().setFromUnitVectors(toEnd.normalize(), toGoal.normalize());
        const angle = 2 * Math.acos(Math.min(1, Math.abs(R.w)));
        if (angle > maxStep) R.slerp(new THREE.Quaternion(), 1 - maxStep / angle);
        const parent = k === 0 ? rig.wrist.quaternion : boneQ[k - 1];
        links[k].bone.quaternion.premultiply(parent.clone().invert().multiply(R).multiply(parent));
      }
    };
    for (let it = 0; it < 4; it++) {
      // The IP joint sits over the index, the tip reaches the middle finger.
      const ipGoal = backOf('index', 0.35);
      const tipGoal = backOf('middle', 0.45);
      if (!ipGoal || !tipGoal) return;
      const { pos } = this.chainPose('thumb');
      ccd(pos[2].clone().lerp(ipGoal, w * 0.6), 1, 0.15);
      const now = this.chainPose('thumb').pos[3];
      ccd(now.clone().lerp(tipGoal, w * 0.6), 2, 0.15);
    }
  }

  // Bent fingers press against their neighbours. Tracking places each finger
  // on its own and a fist seen from behind is mostly guessed, which leaves
  // gaps; real fingers can only close those gaps, so neighbours that are both
  // bent at the knuckle are turned toward each other until their sides touch
  // (spacing = how far apart the knuckles sit on the palm).
  closeFist() {
    const rig = this.rig;
    const pairs = [['index', 'middle'], ['middle', 'ring'], ['ring', 'pinky']];
    const flexOf = (key) => {
      const { pos } = this.chainPose(key);
      const palmN = new THREE.Vector3(0, 0, 1).applyQuaternion(rig.wrist.quaternion);
      const along = new THREE.Vector3(0, 1, 0).applyQuaternion(rig.wrist.quaternion);
      const d = pos[1].clone().sub(pos[0]).normalize();
      return Math.atan2(d.dot(palmN), d.dot(along)); // knuckle bend toward the palm
    };
    const turn = (key, goal) => {
      const { pos } = this.chainPose(key);
      const from = pos[1].clone().sub(pos[0]).normalize();
      const to = goal.clone().sub(pos[0]).normalize();
      const R = new THREE.Quaternion().setFromUnitVectors(from, to);
      const parent = rig.wrist.quaternion;
      rig.chains[key][0].bone.quaternion.premultiply(parent.clone().invert().multiply(R).multiply(parent));
    };
    for (let it = 0; it < 2; it++) {
      for (const [a, b] of pairs) {
        const bend = Math.min(flexOf(a), flexOf(b));
        const w = THREE.MathUtils.smoothstep(bend, 0.5, 1.2); // ~30 to ~70 degrees
        if (w <= 0) continue;
        const A = this.chainPose(a).pos;
        const B = this.chainPose(b).pos;
        const spacing = A[0].distanceTo(B[0]);
        const gap = A[1].distanceTo(B[1]);
        if (gap <= spacing) continue;
        const dir = A[1].clone().sub(B[1]).normalize();
        const close = ((gap - spacing) / 2) * w;
        turn(a, A[1].clone().addScaledVector(dir, -close));
        turn(b, B[1].clone().addScaledVector(dir, close));
      }
    }
  }

  solvePinches() {
    const rig = this.rig;
    const tipOf = (key) => {
      const { pos } = this.chainPose(key);
      return pos[3];
    };
    const ccd = (key, target, maxStep) => {
      const links = rig.chains[key];
      for (let k = 2; k >= 0; k--) {
        const { pos, boneQ } = this.chainPose(key);
        const toTip = pos[3].clone().sub(pos[k]);
        const toGoal = target.clone().sub(pos[k]);
        if (toTip.lengthSq() < 1e-10 || toGoal.lengthSq() < 1e-10) continue;
        const R = new THREE.Quaternion().setFromUnitVectors(toTip.normalize(), toGoal.normalize());
        const angle = 2 * Math.acos(Math.min(1, Math.abs(R.w)));
        if (angle > maxStep) R.slerp(new THREE.Quaternion(), 1 - maxStep / angle);
        const parent = k === 0 ? rig.wrist.quaternion : boneQ[k - 1];
        // World rotation R applied to bone k: local' = parent^-1 * R * parent * local.
        const pinv = parent.clone().invert();
        links[k].bone.quaternion.premultiply(pinv.clone().multiply(R).multiply(parent));
      }
    };
    const GAP = 0.009; // tip joints sit inside the pads; this leaves the pads touching
    for (const { key, weight } of this.pinches) {
      for (let it = 0; it < 4; it++) {
        const a = tipOf('thumb');
        const b = tipOf(key);
        const between = a.distanceTo(b);
        if (between <= GAP * 1.05) break;
        const dir = a.clone().sub(b).normalize();
        const mid = a.clone().add(b).multiplyScalar(0.5);
        const pull = ((between - GAP) / between) * weight;
        const goalA = a.clone().lerp(mid.clone().addScaledVector(dir, GAP / 2), pull);
        const goalB = b.clone().lerp(mid.clone().addScaledVector(dir, -GAP / 2), pull);
        ccd('thumb', goalA, 0.12);
        ccd(key, goalB, 0.12);
      }
    }
  }

  // Mesh + bone offsets for GLB export, in the solver rig's bone layout.
  // Every model joint follows one rig bone rigidly (see update()), so the
  // model skin can be rebound to the rig bones: bake the mesh with the rig at
  // rest, then name each influence by the rig bone that carries its joint.
  exportSkin() {
    const rig = this.rig;
    const side = this.side;
    const jointBone = { wrist: wristName(side) };
    const firstJoint = {};
    const offsets = {};
    const restLocal = {};
    for (const finger of FINGERS) {
      if (finger.key !== 'thumb') jointBone[XR[finger.key][0]] = wristName(side);
      const chain = drivenChain(finger.key);
      chain.forEach((n, k) => (jointBone[n] = boneName(side, finger, k)));
      firstJoint[finger.key] = this.restPos[chain[0]].clone().sub(this.restPos.wrist).applyQuaternion(this.restFrameInv).toArray();
      offsets[finger.key] = [0, 1, 2].map((k) => this.offset[chain[k]].toArray());
      restLocal[finger.key] = rig.chains[finger.key].map((l) => l.restLocal.toArray());
    }

    const saved = rig.getPose();
    rig.resetPose();
    rig.group.position.set(0, 0, 0);
    this.update();
    this.root.updateMatrixWorld(true);
    // World -> hand-bone space; the rig wrist sits at the origin with its rest rotation.
    const toHand = new THREE.Matrix4().makeRotationFromQuaternion(rig.wristRest.clone().invert());
    const baked = bakeSkin(this.mesh, toHand, (i) => jointBone[this.mesh.skeleton.bones[i].name] || wristName(side));
    rig.setPose(saved);
    this.update();
    this.root.updateMatrixWorld(true);
    return { firstJoint, offsets, restLocal, ...baked };
  }
}

export function withWristFade(material) {
  const prev = material.onBeforeCompile;
  material.transparent = true;
  material.customProgramCacheKey = () => `wrist-fade|${prev ? prev.toString() : ''}`;
  material.onBeforeCompile = (shader, renderer) => {
    if (prev) prev(shader, renderer);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', 'attribute float wristFade;\nvarying float vWristFade;\n#include <common>')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWristFade = wristFade;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', 'varying float vWristFade;\n#include <common>')
      .replace('#include <opaque_fragment>', 'diffuseColor.a *= vWristFade;\n#include <opaque_fragment>');
  };
  return material;
}

// Quest-style hand: pale, slightly translucent, with a soft bright rim.
export function questMaterial() {
  const m = new THREE.MeshStandardMaterial({ color: 0xdfe6ea, roughness: 0.45, metalness: 0, transparent: true, opacity: 0.88 });
  m.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <opaque_fragment>',
      `float rim = pow(1.0 - clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0), 2.2);
       outgoingLight += vec3(0.55, 0.78, 0.95) * rim * 0.9;
       diffuseColor.a = mix(diffuseColor.a, 1.0, rim * 0.6);
       #include <opaque_fragment>`,
    );
  };
  return m;
}
