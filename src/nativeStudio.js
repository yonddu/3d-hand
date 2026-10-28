// Hybrid entry: CameraX/MediaPipe stays native. This page only retargets,
// displays Quest-style hands, records detected frames and exports skeletal GLB.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { HandRig } from './handRig.js';
import { loadHandGLB, RealHand, questMaterial } from './realHand.js';
import { armLocals, wristPivot } from './arm.js';
import { exportGlb } from './exportGlb.js';
import { nativeHands, retargetNative } from './nativePose.js';
import { focalW } from './camera.js';

const $ = id => document.getElementById(id);
const SIDES = ['left', 'right'];
// Keep the familiar Studio canvas, recording dock, options and review layout.
for (const id of ['start', 'ar-btn', 'pose-banner', 'gesture', 'object-info', 'slow-hint', 'guide', 'busy']) $(id).hidden = true;
for (const section of document.querySelectorAll('.rail section')) section.hidden = true;
const opts = document.createElement('section');
opts.innerHTML = '<h2>네이티브 원본 추적</h2><p>MediaPipe 관절 방향 → Quest 스타일 손 → GLB</p><p class="hint">사진 모델·자세 보정·시간 필터·충돌 보정은 적용하지 않습니다. 가려진 손은 숨깁니다. 깊이와 팔 위치는 실측이 아닙니다.</p><label class="check"><input id="native-swap" type="checkbox"> 왼손·오른손 바꾸기</label><p class="hint">MediaPipe의 좌우 표시가 실제 손과 반대일 때만 바꾸세요. 녹화 중에는 변경할 수 없습니다.</p>';
$('rail').appendChild(opts);
$('stage-status').textContent = 'Quest 손 모델 준비 중…';
$('rec-info').textContent = '네이티브 원본 관절 방향 · GLB';
$('rec').disabled = true;
const renderer = new THREE.WebGLRenderer({ canvas: $('viewport'), antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, 1, 0.01, 10);
const controls = new OrbitControls(camera, $('viewport'));
controls.enableDamping = true;
controls.minDistance = .15; controls.maxDistance = 2;
function resetView() { camera.position.set(0, .03, .06); controls.target.set(0, -.03, -.42); controls.update(); }
resetView();
$('view-reset').onclick = resetView;
scene.add(new THREE.HemisphereLight(0xe8f1f4, 0x40525a, 1.6));
const light = new THREE.DirectionalLight(0xffffff, 1.8); light.position.set(.4, .8, -.2); scene.add(light);
const rim = new THREE.DirectionalLight(0x9fd6e0, .9); rim.position.set(-.5, .2, .6); scene.add(rim);
new ResizeObserver(() => {
  const w = $('viewport').clientWidth, h = $('viewport').clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false); camera.aspect = w / h;
  camera.fov = Math.max(34, THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(46) / 2) / camera.aspect)));
  camera.updateProjectionMatrix();
}).observe($('viewport'));
const rigs = {}, realHands = {};
for (const side of SIDES) {
  rigs[side] = new HandRig(side); rigs[side].mesh.visible = false; rigs[side].setJointsVisible(false);
  rigs[side].group.visible = false; scene.add(rigs[side].group);
}
let ready = false, active = true, latest = null, lastT = -Infinity, session = null;
let recording = false, recordFrames = [], recordRaw = [], rawMeta = null, recordName = '';
let review = null, playing = false, reviewT = 0, reviewNow = 0;
const takes = [];
let exportBusy = false;
function status(message) { $('stage-status').textContent = message; }
function hideHands() { for (const s of SIDES) { rigs[s].group.visible = false; if (realHands[s]) realHands[s].root.visible = false; $(`seen-${s}`).textContent = '없음'; } }
function updateMeshes() { for (const s of SIDES) if (realHands[s]) { realHands[s].update(); realHands[s].syncBend(true); } }
function options(open) { document.querySelector('.app').classList.toggle('options-open', open); $('opt-open').setAttribute('aria-expanded', open); }
$('opt-open').onclick = () => options(!document.querySelector('.app').classList.contains('options-open'));
$('opt-close').onclick = () => options(false);
function updateDock() {
  $('rec').classList.toggle('on', recording);
  $('rec').setAttribute('aria-label', recording ? '녹화 정지' : '녹화 시작');
  const d = recordFrames.length > 1 ? recordFrames.at(-1).t - recordFrames[0].t : 0;
  $('rec-time').textContent = recording ? `● ${d.toFixed(1)}초` : '녹화';
  $('review-open').disabled = recording || !takes.length || exportBusy;
  $('review-open').textContent = takes.length ? `리뷰 (${takes.length})` : '리뷰';
  $('native-swap').disabled = recording || exportBusy;
}
function stopRecording() {
  if (!recording) return;
  recording = false;
  if (recordFrames.some(f => SIDES.some(s => f.hands[s]))) {
    takes.unshift({ id: String(Date.now()), name: recordName, frames: recordFrames, raw: { ...rawMeta, frames: recordRaw } });
    status('녹화 완료 · 리뷰에서 확인 후 GLB로 저장하세요. 앱을 닫기 전에 저장하세요.');
  } else status('녹화한 구간에 손이 없습니다.');
  updateDock();
}
function pause() { stopRecording(); latest = null; if (!review) { hideHands(); updateMeshes(); } }
function receive(packet) {
  if (!ready || !active || !packet || !Number.isFinite(packet.tMs) || !(packet.width > 0 && packet.height > 0)) return;
  if (packet.session !== session) { pause(); session = packet.session; lastT = -Infinity; }
  if (packet.tMs <= lastT) return;
  lastT = packet.tMs; latest = packet;
  if (review) return;
  const selected = nativeHands(packet.hands);
  const swap = $('native-swap').checked;
  const hands = { left: null, right: null };
  const aspect = packet.width / packet.height;
  const focal = focalW(aspect);
  hideHands();
  for (const [label, h] of Object.entries(selected)) {
    const side = swap ? (label === 'left' ? 'right' : 'left') : label;
    const rig = rigs[side];
    if (!retargetNative(rig, h)) continue;
    // Work-plane placement only, not observed absolute camera distance.
    rig.group.position.set((h.lm[0] - .5) * .42 / focal, -(h.lm[1] - .5) * .42 / (aspect * focal), -.42);
    rig.group.visible = true;
    // Stateless inferred arm. It never changes the detected wrist orientation.
    const q = rig.wrist.quaternion;
    const W = wristPivot(rig.group.position, q);
    const L = armLocals(new THREE.Vector3(side === 'right' ? .18 : -.18, -.12, -.12), W.clone().add(new THREE.Vector3(0, -.1, .23)), W, q, { side });
    hands[side] = { shoulder: L.S.toArray(), elbow: L.E.toArray(), wrist: rig.group.position.toArray(), upperQ: L.upperQ.toArray(), foreQ: L.foreQ.toArray(), handQ: q.toArray(), fingers: rig.getPose().bones, cup: [0], object: null, armOpts: { side } };
    $(`seen-${side}`).textContent = '추적 중';
  }
  updateMeshes();
  if (recording) {
    recordFrames.push({ t: packet.tMs / 1000, hands });
    recordRaw.push({ t: packet.tMs / 1000, hands: packet.hands, captureTimestampNs: packet.captureTimestampNs });
    rawMeta = { pipeline: 'native-direct-v1', aspect, firstPerson: true, swap, rightOnImageRight: true, offline: false, backend: packet.backend, maxHands: packet.maxHands };
    updateDock();
    if (recordFrames.length >= 9000) { stopRecording(); status('9000프레임에 도달해 녹화를 멈췄습니다. 리뷰에서 저장하세요.'); }
  }
}
$('rec').onclick = () => {
  if (!ready || exportBusy) return;
  if (recording) return stopRecording();
  recordFrames = []; recordRaw = []; rawMeta = null;
  recordName = `motion_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`;
  recording = true; updateDock(); status('원본 관절 방향 녹화 중 · 다시 누르면 정지');
};
function duration() { return review ? review.frames.at(-1).t - review.frames[0].t : 0; }
function seek(t) {
  if (!review) return;
  reviewT = Math.max(0, Math.min(t, duration()));
  const target = review.frames[0].t + reviewT;
  let lo = 0, hi = review.frames.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (review.frames[m].t <= target) lo = m; else hi = m - 1; }
  const frame = review.frames[lo];
  for (const side of SIDES) {
    const h = frame.hands[side]; rigs[side].group.visible = !!h;
    if (h) rigs[side].setPose({ position: h.wrist, wrist: h.handQ, bones: h.fingers, cup: 0 });
  }
  updateMeshes();
  $('rv-seek').value = duration() ? reviewT / duration() : 0;
  $('rv-time').textContent = `${reviewT.toFixed(1)} / ${duration().toFixed(1)}초`;
}
function openReview(take = takes[0]) {
  if (!take || recording || exportBusy) return;
  review = take; playing = true; reviewNow = performance.now();
  $('review').hidden = false; $('dock').hidden = true; $('rv-play').textContent = '❚❚';
  $('rv-take').replaceChildren(...takes.map(t => { const o = document.createElement('option'); o.value = t.id; o.textContent = t.name; return o; }));
  $('rv-take').value = take.id;
  seek(0); status('리뷰 · 저장 (GLB)을 눌러야 파일로 남습니다.');
}
function closeReview() {
  if (exportBusy) return;
  review = null; playing = false; $('review').hidden = true; $('dock').hidden = false; hideHands(); updateMeshes();
  updateDock();
}
$('review-open').onclick = () => openReview();
$('rv-close').onclick = closeReview;
$('rv-play').onclick = () => { playing = !playing; reviewNow = performance.now(); $('rv-play').textContent = playing ? '❚❚' : '▶'; };
$('rv-seek').oninput = e => { playing = false; $('rv-play').textContent = '▶'; seek(Number(e.target.value) * duration()); };
$('rv-take').onchange = e => openReview(takes.find(t => t.id === e.target.value));
$('rv-discard').onclick = () => { if (exportBusy) return; takes.splice(takes.indexOf(review), 1); closeReview(); };

async function saveNative(buffer, filename) {
  const bridge = window.HMSAndroid;
  if (!bridge) throw new Error('Android 저장 연결이 없습니다.');
  const bytes = new Uint8Array(buffer);
  const token = bridge.beginExport(filename, bytes.byteLength);
  if (!token) throw new Error('다른 저장 작업이 진행 중이거나 파일이 너무 큽니다.');
  try {
    for (let i = 0; i < bytes.length; i += 24 * 1024) {
      let binary = ''; for (const b of bytes.subarray(i, i + 24 * 1024)) binary += String.fromCharCode(b);
      if (!bridge.appendExport(token, btoa(binary))) throw new Error('파일 전달 실패');
      // Let the native/UI queues progress between bounded chunks.
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    if (!bridge.finishExport(token)) throw new Error('파일 전달이 완료되지 않았습니다.');
  } catch (e) { bridge.cancelExport(token); throw e; }
}
$('rv-glb').onclick = async () => {
  if (!review || exportBusy) return;
  exportBusy = true; playing = false;
  for (const id of ['rv-glb', 'rv-close', 'rv-discard', 'rv-take', 'rv-seek', 'rv-play']) $(id).disabled = true;
  status('GLB 만드는 중…');
  try {
    const skins = Object.fromEntries(SIDES.map(s => [s, realHands[s].exportSkin()]));
    const data = await exportGlb({ frames: review.frames, skins, name: review.name, includeObjects: false, raw: review.raw, directTracking: true });
    await saveNative(data, `${review.name}.glb`);
    status('저장할 위치를 선택하세요.');
  } catch (e) { status(`저장 실패: ${e.message}`); }
  finally { exportBusy = false; for (const id of ['rv-glb', 'rv-close', 'rv-discard', 'rv-take', 'rv-seek', 'rv-play']) $(id).disabled = false; updateDock(); }
};
window.HMSNative = {
  receive, pause,
  setActive(on) { active = !!on; if (!active) pause(); },
  exportResult(ok, message) { status(message || (ok ? 'GLB 저장 완료' : '저장 취소')); },
};
document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });
let drawCount = 0, fpsAt = performance.now();
function draw(now) {
  if (active && !document.hidden) {
    if (review && playing) { const d = duration(); seek(d ? (reviewT + (now - reviewNow) / 1000) % d : 0); reviewNow = now; }
    controls.update(); renderer.render(scene, camera); drawCount++;
    if (now - fpsAt > 1000) { $('fps').textContent = `${Math.round(drawCount * 1000 / (now - fpsAt))} 렌더 FPS`; drawCount = 0; fpsAt = now; }
  } else { fpsAt = now; drawCount = 0; }
  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);
Promise.all(SIDES.map(async side => {
  const gltf = await loadHandGLB({ url: `hand-${side}.glb` });
  const real = new RealHand(gltf, rigs[side], questMaterial(), { correctPose: false });
  real.contacts = false; real.setWristFade(true); real.root.visible = false;
  realHands[side] = real; scene.add(real.root);
})).then(() => {
  ready = true; $('rec').disabled = false;
  status('네이티브 MediaPipe → Quest 손 · 추가 자세 보정 없음');
  window.HMSAndroid?.ready();
}).catch(e => status(`Quest 손 모델을 불러오지 못했습니다: ${e.message}`));
// Read-only inspection hooks for the bridge/GLB integration test.
window.__nativeStudio = { rigs, realHands, takes, get recording() { return recording; }, get latest() { return latest; }, get ready() { return ready; } };
