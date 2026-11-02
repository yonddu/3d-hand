// A full-body model (Mixamo / Unreal / Rigify-named FBX or GLB, or a VRM 0.x / 1.0 avatar)
// driven by MediaPipe Pose's 33 points in body tracking mode. Same idea as the hands
// (custom.js): every bone keeps its length and turns the least it must to aim at the next
// joint's point; the hips take the whole body's turn (hip line + spine); the head turns
// with the ears and nose. Idea from SysMocap (auto skeleton detection for VRM and Mixamo,
// MPL-2.0) and Kalidokit (MIT); no code copied from either.
import * as THREE from 'three';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';

// MediaPipe Pose landmarks.
const MP = { nose: 0, lEar: 7, rEar: 8, lSh: 11, rSh: 12, lEl: 13, rEl: 14, lWr: 15, rWr: 16, lPi: 17, rPi: 18, lIx: 19, rIx: 20, lHip: 23, rHip: 24, lKn: 25, rKn: 26, lAn: 27, rAn: 28, lFt: 31, rFt: 32 };

const clean = (name) => name.replace(/mixamorig[0-9]*[:_]?/i, '').replace(/^(j_bip_|bip0?1[_ ]?|def[-_]|orgs?[-_])/i, '');
function sideOf(raw) {
  const n = clean(raw);
  if (/left/i.test(n) || /(^|[^a-z])l([_.\s-]|$)/i.test(n) || /[_.\s-]l$/i.test(n) || /^L(?=[A-Z_])/.test(n)) return 'l';
  if (/right/i.test(n) || /(^|[^a-z])r([_.\s-]|$)/i.test(n) || /[_.\s-]r$/i.test(n) || /^R(?=[A-Z_])/.test(n)) return 'r';
  return null;
}
const FINGER = /thumb|index|middle|ring|pinky|little|finger|toe|twist|roll|helper|end$|nub|_end|\.end/i;
// Role -> test on the cleaned, lower-cased name (side checked apart).
const ROLE = {
  upperArm: (n) => /upper_?arm|uparm|(^|[^e])arm$/.test(n) && !/fore|lower|low_?arm/.test(n),
  lowerArm: (n) => /forearm|fore_arm|lower_?arm|lowarm|elbow/.test(n),
  hand: (n) => /hand$|^hand|wrist/.test(n),
  upperLeg: (n) => /up_?leg|upper_?leg|thigh/.test(n),
  lowerLeg: (n) => /(^|[^p])leg$|lower_?leg|calf|shin|knee/.test(n) && !/up_?leg|upper/.test(n),
  foot: (n) => /foot|ankle/.test(n),
};

function depth(o) { let d = 0; while (o.parent) { d++; o = o.parent; } return d; }

// The humanoid bones of a model: { hips, spine:[...], neck, head, l:{upperArm,...}, r:{...} }.
function findHumanoid(root, vrmMap) {
  const bones = [];
  root.traverse((o) => { if (o.isBone || (o.type === 'Object3D' && o.children.length && !o.isMesh)) bones.push(o); });
  const real = bones.filter((b) => b.isBone);
  const list = (real.length ? real : bones).filter((b) => !(b.parent && b.parent.name === b.name));
  const H = { spine: [], l: {}, r: {} };
  if (vrmMap) {
    const g = (k) => vrmMap[k] || null;
    H.hips = g('hips'); H.neck = g('neck'); H.head = g('head');
    H.spine = ['spine', 'chest', 'upperChest'].map(g).filter(Boolean);
    for (const [s, w] of [['l', 'left'], ['r', 'right']]) {
      H[s] = { upperArm: g(`${w}UpperArm`), lowerArm: g(`${w}LowerArm`), hand: g(`${w}Hand`), upperLeg: g(`${w}UpperLeg`), lowerLeg: g(`${w}LowerLeg`), foot: g(`${w}Foot`) };
    }
  } else {
    const byDepth = [...list].sort((a, b) => depth(a) - depth(b));
    const named = (re) => byDepth.filter((b) => re.test(clean(b.name).toLowerCase()) && !FINGER.test(clean(b.name)));
    H.hips = named(/hips?$|pelvis|^root_?hips/)[0] || null;
    H.spine = named(/spine|chest|torso/).filter((b) => !sideOf(b.name));
    H.neck = named(/neck/).find((b) => !sideOf(b.name)) || null;
    H.head = named(/^head$|head$|^head/).find((b) => !sideOf(b.name) && !/top|end/i.test(b.name)) || null;
    for (const s of ['l', 'r']) {
      for (const [role, test] of Object.entries(ROLE)) {
        H[s][role] = byDepth.find((b) => sideOf(b.name) === s && !FINGER.test(clean(b.name)) && test(clean(b.name).toLowerCase())) || null;
      }
    }
    if (!H.hips && H.l.upperLeg && H.r.upperLeg) H.hips = H.l.upperLeg.parent;
  }
  const need = [H.hips, H.l.upperArm, H.l.lowerArm, H.r.upperArm, H.r.lowerArm];
  return need.every(Boolean) ? H : null;
}

// VRM humanoid map (role -> node) straight from the file's JSON (no VRM library: lighter).
export async function vrmHumanoid(gltf) {
  const json = gltf.parser && gltf.parser.json;
  const ext = json && json.extensions;
  if (!ext) return null;
  const pairs = [];
  if (ext.VRMC_vrm && ext.VRMC_vrm.humanoid) for (const [k, v] of Object.entries(ext.VRMC_vrm.humanoid.humanBones || {})) pairs.push([k, v.node]);
  else if (ext.VRM && ext.VRM.humanoid) for (const b of ext.VRM.humanoid.humanBones || []) pairs.push([b.bone, b.node]);
  if (!pairs.length) return null;
  const map = {};
  for (const [k, i] of pairs) map[k] = await gltf.parser.getDependency('node', i);
  return map;
}

const v3 = () => new THREE.Vector3();
const worldPos = (o) => { o.updateWorldMatrix(true, false); return v3().setFromMatrixPosition(o.matrixWorld); };
// Frame from a side axis (x) and an up axis (y): x kept square to y, z = x × y.
function frameOf(x, y) {
  const Y = y.clone().normalize();
  const X = x.clone().sub(Y.clone().multiplyScalar(x.dot(Y))).normalize();
  const Z = v3().crossVectors(X, Y);
  return new THREE.Matrix4().makeBasis(X, Y, Z);
}

export class CustomBody {
  constructor(root, name, vrmMap) {
    this.name = name; this.template = root; this.vrm = !!vrmMap;
    this.H = findHumanoid(root, vrmMap);
    if (!this.H) throw new Error('전신 뼈(엉덩이, 팔)를 찾지 못했습니다');
    this.vrmMap = vrmMap;
    const H = this.H;
    this.found = ['hips', 'neck', 'head'].filter((k) => H[k]).length + H.spine.length
      + ['l', 'r'].reduce((a, s) => a + Object.values(H[s]).filter(Boolean).length, 0);
  }

  // A posable copy (same structure; bones found again by traversal order).
  instance(scene) {
    const model = SkeletonUtils.clone(this.template);
    const src = []; this.template.traverse((o) => src.push(o));
    const dst = []; model.traverse((o) => dst.push(o));
    const map = new Map(src.map((o, i) => [o, dst[i]]));
    const pick = (o) => (o ? map.get(o) || null : null);
    const T = this.H;
    const H = { hips: pick(T.hips), neck: pick(T.neck), head: pick(T.head), spine: T.spine.map(pick).filter(Boolean), l: {}, r: {} };
    for (const s of ['l', 'r']) for (const k of Object.keys(T[s])) H[s][k] = pick(T[s][k]);
    const outer = new THREE.Group(); const root = new THREE.Group(); root.add(model); outer.add(root);
    root.matrixAutoUpdate = false;
    scene.add(outer);
    model.traverse((o) => { if (o.isMesh) o.frustumCulled = false; });
    model.updateMatrixWorld(true);
    const restLocal = []; model.traverse((o) => restLocal.push([o, o.quaternion.clone()]));
    const animNodes = []; model.traverse((o) => animNodes.push(o));
    // Rest places (model space) and each driven bone's rest aim (in its own frame).
    const P = (o) => (o ? worldPos(o) : null);
    const mid = (a, b) => a.clone().add(b).multiplyScalar(0.5);
    const hipsP = P(H.hips);
    const shL = P(H.l.upperArm); const shR = P(H.r.upperArm);
    const hipL = P(H.l.upperLeg) || hipsP.clone().add(v3().set(0.1, 0, 0)); const hipR = P(H.r.upperLeg) || hipsP.clone().add(v3().set(-0.1, 0, 0));
    const restFrame = frameOf(hipL.clone().sub(hipR), mid(shL, shR).sub(mid(hipL, hipR)));
    const torso = mid(shL, shR).distanceTo(mid(hipL, hipR));
    const aims = [];
    const aim = (bone, child, key) => {
      if (!bone || !child) return;
      const q = new THREE.Quaternion(); bone.getWorldQuaternion(q);
      const d = P(child).sub(P(bone)); if (d.lengthSq() < 1e-10) return;
      aims.push({ bone, key, local: d.normalize().applyQuaternion(q.invert()) });
    };
    const firstChild = (b) => {
      if (!b) return null;
      const kids = b.children.filter((c) => c.isBone || c.type === 'Object3D');
      const mid3 = kids.find((c) => /middle/i.test(c.name)) || kids[0];
      return mid3 || null;
    };
    if (H.spine.length) aim(H.spine[0], H.neck || H.head, 'spine');
    aim(H.neck, H.head, 'neck');
    for (const s of ['l', 'r']) {
      const B = H[s];
      aim(B.upperArm, B.lowerArm, `${s}upperArm`); aim(B.lowerArm, B.hand, `${s}lowerArm`); aim(B.hand, firstChild(B.hand), `${s}hand`);
      aim(B.upperLeg, B.lowerLeg, `${s}upperLeg`); aim(B.lowerLeg, B.foot, `${s}lowerLeg`); aim(B.foot, firstChild(B.foot), `${s}foot`);
    }
    const handM = H.hips.matrixWorld.clone(); // hips at rest (model space): snapshot / export root
    const headRest = H.head ? (() => {
      const q = new THREE.Quaternion(); H.head.getWorldQuaternion(q); return { q, frame: restFrame.clone() };
    })() : null;
    return { outer, root, model, H, restLocal, animNodes, aims, restFrame, torso, handM, headRest, mirror: false, body: true, scaleHist: [] };
  }

  // W: the 33 MediaPipe Pose world points (three.js axes, m); lm: picture points [x, y, z, vis] * 33;
  // fw, fh: focal lengths in picture width / height units.
  pose(inst, W, lm, fw, fh) {
    const { root, H, restLocal, aims, restFrame } = inst;
    for (const [o, q] of restLocal) o.quaternion.copy(q);
    const mid = (a, b) => W[a].clone().add(W[b]).multiplyScalar(0.5);
    const hip = mid(MP.lHip, MP.rHip); const sh = mid(MP.lSh, MP.rSh);
    const seenFrame = frameOf(W[MP.lHip].clone().sub(W[MP.rHip]).add(W[MP.lSh].clone().sub(W[MP.rSh])), sh.clone().sub(hip));
    const R = new THREE.Matrix4().multiplyMatrices(seenFrame, restFrame.clone().transpose());
    // Size: the seen torso against the model's (median of recent frames: steady).
    const torsoSeen = sh.distanceTo(hip);
    if (torsoSeen > 0.2 && torsoSeen < 1.2) { inst.scaleHist.push(torsoSeen / inst.torso); if (inst.scaleHist.length > 45) inst.scaleHist.shift(); }
    const sorted = [...inst.scaleHist].sort((a, b) => a - b);
    const s = sorted.length ? sorted[sorted.length >> 1] : 1;
    // Place: the hips on their picture ray, at the depth the torso's picture length says.
    const px = (i) => [(lm[i * 4] - 0.5) / fw, (lm[i * 4 + 1] - 0.5) / fh];
    const ph = [(px(MP.lHip)[0] + px(MP.rHip)[0]) / 2, (px(MP.lHip)[1] + px(MP.rHip)[1]) / 2];
    const ps = [(px(MP.lSh)[0] + px(MP.rSh)[0]) / 2, (px(MP.lSh)[1] + px(MP.rSh)[1]) / 2];
    const li = Math.hypot(ps[0] - ph[0], ps[1] - ph[1]);
    const z = li > 1e-3 ? Math.min(8, Math.max(0.5, (torsoSeen || 0.5) / li)) : 2.5;
    const hipsAt = new THREE.Vector3(ph[0] * z, -ph[1] * z, -z);
    const hipsRest = v3().setFromMatrixPosition(inst.handM);
    root.matrix.copy(new THREE.Matrix4().makeTranslation(hipsAt.x, hipsAt.y, hipsAt.z)
      .multiply(R).multiply(new THREE.Matrix4().makeScale(s, s, s))
      .multiply(new THREE.Matrix4().makeTranslation(-hipsRest.x, -hipsRest.y, -hipsRest.z)));
    inst.outer.updateMatrixWorld(true);
    // Every aimed bone, from the trunk out: turn the least to point at its seen direction.
    const dirOf = (a, b) => W[b].clone().sub(W[a]).normalize();
    const seenDir = {
      spine: sh.clone().sub(hip).normalize(),
      neck: mid(MP.lEar, MP.rEar).sub(sh).normalize(),
      lupperArm: dirOf(MP.lSh, MP.lEl), llowerArm: dirOf(MP.lEl, MP.lWr), lhand: mid(MP.lIx, MP.lPi).sub(W[MP.lWr]).normalize(),
      rupperArm: dirOf(MP.rSh, MP.rEl), rlowerArm: dirOf(MP.rEl, MP.rWr), rhand: mid(MP.rIx, MP.rPi).sub(W[MP.rWr]).normalize(),
      lupperLeg: dirOf(MP.lHip, MP.lKn), llowerLeg: dirOf(MP.lKn, MP.lAn), lfoot: dirOf(MP.lAn, MP.lFt),
      rupperLeg: dirOf(MP.rHip, MP.rKn), rlowerLeg: dirOf(MP.rKn, MP.rAn), rfoot: dirOf(MP.rAn, MP.rFt),
    };
    const vis = (i) => lm[i * 4 + 3];
    const seenOK = { lupperArm: [MP.lSh, MP.lEl], llowerArm: [MP.lEl, MP.lWr], lhand: [MP.lWr, MP.lIx], rupperArm: [MP.rSh, MP.rEl], rlowerArm: [MP.rEl, MP.rWr], rhand: [MP.rWr, MP.rIx],
      lupperLeg: [MP.lHip, MP.lKn], llowerLeg: [MP.lKn, MP.lAn], lfoot: [MP.lAn, MP.lFt], rupperLeg: [MP.rHip, MP.rKn], rlowerLeg: [MP.rKn, MP.rAn], rfoot: [MP.rAn, MP.rFt] };
    const qW = new THREE.Quaternion(); const qP = new THREE.Quaternion(); const turn = new THREE.Quaternion();
    const applyAim = (a) => {
      const need = seenOK[a.key];
      if (need && need.some((i) => !(vis(i) >= 0.5))) return; // not seen: the bone stays as modelled
      const want = seenDir[a.key];
      if (!want || !Number.isFinite(want.x)) return;
      a.bone.updateWorldMatrix(true, false);
      a.bone.getWorldQuaternion(qW);
      const cur = a.local.clone().applyQuaternion(qW);
      turn.setFromUnitVectors(cur, want);
      const newW = turn.clone().multiply(qW);
      a.bone.parent.getWorldQuaternion(qP);
      a.bone.quaternion.copy(qP.invert().multiply(newW));
      a.bone.updateWorldMatrix(false, true);
    };
    for (const a of aims) applyAim(a);
    // Head: turned like the ears line and the nose (from the trunk's turn).
    if (H.head && vis(MP.lEar) >= 0.5 && vis(MP.rEar) >= 0.5) {
      const up = sh.clone().sub(hip).normalize();
      const side = W[MP.lEar].clone().sub(W[MP.rEar]);
      const headSeen = frameOf(side, up);
      const want = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().multiplyMatrices(headSeen, inst.headRest.frame.clone().transpose())).multiply(inst.headRest.q);
      const outerQ = new THREE.Quaternion(); inst.outer.getWorldQuaternion(outerQ);
      H.head.parent.getWorldQuaternion(qP);
      H.head.quaternion.copy(qP.invert().multiply(outerQ.multiply(want)));
    }
    const doDebug = () => { if (window.HMS_DEBUG) window.lastBody = { lfoot: H.l.foot && worldPos(H.l.foot).toArray(), rfoot: H.r.foot && worldPos(H.r.foot).toArray(), lhand: H.l.hand && worldPos(H.l.hand).toArray(), rhand: H.r.hand && worldPos(H.r.hand).toArray(), modelTorso: s * inst.torso }; };
    if (!window.HMS_NOCONTACT) contacts(inst, W, lm, s, torsoSeen, vis, (key) => { const a = aims.find((x) => x.key === key); if (a) applyAim(a); });
    doDebug();
    inst.outer.visible = true;
  }
}

// ---- contacts (user: a body of other proportions must still touch where the person touches) ----
// Turns are copied, so a model with other leg / arm lengths slides its feet and misses claps and
// hand-on-body touches. Two fixes after the aims, both two-bone reaches (IK):
//  - a planted foot (its picture point still: < FOOT_STILL torso lengths per second, leaves above
//    FOOT_MOVE) is held where the model's foot was when it planted;
//  - a wrist near the other wrist, the head or its own hip (< HAND_IN torsos, leaves HAND_OUT)
//    puts the model's hand where the person's is relative to that point (scaled to the model).
// Both eased in / out (EASE per frame).
const FOOT_STILL = 0.35; const FOOT_MOVE = 0.7; const HAND_IN = 0.16; const HAND_OUT = 0.24; const EASE = 0.25;

function reach(A, B, C, target, w) {
  // Two bones A (upper) -> B (lower) -> C (end): turn A and B so C goes to target (weight w),
  // keeping the bend plane (pole = where B is now).
  if (!A || !B || !C || w <= 0) return;
  const pa = worldPos(A); const pb = worldPos(B); const pc = worldPos(C);
  const t = pc.clone().lerp(target, w);
  const a = pb.distanceTo(pa); const b = pc.distanceTo(pb);
  const dv = t.clone().sub(pa); let d = dv.length();
  if (d < 1e-6 || a < 1e-6 || b < 1e-6) return;
  d = Math.min(Math.max(d, Math.abs(a - b) + 1e-4), a + b - 1e-4);
  const dir = dv.normalize();
  // pole: B's offset from the A-C line now
  const pole = pb.clone().sub(pa); pole.addScaledVector(dir, -pole.dot(dir));
  if (pole.lengthSq() < 1e-10) pole.set(0, 0, 1).addScaledVector(dir, -dir.z);
  pole.normalize();
  const x = (a * a - b * b + d * d) / (2 * d); const h = Math.sqrt(Math.max(0, a * a - x * x));
  const bWant = pa.clone().addScaledVector(dir, x).addScaledVector(pole, h);
  const turnTo = (bone, from, to) => {
    const qW = new THREE.Quaternion(); bone.getWorldQuaternion(qW);
    const q = new THREE.Quaternion().setFromUnitVectors(from.normalize(), to.normalize());
    const qP = new THREE.Quaternion(); bone.parent.getWorldQuaternion(qP);
    bone.quaternion.copy(qP.invert().multiply(q.multiply(qW)));
    bone.updateWorldMatrix(false, true);
  };
  turnTo(A, pb.clone().sub(pa), bWant.clone().sub(pa));
  const pb2 = worldPos(B); const pc2 = worldPos(C);
  turnTo(B, pc2.clone().sub(pb2), pa.clone().addScaledVector(dir, d).sub(pb2));
}

function contacts(inst, W, lm, s, torsoSeen, vis, reAim) {
  const { H } = inst;
  const now = performance.now ? performance.now() : Date.now();
  const st = inst.contact || (inst.contact = { t: now, feet: { l: { w: 0 }, r: { w: 0 } }, hands: { l: { w: 0 }, r: { w: 0 } }, prev: null });
  const clock = inst.clock != null ? inst.clock : now / 1000;
  const raw = st.clock != null ? clock - st.clock : 1;
  if (raw <= 0 || raw > 1) { st.feet = { l: { w: 0 }, r: { w: 0 } }; st.hands = { l: { w: 0 }, r: { w: 0 } }; } // new take / jump in time
  const dt = Math.max(1e-3, Math.min(0.5, raw));
  st.clock = clock;
  const pic = (i) => [lm[i * 4], lm[i * 4 + 1]];
  const torsoPic = Math.hypot((lm[MP.lSh * 4] + lm[MP.rSh * 4] - lm[MP.lHip * 4] - lm[MP.rHip * 4]) / 2, (lm[MP.lSh * 4 + 1] + lm[MP.rSh * 4 + 1] - lm[MP.lHip * 4 + 1] - lm[MP.rHip * 4 + 1]) / 2) || 1;
  inst.root.updateMatrixWorld(true);
  const log = window.HMS_CONTACTLOG ? (window.contactLog = window.contactLog || []) : null;
  // Feet.
  for (const side of ['l', 'r']) {
    const B = H[side]; const f = st.feet[side];
    const an = side === 'l' ? MP.lAn : MP.rAn; const kn = side === 'l' ? MP.lKn : MP.rKn;
    if (!B.upperLeg || !B.lowerLeg || !B.foot) continue;
    const p = pic(an);
    const seen = vis(an) >= 0.5 && lm[an * 4 + 1] > lm[kn * 4 + 1];
    let speed = Infinity;
    if (f.last && seen) speed = Math.hypot(p[0] - f.last[0], p[1] - f.last[1]) / torsoPic / dt;
    f.last = seen ? p : null;
    const still = seen && (f.on ? speed < FOOT_MOVE : speed < FOOT_STILL);
    if (still && !f.on) { f.on = true; f.at = worldPos(B.foot); }
    if (!still && f.on) { f.on = false; }
    f.w = f.on ? Math.min(1, f.w + EASE) : Math.max(0, f.w - EASE);
    if (f.w > 0 && f.at) {
      const before = worldPos(B.foot).distanceTo(f.at);
      reach(B.upperLeg, B.lowerLeg, B.foot, f.at, f.w);
      reAim(`${side}foot`);
      if (log) log.push({ k: `${side}foot`, on: f.on, w: f.w, before, after: worldPos(B.foot).distanceTo(f.at), torso: s * inst.torso });
    }
    if (!f.on && f.w <= 0) f.at = null;
  }
  // Hands: other wrist, head, own hip.
  const k = (s * inst.torso) / Math.max(torsoSeen || 0, 1e-3); // seen metres -> model scene units
  const modelPt = { head: H.head, lhip: H.l.upperLeg, rhip: H.r.upperLeg, lhand: H.l.hand, rhand: H.r.hand };
  const goals = {};
  for (const side of ['l', 'r']) {
    const B = H[side]; const hst = st.hands[side];
    if (!B.upperArm || !B.lowerArm || !B.hand) continue;
    const wr = side === 'l' ? MP.lWr : MP.rWr;
    if (!(vis(wr) >= 0.5)) { hst.on = null; hst.w = Math.max(0, hst.w - EASE); continue; }
    const other = side === 'l' ? 'r' : 'l';
    const cands = [
      { key: `${other}hand`, mp: side === 'l' ? MP.rWr : MP.lWr },
      { key: 'head', mp: MP.nose },
      { key: `${side}hip`, mp: side === 'l' ? MP.lHip : MP.rHip },
    ].filter((c) => modelPt[c.key] && vis(c.mp) >= 0.5);
    let best = null; let bd = Infinity;
    for (const c of cands) { const d = W[wr].distanceTo(W[c.mp]) / Math.max(torsoSeen, 1e-3); if (d < bd) { bd = d; best = c; } }
    const keep = hst.on && cands.find((c) => c.key === hst.on.key);
    const keepD = keep ? W[wr].distanceTo(W[keep.mp]) / Math.max(torsoSeen, 1e-3) : Infinity;
    if (keep && keepD < HAND_OUT) hst.on = keep; else hst.on = best && bd < HAND_IN ? best : null;
    hst.w = hst.on ? Math.min(1, hst.w + EASE) : Math.max(0, hst.w - EASE);
    if (hst.on) hst.last = hst.on;
    const c = hst.on || hst.last;
    if (!c || hst.w <= 0) continue;
    const off = W[wr].clone().sub(W[c.mp]).multiplyScalar(k);
    goals[side] = { c, off, w: hst.w };
  }
  // Clap: both hands meet halfway (each goes to the middle +- half the seen offset).
  if (goals.l && goals.r && goals.l.c.key === 'rhand' && goals.r.c.key === 'lhand') {
    const mid = worldPos(H.l.hand).add(worldPos(H.r.hand)).multiplyScalar(0.5);
    const half = W[MP.lWr].clone().sub(W[MP.rWr]).multiplyScalar(0.5 * k);
    goals.l.target = mid.clone().add(half); goals.r.target = mid.clone().sub(half);
  }
  for (const side of ['l', 'r']) {
    const g = goals[side]; if (!g) continue;
    const B = H[side];
    const target = g.target || worldPos(modelPt[g.c.key]).add(g.off);
    const before = worldPos(B.hand).distanceTo(target);
    reach(B.upperArm, B.lowerArm, B.hand, target, g.w);
    reAim(`${side}hand`);
    if (log) log.push({ k: `${side}hand-${g.c.key}`, w: g.w, before, after: worldPos(B.hand).distanceTo(target), torso: s * inst.torso });
  }
}

export async function parseBody(gltfOrRoot, name) {
  if (gltfOrRoot && gltfOrRoot.scene) {
    const map = await vrmHumanoid(gltfOrRoot).catch(() => null);
    return new CustomBody(gltfOrRoot.scene, name, map);
  }
  return new CustomBody(gltfOrRoot, name, null);
}
