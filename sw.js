/* Lets the app open with no signal. Bump VERSION whenever you change the app files
   (and APP_VERSION at the top of app.js, which is the number shown under Lease setup). */
const VERSION = 'lease-tracker-v4';
const SHELL = [
  './',
  'index.html',
  'styles.css',
  'lease-math.js',
  'app.js',
  'manifest.webmanifest',
  'fonts/overpass-latin-wght-normal.woff2',
  'icons/car-192.png',
  'icons/car-512.png',
  'google-sheet/Code.gs'
];

// 'reload' skips the browser's own cache, so a new version never installs yesterday's files.
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(VERSION)
      .then(c => c.addAll(SHELL.map(url => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// App files: ask the network first so updates show up right away; fall back to the saved copy
// when offline or when the network takes longer than 2.5 seconds.
// Requests to Google (the Sheet) are never touched.
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const cached = await cache.match(req, { ignoreSearch: true });
    const network = fetch(req, { cache: 'no-cache' }).then(res => {
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    });
    if (!cached) return network;
    network.catch(() => {});                          // offline: the saved copy below is the answer
    const slow = new Promise(resolve => setTimeout(() => resolve(null), 2500));
    try {
      const res = await Promise.race([network, slow]);
      return res && res.ok ? res : cached;
    } catch (e) {
      return cached;
    }
  })());
});
