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
const SIDE_RAD = THREE.MathUtils.degToRad(20); // most a middle / end finger joint bends sideways
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
    // Rest joints and turns of the finger bones, in the model's rest space (= outer's own space).
    const restBone = new Map();
    for (const f of FINGERS) {
      const ch = c[f.key];
      for (const b of [...ch.bones, ...(ch.tip ? [ch.tip] : [])]) restBone.set(b, { p: wp(b), q: b.getWorldQuaternion(new THREE.Quaternion()) });
    }
    const restLat = new THREE.Vector3().setFromMatrixColumn(restFrame, 0).normalize(); // pinky -> index
    // Palm side: for a right hand the palm faces +z of the palm frame (x to the index, y to the
    // middle finger), for a left hand -z. The model is posed as its own hand (mirrored after).
    const ownHand = modelSide || this.handedness();
    const palmSign = ownHand === 'left' ? -1 : 1;
    // Every node's turn, in one fixed order (for recording and export).
    const animNodes = [];
    model.traverse((o) => animNodes.push(o));
    if (mirror) {
      outer.scale.x = -1;
      model.traverse((o) => { if (o.isMesh) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => (m.side = THREE.DoubleSide)); });
    }
    scene.add(outer);
    const inst = { outer, root, model, h, restLocal, restFrame, restPalm, handM, mirror, restHandQ, fore: restFore > 1e-6 ? fore : null, restElbow, restFore, restBone, restLat, palmSign, animNodes, cal: null };
    inst.restAngles = this.restAngles(inst);
    if (window.HMS_DEBUG) window.customDebug = { hand: h.hand.name, chains: Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v.bones.map((b) => b.name).concat(v.tip ? ['tip:' + v.tip.name] : [])])), restPalm, mirror, palmSign };
    outer.visible = false;
    return inst;
  }

  // The model's own bend (flex, side) at each middle / end finger joint at rest, and each
  // first bone's direction in the model's palm frame: what an open hand maps to.
  restAngles(inst) {
    const R3 = new THREE.Matrix3().setFromMatrix4(inst.restFrame).transpose();
    const out = { dir0: {}, ang: {} };
    for (const f of FINGERS) {
      const ch = inst.h.chains[f.key];
      const pts = [...ch.bones, ...(ch.tip ? [ch.tip] : [])].map((b) => inst.restBone.get(b).p);
      const dirs = pts.slice(1).map((p, i) => p.clone().sub(pts[i]).normalize());
      out.dir0[f.key] = dirs[0] ? dirs[0].clone().applyMatrix3(R3) : null;
      out.ang[f.key] = dirs.map((d, k) => (k === 0 ? null : bendOf(dirs[k - 1], d, inst.restLat, inst.palmSign)));
    }
    return out;
  }

  // "편 손 캘리브레이션": one frame of the user's open hand (MediaPipe 3D points, three.js
  // axes, already as the model's side) is the model's rest pose. Stored per bone:
  // first bones: the turn (in the palm frame) from the seen direction to the model's;
  // middle / end joints: flex and side angle offsets (model rest - seen).
  calibrate(inst, Wd) {
    const F = frameOf(Wd[0], Wd[5], Wd[9], Wd[17]);
    const Fi = new THREE.Matrix3().setFromMatrix4(F).transpose();
    const lat = new THREE.Vector3().setFromMatrixColumn(F, 0);
    const cal = { q0: {}, off: {} };
    for (const f of FINGERS) {
      const ch = inst.h.chains[f.key]; const off = 3 - ch.bones.length;
      const dirs = [0, 1, 2].map((k) => Wd[f.mp[k + 1]].clone().sub(Wd[f.mp[k]]).normalize());
      const seen0 = dirs[off].clone().applyMatrix3(Fi);
      const model0 = inst.restAngles.dir0[f.key];
      cal.q0[f.key] = model0 ? new THREE.Quaternion().setFromUnitVectors(seen0, model0) : new THREE.Quaternion();
      cal.off[f.key] = ch.bones.map((_, k) => {
        const m = inst.restAngles.ang[f.key][k];
        if (k === 0 || !m || f.key === 'thumb') return null;
        const a = seenBend(dirs[k + off - 1], dirs[k + off], lat, inst.palmSign);
        return { flex: m.flex - a.flex, side: m.side - a.side };
      });
    }
    inst.cal = cal;
  }

  // P: the 21 points on their picture rays (where the hand is); Wd: MediaPipe's 3D (world)
  // points (how the hand is turned and bent), both in three.js axes; Wd may be null (then P).
  // Only directions are used: every bone keeps its model length, and no bone moves except the
  // model root (the wrist onto the seen wrist). Parent first: hand -> first finger bones
  // (palm frame) -> middle -> end. Each bone turns the least it must (no twist of its own).
  // elbow: the body pose's elbow for this hand, { ray: unit Vector3 from the camera
  // through the seen elbow, farther: whether the elbow is farther from the camera
  // than the wrist }, or null (no body pose: only the hand is placed).
  pose(inst, P, elbow, Wd) {
    const { outer, root, h, restLocal, restFrame, restPalm, mirror } = inst;
    if (!Wd) Wd = P;
    if (mirror) { P = P.map((p) => new THREE.Vector3(-p.x, p.y, p.z)); Wd = Wd.map((p) => new THREE.Vector3(-p.x, p.y, p.z)); } // pose the model's own side, then flip
    if (mirror && elbow) elbow = { ...elbow, ray: new THREE.Vector3(-elbow.ray.x, elbow.ray.y, elbow.ray.z) };
    if (inst.calW) { // open hand from "편 손 캘리브레이션" (raw: mirror it like the points)
      this.calibrate(inst, mirror ? inst.calW.map((p) => new THREE.Vector3(-p.x, p.y, p.z)) : inst.calW);
      inst.calW = null;
    }
    for (const [o, q] of restLocal) o.quaternion.copy(q);
    // Root: hand bone onto the wrist; palm turned like the seen palm: wrist -> middle root
    // (forward) and index root -> pinky root (side), from the 3D points; drawn at the seen
    // hand's size (one even scale for the whole model: its proportions stay).
    const palmW = Wd[9].distanceTo(Wd[0]);
    const s = (palmW > 0.03 && palmW < 0.2 ? palmW : P[9].distanceTo(P[0])) / Math.max(restPalm, 1e-6);
    const F = frameOf(Wd[0], Wd[5], Wd[9], Wd[17]);
    const W = new THREE.Matrix4().copy(F).multiply(restFrame.clone().transpose());
    const handRestPos = new THREE.Vector3().setFromMatrixPosition(inst.handM);
    const M = new THREE.Matrix4().makeTranslation(P[0].x, P[0].y, P[0].z)
      .multiply(W).multiply(new THREE.Matrix4().makeScale(s, s, s))
      .multiply(new THREE.Matrix4().makeTranslation(-handRestPos.x, -handRestPos.y, -handRestPos.z));
    root.matrixAutoUpdate = false;
    root.matrix.copy(M);
    outer.updateMatrixWorld(true);
    inst.elbowUsed = false;
    const Wq = new THREE.Quaternion().setFromRotationMatrix(W);
    if (elbow && inst.fore) {
      // The elbow on its picture ray, one (model) forearm away from the wrist.
      const L = s * inst.restFore;
      const r = elbow.ray.clone().normalize();
      const b = r.dot(P[0]);
      const disc = b * b - P[0].lengthSq() + L * L;
      const near = b - Math.sqrt(Math.max(disc, 0)); const far = b + Math.sqrt(Math.max(disc, 0));
      const t = disc < 0 ? b : elbow.farther || near < 0.05 ? far : near;
      if (t > 0.02) {
        const E = r.multiplyScalar(t);
        const was = handRestPos.clone().sub(inst.restElbow).normalize().applyQuaternion(Wq);
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
    // Fingers, in outer's own space (the mirrored one for the other hand).
    const outerInv = outer.matrixWorld.clone().invert();
    const tmpM = new THREE.Matrix4(); const tmpS = new THREE.Vector3(); const tmpP = new THREE.Vector3();
    const at = (o, v) => { o.updateWorldMatrix(true, false); return v.setFromMatrixPosition(tmpM.multiplyMatrices(outerInv, o.matrixWorld)); };
    const turnOf = (o, qOut) => { o.updateWorldMatrix(true, false); tmpM.multiplyMatrices(outerInv, o.matrixWorld).decompose(tmpP, qOut, tmpS); return qOut; };
    const q = new THREE.Quaternion(); const pq = new THREE.Quaternion();
    const pos = new THREE.Vector3(); const nextPos = new THREE.Vector3(); const par = new THREE.Vector3();
    const F3 = new THREE.Matrix3().setFromMatrix4(F); const Fi = F3.clone().transpose();
    const latSeen = new THREE.Vector3().setFromMatrixColumn(F, 0);
    const ps = inst.palmSign;
    const cal = inst.cal;
    const D2R = Math.PI / 180;
    for (const f of FINGERS) {
      const ch = h.chains[f.key];
      const list = ch.bones;
      const off = 3 - list.length; // two bones only: they are the outer ones
      const seen = [0, 1, 2].map((k) => Wd[f.mp[k + 1]].clone().sub(Wd[f.mp[k]]).normalize());
      list.forEach((bone, k) => {
        at(bone, pos);
        const child = list[k + 1] || ch.tip;
        const was = child ? at(child, nextPos).sub(pos) : pos.clone().sub(at(bone.parent, par));
        let target;
        if (k === 0) {
          // First bone: the seen direction in the palm frame (calibration turn applied), back
          // in the seen palm; knuckles of the four fingers: 30 deg back .. 100 deg toward the palm.
          const d = seen[off].clone().applyMatrix3(Fi);
          if (cal) d.applyQuaternion(cal.q0[f.key]);
          if (f.key !== 'thumb') {
            const n = ps * d.z; const r = Math.hypot(d.y, n);
            const ang = Math.min(100 * D2R, Math.max(-30 * D2R, Math.atan2(n, d.y)));
            d.y = r * Math.cos(ang); d.z = ps * r * Math.sin(ang);
          }
          target = d.applyMatrix3(F3);
        } else if (f.key !== 'thumb') {
          // Middle / end joints: the seen bend at this joint (flex about the knuckle line, a
          // little sideways), applied to the model's own bone before: no twist, never bent back.
          const a = seenBend(seen[k + off - 1], seen[k + off], latSeen, ps);
          const o = cal && cal.off[f.key][k];
          let flex = a.flex + (o ? o.flex : 0);
          let side = a.side + (o ? o.side : 0);
          flex = Math.min(115 * D2R, Math.max(0, flex));
          side = Math.min(SIDE_RAD, Math.max(-SIDE_RAD, side));
          const pBone = list[k - 1];
          const pd = pos.clone().sub(at(pBone, par)).normalize();
          turnOf(pBone, pq);
          const axis = inst.restLat.clone().applyQuaternion(inst.restBone.get(pBone).q.clone().invert()).applyQuaternion(pq);
          axis.addScaledVector(pd, -axis.dot(pd)).normalize();
          target = pd.clone().applyAxisAngle(axis.clone().multiplyScalar(ps), flex);
          target.multiplyScalar(Math.cos(side)).addScaledVector(axis, Math.sin(side));
        } else {
          target = seen[k + off].clone(); // thumb: as seen
        }
        if (was.lengthSq() < 1e-12 || target.lengthSq() < 1e-12) return;
        const turn = new THREE.Quaternion().setFromUnitVectors(was.normalize(), target.normalize());
        // turn in outer space -> the bone's local turn: parent^-1 * turn * parent, applied before its own turn
        turnOf(bone.parent, pq);
        q.copy(pq).invert().multiply(turn).multiply(pq);
        bone.quaternion.premultiply(q);
        bone.updateWorldMatrix(false, true);
      });
    }
    if (window.HMS_DEBUG) {
      // Picture distance of each model joint to its MediaPipe point, % of the seen palm.
      const pr = (v) => new THREE.Vector2(v.x / -v.z, v.y / -v.z);
      const palmPx = pr(P[0]).distanceTo(pr(P[9])) || 1;
      const ds = [];
      for (const f of FINGERS) {
        const ch = h.chains[f.key]; const off = 3 - ch.bones.length;
        ch.bones.forEach((b, k) => ds.push(pr(at(b, pos)).distanceTo(pr(P[f.mp[k + off]])) / palmPx));
        if (ch.tip) ds.push(pr(at(ch.tip, pos)).distanceTo(pr(P[f.mp[3]])) / palmPx);
      }
      inst.err = { all: ds.map((d) => Math.round(d * 100)), mean: +(100 * ds.reduce((a, b) => a + b, 0) / ds.length).toFixed(1), max: Math.round(100 * Math.max(...ds)) };
      // Bends (deg) of the model's middle / end joints, for checks.
      inst.bends = Object.fromEntries(FINGERS.map((f) => {
        const ch = h.chains[f.key];
        const pts = [...ch.bones, ...(ch.tip ? [ch.tip] : [])].map((b) => at(b, new THREE.Vector3()));
        const dirs = pts.slice(1).map((p, i) => p.clone().sub(pts[i]).normalize());
        return [f.key, dirs.slice(1).map((d, i) => Math.round(Math.acos(Math.min(1, Math.max(-1, d.dot(dirs[i])))) / D2R))];
      }));
    }
    outer.visible = true;
  }

  // This frame's pose for export: root (no scale) and every node's local turn.
  snapshot(inst, t) {
    const pos = new THREE.Vector3(); const quat = new THREE.Quaternion(); const scl = new THREE.Vector3();
    inst.root.matrix.decompose(pos, quat, scl);
    // Unscaled root that keeps the hand bone where it is: hand = rootPos + quat * handRest.
    const handNow = new THREE.Vector3().setFromMatrixPosition(inst.handM).multiplyScalar(scl.x).applyQuaternion(quat).add(pos);
    const rootPos = handNow.clone().sub(new THREE.Vector3().setFromMatrixPosition(inst.handM).applyQuaternion(quat));
    return { t, p: rootPos.toArray(), q: quat.toArray(), nodes: inst.animNodes.map((o) => o.quaternion.toArray()) };
  }
}

// Bend at a joint between bone directions a (before) and b (after): flex about the knuckle
// line lat (made square to a), positive toward the palm; side = angle out of that plane.
function bendOf(a, b, lat, palmSign) {
  const ax = lat.clone().addScaledVector(a, -lat.dot(a)).normalize();
  const side = Math.asin(Math.max(-1, Math.min(1, b.dot(ax))));
  const inPlane = b.clone().addScaledVector(ax, -b.dot(ax));
  if (inPlane.lengthSq() < 1e-12) return { flex: 0, side };
  inPlane.normalize();
  const flex = Math.atan2(new THREE.Vector3().crossVectors(a, inPlane).dot(ax) * palmSign, a.dot(inPlane));
  return { flex, side };
}

// The same for MediaPipe's bones, whose knuckle line is often read twisted (depth): a real
// middle / end joint bends sideways only a little, so all of the bend beyond SIDE_RAD is taken
// as flex (the bend's size is kept); only a clearly backward bend (past 10 deg) counts as back.
function seenBend(a, b, lat, palmSign) {
  const raw = bendOf(a, b, lat, palmSign);
  const total = Math.acos(Math.max(-1, Math.min(1, a.dot(b))));
  const side = Math.max(-SIDE_RAD, Math.min(SIDE_RAD, raw.side));
  if (raw.flex < -10 * Math.PI / 180) return { flex: raw.flex, side };
  return { flex: Math.sqrt(Math.max(0, total * total - side * side)), side };
}

// GLB of the model: 'anim' = the recorded turns as an animation (bone turns only; the root
// moves and turns; lengths and scale as modelled), 'pose' = one recorded frame as a still
// pose at the origin. frames: snapshots of one instance.
export async function exportGlb(template, inst, frames, mode, index) {
  const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');
  const model = SkeletonUtils.clone(template);
  const wrap = new THREE.Group(); wrap.name = 'HandMotionRoot'; wrap.add(model);
  // A clone has the same structure: nodes pair with the instance's by traversal order.
  const nodes = [];
  model.traverse((o) => nodes.push(o));
  const pairs = inst.animNodes.map((o, i) => [i, nodes[i]]).filter(([i, n]) => n && n.name === inst.animNodes[i].name);
  let clip = null;
  if (mode === 'pose') {
    const fr = frames[Math.max(0, Math.min(frames.length - 1, index))];
    for (const [i, n] of pairs) n.quaternion.fromArray(fr.nodes[i]);
    model.name = `${model.name || 'model'}_pose`;
  } else {
    const times = frames.map((f) => f.t - frames[0].t);
    const tracks = [
      new THREE.VectorKeyframeTrack(`${wrap.uuid}.position`, times, frames.flatMap((f) => f.p)),
      new THREE.QuaternionKeyframeTrack(`${wrap.uuid}.quaternion`, times, frames.flatMap((f) => f.q)),
    ];
    for (const [i, n] of pairs) {
      const vals = frames.flatMap((f) => f.nodes[i]);
      let moved = false;
      for (let j = 4; j < vals.length && !moved; j++) if (Math.abs(vals[j] - vals[j % 4]) > 1e-5) moved = true;
      if (moved) tracks.push(new THREE.QuaternionKeyframeTrack(`${n.uuid}.quaternion`, times, vals));
    }
    clip = new THREE.AnimationClip('hand_motion', -1, tracks);
  }
  return new Promise((ok, no) => new GLTFExporter().parse(wrap, ok, no, { binary: true, animations: clip ? [clip] : [] }));
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
