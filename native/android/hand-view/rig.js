// "리깅 잡기": the user marks MediaPipe's 21 hand points on a loaded skin, by name, in the app.
//  - tap the model: the point goes inside the finger (middle between where the tap ray enters
//    and leaves the skin); X / Y / Z arrows on the point move it along one axis (press and drag);
//    drag elsewhere turns the model, two fingers zoom; tap a placed point to fix it again.
//  - with all 21 points:
//    * a model with bones: each point takes the nearest bone (bone head), so a rig whose bone
//      names the app does not know can be driven (map kept per model file);
//    * a model without bones (AI meshes): bones are made on the points (Mixamo names) and the
//      skin is bound to them (weights by distance along the skin, weights.js).
import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { surfaceWeights } from './weights.js';

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
// the 11 points placed by hand (wrist, 5 roots, 5 tips); middle joints are automatic (v0.59)
const HAND_TAP = [0, 1, 4, 5, 8, 9, 12, 13, 16, 17, 20];
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
  for (const key of FINGER_KEYS) { const m = MP[key]; ln(0, m[0]); ln(m[0], m[3]); } // middle joints are automatic: root -> tip
  ln(5, 9); ln(9, 13); ln(13, 17);
  for (const i of HAND_TAP) {
    const [x, y] = P(i); const on = i === cur;
    const c = hex(colorOf(i));
    g += `<circle cx="${x}" cy="${y}" r="${on ? 7 : 4.5}" fill="${placed[i] ? c : '#222'}" stroke="${on ? '#fff' : c}" stroke-width="${on ? 2.5 : 1.5}"/>`;
    g += `<circle data-i="${i}" cx="${x}" cy="${y}" r="11" fill="transparent"/>`;
    g += `<text pointer-events="none" x="${x + 6}" y="${y - 5}" fill="${on ? '#fff' : '#bbb'}" font-size="${on ? 12 : 9}">${i}</text>`;
  }
  g += `<text x="4" y="${H - 4}" fill="#aaa" font-size="8">MediaPipe 예시 (손바닥) · 채움=놓음</text></svg>`;
  // names of the current finger's points (wrist + its 4), same colours as the dots
  const f = cur === 0 ? -1 : Math.floor((cur - 1) / 4);
  const ids = f < 0 ? [0, 1, 5, 9, 13, 17] : [1, 4].map((k) => f * 4 + k);
  const names = ids.map((i) => `<div data-i="${i}" style="padding:2px 0;color:${hex(colorOf(i))};${i === cur ? 'font-weight:bold;font-size:13px' : 'opacity:.85'}">● ${i} ${POINTS[i][0]} <span style="opacity:.6">${POINTS[i][1]}</span></div>`).join('');
  return `<div style="background:rgba(0,0,0,.55);border-radius:8px;padding:4px;font:11px sans-serif;color:#fff">${g}${names}</div>`;
}

// Every object of a model in traverse order (a clone has the same order: maps are kept as indices).
export function nodesOf(root) { const a = []; root.traverse((o) => a.push(o)); return a; }

// ---- applying a finished rig -------------------------------------------------------------

function bonesOf(root) {
  const b = []; root.traverse((o) => { if (o.isBone && !(o.parent && o.parent.name === o.name)) b.push(o); });
  return b;
}

// Points (root space) -> bone map using the bone TREE: the hand bone is a branching bone near the
// wrist point, each finger takes one branch under it, and its 3 points match 3 bones in a row on
// that branch (best fit over all finger-to-branch choices). Plain nearest-bone matching put the
// wrist on the thumb root and swapped fingers once the points were ~20 % of a bone off (v0.45).
function mapByTree(root, pts, side) {
  root.updateMatrixWorld(true);
  const nodes = nodesOf(root); const idx = new Map(nodes.map((o, i) => [o, i]));
  const rootInv = root.matrixWorld.clone().invert();
  const at = (b) => b.getWorldPosition(new THREE.Vector3()).applyMatrix4(rootInv);
  const isB = (o) => o.isBone && !(o.parent && o.parent.name === o.name);
  const kidsOf = (o) => o.children.filter(isB);
  const size = (o) => { let n = 0; o.traverse((c) => { if (isB(c)) n++; }); return n; };
  // a branch = the path down from a child bone, always into its biggest sub-tree
  const chainFrom = (o) => { const c = [o]; let k = kidsOf(o); while (k.length) { k.sort((a, b) => size(b) - size(a)); c.push(k[0]); k = kidsOf(k[0]); } return c; };
  const palm = pts[0].distanceTo(pts[9]) || 1;
  const bones = bonesOf(root);
  // hand candidates: bones with >= 5 bone branches within 2 levels (metacarpal bones in between are fine)
  const branchesOf = (h) => { const out = []; for (const k of kidsOf(h)) { const kk = kidsOf(k); if (kk.length >= 2 && size(k) >= 6) kk.forEach((x) => out.push(x)); else out.push(k); } return out; };
  let best = null;
  for (const h of bones) {
    const br = branchesOf(h).filter((b) => size(b) >= 2);
    if (br.length < 5 || br.length > 9) continue;
    const dh = at(h).distanceTo(pts[0]); if (dh > 1.2 * palm) continue;
    const chains = br.map(chainFrom).map((c) => ({ c, p: c.map(at) }));
    // cost of finger f on branch j: best 3 bones in a row against its 3 points
    const fit = FINGER_KEYS.map((key) => chains.map((ch) => {
      const m = MP[key]; let bc = Infinity; let bo = 0;
      for (let o = 0; o + 3 <= ch.c.length; o++) { let c = 0.15 * palm * o; for (let k = 0; k < 3; k++) c += ch.p[o + k].distanceTo(pts[m[k]]); if (c < bc) { bc = c; bo = o; } } // a slight pull to the branch's first bone: points half a bone off pick the start, a real metacarpal is a whole bone off
      return { c: bc, o: bo };
    }));
    // all ways to give the 5 fingers different branches
    let bestPerm = null; let bestCost = Infinity;
    const used = new Array(chains.length).fill(false); const perm = [];
    const go = (f, cost) => {
      if (cost >= bestCost) return;
      if (f === 5) { bestCost = cost; bestPerm = perm.slice(); return; }
      for (let j = 0; j < chains.length; j++) if (!used[j] && fit[f][j].c < Infinity) { used[j] = true; perm.push(j); go(f + 1, cost + fit[f][j].c); perm.pop(); used[j] = false; }
    };
    go(0, 0);
    if (!bestPerm) continue;
    const total = bestCost + dh;
    if (!best || total < best.total) best = { total, h, chains, fit, perm: bestPerm };
  }
  if (!best) return null;
  const chains = {}; const far = [];
  FINGER_KEYS.forEach((key, f) => {
    const j = best.perm[f]; const { c, p } = best.chains[j]; const o = best.fit[f][j].o; const m = MP[key];
    const tip = c[o + 3] && p[o + 3].distanceTo(pts[m[3]]) < 0.25 * palm ? idx.get(c[o + 3]) : null;
    chains[key] = { bones: [0, 1, 2].map((k) => idx.get(c[o + k])), tip };
    [0, 1, 2].forEach((k) => { if (p[o + k].distanceTo(pts[m[k]]) > 0.3 * palm) far.push(POINTS[m[k]][0]); });
  });
  if (at(best.h).distanceTo(pts[0]) > 0.3 * palm) far.unshift(POINTS[0][0]);
  return { side, hand: idx.get(best.h), chains, far, by: 'tree' };
}

// Points (root space) -> bone map for a model with bones: { side, hand, chains: {key: {bones, tip}} } as node indices.
function mapToBones(root, pts, side) {
  const tree = mapByTree(root, pts, side);
  if (tree) return tree;
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

// Skin weights of one mesh (root space): surface distance (weights.js); window.HMS_OLDWEIGHT = the
// old straight-line nearest bone (kept for comparison tests).
function skinWeights(pos, index, toRoot, segs, scale) {
  const n = pos.count; const p = new Float32Array(n * 3); const v = new THREE.Vector3();
  for (let i = 0; i < n; i++) { v.fromBufferAttribute(pos, i).applyMatrix4(toRoot); p[3 * i] = v.x; p[3 * i + 1] = v.y; p[3 * i + 2] = v.z; }
  if (!window.HMS_OLDWEIGHT) {
    const t0 = performance.now(); const r = surfaceWeights(p, index ? index.array : null, segs, scale);
    window.lastWeights = { ...r.stats, ms: Math.round(performance.now() - t0) };
    return r;
  }
  const si = new Uint16Array(n * 4); const sw = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    v.set(p[3 * i], p[3 * i + 1], p[3 * i + 2]);
    const per = new Map(); for (const sg of segs) { const dd = segDist(v, sg.a, sg.b); if (!per.has(sg.bi) || per.get(sg.bi) > dd) per.set(sg.bi, dd); }
    const list = [...per.entries()].map(([bi, dd]) => ({ bi, d: dd })).sort((a, b) => a.d - b.d).slice(0, 4);
    const d0 = list[0].d; const blend = Math.max(0.06 * scale, d0 * 0.5);
    let ws = list.map((x) => (x.d - d0 > blend ? 0 : Math.pow(1 - (x.d - d0) / blend, 2)));
    const sum = ws.reduce((a, b) => a + b, 0) || 1; ws = ws.map((w) => w / sum);
    list.forEach((x, k) => { si[i * 4 + k] = x.bi; sw[i * 4 + k] = ws[k]; });
  }
  return { si, sw };
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
    const { si, sw } = skinWeights(pos, g.index, toRoot, segs, palm);
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

// ---- body (MediaPipe Pose) and free points --------------------------------------------------

// MediaPipe Pose points the body skin uses: [Pose index, 한국어, ENGLISH, where, role key].
// "left" = the PERSON's (the model's own) left, as MediaPipe names it.
export const BODY_POINTS = [
  [0, '코', 'NOSE', '코끝. 머리가 어디를 보는지 잡는 점 (얼굴 겉면이어도 괜찮아요)', 'nose'],
  [7, '왼쪽 귀', 'LEFT_EAR', '모델 자신의 왼쪽 귀 구멍, 머리 두께 안쪽', 'lEar'],
  [8, '오른쪽 귀', 'RIGHT_EAR', '모델 자신의 오른쪽 귀 구멍, 머리 두께 안쪽', 'rEar'],
  [11, '왼쪽 어깨', 'LEFT_SHOULDER', '왼팔이 몸통에 붙는 관절 중심 (어깨 두께 한가운데)', 'lSh'],
  [12, '오른쪽 어깨', 'RIGHT_SHOULDER', '오른팔이 몸통에 붙는 관절 중심', 'rSh'],
  [13, '왼쪽 팔꿈치', 'LEFT_ELBOW', '왼팔이 접히는 팔꿈치 관절 중심', 'lEl'],
  [14, '오른쪽 팔꿈치', 'RIGHT_ELBOW', '오른팔 팔꿈치 관절 중심', 'rEl'],
  [15, '왼쪽 손목', 'LEFT_WRIST', '왼손목 주름 한가운데', 'lWr'],
  [16, '오른쪽 손목', 'RIGHT_WRIST', '오른손목 주름 한가운데', 'rWr'],
  [23, '왼쪽 엉덩이', 'LEFT_HIP', '왼다리가 골반에 붙는 고관절. 허벅지 뿌리 한가운데 (사타구니 옆)', 'lHip'],
  [24, '오른쪽 엉덩이', 'RIGHT_HIP', '오른다리 고관절. 허벅지 뿌리 한가운데', 'rHip'],
  [25, '왼쪽 무릎', 'LEFT_KNEE', '왼무릎이 접히는 관절 중심 (무릎뼈 안쪽)', 'lKn'],
  [26, '오른쪽 무릎', 'RIGHT_KNEE', '오른무릎 관절 중심', 'rKn'],
  [27, '왼쪽 발목', 'LEFT_ANKLE', '왼발목 관절 중심 (복사뼈 높이)', 'lAn'],
  [28, '오른쪽 발목', 'RIGHT_ANKLE', '오른발목 관절 중심', 'rAn'],
  [31, '왼쪽 발끝', 'LEFT_FOOT_INDEX', '왼발 엄지발가락 끝', 'lFt'],
  [32, '오른쪽 발끝', 'RIGHT_FOOT_INDEX', '오른발 엄지발가락 끝', 'rFt'],
];
const B = Object.fromEntries(BODY_POINTS.map((p, i) => [p[4], i]));
const BODY_SEGS = [['lEar', 'nose'], ['rEar', 'nose'], ['lSh', 'rSh'], ['lSh', 'lEl'], ['lEl', 'lWr'], ['rSh', 'rEl'], ['rEl', 'rWr'],
  ['lSh', 'lHip'], ['rSh', 'rHip'], ['lHip', 'rHip'], ['lHip', 'lKn'], ['lKn', 'lAn'], ['lAn', 'lFt'], ['rHip', 'rKn'], ['rKn', 'rAn'], ['rAn', 'rFt']]
  .map(([a, b]) => [B[a], B[b]]);
// colours: head white, left arm orange, right arm blue, left leg red, right leg purple
const BODY_PART = ['head', 'head', 'head', 'la', 'ra', 'la', 'ra', 'la', 'ra', 'll', 'rl', 'll', 'rl', 'll', 'rl', 'll', 'rl'];
const BODY_COL = { head: 0xffffff, la: 0xffb02e, ra: 0x3fa9ff, ll: 0xff5a5a, rl: 0xc77dff };
const BODY_KO = { head: '머리', la: '왼팔', ra: '오른팔', ll: '왼다리', rl: '오른다리' };
const bodyColor = (i) => BODY_COL[BODY_PART[i]];
// front view (the person faces you: their LEFT is on your right)
const BODY_GUIDE = [[.50,.08],[.57,.07],[.43,.07],[.65,.22],[.35,.22],[.74,.37],[.26,.37],[.80,.51],[.20,.51],
  [.58,.52],[.42,.52],[.60,.71],[.40,.71],[.60,.89],[.40,.89],[.66,.96],[.34,.96]];
function bodyGuideSvg(cur, placed) {
  const W = 100, H = 170, P = (i) => [BODY_GUIDE[i][0] * W, BODY_GUIDE[i][1] * H];
  let g = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="background:rgba(255,255,255,.08);border-radius:8px">`;
  for (const [a, b] of BODY_SEGS) { const [x1, y1] = P(a), [x2, y2] = P(b); g += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${hex(bodyColor(b))}" stroke-width="2" opacity=".7"/>`; }
  for (let i = 0; i < BODY_POINTS.length; i++) {
    const [x, y] = P(i); const on = i === cur; const c = hex(bodyColor(i));
    g += `<circle cx="${x}" cy="${y}" r="${on ? 7 : 4.5}" fill="${placed[i] ? c : '#222'}" stroke="${on ? '#fff' : c}" stroke-width="${on ? 2.5 : 1.5}"/>`;
    g += `<circle data-i="${i}" cx="${x}" cy="${y}" r="10" fill="transparent"/>`;
    g += `<text pointer-events="none" x="${x + 6}" y="${y - 4}" fill="${on ? '#fff' : '#bbb'}" font-size="${on ? 11 : 8}">${BODY_POINTS[i][0]}</text>`;
  }
  g += `<text x="3" y="${H - 3}" fill="#aaa" font-size="8">Pose 예시 (정면) · 채움=놓음</text></svg>`;
  const part = BODY_PART[cur];
  const names = BODY_POINTS.map((p, i) => i).filter((i) => BODY_PART[i] === part).map((i) => `<div data-i="${i}" style="padding:2px 0;color:${hex(bodyColor(i))};${i === cur ? 'font-weight:bold;font-size:13px' : 'opacity:.85'}">● ${BODY_POINTS[i][0]} ${BODY_POINTS[i][1]} <span style="opacity:.6">${BODY_POINTS[i][2]}</span></div>`).join('');
  return `<div style="background:rgba(0,0,0,.55);border-radius:8px;padding:4px;font:11px sans-serif;color:#fff">${g}${names}</div>`;
}
const FREE_COL = [0xffffff, 0xff5a5a, 0xffb02e, 0x4cd964, 0x3fa9ff, 0xc77dff, 0xffe14d, 0x4de1d2];
function freeGuideHtml(cur, pts, parents) {
  const rows = pts.map((p, i) => `<div data-i="${i}" style="padding:3px 2px;color:${hex(FREE_COL[i % FREE_COL.length])};${i === cur ? 'font-weight:bold;font-size:13px;background:rgba(255,255,255,.12)' : 'opacity:.85'}">● 점 ${i + 1}${parents[i] >= 0 ? ` ← 점 ${parents[i] + 1}` : ' (뿌리)'}${p ? '' : ' · 비어 있음'}</div>`).join('');
  return `<div style="background:rgba(0,0,0,.55);border-radius:8px;padding:6px;font:12px sans-serif;color:#fff;max-height:45vh;overflow:auto;min-width:120px">자유 점 (누르면 선택)<br>${rows}</div>`;
}

// Bones on given places (root space) with a parent per bone, and the skin bound to them (each
// vertex to its nearest bone segments; a bone owns the segments to its children; a leaf its point).
function bindBones(root, defs, scale) {
  root.updateMatrixWorld(true);
  const rootInv = root.matrixWorld.clone().invert();
  const all = defs.map((d) => { const b = new THREE.Bone(); b.name = d.name; return b; });
  defs.forEach((d, i) => {
    const pp = d.parent >= 0 ? defs[d.parent].at : new THREE.Vector3();
    all[i].position.copy(d.at).sub(pp);
    (d.parent >= 0 ? all[d.parent] : root).add(all[i]);
  });
  const segs = [];
  defs.forEach((d, i) => { const kids = defs.map((c, j) => (c.parent === i ? j : -1)).filter((j) => j >= 0); if (kids.length) kids.forEach((j) => segs.push({ bi: i, a: d.at, b: defs[j].at })); else segs.push({ bi: i, a: d.at, b: d.tail || d.at }); });
  root.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(all);
  const meshes = []; root.traverse((o) => { if (o.isMesh && !o.isSkinnedMesh) meshes.push(o); });
  for (const mesh of meshes) {
    const g = mesh.geometry; const pos = g.attributes.position; const n = pos.count;
    const toRoot = rootInv.clone().multiply(mesh.matrixWorld);
    const { si, sw } = skinWeights(pos, g.index, toRoot, segs, scale);
    const geo = g.clone();
    geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
    geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
    const sk = new THREE.SkinnedMesh(geo, mesh.material);
    sk.name = mesh.name; sk.position.copy(mesh.position); sk.quaternion.copy(mesh.quaternion); sk.scale.copy(mesh.scale);
    const parent = mesh.parent; parent.add(sk); parent.remove(mesh);
    mesh.children.slice().forEach((c) => sk.add(c));
    sk.updateMatrixWorld(true); sk.bind(skeleton, sk.matrixWorld); sk.frustumCulled = false;
  }
  return { built: all.length, meshes: meshes.length };
}

const mid = (a, b, t = 0.5) => a.clone().lerp(b, t);
// Body rig: places of the humanoid roles from the Pose points (root space).
function bodyPlaces(p) {
  const hips = mid(p[B.lHip], p[B.rHip]); const neck = mid(p[B.lSh], p[B.rSh]);
  const ears = mid(p[B.lEar], p[B.rEar]);
  return { hips, spine: mid(hips, neck, 0.35), chest: mid(hips, neck, 0.7), neck, head: mid(neck, ears, 0.55), top: ears.clone().add(ears.clone().sub(neck).multiplyScalar(0.6)), torso: hips.distanceTo(neck) || 1 };
}
// A model with bones: each role takes the nearest bone (limbs first) -> VRM-style role map (nodes).
function mapBodyBones(root, p) {
  root.updateMatrixWorld(true);
  const bones = bonesOf(root); const rootInv = root.matrixWorld.clone().invert();
  const head = bones.map((b) => b.getWorldPosition(new THREE.Vector3()).applyMatrix4(rootInv));
  const used = new Set(); const map = {}; const far = [];
  const P = bodyPlaces(p);
  const take = (role, at, label) => {
    let best = -1; let bd = Infinity;
    head.forEach((h, i) => { if (!used.has(i)) { const d = h.distanceTo(at); if (d < bd) { bd = d; best = i; } } });
    if (best < 0) return; used.add(best); map[role] = bones[best];
    if (bd > 0.25 * P.torso) far.push(label);
  };
  for (const [s, w, k] of [['l', 'left', '왼'], ['r', 'right', '오른']]) {
    take(`${w}UpperArm`, p[B[`${s}Sh`]], `${k}쪽 어깨`); take(`${w}LowerArm`, p[B[`${s}El`]], `${k}쪽 팔꿈치`); take(`${w}Hand`, p[B[`${s}Wr`]], `${k}쪽 손목`);
    take(`${w}UpperLeg`, p[B[`${s}Hip`]], `${k}쪽 엉덩이`); take(`${w}LowerLeg`, p[B[`${s}Kn`]], `${k}쪽 무릎`); take(`${w}Foot`, p[B[`${s}An`]], `${k}쪽 발목`);
  }
  take('hips', P.hips, '골반'); take('head', P.head, '머리');
  // neck: on the head's own chain (the nearest bone to the shoulder middle is often a collarbone)
  if (map.head) {
    let o = map.head.parent; let best = null; let bd = Infinity;
    while (o && o !== map.hips) { if (o.isBone) { const d = o.getWorldPosition(new THREE.Vector3()).applyMatrix4(rootInv).distanceTo(P.neck); if (d < bd) { bd = d; best = o; } } o = o.parent; }
    if (best) map.neck = best; else take('neck', P.neck, '목');
  } else take('neck', P.neck, '목');
  // spine bones: between hips and neck on the bone tree
  if (map.hips && map.neck) {
    const path = []; let o = map.neck.parent;
    while (o && o !== map.hips) { if (o.isBone) path.unshift(o); o = o.parent; }
    if (o === map.hips) { const roles = ['spine', 'chest', 'upperChest']; path.slice(0, 3).forEach((b, i) => { map[roles[i]] = b; }); }
  }
  return { map, far };
}
// A model without bones: humanoid bones on the points (Mixamo names, so the body code finds them).
function buildBody(root, p) {
  const P = bodyPlaces(p);
  const d = []; const add = (name, at, parent, tail) => { d.push({ name, at: at.clone(), parent, tail }); return d.length - 1; };
  const hips = add('Hips', P.hips, -1); const spine = add('Spine', P.spine, hips); const chest = add('Spine1', P.chest, spine);
  const neck = add('Neck', P.neck, chest); add('Head', P.head, neck, P.top);
  for (const [s, w] of [['l', 'Left'], ['r', 'Right']]) {
    const up = add(`${w}Arm`, p[B[`${s}Sh`]], chest); const lo = add(`${w}ForeArm`, p[B[`${s}El`]], up);
    const wr = p[B[`${s}Wr`]]; add(`${w}Hand`, wr, lo, wr.clone().add(wr.clone().sub(p[B[`${s}El`]]).multiplyScalar(0.35)));
    const ul = add(`${w}UpLeg`, p[B[`${s}Hip`]], hips); const ll = add(`${w}Leg`, p[B[`${s}Kn`]], ul);
    const ft = add(`${w}Foot`, p[B[`${s}An`]], ll); add(`${w}ToeBase`, p[B[`${s}Ft`]], ft);
  }
  return bindBones(root, d, P.torso);
}
// Applies a body rig: { map: VRM-style role map | null (bones made: found by name), note }.
export function applyBodyRig(root, rig) {
  const p = rig.pts.map((q) => new THREE.Vector3(...q));
  if (bonesOf(root).length >= 8) {
    const r = mapBodyBones(root, p);
    if (typeof window !== 'undefined') window.lastBodyRig = Object.fromEntries(Object.entries(r.map).map(([k, b]) => [k, b.name]));
    return { map: r.map, note: `몸 리깅: Pose 점 17개 → 기존 뼈에 연결${r.far.length ? ` (멀리 떨어진 점: ${r.far.join(', ')})` : ''}` };
  }
  const b = buildBody(root, p);
  return { map: null, note: `몸 리깅: 몸 뼈 ${b.built}개 새로 만들고 메시 ${b.meshes}개에 피부 연결` };
}
// Free rig: bones on the user's points (parent = the point it was added from), skin bound.
export function applyFreeRig(root, rig) {
  const at = rig.pts.map((q) => (q ? new THREE.Vector3(...q) : null));
  const keep = at.map((q, i) => i).filter((i) => at[i]);
  const idx = new Map(keep.map((i, k) => [i, k]));
  const up = (i) => { let q = rig.parents[i]; while (q >= 0 && !at[q]) q = rig.parents[q]; return q; };
  const defs = keep.map((i) => ({ name: `Bone_${i + 1}`, at: at[i], parent: up(i) >= 0 ? idx.get(up(i)) : -1 }));
  // several roots: hang them under the first one
  defs.forEach((d, k) => { if (k > 0 && d.parent < 0) d.parent = 0; });
  const box = new THREE.Box3().setFromObject(root); const scale = box.getSize(new THREE.Vector3()).length() * 0.2 || 1;
  const b = bindBones(root, defs, scale);
  return { note: `기타 리깅: 뼈 ${b.built}개, 메시 ${b.meshes}개에 피부 연결`, built: b.built };
}

// Applies a rig to a loaded root. Returns { root (maybe changed in place), map | null, note }.
export function applyRig(root, rig) {
  const pts = rig.pts.map((p) => new THREE.Vector3(...p));
  const hasBones = bonesOf(root).length >= 16;
  if (hasBones) {
    const map = mapToBones(root, pts, rig.side);
    if (typeof window !== 'undefined') { const nd = nodesOf(root); window.lastHandRig = { hand: nd[map.hand].name, ...Object.fromEntries(Object.entries(map.chains).map(([k, c]) => [k, c.bones.map((i) => nd[i].name).concat(c.tip != null ? ['tip:' + nd[c.tip].name] : [])])) }; }
    return { map, note: `리깅: 점 21개 → 기존 뼈에 연결${map.far.length ? ` (멀리 떨어진 점: ${map.far.join(', ')})` : ''}` };
  }
  const b = buildSkeleton(root, pts, rig.side);
  return { map: null, note: `리깅: 뼈 ${b.built}개 새로 만들고 메시 ${b.meshes}개에 피부 연결` };
}

// ---- the editor -----------------------------------------------------------------------

export function openEditor({ renderer, canvas, template, name, side, saved, onDone, kind = 'hand' }) {
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
  // landscape: the right 300 px hold the buttons, so the view centres the model in the rest
  const offsetView = () => {}; // v0.63 right column is gone (buttons at the bottom again)
  offsetView();
  let dist = size * 1.4;
  // Look across the model's thinnest side (largest outline), e.g. at the palm of a flat hand.
  const ext = box.getSize(new THREE.Vector3());
  if (ext.x <= ext.y && ext.x <= ext.z) turn.rotation.y = Math.PI / 2;
  else if (ext.y <= ext.x && ext.y <= ext.z) turn.rotation.x = Math.PI / 2;
  const place = () => {}; camera.position.set(0, 0, dist); camera.lookAt(0, 0, 0);
  place();
  const meshes = []; model.traverse((o) => { if (o.isMesh) { meshes.push(o); o.frustumCulled = false; (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => { m.transparent = true; m.opacity = 0.6; m.side = THREE.DoubleSide; }); } });
  const marker = size * 0.006; // half of v0.43 (user)
  const N0 = kind === 'body' ? BODY_POINTS.length : kind === 'free' ? 1 : 21;
  const pts = Array(N0).fill(null); const dots = Array(N0).fill(null);
  const parents = kind === 'free' ? [-1] : null; // free: each point hangs from the one it was added from
  const N = () => pts.length;
  const lines = new THREE.Group(); model.add(lines);
  let side0 = side || 'right';
  if (kind === 'free' && saved && saved.pts && saved.parents && saved.pts.length) {
    pts.length = 0; dots.length = 0; parents.length = 0;
    saved.pts.forEach((p, i) => { pts.push(p ? new THREE.Vector3(...p) : null); dots.push(null); parents.push(saved.parents[i]); });
  } else if (saved && saved.pts && saved.pts.length === N0) { saved.pts.forEach((p, i) => { pts[i] = new THREE.Vector3(...p); }); side0 = saved.side || side0; }
  // per kind: colour, lines, how big the markers can be, the example panel, the point's text
  const colorAt = (i) => (kind === 'body' ? bodyColor(i) : kind === 'free' ? FREE_COL[i % FREE_COL.length] : colorOf(i));
  const segList = () => {
    if (kind === 'body') return BODY_SEGS;
    if (kind === 'free') return parents.map((q, i) => [q, i]).filter(([q]) => q >= 0);
    const a = []; for (const key of FINGER_KEYS) { const m = MP[key]; a.push([0, m[0]], [m[0], m[1]], [m[1], m[2]], [m[2], m[3]]); } return a;
  };
  const refLen = () => {
    if (kind === 'body') return pts[B.lSh] && pts[B.lHip] ? pts[B.lSh].distanceTo(pts[B.lHip]) * 0.5 : 0;
    if (kind === 'free') return 0;
    return pts[0] && pts[9] ? pts[0].distanceTo(pts[9]) : 0;
  };
  const panelHtml = () => (kind === 'body' ? bodyGuideSvg(cur, pts) : kind === 'free' ? freeGuideHtml(cur, pts, parents) : guideSvg(cur, side0, pts));
  const need = () => (kind === 'free' ? 2 : N());
  const pointText = (i) => {
    if (kind === 'body') { const [k, ko, en, where] = BODY_POINTS[i]; return { title: `점 ${k}: ${ko}`, en, where }; }
    if (kind === 'free') return { title: `점 ${i + 1}`, en: parents[i] >= 0 ? `← 점 ${parents[i] + 1}에 이어짐` : '뿌리 뼈', where: '뼈가 꺾일 곳(관절)에 놓으세요. "새 점 추가"를 누르면 지금 점에 이어지는 다음 뼈가 생겨요' };
    const [ko, en, where] = POINTS[i];
    if (MIDS.has(i)) return { title: `점 ${i}: ${ko}`, en: manual.has(i) ? '직접 놓음' : '자동 (뿌리·끝으로 계산)', where: manual.has(i) ? where : `자동으로 놓여요. 접히는 곳과 다르면 화살표로 옮기세요 (옮긴 점은 그대로 유지). ${where}` };
    return { title: `점 ${i}: ${ko}`, en, where };
  };
  let cur = pts.findIndex((p, i) => !p && !(kind === 'hand' && [2, 3, 6, 7, 10, 11, 14, 15, 18, 19].includes(i))); if (cur < 0) cur = 0;
  const palmLen = () => refLen();
  let framed = false; // zoom to the hand once the wrist and the middle root are placed
  const frameHand = () => {}; void framed;

  const tc = new TransformControls(camera, canvas);
  tc.setMode('translate'); tc.setSpace('world'); tc.setSize(0.9);
  scene.add(tc.getHelper());

  // UI over the canvas
  const ui = document.createElement('div');
  Object.assign(ui.style, { position: 'absolute', left: '0', right: '0', bottom: '0', padding: '8px', background: 'rgba(0,0,0,.6)', color: '#fff', font: '15px sans-serif', zIndex: 5 });
  const head = document.createElement('div'); Object.assign(head.style, { position: 'absolute', left: '0', right: '0', top: '0', padding: '8px', background: 'rgba(0,0,0,.6)', color: '#fff', font: '13px sans-serif', zIndex: 5 });
  const howTo = '탭=점 놓기 · 화살표 끌기=그 축으로 이동(0.3배) · 빈 곳 끌기=회전 · 두 손가락 벌리기=확대, 같이 밀기=화면 이동';
  if (kind === 'body') head.innerHTML = '<b>몸 리깅 (MediaPipe Pose): 관절 중심, 팔다리 두께 한가운데에. 왼쪽 = 모델 자신의 왼쪽 (정면에서 보면 화면 오른쪽)</b><br>' + howTo + ' · 오른쪽 예시에서 점 고르기<br>색: ' + Object.keys(BODY_KO).map((k) => `<span style="color:${hex(BODY_COL[k])}">●</span>${BODY_KO[k]}`).join(' ');
  else if (kind === 'free') head.innerHTML = '<b>기타 리깅: 찍은 점마다 뼈가 생겨요. "새 점 추가" = 지금 점에 이어지는 다음 뼈 (꼬리·날개·소품 등). 완료하면 뼈 넣은 GLB로 저장</b><br>' + howTo;
  else head.innerHTML = '<b>손목, 손가락 뿌리 5개, 손가락 끝 5개만 찍으세요 (11점). 가운데 관절은 자동으로 놓여요.</b> <span style="color:#33dd55">초록 화살표 = 손바닥 쪽</span> (반대면 "손바닥 방향 뒤집기")<br>' + howTo + ' · 놓은 점 탭=고치기 · 오른쪽 예시에서 점 고르기(순서 상관없음)<br>색: ' + FINGER_KO.map((n, k) => `<span style="color:${hex(COLORS[k])}">●</span>${n}`).join(' ');
  const label = document.createElement('div'); label.style.marginBottom = '6px';
  const row = document.createElement('div'); Object.assign(row.style, { display: 'flex', flexWrap: 'wrap', gap: '6px' });
  const btn = (t, f) => { const b = document.createElement('button'); b.textContent = t; Object.assign(b.style, window.innerWidth > window.innerHeight ? { font: '13px sans-serif', padding: '5px 8px' } : { font: '15px sans-serif', padding: '8px 10px' }); b.onclick = f; row.appendChild(b); return b; };
  const guide = document.createElement('div'); Object.assign(guide.style, { position: 'absolute', right: '82px', top: '96px', zIndex: 5 });
  // tap a dot (or a name) in the example to choose which point to place/fix next: any order
  guide.addEventListener('pointerdown', (e) => { e.stopPropagation(); const t = e.target.closest('[data-i]'); if (t) select(+t.dataset.i); });
  ui.appendChild(label); ui.appendChild(row);
  // landscape (v0.63 app is landscape; v0.64 user: buttons at the bottom): one compact bottom bar,
  // short header, example panel top-right as before
  if (window.innerWidth > window.innerHeight) {
    Object.assign(ui.style, { padding: '4px 6px', font: '13px sans-serif' });
    Object.assign(head.style, { font: '11px sans-serif', padding: '3px 8px' });
    label.style.marginBottom = '3px'; row.style.gap = '4px';
  }
  document.body.appendChild(guide);
  document.body.appendChild(ui); document.body.appendChild(head);
  const stepPt = (d) => { if (kind !== 'hand') return (cur + N() + d) % N(); const j = HAND_TAP.indexOf(cur); return HAND_TAP[((j < 0 ? 0 : j) + d + HAND_TAP.length) % HAND_TAP.length]; };
  btn('◀ 이전', () => select(stepPt(-1)));
  btn('다음 ▶', () => select(stepPt(1)));
  if (kind === 'free') btn('새 점 추가 (지금 점에 이어서)', () => { pts.push(null); dots.push(null); parents.push(pts[cur] ? cur : parents[cur]); select(pts.length - 1); });
  btn('화면 가운데로', () => { pan.set(0, 0, 0); });
  btn('이 점 지우기', () => { pts[cur] = null; if (kind === 'hand' && MIDS.has(cur)) { manual.delete(cur); autoMids(); } redraw(); select(cur); });
  const sideText = () => `손바닥 방향 뒤집기 (지금: ${side0 === 'left' ? '왼손' : '오른손'})`;
  const sideBtn = kind === 'hand' ? btn('', () => { side0 = side0 === 'left' ? 'right' : 'left'; sideBtn.textContent = sideText(); drawLines(); }) : document.createElement('button');
  sideBtn.textContent = sideText();
  // Hand rig check (user GLB: points stacked, 85 % of the skin ended on the wrist bone): before
  // finishing, warn about points on top of each other, too short finger segments and points
  // outside the model; a second press finishes anyway.
  let warned = false;
  // Hand: only the wrist, the 5 roots and the 5 tips are placed by hand; the 2 middle joints of each
  // finger go on the root->tip line at hand-model ratios (two hand-rigged gauntlets: fingers
  // 0.44/0.28/0.28, thumb 0.31-0.39/0.30-0.34; root->tip 0.97-1.0 of the chain = straight), then to the
  // middle of the finger's thickness. A middle joint moved by hand stays where it was put.
  const MIDS = new Set(FINGER_KEYS.flatMap((k) => [MP[k][1], MP[k][2]]));
  const manual = new Set(kind === 'hand' ? [...MIDS].filter((i) => pts[i]) : []); // middle joints the user placed or dragged (a saved rig keeps its own)
  const centre = (p, dir) => {
    // move p to halfway between the surfaces on both sides, across the finger (2 directions)
    const pal = refLen() || size * 0.1; const w = model.localToWorld(p.clone());
    const wd = model.localToWorld(p.clone().add(dir)).sub(w).normalize();
    const u = new THREE.Vector3(0, 1, 0).cross(wd); if (u.lengthSq() < 1e-6) u.set(1, 0, 0).cross(wd); u.normalize();
    const v = wd.clone().cross(u).normalize();
    const rc = new THREE.Raycaster();
    for (const ax of [u, v]) {
      const hit = (d) => { rc.set(w, d); const h = rc.intersectObjects(meshes, false)[0]; return h && h.distance < 0.25 * pal * (model.matrixWorld.getMaxScaleOnAxis() || 1) ? h.point : null; };
      const a = hit(ax.clone()); const b = hit(ax.clone().negate());
      if (a && b) w.copy(a).add(b).multiplyScalar(0.5);
    }
    return model.worldToLocal(w);
  };
  function autoMids() {
    if (kind !== 'hand') return;
    model.updateMatrixWorld(true);
    for (const key of FINGER_KEYS) {
      const m = MP[key]; const r = pts[m[0]]; const t = pts[m[3]]; if (!r || !t) continue;
      const q = key === 'thumb' ? [0.35, 0.67] : [0.44, 0.72];
      [1, 2].forEach((k, j) => {
        if (manual.has(m[k])) return;
        const p = r.clone().lerp(t, q[j]);
        pts[m[k]] = centre(p, t.clone().sub(r));
      });
    }
  }
  // inside = most of 6 axis rays cross the surface an odd number of times; a point just past the
  // surface (finger tips sit on the skin) counts as inside when a surface is within `near`
  const inside = (p, near) => {
    const w = p.clone().applyMatrix4(model.matrixWorld); let votes = 0; let close = Infinity;
    const sc = new THREE.Vector3().setFromMatrixScale(model.matrixWorld).x;
    for (const d of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      ray.set(w, new THREE.Vector3(...d)); const h = ray.intersectObjects(meshes, false);
      if (h.length % 2 === 1) votes++; if (h.length) close = Math.min(close, h[0].distance / sc);
    }
    return votes >= 3 || close < near;
  };
  function checkHand() {
    const bad = []; const palm = pts[0] && pts[9] ? pts[0].distanceTo(pts[9]) : 0;
    if (!palm) return bad;
    const name = (i) => `점 ${i}(${POINTS[i][0]})`;
    for (const key of FINGER_KEYS) {
      const m = MP[key];
      for (let k = 0; k < 3; k++) {
        const a = m[k]; const b = m[k + 1]; const d = pts[a].distanceTo(pts[b]) / palm;
        if (d < 0.12) bad.push({ i: b, text: `${name(a)}–${name(b)} 마디가 너무 짧아요 (손바닥의 ${Math.round(d * 100)}%)` });
      }
    }
    for (let i = 0; i < 21; i++) for (let j = i + 1; j < 21; j++) if (pts[i].distanceTo(pts[j]) < 0.06 * palm && !bad.some((x) => x.i === j)) bad.push({ i: j, text: `${name(i)}, ${name(j)} 위치가 겹쳐요` });
    model.updateMatrixWorld(true);
    for (let i = 0; i < 21; i++) if (!inside(pts[i], 0.1 * palm)) bad.push({ i, text: `${name(i)} 위치가 모델 밖이에요` });
    return bad;
  }
  const doneBtn = btn('완료', () => {
    if (kind === 'hand' && !warned) {
      const bad = checkHand();
      if (bad.length) {
        warned = true; select(bad[0].i);
        label.innerHTML = `<div style="color:#ffb4a8"><b>리깅 점 확인 필요 (${bad.length}곳)</b><br>${bad.slice(0, 5).map((x) => x.text).join('<br>')}${bad.length > 5 ? `<br>외 ${bad.length - 5}곳` : ''}<br><span style="color:#fff">고친 뒤 완료, 또는 그대로 "그래도 완료"</span></div>`;
        doneBtn.textContent = '그래도 완료';
        window.lastRigCheck = bad.map((x) => x.text);
        return;
      }
    }
    finish(true);
  });
  btn('취소', () => finish(false));

  function redraw() {
    dots.forEach((d) => d && model.remove(d));
    pts.forEach((p, i) => {
      if (!p) { dots[i] = null; return; }
      const m = new THREE.Mesh(new THREE.SphereGeometry((palmLen() > 0 ? Math.min(marker, palmLen() * 0.025) : marker) * (i === cur ? 1.5 : 1), 12, 8), new THREE.MeshBasicMaterial({ color: colorAt(i), depthTest: false }));
      m.renderOrder = 10; m.position.copy(p); m.userData.point = i; model.add(m); dots[i] = m;
    });
    drawLines();
  }
  function drawLines() {
    lines.clear();
    const seg = (a, b) => { if (!pts[a] || !pts[b]) return; const g = new THREE.BufferGeometry().setFromPoints([pts[a], pts[b]]); const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color: colorAt(b), depthTest: false })); l.renderOrder = 9; lines.add(l); };
    for (const [a, b] of segList()) seg(a, b);
    // Palm side (user v0.69): green arrow out of the palm. It follows from which hand the model is
    // (custom.js: right hand palm = +z of wrist / index / middle / pinky frame, left = -z), so
    // "손바닥 방향 뒤집기" swaps the hand side.
    if (kind === 'hand' && pts[0] && pts[5] && pts[9] && pts[17]) {
      const y = pts[9].clone().sub(pts[0]); const len = y.length(); y.normalize();
      const x = pts[5].clone().sub(pts[17]); x.addScaledVector(y, -x.dot(y)).normalize();
      const z = new THREE.Vector3().crossVectors(x, y).multiplyScalar(side0 === 'left' ? -1 : 1);
      const c = pts[0].clone().add(pts[5]).add(pts[9]).add(pts[17]).multiplyScalar(0.25);
      const mat = new THREE.MeshBasicMaterial({ color: 0x33dd55, depthTest: false, transparent: true });
      const arrow = new THREE.Group();
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(len * 0.035, len * 0.035, len * 0.65, 10), mat); shaft.position.y = len * 0.325;
      const tipM = new THREE.Mesh(new THREE.ConeGeometry(len * 0.1, len * 0.25, 14), mat); tipM.position.y = len * 0.775;
      arrow.add(shaft, tipM); arrow.position.copy(c); arrow.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), z);
      arrow.traverse((o) => { o.renderOrder = 10; });
      lines.add(arrow);
    }
    const n = pts.filter(Boolean).length;
    if (typeof guide !== 'undefined' && guide) { guide.innerHTML = panelHtml(); guide.style.top = (head.offsetHeight + 6) + 'px'; }
    if (!doneBtn) return;
    doneBtn.disabled = n < need(); if (!warned) doneBtn.textContent = kind === 'free' ? `완료 (점 ${n}개)` : kind === 'hand' ? `완료 (${HAND_TAP.filter((i) => pts[i]).length}/11)` : `완료 (${n}/${N()})`;
  }
  function select(i) {
    cur = i; frameHand(); redraw();
    const { title: ko, en, where } = pointText(i);
    guide.innerHTML = panelHtml(); guide.style.top = (head.offsetHeight + 6) + 'px';
    label.innerHTML = `<div><span style="color:${hex(colorAt(i))};font-size:20px">●</span> <b>${ko}</b> <span style="opacity:.7">${en}</span>${pts[i] ? ' · 놓임 (화살표로 조정, 다시 탭하면 옮김)' : ' · 모델을 탭하세요'}<br><span style="font-size:13px;opacity:.9">위치: ${where}</span></div>`;
    if (pts[i] && dots[i]) tc.attach(dots[i]); else tc.detach();
  }
  // Arrow drags move the point at FINE x the finger (the plain gizmo felt far too fast on a zoomed-in hand),
  // and the view stays still while dragging (it used to chase the moving point, which sped the drag up).
  const FINE = 0.3; const dragStart = new THREE.Vector3();
  tc.addEventListener('mouseDown', () => { if (tc.object) dragStart.copy(tc.object.position); });
  tc.addEventListener('objectChange', () => {
    const i = tc.object && tc.object.userData.point; if (i == null) return;
    if (tc.dragging) tc.object.position.sub(dragStart).multiplyScalar(FINE).add(dragStart);
    pts[i].copy(tc.object.position); warned = false;
    if (MIDS.has(i)) manual.add(i); else if (kind === 'hand') { autoMids(); redraw(); tc.attach(dots[i]); }
    drawLines();
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
    pts[cur] = model.worldToLocal(w.clone()); warned = false;
    if (MIDS.has(cur)) manual.add(cur);
    autoMids();
    // next point to place by hand: the first missing wrist/root/tip (middle joints are automatic)
    if (kind === 'hand') { const nx = [0, ...FINGER_KEYS.flatMap((k) => [MP[k][0], MP[k][3]])].find((k) => !pts[k]); if (nx != null && !MIDS.has(cur)) cur = nx; }
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
  const onResize = () => { W = window.innerWidth; H = window.innerHeight; Object.assign(canvas.style, { width: `${W}px`, height: `${H}px` }); renderer.setSize(W, H, false); camera.aspect = W / H; offsetView(); camera.updateProjectionMatrix(); };
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
      // model (template root) space
      const out = !ok ? null : kind === 'free' ? { kind, pts: pts.map((p) => (p ? p.toArray() : null)), parents: parents.slice() }
        : kind === 'body' ? { kind, pts: pts.map((p) => p.toArray()) } : { side: side0, pts: pts.map((p) => p.toArray()) };
    onDone(out);
  }
  // test hooks
  return {
    setPoint: (i, p) => { pts[i] = new THREE.Vector3(...p); select(i); },
    auto: () => { autoMids(); redraw(); drawLines(); return pts.map((p) => (p ? p.toArray() : null)); },
    clear: () => { pts.fill(null); manual.clear(); redraw(); },
    tap,
    dist: () => dist,
    screenOf: (i) => { scene.updateMatrixWorld(true); const v = pts[i].clone().applyMatrix4(model.matrixWorld).project(camera); return [(v.x + 1) / 2 * W, (1 - v.y) / 2 * H]; },
    local: (i) => pts[i].toArray(),
    pan: () => pan.toArray(),
    setSide: (v) => { side0 = v; sideBtn.textContent = sideText(); drawLines(); },
    view: (x, y) => { turn.rotation.set(x, y, 0); }, // tests
    finish,
  };
}
