/* Lets the app open with no signal. Bump VERSION whenever you change the app files. */
const VERSION = 'lease-tracker-v1';
const SHELL = [
  './',
  'index.html',
  'styles.css',
  'lease-math.js',
  'app.js',
  'manifest.webmanifest',
  'fonts/overpass-latin-wght-normal.woff2',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'google-sheet/Code.gs'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// App files: answer from the cache right away, refresh the cache in the background.
// Requests to Google (the Sheet) are never touched.
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.open(VERSION).then(async cache => {
      const cached = await cache.match(req, { ignoreSearch: true });
      const fresh = fetch(req).then(res => {
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      }).catch(() => cached);
      return cached || fresh;
    })
  );
});
