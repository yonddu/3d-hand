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

fs.mkdirSync(path.join(OUT, 'img'), { recursive: true });
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await (await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 2 })).newPage();
page.on('pageerror', (e) => console.log('pageerror', e.message));
await page.goto(URL);
await page.waitForTimeout(2000);
await page.click('#start-demo');
await page.waitForTimeout(2500);
await page.addStyleTag({ content: `header,.topbar,.stage-foot,#pose-banner,.status,.hud,button,#overlay{display:none!important} canvas#viewport{position:fixed!important;left:0;top:0;width:${W}px!important;height:${H}px!important;z-index:9999}` });
await page.evaluate(async ([seed, W, H]) => {
  const THREE = await import('three');
  const { armPoseJoints } = await import('./src/armPoses.js');
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
      S.realHands[side].mesh.material.color = skin;
      if (S.arms[side].mesh) S.arms[side].mesh.material.color = rnd() < 0.5 ? skin : new THREE.Color(pick(SLEEVE));
      S.scene.background = new THREE.Color().setHSL(rnd(), 0.1 + 0.4 * rnd(), 0.2 + 0.6 * rnd());
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
}, [SEED, W, H]);

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
