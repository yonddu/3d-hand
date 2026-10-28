// Browser check that the picture networks' GPU path (src/gpuNet.js, WebGL2)
// gives the same outputs as the plain JS loops (palmFace.js conv), and how
// long each takes per crop. Serves the repo on port 8133 (Playwright with
// Chromium; headless Chromium draws WebGL on the CPU (SwiftShader), so its
// GPU times are not a phone's).
//   node tools/test-gpu-net.mjs [model.bin ...]   (default: the app's two)
import http from 'http';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const { chromium } = createRequire(import.meta.url)('playwright');
const repo = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const models = process.argv.slice(2).length ? process.argv.slice(2) : ['vendor/models/finger_curl.bin', 'vendor/models/joint_cube.bin'];
const outsOf = (f) => (/cube/.test(f) ? 30 : 15);

const types = { '.js': 'text/javascript', '.html': 'text/html' };
const srv = http.createServer((req, res) => {
  const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (u === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<!doctype html><title>gpu</title>'); }
  const f = u.startsWith('/model/') ? path.resolve(u.slice(7)) : path.join(repo, u);
  if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
}).listen(8133);
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
let bad = 0;
try {
  const page = await browser.newPage();
  page.on('console', (m) => m.type() === 'warning' && console.log('page:', m.text()));
  await page.goto('http://localhost:8133/');
  for (const m of models) {
    const r = await page.evaluate(async ([url, outs]) => {
      const { pictureNet } = await import('/src/fingerCurl.js');
      const { conv } = await import('/src/palmFace.js');
      const net = pictureNet(url, outs);
      await net.load();
      if (!net.gpu()) return { gpu: false };
      const S = net.size();
      // The same network in plain JS, from the same file.
      const buf = await (await fetch(url)).arrayBuffer();
      const { half } = await import('/src/palmFace.js');
      const h = new Uint16Array(buf);
      const all = Float32Array.from(h, half);
      const L = S === 128 ? [[3, 16], [16, 16], [16, 32], [32, 48], [48, 64]] : [[3, 16], [16, 32], [32, 48], [48, 64]];
      let o = 0;
      const take = (n) => all.subarray(o, (o += n));
      const w = L.map(([ci, co]) => ({ ci, co, w: take(9 * ci * co), b: take(co) }));
      const dense = { w: take(1024 * 2 * outs), b: take(2 * outs) };
      const js = (rgba) => {
        let x = new Float32Array(S * S * 3);
        for (let i = 0; i < S * S; i++) for (let c = 0; c < 3; c++) x[i * 3 + c] = rgba[i * 4 + c] / 255 - 0.5;
        let size = S;
        for (const l of w) { x = conv(x, size, l); size /= 2; }
        const out = Array.from(dense.b);
        for (let i = 0; i < 1024; i++) for (let c = 0; c < 2 * outs; c++) out[c] += x[i] * dense.w[i * 2 * outs + c];
        return out;
      };
      let diff = 0;
      const crops = [];
      for (let k = 0; k < 8; k++) {
        const rgba = new Uint8ClampedArray(S * S * 4);
        // A smooth picture with some edges, not pure noise.
        for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) for (let c = 0; c < 3; c++) rgba[(y * S + x) * 4 + c] = 128 + 100 * Math.sin((x * (c + 1) + y * (k + 2)) / 9) * (x > S / 3 ? 1 : 0.4);
        crops.push(rgba);
        const a = js(rgba);
        const b = net.run(rgba);
        for (let c = 0; c < a.length; c++) diff = Math.max(diff, Math.abs(a[c] - b[c]));
      }
      const time = (f) => { const t0 = performance.now(); for (let i = 0; i < 20; i++) f(crops[i % 8]); return (performance.now() - t0) / 20; };
      return { gpu: true, S, diff, jsMs: time(js), gpuMs: time(net.run) };
    }, ['/model/' + path.resolve(m), outsOf(m)]);
    if (!r.gpu) { console.log(`${m}: GPU path unavailable`); bad++; continue; }
    const ok = r.diff < 1e-3;
    if (!ok) bad++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${m}: crop ${r.S}, max output diff ${r.diff.toExponential(2)}, JS ${r.jsMs.toFixed(1)} ms, GPU ${r.gpuMs.toFixed(1)} ms per crop`);
  }
} finally {
  await browser.close();
  srv.close();
}
process.exit(bad ? 1 : 0);
