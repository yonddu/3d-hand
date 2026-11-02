// A hand model the user brings (GLB / glTF / FBX), driven by the raw MediaPipe
// points like the built-in Quest hand, to see how their own rig deforms.
//
// Finds each finger's bones by name (Mixamo LeftHandIndex1, Unreal index_01_l,
// Blender/Rigify f_index.01.L, Unity Index_Proximal_L, ...), ordered from the
// palm out; the hand bone is their nearest common ancestor. Then:
// - the whole model is moved, turned and scaled so its hand bone sits on the
//   MediaPipe wrist with the palm turned like the seen palm (wrist -> index,
//   middle, pinky roots), at the seen palm's size;
// - each finger bone turns the least it must (in its own parent's frame) to aim
//   at the next joint's MediaPipe point. Bone lengths stay the model's.
// A model with one hand is mirrored for the other hand (the user can say which
// hand the model is, or turn mirroring off).
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';

const FINGERS = [
  { key: 'thumb', mp: [1, 2, 3, 4], re: /thumb|pollex|(^|[^a-z])th(umb)?[_.\-\s]?\d/ },
  { key: 'index', mp: [5, 6, 7, 8], re: /index|pointer|(^|[^a-z])ind\d/ },
  { key: 'middle', mp: [9, 10, 11, 12], re: /middle|(^|[^a-z])mid(dle)?[_.\-\s]?\d/ },
  { key: 'ring', mp: [13, 14, 15, 16], re: /ring|(^|[^a-z])rng\d/ },
  { key: 'pinky', mp: [17, 18, 19, 20], re: /pinky|little|small|(^|[^a-z])pnk\d/ },
];
const TIP = /tip|end|nub|null|_4$|\.004$|4$|_end/;

function sideOf(name) {
  const n = name.toLowerCase();
  if (/left|(^|[^a-z])l[_.\s]|[_.\s]l($|[^a-z])|^l(?=[A-Z])/.test(n) || /(^|[_.\s])l$/.test(n)) return 'left';
  if (/right|(^|[^a-z])r[_.\s]|[_.\s]r($|[^a-z])/.test(n) || /(^|[_.\s])r$/.test(n)) return 'right';
  // Mixamo / camel case: LeftHand, mixamorig:RightHandIndex1
  if (/Left/.test(name)) return 'left';
  if (/Right/.test(name)) return 'right';
  return null;
}

// The skeleton: real bones when the file has them (an FBX can also carry plain
// nodes of the same names), else named plain nodes.
function boneList(root) {
  const bones = []; const named = [];
  root.traverse((o) => {
    // A bone with its parent's name (some FBX files nest a zero-length copy) is not a joint of its own.
    if (o.parent && o.parent.name === o.name) return;
    if (o.isBone) bones.push(o);
    else if (o.type === 'Object3D' && /hand|thumb|index|middle|ring|pinky|finger/i.test(o.name)) named.push(o);
  });
  return bones.length ? bones : named;
}

// The forearm bone above the hand (skipping twist / roll helpers): its place is the elbow.
const FOREARM = /forearm|fore_arm|lowerarm|lower_arm|lowarm|elbow|loarm/i;
function findForearm(hand) {
  for (let o = hand.parent, n = 0; o && n < 6; o = o.parent, n++) {
    if (/twist|roll|helper|bend/i.test(o.name)) continue;
    if (FOREARM.test(o.name)) return o;
  }
  return null;
}

function depth(o) { let d = 0; while (o.parent) { d++; o = o.parent; } return d; }
function ancestors(o) { const a = []; while (o) { a.push(o); o = o.parent; } return a; }
function commonAncestor(list) {
  let anc = ancestors(list[0]);
  for (const o of list.slice(1)) { const set = new Set(ancestors(o)); anc = anc.filter((x) => set.has(x)); }
  return anc[0];
}

// One hand of the model: its bones per finger, mapped to MediaPipe points.
function findHand(bones, side) {
  const mine = bones.filter((b) => side === null || sideOf(b.name) === side);
  const chains = {};
  for (const f of FINGERS) {
    let list = mine.filter((b) => f.re.test(b.name.toLowerCase().replace(/mixamorig[0-9]*:/, '')));
    if (f.key !== 'thumb') list = list.filter((b) => !FINGERS[0].re.test(b.name.toLowerCase()));
    list.sort((a, b) => depth(a) - depth(b));
    // Keep one line of bones (a branch elsewhere is not this finger).
    const line = [];
    for (const b of list) if (!line.length || ancestors(b).includes(line[line.length - 1])) line.push(b);
    let tip = null;
    if (line.length > 3 && TIP.test(line[line.length - 1].name.toLowerCase())) tip = line.pop();
    // Knuckle bones (metacarpals) ride with the palm: the last three are the moving ones.
    const moving = line.slice(-3);
    if (moving.length < 2) return null;
    chains[f.key] = { bones: moving, tip, extra: line.slice(0, -3) };
  }
  const roots = FINGERS.map((f) => chains[f.key].extra[0] || chains[f.key].bones[0]);
  let hand = commonAncestor(roots);
  if (!hand || !(hand.isBone || /hand|wrist/i.test(hand.name))) {
    hand = mine.find((b) => /hand|wrist/i.test(b.name) && !FINGERS.some((f) => f.re.test(b.name.toLowerCase()))) || roots[0].parent;
  }
  return { side, hand, chains };
}

export class CustomHand {
  constructor(root, name) {
    this.name = name;
    this.template = root;
    const bones = boneList(root);
    const sides = new Set(bones.map((b) => sideOf(b.name)).filter(Boolean));
    this.found = {};
    for (const side of ['left', 'right']) if (sides.has(side)) this.found[side] = findHand(bones, side) && side;
    if (!this.found.left && !this.found.right) {
      const any = findHand(bones, null);
      if (!any) {
        let skinned = false; root.traverse((o) => { if (o.isSkinnedMesh) skinned = true; });
        throw new Error(bones.length === 0 && !skinned
          ? '이 파일에는 뼈대(리깅)가 없습니다. 메시만 있는 모델은 움직일 수 없어요. 손 뼈를 넣은(리깅한) GLB/FBX를 불러오세요'
          : `손가락 뼈를 찾지 못했습니다 (뼈 ${bones.length}개, 이름에 thumb/index/middle/ring/pinky 필요)`);
      }
      this.found.any = true;
    }
    let meshes = 0; let tris = 0;
    root.traverse((o) => {
      if (o.isMesh) {
        meshes++;
        const g = o.geometry;
        tris += g.index ? g.index.count / 3 : g.attributes.position.count / 3;
        o.frustumCulled = false;
      }
    });
    this.stats = { meshes, tris: Math.round(tris), bones: bones.length };
    this.slots = { left: [], right: [] };
    this.choice = 'auto';
  }

  // The user's choice (MainActivity button): 'auto' (bone names; unknown = right),
  // 'left' / 'right' (the model is that hand), 'none' (never mirror).
  handedness() {
    if (this.choice === 'left' || this.choice === 'right') return this.choice;
    return this.found.left && !this.found.right ? 'left' : 'right';
  }

  mirrorFor(side) {
    if (this.choice === 'none') return false;
    if (this.found.left && this.found.right && (this.choice || 'auto') === 'auto') return false; // both hands in the file
    return this.handedness() !== side;
  }

  // A posable copy of the model for one hand of the picture.
  instance(scene, side) {
    // Which bones to use (a model with both hands: that side's), and which hand the model is.
    const both = this.found.left && this.found.right;
    const modelSide = both ? side : this.found.any ? null : this.found.left ? 'left' : 'right';
    const mirror = this.mirrorFor(side);
    const model = SkeletonUtils.clone(this.template);
    // outer: mirror for the other hand; root: placed each frame (hand on the wrist); model: as loaded.
    const outer = new THREE.Group();
    const root = new THREE.Group();
    outer.add(root); root.add(model);
    root.updateMatrixWorld(true);
    const h = findHand(boneList(model), modelSide);
    // Rest (as loaded): local turns, and world points for the palm frame.
    const restLocal = new Map();
    model.traverse((o) => restLocal.set(o, o.quaternion.clone()));
    const wp = (o) => o.getWorldPosition(new THREE.Vector3());
    const c = h.chains;
    const restFrame = frameOf(wp(h.hand), wp(c.index.bones[0]), wp(c.middle.bones[0]), wp(c.pinky.bones[0]));
    const restPalm = wp(c.middle.bones[0]).distanceTo(wp(h.hand));
    // The hand bone's place and turn in the model root's frame (root at rest = identity here).
    const handM = h.hand.matrixWorld.clone();
    const restHandQ = h.hand.getWorldQuaternion(new THREE.Quaternion());
    // Elbow (forearm bone), when the model has an arm: the forearm can follow the body pose.
    const fore = findForearm(h.hand);
    const restElbow = fore ? wp(fore) : null;
    const restFore = fore ? restElbow.distanceTo(wp(h.hand)) : 0;
    if (mirror) {
      outer.scale.x = -1;
      model.traverse((o) => { if (o.isMesh) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => (m.side = THREE.DoubleSide)); });
    }
    scene.add(outer);
    // Model finger bone lengths (bone -> next joint), in model palms: matched to the user's own later (fitLengths).
    const lengths = {};
    for (const f of FINGERS) {
      const ch = c[f.key];
      lengths[f.key] = ch.bones.map((b, k) => { const n = ch.bones[k + 1] || ch.tip; return n ? wp(n).distanceTo(wp(b)) / restPalm : 0; });
    }
    const inst = { outer, root, h, restLocal, restFrame, restPalm, handM, mirror, restHandQ, fore: restFore > 1e-6 ? fore : null, restElbow, restFore, lengths, fitted: null };
    if (window.HMS_DEBUG) window.customDebug = { hand: h.hand.name, chains: Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v.bones.map((b) => b.name).concat(v.tip ? ['tip:' + v.tip.name] : [])])), restPalm, mirror };
    outer.visible = false;
    return inst;
  }

  // The user's finger bone lengths (from MediaPipe's 3D points, in palms: wrist -> middle root),
  // { thumb: [3], index: [3], ... }. Each model finger bone is scaled (evenly, about its joint)
  // so it is as long, relative to the palm, as the user's: the fingertips land on the points
  // instead of past them. Thicker / thinner by the same factor. 0.5 .. 1.6 at most.
  fitLengths(inst, user) {
    const out = {};
    for (const f of FINGERS) {
      const ch = inst.h.chains[f.key];
      const off = 3 - ch.bones.length;
      let prev = 1; out[f.key] = [];
      ch.bones.forEach((bone, k) => {
        const m = inst.lengths[f.key][k];
        const t = user && user[f.key] ? user[f.key][k + off] : 0;
        const q = m > 1e-6 && t > 1e-6 ? Math.min(1.6, Math.max(0.5, t / m)) : prev;
        bone.scale.setScalar(q / prev);
        out[f.key].push(+q.toFixed(2));
        prev = q;
      });
    }
    inst.fitted = out;
    return out;
  }

  // elbow: the body pose's elbow for this hand, { ray: unit Vector3 from the camera
  // through the seen elbow, farther: whether the elbow is farther from the camera
  // than the wrist }, or null (no body pose: only the hand is placed).
  pose(inst, P, elbow) {
    const { outer, root, h, restLocal, restFrame, restPalm, mirror } = inst;
    if (mirror) P = P.map((p) => new THREE.Vector3(-p.x, p.y, p.z)); // pose the model's own side, then flip
    if (mirror && elbow) elbow = { ...elbow, ray: new THREE.Vector3(-elbow.ray.x, elbow.ray.y, elbow.ray.z) };
    for (const [o, q] of restLocal) o.quaternion.copy(q);
    // Root: hand bone onto the wrist, palm turned like the seen palm, seen size.
    const s = P[9].distanceTo(P[0]) / Math.max(restPalm, 1e-6);
    const W = new THREE.Matrix4().copy(frameOf(P[0], P[5], P[9], P[17])).multiply(restFrame.clone().transpose());
    const handRestPos = new THREE.Vector3().setFromMatrixPosition(inst.handM);
    // root matrix M: M * handRestPos = P0 and M turns by W, scales by s.
    const M = new THREE.Matrix4().makeTranslation(P[0].x, P[0].y, P[0].z)
      .multiply(W).multiply(new THREE.Matrix4().makeScale(s, s, s))
      .multiply(new THREE.Matrix4().makeTranslation(-handRestPos.x, -handRestPos.y, -handRestPos.z));
    root.matrixAutoUpdate = false;
    root.matrix.copy(M);
    outer.updateMatrixWorld(true);
    inst.elbowUsed = false;
    if (elbow && inst.fore) {
      // The elbow on its picture ray, one (model) forearm away from the wrist.
      const L = s * inst.restFore;
      const r = elbow.ray.clone().normalize();
      const b = r.dot(P[0]);
      const disc = b * b - P[0].lengthSq() + L * L;
      // Two places on the ray: the pose says nearer or farther than the wrist; one that
      // would be behind or right at the camera is not possible.
      const near = b - Math.sqrt(Math.max(disc, 0)); const far = b + Math.sqrt(Math.max(disc, 0));
      const t = disc < 0 ? b : elbow.farther || near < 0.05 ? far : near;
      if (t > 0.02) {
        const E = r.multiplyScalar(t);
        const Wq = new THREE.Quaternion().setFromRotationMatrix(W);
        const handRest = new THREE.Vector3().setFromMatrixPosition(inst.handM);
        const was = handRest.clone().sub(inst.restElbow).normalize().applyQuaternion(Wq);
        const R = new THREE.Quaternion().setFromUnitVectors(was, P[0].clone().sub(E).normalize()).multiply(Wq);
        // Model turned with the forearm from the elbow to the wrist; then the hand turned back to the seen palm.
        root.matrix.compose(new THREE.Vector3(), R, new THREE.Vector3(s, s, s));
        const shift = E.clone().sub(inst.restElbow.clone().applyMatrix4(root.matrix));
        root.matrix.premultiply(new THREE.Matrix4().makeTranslation(shift.x, shift.y, shift.z));
        outer.updateMatrixWorld(true);
        const outerInv0 = outer.matrixWorld.clone().invert();
        const pq0 = new THREE.Quaternion();
        new THREE.Matrix4().multiplyMatrices(outerInv0, h.hand.parent.matrixWorld).decompose(new THREE.Vector3(), pq0, new THREE.Vector3());
        h.hand.quaternion.copy(pq0.invert().multiply(Wq.clone().multiply(inst.restHandQ)));
        h.hand.updateWorldMatrix(false, true);
        inst.elbowUsed = true;
      }
    }
    // Fingers: each bone aims at the next joint's seen point. Worked in outer's own
    // space (the mirrored one for the other hand), where P lives.
    const outerInv = outer.matrixWorld.clone().invert();
    const tmpM = new THREE.Matrix4(); const tmpS = new THREE.Vector3(); const tmpP = new THREE.Vector3();
    const at = (o, v) => { o.updateWorldMatrix(true, false); return v.setFromMatrixPosition(tmpM.multiplyMatrices(outerInv, o.matrixWorld)); };
    const turnOf = (o, qOut) => { o.updateWorldMatrix(true, false); tmpM.multiplyMatrices(outerInv, o.matrixWorld).decompose(tmpP, qOut, tmpS); return qOut; };
    const q = new THREE.Quaternion(); const pq = new THREE.Quaternion();
    const pos = new THREE.Vector3(); const nextPos = new THREE.Vector3(); const par = new THREE.Vector3();
    for (const f of FINGERS) {
      const ch = h.chains[f.key];
      const list = ch.bones;
      const off = 3 - list.length; // two bones only: they are the outer ones
      list.forEach((bone, k) => {
        at(bone, pos);
        const child = list[k + 1] || ch.tip;
        const was = child ? at(child, nextPos).sub(pos) : pos.clone().sub(at(bone.parent, par));
        const target = P[f.mp[k + off + 1]].clone().sub(pos);
        if (was.lengthSq() < 1e-12 || target.lengthSq() < 1e-12) return;
        const turn = new THREE.Quaternion().setFromUnitVectors(was.normalize(), target.normalize());
        // turn in outer space -> the bone's local turn: parent^-1 * turn * parent, applied before its own turn
        turnOf(bone.parent, pq);
        q.copy(pq).invert().multiply(turn).multiply(pq);
        bone.quaternion.premultiply(q);
        bone.updateWorldMatrix(false, true);
      });
    }
    outer.visible = true;
  }
}

export function frameOf(wrist, index, middle, pinky) {
  const y = middle.clone().sub(wrist).normalize();
  const x = index.clone().sub(pinky);
  x.addScaledVector(y, -x.dot(y)).normalize();
  const z = new THREE.Vector3().crossVectors(x, y);
  return new THREE.Matrix4().makeBasis(x, y, z);
}

export async function parseModel(bytes, name) {
  const lower = name.toLowerCase();
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  let root;
  if (lower.endsWith('.fbx')) root = new FBXLoader().parse(buf, '');
  else root = (await new Promise((ok, no) => new GLTFLoader().parse(buf, '', ok, no))).scene;
  // Cameras and lights of the file are not wanted.
  const drop = [];
  root.traverse((o) => { if (o.isCamera || o.isLight) drop.push(o); });
  drop.forEach((o) => o.parent && o.parent.remove(o));
  return new CustomHand(root, name);
}
