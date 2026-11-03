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
const BACK_MAX = THREE.MathUtils.degToRad(35);
const SIDE_RAD = THREE.MathUtils.degToRad(15); // most a middle / end finger joint bends sideways (was 20)
const TOUCH_IN = 0.2; const TOUCH_OUT = 0.28; const TOUCH_EASE = 0.25; const TOUCH_ITERS = 12; const TOUCH_STEP = THREE.MathUtils.degToRad(40);
const DIP_RATIO = 2 / 3; // end joint bend / middle joint bend (tendon coupling)
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

// A hand from the user's own point marks ('리깅 잡기'): node indices in traverse order.
function handFromMap(model, map) {
  const nodes = []; model.traverse((o) => nodes.push(o));
  const chains = {};
  for (const f of FINGERS) { const c = map.chains[f.key]; chains[f.key] = { bones: c.bones.map((i) => nodes[i]), tip: c.tip != null ? nodes[c.tip] : null, extra: [] }; }
  return { side: map.side, hand: nodes[map.hand], chains };
}

export class CustomHand {
  constructor(root, name, rigMap = null) {
    this.name = name;
    this.template = root;
    this.rigMap = rigMap;
    const bones = boneList(root);
    if (rigMap) {
      this.found = { [rigMap.side === 'left' ? 'left' : 'right']: rigMap.side === 'left' ? 'left' : 'right' };
      this.choice = rigMap.side === 'left' ? 'left' : 'right';
    }
    const sides = new Set(bones.map((b) => sideOf(b.name)).filter(Boolean));
    if (!rigMap) this.found = {};
    if (!rigMap) for (const side of ['left', 'right']) if (sides.has(side)) this.found[side] = findHand(bones, side) && side;
    if (!rigMap && !this.found.left && !this.found.right) {
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
    if (!rigMap) this.choice = 'auto';
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
    const h = this.rigMap ? handFromMap(model, this.rigMap) : findHand(boneList(model), modelSide);
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
    const restPos = new Map();
    for (const b of restBone.keys()) restPos.set(b, b.position.clone());
    const restHandPos = wp(h.hand);
    // Finger roots: their parents' rest matrices (to move a root inside its parent).
    const rootParentInv = new Map();
    for (const f of FINGERS) { const b = c[f.key].bones[0]; rootParentInv.set(b, b.parent.matrixWorld.clone().invert()); }
    // Each instance stretches its own copy of the skin (fitLengths).
    const skins = [];
    model.traverse((o) => {
      if (!o.isSkinnedMesh) return;
      o.geometry = o.geometry.clone();
      skins.push({ mesh: o, orig: o.geometry.attributes.position.array.slice(), inv0: o.skeleton.boneInverses.map((m) => m.clone()), meshM: o.matrixWorld.clone() });
    });
    // Model finger bone lengths (bone -> next joint), in model palms.
    const lengths = {};
    for (const f of FINGERS) {
      const ch = c[f.key];
      lengths[f.key] = ch.bones.map((b, k) => { const n = ch.bones[k + 1] || ch.tip; return n ? wp(n).distanceTo(wp(b)) / restPalm : 0; });
    }
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
    const inst = { outer, root, model, h, restLocal, restFrame, restPalm, handM, mirror, restHandQ, fore: restFore > 1e-6 ? fore : null, restElbow, restFore, restBone, restLat, palmSign, animNodes, cal: null, restPos, restHandPos, rootParentInv, skins, lengths, restFrame0: restFrame.clone(), fitted: null };
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
    inst.calSrc = Wd;
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

  fitLengths(inst, user) {
    const out = {};
    const segs = new Map();
    // Knuckles: each finger root (and the thumb base) where the user's is, in the model's palm
    // frame at the model's palm size. The model's own palm frame is kept (wrist, middle root).
    const R0 = inst.restFrame0;
    const ex = new THREE.Vector3().setFromMatrixColumn(R0, 0); const ey = new THREE.Vector3().setFromMatrixColumn(R0, 1); const ez = new THREE.Vector3().setFromMatrixColumn(R0, 2);
    const rootShift = {};
    for (const f of FINGERS) {
      const ch = inst.h.chains[f.key];
      const k = user && user.knuckles && user.knuckles[f.key];
      const b = ch.bones[0];
      const was = inst.restBone.get(b).p;
      let s = new THREE.Vector3();
      if (k && ch.bones.length === 3 && f.key !== 'middle') {
        const zk = inst.mirror ? -k[2] : k[2];
        const target = inst.restHandPos.clone().addScaledVector(ex, k[0] * inst.restPalm).addScaledVector(ey, k[1] * inst.restPalm).addScaledVector(ez, zk * inst.restPalm);
        s = target.sub(was);
        if (s.length() > (inst.wide ? 1 : 0.6) * inst.restPalm) s.setLength((inst.wide ? 1 : 0.6) * inst.restPalm); // never wild
      }
      rootShift[f.key] = s;
      b.position.copy(was.clone().add(s).applyMatrix4(inst.rootParentInv.get(b)));
    }
    for (const f of FINGERS) {
      const ch = inst.h.chains[f.key];
      const off = 3 - ch.bones.length;
      const shift = rootShift[f.key].clone();
      out[f.key] = [];
      ch.bones.forEach((bone, k) => {
        const next = ch.bones[k + 1] || ch.tip;
        const A = inst.restBone.get(bone).p;
        const m = inst.lengths[f.key][k];
        const t = user && user[f.key] ? user[f.key][k + off] : 0;
        const q = next && m > 1e-6 && t > 1e-6 ? Math.min(inst.wide ? 3 : 1.6, Math.max(inst.wide ? 0.25 : 0.5, t / m)) : 1;
        let dir = null; let len = 0;
        if (next) {
          dir = inst.restBone.get(next).p.clone().sub(A); len = dir.length(); dir.normalize();
          next.position.copy(inst.restPos.get(next)).multiplyScalar(q);
        }
        segs.set(bone, { A, dir, len, q, shift: shift.clone() });
        if (dir) shift.addScaledVector(dir, len * (q - 1));
        out[f.key].push(+q.toFixed(2));
      });
      if (ch.tip) segs.set(ch.tip, { A: inst.restBone.get(ch.tip).p, dir: null, len: 0, q: 1, shift: shift.clone() });
    }
    const v = new THREE.Vector3(); const d = new THREE.Vector3(); const rel = new THREE.Vector3();
    for (const sk of inst.skins) {
      const g = sk.mesh.geometry;
      const pos = g.attributes.position; const si = g.attributes.skinIndex; const sw = g.attributes.skinWeight;
      const bones = sk.mesh.skeleton.bones;
      const segOf = bones.map((b) => segs.get(b) || null);
      const meshInv = sk.meshM.clone().invert();
      for (let i = 0; i < pos.count; i++) {
        v.set(sk.orig[i * 3], sk.orig[i * 3 + 1], sk.orig[i * 3 + 2]).applyMatrix4(sk.meshM);
        d.set(0, 0, 0);
        for (let j = 0; j < 4; j++) {
          const w = sw.getComponent(i, j); if (!w) continue;
          const sg = segOf[si.getComponent(i, j)]; if (!sg) continue;
          d.addScaledVector(sg.shift, w);
          if (sg.dir) {
            const along = Math.min(Math.max(rel.copy(v).sub(sg.A).dot(sg.dir), 0), sg.len);
            d.addScaledVector(sg.dir, w * along * (sg.q - 1));
          }
        }
        v.add(d).applyMatrix4(meshInv);
        pos.setXYZ(i, v.x, v.y, v.z);
      }
      pos.needsUpdate = true;
      g.computeBoundingSphere();
      // Bones that moved: bind them where they now rest.
      bones.forEach((b, i) => {
        const sg = segOf[i];
        const m = sk.inv0[i].clone();
        if (sg) m.multiply(new THREE.Matrix4().makeTranslation(-sg.shift.x, -sg.shift.y, -sg.shift.z));
        sk.mesh.skeleton.boneInverses[i].copy(m);
      });
    }
    // The palm frame the pose uses: from the knuckles where they now are.
    const np = (f) => inst.restBone.get(inst.h.chains[f].bones[0]).p.clone().add(rootShift[f]);
    inst.restFrame = frameOf(inst.restHandPos, np('index'), np('middle'), np('pinky'));
    inst.restLat = new THREE.Vector3().setFromMatrixColumn(inst.restFrame, 0).normalize();
    out.knuckleMove = Object.fromEntries(Object.entries(rootShift).map(([k, v]) => [k, +(v.length() / inst.restPalm).toFixed(3)]));
    inst.restAngles = this.restAngles(inst); // model directions in the (new) palm frame
    if (inst.calSrc) this.calibrate(inst, inst.calSrc);
    inst.fitted = out;
    return out;
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
    let E = null;
    if (elbow && inst.fore) {
      // The elbow on its picture ray, one (model) forearm away from the wrist.
      const L = s * inst.restFore;
      const r = elbow.ray.clone().normalize();
      const b = r.dot(P[0]);
      const disc = b * b - P[0].lengthSq() + L * L;
      const near = b - Math.sqrt(Math.max(disc, 0)); const far = b + Math.sqrt(Math.max(disc, 0));
      const t = disc < 0 ? b : elbow.farther || near < 0.05 ? far : near;
      if (t > 0.02) E = r.multiplyScalar(t);
    } else if (inst.fore && !window.HMS_NOARM) {
      // No body pose: a first-person arm. The forearm reaches from the wrist toward a shoulder
      // below and beside the camera (two-bone reach, elbow down and out), and the wrist bends
      // at most WRIST_MAX from the forearm line, so the arm no longer turns with every wrist turn.
      E = firstPersonElbow(P[0], new THREE.Vector3().setFromMatrixColumn(F, 1), s * inst.restFore, inst.palmSign);
    }
    if (window.HMS_DEBUG && inst.fore) { inst.root.updateMatrixWorld(true); const fw = new THREE.Vector3(); inst.fore.getWorldPosition(fw); window.lastFore = P[0].clone().sub(fw).normalize().toArray(); }
    {
      if (E) {
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
        if (window.HMS_DEBUG) window.lastFore = P[0].clone().sub(E).normalize().toArray();
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
    // On screen with the user's skeleton: finger roots right on their points this frame.
    if (inst.fitted && !window.HMS_NOROOT) {
      for (const f of FINGERS) {
        const b = h.chains[f.key].bones[0];
        const off = 3 - h.chains[f.key].bones.length;
        b.parent.updateWorldMatrix(true, false);
        const toLocal = tmpM.multiplyMatrices(outerInv, b.parent.matrixWorld).invert();
        b.position.copy(P[f.mp[off]]).applyMatrix4(toLocal);
        b.updateWorldMatrix(false, true);
      }
    }
    const ps = inst.palmSign;
    const cal = inst.cal;
    if (!inst.prevQ) { inst.prevQ = new Map(); inst.refLen = {}; }
    const D2R = Math.PI / 180;
    for (const f of FINGERS) {
      const ch = h.chains[f.key];
      const list = ch.bones;
      const off = 3 - list.length; // two bones only: they are the outer ones
      const seen = [0, 1, 2].map((k) => Wd[f.mp[k + 1]].clone().sub(Wd[f.mp[k]]).normalize());
      let pipFlex = 0;
      list.forEach((bone, k) => {
        at(bone, pos);
        const child = list[k + 1] || ch.tip;
        const was = child ? at(child, nextPos).sub(pos) : pos.clone().sub(at(bone.parent, par));
        let target;
        if (window.HMS_PURE && (window.HMS_PURE === 3 || (window.HMS_PURE === 1) === (k === 0))) {
          // 'MediaPipe as is': the bone aimed at MediaPipe's own direction (1 = knuckle bone only,
          // 2 = other bones only, 3 = all). User rule: fingers never bend toward the back of the hand:
          // a backward bend is taken as forward (MediaPipe's depth read flipped, PUREBACK 1, default)
          // or held straight (PUREBACK 2); 0 = no limit.
          target = seen[k + off].clone();
          const mode = window.HMS_PUREBACK == null ? 2 : window.HMS_PUREBACK;
          // user: never quite straight either - a slight bend (MIN_FLEX) keeps which way is front fixed
          const minF = (window.HMS_MINFLEX == null ? MIN_FLEX_DEG : window.HMS_MINFLEX) * D2R;
          if (f.key !== 'thumb' && mode) {
            if (k === 0) {
              const d = target.clone().applyMatrix3(Fi);
              const n = ps * d.z; const r = Math.hypot(d.y, n); const a0 = Math.atan2(n, d.y);
              if (a0 < minF) { const ang = mode === 1 && a0 < 0 ? Math.min(-a0, 100 * D2R) : minF; d.y = r * Math.cos(ang); d.z = ps * r * Math.sin(ang); target = d.applyMatrix3(F3); }
            } else {
              const pBone = list[k - 1];
              const pd = pos.clone().sub(at(pBone, par)).normalize();
              turnOf(pBone, pq);
              const axis = inst.restLat.clone().applyQuaternion(inst.restBone.get(pBone).q.clone().invert()).applyQuaternion(pq);
              axis.addScaledVector(pd, -axis.dot(pd)).normalize();
              const bnd = bendOf(pd, target.clone().normalize(), axis, ps);
              if (bnd.flex < minF) {
                const flex = mode === 1 && bnd.flex < 0 ? Math.min(-bnd.flex, 115 * D2R) : minF;
                target = pd.clone().applyAxisAngle(axis.clone().multiplyScalar(ps), flex);
                target.multiplyScalar(Math.cos(bnd.side)).addScaledVector(axis, Math.sin(bnd.side));
              }
            }
          }
        }
        else if (k === 0) {
          // First bone: the seen direction in the palm frame (calibration turn applied), back
          // in the seen palm; knuckles of the four fingers: straight .. 100 deg toward the palm (never toward the back).
          const d = seen[off].clone().applyMatrix3(Fi);
          if (cal) d.applyQuaternion(cal.q0[f.key]);
          if (f.key !== 'thumb') {
            const n = ps * d.z; const r = Math.hypot(d.y, n);
            let a0 = Math.atan2(n, d.y);
            if (a0 < -BACK_MAX - 20 * D2R && !window.HMS_NOBACKFIX) a0 = -a0; // knuckle bent far back: read flipped
            const ang = Math.min(100 * D2R, Math.max((window.HMS_MCPBACK ? -30 : 0) * D2R, a0)); // never past the back of the hand
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
          const sideLim = window.HMS_SIDE != null ? window.HMS_SIDE * D2R : SIDE_RAD;
          side = Math.min(sideLim, Math.max(-sideLim, side));
          // End joint moves with the middle one (one tendon drives both): about 2/3 of its bend,
          // straight in line; MediaPipe's own end-joint reading is mostly depth noise.
          if (k === 2 && off === 0 && !window.HMS_NOCOUPLE) {
            flex = DIP_RATIO * pipFlex;
            side = 0;
          }
          if (k === 1) pipFlex = flex;
          const pBone = list[k - 1];
          const pd = pos.clone().sub(at(pBone, par)).normalize();
          turnOf(pBone, pq);
          const axis = inst.restLat.clone().applyQuaternion(inst.restBone.get(pBone).q.clone().invert()).applyQuaternion(pq);
          axis.addScaledVector(pd, -axis.dot(pd)).normalize();
          target = pd.clone().applyAxisAngle(axis.clone().multiplyScalar(ps), flex);
          target.multiplyScalar(Math.cos(side)).addScaledVector(axis, Math.sin(side));
        } else {
          // Thumb: as seen, but within a cone of the bone before (MCP 75, IP 90 deg; the early
          // web solver's limits): MediaPipe sometimes folds the thumb back on itself.
          target = seen[k + off].clone();
          if (!window.HMS_NOTHUMBLIM) {
            const pd = pos.clone().sub(at(list[k - 1], par)).normalize();
            const lim = (k + off === 1 ? 75 : 90) * D2R;
            const ang = pd.angleTo(target);
            if (ang > lim) {
              const ax = new THREE.Vector3().crossVectors(pd, target);
              if (ax.lengthSq() > 1e-12) target = pd.clone().applyAxisAngle(ax.normalize(), lim);
            }
          }
        }
        if (was.lengthSq() < 1e-12 || target.lengthSq() < 1e-12) return;
        const turn = new THREE.Quaternion().setFromUnitVectors(was.normalize(), target.normalize());
        // turn in outer space -> the bone's local turn: parent^-1 * turn * parent, applied before its own turn
        turnOf(bone.parent, pq);
        q.copy(pq).invert().multiply(turn).multiply(pq);
        bone.quaternion.premultiply(q);
        // Live: a bone whose seen length suddenly changes is likely misread (hidden, foreshortened)
        // and moves slower (early web solver: 0.35 + 0.65 * confidence per frame).
        if (inst.live && !window.HMS_NOCONF) {
          const key = `${f.key}${k}`;
          const len = Wd[f.mp[k + off + 1]].distanceTo(Wd[f.mp[k + off]]);
          const ref = inst.refLen[key];
          let c = 1;
          if (ref === undefined) inst.refLen[key] = len;
          else {
            c = Math.min(1, Math.max(0.15, 1 - Math.abs(len / Math.max(ref, 1e-4) - 1) * 2));
            if (c > 0.6) inst.refLen[key] = ref * 0.97 + len * 0.03;
          }
          const prev = inst.prevQ.get(bone);
          if (prev && inst.fresh) bone.quaternion.copy(prev.slerp(bone.quaternion, 0.35 + 0.65 * c));
          inst.prevQ.set(bone, bone.quaternion.clone());
        }
        bone.updateWorldMatrix(false, true);
      });
    }
    if (!window.HMS_NOTOUCH) this.touch(inst, Wd, palmW > 0.03 && palmW < 0.2 ? palmW : null, s, at, turnOf);
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

  // Fingertip contact (user: a model hand of other proportions must still touch where the real
  // hand touches). The joint turns are copied, so a model with a shorter thumb would miss the
  // finger (or go through it). When MediaPipe's thumb tip is near another fingertip (enter
  // TOUCH_IN, leave TOUCH_OUT palms: two thresholds so it does not flicker), the model's thumb
  // (only the thumb, 3 bones, CCD) is turned so its tip sits where MediaPipe has it relative to
  // that fingertip (offset scaled to the model palm). Eased in and out over a few frames.
  touch(inst, Wd, palmW, s, at, turnOf) {
    const th = inst.h.chains.thumb;
    if (!palmW || !th.tip || th.bones.length < 2) { inst.touchW = 0; return; }
    const tipOf = { index: 8, middle: 12, ring: 16, pinky: 20 };
    let best = null; let bd = Infinity;
    for (const [k, mi] of Object.entries(tipOf)) { const d = Wd[4].distanceTo(Wd[mi]) / palmW; if (d < bd && inst.h.chains[k].tip) { bd = d; best = k; } }
    const was = inst.touchOn;
    const on = best && (bd < TOUCH_IN || (was === best && bd < TOUCH_OUT));
    if (on && was && was !== best && bd > TOUCH_IN) { /* keep the old finger while it still holds */ }
    inst.touchOn = on ? best : (was && Wd[4].distanceTo(Wd[tipOf[was]]) / palmW < TOUCH_OUT ? was : null);
    const w0 = inst.touchW || 0;
    inst.touchW = inst.touchOn ? Math.min(1, w0 + TOUCH_EASE) : Math.max(0, w0 - TOUCH_EASE);
    const key = inst.touchOn || inst.touchLast;
    if (inst.touchOn) inst.touchLast = inst.touchOn;
    if (!key || inst.touchW <= 0) return;
    const mi = tipOf[key];
    const k = (s * inst.restPalm) / palmW; // MediaPipe metres -> model (outer) units
    const tip = new THREE.Vector3(); const fingerTip = at(inst.h.chains[key].tip, new THREE.Vector3());
    const goal = fingerTip.clone().addScaledVector(Wd[4].clone().sub(Wd[mi]), k);
    at(th.tip, tip);
    const before = tip.distanceTo(goal); const gap0 = tip.distanceTo(fingerTip);
    const target = tip.clone().lerp(goal, inst.touchW);
    const p = new THREE.Vector3(); const pq = new THREE.Quaternion(); const q = new THREE.Quaternion();
    for (let it = 0; it < TOUCH_ITERS; it++) {
      for (let j = th.bones.length - 1; j >= 0; j--) {
        const b = th.bones[j];
        at(b, p); at(th.tip, tip);
        const a = tip.clone().sub(p); const c = target.clone().sub(p);
        if (a.lengthSq() < 1e-12 || c.lengthSq() < 1e-12) continue;
        a.normalize(); c.normalize();
        let ang = Math.acos(Math.min(1, Math.max(-1, a.dot(c))));
        if (ang < 1e-4) continue;
        ang = Math.min(ang, TOUCH_STEP);
        const ax = new THREE.Vector3().crossVectors(a, c); if (ax.lengthSq() < 1e-12) continue;
        const turn = new THREE.Quaternion().setFromAxisAngle(ax.normalize(), ang);
        turnOf(b.parent, pq);
        q.copy(pq).invert().multiply(turn).multiply(pq);
        b.quaternion.premultiply(q);
        b.updateWorldMatrix(false, true);
      }
    }
    at(th.tip, tip);
    if (window.HMS_TOUCHLOG) (window.touchLog = window.touchLog || []).push({ f: key, d: +bd.toFixed(3), w: inst.touchW, before: before / (s * inst.restPalm), gap0: gap0 / (s * inst.restPalm), mpPalmModel: palmW / (s * inst.restPalm), after: tip.distanceTo(goal) / (s * inst.restPalm) });
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

  // Back onto the instance (review playback of the corrected take): the inverse of snapshot,
  // keeping the instance's current scale.
  applySnapshot(inst, f) {
    const pos = new THREE.Vector3(); const quat = new THREE.Quaternion(); const scl = new THREE.Vector3();
    inst.root.matrix.decompose(pos, quat, scl);
    const q = new THREE.Quaternion().fromArray(f.q);
    const hr = new THREE.Vector3().setFromMatrixPosition(inst.handM).applyQuaternion(q);
    const p = new THREE.Vector3().fromArray(f.p).add(hr.clone().multiplyScalar(1 - scl.x));
    inst.root.matrix.compose(p, q, scl);
    inst.animNodes.forEach((o, i) => { if (f.nodes[i]) o.quaternion.fromArray(f.nodes[i]); });
    inst.outer.visible = true;
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
const MIN_FLEX_DEG = 5; // 'MediaPipe as is' fingers: each joint bent at least this much toward the palm
function seenBend(a, b, lat, palmSign) {
  const raw = bendOf(a, b, lat, palmSign);
  const total = Math.acos(Math.max(-1, Math.min(1, a.dot(b))));
  const side = Math.max(-SIDE_RAD, Math.min(SIDE_RAD, raw.side));
  // A real finger bends back 10..30 deg at most. Far past that it is MediaPipe's palm/back mix-up
  // (the knuckle line read flipped while the hand turns over): a strong forward bend.
  if (raw.flex < -BACK_MAX && !window.HMS_NOBACKFIX) return { flex: Math.sqrt(Math.max(0, total * total - side * side)), side };
  if (raw.flex < -10 * Math.PI / 180) return { flex: raw.flex, side };
  return { flex: Math.sqrt(Math.max(0, total * total - side * side)), side };
}

const POSE_WINDOW = 0.5; // s, still pose: median over this much either side
const SMOOTH_SIGMA = 0.12; // s, animation: Gaussian, forward and back (no lag)
const SPIKE_FRAMES = 2; // animation: per joint median over +-2 frames first (one-off MediaPipe misreads)

// Turns as [x,y,z,w]; all put on the same side as ref (q and -q are one turn).
function aligned(list, ref) { return list.map((q) => (q[0] * ref[0] + q[1] * ref[1] + q[2] * ref[2] + q[3] * ref[3] < 0 ? q.map((v) => -v) : q)); }
function norm4(q) { const n = Math.hypot(...q) || 1; return q.map((v) => v / n); }
function medianQuat(list, ref) {
  const a = aligned(list, ref);
  return norm4([0, 1, 2, 3].map((c) => { const v = a.map((q) => q[c]).sort((x, y) => x - y); return v[v.length >> 1]; }));
}
// Every joint's turn and the root place smoothed over time, looking both ways (no lag).
function medianFrames(frames, r) {
  if (frames.length < 2 * r + 1) return frames;
  const med = (list) => { const s = [...list].sort((a, b) => a - b); return s[s.length >> 1]; };
  return frames.map((f, i) => {
    const near = frames.slice(Math.max(0, i - r), i + r + 1);
    const m = (get, ref) => {
      const vs = near.map((g) => { const v = get(g); return ref.length === 4 && v[0] * ref[0] + v[1] * ref[1] + v[2] * ref[2] + v[3] * ref[3] < 0 ? v.map((x) => -x) : v; });
      const out = ref.map((_, c) => med(vs.map((v) => v[c])));
      return ref.length === 4 ? norm4(out) : out;
    };
    return { ...f, p: m((g) => g.p, f.p), q: m((g) => g.q, f.q), nodes: f.nodes.map((q, k) => m((g) => g.nodes[k], q)) };
  });
}

function smoothFrames(frames, sigma) {
  if (frames.length < 3) return frames;
  let lo = 0; let hi = 0;
  return frames.map((f) => {
    while (frames[lo].t < f.t - 4 * sigma) lo++;
    while (hi + 1 < frames.length && frames[hi + 1].t <= f.t + 4 * sigma) hi++;
    const near = frames.slice(lo, hi + 1);
    const ws = near.map((g) => Math.exp(-0.5 * ((g.t - f.t) / sigma) ** 2));
    const sum = ws.reduce((x, y) => x + y, 0);
    const avg = (get, ref) => {
      const out = new Array(ref.length).fill(0);
      near.forEach((g, j) => {
        let v = get(g);
        if (ref.length === 4 && v[0] * ref[0] + v[1] * ref[1] + v[2] * ref[2] + v[3] * ref[3] < 0) v = v.map((x) => -x);
        v.forEach((x, c) => (out[c] += (x * ws[j]) / sum));
      });
      return ref.length === 4 ? norm4(out) : out;
    };
    return { ...f, p: avg((g) => g.p, f.p), q: avg((g) => g.q, f.q), nodes: f.nodes.map((q, i) => avg((g) => g.nodes[i], q)) };
  });
}

// GLB of the model: 'anim' = the recorded turns as an animation (bone turns only; the root
// moves and turns; lengths and scale as modelled), 'pose' = one recorded frame as a still
// pose at the origin. frames: snapshots of one instance.
// The animation's own frames: one-off misreads out, then smoothed (what 'anim' saves).
export function smoothTake(frames) { return smoothFrames(medianFrames(frames, SPIKE_FRAMES), SMOOTH_SIGMA); }

export async function exportGlb(template, inst, frames, mode, index) { // eslint-disable-line no-param-reassign
  const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');
  const model = SkeletonUtils.clone(template);
  const wrap = new THREE.Group(); wrap.name = 'HandMotionRoot'; wrap.add(model);
  // A clone has the same structure: nodes pair with the instance's by traversal order.
  const nodes = [];
  model.traverse((o) => nodes.push(o));
  const pairs = inst.animNodes.map((o, i) => [i, nodes[i]]).filter(([i, n]) => n && n.name === inst.animNodes[i].name);
  const hidden = nodes.filter((o) => o.isMesh && !o.visible);
  hidden.forEach((o) => o.parent.remove(o)); // a hidden prop (bare hands) is not saved
  let clip = null;
  if (mode === 'pose') {
    // The pose held around the chosen frame: per joint, the median turn over +-POSE_WINDOW s
    // (one frame alone carries MediaPipe's frame noise).
    const mid = frames[Math.max(0, Math.min(frames.length - 1, index))];
    const win = frames.filter((f) => Math.abs(f.t - mid.t) <= POSE_WINDOW);
    for (const [i, n] of pairs) n.quaternion.fromArray(medianQuat(win.map((f) => f.nodes[i]), mid.nodes[i]));
    model.name = `${model.name || 'model'}_pose`;
  } else {
    frames = smoothTake(frames);
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

// "이 모델을 내 손 비율로 저장": the model itself rebuilt to the user's hand (finger bone lengths
// and knuckles from MediaPipe, as on screen), at rest, as a new rigged GLB. Its bones then match
// MediaPipe's, so rotations alone put it on the hand (screen = game). user: fitCal lengths of the
// seen side; seenSide: which hand they were measured on (a right hand's knuckles mirror for a
// left model).
export async function bakeFitted(custom, scene, seenSide, user) {
  const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');
  const own = custom.handedness();
  const inst = custom.instance(scene, own); // the model's own side: no mirror
  scene.remove(inst.outer);
  inst.wide = true; // made once, on purpose: the user's proportions in full
  const u = JSON.parse(JSON.stringify(user));
  if (seenSide !== own && u.knuckles) for (const k of Object.keys(u.knuckles)) u.knuckles[k][2] = -u.knuckles[k][2];
  const fit = custom.fitLengths(inst, u);
  for (const [o, q] of inst.restLocal) o.quaternion.copy(q);
  const model = inst.model;
  inst.root.remove(model);
  model.position.set(0, 0, 0); model.quaternion.identity(); model.scale.set(1, 1, 1);
  const wrap = new THREE.Group(); wrap.name = 'HandMotionFitted'; wrap.add(model);
  wrap.updateMatrixWorld(true);
  // Bind every skin where its bones now rest (the exact inverse of the new rest pose).
  model.traverse((o) => {
    if (!o.isSkinnedMesh) return;
    o.bindMatrix.copy(o.matrixWorld); o.bindMatrixInverse.copy(o.matrixWorld).invert();
    o.skeleton.calculateInverses();
  });
  const buf = await new Promise((ok, no) => new GLTFExporter().parse(wrap, ok, no, { binary: true }));
  return { buf, fit };
}

// First person: where the shoulder is (three.js camera space, m; x toward the hand's own side),
// upper arm length, and how far the wrist bends from the forearm line at most.
const SHOULDER = [0.18, -0.28, 0.05];
const UPPER_ARM = 0.29;
const WRIST_MAX = 65 * Math.PI / 180;
function firstPersonElbow(wrist, handDir, fore, palmSign) {
  const S = new THREE.Vector3(SHOULDER[0] * palmSign, SHOULDER[1], SHOULDER[2]);
  const toS = S.clone().sub(wrist); const D = toS.length(); const n = toS.clone().normalize();
  const a = D >= fore + UPPER_ARM ? fore : Math.max(-fore, Math.min(fore, (fore * fore - UPPER_ARM * UPPER_ARM + D * D) / (2 * D)));
  const h = Math.sqrt(Math.max(fore * fore - a * a, 0));
  const pole = new THREE.Vector3(0.5 * palmSign, -1, 0); pole.addScaledVector(n, -pole.dot(n)).normalize();
  const E = wrist.clone().addScaledVector(n, a).addScaledVector(pole, h);
  // Wrist range: the hand line (wrist -> middle root) within WRIST_MAX of the forearm line.
  const out = wrist.clone().sub(E).normalize(); // elbow -> wrist
  const hd = handDir.clone().normalize();
  const ang = out.angleTo(hd);
  if (ang > WRIST_MAX) {
    const axis = new THREE.Vector3().crossVectors(out, hd);
    if (axis.lengthSq() < 1e-10) axis.set(1, 0, 0);
    out.applyAxisAngle(axis.normalize(), ang - WRIST_MAX);
  }
  return wrist.clone().addScaledVector(out, -fore);
}

export function frameOf(wrist, index, middle, pinky) {
  const y = middle.clone().sub(wrist).normalize();
  const x = index.clone().sub(pinky);
  x.addScaledVector(y, -x.dot(y)).normalize();
  const z = new THREE.Vector3().crossVectors(x, y);
  return new THREE.Matrix4().makeBasis(x, y, z);
}

// The file as a three.js scene (+ the glTF result for VRM's humanoid map).
export async function loadFile(bytes, name) {
  const lower = name.toLowerCase();
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  let root; let gltf = null;
  if (lower.endsWith('.fbx')) root = new FBXLoader().parse(buf, '');
  else { gltf = await new Promise((ok, no) => new GLTFLoader().parse(buf, '', ok, no)); root = gltf.scene; }
  // Cameras and lights of the file are not wanted.
  const drop = [];
  root.traverse((o) => { if (o.isCamera || o.isLight) drop.push(o); });
  drop.forEach((o) => o.parent && o.parent.remove(o));
  return { root, gltf };
}

export async function parseModel(bytes, name) {
  const { root } = await loadFile(bytes, name);
  return new CustomHand(root, name);
}
