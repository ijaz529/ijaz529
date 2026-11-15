/**
 * Offline after the first load (Constitution V): the service worker must precache every built file,
 * and its cache lookups must not depend on request headers the precache fetch did not send. A deploy
 * must not break a page that is already open (it loads its workers and photos lazily, from its own
 * build). The behaviour itself is covered end to end by tests/e2e/offline.spec.ts and update.spec.ts.
 */
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import vm from 'node:vm';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ASSETS_PLACEHOLDER, buildId, contentDigest, ID_PLACEHOLDER, injectPrecache, listedAssets, precacheList, verifyPrecache } from '../../scripts/sw-precache';

const sw = readFileSync('public/sw.js', 'utf8');
const root = process.cwd();

describe('service worker precache manifest', () => {
  it('lists every built file except source maps, the HTML shell and the worker itself, sorted and relative', () => {
    const list = precacheList(['assets/index-b.js', 'assets/index-b.js.map', 'index.html', 'assets/a.css', 'assets/vision.worker-x.js', 'sw.js', 'assets/a.css']);
    expect(list).toEqual(['./assets/a.css', './assets/index-b.js', './assets/vision.worker-x.js']);
  });

  it('includes the public files (icons, manifest, Snap sample photos), with Windows separators normalised', () => {
    const list = precacheList(['assets/index-b.js', 'samples\\snap-table.png', 'icons/icon-192.png', 'manifest.webmanifest']);
    expect(list).toEqual(['./assets/index-b.js', './icons/icon-192.png', './manifest.webmanifest', './samples/snap-table.png']);
  });

  it('injects the list and a build id that changes with the file names', () => {
    const a = ['./assets/index-1.js'];
    const b = ['./assets/index-2.js'];
    const out = injectPrecache(sw, a);
    expect(out).toContain('const BUILD_ASSETS = ["./assets/index-1.js"];');
    expect(out).toContain(`const BUILD_ID = '${buildId(a)}';`);
    expect(out).not.toContain(ASSETS_PLACEHOLDER);
    expect(listedAssets(out)).toEqual(a);
    expect(buildId(a)).not.toBe(buildId(b));
    expect(buildId(a)).toMatch(/^[0-9a-f]{10}$/);
    // An edit to index.html alone (same asset names) still gives a new build id, so the shell updates.
    expect(buildId(a, '<html>1</html>')).not.toBe(buildId(a, '<html>2</html>'));
    expect(injectPrecache(sw, a, '<html>x</html>')).toContain(`const BUILD_ID = '${buildId(a, '<html>x</html>')}';`);
    // So does a change to a file's bytes under the same name (an unhashed public file such as a sample photo).
    expect(buildId(a, '<html>x</html>', 'photo 1')).not.toBe(buildId(a, '<html>x</html>', 'photo 2'));
    expect(injectPrecache(sw, a, '<html>x</html>', 'photo 1')).toContain(`const BUILD_ID = '${buildId(a, '<html>x</html>', 'photo 1')}';`);
  });

  it('refuses a service worker without the placeholders (the build would silently lose offline support)', () => {
    expect(() => injectPrecache('self.addEventListener("fetch", () => {});', [])).toThrow(/BUILD_ASSETS/);
  });

  it('verifies a built sw.js against the files on disk: placeholders gone, nothing missing, nothing extra', () => {
    const files = ['index.html', 'sw.js', 'assets/index-1.js', 'assets/index-1.js.map', 'assets/planner.worker-2.js', 'samples/s.png'];
    const good = injectPrecache(sw, precacheList(files));
    expect(verifyPrecache(good, files)).toEqual([]);
    expect(verifyPrecache(sw, files).join('\n')).toMatch(/placeholder/);
    const missing = verifyPrecache(injectPrecache(sw, precacheList(files.filter((f) => !f.includes('worker')))), files);
    expect(missing.join('\n')).toContain('./assets/planner.worker-2.js');
    const extra = verifyPrecache(injectPrecache(sw, precacheList([...files, 'assets/gone.js'])), files);
    expect(extra.join('\n')).toContain('./assets/gone.js');
  });

  it('public/sw.js has each placeholder exactly once, precaches the shell and the build in one step, keyed by build', () => {
    expect(sw.split(ASSETS_PLACEHOLDER)).toHaveLength(2);
    expect(sw.split(ID_PLACEHOLDER)).toHaveLength(2);
    // The shell and the whole build in one step, every request revalidated with the server (the HTTP cache may still
    // hold the previous build's shell). Nothing is written unless every file arrived: see 'precaches the whole build'.
    expect(sw).toContain("[...SHELL, ...BUILD_ASSETS].map((u) => new Request(u, { cache: 'no-cache' }))");
    expect(sw).toMatch(/const CACHE = `cuesight-v\d+-\$\{BUILD_ID\}`/);
  });

  it('cache lookups ignore Vary (precache fetches carry no Origin header; module scripts do)', () => {
    const matches = sw.match(/\bcaches?\s*\.match\([^)]*\)/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(3);
    for (const m of matches) expect(m).toContain('ignoreVary: true');
  });

  it('serves navigations from the precached shell, never writing a newer shell into an older build cache', () => {
    // The shell and the files it references must come from the same build: updates arrive as a new
    // worker with a new BUILD_ID (see the header comment in public/sw.js).
    expect(sw).not.toMatch(/put[A-Za-z]*\(new Request\('\.\/index\.html'\)/);
  });

  it('makes no requests to other origins', () => {
    expect(sw).toContain('new URL(req.url).origin !== self.location.origin) return;');
    expect(sw).not.toMatch(/https?:\/\//);
  });
});

// ---------------------------------------------------------------------------------------------
// public/sw.js itself, run in a VM against fake caches, clients and a static server: build A is
// installed and serving an open page, then build B is deployed.
// ---------------------------------------------------------------------------------------------
const ORIGIN = 'https://cuesight.test';
type Req = { url: string; method: string; mode: string; cache?: string };
/** The worker's `Request`: relative URLs resolve against the worker script, as in a real service worker. */
class FakeRequest implements Req {
  readonly url: string;
  readonly method: string;
  readonly mode: string;
  readonly cache: string;
  constructor(input: string | Req, init: { method?: string; mode?: string; cache?: string } = {}) {
    this.url = new URL(typeof input === 'string' ? input : input.url, `${ORIGIN}/sw.js`).href;
    this.method = init.method ?? 'GET';
    this.mode = init.mode ?? 'cors';
    this.cache = init.cache ?? 'default';
  }
}
const keyOf = (r: Req | string, ignoreSearch = false) => {
  const u = new URL(typeof r === 'string' ? r : r.url, `${ORIGIN}/`);
  return ignoreSearch ? `${u.origin}${u.pathname}` : u.href;
};
const basic = (r: Response) => Object.defineProperty(r, 'type', { value: 'basic' });

class FakeCache {
  readonly m = new Map<string, Response>();
  constructor(private readonly net: (r: Req | string) => Promise<Response>) {}
  async addAll(urls: (string | Req)[]): Promise<void> {
    const got = await Promise.all(urls.map(async (u) => [keyOf(u), await this.net(u)] as const));
    if (got.some(([, r]) => !r.ok)) throw new TypeError('addAll: a request failed');
    for (const [k, r] of got) this.m.set(k, r);
  }
  async add(u: string): Promise<void> {
    await this.addAll([u]);
  }
  async put(r: Req | string, res: Response): Promise<void> {
    this.m.set(keyOf(r), res);
  }
  async match(r: Req | string, o: { ignoreSearch?: boolean } = {}): Promise<Response | undefined> {
    const k = keyOf(r, o.ignoreSearch);
    for (const [key, res] of this.m) if ((o.ignoreSearch ? keyOf(key, true) : key) === k) return res.clone();
    return undefined;
  }
  async delete(r: Req | string): Promise<boolean> {
    return this.m.delete(keyOf(r));
  }
}

/**
 * `maxAge`: the host sends `Cache-Control: max-age` (GitHub Pages: 600 s), so the browser's HTTP cache answers a
 * request in the default cache mode with the copy it already has; 'no-cache' / 'reload' requests go to the server.
 * Without it, every request reaches the server (as with `no-cache` from the host).
 */
function world({ maxAge = false } = {}) {
  let site: Record<string, string> = {};
  const server = async (u: string): Promise<Response> => {
    const path = new URL(u).pathname;
    const body = site[path === '/' ? '/index.html' : path];
    return basic(body === undefined ? new Response('not found', { status: 404 }) : new Response(body, { status: 200 }));
  };
  const http = new Map<string, string>();
  const net = async (r: Req | string): Promise<Response> => {
    const u = keyOf(r);
    const mode = typeof r === 'string' ? 'default' : (r.cache ?? 'default');
    if (maxAge && mode === 'default' && http.has(u)) return basic(new Response(http.get(u), { status: 200 }));
    const res = await server(u);
    if (maxAge && res.ok) http.set(u, await res.clone().text());
    return res;
  };
  const store = new Map<string, FakeCache>();
  const caches = {
    open: async (n: string) => (store.has(n) ? store.get(n)! : store.set(n, new FakeCache(net)).get(n)!),
    keys: async () => [...store.keys()],
    delete: async (n: string) => store.delete(n),
    match: async (r: Req | string, o?: { ignoreSearch?: boolean }) => {
      for (const c of store.values()) {
        const hit = await c.match(r, o);
        if (hit) return hit;
      }
      return undefined;
    },
  };
  let open: string[] = [];
  /** Loads one build's sw.js (as the build writes it) into a fresh worker global. */
  /** `built`: run that built sw.js as-is instead of injecting the list of `files` into public/sw.js. */
  const worker = (files: Record<string, string>, built?: string) => {
    const src = built ?? injectPrecache(sw, precacheList(Object.keys(files).map((f) => f.slice(1))), files['/index.html']);
    const on: Record<string, (e: unknown) => void> = {};
    const self = {
      location: { origin: ORIGIN },
      addEventListener: (t: string, f: (e: unknown) => void) => (on[t] = f),
      skipWaiting: vi.fn(async () => undefined),
      clients: { matchAll: vi.fn(async () => open.map((id) => ({ id }))), claim: vi.fn(async () => undefined) },
    };
    vm.runInContext(src, vm.createContext({ self, caches, fetch: net, Request: FakeRequest, Response, URL, console }));
    const ext = async (type: string, extra: object = {}) => {
      const waits: Promise<unknown>[] = [];
      let res: Promise<Response> | undefined;
      on[type]!({ ...extra, waitUntil: (p: Promise<unknown>) => waits.push(p), respondWith: (p: Promise<Response>) => (res = p) });
      const out = res ? await res : undefined;
      await Promise.all(waits);
      return out;
    };
    return {
      self,
      install: () => ext('install'),
      activate: () => ext('activate'),
      message: (data: unknown) => ext('message', { data }),
      get: async (path: string, mode = 'no-cors') => {
        const r = await ext('fetch', { request: { url: `${ORIGIN}${path}`, method: 'GET', mode } satisfies Req });
        return r && r.ok ? r.text() : `HTTP ${r?.status}`;
      },
    };
  };
  return {
    worker,
    caches,
    deploy: (files: Record<string, string>) => (site = files),
    setOpen: (ids: string[]) => (open = ids),
  };
}

/** A shell like Vite's: it references the build's hashed main chunk and stylesheet. */
const shell = (b: string) =>
  `<html><link rel="icon" href="./icon.svg"><script type="module" crossorigin src="./assets/index-${b}.js"></script><link rel="stylesheet" crossorigin href="./assets/index-${b}.css"></html>`;
const buildA = {
  '/index.html': shell('A'),
  '/assets/index-A.js': 'main A',
  '/assets/index-A.css': 'css A',
  '/assets/planner.worker-A.js': 'planner A',
  '/icon.svg': 'icon',
  '/samples/snap-table.png': 'photo',
};
const buildB = {
  '/index.html': shell('B'),
  '/assets/index-B.js': 'main B',
  '/assets/index-B.css': 'css B',
  '/assets/planner.worker-B.js': 'planner B',
  '/icon.svg': 'icon',
  '/samples/snap-table.png': 'photo',
};

describe('public/sw.js across a deploy', () => {
  it('installs a new build next to the running one without taking over the open page', async () => {
    const w = world();
    w.deploy(buildA);
    const a = w.worker(buildA);
    await a.install();
    await a.activate();
    w.setOpen(['page-1']);
    w.deploy(buildB);
    const b = w.worker(buildB);
    await b.install();
    expect(b.self.skipWaiting).not.toHaveBeenCalled();
    expect(await w.caches.keys()).toHaveLength(2);
    // The open page is still served by A's worker: its lazily created worker and the photos load.
    expect(await a.get('/assets/planner.worker-A.js')).toBe('planner A');
    expect(await a.get('/samples/snap-table.png')).toBe('photo');
    // "Reload" on the update prompt.
    await b.message({ type: 'skip-waiting' });
    expect(b.self.skipWaiting).toHaveBeenCalledTimes(1);
  });

  it('precaches the whole build, Snap sample photos included, and fails the install if a file is missing', async () => {
    const w = world();
    w.deploy(buildA);
    const a = w.worker(buildA);
    await a.install();
    const cache = await w.caches.open((await w.caches.keys())[0]!);
    expect([...cache.m.keys()].sort()).toEqual([`${ORIGIN}/`, ...Object.keys(buildA).map((p) => `${ORIGIN}${p}`)].sort());
    // A deploy whose files are not all on the server yet must not install.
    const w2 = world();
    w2.deploy({ '/index.html': buildA['/index.html'] });
    await expect(w2.worker(buildA).install()).rejects.toThrow();
    expect(await w2.caches.keys(), 'no half-filled cache is left').toEqual([]);
  });

  it('after taking over, keeps serving the older build to pages still open on it, then drops it once they are gone', async () => {
    const w = world();
    w.deploy(buildA);
    const a = w.worker(buildA);
    await a.install();
    await a.activate();
    w.setOpen(['page-1', 'page-2']);
    w.deploy(buildB);
    let b = w.worker(buildB);
    await b.install();
    await b.message({ type: 'skip-waiting' });
    await b.activate();
    expect(b.self.clients.claim).toHaveBeenCalled();
    expect(await w.caches.keys()).toHaveLength(2);

    // page-1 still runs A and now creates its planner worker: A's file is gone from the server.
    expect(await b.get('/assets/planner.worker-A.js')).toBe('planner A');
    // Navigations get B's shell, never A's (also kept in the cache storage).
    expect(await b.get('/?mode=practice', 'navigate')).toBe(buildB['/index.html']);
    expect(await b.get('/index.html', 'navigate')).toBe(buildB['/index.html']);
    expect(await b.get('/assets/planner.worker-B.js')).toBe('planner B');

    // page-2 reloads into B (a new client); page-1 is still open, so A stays. The worker may be
    // restarted in between: what it must keep is in the cache storage, not in memory.
    w.setOpen(['page-1', 'page-3']);
    b = w.worker(buildB);
    await b.get('/assets/index-B.js');
    expect(await w.caches.keys()).toHaveLength(2);
    expect(await b.get('/assets/planner.worker-A.js')).toBe('planner A');

    // page-1 is closed: the next request drops A's cache.
    w.setOpen(['page-3']);
    await b.get('/assets/index-B.js');
    expect(await w.caches.keys()).toEqual([`cuesight-v2-${buildId(precacheList(Object.keys(buildB).map((f) => f.slice(1))), buildB['/index.html'])}`]);
    expect(await b.get('/assets/planner.worker-A.js')).toBe('HTTP 404');
    expect(await b.get('/samples/snap-table.png')).toBe('photo');
  });

  it('never drops the cache of a newer build that is installing meanwhile', async () => {
    const w = world();
    w.deploy(buildA);
    const a = w.worker(buildA);
    await a.install();
    await a.activate();
    w.setOpen(['page-1']);
    w.deploy(buildB);
    const b = w.worker(buildB);
    await b.install();
    await b.message({ type: 'skip-waiting' });
    await b.activate();
    const buildC = { '/index.html': '<html>C</html>', '/assets/index-C.js': 'main C', '/samples/snap-table.png': 'photo' };
    w.deploy(buildC);
    const c = w.worker(buildC);
    await c.install();
    w.setOpen([]);
    await b.get('/assets/index-B.js'); // prunes A
    const keys = await w.caches.keys();
    expect(keys).toHaveLength(2);
    expect(await (await w.caches.open(keys[1]!)).match('./assets/index-C.js')).toBeDefined();
    await c.activate();
    expect(await c.get('/', 'navigate')).toBe('<html>C</html>');
    expect(await w.caches.keys()).toEqual([keys[1]]);
  });

  it('activating with no page open (every tab closed, then relaunched) drops the older build at once', async () => {
    const w = world();
    w.deploy(buildA);
    const a = w.worker(buildA);
    await a.install();
    await a.activate();
    w.deploy(buildB);
    const b = w.worker(buildB);
    await b.install();
    w.setOpen([]);
    await b.activate();
    expect(await w.caches.keys()).toHaveLength(1);
    expect(await b.get('/', 'navigate')).toBe(buildB['/index.html']);
  });
});

describe('public/sw.js on a host that sends Cache-Control: max-age (GitHub Pages: 600 s)', () => {
  /** Build A installed and serving an open page (page-1); then `next` is deployed (`served` is what the host sends). */
  async function deployOver(next: Record<string, string>, served: Record<string, string> = next) {
    const w = world({ maxAge: true });
    w.deploy(buildA);
    const a = w.worker(buildA);
    await a.install();
    await a.activate();
    w.setOpen(['page-1']);
    w.deploy(served);
    return { w, a, b: w.worker(next) };
  }
  const cacheText = async (w: ReturnType<typeof world>, name: string, url: string) => {
    const hit = await (await w.caches.open(name)).match(url);
    return hit ? hit.text() : undefined;
  };

  it("precaches the new build's own shell and public files, not the HTTP cache's copies from the previous build", async () => {
    // B also replaces a sample photo under the same (unhashed) name.
    const next = { ...buildB, '/samples/snap-table.png': 'photo v2' };
    const { w, b } = await deployOver(next);
    await b.install();
    const [, cacheB] = await w.caches.keys();
    expect(await cacheText(w, cacheB!, './index.html')).toBe(buildB['/index.html']);
    expect(await cacheText(w, cacheB!, './')).toBe(buildB['/index.html']);
    expect(await cacheText(w, cacheB!, './samples/snap-table.png')).toBe('photo v2');
    // "Reload": the reloaded page (a new client) gets B's shell, so it runs B and its files come from B's cache.
    await b.message({ type: 'skip-waiting' });
    w.setOpen(['page-2']);
    await b.activate();
    expect(await b.get('/?mode=practice', 'navigate')).toBe(buildB['/index.html']);
    expect(await b.get('/assets/planner.worker-B.js')).toBe('planner B');
  });

  it("refuses to install while the server still sends the previous build's index.html (a CDN edge mid-deploy)", async () => {
    // B's sw.js and files are live, but index.html is still A's: it references A's chunks, which are not B's.
    const { w, a, b } = await deployOver(buildB, { ...buildB, '/index.html': buildA['/index.html'] });
    await expect(b.install()).rejects.toThrow(/index\.html/);
    // No half-made cache is left behind, and the open page keeps running A.
    expect(await w.caches.keys()).toHaveLength(1);
    expect(await a.get('/assets/planner.worker-A.js')).toBe('planner A');
    // Once the edge serves B's index.html, the browser's next update check installs B.
    w.deploy(buildB);
    await b.install();
    const [, cacheB] = await w.caches.keys();
    expect(await cacheText(w, cacheB!, './index.html')).toBe(buildB['/index.html']);
  });

  it("a refused install never touches the running build's cache (a sw.js-only deploy keeps the cache name)", async () => {
    // BUILD_ID hashes the file list and index.html, not sw.js: a deploy that only changes sw.js installs into the
    // running build's cache. If the edge then sends an older shell, that cache must keep A's own shell and files.
    const older = { ...buildA, '/index.html': shell('Z') };
    const { w, a, b } = await deployOver(buildA, older);
    await expect(b.install()).rejects.toThrow(/index\.html/);
    const [cacheA] = await w.caches.keys();
    expect(await w.caches.keys()).toHaveLength(1);
    expect(await cacheText(w, cacheA!, './index.html')).toBe(buildA['/index.html']);
    expect(await cacheText(w, cacheA!, './')).toBe(buildA['/index.html']);
    expect(await a.get('/?mode=practice', 'navigate')).toBe(buildA['/index.html']);
    expect(await a.get('/assets/planner.worker-A.js')).toBe('planner A');
  });

  it('accepts a shell the host added its own markup to (only references to built files are checked)', async () => {
    const injected = buildB['/index.html'].replace('</html>', '<script src="/__host/insights.js"></script><a href="./help/">help</a></html>');
    const { w, b } = await deployOver(buildB, { ...buildB, '/index.html': injected });
    await b.install();
    expect(await w.caches.keys()).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------------------------
// Build-level guard: the real production build.
// ---------------------------------------------------------------------------------------------
function walk(dir: string, base = dir): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p, base) : [relative(base, p).split(sep).join('/')];
  });
}

describe('the production build (dist/sw.js)', () => {
  let tmp = '';
  let out = '';
  let files: string[] = [];
  let built = '';
  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'cuesight-sw-'));
    out = join(tmp, 'dist');
    await build({ root, configFile: join(root, 'vite.config.ts'), logLevel: 'silent', build: { outDir: out, emptyOutDir: true } });
    files = walk(out);
    built = readFileSync(join(out, 'sw.js'), 'utf8');
  }, 60_000);
  afterAll(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it('has its placeholders replaced', () => {
    expect(built).not.toContain(ASSETS_PLACEHOLDER);
    expect(built).not.toContain(ID_PLACEHOLDER);
    expect(verifyPrecache(built, files)).toEqual([]);
  });

  it('lists every emitted file: the JS and CSS chunks, both workers, icons, manifest and the Snap sample photos', () => {
    const listed = listedAssets(built);
    expect(listed).toEqual(
      files
        .filter((f) => f !== 'sw.js' && f !== 'index.html' && !f.endsWith('.map'))
        .map((f) => `./${f}`)
        .sort(),
    );
    expect(listed.filter((f) => /^\.\/assets\/index-[\w-]+\.js$/.test(f))).toHaveLength(1);
    expect(listed.filter((f) => /^\.\/assets\/[\w-]+\.css$/.test(f)).length).toBeGreaterThanOrEqual(1);
    expect(listed.filter((f) => /^\.\/assets\/(planner|vision)\.worker-[\w-]+\.js$/.test(f))).toHaveLength(2);
    expect(listed).toEqual(expect.arrayContaining(['./samples/snap-table.png', './samples/snap-player.png', './manifest.webmanifest', './icons/icon-192.png']));
  });

  it("derives BUILD_ID from that list, the built index.html and every listed file's bytes (any change is a new version)", () => {
    const listed = listedAssets(built);
    expect(built).toContain(`const BUILD_ID = '${buildId(listed, readFileSync(join(out, 'index.html'), 'utf8'), contentDigest(out, listed))}';`);
  });

  it('gives a new BUILD_ID when only the content of a public file changes, so the update reaches installed apps', async () => {
    // A new sample photo (or manifest, icon) under the same name: the browser only installs a new worker when
    // dist/sw.js changes, and the old worker serves its precached copy cache-first.
    const pub = join(tmp, 'public-edited');
    cpSync(join(root, 'public'), pub, { recursive: true });
    const photo = join(pub, 'samples', 'snap-table.png');
    writeFileSync(photo, Buffer.concat([readFileSync(photo), Buffer.from([0])]));
    await build({ root, configFile: join(root, 'vite.config.ts'), logLevel: 'silent', publicDir: pub, build: { outDir: join(tmp, 'dist-edited'), emptyOutDir: true } });
    const edited = readFileSync(join(tmp, 'dist-edited', 'sw.js'), 'utf8');
    const id = (s: string) => /const BUILD_ID = '(\w+)';/.exec(s)?.[1];
    expect(listedAssets(edited)).toEqual(listedAssets(built));
    expect(readFileSync(join(tmp, 'dist-edited', 'index.html'), 'utf8')).toBe(readFileSync(join(out, 'index.html'), 'utf8'));
    expect(id(edited)).toMatch(/^[0-9a-f]{10}$/);
    expect(id(edited)).not.toBe(id(built));
  }, 60_000);

  it("installs from the built files: the built index.html passes the worker's check that the shell is this build's", async () => {
    const w = world({ maxAge: true });
    const site = Object.fromEntries(files.map((f) => [`/${f}`, readFileSync(join(out, f), 'latin1')]));
    w.deploy(site);
    const worker = w.worker(site, built);
    await worker.install();
    expect(await w.caches.keys()).toHaveLength(1);
    expect(await worker.get('/?mode=practice', 'navigate')).toBe(site['/index.html']);
    const main = listedAssets(built).find((f) => /^\.\/assets\/index-[\w-]+\.js$/.test(f))!;
    expect(site['/index.html']).toContain(`src="${main}"`);
    expect(await worker.get(main.slice(1))).toBe(site[main.slice(1)]);
  });

  it('ships no source maps (dist is copied as-is into the iOS app)', () => {
    expect(files.filter((f) => f.endsWith('.map'))).toEqual([]);
    for (const f of files.filter((x) => x.endsWith('.js'))) expect(readFileSync(join(out, f), 'utf8'), f).not.toContain('sourceMappingURL');
  });

  it('fails when the public dir has no sw.js (the app would silently lose offline support)', async () => {
    const pub = join(tmp, 'public-without-sw');
    mkdirSync(pub, { recursive: true });
    writeFileSync(join(pub, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    await expect(
      build({ root, configFile: join(root, 'vite.config.ts'), logLevel: 'silent', publicDir: pub, build: { outDir: join(tmp, 'dist-no-sw'), emptyOutDir: true } }),
    ).rejects.toThrow(/sw\.js/);
  }, 60_000);
});
