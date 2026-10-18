/* Service Worker: hält die App offline verfügbar (Cache zuerst, im Hintergrund aktualisieren).
   Wichtig: Dateien immer am HTTP-Cache vorbei laden – sonst landet nach einem Update evtl. noch alter Code im Offline-Speicher. */
const CACHE = 'birdie-book-v4';
const ASSETS = ['./', './index.html', './app.js', './manifest.webmanifest', './icon-192.png', './icon-512.png', './apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(ASSETS.map(u => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  const key = url.origin + url.pathname; // ohne ?v=… speichern
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = (await cache.match(key)) ||
      (req.mode === 'navigate' ? (await cache.match('./index.html')) || (await cache.match('./')) : undefined);
    const network = fetch(new Request(req.url, { cache: 'no-cache', credentials: 'same-origin' })).then(res => {
      if (res.ok) cache.put(key, res.clone());
      return res;
    }).catch(() => cached || Response.error());
    if (cached) { e.waitUntil(network); return cached; }
    return network;
  })());
});
