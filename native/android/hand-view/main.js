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

// The user's finger bone lengths per side, from MediaPipe's 3D (world) points: median over
// the first CAL_FRAMES frames that side is seen, then kept (frame by frame they swing ~25%).
const CAL_FRAMES = 60;
const FINGER_MP = { thumb: [1, 2, 3, 4], index: [5, 6, 7, 8], middle: [9, 10, 11, 12], ring: [13, 14, 15, 16], pinky: [17, 18, 19, 20] };
const cal = { left: { samples: [], lengths: null }, right: { samples: [], lengths: null } };
const dist3 = (w, a, b) => Math.hypot(w[a * 3] - w[b * 3], w[a * 3 + 1] - w[b * 3 + 1], w[a * 3 + 2] - w[b * 3 + 2]);
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
// true when the lengths changed (the models then need refitting)
function calibrate(side, w) {
  const c = cal[side];
  if (c.samples.length >= CAL_FRAMES || !w || w.length < 63) return false;
  const palm = dist3(w, 0, 9);
  if (!(palm > 0.03 && palm < 0.2)) return false;
  const one = {};
  for (const [k, mp] of Object.entries(FINGER_MP)) one[k] = [0, 1, 2].map((i) => dist3(w, mp[i], mp[i + 1]) / palm);
  // Knuckles (finger roots, thumb base) in the palm's own frame, in palms: x toward the index
  // side, y wrist -> middle root, z = x cross y.
  const v = (i) => [w[i * 3] - w[0], w[i * 3 + 1] - w[1], w[i * 3 + 2] - w[2]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const unit = (a) => { const n = Math.hypot(...a) || 1; return a.map((x) => x / n); };
  const y = unit(v(9)); let x = v(5).map((a, i) => a - w[17 * 3 + i] + w[i]);
  x = unit(x.map((a, i) => a - dot(x, y) * y[i]));
  const z = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
  one.knuckles = {};
  for (const [k, mp] of Object.entries(FINGER_MP)) { const p = v(mp[0]); one.knuckles[k] = [dot(p, x) / palm, dot(p, y) / palm, dot(p, z) / palm]; }
  c.samples.push(one);
  const n = c.samples.length;
  if (n !== 5 && n % 10 !== 0) return false;
  c.lengths = {};
  for (const k of Object.keys(FINGER_MP)) c.lengths[k] = [0, 1, 2].map((i) => median(c.samples.map((s) => s[k][i])));
  c.lengths.knuckles = {};
  for (const k of Object.keys(FINGER_MP)) c.lengths.knuckles[k] = [0, 1, 2].map((i) => median(c.samples.map((s) => s.knuckles[k][i])));
  return true;
}
window.calStatus = () => JSON.stringify({ left: cal.left.samples.length, right: cal.right.samples.length, fit: Object.fromEntries(['left', 'right'].map((s) => [s, customSlots[s].map((i) => i.fitted)])), err: Object.fromEntries(['left', 'right'].map((s) => [s, customSlots[s].map((i) => i.err)])) });

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
    const refit = calibrate(side, hand.world);
    if (custom && n <= 1) {
      if (!customSlots[side][n]) {
        customSlots[side][n] = custom.instance(scene, side);
        if (cal[side].lengths && !window.HMS_NOFIT) custom.fitLengths(customSlots[side][n], cal[side].lengths);
      } else if (refit && !window.HMS_NOFIT) customSlots[side].forEach((i) => custom.fitLengths(i, cal[side].lengths));
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
