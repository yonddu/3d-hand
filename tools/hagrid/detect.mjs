// The app's own readings of HaGRID photos (tools/hagrid/fetch-images.py):
// MediaPipe (the vendored tasks-vision and hand_landmarker.task, as the app
// runs them), then for each hand the 64x64 crop (palmFace.js cutHand) read
// by the finger curl and joint cube models. tools/hagrid/eval.mjs scores them.
//
//   python3 -m http.server 8090   (in the repo folder)
//   node tools/hagrid/detect.mjs <photos dir> <out.jsonl>
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const [dir, outFile] = process.argv.slice(2);
const URL = process.env.HAGRID_URL || 'http://localhost:8090/tools/hagrid/detect.html';

const done = new Set();
if (fs.existsSync(outFile)) for (const l of fs.readFileSync(outFile, 'utf8').split('\n')) if (l.trim()) done.add(JSON.parse(l).id);
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('pageerror', e.message));
await page.goto(URL);
await page.evaluate(async () => {
  const { FilesetResolver, HandLandmarker } = await import('@mediapipe/tasks-vision');
  const { cutHand } = await import('/src/palmFace.js');
  const { loadFingerCurl, fingerCurl } = await import('/src/fingerCurl.js');
  const { loadJointCube, jointCube } = await import('/src/jointCube.js');
  await Promise.all([loadFingerCurl('/'), loadJointCube('/')]);
  const files = await FilesetResolver.forVisionTasks('/vendor/mediapipe/wasm');
  const hl = await HandLandmarker.createFromOptions(files, { baseOptions: { modelAssetPath: '/vendor/models/hand_landmarker.task', delegate: 'CPU' }, runningMode: 'IMAGE', numHands: 2 });
  window.__detect = async (dataUrl) => {
    const im = new Image();
    im.src = dataUrl;
    await im.decode();
    const W = im.naturalWidth;
    const H = im.naturalHeight;
    const r = hl.detect(im);
    return {
      W,
      H,
      mp: r.landmarks.map((lm, i) => {
        const crop = cutHand(im, lm, W, H);
        return { label: r.handedness[i][0].categoryName, score: r.handedness[i][0].score, lm: lm.map((q) => [q.x, q.y, q.z]), world: r.worldLandmarks[i].map((q) => [q.x, q.y, q.z]), curl: fingerCurl(crop), cube: jointCube(crop) };
      }),
    };
  };
});

const gestures = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
let n = 0;
for (const g of gestures) {
  const meta = JSON.parse(fs.readFileSync(path.join(dir, `${g}.json`), 'utf8'));
  for (const [id, m] of Object.entries(meta)) {
    if (done.has(id)) continue;
    const file = path.join(dir, g, `${id}.jpg`);
    if (!fs.existsSync(file)) continue;
    const r = await page.evaluate((u) => window.__detect(u), `data:image/jpeg;base64,${fs.readFileSync(file).toString('base64')}`);
    fs.appendFileSync(outFile, JSON.stringify({ id, gesture: g, aspect: r.W / r.H, boxes: m.bboxes, labels: m.labels, mp: r.mp }) + '\n');
    if (++n % 100 === 0) console.log(`${n} photos read`);
  }
}
await browser.close();
console.log(`${n} photos read`);
