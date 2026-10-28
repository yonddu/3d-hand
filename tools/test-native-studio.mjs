// Packaged Studio smoke test with a stub native transport, no camera/GPU claims.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { restLandmarks, wristName } from '../src/skeleton.js';
const dir = path.resolve('dist/native');
const srv = http.createServer((req, res) => {
  const f = path.join(dir, new URL(req.url, 'http://x').pathname);
  if (!f.startsWith(dir + path.sep) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.setHeader('Content-Type', f.endsWith('.js') ? 'text/javascript' : f.endsWith('.html') ? 'text/html' : 'application/octet-stream');
  fs.createReadStream(f).pipe(res);
}).listen(0, '127.0.0.1');
await new Promise(resolve => srv.on('listening', resolve));
const browser = await chromium.launch({ args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 412, height: 700 } });
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    window.exports = [];
    window.HMSAndroid = {
      ready() { window.bridgeReady = true; },
      beginExport(name, size) { window.transfer = { name, size, chunks: [] }; return 'test'; },
      appendExport(id, data) { window.transfer.chunks.push(data); return id === 'test'; },
      finishExport() { window.exports.push(window.transfer); return true; },
      cancelExport() {},
    };
  });
  await page.goto(`http://127.0.0.1:${srv.address().port}/index.html`);
  await page.waitForFunction(() => window.bridgeReady, null, { timeout: 60000 });
  const makeHand = side => ({ label: side, score: .95, world: restLandmarks(side).flatMap(([x,y,z]) => [x,-y,-z]), lm: restLandmarks(side).flatMap(([x,y,z]) => [.5+x,.5-y,z]) });
  const hand = makeHand('right');
  const packet = (tMs, hands) => ({ session: 1, tMs, width: 720, height: 1280, hands, backend: 'gpu', maxHands: 2 });
  const send = p => page.evaluate(p => window.HMSNative.receive(p), p);
  await send(packet(1000, [hand]));
  assert.equal(await page.evaluate(() => window.__nativeStudio.realHands.right.root.visible), true);
  assert.equal(await page.evaluate(() => window.__nativeStudio.realHands.right.correctPose), false);
  assert.equal(await page.evaluate(() => window.__nativeStudio.arms.right.group.visible && window.__nativeStudio.arms.right.mesh.visible), true, 'web arm mesh visible');
  assert.equal(await page.evaluate(() => window.__nativeStudio.arms.right.elbowDot.visible), false, 'no elbow debug marker');
  await page.click('#rec');
  await send(packet(1100, [hand]));
  await send(packet(1200, []));
  assert.equal(await page.evaluate(() => window.__nativeStudio.realHands.right.root.visible), false, 'missing hand hidden immediately');
  assert.equal(await page.evaluate(() => window.__nativeStudio.arms.right.group.visible), false, 'lost arm also hidden');
  await send(packet(1300, [hand]));
  await page.click('#rec');
  assert.equal(await page.evaluate(() => window.__nativeStudio.takes[0].frames.length), 3, 'one key per delivered native result');
  await page.click('#review-open');
  await page.click('#rv-glb');
  await page.waitForFunction(() => window.exports.length === 1, null, { timeout: 60000 });
  const saved = await page.evaluate(() => window.exports[0]);
  const buf = Buffer.concat(saved.chunks.map(s => Buffer.from(s, 'base64')));
  assert.equal(buf.length, saved.size); assert.equal(buf.readUInt32LE(0), 0x46546c67); assert.equal(buf.readUInt32LE(8), buf.length);
  const jsonLen = buf.readUInt32LE(12);
  const gltf = JSON.parse(buf.subarray(20, 20 + jsonLen).toString());
  assert.ok(gltf.skins?.length && gltf.animations?.length, 'skeletal mesh and animation exported');
  const root = gltf.scenes.find(n => n.extras?.tracking === 'native-direct-v1');
  assert.ok(root); assert.equal(root.extras.raw.frames.length, 3);
  assert.equal(root.extras.armPipeline, 'web-arm-wrist-v1');
  const anim = gltf.animations[0], bin = 20 + jsonLen + 8;
  const tracks = {};
  for (const c of anim.channels) {
    const a = gltf.accessors[anim.samplers[c.sampler].output], v = gltf.bufferViews[a.bufferView];
    const count = a.type === 'VEC4' ? 4 : 3;
    const start = bin + (v.byteOffset || 0) + (a.byteOffset || 0);
    const values = Array.from({ length: a.count * count }, (_, i) => buf.readFloatLE(start + i * 4));
    assert.ok(values.every(Number.isFinite), 'finite animation values');
    tracks[`${gltf.nodes[c.target.node].name}.${c.target.path}`] = values;
  }
  assert.deepEqual(tracks['RightShoulder.scale'], [1,1,1,0,0,0,1,1,1], 'direct export does not fill lost-hand gap');
  const wantedWrist = await page.evaluate(() => window.__nativeStudio.takes[0].frames[0].hands.right.handQ);
  const globalWrist = new THREE.Quaternion();
  for (const bone of ['RightArm', 'RightForeArm', wristName('right')]) globalWrist.multiply(new THREE.Quaternion().fromArray(tracks[`${bone}.rotation`].slice(0,4)));
  assert.ok(Math.abs(globalWrist.dot(new THREE.Quaternion().fromArray(wantedWrist))) > .99999, 'GLB matches displayed web wrist orientation');
  const expected = await page.evaluate(() => window.__nativeStudio.takes[0].frames[0].hands.right.fingers);
  let checked = 0;
  for (const [bone, q] of Object.entries(expected)) {
    if (!tracks[`${bone}.rotation`]) continue;
    checked++;
    const got = tracks[`${bone}.rotation`].slice(0,4);
    const dot = got.reduce((s,x,i) => s + x*q[i], 0);
    assert.ok(Math.abs(Math.abs(dot)-1) < 1e-5, `${bone}: exporter preserves direct finger rotation`);
  }
  assert.equal(checked, 15, 'all fifteen finger bones checked');
  await page.click('#rv-close');
  await page.click('#rec');
  await send(packet(1400, [hand]));
  await page.evaluate(() => window.HMSNative.pause());
  assert.equal(await page.evaluate(() => window.__nativeStudio.recording), false, 'pause stops recording without erasing finished take');
  assert.equal(await page.evaluate(() => window.__nativeStudio.takes.length), 2);
  assert.deepEqual(errors, []);
  console.log(`Native Studio: offline assets, Quest skin, raw recording, lost hand, review, chunked GLB (${buf.length} bytes), skeleton, finger tracks and pause PASS`);
} finally { await browser.close(); srv.close(); }
