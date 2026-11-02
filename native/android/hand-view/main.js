// The user's own hand model (GLB / glTF / FBX) drawn over the camera picture,
// posed straight from the raw MediaPipe points (no solver, no smoothing, no
// limits). With no model loaded nothing is drawn here: the app shows the
// MediaPipe points and lines themselves. MainActivity calls setHands(json) each frame.
//
// json: { w, h, fw, fh, hands: [{ side: 'left'|'right', cam: [63], elbow? }] }
//   w, h: picture size (px); fw, fh: focal lengths in picture width / height units;
//   cam: the hand's 21 points in camera space (m; x right, y down, z forward),
//   already on their picture rays (MainActivity), so the model lies over the seen hand.
import * as THREE from 'three';
import { parseModel } from './custom.js';

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
let ready = true;
window.handViewReady = true;

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
  for (const side of ['left', 'right']) customSlots[side].forEach((i) => (i.outer.visible = false));
  const used = { left: 0, right: 0 };
  for (const hand of d.hands || []) {
    const side = hand.side === 'left' ? 'left' : 'right';
    const n = used[side]++;
    if (!hand.cam || hand.cam.length < 63) continue;
    const P = Array.from({ length: 21 }, (_, j) => toThree(hand.cam, j));
    if (custom && n <= 1) {
      if (!customSlots[side][n]) customSlots[side][n] = custom.instance(scene, side);
      // Body pose elbow for this hand (MainActivity): picture point + whether it is farther than the wrist.
      let elbow = null;
      if (hand.elbow && hand.elbow.length >= 3) {
        const [u, v, farther] = hand.elbow;
        elbow = { ray: new THREE.Vector3((u - 0.5) / d.fw, -(v - 0.5) / d.fh, -1).normalize(), farther: farther > 0 };
      }
      custom.pose(customSlots[side][n], P, elbow);
    }
  }
  renderer.render(scene, camera);
  return 'ok';
};

window.addEventListener('resize', () => { last = null; });
