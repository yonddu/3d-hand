// Keeps the large files on the phone between visits (written by hand, not built).
//
// The models and the tracking engine (~28 MB in vendor/) never change under
// the same name, so once fetched they are served from the phone. The app
// code (app.bundle.js?h=<hash of its contents>) is new under a new name with
// every release, so it is fetched once per release and the old copy dropped.
// The page itself (index.html) is always asked for first, so a new release
// shows on the next visit; the stored copy is used only offline.
// The picture models (vendor/models/*.bin) are asked for as <file>?h=<hash of
// its contents> (build.mjs, palmFace.js versioned()), so a replaced model is a
// new name. The server ignores the ?h=, so the bytes are checked against it
// before they are stored: a page of an older release asking for its model
// after the file was replaced gets the new bytes, which are not stored under
// the old name (the page refuses them too, palmFace.js fetchModel). Per file
// the two newest stored versions are kept, so a tab still on the previous
// release works offline; copies stored without a hash (before 2026-10-27)
// are dropped once a hashed one is there. Change VENDOR when any other file
// in vendor/ is replaced under the same name.
const VENDOR = 'hms-vendor-1';
const APP = 'hms-app';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('hms-vendor-') && k !== VENDOR).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function stored(cacheName, req, dropOthers = null) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) {
    await cache.put(req, res.clone());
    if (dropOthers) for (const k of await cache.keys()) if (dropOthers(k) && k.url !== req.url) await cache.delete(k);
  }
  return res;
}

const KEEP = 2; // versions of one model kept
const hex = async (buf) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map((b) => b.toString(16).padStart(2, '0')).join('');
async function model(req) {
  const cache = await caches.open(VENDOR);
  const url = new URL(req.url);
  const want = url.searchParams.get('h');
  const same = async () => (await cache.keys()).filter((k) => new URL(k.url).pathname === url.pathname);
  const tidy = async () => {
    const all = await same();
    const hashed = all.filter((k) => new URL(k.url).searchParams.get('h'));
    if (!hashed.length) return;
    for (const k of all.filter((k) => !new URL(k.url).searchParams.get('h'))) await cache.delete(k);
    // keys() lists in the order stored; a hit is stored again to count as new
    for (const k of hashed.slice(0, Math.max(0, hashed.length - KEEP))) await cache.delete(k);
  };
  const hit = await cache.match(req);
  if (hit) {
    if (want) {
      await cache.put(req, hit.clone());
      await tidy();
    }
    return hit;
  }
  const res = await fetch(req, want ? { cache: 'no-cache' } : undefined);
  if (!res.ok) return res;
  if (want && (await hex(await res.clone().arrayBuffer())).slice(0, want.length) !== want) return res; // another release's bytes: not stored
  await cache.put(req, res.clone());
  if (want) await tidy();
  return res;
}

async function fresh(req) {
  const cache = await caches.open(APP);
  try {
    const res = await fetch(req);
    if (res.ok) await cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    throw err;
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const path = url.pathname;
  if (path.includes('/vendor/models/') && path.endsWith('.bin')) e.respondWith(model(req));
  else if (path.includes('/vendor/')) e.respondWith(stored(VENDOR, req));
  else if (path.endsWith('/app.bundle.js')) e.respondWith(stored(APP, req, (k) => new URL(k.url).pathname.endsWith('/app.bundle.js')));
  else if (req.mode === 'navigate') e.respondWith(fresh(req));
});
