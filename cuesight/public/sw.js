// CueSight service worker: offline app shell. Same-origin GETs only; no user data, no network calls of its own.
// - Precache: the shell plus every file of the build (BUILD_ASSETS: the JS/CSS chunks, both worker scripts, the
//   icons, the manifest and the Snap sample photos), written into dist/sw.js at build time by
//   scripts/sw-precache.ts, because on a first visit the chunks load before this worker controls the page and the
//   sample photos may never be fetched online. Install fails if any of them is missing, so a broken deploy never
//   replaces a working one.
// - Updates: a new deploy changes this file (its file list and BUILD_ID, which also hashes index.html), so the
//   browser installs the new worker next to the running one, and it WAITS. An open page keeps running the build it
//   loaded, and that build creates its planner/vision workers and fetches its photos lazily, by its own hashed file
//   names. The page offers "Reload" instead (src/app/sw-update.ts), which posts 'skip-waiting'; otherwise the new
//   version starts once every tab of the old one is closed.
// - If the new worker activates while pages of an older build are still open (another tab took the update), the
//   older caches are kept until every client that was open at activation is gone, so those pages can still load
//   their files; the ids are kept in the cache storage, which outlives this worker's restarts.
// - Navigations: this build's precached shell (offline), so the shell and the files it references always come
//   from the same build.
// - Everything else: cache-first (this build, then the older builds kept for open pages), cached on first fetch.
// The iOS app (Capacitor, capacitor://localhost) does not register a service worker; its assets are bundled.
const BUILD_ASSETS = [];
const BUILD_ID = 'dev';
const CACHE = `cuesight-v2-${BUILD_ID}`;
const SHELL = ['./', './index.html'];
/** Where this worker records, when it takes over from an older build, the clients open then and the caches they need. */
const KEEP = './__cuesight-sw/older-build-clients';

self.addEventListener('install', (e) => {
  // No skipWaiting() here: an open page must keep the worker (and the cache) of its own build. See 'message'.
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll([...SHELL, ...BUILD_ASSETS])));
});

self.addEventListener('message', (e) => {
  // "Reload" on the page's update prompt: take over now; the page reloads when it sees the new controller.
  if (e.data && e.data.type === 'skip-waiting') e.waitUntil(self.skipWaiting());
});

const openClients = () => self.clients.matchAll({ type: 'all', includeUncontrolled: true });
const dropCaches = (names) => Promise.all(names.map((k) => caches.delete(k)));
// Caches of older builds: those created before this build's (caches.keys() is in creation order), so never the
// cache of a newer build that is installing meanwhile.
const olderCaches = () =>
  caches.keys().then((ks) => {
    const i = ks.indexOf(CACHE);
    return i < 0 ? [] : ks.slice(0, i).filter((k) => k.startsWith('cuesight-'));
  });

self.addEventListener('activate', (e) => {
  e.waitUntil(
    Promise.all([caches.open(CACHE), olderCaches(), openClients()])
      .then(([cache, older, open]) => {
        if (!older.length) return undefined;
        if (!open.length) return dropCaches(older);
        const keep = { clients: open.map((c) => c.id), caches: older };
        return cache.put(KEEP, new Response(JSON.stringify(keep), { headers: { 'content-type': 'application/json' } }));
      })
      .then(() => self.clients.claim()),
  );
});

/** True until this worker has seen that no older build's cache is kept for open pages (re-checked after a restart). */
let pruneDue = true;
function pruneOlderCaches() {
  return caches
    .open(CACHE)
    .then((cache) =>
      cache.match(KEEP, { ignoreVary: true }).then((rec) => {
        if (!rec) {
          pruneDue = false;
          return undefined;
        }
        return Promise.all([rec.json(), openClients()]).then(([keep, open]) => {
          if (open.some((c) => keep.clients.includes(c.id))) return undefined;
          pruneDue = false;
          return dropCaches(keep.caches).then(() => cache.delete(KEEP));
        });
      }),
    )
    .catch(() => undefined);
}

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
  if (pruneDue) e.waitUntil(pruneOlderCaches());

  const path = new URL(req.url).pathname;
  if (req.mode === 'navigate' && (path.endsWith('/') || path.endsWith('/index.html'))) {
    e.respondWith(
      caches
        .open(CACHE)
        .then((cache) =>
          cache
            .match('./index.html', { ignoreVary: true })
            .then((hit) => hit || fetch(req).catch(() => cache.match('./', { ignoreSearch: true, ignoreVary: true }))),
        )
        .then((res) => res || Response.error()),
    );
    return;
  }

  // ignoreVary: precached responses were fetched by this worker (no Origin header), while the page's module
  // scripts are CORS-mode requests that carry one; servers that answer `Vary: Origin` would otherwise miss.
  e.respondWith(
    caches
      .open(CACHE)
      .then((cache) => cache.match(req, { ignoreSearch: true, ignoreVary: true }))
      .then((hit) => hit || caches.match(req, { ignoreSearch: true, ignoreVary: true }))
      .then((hit) => hit || fetch(req).then((res) => putIfCacheable(req, res).then(() => res))),
  );
});
