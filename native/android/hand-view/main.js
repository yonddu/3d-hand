// Quest-style hand drawn over the camera picture, posed straight from the
// raw MediaPipe points (no solver, no smoothing, no limits). Native app page:
// MainActivity calls setHands(json) each frame.
//
// json: { w, h, fw, fh, hands: [{ side: 'left'|'right', cam: [63] }] }
//   w, h: picture size (px); fw, fh: focal lengths in picture width / height units;
//   cam: the hand's 21 points in camera space (m; x right, y down, z forward),
//   palm: wrist -> middle-finger root in MediaPipe's world points (m).
//
// The model (MIT, WebXR generic hand) has 25 joints, all siblings, so each
// bone is placed on its own: the wrist and the knuckle bones (metacarpals)
// follow the palm as one piece (wrist -> index/middle/pinky roots), and every
// finger bone keeps the model's length and turns the least it must to point
// at the next joint's MediaPipe point. The points come in already on their
// picture rays (MainActivity), so the hand lies over the seen hand.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import leftGlb from '../vendor-hand/hand-left.glb';
import rightGlb from '../vendor-hand/hand-right.glb';
import { parseModel } from './custom.js';

const NAMES = ['wrist',
  'thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip',
  'index-finger-metacarpal', 'index-finger-phalanx-proximal', 'index-finger-phalanx-intermediate', 'index-finger-phalanx-distal', 'index-finger-tip',
  'middle-finger-metacarpal', 'middle-finger-phalanx-proximal', 'middle-finger-phalanx-intermediate', 'middle-finger-phalanx-distal', 'middle-finger-tip',
  'ring-finger-metacarpal', 'ring-finger-phalanx-proximal', 'ring-finger-phalanx-intermediate', 'ring-finger-phalanx-distal', 'ring-finger-tip',
  'pinky-finger-metacarpal', 'pinky-finger-phalanx-proximal', 'pinky-finger-phalanx-intermediate', 'pinky-finger-phalanx-distal', 'pinky-finger-tip'];
// Chains: [model joint name, MediaPipe point]; the first of each finger chain
// is the knuckle bone (no MediaPipe point: it rides with the palm).
const CHAINS = [
  [['thumb-metacarpal', 1], ['thumb-phalanx-proximal', 2], ['thumb-phalanx-distal', 3], ['thumb-tip', 4]],
  [['index-finger-metacarpal', -1], ['index-finger-phalanx-proximal', 5], ['index-finger-phalanx-intermediate', 6], ['index-finger-phalanx-distal', 7], ['index-finger-tip', 8]],
  [['middle-finger-metacarpal', -1], ['middle-finger-phalanx-proximal', 9], ['middle-finger-phalanx-intermediate', 10], ['middle-finger-phalanx-distal', 11], ['middle-finger-tip', 12]],
  [['ring-finger-metacarpal', -1], ['ring-finger-phalanx-proximal', 13], ['ring-finger-phalanx-intermediate', 14], ['ring-finger-phalanx-distal', 15], ['ring-finger-tip', 16]],
  [['pinky-finger-metacarpal', -1], ['pinky-finger-phalanx-proximal', 17], ['pinky-finger-phalanx-intermediate', 18], ['pinky-finger-phalanx-distal', 19], ['pinky-finger-tip', 20]],
];

const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, premultipliedAlpha: false });
renderer.setClearColor(0x000000, 0);
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, 9 / 16, 0.02, 5);
scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.4);
sun.position.set(0.3, 1, 0.6);
scene.add(sun);
// The web app's see-through hand (main.js ghostMat).
const material = new THREE.MeshStandardMaterial({ color: 0xbfd6da, roughness: 0.35, transparent: true, opacity: 0.72, emissive: 0x16343a, emissiveIntensity: 0.6, depthFunc: THREE.LessEqualDepth });
// Depth first, then colour: only the nearest skin shows through, no streaks from the inside faces.
const depthOnly = new THREE.MeshBasicMaterial({ colorWrite: false });

function frameOf(wrist, index, middle, pinky) {
  const y = middle.clone().sub(wrist).normalize();
  const x = index.clone().sub(pinky);
  x.addScaledVector(y, -x.dot(y)).normalize();
  const z = new THREE.Vector3().crossVectors(x, y);
  return new THREE.Matrix4().makeBasis(x, y, z);
}

class Hand {
  constructor(gltf) {
    this.root = gltf.scene;
    this.bones = {};
    const skins = [];
    this.root.traverse((o) => {
      if (o.isSkinnedMesh) skins.push(o);
      if (NAMES.includes(o.name)) this.bones[o.name] = o;
    });
    for (const o of skins) {
      o.material = material; o.frustumCulled = false; o.renderOrder = 1;
      const depth = new THREE.SkinnedMesh(o.geometry, depthOnly);
      depth.bind(o.skeleton, o.bindMatrix); depth.frustumCulled = false; depth.renderOrder = 0;
      o.parent.add(depth);
    }
    this.rest = {};
    for (const n of NAMES) this.rest[n] = { p: this.bones[n].position.clone(), q: this.bones[n].quaternion.clone() };
    const r = (n) => this.rest[n].p;
    this.restFrame = frameOf(r('wrist'), r('index-finger-phalanx-proximal'), r('middle-finger-phalanx-proximal'), r('pinky-finger-phalanx-proximal'));
    this.restPalm = r('middle-finger-phalanx-proximal').distanceTo(r('wrist'));
    this.root.visible = false;
    scene.add(this.root);
  }

  pose(P, palm) {
    const R = this.rest;
    const W = new THREE.Quaternion().setFromRotationMatrix(
      frameOf(P[0], P[5], P[9], P[17]).multiply(this.restFrame.clone().transpose()));
    // Hand size from MediaPipe's own 3D hand (palm: wrist -> middle root, m), not from the
    // points moved onto their picture rays, whose depths can stretch the palm.
    const s = (palm > 0.03 && palm < 0.2 ? palm : P[9].distanceTo(P[0])) / this.restPalm;
    const onPalm = (p) => p.clone().sub(R.wrist.p).applyQuaternion(W).multiplyScalar(s).add(P[0]);
    const put = (name, pos, q) => {
      const b = this.bones[name];
      b.position.copy(pos); b.quaternion.copy(q); b.scale.setScalar(s);
    };
    put('wrist', P[0], W.clone().multiply(R.wrist.q));
    const pred = new THREE.Quaternion();
    const toRest = new THREE.Quaternion();
    for (const chain of CHAINS) {
      let prevName = 'wrist';
      let prevQ = W.clone().multiply(R.wrist.q);
      let prevPos = P[0];
      chain.forEach(([name, m], k) => {
        // Turned with the bone before it, as at rest.
        pred.copy(prevQ).multiply(R[prevName].q.clone().invert()).multiply(R[name].q);
        // Model bone lengths (scaled to this hand): the first bone of a finger sits where the palm
        // puts it, each next one at the end of the bone before it.
        const pos = k === 0 ? onPalm(R[name].p)
          : prevPos.clone().add(R[name].p.clone().sub(R[prevName].p).applyQuaternion(prevQ.clone().multiply(R[prevName].q.clone().invert())).multiplyScalar(s));
        let q = pred.clone();
        const next = chain[k + 1];
        if (m < 0) q = W.clone().multiply(R[name].q); // knuckle bone: with the palm
        else if (next) {
          toRest.copy(pred).multiply(R[name].q.clone().invert());
          const was = R[next[0]].p.clone().sub(R[name].p).applyQuaternion(toRest).normalize();
          const target = P[next[1]].clone().sub(pos); // aim at the seen point of the next joint
          if (target.lengthSq() > 1e-10) q = new THREE.Quaternion().setFromUnitVectors(was, target.normalize()).multiply(pred);
        }
        put(name, pos, q);
        prevName = name; prevQ = q; prevPos = pos;
      });
    }
    this.root.visible = true;
  }
}

const hands = { left: [], right: [] };
let ready = false;
const loader = new GLTFLoader();
const parse = (u8) => new Promise((ok, no) => loader.parse(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength), '', ok, no));
Promise.all([parse(leftGlb), parse(leftGlb), parse(rightGlb), parse(rightGlb)]).then(([l1, l2, r1, r2]) => {
  hands.left = [new Hand(l1), new Hand(l2)];
  hands.right = [new Hand(r1), new Hand(r2)];
  ready = true;
  window.handViewReady = true;
}).catch((e) => { window.handViewError = String(e); });

let last = null;
function layout(w, h) {
  const W = window.innerWidth; const H = window.innerHeight;
  const k = Math.min(W / w, H / h);
  const cw = Math.round(w * k); const ch = Math.round(h * k);
  Object.assign(canvas.style, { left: `${Math.round((W - cw) / 2)}px`, top: `${Math.round((H - ch) / 2)}px`, width: `${cw}px`, height: `${ch}px` });
  renderer.setSize(cw, ch, false);
}

// Camera space (x right, y down, z forward) -> three.js (y up, looking down -z): a turn, not a mirror.
const toThree = (cam, j) => new THREE.Vector3(cam[j * 3], -cam[j * 3 + 1], -cam[j * 3 + 2]);

// The user's own hand model (MainActivity sends the file in base64 pieces).
let custom = null;
let customSlots = { left: [], right: [] };
let incoming = null;
window.modelStatus = '';
window.modelBegin = (name) => { incoming = { name, parts: [] }; window.modelStatus = 'loading'; return 'ok'; };
window.modelChunk = (b64) => { incoming.parts.push(b64); return 'ok'; };
window.modelEnd = () => {
  const { name, parts } = incoming; incoming = null;
  const bin = atob(parts.join(''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  parseModel(bytes, name).then((m) => {
    dropCustom();
    custom = m;
    const st = m.stats;
    const sides = Object.keys(m.found).filter((k) => m.found[k]).map((k) => (k === 'any' ? '방향 모름' : k === 'left' ? '왼손' : '오른손')).join('·');
    window.modelStatus = `ok:${name} · ${sides} · 삼각형 ${st.tris.toLocaleString()} · 메시 ${st.meshes} · 뼈 ${st.bones}`;
  }).catch((e) => { window.modelStatus = `error:${e && e.message ? e.message : e}`; });
  return 'ok';
};
function dropCustom() {
  for (const side of ['left', 'right']) customSlots[side].forEach((i) => scene.remove(i.outer));
  customSlots = { left: [], right: [] };
  custom = null;
}
window.modelReset = () => { dropCustom(); window.modelStatus = ''; return 'ok'; };
// 'auto' | 'left' | 'right' | 'none': which hand the loaded model is (mirroring).
window.modelHand = (choice) => {
  if (!custom) return 'none-loaded';
  custom.choice = choice;
  for (const side of ['left', 'right']) customSlots[side].forEach((i) => scene.remove(i.outer));
  customSlots = { left: [], right: [] };
  const h = custom.handedness();
  return choice === 'none' ? '반전 안 함' : `${h === 'left' ? '왼손' : '오른손'} 모델로 봄 · 반대 손은 좌우 반전`;
};

window.setHands = function setHands(data) {
  if (!ready) return 'loading';
  const d = typeof data === 'string' ? JSON.parse(data) : data;
  const key = `${d.w}x${d.h}x${window.innerWidth}x${window.innerHeight}`;
  if (key !== last) { layout(d.w, d.h); last = key; }
  camera.aspect = d.w / d.h;
  camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(0.5 / d.fh));
  camera.updateProjectionMatrix();
  for (const side of ['left', 'right']) hands[side].forEach((h) => (h.root.visible = false));
  for (const side of ['left', 'right']) customSlots[side].forEach((i) => (i.outer.visible = false));
  const used = { left: 0, right: 0 };
  for (const hand of d.hands || []) {
    const side = hand.side === 'left' ? 'left' : 'right';
    const n = used[side]++;
    if (!hand.cam || hand.cam.length < 63) continue;
    const P = Array.from({ length: 21 }, (_, j) => toThree(hand.cam, j));
    if (custom) {
      if (n > 1) continue;
      if (!customSlots[side][n]) customSlots[side][n] = custom.instance(scene, side);
      custom.pose(customSlots[side][n], P);
    } else {
      const model = hands[side][n];
      if (model) model.pose(P, hand.palm);
    }
  }
  renderer.render(scene, camera);
  return 'ok';
};

window.addEventListener('resize', () => { last = null; });
