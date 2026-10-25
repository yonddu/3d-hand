import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FINGERS, HAND_CONNECTIONS } from './skeleton.js';
import { HandRig } from './handRig.js';
import { HandSolver } from './solver.js';
import { PointSetFilter } from './filters.js';
import { DemoSource } from './demo.js';
import { loadHandGLB, RealHand, questMaterial } from './realHand.js';
import { GraspEstimator, OBJECT_LABEL, handFeatures } from './grasp.js';
import { objectForHand, manualObject } from './objects.js';
import { ArmRig } from './arm.js';
import { wristLoop } from './armMesh.js';
import { exportGlb, frameFromLive, frameFromPoseHand, zipFiles } from './exportGlb.js';
import { capturePose, validatePose, applyPose, loadLibrary, saveLibrary } from './pose.js';

const CONFIG = window.HMS_CONFIG || {};
const $ = (id) => document.getElementById(id);
const SIDES = ['left', 'right'];

// --- scene -------------------------------------------------------------------

const canvas = $('viewport');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 10);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.minDistance = 0.15;
controls.maxDistance = 2;

scene.add(new THREE.HemisphereLight(0xe8f1f4, 0x40525a, 1.6));
const key = new THREE.DirectionalLight(0xffffff, 1.8);
key.position.set(0.4, 0.8, -0.2);
scene.add(key);
const rim = new THREE.DirectionalLight(0x9fd6e0, 0.9);
rim.position.set(-0.5, 0.2, 0.6);
scene.add(rim);

const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();


const grid = new THREE.GridHelper(1.2, 24, 0x7f9aa3, 0x7f9aa3);
grid.material.transparent = true;
grid.material.opacity = 0.22;
grid.position.set(0, -0.2, -0.35);
scene.add(grid);

const skinMat = () => new THREE.MeshStandardMaterial({ color: 0xd6a283, roughness: 0.6 });
const ghostMat = () =>
  new THREE.MeshStandardMaterial({ color: 0xbfd6da, roughness: 0.35, transparent: true, opacity: 0.72, emissive: 0x16343a, emissiveIntensity: 0.6 });

const rigs = {};
const solvers = {};
const filters = {};
const anchorFilters = {};
const filterParams = { minCutoff: 1.2, beta: 12, dCutoff: 1.0 };
const anchorParams = { minCutoff: 0.6, beta: 2, dCutoff: 1.0 };
const rawDots = {};
for (const side of SIDES) {
  rigs[side] = new HandRig(side, { material: skinMat() });
  scene.add(rigs[side].group);
  solvers[side] = new HandSolver(rigs[side]);
  filters[side] = new PointSetFilter(21, filterParams);
  anchorFilters[side] = new PointSetFilter(1, anchorParams);
  rigs[side].group.position.set(side === 'right' ? 0.11 : -0.11, -0.11, -0.42);

  // Raw (unfiltered, unconstrained) landmarks for comparison.
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(HAND_CONNECTIONS.length * 6), 3));
  rawDots[side] = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: side === 'left' ? 0xe5975a : 0x64a8ec, depthTest: false }));
  rawDots[side].renderOrder = 11;
  rawDots[side].visible = false;
  scene.add(rawDots[side]);
}

// The phone sits at the player's eyes and looks the same way they do (-Z), so
// the camera's view of the hands is the first-person view: backs of the hands,
// reaching forward. Orbiting is for inspection; reset returns to the eye.
const EYE = { pos: [0, 0.03, 0.06], target: [0, -0.03, -0.42] };
function resetView() {
  camera.position.fromArray(EYE.pos);
  controls.target.fromArray(EYE.target);
  controls.update();
}
resetView();
$('view-reset').onclick = resetView;

function resize() {
  const { clientWidth: w, clientHeight: h } = canvas;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  if (state.ar) return fitArCamera();
  // Keep a constant horizontal field of view so both hands fit on a portrait phone.
  const hfov = THREE.MathUtils.degToRad(46);
  camera.fov = Math.max(34, THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(hfov / 2) / camera.aspect)));
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(canvas);

// --- state -------------------------------------------------------------------

const state = {
  source: 'demo',
  frozen: false, // viewing a saved pose
  limits: true,
  swap: false,
  lastSeen: { left: -1, right: -1 },
  lastSolve: { left: null, right: null },
  rawLandmarks: { left: null, right: null },
  tableSide: 'right',
  detections: [],
  detAt: -1e9,
  pose: null,
  poseAt: -1e9,
  gesture: '',
  ar: false, // camera picture behind the hands
};
const demo = new DemoSource();
let tracker = null;
let trackerLoading = null;
let stream = null;
const video = $('video');
const overlay = $('overlay');
const octx = overlay.getContext('2d');

// --- input sources ------------------------------------------------------------

// GPU tracking that never finds a hand (some phone GPUs return nothing) is
// rebuilt on the CPU once. Counted over frames actually processed.
const gpuWatch = { frames: 0, found: false, since: 0 };
function watchGpu(count, now) {
  if (!tracker || tracker.delegate !== 'GPU' || gpuWatch.found) return;
  if (count) {
    gpuWatch.found = true;
    return;
  }
  if (!gpuWatch.frames++) gpuWatch.since = now;
  if (gpuWatch.frames > 60 && now - gpuWatch.since > 4000) fallbackToCPU('GPU에서 손을 못 찾음');
}
let switching = false;
function fallbackToCPU(why) {
  if (!tracker || tracker.delegate === 'CPU' || switching) return;
  switching = true;
  setStatus(`${why} → CPU로 다시 시작하는 중…`);
  tracker
    .useCPU()
    .then(() => setStatus('추적 준비됨 (CPU)'))
    .catch((err) => {
      console.error(err);
      setStatus('CPU 추적을 시작하지 못했습니다', true);
    })
    .finally(() => (switching = false));
}

function setStatus(text, isError = false) {
  const el = $('engine-status');
  el.textContent = text;
  el.classList.toggle('err', isError);
  el.parentElement.classList.toggle('status', true);
  // Also on the stage: on a phone the panel is usually scrolled out of view.
  const st = $('stage-status');
  st.textContent = state.source === 'demo' ? '' : text;
  st.style.color = isError ? 'var(--warn)' : '';
}

// Phones run the object and body models on a slow CPU; give the hands the time.
const MOBILE = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
const OBJECT_EVERY = MOBILE ? 600 : 150; // ms
const POSE_EVERY = MOBILE ? 300 : 100; // ms

async function ensureTracker() {
  if (tracker) return tracker;
  if (!trackerLoading) {
    trackerLoading = (async () => {
      const { HandTracker } = await import('./tracker.js');
      const t = new HandTracker(CONFIG);
      await t.init((s) => setStatus(s));
      tracker = t;
      t.initObjects((s) => setStatus(s))
        .catch((err) => {
          console.warn(err);
          setStatus(`추적 준비됨 (${t.delegate}) · 물건 인식 없음`);
        })
        .then(() => t.initPose())
        .then(() => t.pose && setStatus(`추적 + 물건 + 팔꿈치 인식 준비됨 (${t.delegate})`))
        .catch((err) => console.warn('pose model unavailable; elbows use IK only', err));
      return t;
    })().catch((err) => {
      trackerLoading = null;
      console.error(err);
      setStatus('추적 엔진을 불러오지 못했습니다', true);
      toast('MediaPipe를 불러오지 못했습니다. 로컬 서버(README)에서 실행해 보세요.');
      throw err;
    });
  }
  return trackerLoading;
}

function stopStream() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  video.pause();
  video.removeAttribute('src');
  video.srcObject = null;
  octx.clearRect(0, 0, overlay.width, overlay.height);
}

function resetTracking() {
  for (const side of SIDES) {
    filters[side].reset();
    anchorFilters[side].reset();
    solvers[side].reset();
    if (typeof grasps !== 'undefined') grasps[side].reset();
    state.lastSeen[side] = -1;
  }
}

async function setSource(src) {
  state.source = src;
  for (const s of ['demo', 'camera', 'video']) $(`src-${s}`).setAttribute('aria-pressed', s === src);
  $('camera-opts').hidden = src !== 'camera';
  $('video-pick').hidden = src !== 'video';
  $('preview').classList.remove('mirror');
  stopStream();
  resetTracking();
  exitFrozen();
  $('gesture').textContent = '';
  if (src === 'demo') {
    $('preview-empty').hidden = false;
    $('preview-empty').textContent = '데모는 카메라 없이 가상의 손 관절 데이터를 같은 파이프라인에 흘려 보냅니다.';
    setStatus('데모 재생 중');
    return;
  }
  if (src === 'camera') await startCamera();
  if (src === 'video') {
    $('preview-empty').hidden = false;
    $('preview-empty').textContent = '손이 나오는 동영상을 선택하세요.';
    setStatus('동영상을 기다리는 중');
    ensureTracker().catch(() => {});
  }
}

async function startCamera() {
  $('preview-empty').hidden = false;
  $('preview-empty').textContent = '카메라 권한을 요청하는 중…';
  const facing = $('facing').value;
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('unsupported');
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } },
    });
  } catch (err) {
    console.warn(err);
    $('preview-empty').textContent =
      '이 화면에서는 카메라를 쓸 수 없습니다. HTTPS 또는 localhost에서 연 페이지인지, 카메라 권한을 허용했는지 확인하세요. (이 데모 페이지 안에서는 동영상 파일 입력을 쓰세요.)';
    setStatus('카메라 사용 불가', true);
    return;
  }
  if (state.source !== 'camera') return stopStream();
  video.srcObject = stream;
  await video.play().catch(() => {});
  ensureTracker()
    .then((t) => !t.rvfc && t.watchFrames(video))
    .catch(() => {});
  $('preview-empty').hidden = true;
  // Front cameras feel natural mirrored; tracking still runs on the raw frame.
  $('preview').classList.toggle('mirror', facing === 'user');
  await ensureTracker().catch(() => {});
}

$('src-demo').onclick = () => setSource('demo');
$('src-camera').onclick = () => setSource('camera');
$('src-video').onclick = () => setSource('video');
$('facing').onchange = () => state.source === 'camera' && setSource('camera');
$('video-file').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  stopStream();
  resetTracking();
  video.src = URL.createObjectURL(file);
  await video.play().catch(() => {});
  $('preview-empty').hidden = true;
  await ensureTracker().catch(() => {});
};
$('swap').onchange = (e) => {
  state.swap = e.target.checked;
  resetTracking();
};

// --- engine controls -------------------------------------------------------------

$('limits').onchange = (e) => (state.limits = e.target.checked);
const bindSlider = (id, obj, key) => {
  const el = $(id);
  el.oninput = () => {
    obj[key] = parseFloat(el.value);
    $(`${id}-out`).textContent = el.value;
  };
};
bindSlider('mincut', filterParams, 'minCutoff');
bindSlider('beta', filterParams, 'beta');
$('show-joints').onchange = (e) => {
  SIDES.forEach((s) => rigs[s].setJointsVisible(e.target.checked));
  syncArmVisibility();
};
$('show-raw').onchange = (e) => SIDES.forEach((s) => (rawDots[s].visible = e.target.checked));
const MATERIALS = { quest: questMaterial, skin: skinMat, ghost: ghostMat };
function applyLook() {
  const make = MATERIALS[$('look').value];
  for (const s of SIDES) {
    const target = realHands[s] || rigs[s];
    target.mesh.material.dispose();
    const mat = make();
    if (realHands[s]) realHands[s].setMaterial(mat);
    else rigs[s].mesh.material = mat;
    // The arm is one surface with the hand, so it wears the same material.
    arms[s].setMaterial(realHands[s] ? realHands[s].mesh.material : mat);
  }
  applyOpacity();
}
$('look').onchange = applyLook;

// Realistic hand meshes replace the procedural capsules once they load.
const realHands = { left: null, right: null };

// Held-object estimation per hand.
const objectMat = new THREE.MeshStandardMaterial({ color: 0xd99a4e, roughness: 0.55, transparent: true, opacity: 0.5, depthWrite: false });
const grasps = {};
SIDES.forEach((s) => (grasps[s] = new GraspEstimator(rigs[s], objectMat)));
$('object-mode').onchange = () => SIDES.forEach((s) => grasps[s].reset());

// Forearm + elbow per side.
const arms = {};
const armResults = { left: null, right: null };
for (const s of SIDES) {
  arms[s] = new ArmRig(s);
  scene.add(arms[s].group);
}
const syncArmVisibility = () =>
  SIDES.forEach((s) => {
    arms[s].setVisible($('show-arm').checked, $('show-upper').checked, $('show-arm').checked && $('show-joints').checked);
    // Quest-style wrist fade only when the hand ends at the wrist.
    if (realHands[s]) realHands[s].setWristFade(!$('show-arm').checked);
  });

// Arm skin grown from the hand's wrist border, with shared seam normals.
function attachArm(side) {
  const real = realHands[side];
  arms[side].setSkin(wristLoop(real ? real.exportSkin() : null), real ? real.mesh.material : rigs[side].mesh.material);
  if (real) real.setSeamNormals(arms[side].skinData.seam);
}
$('show-arm').onchange = syncArmVisibility;
$('show-upper').onchange = syncArmVisibility;

// Which object description to give the grasp estimator this frame.
function graspOptions(input) {
  const mode = $('object-mode').value;
  const correct = $('contact').checked;
  if (mode === 'auto') return { correct, vision: input.vision || null };
  if (mode === 'hand') return { correct, handOnly: true };
  return { correct, vision: manualObject(mode), forced: true };
}
Promise.all(
  SIDES.map(async (side) => {
    const src = CONFIG.handModels && CONFIG.handModels[side];
    if (!src) return;
    const gltf = await loadHandGLB(src);
    const real = new RealHand(gltf, rigs[side], questMaterial());
    scene.add(real.root);
    rigs[side].mesh.visible = false;
    realHands[side] = real;
  }),
)
  .catch((err) => {
    console.warn('Realistic hand model failed to load; using the procedural hand.', err);
    SIDES.forEach((s) => {
      if (realHands[s]) scene.remove(realHands[s].root);
      realHands[s] = null;
      rigs[s].mesh.visible = true;
    });
  })
  .then(() => {
    SIDES.forEach(attachArm);
    applyLook();
    syncArmVisibility();
  });

// --- per-frame pipeline --------------------------------------------------------------

// Phone main cameras see about 66 degrees across the long side of the frame.
const LONG_FOV = (66 * Math.PI) / 180;
// Focal length in image-width units for a frame of this aspect (width / height).
const focalW = (aspect) => (Math.max(1, 1 / aspect) * 0.5) / Math.tan(LONG_FOV / 2);
const WORK_DEPTH = 0.42;
const LIVE_WINDOW = 1.0; // seconds a hand counts as tracked after its last detection

const facingUser = () => state.source === 'camera' && $('facing').value === 'user';

// MediaPipe hand -> rig-oriented world points + scene anchor for the wrist.
function fromMediaPipe(hand) {
  // Image axes (x right, y down, z away) -> scene axes (x right, y up, z toward camera).
  const world = hand.world.map((p) => new THREE.Vector3(p.x, -p.y, -p.z));
  const aspect = (video.videoWidth || 4) / (video.videoHeight || 3);
  const a = hand.landmarks[0];
  const b = hand.landmarks[9];
  const pix = Math.hypot(b.x - a.x, (b.y - a.y) / aspect);
  const real = world[0].distanceTo(world[9]);
  const FOCAL = focalW(aspect);
  const z = THREE.MathUtils.clamp((FOCAL * real) / Math.max(pix, 1e-3), 0.18, 1.2);
  const vision = objectForHand(state.detections, hand, aspect);
  if (state.ar) {
    // Passthrough: put the wrist on its own camera ray at its real distance,
    // so the 3D hand lands on top of the real one in the video.
    const ray = (p) => new THREE.Vector3((p.x - 0.5) / FOCAL, -((p.y - 0.5) / aspect) / FOCAL, -1);
    const anchor = ray(a).multiplyScalar(z);
    const elbow = elbowFromPoseAR(hand, z, ray);
    // Facing the camera, the body (and so the shoulders) is behind the hands.
    const sgn = hand.side === 'right' ? 1 : -1;
    const shoulder = facingUser() ? new THREE.Vector3(-0.18 * sgn, anchor.y - 0.12, Math.min(anchor.z - 0.3, -0.5)) : null;
    return { side: hand.side, world, anchor, vision, elbow, shoulder };
  }
  // Lay hands out on a work plane at WORK_DEPTH so they stay in frame; real
  // depth changes still move the hand, at half strength.
  const k = WORK_DEPTH / FOCAL;
  const anchor = new THREE.Vector3((a.x - 0.5) * k, (-(a.y - 0.5) / aspect) * k, -(WORK_DEPTH + 0.5 * (z - WORK_DEPTH)));
  const elbow = elbowFromPose(hand, anchor, aspect, k);
  if (facingUser()) {
    // A camera facing the person sees the palms. Turn the hands 180 degrees
    // around the work plane so the scene is still the player's own view.
    world.forEach((p) => p.set(-p.x, p.y, -p.z));
    anchor.set(-anchor.x, anchor.y, -2 * WORK_DEPTH - anchor.z);
    if (elbow) elbow.set(-elbow.x, elbow.y, -2 * WORK_DEPTH - elbow.z);
  }
  return { side: hand.side, world, anchor, vision, elbow };
}

// Elbow seen by the pose model, placed relative to this hand's wrist.
const POSE_ARM = { left: { elbow: 13, wrist: 15 }, right: { elbow: 14, wrist: 16 } };
function elbowFromPose(hand, anchor, aspect, k) {
  const pose = state.pose;
  if (!pose || !pose.landmarks) return null;
  const ids = POSE_ARM[hand.side];
  const e = pose.landmarks[ids.elbow];
  const w = pose.landmarks[ids.wrist];
  const hw = hand.landmarks[0];
  // Same arm as this hand, and the elbow clearly visible.
  if ((e.visibility ?? 0) < 0.6 || Math.hypot(w.x - hw.x, w.y - hw.y) > 0.15) return null;
  const ew = pose.world[ids.elbow];
  const ww = pose.world[ids.wrist];
  return new THREE.Vector3(
    anchor.x + (e.x - hw.x) * k,
    anchor.y - ((e.y - hw.y) / aspect) * k,
    anchor.z - (ew.z - ww.z),
  );
}

function elbowFromPoseAR(hand, wristDist, ray) {
  const pose = state.pose;
  if (!pose || !pose.landmarks) return null;
  const ids = POSE_ARM[hand.side];
  const e = pose.landmarks[ids.elbow];
  const w = pose.landmarks[ids.wrist];
  const hw = hand.landmarks[0];
  if ((e.visibility ?? 0) < 0.5 || Math.hypot(w.x - hw.x, w.y - hw.y) > 0.2) return null;
  // The elbow's place in the picture is reliable; its depth from a single
  // camera is not, so keep it near the wrist's distance.
  const dz = THREE.MathUtils.clamp(pose.world[ids.elbow].z - pose.world[ids.wrist].z, -0.08, 0.08);
  return ray(e).multiplyScalar(Math.max(0.1, wristDist + dz));
}

function feed(inputs, t) {
  const seen = new Set();
  for (const input of inputs) {
    const side = input.side;
    if (seen.has(side)) continue;
    seen.add(side);
    if (state.lastSeen[side] < 0 || t - state.lastSeen[side] > 0.6) {
      filters[side].reset();
      anchorFilters[side].reset();
      solvers[side].reset();
    }
    state.lastSeen[side] = t;
    state.rawLandmarks[side] = input.world;
    const smooth = filters[side].filter(input.world.map((p) => [p.x, p.y, p.z]), t).map((a) => new THREE.Vector3(...a));
    const [anc] = anchorFilters[side].filter([[input.anchor.x, input.anchor.y, input.anchor.z]], t);
    const rig = rigs[side];
    rig.group.visible = true;
    rig.group.position.set(anc[0], anc[1], anc[2]);
    state.lastSolve[side] = solvers[side].solve(smooth, { limits: state.limits });
    if ($('object-mode').value !== 'off') grasps[side].update(graspOptions(input));
    arms[side].shoulder.copy(input.shoulder || arms[side].homeShoulder);
    armResults[side] = arms[side].update(rig.group.position, rig.wrist.quaternion, input.elbow || null);
    updateRaw(side, input.world, rig.group.position);
  }
}

function updateRaw(side, P, origin) {
  const attr = rawDots[side].geometry.attributes.position;
  const o = P[0];
  HAND_CONNECTIONS.forEach(([i, j], k) => {
    attr.setXYZ(k * 2, P[i].x - o.x + origin.x, P[i].y - o.y + origin.y, P[i].z - o.z + origin.z);
    attr.setXYZ(k * 2 + 1, P[j].x - o.x + origin.x, P[j].y - o.y + origin.y, P[j].z - o.z + origin.z);
  });
  attr.needsUpdate = true;
}

// Lost hands ease into a natural reach (back of the hand to the camera, like
// the player's own resting hands), then disappear the way Quest hands do.
const LOST_REACH = new THREE.Quaternion().setFromEuler(new THREE.Euler((40 * Math.PI) / 180, Math.PI, 0, 'YXZ'));
const LOST_HIDE = 1.5; // seconds
const LOST_HIDE_AR = 0.3; // over the camera picture a hand that is not there must not linger
function relaxLost(t) {
  for (const side of SIDES) {
    const rig = rigs[side];
    const hide = state.ar ? LOST_HIDE_AR : LOST_HIDE;
    if (state.source !== 'demo' && (state.lastSeen[side] < 0 || t - state.lastSeen[side] > hide)) rig.group.visible = false;
    if (state.lastSeen[side] >= 0 && t - state.lastSeen[side] < LIVE_WINDOW) continue;
    if (grasps[side].current) grasps[side].reset();
    rig.wrist.quaternion.slerp(LOST_REACH.clone().multiply(rig.wristRest), 0.06);
    for (const chain of Object.values(rig.chains)) for (const l of chain) l.bone.quaternion.slerp(l.restLocal, 0.06);
  }
}

function drawOverlay(hands) {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (overlay.width !== w || overlay.height !== h) {
    overlay.width = w;
    overlay.height = h;
  }
  octx.clearRect(0, 0, w, h);
  for (const hand of hands) {
    const color = hand.side === 'left' ? cssVar('--left') : cssVar('--right');
    octx.strokeStyle = color;
    octx.fillStyle = color;
    octx.lineWidth = Math.max(2, w / 320);
    for (const [i, j] of HAND_CONNECTIONS) {
      const a = hand.landmarks[i];
      const b = hand.landmarks[j];
      octx.beginPath();
      octx.moveTo(a.x * w, a.y * h);
      octx.lineTo(b.x * w, b.y * h);
      octx.stroke();
    }
    for (const p of hand.landmarks) {
      octx.beginPath();
      octx.arc(p.x * w, p.y * h, Math.max(2.5, w / 220), 0, Math.PI * 2);
      octx.fill();
    }
  }
  // Recognized objects.
  const accent = cssVar('--accent');
  octx.font = `${Math.max(12, w / 45)}px ${cssVar('--font-mono') || 'monospace'}`;
  for (const d of state.detections || []) {
    octx.strokeStyle = accent;
    octx.lineWidth = Math.max(2, w / 400);
    octx.setLineDash([8, 6]);
    octx.strokeRect(d.x * w, d.y * h, d.w * w, d.h * h);
    octx.setLineDash([]);
    octx.fillStyle = accent;
    octx.fillText(`${d.category} ${Math.round(d.score * 100)}%`, d.x * w + 4, Math.max(14, d.y * h - 6));
  }
}

// --- passthrough (AR): the camera picture behind semi-transparent hands --------------------

const videoTex = new THREE.VideoTexture(video);
videoTex.colorSpace = THREE.SRGBColorSpace;
let arFit = '';
// The 3D camera becomes the phone camera: at the origin, same field of view,
// cropped like the video is (cover) so the hands line up with the picture.
function fitArCamera() {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const cw = canvas.clientWidth;
  const ch = canvas.clientHeight;
  if (!vw || !vh || !cw || !ch) return;
  const key = `${vw}x${vh}/${cw}x${ch}`;
  if (key === arFit) return;
  arFit = key;
  const va = vw / vh;
  const ca = cw / ch;
  const f = focalW(va);
  const tx = 0.5 / f;
  const ty = 0.5 / va / f;
  const tyVis = ca > va ? tx / ca : ty;
  camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(tyVis));
  camera.aspect = ca;
  camera.updateProjectionMatrix();
  // Same crop on the background picture.
  videoTex.repeat.set(ca > va ? 1 : ca / va, ca > va ? va / ca : 1);
  videoTex.offset.set((1 - videoTex.repeat.x) / 2, (1 - videoTex.repeat.y) / 2);
}
const arWanted = () => $('ar').checked && (state.source === 'camera' || state.source === 'video') && !state.frozen && video.readyState >= 2;
function syncAr() {
  $('ar-btn').hidden = state.source === 'demo';
  const on = arWanted();
  if (on) fitArCamera();
  if (on === state.ar) return;
  state.ar = on;
  arFit = '';
  document.querySelector('.app').classList.toggle('ar', on);
  scene.background = on ? videoTex : null;
  grid.visible = !on;
  controls.enabled = !on;
  $('view-reset').hidden = on;
  if (on) {
    camera.position.set(0, 0, 0);
    camera.quaternion.identity();
    fitArCamera();
  } else {
    resize();
    resetView();
  }
  SIDES.forEach((s) => {
    arms[s].follow = on;
    arms[s].opts = { side: s };
  });
  applyOpacity();
  resetTracking(); // hand positions change meaning between the two views
}
// Overlaid on the real hands the skin is see-through.
function applyOpacity() {
  for (const s of SIDES) {
    const m = realHands[s] ? realHands[s].mesh.material : rigs[s].mesh.material;
    if (!m) continue;
    m.userData.baseOpacity ??= m.opacity;
    m.transparent = true;
    m.opacity = state.ar ? Math.min(0.5, m.userData.baseOpacity) : m.userData.baseOpacity;
  }
}
$('ar').onchange = () => {
  $('ar-btn').setAttribute('aria-pressed', $('ar').checked);
  syncAr();
};
$('ar-btn').onclick = () => {
  $('ar').checked = !$('ar').checked;
  $('ar').onchange();
};

let frames = 0;
let fpsT = performance.now();
let tableT = 0;

function tick(now) {
  syncAr();
  // Recording a video file steps through it frame by frame on video time.
  const offline = rec.on && rec.offline;
  const t = offline ? video.currentTime : now / 1000;
  if (offline && !rec.frameReady) {
    // waiting for the next frame to seek
  } else if (!state.frozen) {
    if (state.source === 'demo') {
      const inputs = demo.frame(t);
      feed(inputs, t);
      state.gesture = inputs[1].gesture;
    } else if (tracker && video.readyState >= 2) {
      if (offline) {
        // Every frame counts here: detect objects and the body on a fixed frame stride.
        state.detAt = rec.frames.length % 4 === 0 ? -1e9 : now;
        state.poseAt = rec.frames.length % 2 === 0 ? -1e9 : now;
      }
      if (tracker.objects && now - state.detAt > OBJECT_EVERY) {
        const found = tracker.detectObjects(video, now);
        if (found) {
          state.detections = found;
          state.detAt = now;
        }
      }
      if (!offline && now - state.detAt > OBJECT_EVERY + 650) state.detections = [];
      if (tracker.pose && now - state.poseAt > POSE_EVERY) {
        const p = tracker.detectPose(video, now);
        if (p) {
          state.pose = p;
          state.poseAt = now;
        }
      }
      let hands = null;
      try {
        hands = tracker.detect(video, now, { swapHandedness: state.swap, rightOnImageRight: !facingUser() });
      } catch (err) {
        console.error(err);
        fallbackToCPU('추적 오류');
      }
      if (hands) watchGpu(hands.length, now);
      if (hands) {
        drawOverlay(hands);
        feed(hands.map(fromMediaPipe), t);
      }
    }
    relaxLost(t);
  }
  for (const side of SIDES) if (realHands[side]) realHands[side].update();
  for (const side of SIDES) {
    arms[side].group.visible = rigs[side].group.visible;
    // Saved poses and lost hands still need a forearm under the wrist.
    if (state.frozen) {
      arms[side].pose(rigs[side].group.position, rigs[side].wrist.quaternion);
    } else if (state.lastSeen[side] < 0 || t - state.lastSeen[side] > 0.2) {
      arms[side].update(rigs[side].group.position, rigs[side].wrist.quaternion, null);
    }
  }
  stepReview(now);
  if (rec.on) $('rec-time').textContent = `● ${(rec.frames.length > 1 ? rec.frames[rec.frames.length - 1].t - rec.frames[0].t : 0).toFixed(1)}초`;
  if (rec.on && !state.frozen) {
    if (!offline) sampleRecording(now);
    else if (rec.frameReady) stepOffline();
  }
  if (!state.ar) controls.update();
  renderer.render(scene, camera);

  frames++;
  if (now - fpsT > 500) {
    $('fps').textContent = `${Math.round((frames * 1000) / (now - fpsT))} fps${tracker && state.source !== 'demo' ? ` · ${tracker.delegate}` : ''}`;
    frames = 0;
    fpsT = now;
    for (const side of SIDES) {
      const live = state.frozen ? !!rigs[side].group.visible : state.lastSeen[side] >= 0 && t - state.lastSeen[side] < LIVE_WINDOW;
      $(`seen-${side}`).textContent = live ? '추적 중' : '없음';
    }
    $('gesture').textContent = state.source === 'demo' && !state.frozen ? `데모 동작: ${state.gesture}` : '';
    $('object-info').textContent = SIDES.map((s) => {
      const o = grasps[s].current;
      return o ? `${s === 'left' ? '왼손' : '오른손'}: ${describeObject(o)}` : '';
    }).filter(Boolean).join(' · ');
  }
  if (now - tableT > 120) {
    tableT = now;
    renderTable();
  }
  requestAnimationFrame(tick);
}

const SOURCE_LABEL = { camera: '카메라 인식', demo: '데모 인식', hand: '손 모양 추정', manual: '직접 선택' };
function describeObject(o) {
  const cm = (m) => (m * 100).toFixed(1);
  let size;
  if (o.type === 'box') size = `${cm(o.size[0])}×${cm(o.size[1])}×${cm(o.size[2])}cm`;
  else if (o.type === 'cylinder' || o.type === 'rod') size = `Ø${cm(o.radius * 2)} × ${cm(o.length)}cm`;
  else size = `Ø${cm(o.radius * 2)}cm`;
  const name = o.label ? `${o.label}(${OBJECT_LABEL[o.type]})` : OBJECT_LABEL[o.type];
  return `${name} ${size} · ${SOURCE_LABEL[o.source] || ''}`;
}

// --- angle table -----------------------------------------------------------------------

function renderTable() {
  const side = state.tableSide;
  const solve = state.frozen ? frozenAngles[side] : state.lastSolve[side];
  const body = $('angle-body');
  const rows = FINGERS.map((f) => {
    const ang = solve ? solve.angles[f.key] : null;
    const conf = solve && solve.confidence ? solve.confidence[f.key] : null;
    const cells = [0, 1, 2]
      .map((k) => {
        if (!ang) return '<td>–</td>';
        const { flex, abd } = ang[k];
        const low = conf && conf[k] < 0.5 ? ' class="low"' : '';
        const txt = Math.abs(abd) >= 0.5 ? `${flex.toFixed(0)} / ${abd.toFixed(0)}` : flex.toFixed(0);
        return `<td${low}>${txt}</td>`;
      })
      .join('');
    const c = conf ? Math.min(...conf) : null;
    const bar = c === null ? '–' : `<span class="conf" title="${Math.round(c * 100)}%"><i style="width:${Math.round(c * 100)}%"></i></span>`;
    return `<tr><td>${f.label}</td>${cells}<td>${bar}</td></tr>`;
  });
  const arm = state.frozen ? frozenArms[side] : armResults[side];
  if (arm) {
    const src = arm.source === 'pose' ? '인식' : 'IK 추정';
    rows.push(`<tr><td>손목</td><td>${arm.wristFlex.toFixed(0)} / ${arm.wristDeviation.toFixed(0)}</td><td colspan="2" class="note">굽힘 / 꺾임</td><td></td></tr>`);
    rows.push(`<tr><td>팔꿈치</td><td>${arm.elbowFlex.toFixed(0)}</td><td colspan="2" class="note">${src}</td><td></td></tr>`);
  }
  body.innerHTML = rows.join('');
}
for (const side of SIDES) {
  $(`tab-${side}`).onclick = () => {
    state.tableSide = side;
    SIDES.forEach((s) => $(`tab-${s}`).setAttribute('aria-pressed', s === side));
    renderTable();
  };
}

// --- poses ------------------------------------------------------------------------------

let library = loadLibrary();
const frozenAngles = { left: null, right: null };
const frozenArms = { left: null, right: null };

function roundArm(a, side) {
  const prefix = side === 'left' ? 'Left' : 'Right';
  const r = (v) => +v.toFixed(4);
  return {
    source: a.source,
    shoulder: a.shoulder.map(r),
    elbow: a.elbow.map(r),
    wrist: a.wrist.map(r),
    elbowFlex: +a.elbowFlex.toFixed(1),
    wristFlex: +a.wristFlex.toFixed(1),
    wristDeviation: +a.wristDeviation.toFixed(1),
    // Mixamo names: LeftArm / LeftForeArm rotations in scene space.
    bones: { [`${prefix}Arm`]: a.upperArmQuat.map(r), [`${prefix}ForeArm`]: a.forearmQuat.map(r) },
  };
}

function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), 2600);
}

function nextPoseName() {
  const typed = $('pose-name').value.trim();
  return typed || `포즈 ${String(library.length + 1).padStart(2, '0')}`;
}

function capture() {
  const t = performance.now() / 1000;
  const visible = {};
  for (const side of SIDES) {
    visible[side] = rigs[side].group.visible;
    const live = state.frozen || state.source === 'demo' || (state.lastSeen[side] >= 0 && t - state.lastSeen[side] < LIVE_WINDOW);
    rigs[side].group.visible = visible[side] && live;
  }
  const pose = capturePose(nextPoseName(), rigs, state.rawLandmarks);
  SIDES.forEach((s) => (rigs[s].group.visible = visible[s]));
  for (const s of SIDES) if (pose.hands[s]) pose.hands[s].object = grasps[s].toJSON();
  for (const s of SIDES) if (pose.hands[s]) pose.hands[s].arm = roundArm(armResults[s] || arms[s].measure(rigs[s].wrist.quaternion), s);
  if (!pose.hands.left && !pose.hands.right) {
    toast('추적 중인 손이 없어 캡처하지 않았습니다.');
    return;
  }
  library.unshift({ id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, pose });
  persist();
  $('pose-name').value = '';
  toast(`"${pose.name}" 저장됨`);
}

function persist() {
  if (!saveLibrary(library)) toast('이 브라우저에 저장할 수 없습니다. JSON으로 내보내 두세요.');
  renderLibrary();
}

let pendingDelete = null;
function renderLibrary() {
  const ul = $('pose-list');
  $('pose-count').textContent = `${library.length}개`;
  if (!library.length) {
    ul.innerHTML = '<li class="empty">아직 저장한 포즈가 없습니다. 손 모양을 잡고 "포즈 캡처"를 누르세요.</li>';
    return;
  }
  ul.innerHTML = '';
  for (const item of library) {
    const { pose } = item;
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = pose.name;
    const acts = document.createElement('span');
    acts.className = 'acts';
    const mk = (label, fn) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.onclick = fn;
      acts.appendChild(b);
      return b;
    };
    mk('보기', () => viewPose(pose));
    mk('JSON', () => saveJson(pose, `${slug(pose.name)}.pose.json`));
    mk('GLB', () => savePoseGlb(pose));
    const del = mk(pendingDelete === item.id ? '삭제 확인' : '삭제', () => {
      if (pendingDelete !== item.id) {
        pendingDelete = item.id;
        renderLibrary();
        return;
      }
      pendingDelete = null;
      library = library.filter((x) => x.id !== item.id);
      persist();
    });
    if (pendingDelete === item.id) del.style.color = 'var(--warn)';
    const meta = document.createElement('span');
    meta.className = 'meta';
    const hands = [pose.hands.left ? '왼손' : null, pose.hands.right ? '오른손' : null].filter(Boolean).join(' + ');
    meta.textContent = `${hands} · ${new Date(pose.createdAt).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' })}`;
    li.append(name, acts, meta);
    ul.appendChild(li);
  }
}

function viewPose(pose) {
  if (review.take) closeReview();
  state.frozen = true;
  applyPose(pose, rigs);
  for (const side of SIDES) {
    const h = pose.hands[side];
    grasps[side].fromJSON(h ? h.object : null);
    frozenArms[side] = h && h.arm ? h.arm : null;
    if (h && h.arm) arms[side].setFromSaved(h.arm);
    frozenAngles[side] = h && h.angles ? { angles: h.angles } : null;
  }
  $('pose-banner').hidden = false;
  $('pose-banner-text').textContent = `"${pose.name}" 보는 중`;
}

function exitFrozen() {
  if (!state.frozen) return;
  state.frozen = false;
  $('pose-banner').hidden = true;
  SIDES.forEach((s) => (rigs[s].group.visible = true));
  resetTracking();
}
$('back-live').onclick = exitFrozen;

// Downloads: the artifact viewer offers files through its downloads capability;
// a normal browser uses an <a download> link. The JSON is also shown for copying.
async function saveJson(obj, filename) {
  const text = JSON.stringify(obj, null, 2);
  const out = $('json-out');
  out.value = text;
  out.hidden = false;
  try {
    if (window.claude && window.claude.use) {
      const downloads = await window.claude.use('downloads');
      if (downloads) {
        await downloads.save({ filename, data: text });
        return;
      }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } catch (err) {
    console.warn(err);
    toast('파일 저장이 취소되었습니다. 아래 JSON을 복사해 쓰세요.');
  }
}

function slug(s) {
  return s.replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 40) || 'pose';
}

$('capture').onclick = capture;
$('capture-timer').onclick = () => {
  let n = 3;
  const el = $('countdown');
  el.hidden = false;
  el.textContent = n;
  const iv = setInterval(() => {
    n--;
    if (n > 0) el.textContent = n;
    else {
      clearInterval(iv);
      el.hidden = true;
      capture();
    }
  }, 1000);
};
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !/INPUT|TEXTAREA|SELECT|BUTTON/.test(document.activeElement.tagName)) {
    e.preventDefault();
    capture();
  }
});
$('pose-file').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const poses = Array.isArray(data.poses) ? data.poses : [data];
    poses.forEach(validatePose);
    for (const pose of poses.reverse()) library.unshift({ id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, pose });
    persist();
    viewPose(poses[poses.length - 1]);
    toast(`${poses.length}개 포즈를 불러왔습니다.`);
  } catch (err) {
    toast(err.message || 'JSON을 읽지 못했습니다.');
  }
};
$('export-all').onclick = () => {
  if (!library.length) return toast('내보낼 포즈가 없습니다.');
  saveJson({ format: 'hand-motion-studio.library', version: 1, poses: library.map((x) => x.pose) }, 'hand-poses.json');
};

// --- motion recording + GLB export ----------------------------------------------------

const REC_FPS = 30;
const takes = []; // this session's recordings, newest first
const rec = { on: false, offline: false, frameReady: false, frames: [], lastAt: -1e9, name: '' };

function handIsLive(side, t) {
  if (!rigs[side].group.visible) return false;
  // Offline steps are 1/30 s apart, so "seen this step" means within one step.
  const window = rec.offline ? 0.5 / REC_FPS : 0.25;
  return state.source === 'demo' || (state.lastSeen[side] >= 0 && t - state.lastSeen[side] < window);
}

function liveFrame(t) {
  const hands = {};
  for (const side of SIDES) hands[side] = handIsLive(side, t) ? frameFromLive(side, rigs[side], arms[side], grasps[side]) : null;
  return hands;
}

function sampleRecording(now) {
  if (now - rec.lastAt < 1000 / REC_FPS - 2) return;
  rec.lastAt = now;
  const t = now / 1000;
  rec.frames.push({ t, hands: liveFrame(t) });
  if (rec.frames.length % 15 === 0) updateRecInfo();
}

// Video file: pause, then seek through it at REC_FPS, one tracked frame per step.
function stepOffline() {
  const t = video.currentTime;
  rec.frames.push({ t, hands: liveFrame(t) });
  if (rec.frames.length % 10 === 0) updateRecInfo();
  const next = t + 1 / REC_FPS;
  rec.frameReady = false;
  if (next >= (video.duration || 0)) return stopRecording();
  video.currentTime = next;
}
video.addEventListener('seeked', () => {
  if (rec.on && rec.offline) rec.frameReady = true;
});

function updateRecInfo() {
  const f = rec.frames;
  const dur = f.length > 1 ? f[f.length - 1].t - f[0].t : 0;
  const withHands = f.filter((x) => x.hands.left || x.hands.right).length;
  $('rec-info').textContent = f.length ? `${rec.on ? '녹화 중 · ' : ''}${dur.toFixed(1)}초 · ${f.length}프레임 (손 ${withHands})` : 'GLB · 팔 + 손 + 쥔 물체';
  $('rec').classList.toggle('on', rec.on);
  $('rec').setAttribute('aria-label', rec.on ? '녹화 정지' : '녹화 시작');
  $('rec-time').classList.toggle('on', rec.on);
  if (!rec.on) $('rec-time').textContent = '녹화';
  $('rec-json').disabled = rec.on || !takes.length;
  $('review-open').disabled = rec.on || !takes.length;
  $('review-open').textContent = takes.length ? `리뷰 (${takes.length})` : '리뷰';
}

function startRecording() {
  exitFrozen();
  rec.on = true;
  rec.frames = [];
  rec.lastAt = -1e9;
  rec.name = $('pose-name').value.trim() || `motion_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`;
  rec.offline = state.source === 'video' && !!video.src;
  rec.frameReady = false;
  if (rec.offline) {
    video.pause();
    resetTracking();
    if (video.currentTime === 0) rec.frameReady = true;
    else video.currentTime = 0;
  }
  updateRecInfo();
}

function stopRecording() {
  rec.on = false;
  if (rec.offline) {
    rec.offline = false;
    resetTracking();
    video.play().catch(() => {});
  }
  const frames = trimFrames(rec.frames);
  if (frames.length) {
    takes.unshift({ id: Date.now().toString(36), name: rec.name, frames, createdAt: new Date() });
    toast(`테이크 저장: ${(frames[frames.length - 1].t - frames[0].t).toFixed(1)}초. "리뷰"에서 다시 보고 GLB로 저장하세요.`);
  } else toast('녹화된 손이 없습니다.');
  updateRecInfo();
}

$('rec').onclick = () => (rec.on ? stopRecording() : startRecording());

function exportSkins() {
  const skins = {};
  for (const s of SIDES) skins[s] = realHands[s] ? realHands[s].exportSkin() : rigs[s].exportSkin();
  return skins;
}

async function saveGlb(frames, name) {
  try {
    const glb = await exportGlb({ frames, skins: exportSkins(), name, includeObjects: $('rec-object').checked });
    await saveBinary(glb, `${slug(name)}.glb`);
    return glb;
  } catch (err) {
    console.error(err);
    toast(err.message || 'GLB를 만들지 못했습니다.');
  }
}

$('rec-json').onclick = () => {
  const take = takes[0];
  if (take) saveJson({ format: 'hand-motion-studio.motion', version: 1, name: take.name, fps: REC_FPS, frames: take.frames }, `${slug(take.name)}.motion.json`);
};

// --- review: play a take back on the same rig ---------------------------------------------

const review = { take: null, t: 0, playing: false, lastNow: 0 };

function takeDuration(take) {
  return take.frames[take.frames.length - 1].t - take.frames[0].t;
}

function applyFrame(frame) {
  for (const side of SIDES) {
    const f = frame.hands[side];
    const rig = rigs[side];
    rig.group.visible = !!f;
    if (!f) continue;
    rig.setPose({ position: f.wrist, wrist: f.handQ, bones: f.fingers });
    grasps[side].fromJSON(f.object);
    arms[side].setFromSaved({ shoulder: f.shoulder, elbow: f.elbow, wrist: f.wrist });
    arms[side].opts = { side, ...f.armOpts };
  }
}

function seekReview(t) {
  const take = review.take;
  const dur = takeDuration(take);
  review.t = Math.min(Math.max(t, 0), dur);
  const target = take.frames[0].t + review.t;
  // Frames are in time order: binary search for the nearest one.
  let lo = 0;
  let hi = take.frames.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (take.frames[mid].t < target) lo = mid + 1;
    else hi = mid;
  }
  applyFrame(take.frames[lo]);
  $('rv-seek').value = dur ? review.t / dur : 0;
  $('rv-time').textContent = `${review.t.toFixed(1)} / ${dur.toFixed(1)}초`;
}

function setPlaying(on) {
  review.playing = on;
  review.lastNow = performance.now();
  $('rv-play').textContent = on ? '❚❚' : '▶';
  $('rv-play').setAttribute('aria-label', on ? '일시정지' : '재생');
}

function renderTakes() {
  const sel = $('rv-take');
  sel.innerHTML = '';
  for (const take of takes) {
    const o = document.createElement('option');
    o.value = take.id;
    o.textContent = `${take.createdAt.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })} · ${takeDuration(take).toFixed(1)}초`;
    sel.appendChild(o);
  }
  if (review.take) sel.value = review.take.id;
}

function openReview(take = takes[0]) {
  if (!take) return;
  if (rec.on) stopRecording();
  state.frozen = true;
  $('pose-banner').hidden = true;
  review.take = take;
  renderTakes();
  $('review').hidden = false;
  $('dock').hidden = true;
  seekReview(0);
  setPlaying(true);
}

function closeReview() {
  if (!review.take) return;
  review.take = null;
  setPlaying(false);
  $('review').hidden = true;
  $('dock').hidden = false;
  exitFrozen();
}

function stepReview(now) {
  if (!review.take || !review.playing) return;
  const dt = (now - review.lastNow) / 1000;
  review.lastNow = now;
  const dur = takeDuration(review.take);
  let t = review.t + dt;
  if (t > dur) t = 0; // loop
  seekReview(t);
}

$('review-open').onclick = () => openReview();
$('rv-close').onclick = closeReview;
$('rv-play').onclick = () => setPlaying(!review.playing);
$('rv-seek').oninput = (e) => {
  setPlaying(false);
  seekReview(+e.target.value * takeDuration(review.take));
};
$('rv-take').onchange = (e) => {
  const take = takes.find((x) => x.id === e.target.value);
  if (take) {
    review.take = take;
    seekReview(0);
    setPlaying(true);
  }
};
$('rv-glb').onclick = () => review.take && saveGlb(review.take.frames, review.take.name);

// --- options drawer + start screen ---------------------------------------------------------

function setOptions(open) {
  document.querySelector('.app').classList.toggle('options-open', open);
  $('opt-open').setAttribute('aria-expanded', open);
}
$('opt-open').onclick = () => setOptions(!document.querySelector('.app').classList.contains('options-open'));
$('opt-close').onclick = () => setOptions(false);

$('start-facing').value = MOBILE ? 'environment' : 'user';
$('start-camera').onclick = () => {
  $('start').hidden = true;
  $('facing').value = $('start-facing').value;
  setSource('camera');
};
$('start-demo').onclick = () => {
  $('start').hidden = true;
  setSource('demo');
};

// Drop empty frames at the start and end of a take.
function trimFrames(frames) {
  const has = (f) => f.hands.left || f.hands.right;
  const a = frames.findIndex(has);
  if (a < 0) return [];
  let b = frames.length - 1;
  while (!has(frames[b])) b--;
  return frames.slice(a, b + 1);
}

function savePoseGlb(pose) {
  const hands = {};
  for (const s of SIDES) hands[s] = pose.hands[s] ? frameFromPoseHand(s, pose.hands[s]) : null;
  return saveGlb([{ t: 0, hands }], pose.name);
}

// .glb is not on the artifact viewer's download list, so there it goes out zipped.
async function saveBinary(buffer, filename) {
  try {
    if (window.claude && window.claude.use) {
      const downloads = await window.claude.use('downloads');
      if (downloads) {
        const zip = zipFiles([{ name: filename, data: buffer }]);
        await downloads.save({ filename: filename.replace(/\.glb$/, '.glb.zip'), data: zip });
        return;
      }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([buffer], { type: 'model/gltf-binary' }));
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } catch (err) {
    console.warn(err);
    toast('파일 저장이 취소되었습니다.');
  }
}

renderLibrary();
renderTable();
requestAnimationFrame(tick);
window.__hms = { fallbackToCPU, camera, controls, realHands, arms, rec, startRecording, stopRecording, trimFrames, exportSkins, exportGlb, savePoseGlb, armResults: () => armResults, tracker: () => ensureTracker(), handFeatures, grasps, scene, rigs, solvers, state, capture, viewPose };
