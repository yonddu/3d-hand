// "리깅 잡기": the user marks MediaPipe's 21 hand points on a loaded skin, by name, in the app.
//  - tap the model: the point goes inside the finger (middle between where the tap ray enters
//    and leaves the skin); X / Y / Z arrows on the point move it along one axis (press and drag);
//    drag elsewhere turns the model, two fingers zoom; tap a placed point to fix it again.
//  - with all 21 points:
//    * a model with bones: each point takes the nearest bone (bone head), so a rig whose bone
//      names the app does not know can be driven (map kept per model file);
//    * a model without bones (AI meshes): bones are made on the points (Mixamo names) and the
//      skin is bound to them (each vertex to its nearest bone segments).
import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';

export const POINTS = [
  ['손목', 'WRIST', '손목 주름 한가운데, 손목이 꺾이는 관절 중심'],
  ['엄지 뿌리', 'THUMB_CMC', '손목 가까이 엄지가 시작되는 관절. 손바닥 두툼한 엄지 살(엄지두덩) 안쪽 깊은 곳'],
  ['엄지 첫 관절', 'THUMB_MCP', '엄지가 손바닥에서 떨어져 나오는 관절. 엄지 손등 쪽 튀어나온 뼈마디'],
  ['엄지 끝 관절', 'THUMB_IP', '엄지 손톱 바로 아래 주름이 생기는 관절'],
  ['엄지 끝', 'THUMB_TIP', '엄지 손끝 살 끝 (손톱 끝 높이)'],
  ['검지 뿌리', 'INDEX_MCP', '검지가 손바닥과 이어지는 관절. 주먹 쥐면 손등에 튀어나오는 너클'],
  ['검지 가운데 관절', 'INDEX_PIP', '검지 가운데 주름 (손가락에서 가장 크게 접히는 곳)'],
  ['검지 끝 관절', 'INDEX_DIP', '검지 손톱 바로 아래 주름'],
  ['검지 끝', 'INDEX_TIP', '검지 손끝 살 끝 (손톱 끝 높이)'],
  ['중지 뿌리', 'MIDDLE_MCP', '중지가 손바닥과 이어지는 관절. 주먹 쥐면 손등에 튀어나오는 너클'],
  ['중지 가운데 관절', 'MIDDLE_PIP', '중지 가운데 주름 (손가락에서 가장 크게 접히는 곳)'],
  ['중지 끝 관절', 'MIDDLE_DIP', '중지 손톱 바로 아래 주름'],
  ['중지 끝', 'MIDDLE_TIP', '중지 손끝 살 끝 (손톱 끝 높이)'],
  ['약지 뿌리', 'RING_MCP', '약지가 손바닥과 이어지는 관절. 주먹 쥐면 손등에 튀어나오는 너클'],
  ['약지 가운데 관절', 'RING_PIP', '약지 가운데 주름 (손가락에서 가장 크게 접히는 곳)'],
  ['약지 끝 관절', 'RING_DIP', '약지 손톱 바로 아래 주름'],
  ['약지 끝', 'RING_TIP', '약지 손끝 살 끝 (손톱 끝 높이)'],
  ['새끼 뿌리', 'PINKY_MCP', '새끼가 손바닥과 이어지는 관절. 주먹 쥐면 손등에 튀어나오는 너클'],
  ['새끼 가운데 관절', 'PINKY_PIP', '새끼 가운데 주름 (손가락에서 가장 크게 접히는 곳)'],
  ['새끼 끝 관절', 'PINKY_DIP', '새끼 손톱 바로 아래 주름'],
  ['새끼 끝', 'PINKY_TIP', '새끼 손끝 살 끝 (손톱 끝 높이)'],
];
export const FINGER_KEYS = ['thumb', 'index', 'middle', 'ring', 'pinky'];
const MP = { thumb: [1, 2, 3, 4], index: [5, 6, 7, 8], middle: [9, 10, 11, 12], ring: [13, 14, 15, 16], pinky: [17, 18, 19, 20] };
const COLORS = [0xffffff, 0xff5a5a, 0xffb02e, 0x4cd964, 0x3fa9ff, 0xc77dff];
const colorOf = (i) => COLORS[i === 0 ? 0 : 1 + Math.floor((i - 1) / 4)];
const MIXAMO = { thumb: 'Thumb', index: 'Index', middle: 'Middle', ring: 'Ring', pinky: 'Pinky' };

// 2D guide picture: where each of the 21 points sits on a flat hand (palm facing you, fingers up).
const GUIDE = [[.50,.95],[.36,.86],[.24,.74],[.15,.63],[.07,.53],
  [.38,.52],[.35,.36],[.34,.25],[.33,.15],[.50,.50],[.50,.32],[.50,.20],[.50,.09],
  [.62,.52],[.64,.35],[.65,.24],[.66,.14],[.73,.57],[.77,.44],[.79,.36],[.81,.28]];
const hex = (c) => '#' + c.toString(16).padStart(6, '0');
const FINGER_KO = ['손목', '엄지', '검지', '중지', '약지', '새끼'];
function guideSvg(cur, side, placed) {
  const W = 140, H = 152, P = (i) => [(side === 'right' ? 1 - GUIDE[i][0] : GUIDE[i][0]) * W, GUIDE[i][1] * H];
  let g = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="background:rgba(255,255,255,.08);border-radius:8px">`;
  const ln = (a, b) => { const [x1, y1] = P(a), [x2, y2] = P(b); g += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${hex(colorOf(b))}" stroke-width="2" opacity=".7"/>`; };
  for (const key of FINGER_KEYS) { const m = MP[key]; ln(0, m[0]); ln(m[0], m[1]); ln(m[1], m[2]); ln(m[2], m[3]); }
  ln(5, 9); ln(9, 13); ln(13, 17);
  for (let i = 0; i < 21; i++) {
    const [x, y] = P(i); const on = i === cur;
    const c = hex(colorOf(i));
    g += `<circle cx="${x}" cy="${y}" r="${on ? 7 : 4.5}" fill="${placed[i] ? c : '#222'}" stroke="${on ? '#fff' : c}" stroke-width="${on ? 2.5 : 1.5}"/>`;
    g += `<circle data-i="${i}" cx="${x}" cy="${y}" r="11" fill="transparent"/>`;
    g += `<text pointer-events="none" x="${x + 6}" y="${y - 5}" fill="${on ? '#fff' : '#bbb'}" font-size="${on ? 12 : 9}">${i}</text>`;
  }
  g += `<text x="4" y="${H - 4}" fill="#aaa" font-size="8">MediaPipe 예시 (손바닥) · 채움=놓음</text></svg>`;
  // names of the current finger's points (wrist + its 4), same colours as the dots
  const f = cur === 0 ? -1 : Math.floor((cur - 1) / 4);
  const ids = f < 0 ? [0, 1, 5, 9, 13, 17] : [1, 2, 3, 4].map((k) => f * 4 + k);
  const names = ids.map((i) => `<div data-i="${i}" style="padding:2px 0;"color:${hex(colorOf(i))};${i === cur ? 'font-weight:bold;font-size:13px' : 'opacity:.85'}">● ${i} ${POINTS[i][0]} <span style="opacity:.6">${POINTS[i][1]}</span></div>`).join('');
  return `<div style="background:rgba(0,0,0,.55);border-radius:8px;padding:4px;font:11px sans-serif;color:#fff">${g}${names}</div>`;
}

// Every object of a model in traverse order (a clone has the same order: maps are kept as indices).
export function nodesOf(root) { const a = []; root.traverse((o) => a.push(o)); return a; }

// ---- applying a finished rig -------------------------------------------------------------

function bonesOf(root) {
  const b = []; root.traverse((o) => { if (o.isBone && !(o.parent && o.parent.name === o.name)) b.push(o); });
  return b;
}

// Points (root space) -> bone map for a model with bones: { side, hand, chains: {key: {bones, tip}} } as node indices.
function mapToBones(root, pts, side) {
  root.updateMatrixWorld(true);
  const nodes = nodesOf(root); const idx = new Map(nodes.map((o, i) => [o, i]));
  const bones = bonesOf(root);
  const rootInv = root.matrixWorld.clone().invert();
  const head = bones.map((b) => b.getWorldPosition(new THREE.Vector3()).applyMatrix4(rootInv));
  const near = (p, avoid) => {
    let best = -1; let bd = Infinity;
    head.forEach((h, i) => { if (avoid.has(i)) return; const d = h.distanceTo(p); if (d < bd) { bd = d; best = i; } });
    return { i: best, d: bd };
  };
  const used = new Set(); const pick = {};
  const order = [0, 1, 2, 3, 5, 6, 7, 9, 10, 11, 13, 14, 15, 17, 18, 19];
  for (const k of order) { const n = near(pts[k], used); if (n.i < 0) throw new Error('뼈가 모자랍니다 (점 16개에 서로 다른 뼈 필요)'); pick[k] = n; used.add(n.i); }
  const palm = pts[0].distanceTo(pts[9]) || 1;
  const chains = {};
  for (const key of FINGER_KEYS) {
    const m = MP[key];
    const tipN = near(pts[m[3]], used);
    const tip = tipN.i >= 0 && tipN.d < 0.25 * palm ? tipN.i : -1;
    if (tip >= 0) used.add(tip);
    chains[key] = { bones: m.slice(0, 3).map((k) => idx.get(bones[pick[k].i])), tip: tip >= 0 ? idx.get(bones[tip]) : null };
  }
  const far = order.filter((k) => pick[k].d > 0.3 * palm).map((k) => POINTS[k][0]);
  return { side, hand: idx.get(bones[pick[0].i]), chains, far };
}

// Distance from p to segment a-b.
function segDist(p, a, b) {
  const ab = b.clone().sub(a); const t = Math.max(0, Math.min(1, p.clone().sub(a).dot(ab) / Math.max(ab.lengthSq(), 1e-12)));
  return p.distanceTo(a.clone().addScaledVector(ab, t));
}

// A model without bones: bones on the points (Mixamo names, so the app finds them), skin bound.
function buildSkeleton(root, pts, side) {
  root.updateMatrixWorld(true);
  const S = side === 'left' ? 'Left' : 'Right';
  const rootInv = root.matrixWorld.clone().invert();
  const hand = new THREE.Bone(); hand.name = `${S}Hand`; hand.position.copy(pts[0]);
  root.add(hand);
  const all = [hand]; const segs = []; // {bone index, a, b} in root space
  const at = new Map([[0, hand]]);
  for (const key of FINGER_KEYS) {
    const m = MP[key];
    let parent = hand; let parentPt = pts[0];
    m.forEach((k, j) => {
      const b = new THREE.Bone(); b.name = `${S}Hand${MIXAMO[key]}${j + 1}`;
      b.position.copy(pts[k]).sub(parentPt); // bones keep the world turn of the root (none)
      parent.add(b); all.push(b); at.set(k, b);
      segs.push({ bi: all.indexOf(parent), a: parentPt, b: pts[k] });
      parent = b; parentPt = pts[k];
    });
  }
  root.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(all);
  const meshes = []; root.traverse((o) => { if (o.isMesh && !o.isSkinnedMesh) meshes.push(o); });
  const palm = pts[0].distanceTo(pts[9]) || 1;
  for (const mesh of meshes) {
    const g = mesh.geometry.index ? mesh.geometry : mesh.geometry; // indexed or not, per vertex
    const pos = g.attributes.position; const n = pos.count;
    const toRoot = rootInv.clone().multiply(mesh.matrixWorld);
    const si = new Uint16Array(n * 4); const sw = new Float32Array(n * 4);
    const v = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(toRoot);
      const d = segs.map((s) => ({ bi: s.bi, d: segDist(v, s.a, s.b) }));
      // one weight per bone: its nearest segment
      const per = new Map(); for (const x of d) if (!per.has(x.bi) || per.get(x.bi) > x.d) per.set(x.bi, x.d);
      const list = [...per.entries()].map(([bi, dd]) => ({ bi, d: dd })).sort((a, b) => a.d - b.d).slice(0, 4);
      const d0 = list[0].d; const blend = Math.max(0.06 * palm, d0 * 0.5);
      let ws = list.map((x) => (x.d - d0 > blend ? 0 : Math.pow(1 - (x.d - d0) / blend, 2)));
      const sum = ws.reduce((a, b) => a + b, 0) || 1; ws = ws.map((w) => w / sum);
      list.forEach((x, k) => { si[i * 4 + k] = x.bi; sw[i * 4 + k] = ws[k]; });
    }
    const geo = g.clone();
    geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
    geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
    const sk = new THREE.SkinnedMesh(geo, mesh.material);
    sk.name = mesh.name; sk.position.copy(mesh.position); sk.quaternion.copy(mesh.quaternion); sk.scale.copy(mesh.scale);
    const parent = mesh.parent; parent.add(sk); parent.remove(mesh);
    mesh.children.slice().forEach((c) => sk.add(c));
    sk.updateMatrixWorld(true);
    sk.bind(skeleton, sk.matrixWorld);
    sk.frustumCulled = false;
  }
  return { built: all.length, meshes: meshes.length };
}

// Applies a rig to a loaded root. Returns { root (maybe changed in place), map | null, note }.
export function applyRig(root, rig) {
  const pts = rig.pts.map((p) => new THREE.Vector3(...p));
  const hasBones = bonesOf(root).length >= 16;
  if (hasBones) {
    const map = mapToBones(root, pts, rig.side);
    return { map, note: `리깅: 점 21개 → 기존 뼈에 연결${map.far.length ? ` (멀리 떨어진 점: ${map.far.join(', ')})` : ''}` };
  }
  const b = buildSkeleton(root, pts, rig.side);
  return { map: null, note: `리깅: 뼈 ${b.built}개 새로 만들고 메시 ${b.meshes}개에 피부 연결` };
}

// ---- the editor -----------------------------------------------------------------------

export function openEditor({ renderer, canvas, template, name, side, saved, onDone }) {
  let W = window.innerWidth; let H = window.innerHeight;
  Object.assign(canvas.style, { left: '0px', top: '0px', width: `${W}px`, height: `${H}px` });
  renderer.setSize(W, H, false);
  renderer.setClearColor(0x22262c, 1);
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.2); sun.position.set(0.3, 1, 0.6); scene.add(sun);
  const turn = new THREE.Group(); scene.add(turn);
  const model = SkeletonUtils.clone(template); turn.add(model);
  model.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3()).length() || 1; const center = box.getCenter(new THREE.Vector3());
  model.position.sub(center); // the model turns about its middle (points are kept in model space)
  const camera = new THREE.PerspectiveCamera(40, W / H, size / 200, size * 20);
  let dist = size * 1.4;
  // Look across the model's thinnest side (largest outline), e.g. at the palm of a flat hand.
  const ext = box.getSize(new THREE.Vector3());
  if (ext.x <= ext.y && ext.x <= ext.z) turn.rotation.y = Math.PI / 2;
  else if (ext.y <= ext.x && ext.y <= ext.z) turn.rotation.x = Math.PI / 2;
  const place = () => {}; camera.position.set(0, 0, dist); camera.lookAt(0, 0, 0);
  place();
  const meshes = []; model.traverse((o) => { if (o.isMesh) { meshes.push(o); o.frustumCulled = false; (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => { m.transparent = true; m.opacity = 0.6; m.side = THREE.DoubleSide; }); } });
  const marker = size * 0.012;
  const pts = Array(21).fill(null); const dots = Array(21).fill(null);
  const lines = new THREE.Group(); model.add(lines);
  let side0 = side || 'right';
  if (saved && saved.pts && saved.pts.length === 21) { saved.pts.forEach((p, i) => { pts[i] = new THREE.Vector3(...p); }); side0 = saved.side || side0; }
  let cur = pts.findIndex((p) => !p); if (cur < 0) cur = 0;
  const palmLen = () => (pts[0] && pts[9] ? pts[0].distanceTo(pts[9]) : 0);
  let framed = false; // zoom to the hand once the wrist and the middle root are placed
  const frameHand = () => {}; void framed;

  const tc = new TransformControls(camera, canvas);
  tc.setMode('translate'); tc.setSpace('world'); tc.setSize(0.9);
  scene.add(tc.getHelper());

  // UI over the canvas
  const ui = document.createElement('div');
  Object.assign(ui.style, { position: 'absolute', left: '0', right: '0', bottom: '0', padding: '8px', background: 'rgba(0,0,0,.6)', color: '#fff', font: '15px sans-serif', zIndex: 5 });
  const head = document.createElement('div'); Object.assign(head.style, { position: 'absolute', left: '0', right: '0', top: '0', padding: '8px', background: 'rgba(0,0,0,.6)', color: '#fff', font: '13px sans-serif', zIndex: 5 });
  head.innerHTML = '<b>점은 마디 중간이 아니라 관절(접히는 곳)에, 겉면이 아니라 손가락 두께 한가운데에 놓으세요.</b><br>' + '모델을 탭해서 점 놓기 · 화살표를 꾹 눌러 끌면 그 축으로 이동 · 빈 곳을 끌면 회전 · 두 손가락 벌리기=확대, 같이 밀기=화면 이동 · 화살표는 손가락보다 천천히(0.3배) 움직여요 · 놓은 점을 탭하면 그 점 고치기 · <b>오른쪽 예시에서 점을 눌러 찍을 점 고르기(순서 상관없음)</b>' + '<br>색: ' + FINGER_KO.map((n, k) => `<span style="color:${hex(COLORS[k])}">●</span>${n}`).join(' ');
  const label = document.createElement('div'); label.style.marginBottom = '6px';
  const row = document.createElement('div'); Object.assign(row.style, { display: 'flex', flexWrap: 'wrap', gap: '6px' });
  const btn = (t, f) => { const b = document.createElement('button'); b.textContent = t; Object.assign(b.style, { font: '15px sans-serif', padding: '8px 10px' }); b.onclick = f; row.appendChild(b); return b; };
  const guide = document.createElement('div'); Object.assign(guide.style, { position: 'absolute', right: '6px', top: '96px', zIndex: 5 });
  // tap a dot (or a name) in the example to choose which point to place/fix next: any order
  guide.addEventListener('pointerdown', (e) => { e.stopPropagation(); const t = e.target.closest('[data-i]'); if (t) select(+t.dataset.i); });
  ui.appendChild(label); ui.appendChild(row);
  document.body.appendChild(guide);
  document.body.appendChild(ui); document.body.appendChild(head);
  btn('◀ 이전', () => select((cur + 20) % 21));
  btn('다음 ▶', () => select((cur + 1) % 21));
  btn('화면 가운데로', () => { pan.set(0, 0, 0); });
  btn('이 점 지우기', () => { pts[cur] = null; redraw(); select(cur); });
  const sideBtn = btn('', () => { side0 = side0 === 'left' ? 'right' : 'left'; sideBtn.textContent = side0 === 'left' ? '모델: 왼손' : '모델: 오른손'; drawLines(); });
  sideBtn.textContent = side0 === 'left' ? '모델: 왼손' : '모델: 오른손';
  const doneBtn = btn('완료', () => finish(true));
  btn('취소', () => finish(false));

  function redraw() {
    dots.forEach((d) => d && model.remove(d));
    pts.forEach((p, i) => {
      if (!p) { dots[i] = null; return; }
      const m = new THREE.Mesh(new THREE.SphereGeometry((palmLen() > 0 ? Math.min(marker, palmLen() * 0.05) : marker) * (i === cur ? 1.5 : 1), 12, 8), new THREE.MeshBasicMaterial({ color: colorOf(i), depthTest: false }));
      m.renderOrder = 10; m.position.copy(p); m.userData.point = i; model.add(m); dots[i] = m;
    });
    drawLines();
  }
  function drawLines() {
    lines.clear();
    const seg = (a, b) => { if (!pts[a] || !pts[b]) return; const g = new THREE.BufferGeometry().setFromPoints([pts[a], pts[b]]); const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color: colorOf(b), depthTest: false })); l.renderOrder = 9; lines.add(l); };
    for (const key of FINGER_KEYS) { const m = MP[key]; seg(0, m[0]); seg(m[0], m[1]); seg(m[1], m[2]); seg(m[2], m[3]); }
    const n = pts.filter(Boolean).length;
    if (typeof guide !== 'undefined' && guide) { guide.innerHTML = guideSvg(cur, side0, pts); guide.style.top = (head.offsetHeight + 6) + 'px'; }
    if (!doneBtn) return;
    doneBtn.disabled = n < 21; doneBtn.textContent = `완료 (${n}/21)`;
  }
  function select(i) {
    cur = i; frameHand(); redraw();
    const [ko, en, where] = POINTS[i];
    guide.innerHTML = guideSvg(i, side0, pts); guide.style.top = (head.offsetHeight + 6) + 'px';
    label.innerHTML = `<div><span style="color:${hex(colorOf(i))};font-size:20px">●</span> <b>점 ${i}: ${ko}</b> <span style="opacity:.7">${en}</span>${pts[i] ? ' · 놓임 (화살표로 조정, 다시 탭하면 옮김)' : ' · 모델을 탭하세요'}<br><span style="font-size:13px;opacity:.9">위치: ${where}</span></div>`;
    if (pts[i] && dots[i]) tc.attach(dots[i]); else tc.detach();
  }
  // Arrow drags move the point at FINE x the finger (the plain gizmo felt far too fast on a zoomed-in hand),
  // and the view stays still while dragging (it used to chase the moving point, which sped the drag up).
  const FINE = 0.3; const dragStart = new THREE.Vector3();
  tc.addEventListener('mouseDown', () => { if (tc.object) dragStart.copy(tc.object.position); });
  tc.addEventListener('objectChange', () => {
    const i = tc.object && tc.object.userData.point; if (i == null) return;
    if (tc.dragging) tc.object.position.sub(dragStart).multiplyScalar(FINE).add(dragStart);
    pts[i].copy(tc.object.position); drawLines();
  });

  // Touch: tap = place / pick, one finger drag = turn, two fingers = zoom (unless on an arrow).
  const ray = new THREE.Raycaster(); const ndc = new THREE.Vector2();
  const pan = new THREE.Vector3(); let mid0 = null; const pan0 = new THREE.Vector3();
  const down = new Map(); let pinch0 = 0; let dist0 = dist; let moved = false; let t0 = 0; let last = null; let gizmo = false;
  const onDown = (e) => {
    down.set(e.pointerId, [e.clientX, e.clientY]);
    if (down.size === 1) gizmo = !!(tc.dragging || tc.axis);
    if (gizmo) return;
    moved = false; t0 = performance.now(); last = [e.clientX, e.clientY];
    if (down.size === 2) { const [a, b] = [...down.values()]; pinch0 = Math.hypot(a[0] - b[0], a[1] - b[1]); dist0 = dist; mid0 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; pan0.copy(pan); moved = true; }
  };
  const onMove = (e) => {
    if (!down.has(e.pointerId)) return;
    down.set(e.pointerId, [e.clientX, e.clientY]);
    if (gizmo || tc.dragging) return;
    if (down.size === 2) { const [a, b] = [...down.values()]; const d = Math.hypot(a[0] - b[0], a[1] - b[1]); if (pinch0 > 0) { dist = Math.max(size * 0.01, Math.min(size * 6, dist0 * pinch0 / d)); }
      // both fingers moving together = slide the view (pan), screen-plane, 1:1 with the fingers
      if (mid0) {
        const k = 2 * dist * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / H;
        const mx = (a[0] + b[0]) / 2 - mid0[0], my = (a[1] + b[1]) / 2 - mid0[1];
        pan.copy(pan0).add(new THREE.Vector3(-mx * k, my * k, 0));
      }
      moved = true; last = null; return; }
    if (!last) { last = [e.clientX, e.clientY]; return; }
    const dx = e.clientX - last[0]; const dy = e.clientY - last[1];
    if (Math.abs(dx) + Math.abs(dy) > 2) moved = moved || Math.hypot(e.clientX - last[0], e.clientY - last[1]) > 6;
    if (moved) {
      turn.rotation.y += dx * 0.01; turn.rotation.x = Math.max(-1.5, Math.min(1.5, turn.rotation.x + dy * 0.01));
      last = [e.clientX, e.clientY];
    }
  };
  const onUp = (e) => {
    const was = down.size; down.delete(e.pointerId); if (down.size < 2) mid0 = null;
    if (gizmo || tc.dragging) { if (!down.size) gizmo = false; last = null; return; }
    if (was === 1 && !moved && performance.now() - t0 < 500) tap(e.clientX, e.clientY);
    last = null;
  };
  canvas.addEventListener('pointerdown', onDown); canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp); canvas.addEventListener('pointercancel', onUp);
  canvas.style.touchAction = 'none';

  function tap(x, y) {
    ndc.set((x / W) * 2 - 1, -(y / H) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    // a placed point under the finger: fix that one
    const hitDot = ray.intersectObjects(dots.filter(Boolean), false)[0];
    const near = dots.filter(Boolean).map((d) => ({ d, s: d.getWorldPosition(new THREE.Vector3()).project(camera) })).map(({ d, s }) => ({ d, px: Math.hypot((s.x - ndc.x) * W / 2, (s.y - ndc.y) * H / 2) })).sort((a, b) => a.px - b.px)[0];
    if (hitDot || (near && near.px < 18)) { select((hitDot ? hitDot.object : near.d).userData.point); return; }
    const hits = ray.intersectObjects(meshes, false);
    if (!hits.length) return;
    const a = hits[0].point; let b = null;
    for (const h of hits.slice(1)) if (h.distance - hits[0].distance > size * 0.002) { b = h.point; break; }
    const w = b ? a.clone().add(b).multiplyScalar(0.5) : a.clone().addScaledVector(ray.ray.direction, size * 0.01);
    pts[cur] = model.worldToLocal(w.clone());
    select(cur);
  }

  let raf = 0;
  // The view orbits the point being placed (once placed), so a zoomed-in finger stays in view.
  const target = new THREE.Vector3(); const want = new THREE.Vector3();
  const loop = () => {
    // the view only changes when the user turns / pans / zooms (it used to chase the selected point and zoom by itself)
    const at = target.clone().add(pan); camera.position.set(at.x, at.y, at.z + dist); camera.lookAt(at);
    renderer.render(scene, camera); raf = requestAnimationFrame(loop);
  };
  const onResize = () => { W = window.innerWidth; H = window.innerHeight; Object.assign(canvas.style, { width: `${W}px`, height: `${H}px` }); renderer.setSize(W, H, false); camera.aspect = W / H; camera.updateProjectionMatrix(); };
  window.addEventListener('resize', onResize);
  loop();
  select(cur);

  function finish(ok) {
    cancelAnimationFrame(raf); window.removeEventListener('resize', onResize);
    tc.detach(); tc.dispose();
    canvas.removeEventListener('pointerdown', onDown); canvas.removeEventListener('pointermove', onMove);
    canvas.removeEventListener('pointerup', onUp); canvas.removeEventListener('pointercancel', onUp);
    ui.remove(); head.remove(); guide.remove();
    renderer.setClearColor(0x000000, 0);
      const out = ok ? { side: side0, pts: pts.map((p) => p.toArray()) } : null; // model (template root) space
    onDone(out);
  }
  // test hooks
  return {
    setPoint: (i, p) => { pts[i] = new THREE.Vector3(...p); select(i); },
    tap,
    dist: () => dist,
    screenOf: (i) => { scene.updateMatrixWorld(true); const v = pts[i].clone().applyMatrix4(model.matrixWorld).project(camera); return [(v.x + 1) / 2 * W, (1 - v.y) / 2 * H]; },
    local: (i) => pts[i].toArray(),
    pan: () => pan.toArray(),
    setSide: (v) => { side0 = v; sideBtn.textContent = side0 === 'left' ? '모델: 왼손' : '모델: 오른손'; },
    finish,
  };
}
