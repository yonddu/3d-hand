// Synthetic training aid: renders the app's own MIT hand model (webxr-input-
// profiles hand-left/right.glb) and arm skin in poses from the data, first
// person from the eyes, and runs MediaPipe on each picture. Every sample keeps
// the true pose (hand shape angles, hand turn, 21 joint positions) next to
// what MediaPipe read, so the pipeline's joint angle error can be measured
// (tools/synth-eval.mjs).
//
// Kept apart from the takes: written to its own folder, never to takes/, and
// never used to score (the score-only takes in regress-split.json stay real
// video only).
//
//   python3 -m http.server 8090   (in the repo folder)
//   node tools/synth-render.mjs <count> [out folder] [seed]
//
// Every pose comes from the data (armPoses.js x gestures.js, or a blend of two
// shapes: angles between two poses inside the joint ranges stay inside them),
// so nothing outside human joint ranges is drawn. Varied per sample: side,
// skin tone, sleeve, background, light, where the head looks.
// Pictures are 720x1280 (a phone video frame).
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const N = +process.argv[2] || 200;
const OUT = process.argv[3] || '/mnt/project-files/hand-motion-studio/synthetic/';
const SEED = +process.argv[4] || 1;
const W = 360;
const H = 640;
const URL = process.env.SYNTH_URL || 'http://localhost:8090/index.html';
// SYNTH_EXTRAS=1: also rings, watches, bracelets and patterned backgrounds
// (things common in real video). Off keeps older seeds as they were drawn.
const EXTRAS = process.env.SYNTH_EXTRAS === '1';

fs.mkdirSync(path.join(OUT, 'img'), { recursive: true });
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await (await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 2 })).newPage();
page.on('pageerror', (e) => console.log('pageerror', e.message));
await page.goto(URL);
await page.waitForTimeout(2000);
await page.click('#start-demo');
await page.waitForTimeout(2500);
await page.addStyleTag({ content: `header,.topbar,.stage-foot,#pose-banner,.status,.hud,button,#overlay{display:none!important} canvas#viewport{position:fixed!important;left:0;top:0;width:${W}px!important;height:${H}px!important;z-index:9999}` });
await page.evaluate(async ([seed, W, H, EXTRAS]) => {
  const THREE = await import('three');
  const { armPoseJoints } = await import('./src/armPoses.js');
  const { paintHand } = await import('./tools/synthSkin.js');
  const { FilesetResolver, HandLandmarker } = await import('@mediapipe/tasks-vision');
  const files = await FilesetResolver.forVisionTasks('vendor/mediapipe/wasm');
  const hl = await HandLandmarker.createFromOptions(files, { baseOptions: { modelAssetPath: 'vendor/models/hand_landmarker.task', delegate: 'CPU' }, runningMode: 'IMAGE', numHands: 2 });
  const S = window.__hms;
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const SKIN = [0xf1c8a8, 0xe0ac8a, 0xc68863, 0xa86b4a, 0x8a5536, 0x5e3a26];
  const SLEEVE = [0xdfe6ea, 0x2b2f36, 0x5a6e8c, 0x8c3b3b, 0x6b6b4a, 0xe8e2d4];
  const byId = Object.fromEntries(S.GESTURES.map((g) => [g.id, g]));
  // The app's orbit controls aim the camera at their target every frame, so
  // the look point goes there (no roll: they keep the camera upright).
  // Plain skin (not the app's pale Quest look), opaque.
  const look = document.getElementById('look');
  look.value = 'skin';
  look.dispatchEvent(new Event('change'));
  const paint = { left: paintHand(S.realHands.left), right: paintHand(S.realHands.right) };
  // Extras: worn things and busy backgrounds, placed fresh for every sample.
  const METAL = [0xd4af37, 0xc0c0c0, 0xb87333, 0x2a2a2a, 0xe8e8e8];
  const metal = () => new THREE.MeshStandardMaterial({ color: pick(METAL), metalness: 0.9, roughness: 0.2 + 0.4 * rnd() });
  const extras = new THREE.Group();
  S.scene.add(extras);
  const bgCanvas = document.createElement('canvas');
  bgCanvas.width = bgCanvas.height = 256;
  const bgTex = new THREE.CanvasTexture(bgCanvas);
  bgTex.colorSpace = THREE.SRGBColorSpace;
  const hsl = () => `hsl(${Math.floor(360 * rnd())},${Math.floor(10 + 50 * rnd())}%,${Math.floor(15 + 70 * rnd())}%)`;
  function patternBackground() {
    const g = bgCanvas.getContext('2d');
    g.fillStyle = hsl();
    g.fillRect(0, 0, 256, 256);
    const kind = Math.floor(rnd() * 4);
    for (let i = 0; i < 40; i++) {
      g.fillStyle = hsl();
      g.strokeStyle = hsl();
      g.lineWidth = 2 + 10 * rnd();
      if (kind === 0) g.fillRect((i % 8) * 32, Math.floor(i / 8) * 64 + ((i % 2) * 32), 32, 32); // checks
      else if (kind === 1) { g.beginPath(); g.moveTo(rnd() * 256, 0); g.lineTo(rnd() * 256, 256); g.stroke(); } // stripes
      else if (kind === 2) { g.beginPath(); g.arc(rnd() * 256, rnd() * 256, 5 + 40 * rnd(), 0, 7); g.fill(); } // blobs
      else g.fillRect(rnd() * 256, rnd() * 256, 10 + 80 * rnd(), 10 + 80 * rnd()); // clutter
    }
    bgTex.needsUpdate = true;
    return bgTex;
  }
  const ringGeo = new THREE.TorusGeometry(1, 0.17, 10, 28);
  const bandGeo = new THREE.CylinderGeometry(1, 1, 1, 32, 1, true);
  // A torus around the segment a->b (world points), radius r, at fraction t.
  function ringOn(a, b, r, t, mat, width = 1) {
    const m = new THREE.Mesh(ringGeo, mat);
    m.position.copy(a).lerp(b, t);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), b.clone().sub(a).normalize());
    m.scale.set(r, r, r * width);
    extras.add(m);
    return m;
  }
  function wearThings(side, P, E) {
    extras.clear();
    // Rings on proximal phalanges: none, one or two.
    const FING = [['index', 5, 6], ['middle', 9, 10], ['ring', 13, 14], ['pinky', 17, 18], ['thumb', 2, 3]];
    const nRings = rnd() < 0.4 ? 0 : rnd() < 0.7 ? 1 : 2;
    for (let i = 0; i < nRings; i++) {
      const [, a, b] = rnd() < 0.5 ? FING[2] : pick(FING);
      ringOn(P[a], P[b], (0.0085 + 0.002 * rnd()) * (a === 17 ? 0.85 : 1), 0.3 + 0.2 * rnd(), metal(), 0.8 + 1.5 * rnd());
    }
    // Watch or bracelet on the forearm, a little up from the wrist.
    const k = rnd();
    if (k < 0.55) {
      const wrist = P[0];
      const up = wrist.clone().sub(E).normalize();
      const at = wrist.clone().addScaledVector(up, -(0.025 + 0.03 * rnd()));
      // Back of the hand: away from the palm (see tools/palm/crops.py facing).
      const n = P[5].clone().sub(wrist).cross(P[17].clone().sub(wrist)).normalize();
      const back = side === 'right' ? n.clone().negate() : n;
      const across = up.clone().cross(back).normalize();
      const band = new THREE.Mesh(bandGeo, k < 0.4 ? new THREE.MeshStandardMaterial({ color: pick([0x1b1b1b, 0x5a3a22, 0x2b3d5a, 0xdddddd, 0x8a1c1c]), roughness: 0.7 }) : metal());
      band.material.side = THREE.DoubleSide;
      const basis = new THREE.Matrix4().makeBasis(across, up, back);
      band.quaternion.setFromRotationMatrix(basis);
      band.position.copy(at);
      band.scale.set(0.035 + 0.006 * rnd(), k < 0.4 ? 0.02 : 0.006 + 0.01 * rnd(), 0.028 + 0.005 * rnd());
      extras.add(band);
      if (k < 0.4) {
        // Watch face: on the back usually, sometimes worn on the palm side.
        const face = new THREE.Mesh(rnd() < 0.5 ? new THREE.BoxGeometry(1, 1, 1) : new THREE.CylinderGeometry(0.5, 0.5, 1, 28), metal());
        const onBack = rnd() < 0.85 ? 1 : -1;
        face.quaternion.copy(band.quaternion);
        if (face.geometry.type === 'CylinderGeometry') face.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2));
        face.position.copy(at).addScaledVector(back, onBack * (0.031 + 0.004 * rnd()));
        const d = 0.032 + 0.012 * rnd();
        face.scale.set(d, face.geometry.type === 'CylinderGeometry' ? 0.01 : d, face.geometry.type === 'CylinderGeometry' ? d : 0.01);
        extras.add(face);
      }
    }
  }
  const camRig = (x, y) => {
    const c = S.camera;
    c.position.set(0, 0, 0);
    c.up.set(0, 1, 0);
    c.fov = 66;
    c.aspect = W / H;
    c.updateProjectionMatrix();
    // A unit-length look point: the controls keep the camera within 2 m of it.
    const t = new THREE.Vector3(x, y, -1).normalize();
    S.controls.target.copy(t);
    c.lookAt(t);
    c.updateMatrixWorld(true);
  };
  window.__synth = {
    hl,
    // Poses one hand and arm; returns the truth, or null if the hand is out of the picture.
    pose() {
      const side = rnd() < 0.5 ? 'left' : 'right';
      const other = side === 'left' ? 'right' : 'left';
      const ap = pick(S.ARM_POSES);
      // Hand shape: the arm pose's own half the time, else any shape, sometimes a blend of two.
      const a = rnd() < 0.5 && byId[ap.hand] ? byId[ap.hand] : pick(S.GESTURES);
      const b = rnd() < 0.3 ? pick(S.GESTURES) : null;
      const u = b ? rnd() : 0;
      const h = {};
      for (const k of Object.keys(a.h)) h[k] = a.h[k].map((v, i) => v + (b ? (b.h[k][i] - v) * u : 0));
      const shape = { id: b ? `${a.id}~${b.id}@${u.toFixed(2)}` : a.id, h, cup: (a.cup || 0) * (1 - u) + (b ? (b.cup || 0) * u : 0) };
      S.state.frozen = true;
      S.state.armView = true;
      const rig = S.rigs[side];
      const arm = S.arms[side];
      const J = armPoseJoints(ap.arm, side, arm.homeShoulder);
      S.applyGesture(rig, shape);
      rig.group.position.copy(J.W);
      rig.wrist.quaternion.copy(J.handQ);
      rig.group.visible = true;
      S.rigs[other].group.visible = false;
      S.arms[other].group.visible = false;
      arm.shoulder.copy(J.S);
      arm.elbow.copy(J.E);
      arm.opts = { side, comfort: 1, shrug: 0 };
      arm.setVisible(true, true, false);
      S.scene.children.forEach((c) => {
        if (c.type === 'GridHelper') c.visible = false;
        if (c.name === `${other}RealHand`) c.visible = false;
        if (c.name === `${side}RealHand`) c.visible = true;
      });
      // Look about the way a phone held at the eyes does, toward the hand.
      // Hands well off to the side or behind are out of a phone camera's reach.
      if (-J.W.z < 0.15 || J.W.clone().normalize().z > -0.55) return null;
      const look = J.W.clone().divideScalar(-J.W.z);
      camRig(look.x * (0.5 + 0.5 * rnd()) + (rnd() - 0.5) * 0.2, look.y * (0.5 + 0.5 * rnd()) + (rnd() - 0.5) * 0.2);
      const skin = new THREE.Color(pick(SKIN));
      paint[side].vary(rnd, skin);
      if (S.arms[side].mesh) S.arms[side].mesh.material.color = rnd() < 0.5 ? skin : new THREE.Color(pick(SLEEVE));
      S.scene.background = EXTRAS && rnd() < 0.6 ? patternBackground() : new THREE.Color().setHSL(rnd(), 0.1 + 0.4 * rnd(), 0.2 + 0.6 * rnd());
      S.scene.children.forEach((c) => {
        if (c.isDirectionalLight) c.intensity = 0.4 + 1.6 * rnd();
        if (c.isHemisphereLight) c.intensity = 0.4 + 1.2 * rnd();
      });
      // Truth: the drawn model's joints (RealHand places its bones from the
      // rig, with its own bone lengths), in camera space (x right, y up, -z
      // ahead) and in the picture.
      const rh = S.realHands[side];
      rh.update();
      rh.root.updateMatrixWorld(true);
      const XR = { thumb: 'thumb-metacarpal thumb-phalanx-proximal thumb-phalanx-distal thumb-tip' };
      for (const k of ['index', 'middle', 'ring', 'pinky']) XR[k] = ['phalanx-proximal', 'phalanx-intermediate', 'phalanx-distal', 'tip'].map((n) => `${k}-finger-${n}`).join(' ');
      const L = [rh.joints.wrist.getWorldPosition(new THREE.Vector3())];
      for (const k of Object.keys(XR)) for (const n of XR[k].split(' ')) L.push(rh.joints[n].getWorldPosition(new THREE.Vector3()));
      if (EXTRAS) wearThings(side, L, J.E);
      else extras.clear();
      const inv = S.camera.matrixWorldInverse;
      const cam = L.map((p) => p.clone().applyMatrix4(inv));
      const img = L.map((p) => {
        const q = p.clone().project(S.camera);
        return [(q.x + 1) / 2, (1 - q.y) / 2];
      });
      const inside = img.filter(([x, y]) => x > 0.02 && x < 0.98 && y > 0.02 && y < 0.98).length;
      if (inside < 21 || cam.some((p) => p.z > -0.12)) return null;
      const handQ = new THREE.Quaternion().setFromRotationMatrix(inv).multiply(rig.wrist.getWorldQuaternion(new THREE.Quaternion()));
      return { side, arm: ap.id, armAngles: ap.arm, shape: shape.id, h: shape.h, cup: shape.cup, handQ: handQ.toArray(), joints: cam.map((p) => p.toArray()), image: img };
    },
    async detect(dataUrl) {
      const im = new Image();
      im.src = dataUrl;
      await im.decode();
      const r = hl.detect(im);
      return r.landmarks.map((lm, i) => ({ label: r.handedness[i][0].categoryName, score: r.handedness[i][0].score, lm: lm.map((q) => [q.x, q.y, q.z]), world: r.worldLandmarks[i].map((q) => [q.x, q.y, q.z]) }));
    },
  };
}, [SEED, W, H, EXTRAS]);

const outFile = path.join(OUT, `synth_seed${SEED}.jsonl`);
const stream = fs.createWriteStream(outFile, { flags: 'a' });
let made = 0;
let tries = 0;
let found = 0;
while (made < N && tries < N * 6) {
  tries++;
  const truth = await page.evaluate(() => window.__synth.pose());
  if (!truth) continue;
  // Two frames drawn after posing, so the picture shows this pose.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.waitForTimeout(60);
  const jpg = await page.screenshot({ type: 'jpeg', quality: 85 });
  const mp = await page.evaluate((u) => window.__synth.detect(u), `data:image/jpeg;base64,${jpg.toString('base64')}`);
  const name = `s${SEED}_${String(made).padStart(5, '0')}.jpg`;
  fs.writeFileSync(path.join(OUT, 'img', name), jpg);
  if (mp.length) found++;
  stream.write(JSON.stringify({ id: name, aspect: W / H, truth, mp }) + '\n');
  made++;
  if (made % 50 === 0) console.log(`${made} made, MediaPipe found a hand in ${found}`);
}
stream.end();
console.log(`done: ${made} samples (${tries} tries), MediaPipe found a hand in ${found} -> ${outFile}`);
await browser.close();
