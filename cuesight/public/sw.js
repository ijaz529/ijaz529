// CueSight service worker: offline app shell. Same-origin GETs only; no user data, no network calls of its own.
// - Precache: the shell, every built JS/CSS/worker file (BUILD_ASSETS, written into dist/sw.js at build time by
//   scripts/sw-precache.ts, because on a first visit those load before this worker controls the page), the manifest
//   and the icon set. Install fails if the shell or a built file is missing, so a broken deploy never replaces a
//   working one.
// - Navigations: the precached shell first (offline). A new deploy changes this file (its file list and BUILD_ID,
//   which also hashes index.html), so the browser installs the new worker, which precaches the new shell and files
//   as one set and drops this cache when it activates: the new version shows on the next launch, and the shell and
//   the files it references always come from the same build.
// - Everything else (sample photos): cache-first, cached on first successful fetch.
// The iOS app (Capacitor, capacitor://localhost) does not register a service worker; its assets are bundled.
const BUILD_ASSETS = [];
const BUILD_ID = 'dev';
const CACHE = `cuesight-v2-${BUILD_ID}`;
const SHELL = ['./', './index.html'];
const ASSETS = [
  './manifest.webmanifest',
  './icon.svg',
  './icons/favicon-32.png',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => Promise.all([c.addAll(SHELL), c.addAll(BUILD_ASSETS), ...ASSETS.map((u) => c.add(u).catch(() => undefined))]))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((ks) => Promise.all(ks.filter((k) => k.startsWith('cuesight-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

function putIfCacheable(req, res) {
  if (res && res.status === 200 && res.type === 'basic') {
    const copy = res.clone();
    return caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => undefined);
  }
  return Promise.resolve();
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  const path = new URL(req.url).pathname;
  if (req.mode === 'navigate' && (path.endsWith('/') || path.endsWith('/index.html'))) {
    e.respondWith(
      caches
        .match('./index.html', { ignoreVary: true })
        .then((hit) => hit || fetch(req).catch(() => caches.match('./', { ignoreSearch: true, ignoreVary: true })))
        .then((res) => res || Response.error()),
    );
    return;
  }

  // ignoreVary: precached responses were fetched by this worker (no Origin header), while the page's module
  // scripts are CORS-mode requests that carry one; servers that answer `Vary: Origin` would otherwise miss.
  e.respondWith(
    caches.match(req, { ignoreSearch: true, ignoreVary: true }).then(
      (hit) => hit || fetch(req).then((res) => putIfCacheable(req, res).then(() => res)),
    ),
  );
});
