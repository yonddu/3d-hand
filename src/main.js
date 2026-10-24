import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FINGERS, HAND_CONNECTIONS } from './skeleton.js';
import { HandRig } from './handRig.js';
import { HandSolver } from './solver.js';
import { PointSetFilter } from './filters.js';
import { DemoSource } from './demo.js';
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

// The phone on its stand sits at the origin, looking down -Z at the hands.
const phone = new THREE.Group();
const phoneBody = new THREE.Mesh(
  new THREE.BoxGeometry(0.075, 0.155, 0.008),
  new THREE.MeshStandardMaterial({ color: 0x1d2a30, roughness: 0.4 }),
);
const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.003, 20), new THREE.MeshBasicMaterial({ color: 0x3fd0c9 }));
lens.rotation.x = Math.PI / 2;
lens.position.set(0, 0.06, -0.005);
phone.add(phoneBody, lens);
phone.position.set(0, -0.02, 0.02);
// Hidden by default: in first person the phone is a reference, not part of the shot.
phone.visible = false;
scene.add(phone);

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
  rigs[side].group.position.set(side === 'right' ? -0.11 : 0.11, -0.08, -0.42);

  // Raw (unfiltered, unconstrained) landmarks for comparison.
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(HAND_CONNECTIONS.length * 6), 3));
  rawDots[side] = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: side === 'left' ? 0xe5975a : 0x64a8ec, depthTest: false }));
  rawDots[side].renderOrder = 11;
  rawDots[side].visible = false;
  scene.add(rawDots[side]);
}

const VIEWS = {
  // Behind the hands, looking toward the phone: what the player sees in first person.
  fp: { pos: [0, 0.16, -1.0], target: [0, -0.01, -0.4] },
  // From the phone, the way the camera sees the hands.
  cam: { pos: [0, 0.0, 0.12], target: [0, -0.01, -0.42] },
};
function setView(name) {
  const v = VIEWS[name];
  camera.position.fromArray(v.pos);
  controls.target.fromArray(v.target);
  controls.update();
  phone.visible = name !== 'cam' && $('show-phone').checked;
  $('view-fp').setAttribute('aria-pressed', name === 'fp');
  $('view-cam').setAttribute('aria-pressed', name === 'cam');
}
setView('fp');
$('view-fp').onclick = () => setView('fp');
$('view-cam').onclick = () => setView('cam');

function resize() {
  const { clientWidth: w, clientHeight: h } = canvas;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
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
  gesture: '',
};
const demo = new DemoSource();
let tracker = null;
let trackerLoading = null;
let stream = null;
const video = $('video');
const overlay = $('overlay');
const octx = overlay.getContext('2d');

// --- input sources ------------------------------------------------------------

function setStatus(text, isError = false) {
  const el = $('engine-status');
  el.textContent = text;
  el.classList.toggle('err', isError);
  el.parentElement.classList.toggle('status', true);
}

async function ensureTracker() {
  if (tracker) return tracker;
  if (!trackerLoading) {
    trackerLoading = (async () => {
      const { HandTracker } = await import('./tracker.js');
      const t = new HandTracker(CONFIG);
      await t.init((s) => setStatus(s));
      tracker = t;
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
$('show-joints').onchange = (e) => SIDES.forEach((s) => rigs[s].setJointsVisible(e.target.checked));
$('show-phone').onchange = (e) => (phone.visible = e.target.checked && $('view-cam').getAttribute('aria-pressed') !== 'true');
$('show-raw').onchange = (e) => SIDES.forEach((s) => (rawDots[s].visible = e.target.checked));
$('ghost').onchange = (e) =>
  SIDES.forEach((s) => {
    rigs[s].mesh.material.dispose();
    rigs[s].mesh.material = e.target.checked ? ghostMat() : skinMat();
  });

// --- per-frame pipeline --------------------------------------------------------------

const HFOV = (63 * Math.PI) / 180;
const FOCAL = 0.5 / Math.tan(HFOV / 2); // in image-width units
const WORK_DEPTH = 0.42;
const LIVE_WINDOW = 1.0; // seconds a hand counts as tracked after its last detection

// MediaPipe hand -> rig-oriented world points + scene anchor for the wrist.
function fromMediaPipe(hand) {
  // Image axes (x right, y down, z away) -> scene axes (x right, y up, z toward camera).
  const world = hand.world.map((p) => new THREE.Vector3(p.x, -p.y, -p.z));
  const aspect = (video.videoWidth || 4) / (video.videoHeight || 3);
  const a = hand.landmarks[0];
  const b = hand.landmarks[9];
  const pix = Math.hypot(b.x - a.x, (b.y - a.y) / aspect);
  const real = world[0].distanceTo(world[9]);
  const z = THREE.MathUtils.clamp((FOCAL * real) / Math.max(pix, 1e-3), 0.18, 1.2);
  // Lay hands out on a work plane at WORK_DEPTH so they stay in frame; real
  // depth changes still move the hand, at half strength.
  const k = WORK_DEPTH / FOCAL;
  const anchor = new THREE.Vector3((a.x - 0.5) * k, (-(a.y - 0.5) / aspect) * k, -(WORK_DEPTH + 0.5 * (z - WORK_DEPTH)));
  return { side: hand.side, world, anchor };
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

// Ease a lost hand back to its rest pose instead of freezing mid-gesture.
function relaxLost(t) {
  for (const side of SIDES) {
    const rig = rigs[side];
    if (state.lastSeen[side] >= 0 && t - state.lastSeen[side] < LIVE_WINDOW) continue;
    rig.wrist.quaternion.slerp(rig.wristRest, 0.06);
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
}

let frames = 0;
let fpsT = performance.now();
let tableT = 0;

function tick(now) {
  const t = now / 1000;
  if (!state.frozen) {
    if (state.source === 'demo') {
      const inputs = demo.frame(t);
      feed(inputs, t);
      state.gesture = inputs[1].gesture;
    } else if (tracker && video.readyState >= 2) {
      const hands = tracker.detect(video, now, { swapHandedness: state.swap });
      if (hands) {
        drawOverlay(hands);
        feed(hands.map(fromMediaPipe), t);
      }
    }
    relaxLost(t);
  }
  controls.update();
  renderer.render(scene, camera);

  frames++;
  if (now - fpsT > 500) {
    $('fps').textContent = `${Math.round((frames * 1000) / (now - fpsT))} fps`;
    frames = 0;
    fpsT = now;
    for (const side of SIDES) {
      const live = state.frozen ? !!rigs[side].group.visible : state.lastSeen[side] >= 0 && t - state.lastSeen[side] < LIVE_WINDOW;
      $(`seen-${side}`).textContent = live ? '추적 중' : '없음';
    }
    $('gesture').textContent = state.source === 'demo' && !state.frozen ? `데모 동작: ${state.gesture}` : '';
  }
  if (now - tableT > 120) {
    tableT = now;
    renderTable();
  }
  requestAnimationFrame(tick);
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
  state.frozen = true;
  applyPose(pose, rigs);
  for (const side of SIDES) {
    const h = pose.hands[side];
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

renderLibrary();
renderTable();
requestAnimationFrame(tick);
window.__hms = { rigs, solvers, state, capture, viewPose };
