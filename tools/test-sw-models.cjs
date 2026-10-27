// Browser check of sw.js: a model replaced under the same file name reaches a
// phone that stored the old copy, the old copy is dropped, and it works
// offline. A throwaway site with the repo's sw.js; needs Playwright with Chromium.
//   node tools/test-sw-models.cjs
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-test-'));
fs.mkdirSync(path.join(root, 'vendor/models'), { recursive: true });
fs.copyFileSync(path.join(__dirname, '..', 'sw.js'), path.join(root, 'sw.js'));
const page = (h) => `<!doctype html><script>
window.HMS_CONFIG={modelHash:{'vendor/models/joint_cube.bin':'${h}'}};
navigator.serviceWorker.register('sw.js');
</script>`;
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const f = path.join(root, u.pathname === '/' ? 'index.html' : u.pathname);
  if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript' : f.endsWith('.html') ? 'text/html' : 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(f).pipe(res);
}).listen(8131);
(async () => {
  const fail = [];
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  const getModel = (h) => p.evaluate(async (h) => {
    const r = await fetch('vendor/models/joint_cube.bin' + (h ? '?h=' + h : ''));
    return r.ok ? new TextDecoder().decode(await r.arrayBuffer()) : 'HTTP ' + r.status;
  }, h);
  const cached = () => p.evaluate(async () => { const c = await caches.open('hms-vendor-1'); return (await c.keys()).map((k) => new URL(k.url).pathname + new URL(k.url).search); });
  // Release 1: model A, and a phone that stored it under the old plain name too.
  fs.writeFileSync(path.join(root, 'index.html'), page('aaaa'));
  fs.writeFileSync(path.join(root, 'vendor/models/joint_cube.bin'), 'MODEL-A');
  await p.goto('http://localhost:8131/');
  await p.evaluate(() => navigator.serviceWorker.ready);
  await p.reload();
  await p.evaluate(() => navigator.serviceWorker.ready);
  if (!(await p.evaluate(() => !!navigator.serviceWorker.controller))) fail.push('page not controlled by sw');
  const a0 = await getModel(null), a1 = await getModel('aaaa');
  console.log('release 1:', a0, a1, JSON.stringify(await cached()));
  // Release 2: model replaced under the same file name.
  fs.writeFileSync(path.join(root, 'index.html'), page('bbbb'));
  fs.writeFileSync(path.join(root, 'vendor/models/joint_cube.bin'), 'MODEL-B');
  await p.reload();
  const h = await p.evaluate(() => HMS_CONFIG.modelHash['vendor/models/joint_cube.bin']);
  const b = await getModel(h);
  const list = await cached();
  console.log('release 2:', h, b, JSON.stringify(list));
  if (b !== 'MODEL-B') fail.push('new model not fetched: ' + b);
  if (list.length !== 1 || !list[0].endsWith('?h=bbbb')) fail.push('old copies kept: ' + list);
  // Offline: the stored new model is served.
  await ctx.setOffline(true);
  const off = await getModel('bbbb');
  console.log('offline:', off);
  if (off !== 'MODEL-B') fail.push('offline model missing: ' + off);
  // Same hash again online: no second download (served from the store).
  await ctx.setOffline(false);
  let hits = 0; srv.on('request', (r) => { if (r.url.includes('joint_cube')) hits++; });
  await getModel('bbbb');
  console.log('repeat downloads:', hits);
  if (hits) fail.push('model downloaded again');
  await browser.close(); srv.close();
  console.log(fail.length ? 'FAIL ' + fail.join('; ') : 'all passed');
  process.exit(fail.length ? 1 : 0);
})();
