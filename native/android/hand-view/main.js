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
import { CustomHand, loadFile, exportGlb, bakeFitted, smoothTake } from './custom.js';
import { parseBody, CustomBody } from './body.js';
import { cleanTake } from './clean.js';
import { openEditor, applyRig, applyBodyRig, applyFreeRig } from './rig.js';

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

// "내 손에 스킨 씌우기" (screen only): the user's finger bone lengths and knuckles from
// MediaPipe's 3D points, median of the first CAL_FRAMES frames per side, then kept.
const CAL_FRAMES = 60;
const FINGER_MP = { thumb: [1, 2, 3, 4], index: [5, 6, 7, 8], middle: [9, 10, 11, 12], ring: [13, 14, 15, 16], pinky: [17, 18, 19, 20] };
const fitCal = { left: { samples: [], lengths: null }, right: { samples: [], lengths: null } };
const dist3 = (w, a, b) => Math.hypot(w[a * 3] - w[b * 3], w[a * 3 + 1] - w[b * 3 + 1], w[a * 3 + 2] - w[b * 3 + 2]);
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
// true when the lengths changed (the models then need refitting)
function calibrateFit(side, w) {
  const c = fitCal[side];
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
// "편 손 캘리브레이션": the next frame's 3D points of each seen hand are its open hand (kept,
// also for models loaded later, and across app starts).
const calRaw = { left: null, right: null };
try { for (const side of ['left', 'right']) { const v = localStorage.getItem(`hms.openHand.${side}`); if (v) calRaw[side] = JSON.parse(v); } } catch (e) { /* none kept */ }
let calWanted = false;
let fitOn = !!window.HMS_FIT; // game build: the model as modelled (screen = saved GLB)
window.fitHand = (on) => {
  fitOn = !!on;
  // Rebuild the shown models (a fitted one keeps its stretched skin).
  for (const side of ['left', 'right']) customSlots[side].forEach((i) => scene.remove(i.outer));
  customSlots = { left: [], right: [] };
  return 'ok';
};
window.calibrateOpen = () => { calWanted = true; return 'ok'; };
window.calibrateClear = () => {
  calRaw.left = calRaw.right = null;
  try { localStorage.removeItem('hms.openHand.left'); localStorage.removeItem('hms.openHand.right'); } catch (e) { /* ignore */ }
  for (const side of ['left', 'right']) customSlots[side].forEach((i) => { i.cal = null; });
  return 'ok';
};
window.debugSnap = (side) => { const i = customSlots[side || 'right'][0]; return i ? custom.snapshot(i, 0) : null; };
window.debugSlots = () => customSlots; // tests: the posed model instances
window.calStatus = () => JSON.stringify({ fitN: { left: fitCal.left.samples.length, right: fitCal.right.samples.length }, fit: Object.fromEntries(['left', 'right'].map((s) => [s, customSlots[s].map((i) => i.fitted)])), left: !!calRaw.left, right: !!calRaw.right, err: Object.fromEntries(['left', 'right'].map((s) => [s, customSlots[s].map((i) => i.err)])), bends: Object.fromEntries(['left', 'right'].map((s) => [s, customSlots[s].map((i) => i.bends)])) });
const toVecs = (a) => Array.from({ length: 21 }, (_, j) => toThree(a, j));

// Live smoothing (One Euro: steady when still, little lag when moving). Measured on the user's
// takes: palm turn per frame -25..35 %, ~6 mm average offset.
const OE_MIN = 1.0; const OE_BETA = 5; const OE_D = 1.0; const OE_RESET_MS = 300;
const oeState = {};
// zk < 1: the z channel (depth, MediaPipe's weakest reading) gets a lower cutoff = steadier.
const OE_ZK = 0.5;
function liveFilter(key, x, nowMs, zk = 1) {
  const s = oeState[key];
  if (!s || nowMs - s.t > OE_RESET_MS || nowMs <= s.t || s.y.length !== x.length) { oeState[key] = { t: nowMs, y: Array.from(x), dx: new Array(x.length).fill(0) }; return x; }
  const dt = (nowMs - s.t) / 1000; s.t = nowMs;
  const alpha = (c) => 1 / (1 + 1 / (2 * Math.PI * c * dt));
  const ad = alpha(OE_D);
  const out = new Array(x.length);
  for (let j = 0; j < x.length; j += 3) {
    let sp = 0;
    for (let c = 0; c < 3; c++) { const v = (x[j + c] - s.y[j + c]) / dt; s.dx[j + c] = ad * v + (1 - ad) * s.dx[j + c]; sp += s.dx[j + c] ** 2; }
    const cut = OE_MIN + OE_BETA * Math.sqrt(sp);
    const a = alpha(cut); const az = zk === 1 ? a : alpha(cut * zk);
    for (let c = 0; c < 3; c++) { const k = c === 2 ? az : a; s.y[j + c] = k * x[j + c] + (1 - k) * s.y[j + c]; out[j + c] = s.y[j + c]; }
  }
  return out;
}

// MediaPipe's left/right label often swaps for a few frames while a hand turns over (user's
// take: the right hand read as 'left' right at its palm/back flips), and the hand was then posed
// as the other hand (mirrored: fingers smashed). A lone hand where a hand of the other label was
// just seen, with that label not seen this frame, keeps the old label.
const SIDE_MS = 400; const SIDE_NEAR = 0.25; // picture distance (x/z, y/z)
const sideTrack = { left: null, right: null };
function keepSides(hands, nowMs) {
  const pic = (h) => (h.cam && h.cam.length >= 3 && h.cam[2] > 0 ? [h.cam[0] / h.cam[2], h.cam[1] / h.cam[2]] : null);
  const labels = new Set(hands.map((h) => (h.side === 'left' ? 'left' : 'right')));
  for (const h of hands) {
    const side = h.side === 'left' ? 'left' : 'right';
    const other = side === 'left' ? 'right' : 'left';
    const p = pic(h); const tr = sideTrack[other]; const own = sideTrack[side];
    if (!p || !tr || labels.has(other) || hands.length > 1) continue;
    const recent = nowMs - tr.t >= 0 && nowMs - tr.t < SIDE_MS;
    const ownRecent = own && nowMs - own.t >= 0 && nowMs - own.t < SIDE_MS && Math.hypot(own.p[0] - p[0], own.p[1] - p[1]) < SIDE_NEAR;
    if (recent && !ownRecent && Math.hypot(tr.p[0] - p[0], tr.p[1] - p[1]) < SIDE_NEAR) { h.side = other; h.sideKept = true; }
  }
  for (const h of hands) { const p = pic(h); if (p) sideTrack[h.side === 'left' ? 'left' : 'right'] = { p, t: nowMs }; }
}

// A hand not seen for a moment keeps its last pose (MediaPipe drops a hand for a frame or two).
const HOLD_MS = 500;
const lastSeen = { left: [], right: [] };

// Recording for export: snapshots per side (MainActivity replays the saved frames through
// setHands with record: true, then asks for a GLB).
// Record -> correct: MainActivity first feeds every saved frame with collect: true (kept, not
// posed); recFinish() cleans the whole take (clean.js), poses every cleaned frame for export
// and returns the clean-up counts. reviewPlay() then shows the corrected, smoothed animation.
let rec = null; let recIn = null; let review = null;
window.recBegin = () => { rec = { left: [], right: [], body: [] }; recIn = []; reviewStop(); return 'ok'; };
// Which recorded track a save / review uses: the body (body tracking) or the hand seen most.
function recTrack() {
  if (rec.body.length > Math.max(rec.left.length, rec.right.length) && bodyModel && bodySlot) return { side: 'body', frames: rec.body, inst: bodySlot, template: bodyModel.template };
  const side = rec.left.length > rec.right.length ? 'left' : 'right';
  return { side, frames: rec[side], inst: custom && customSlots[side][0], template: custom && custom.template };
}
window.recFinish = () => {
  if (!recIn) return 'error:no take';
  const { frames, stats } = window.HMS_NOCLEAN ? { frames: recIn, stats: {} } : cleanTake(recIn);
  for (const f of frames) window.setHands({ ...f, collect: false, record: true, noRender: true, cleaned: true });
  recIn = null;
  return JSON.stringify(stats);
};
function reviewStop() { if (review) { cancelAnimationFrame(review.raf); review = null; } }
window.reviewStop = () => { reviewStop(); return 'ok'; };
window.reviewPlay = () => {
  reviewStop();
  if (!(custom || bodyModel) || !rec) return 'error:기록이 없습니다';
  const tr = recTrack(); const inst = tr.inst;
  if (!inst || tr.frames.length < 2) return 'error:손(몸)이 잡힌 프레임이 없습니다';
  for (const s of ['left', 'right']) customSlots[s].forEach((i) => { i.outer.visible = i === inst; });
  if (bodySlot) bodySlot.outer.visible = bodySlot === inst;
  const frames = smoothTake(tr.frames);
  const t0 = frames[0].t; const len = frames[frames.length - 1].t - t0;
  const start = performance.now(); let k = 0;
  const step = () => {
    const tt = ((performance.now() - start) / 1000) % (len + 0.5);
    if (tt < (k ? frames[k - 1].t - t0 : 0)) k = 0;
    while (k < frames.length - 1 && frames[k + 1].t - t0 <= tt) k++;
    CustomHand.prototype.applySnapshot(inst, frames[k]);
    renderer.render(scene, camera);
    review.raf = requestAnimationFrame(step);
  };
  review = { raf: requestAnimationFrame(step) };
  return `ok:${frames.length}:${len.toFixed(1)}`;
};
let exportOut = null; window.exportStatus = '';
window.exportBegin = (mode, frameIndex) => {
  if (!custom && !bodyModel) return 'error:스킨이 없습니다';
  if (!rec) return 'error:기록이 없습니다';
  const tr = recTrack(); const side = tr.side;
  let frames = tr.frames;
  if (!frames.length || !tr.inst) return 'error:손(몸)이 잡힌 프레임이 없습니다';
  let index = 0;
  if (mode === 'pose') { let best = Infinity; frames.forEach((f, i) => { const dd = Math.abs(f.fi - frameIndex); if (dd < best) { best = dd; index = i; } }); }
  const inst = tr.inst;
  window.exportStatus = 'working';
  exportGlb(tr.template, inst, frames, mode, index).then((buf) => {
    const u8 = new Uint8Array(buf); let bin = '';
    for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    exportOut = btoa(bin);
    window.exportStatus = `ok:${side}:${frames.length}:${index}:${u8.length}`;
  }).catch((e) => { window.exportStatus = `error:${e && e.message ? e.message : e}`; });
  return 'working';
};
// The model rebuilt to the user's measured hand (needs the first frames of a hand seen live).
window.bakeBegin = () => {
  if (!custom) return 'error:손 모델이 없습니다';
  const side = fitCal.left.samples.length > fitCal.right.samples.length ? 'left' : 'right';
  if (!fitCal[side].lengths) return 'error:손 길이를 아직 못 쟀습니다 (손을 화면에 몇 초 보여주세요)';
  window.exportStatus = 'working';
  bakeFitted(custom, scene, side, fitCal[side].lengths).then(({ buf, fit }) => {
    const u8 = new Uint8Array(buf); let bin = '';
    for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    exportOut = btoa(bin);
    window.bakeFit = fit;
    window.exportStatus = `ok:${side}:${fitCal[side].samples.length}:0:${u8.length}`;
  }).catch((e) => { window.exportStatus = `error:${e && e.message ? e.message : e}`; });
  return 'working';
};
// Fingers 'MediaPipe as is': every finger bone aimed straight at MediaPipe's own bone direction (no app rules:
// knuckle range, end joint following the middle one, side limit, thumb cone). Closer to the picture, more flips.
window.setPure = (on) => { window.HMS_PURE = on ? 3 : 0; try { localStorage.setItem('hms.pure', on ? '1' : '0'); } catch (e) { /* ignore */ } return 'ok'; };
try { if (localStorage.getItem('hms.pure') === '1') window.HMS_PURE = 3; } catch (e) { /* ignore */ }
// Weapon / prop (game build: 'Kukri' under the hand bone): shown or not, on screen and in saved GLBs.
window.propOn = true;
window.setProp = (on) => {
  window.propOn = !!on;
  const apply = (root) => root && root.traverse((o) => { if (/^Kukri/.test(o.name)) o.visible = window.propOn; }); // eslint-disable-line
  if (custom) apply(custom.template);
  for (const side of ['left', 'right']) customSlots[side].forEach((i) => apply(i.model));
  return window.propOn ? 'on' : 'off';
};
window.exportChunks = (size) => (exportOut ? Math.ceil(exportOut.length / size) : 0);
window.exportChunk = (i, size) => (exportOut ? exportOut.slice(i * size, (i + 1) * size) : '');
window.exportDone = () => { exportOut = null; return 'ok'; };

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
  rigSource = { bytes, name };
  const rig = savedRig(name, 'hand');
  useModel(bytes, name, rig, savedRig(name, 'body')).then((st) => { window.modelStatus = st; })
    .catch((e) => { window.modelStatus = `error:${e && e.message ? e.message : e} · 옵션의 '리깅 잡기'로 점 21개를 찍으면 쓸 수 있어요`; });
  return 'ok';
};
// The last loaded file (the rig editor reloads it fresh), and the user's point marks per file.
let rigSource = null;
const rigKey = (name, kind = 'hand') => (kind === 'hand' ? `hms.rig.${name}` : `hms.${kind}rig.${name}`);
function savedRig(name, kind) { try { return JSON.parse(localStorage.getItem(rigKey(name, kind)) || 'null'); } catch (e) { return null; } }
const boneCount = (root) => { let n = 0; root.traverse((o) => { if (o.isBone) n++; }); return n; };
async function useModel(bytes, name, rig, bodyRig) {
  const f = await loadFile(bytes, name);
  // One skin can drive the hands (finger bones), the whole body (humanoid bones), or both.
  let hand = null; let body = null; let why = ''; let rigNote = '';
  let bodyNote = ''; let bodyMap = null; let bodyBuilt = false;
  // a model without bones: bones are made from ONE rig (body first) - two made skeletons can't share a skin
  const bare = boneCount(f.root) < 8;
  if (bodyRig) { const r = applyBodyRig(f.root, bodyRig); bodyNote = r.note; bodyMap = r.map; bodyBuilt = !r.map; }
  if (rig && bare && bodyRig) rigNote = '손 리깅은 뼈 없는 모델에서 몸 리깅과 같이 못 써요 (몸 리깅 사용)';
  else if (rig) {
    const r = applyRig(f.root, rig); rigNote = r.note;
    hand = new CustomHand(f.root, name, r.map);
  } else {
    try { hand = new CustomHand(f.root, name); } catch (e) { why = e && e.message ? e.message : String(e); }
  }
  if (bodyMap) { body = new CustomBody(f.root, name, bodyMap); body.vrm = false; } // throws if a needed bone is missing
  else if (bodyBuilt) body = new CustomBody(f.root, name, null);
  else try { body = await parseBody(f.gltf || f.root, name); } catch (e) { body = null; }
  if (!hand && !body) throw new Error(why || '뼈를 찾지 못했습니다');
  dropCustom();
  custom = hand; bodyModel = body;
  const parts = [];
  if (hand) {
    const st = hand.stats;
    parts.push(`손: ${Object.keys(hand.found).filter((k) => hand.found[k]).map((k) => (k === 'any' ? '방향 모름' : k === 'left' ? '왼손' : '오른손')).join('·')} · 삼각형 ${st.tris.toLocaleString()} · 뼈 ${st.bones}`);
  }
  if (rigNote) parts.push(rigNote);
  if (body) parts.push(`전신${body.vrm ? '(VRM)' : ''}: 몸 뼈 ${body.found}개 인식 (몸 추적에서 움직임)`);
  if (bodyNote) parts.push(bodyNote);
  return `ok:${name} · ${parts.join(' · ')}`;
}
// "리깅 잡기": the editor over the whole page; rigStatus: 'open' | 'done:<status>' | 'error:..' | 'cancel'.
let rigOpenNow = false;
window.rigStatus = '';
window.rigOpen = (kind = 'hand') => {
  if (!rigSource) return 'error:먼저 스킨(GLB/FBX)을 불러오세요';
  if (rigOpenNow) return 'open';
  rigOpenNow = true; window.rigStatus = 'open';
  reviewStop();
  const show = (v) => { for (const side of ['left', 'right']) customSlots[side].forEach((i) => { i.outer.visible = v; }); if (bodySlot) bodySlot.outer.visible = v; };
  show(false);
  const { bytes, name } = rigSource;
  const saved = savedRig(name, kind);
  loadFile(bytes, name).then((f) => {
    window.rigEditor = openEditor({ renderer, canvas, template: f.root, name, kind, side: custom ? custom.handedness() : 'right', saved, onDone: (rig) => {
      rigOpenNow = false; window.rigEditor = null;
      last = null; // the next frame lays the canvas out again
      if (!rig) { show(true); window.rigStatus = 'cancel'; return; }
      try { localStorage.setItem(rigKey(name, kind), JSON.stringify(rig)); } catch (e) { /* kept for this run only */ }
      if (kind === 'free') { show(true); freeRigGlb(bytes, name, rig); return; }
      useModel(bytes, name, kind === 'hand' ? rig : savedRig(name, 'hand'), kind === 'body' ? rig : savedRig(name, 'body'))
        .then((st) => { window.modelStatus = st; window.rigStatus = `done:${st}`; })
        .catch((e) => { window.rigStatus = `error:${e && e.message ? e.message : e}`; });
    } });
  }).catch((e) => { rigOpenNow = false; show(true); window.rigStatus = `error:${e && e.message ? e.message : e}`; });
  return 'open';
};
// Free rig: bones on the user's points in a fresh copy of the file, saved as a GLB (rigStatus 'glb:<note>').
async function freeRigGlb(bytes, name, rig) {
  try {
    const f = await loadFile(bytes, name);
    const r = applyFreeRig(f.root, rig);
    const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');
    const buf = await new Promise((ok, no) => new GLTFExporter().parse(f.root, ok, no, { binary: true }));
    const u8 = new Uint8Array(buf); let bin = '';
    for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    exportOut = btoa(bin); freeReady = `ok:free:${r.built}:0:${u8.length}`;
    window.rigStatus = `glb:${r.note}`;
  } catch (e) { window.rigStatus = `error:${e && e.message ? e.message : e}`; }
}
let freeReady = '';
window.rigGlbBegin = () => { if (!freeReady) return 'error:만든 GLB가 없습니다'; window.exportStatus = freeReady; freeReady = ''; return 'working'; };
window.rigForget = () => { if (rigSource) try { for (const k of ['hand', 'body', 'free']) localStorage.removeItem(rigKey(rigSource.name, k)); } catch (e) { /* ignore */ } return 'ok'; };
function dropCustom() {
  for (const side of ['left', 'right']) customSlots[side].forEach((i) => scene.remove(i.outer));
  customSlots = { left: [], right: [] };
  custom = null;
  if (bodySlot) scene.remove(bodySlot.outer);
  bodySlot = null; bodyModel = null;
}
// The full-body skin (body tracking): one instance.
let bodyModel = null; let bodySlot = null; let bodySeen = -1e9;
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
  if (d.collect) { if (recIn) recIn.push(d); return 'ok'; }
  if (review && !d.record) return 'ok'; // the corrected take is playing
  if (rigOpenNow) return 'ok'; // the rig editor has the page
  const key = `${d.w}x${d.h}x${window.innerWidth}x${window.innerHeight}`;
  if (key !== last) { layout(d.w, d.h); last = key; }
  camera.aspect = d.w / d.h;
  camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(0.5 / d.fh));
  camera.updateProjectionMatrix();
  const now = d.t != null ? d.t * 1000 : performance.now();
  const used = { left: 0, right: 0 };
  const posed = new Set();
  if (!window.HMS_NOSTICKY && !d.cleaned) keepSides(d.hands || [], now);
  for (const hand of d.hands || []) {
    const side = hand.side === 'left' ? 'left' : 'right';
    const n = used[side]++;
    if (!hand.cam || hand.cam.length < 63) continue;
    if (!d.record && !window.HMS_NOFILTER) { // live: One Euro filter on the points (saved frames stay raw)
      hand.cam = liveFilter(`${side}${n}c`, hand.cam, now);
      if (hand.world && hand.world.length >= 63) hand.world = liveFilter(`${side}${n}w`, hand.world, now, window.HMS_OEZ != null ? +window.HMS_OEZ : OE_ZK);
    }
    const P = toVecs(hand.cam);
    const Wd = hand.world && hand.world.length >= 63 ? toVecs(hand.world) : null;
    const refit = !d.record && calibrateFit(side, hand.world) && fitOn; // measured also with the fit off (for the bake)
    if (calWanted && Wd && n === 0) {
      calRaw[side] = Wd.map((v) => v.toArray()).flat();
      try { localStorage.setItem(`hms.openHand.${side}`, JSON.stringify(calRaw[side])); } catch (e) { /* not kept */ }
      customSlots[side].forEach((i) => { i.calW = toVecs(calRaw[side]); });
    }
    if (custom && n <= 1) {
      if (!customSlots[side][n]) {
        customSlots[side][n] = custom.instance(scene, side);
        if (calRaw[side]) customSlots[side][n].calW = toVecs(calRaw[side]);
        if (fitOn && fitCal[side].lengths) custom.fitLengths(customSlots[side][n], fitCal[side].lengths);
      } else if (refit) customSlots[side].forEach((i) => custom.fitLengths(i, fitCal[side].lengths));
      // Body pose elbow for this hand (MainActivity): picture point + whether it is farther than the wrist.
      let elbow = null;
      if (hand.elbow && hand.elbow.length >= 3) {
        const [u, v, farther] = hand.elbow;
        elbow = { ray: new THREE.Vector3((u - 0.5) / d.fw, -(v - 0.5) / d.fh, -1).normalize(), farther: farther > 0 };
      }
      const inst = customSlots[side][n];
      inst.live = !d.record;
      inst.fresh = now - (lastSeen[side][n] || -1e9) < 300; // last pose recent: smooth from it
      custom.pose(inst, P, elbow, Wd);
      posed.add(inst);
      lastSeen[side][n] = now;
      if (rec && d.record && n === 0) rec[side].push({ ...custom.snapshot(inst, d.t || 0), fi: d.fi });
    }
  }
  // Body tracking: the full-body skin follows MediaPipe Pose.
  if (d.body && bodyModel && d.body.world && d.body.world.length >= 99 && d.body.lm && d.body.lm.length >= 132) {
    if (!bodySlot) bodySlot = bodyModel.instance(scene);
    let w = d.body.world;
    if (!d.record && !window.HMS_NOFILTER) w = liveFilter('bodyw', w, now);
    const W = Array.from({ length: 33 }, (_, j) => toThree(w, j));
    bodySlot.clock = d.t != null ? d.t : now / 1000;
    bodyModel.pose(bodySlot, W, d.body.lm, d.fw, d.fh);
    bodySeen = now;
    if (rec && d.record) rec.body.push({ ...CustomHand.prototype.snapshot(bodySlot, d.t || 0), fi: d.fi });
  } else if (bodySlot && now - bodySeen > HOLD_MS) bodySlot.outer.visible = false;
  if (calWanted) calWanted = !(d.hands || []).some((h) => h.world);
  for (const side of ['left', 'right']) {
    customSlots[side].forEach((i, n) => {
      if (!posed.has(i)) i.outer.visible = i.outer.visible && now - (lastSeen[side][n] || 0) < HOLD_MS;
    });
  }
  if (!d.noRender) renderer.render(scene, camera);
  return 'ok';
};

window.addEventListener('resize', () => { last = null; });
