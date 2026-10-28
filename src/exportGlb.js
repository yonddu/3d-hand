// GLB export: first-person arms rig (shoulder -> upper arm -> forearm -> hand
// -> fingers, Mixamo bone names) with a skinned mesh and an animation clip.
//
// The file is meant to drop straight into Blender / Unity / Unreal / three.js:
//   HMS_Arms (scene)
//     HMS_ArmsMesh                  skinned mesh (hands + forearms + upper arms)
//     Head                          eye point = the phone, at the origin, never animated
//       FirstPersonCamera           looks down -Z like the phone did
//       LeftShoulder / RightShoulder
//         LeftArm                   upper arm, +Y toward the elbow
//           LeftForeArm             +Y toward the wrist, X follows the hand (twist)
//             LeftHand              +Y toward the fingers, +Z palm normal
//               LeftHandIndex1..4   +Y along the bone, flexion = +X rotation
//               LeftHeld_cylinder   held object (scaled to 0 while not held)
//
// Bind pose: arms straight forward, palms down, fingers relaxed (rig rest).
// The arm skin starts on the hand's wrist border (armMesh.js), so hand and arm
// are one continuous surface.
// Units are meters, +Y up, the same space as the app's scene.
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { FINGERS, wristName, boneName } from './skeleton.js';
import { ArmRig, UPPER, FORE, ARM_BIND, armLocals, limitedArmLocals, wristPivot, pivotLoop, WRIST_PIVOT } from './arm.js';
import { wristLoop, buildArm } from './armMesh.js';

const SIDES = ['left', 'right'];
const HIDE_GAP = 0.5; // seconds a hand stays drawn while unseen
const prefix = (side) => (side === 'left' ? 'Left' : 'Right');

// --- frames ----------------------------------------------------------------------
//
// A frame holds, per visible hand, everything needed to pose the rig:
//   { shoulder, elbow, wrist: [x,y,z] scene, upperQ, foreQ, handQ: [x,y,z,w] scene,
//     fingers: { boneName: [x,y,z,w] local }, object: grasp JSON (wrist-local) | null }

export function frameFromLive(side, rig, arm, grasp) {
  const m = arm.measure(rig.wrist.quaternion);
  return {
    shoulder: m.shoulder,
    elbow: m.elbow,
    wrist: rig.group.position.toArray(),
    upperQ: m.upperArmQuat,
    foreQ: m.forearmQuat,
    handQ: rig.wrist.quaternion.toArray(),
    fingers: rig.getPose().bones,
    cup: [rig.cup || 0],
    object: grasp ? grasp.toJSON() : null,
    armOpts: arm.opts,
  };
}

// Saved pose JSON hand -> frame. Older captures without arm data get null arm
// fields; the exporter then solves a default forearm.
export function frameFromPoseHand(side, h) {
  const a = h.arm;
  const P = prefix(side);
  return {
    shoulder: a ? a.shoulder : null,
    elbow: a ? a.elbow : null,
    wrist: h.position,
    upperQ: a && a.bones ? a.bones[`${P}Arm`] : null,
    foreQ: a && a.bones ? a.bones[`${P}ForeArm`] : null,
    handQ: h.wrist,
    fingers: h.bones,
    object: h.object || null,
  };
}

// --- skin baking -----------------------------------------------------------------

// CPU-skin a SkinnedMesh as currently posed. `toLocal` maps world space to the
// target bone space; `nameOf(boneIndex)` names the export bone for each influence.
export function bakeSkin(mesh, toLocal, nameOf) {
  const g = mesh.geometry;
  const pos = g.attributes.position;
  const nor = g.attributes.normal;
  const si = g.attributes.skinIndex;
  const sw = g.attributes.skinWeight;
  const skel = mesh.skeleton;
  const boneMats = skel.bones.map((b, i) => new THREE.Matrix4().multiplyMatrices(b.matrixWorld, skel.boneInverses[i]));
  const pre = toLocal.clone().multiply(mesh.matrixWorld).multiply(mesh.bindMatrixInverse);
  const n = pos.count;
  const position = new Float32Array(n * 3);
  const normal = new Float32Array(n * 3);
  const names = new Array(n * 4);
  const weights = new Float32Array(n * 4);
  const m = new THREE.Matrix4();
  const acc = new THREE.Matrix4();
  const nm = new THREE.Matrix3();
  const v = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    acc.elements.fill(0);
    for (let j = 0; j < 4; j++) {
      const w = sw.getComponent(i, j);
      const b = si.getComponent(i, j);
      names[i * 4 + j] = nameOf(b);
      weights[i * 4 + j] = w;
      if (!w) continue;
      const e = boneMats[b].elements;
      for (let k = 0; k < 16; k++) acc.elements[k] += e[k] * w;
    }
    m.multiplyMatrices(pre, acc).multiply(mesh.bindMatrix);
    v.fromBufferAttribute(pos, i).applyMatrix4(m).toArray(position, i * 3);
    if (nor) {
      nm.getNormalMatrix(m);
      v.fromBufferAttribute(nor, i).applyMatrix3(nm).normalize().toArray(normal, i * 3);
    }
  }
  return { position, normal, index: g.index ? new Uint32Array(g.index.array) : null, names, weights };
}

// --- building the rig ----------------------------------------------------------------

function bone(name, parent, pos = [0, 0, 0], quat = [0, 0, 0, 1]) {
  const b = new THREE.Bone();
  b.name = name;
  b.position.fromArray(pos);
  b.quaternion.fromArray(quat);
  if (parent) parent.add(b);
  return b;
}

function buildSide(side, head, skin, shoulder) {
  const P = prefix(side);
  const B = {};
  B.shoulder = bone(`${P}Shoulder`, head, shoulder);
  B.arm = bone(`${P}Arm`, B.shoulder, [0, 0, 0], ARM_BIND.toArray());
  B.fore = bone(`${P}ForeArm`, B.arm, [0, UPPER, 0]);
  B.hand = bone(wristName(side), B.fore, [0, FORE, 0]);
  // Helper on the wrist pivot taking half the hand's turn: the arm skin's
  // side of the bend and the heel of the hand follow it, so the wrist rounds
  // over the joint instead of folding like paper (user).
  B.bend = bone(`${P}WristBend`, B.fore, [0, FORE, 0]);
  B.fingers = {};
  for (const finger of FINGERS) {
    let parent = B.hand;
    // Skin offsets are from the tracked wrist point; the bone is on the pivot.
    let pos = skin.firstJoint[finger.key].slice();
    pos[1] -= WRIST_PIVOT;
    for (let k = 0; k < 4; k++) {
      const b = bone(boneName(side, finger, k), parent, pos, k < 3 ? skin.restLocal[finger.key][k] : [0, 0, 0, 1]);
      B.fingers[b.name] = b;
      if (k < 3) pos = skin.offsets[finger.key][k];
      parent = b;
    }
  }
  return B;
}

// One merged skinned geometry: hand skin (in hand-bone space) + forearm + upper arm.
function buildGeometry(sides, bonesBySide, skins, boneIndex) {
  const parts = [];
  for (const side of sides) {
    const B = bonesBySide[side];
    B.hand.updateWorldMatrix(true, false);
    const skin = skins[side];
    parts.push({
      position: skin.position,
      normal: new Float32Array(skin.normal),
      index: skin.index,
      skinIndex: Uint16Array.from(skin.names, (n) => boneIndex[n] ?? boneIndex[B.hand.name]),
      skinWeight: skin.weights,
      matrix: B.hand.matrixWorld.clone().multiply(new THREE.Matrix4().makeTranslation(0, -WRIST_PIVOT, 0)),
    });
    // Arm skin grown from the hand's wrist border (same as the app shows).
    const P = prefix(side);
    const arm = buildArm(pivotLoop(wristLoop(skin)));
    for (const { id, normal } of arm.seam) normal.toArray(parts[parts.length - 1].normal, id * 3);
    const n = arm.position.length / 3;
    const idx = new Uint16Array(n * 4);
    const ids = [boneIndex[`${P}Arm`], boneIndex[`${P}ForeArm`], boneIndex[`${P}WristBend`], boneIndex[wristName(side)]];
    const w = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      // As in the app (arm.js setSkin): the arm side of the bend rides the
      // half-turn helper, the heel of the hand (its skin) makes the rest.
      const share = [arm.weights[i * 3], arm.weights[i * 3 + 1], arm.weights[i * 3 + 2], 0];
      for (let j = 0; j < 4; j++) {
        idx[i * 4 + j] = ids[j];
        w[i * 4 + j] = share[j];
      }
    }
    B.arm.updateWorldMatrix(true, false);
    parts.push({ position: arm.position, normal: arm.normal, index: arm.index, skinIndex: idx, skinWeight: w, matrix: B.arm.matrixWorld.clone() });
  }

  const total = parts.reduce((s, p) => s + p.position.length / 3, 0);
  const position = new Float32Array(total * 3);
  const normal = new Float32Array(total * 3);
  const skinIndex = new Uint16Array(total * 4);
  const skinWeight = new Float32Array(total * 4);
  const index = [];
  let off = 0;
  const v = new THREE.Vector3();
  const nm = new THREE.Matrix3();
  for (const p of parts) {
    const n = p.position.length / 3;
    nm.getNormalMatrix(p.matrix);
    for (let i = 0; i < n; i++) {
      v.fromArray(p.position, i * 3).applyMatrix4(p.matrix).toArray(position, (off + i) * 3);
      v.fromArray(p.normal, i * 3).applyMatrix3(nm).normalize().toArray(normal, (off + i) * 3);
    }
    skinIndex.set(p.skinIndex, off * 4);
    skinWeight.set(p.skinWeight, off * 4);
    if (p.index) for (const k of p.index) index.push(k + off);
    else for (let i = 0; i < n; i++) index.push(i + off);
    off += n;
  }
  // glTF wants each joint once per vertex (several model joints can map to the
  // same export bone) and weights that sum to 1.
  const merged = new Map();
  for (let i = 0; i < total; i++) {
    merged.clear();
    for (let j = 0; j < 4; j++) {
      const w = skinWeight[i * 4 + j];
      if (w > 0) merged.set(skinIndex[i * 4 + j], (merged.get(skinIndex[i * 4 + j]) || 0) + w);
    }
    const list = [...merged].sort((a, b) => b[1] - a[1]);
    if (!list.length) list.push([0, 1]);
    const sum = list.reduce((s, [, w]) => s + w, 0);
    let rest = 1;
    for (let j = 0; j < 4; j++) {
      const e = list[j];
      skinIndex[i * 4 + j] = e ? e[0] : 0;
      skinWeight[i * 4 + j] = e ? e[1] / sum : 0;
      if (j) rest -= skinWeight[i * 4 + j];
    }
    skinWeight[i * 4] = rest; // absorb float rounding in the largest weight
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(position, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  g.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndex, 4));
  g.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));
  g.setIndex(index);
  return g;
}

// Held objects: one node per shape type, posed like GraspEstimator.render().
const SHAPES = ['cylinder', 'rod', 'sphere', 'box', 'pinch'];
function objectGeometry(type) {
  if (type === 'cylinder' || type === 'rod') return new THREE.CylinderGeometry(1, 1, 1, 32, 1, false);
  if (type === 'box') return new THREE.BoxGeometry(1, 1, 1);
  return new THREE.SphereGeometry(1, 32, 20);
}
const Y = new THREE.Vector3(0, 1, 0);
function objectTransform(o, type) {
  if (!o || o.type !== type) return { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [0, 0, 0] };
  const q = new THREE.Quaternion();
  let scale;
  if (type === 'cylinder' || type === 'rod') {
    q.setFromUnitVectors(Y, new THREE.Vector3().fromArray(o.axis || [0, 1, 0]).normalize());
    scale = [o.radius, o.length, o.radius];
  } else if (type === 'box') {
    q.fromArray(o.quaternion);
    scale = o.size;
  } else scale = [o.radius, o.radius, o.radius];
  return { pos: o.center, quat: q.toArray(), scale };
}

// --- per-frame local transforms ---------------------------------------------------------

// Game rigs keep bone lengths fixed, so each frame is re-solved with the fixed
// upper arm / forearm lengths (arm.js armLocals, the same solve the app shows).
function sideLocals(f, side, directTracking = false) {
  // Same forearm range limit as the app shows.
  // The hand bone sits on the wrist pivot (arm.js WRIST_PIVOT), as in the app.
  const handQ = new THREE.Quaternion().fromArray(f.handQ);
  const args = [new THREE.Vector3().fromArray(f.shoulder), new THREE.Vector3().fromArray(f.elbow), wristPivot(new THREE.Vector3().fromArray(f.wrist), handQ), handQ, { side, ...f.armOpts }];
  // Native baseline retains the detected hand orientation; the inferred arm follows it.
  const L = directTracking ? armLocals(...args) : limitedArmLocals(...args).L;
  return { shoulderPos: L.S.toArray(), arm: L.arm.toArray(), fore: L.fore.toArray(), hand: L.hand.toArray() };
}

// Fill missing arm data (old captures) with the app's own IK.
function completeFrame(side, f) {
  if (f.upperQ && f.foreQ && f.elbow && f.shoulder) return f;
  const arm = new ArmRig(side, new THREE.MeshBasicMaterial());
  const wrist = new THREE.Vector3().fromArray(f.wrist);
  const q = new THREE.Quaternion().fromArray(f.handQ);
  for (let i = 0; i < 30; i++) arm.update(wrist, q, null);
  const m = arm.measure(q);
  return { ...f, shoulder: m.shoulder, elbow: m.elbow, upperQ: m.upperArmQuat, foreQ: m.forearmQuat };
}

// --- export ------------------------------------------------------------------------------

// frames: [{ t: seconds, hands: { left: frame|null, right: frame|null } }]
// skins: { left, right } from RealHand/HandRig.exportSkin()
// Returns an ArrayBuffer (binary glTF).
export async function exportGlb({ frames, skins, name = 'HMS_Motion', includeObjects = true, raw = null, directTracking = false }) {
  const sides = SIDES.filter((s) => frames.some((fr) => fr.hands[s]));
  if (!sides.length) throw new Error('내보낼 손 데이터가 없습니다.');

  // Hold the last known frame per side across gaps (and before the first).
  const filled = {};
  for (const side of sides) {
    const first = frames.find((fr) => fr.hands[side]).hands[side];
    let last = completeFrame(side, first);
    filled[side] = [];
    for (const fr of frames) {
      if (fr.hands[side]) last = completeFrame(side, fr.hands[side]);
      filled[side].push(last);
    }
  }

  // A hand is drawn only while it is seen, and across gaps up to HIDE_GAP;
  // before it first shows, after it last shows and over longer gaps the
  // whole arm is scaled to nothing. Held over the whole take, a hand seen for
  // 0.9 s stood there from the first frame to the last (user GLB 2026-10-27 20:47).
  const shown = {};
  for (const side of sides) {
    const seen = frames.map((fr) => !!fr.hands[side]);
    shown[side] = seen.slice();
    let last = -1;
    seen.forEach((v, i) => {
      if (!v) return;
      if (!directTracking && last >= 0 && i - last > 1 && frames[i].t - frames[last].t <= HIDE_GAP) shown[side].fill(true, last + 1, i);
      last = i;
    });
  }

  // A Scene exports its children as glTF root nodes (skinned meshes must be roots).
  const root = new THREE.Scene();
  root.name = 'HMS_Arms';
  const head = bone('Head', null);
  root.add(head);
  const cam = new THREE.PerspectiveCamera(50, 4 / 3, 0.01, 100);
  cam.name = 'FirstPersonCamera';
  head.add(cam);

  const bonesBySide = {};
  for (const side of sides) bonesBySide[side] = buildSide(side, head, skins[side], filled[side][0].shoulder);

  const bones = [];
  head.traverse((o) => o.isBone && bones.push(o));
  const boneIndex = Object.fromEntries(bones.map((b, i) => [b.name, i]));
  root.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(bones); // inverses from the bind pose above
  const material = new THREE.MeshStandardMaterial({ name: 'Skin', color: 0xd9ab90, roughness: 0.6 });
  const mesh = new THREE.SkinnedMesh(buildGeometry(sides, bonesBySide, skins, boneIndex), material);
  mesh.name = 'HMS_ArmsMesh';
  root.add(mesh);
  mesh.bind(skeleton, new THREE.Matrix4());

  // Held objects.
  const objectNodes = {};
  if (includeObjects) {
    const objMat = new THREE.MeshStandardMaterial({ name: 'HeldObject', color: 0xd99a4e, roughness: 0.55 });
    for (const side of sides) {
      const used = new Set(filled[side].map((f) => f.object && f.object.type).filter(Boolean));
      for (const type of SHAPES) {
        if (!used.has(type)) continue;
        const node = new THREE.Mesh(objectGeometry(type), objMat);
        node.name = `${prefix(side)}Held_${type}`;
        bonesBySide[side].hand.add(node);
        (objectNodes[side] ||= []).push({ type, node });
      }
    }
  }

  // Tracks.
  const times = frames.map((fr) => fr.t - frames[0].t);
  const tracks = [];
  const quatTrack = (nodeName, values) => {
    // Keep neighbouring keys in the same hemisphere so interpolation takes the short way.
    for (let i = 4; i < values.length; i += 4) {
      const d = values[i] * values[i - 4] + values[i + 1] * values[i - 3] + values[i + 2] * values[i - 2] + values[i + 3] * values[i - 1];
      if (d < 0) for (let k = 0; k < 4; k++) values[i + k] = -values[i + k];
    }
    tracks.push(new THREE.QuaternionKeyframeTrack(`${nodeName}.quaternion`, times, values));
  };
  const vecTrack = (nodeName, prop, values) => tracks.push(new THREE.VectorKeyframeTrack(`${nodeName}.${prop}`, times, values));

  for (const side of sides) {
    const P = prefix(side);
    const locals = filled[side].map((f) => sideLocals(f, side, directTracking));
    vecTrack(`${P}Shoulder`, 'position', locals.flatMap((l) => l.shoulderPos));
    vecTrack(`${P}Shoulder`, 'scale', shown[side].flatMap((v) => (v ? [1, 1, 1] : [0, 0, 0])));
    quatTrack(`${P}Arm`, locals.flatMap((l) => l.arm));
    quatTrack(`${P}ForeArm`, locals.flatMap((l) => l.fore));
    quatTrack(wristName(side), locals.flatMap((l) => l.hand));
    quatTrack(`${P}WristBend`, locals.flatMap((l) => new THREE.Quaternion().slerp(new THREE.Quaternion().fromArray(l.hand), 0.5).toArray()));
    for (const finger of FINGERS) {
      for (let k = 0; k < 3; k++) {
        const n = boneName(side, finger, k);
        const rest = bonesBySide[side].fingers[n].quaternion.toArray();
        quatTrack(n, filled[side].flatMap((f) => (f.fingers && f.fingers[n]) || rest));
      }
    }
    for (const { type, node } of objectNodes[side] || []) {
      const tr = filled[side].map((f) => objectTransform(f.object, type));
      vecTrack(node.name, 'position', tr.flatMap((x) => x.pos));
      quatTrack(node.name, tr.flatMap((x) => x.quat));
      vecTrack(node.name, 'scale', tr.flatMap((x) => x.scale));
    }
  }
  const clip = new THREE.AnimationClip(name, -1, tracks);

  // Leave the nodes in the first frame's pose so the file opens posed.
  const mixer = new THREE.AnimationMixer(root);
  mixer.clipAction(clip).play();
  mixer.setTime(0);
  root.updateMatrixWorld(true);

  root.userData = {
    generator: 'Hand Motion Studio',
    ...(directTracking ? { tracking: 'native-direct-v1', armPose: 'inferred; not observed by a body model', hiddenHands: 'no gap filling' } : {}),
    naming: 'mixamo',
    units: 'meters',
    frames: frames.length,
    fps: frames.length > 1 ? +((frames.length - 1) / (times[times.length - 1] || 1)).toFixed(2) : 0,
    bind: 'arms straight forward (-Z), palms down, fingers relaxed',
  };
  // The tracker's raw readings (tracker.js lastRaw), so a sent-in file can be
  // replayed and measured (tools/replay.mjs). Not needed to play the motion.
  if (raw && raw.frames && raw.frames.length) root.userData.raw = raw;

  const exporter = new GLTFExporter();
  return exporter.parseAsync(root, { binary: true, animations: [clip], onlyVisible: false });
}

// Minimal stored (uncompressed) zip, for hosts that only accept .zip downloads.
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
export function zipFiles(files) {
  const enc = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of files) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const nameBytes = enc.encode(name);
    const crc = crc32(bytes);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint32(14, crc, true);
    local.setUint32(18, bytes.length, true);
    local.setUint32(22, bytes.length, true);
    local.setUint16(26, nameBytes.length, true);
    chunks.push(new Uint8Array(local.buffer), nameBytes, bytes);
    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true);
    cen.setUint16(4, 20, true);
    cen.setUint16(6, 20, true);
    cen.setUint16(8, 0x0800, true);
    cen.setUint32(16, crc, true);
    cen.setUint32(20, bytes.length, true);
    cen.setUint32(24, bytes.length, true);
    cen.setUint16(28, nameBytes.length, true);
    cen.setUint32(42, offset, true);
    central.push(new Uint8Array(cen.buffer), nameBytes);
    offset += 30 + nameBytes.length + bytes.length;
  }
  const cenSize = central.reduce((s, c) => s + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cenSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...chunks, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
}
