// Browser check that a saved GLB draws a hand only while it is seen
// (exportGlb.js HIDE_GAP): hidden before it first shows and after it last
// shows, held over short gaps, hidden over long ones. Serves the built app
// (npm run build first) on port 8132 and saves through its own exporter
// (Playwright with Chromium).
//   node tools/test-export-hide.mjs
import http from 'http';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { readTake, replay } from './replay.mjs';

const { chromium } = createRequire(import.meta.url)('playwright'); // global install, as test-sw-models.cjs
const repo = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const motion = replay(readTake('/mnt/project-files/hand-motion-studio/takes/left_pop_20-47.glb'), { keep: true }).motion;
// Right seen throughout; left (a copy of the right) seen at frames 100-109,
// then 112-119 after a 2-frame gap, then 200-204 after a long gap.
const frames = motion.filter((f) => f.hands.right).slice(0, 260).map((f, i) => ({
  t: f.t,
  hands: { right: f.hands.right, left: (i >= 100 && i < 110) || (i >= 112 && i < 120) || (i >= 200 && i < 205) ? f.hands.right : null },
}));
const want = { 0: 0, 99: 0, 100: 1, 110: 1, 111: 1, 119: 1, 120: 0, 199: 0, 200: 1, 204: 1, 205: 0, 259: 0 };

const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.json': 'application/json', '.wasm': 'application/wasm' };
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const f = path.join(repo, decodeURIComponent(u.pathname === '/' ? '/index.html' : u.pathname));
  if (!f.startsWith(repo) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
}).listen(8132);
const browser = await chromium.launch();
const fail = [];
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('page error:', e.message));
  await page.goto('http://localhost:8132/');
  await page.waitForFunction(() => window.__hms && window.__hms.exportSkins, null, { timeout: 60000 });
  const scales = await page.evaluate(async (frames) => {
    const buf = await window.__hms.exportGlb({ frames, skins: window.__hms.exportSkins(), includeObjects: false });
    const dv = new DataView(buf);
    const jl = dv.getUint32(12, true);
    const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, jl)));
    const bin = 20 + jl + 8;
    const out = {};
    const anim = json.animations[0];
    for (const c of anim.channels) {
      const name = json.nodes[c.target.node].name;
      if (c.target.path !== 'scale' || !/Shoulder$/.test(name)) continue;
      const a = json.accessors[anim.samplers[c.sampler].output];
      const v = json.bufferViews[a.bufferView];
      const f = new Float32Array(buf.slice(bin + (v.byteOffset || 0) + (a.byteOffset || 0), bin + (v.byteOffset || 0) + (a.byteOffset || 0) + a.count * 12));
      out[name] = Array.from({ length: a.count }, (_, i) => f[i * 3]);
    }
    return out;
  }, frames);
  const ok = (c, what) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${what}`); if (!c) fail.push(what); };
  ok(scales.RightShoulder && scales.RightShoulder.every((s) => s === 1), 'right hand, seen throughout, is always drawn');
  ok(!!scales.LeftShoulder, 'left arm has a scale track');
  for (const [i, s] of Object.entries(want)) ok(scales.LeftShoulder && scales.LeftShoulder[i] === s, `left frame ${i}: ${s ? 'drawn' : 'hidden'}`);
} finally {
  await browser.close();
  srv.close();
}
if (fail.length) process.exit(1);
console.log('all export hide checks pass');
