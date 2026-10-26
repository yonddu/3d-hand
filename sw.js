// Keeps the large files on the phone between visits (written by hand, not built).
//
// The models and the tracking engine (~28 MB in vendor/) never change under
// the same name, so once fetched they are served from the phone. The app
// code (app.bundle.js?h=<hash of its contents>) is new under a new name with
// every release, so it is fetched once per release and the old copy dropped.
// The page itself (index.html) is always asked for first, so a new release
// shows on the next visit; the stored copy is used only offline.
// Change VENDOR when a file in vendor/ is replaced under the same name.
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
    if (dropOthers) for (const k of await cache.keys()) if (dropOthers(k) && k.url !== req.url) await cache.delete(k);
    await cache.put(req, res.clone());
  }
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
  if (path.includes('/vendor/')) e.respondWith(stored(VENDOR, req));
  else if (path.endsWith('/app.bundle.js')) e.respondWith(stored(APP, req, (k) => new URL(k.url).pathname.endsWith('/app.bundle.js')));
  else if (req.mode === 'navigate') e.respondWith(fresh(req));
});
