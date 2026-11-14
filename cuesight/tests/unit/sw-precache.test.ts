/**
 * Offline after the first load (Constitution V): the service worker must precache every built file,
 * and its cache lookups must not depend on request headers the precache fetch did not send. A deploy
 * must not break a page that is already open (it loads its workers and photos lazily, from its own
 * build). The behaviour itself is covered end to end by tests/e2e/offline.spec.ts and update.spec.ts.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import vm from 'node:vm';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ASSETS_PLACEHOLDER, buildId, ID_PLACEHOLDER, injectPrecache, listedAssets, precacheList, verifyPrecache } from '../../scripts/sw-precache';

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
    // One addAll: either the whole build is cached or the install fails (no half-filled cache).
    expect(sw).toContain('c.addAll([...SHELL, ...BUILD_ASSETS])');
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
type Req = { url: string; method: string; mode: string };
const keyOf = (r: Req | string, ignoreSearch = false) => {
  const u = new URL(typeof r === 'string' ? r : r.url, `${ORIGIN}/`);
  return ignoreSearch ? `${u.origin}${u.pathname}` : u.href;
};
const basic = (r: Response) => Object.defineProperty(r, 'type', { value: 'basic' });

class FakeCache {
  readonly m = new Map<string, Response>();
  constructor(private readonly net: (u: string) => Promise<Response>) {}
  async addAll(urls: string[]): Promise<void> {
    const got = await Promise.all(urls.map(async (u) => [keyOf(u), await this.net(keyOf(u))] as const));
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

function world() {
  let site: Record<string, string> = {};
  const net = async (u: string): Promise<Response> => {
    const path = new URL(u).pathname;
    const body = site[path === '/' ? '/index.html' : path];
    return basic(body === undefined ? new Response('not found', { status: 404 }) : new Response(body, { status: 200 }));
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
  const worker = (files: Record<string, string>) => {
    const src = injectPrecache(sw, precacheList(Object.keys(files).map((f) => f.slice(1))), files['/index.html']);
    const on: Record<string, (e: unknown) => void> = {};
    const self = {
      location: { origin: ORIGIN },
      addEventListener: (t: string, f: (e: unknown) => void) => (on[t] = f),
      skipWaiting: vi.fn(async () => undefined),
      clients: { matchAll: vi.fn(async () => open.map((id) => ({ id }))), claim: vi.fn(async () => undefined) },
    };
    vm.runInContext(src, vm.createContext({ self, caches, fetch: (r: Req | string) => net(keyOf(r)), Response, URL, console }));
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

const buildA = { '/index.html': '<html>A</html>', '/assets/index-A.js': 'main A', '/assets/planner.worker-A.js': 'planner A', '/samples/snap-table.png': 'photo' };
const buildB = { '/index.html': '<html>B</html>', '/assets/index-B.js': 'main B', '/assets/planner.worker-B.js': 'planner B', '/samples/snap-table.png': 'photo' };

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
    w2.deploy({ '/index.html': '<html>A</html>' });
    await expect(w2.worker(buildA).install()).rejects.toThrow();
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
    expect(await b.get('/?mode=practice', 'navigate')).toBe('<html>B</html>');
    expect(await b.get('/index.html', 'navigate')).toBe('<html>B</html>');
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
    expect(await b.get('/', 'navigate')).toBe('<html>B</html>');
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

  it('derives BUILD_ID from that list and the built index.html (any change to either is a new version)', () => {
    expect(built).toContain(`const BUILD_ID = '${buildId(listedAssets(built), readFileSync(join(out, 'index.html'), 'utf8'))}';`);
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
