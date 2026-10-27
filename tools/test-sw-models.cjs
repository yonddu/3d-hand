// Browser check of sw.js and the picture models' versions (Playwright with
// Chromium, a throwaway site on port 8131):
//   - a phone whose older service worker (v89, fec401b) stored the model
//     with and without a hash moves to this one: the copy without a hash goes;
//   - a model replaced under the same file name reaches it once per release,
//     the two newest versions stay (a tab on the previous release works
//     offline), older ones go;
//   - an old tab asking for its model after the file was replaced is handed
//     the new bytes by the server, and they are not stored under its name;
//   - a stored model is not downloaded again.
// Then, without a browser, palmFace.js fetchModel refuses another release's
// bytes and a failed load is tried again.
//   node tools/test-sw-models.cjs
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');
const repo = path.join(__dirname, '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-test-'));
fs.mkdirSync(path.join(root, 'vendor/models'), { recursive: true });
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 10);
const page = (h) => `<!doctype html><script>
window.HMS_CONFIG={modelHash:{'vendor/models/joint_cube.bin':'${h}'}};
navigator.serviceWorker.register('sw.js');
</script>`;
let hits = 0;
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname.includes('joint_cube')) hits++;
  const f = path.join(root, u.pathname === '/' ? 'index.html' : u.pathname);
  if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript' : f.endsWith('.html') ? 'text/html' : 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(f).pipe(res);
}).listen(8131);
const fail = [];
const want = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fail.push(what); };

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  const getModel = (h) => p.evaluate(async (h) => {
    const r = await fetch('vendor/models/joint_cube.bin' + (h ? '?h=' + h : ''));
    return r.ok ? new TextDecoder().decode(await r.arrayBuffer()) : 'HTTP ' + r.status;
  }, h);
  const cached = () => p.evaluate(async () => { const c = await caches.open('hms-vendor-1'); return (await c.keys()).map((k) => new URL(k.url).search || 'plain'); });
  const release = (model) => {
    fs.writeFileSync(path.join(root, 'vendor/models/joint_cube.bin'), model);
    fs.writeFileSync(path.join(root, 'index.html'), page(hash(model)));
    return hash(model);
  };
  // v89's service worker, model A stored under the plain name and with a hash.
  fs.writeFileSync(path.join(root, 'sw.js'), execFileSync('git', ['show', 'fec401b:sw.js'], { cwd: repo }));
  const A = release('MODEL-A');
  await p.goto('http://localhost:8131/');
  await p.evaluate(() => navigator.serviceWorker.ready);
  await p.reload();
  await getModel(null);
  await getModel(A);
  console.log('under v89:', JSON.stringify(await cached()));
  // This service worker takes over.
  fs.copyFileSync(path.join(repo, 'sw.js'), path.join(root, 'sw.js'));
  await p.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    await reg.update();
    await new Promise((ok) => (navigator.serviceWorker.controller && reg.active && !reg.installing && !reg.waiting && reg.active.scriptURL.endsWith('sw.js') && navigator.serviceWorker.addEventListener('controllerchange', ok, { once: true })) || setTimeout(ok, 1500));
  });
  await p.reload();
  want((await getModel(A)) === 'MODEL-A', 'after the update, model A served');
  want(JSON.stringify(await cached()) === JSON.stringify([`?h=${A}`]), `the copy without a hash dropped: ${JSON.stringify(await cached())}`);
  // Release B, then C, under the same file name.
  const B = release('MODEL-B');
  await p.reload();
  want((await getModel(B)) === 'MODEL-B', 'release B fetched');
  want(JSON.stringify(await cached()) === JSON.stringify([`?h=${A}`, `?h=${B}`]), `A and B kept: ${JSON.stringify(await cached())}`);
  await ctx.setOffline(true);
  want((await getModel(A)) === 'MODEL-A' && (await getModel(B)) === 'MODEL-B', 'offline: both stored versions served');
  await ctx.setOffline(false);
  const C = release('MODEL-C');
  await p.reload();
  want((await getModel(C)) === 'MODEL-C', 'release C fetched');
  const afterC = await cached();
  want(afterC.length === 2 && afterC.includes(`?h=${B}`) && afterC.includes(`?h=${C}`), `B and C kept, A dropped: ${JSON.stringify(afterC)}`);
  // An old tab asks for A, which the server no longer has: C's bytes come
  // back and are not stored as A.
  const oldTab = await getModel(A);
  const afterOld = await cached();
  want(oldTab === 'MODEL-C' && !afterOld.includes(`?h=${A}`) && afterOld.length === 2, `A's name not given C's bytes: ${JSON.stringify(afterOld)}`);
  // Stored: no second download.
  hits = 0;
  await getModel(C);
  want(hits === 0, `stored model not downloaded again (${hits})`);
  await browser.close();
  srv.close();

  // The page's own check (palmFace.js fetchModel), in Node.
  const { fetchModel } = await import(path.join(repo, 'src/palmFace.js'));
  const bytes = (s) => new TextEncoder().encode(s).buffer;
  globalThis.HMS_CONFIG = { modelHash: { 'vendor/models/joint_cube.bin': hash('MODEL-A') } };
  globalThis.fetch = async () => new Response(bytes('MODEL-C'));
  const refused = await fetchModel('vendor/models/joint_cube.bin').then(() => false, () => true);
  want(refused, "page refuses another release's model");
  globalThis.fetch = async () => new Response(bytes('MODEL-A'));
  const okBytes = await fetchModel('vendor/models/joint_cube.bin');
  want(new TextDecoder().decode(okBytes) === 'MODEL-A', "page takes its own release's model");
  globalThis.HMS_CONFIG = { modelHash: { 'vendor/models/joint_cube.bin': hash('MODEL-A') }, modelBase64: { 'vendor/models/joint_cube.bin': 'joint_cube.bin.b64.txt' } };
  globalThis.fetch = async (u) => new Response(u.endsWith('.b64.txt') ? Buffer.from('MODEL-A').toString('base64') : 'x');
  want(new TextDecoder().decode(await fetchModel('vendor/models/joint_cube.bin')) === 'MODEL-A', 'artifact: model read from base64 text');
  const { pictureNet } = await import(path.join(repo, 'src/fingerCurl.js'));
  let calls = 0;
  globalThis.fetch = async () => (++calls === 1 ? new Response('', { status: 503 }) : new Response(bytes('MODEL-A')));
  globalThis.HMS_CONFIG = {};
  const net = pictureNet('vendor/models/joint_cube.bin', 1);
  await net.load().catch(() => {});
  await net.load().catch(() => {});
  want(calls === 2, 'a failed load is tried again');
  console.log(fail.length ? `${fail.length} failed` : 'all passed');
  process.exit(fail.length ? 1 : 0);
})();
