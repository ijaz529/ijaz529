/**
 * Offline after the first load (Constitution V): the service worker must precache every built file,
 * and its cache lookups must not depend on request headers the precache fetch did not send.
 * The behaviour itself is covered end to end by tests/e2e/offline.spec.ts.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ASSETS_PLACEHOLDER, buildId, ID_PLACEHOLDER, injectPrecache, precacheList } from '../../scripts/sw-precache';

const sw = readFileSync('public/sw.js', 'utf8');

describe('service worker precache manifest', () => {
  it('lists every built file except source maps, the HTML shell and the worker itself, sorted and relative', () => {
    const list = precacheList(['assets/index-b.js', 'assets/index-b.js.map', 'index.html', 'assets/a.css', 'assets/vision.worker-x.js', 'sw.js', 'assets/a.css']);
    expect(list).toEqual(['./assets/a.css', './assets/index-b.js', './assets/vision.worker-x.js']);
  });

  it('injects the list and a build id that changes with the file names', () => {
    const a = ['./assets/index-1.js'];
    const b = ['./assets/index-2.js'];
    const out = injectPrecache(sw, a);
    expect(out).toContain('const BUILD_ASSETS = ["./assets/index-1.js"];');
    expect(out).toContain(`const BUILD_ID = '${buildId(a)}';`);
    expect(out).not.toContain(ASSETS_PLACEHOLDER);
    expect(buildId(a)).not.toBe(buildId(b));
    expect(buildId(a)).toMatch(/^[0-9a-f]{10}$/);
    // An edit to index.html alone (same asset names) still gives a new build id, so the shell updates.
    expect(buildId(a, '<html>1</html>')).not.toBe(buildId(a, '<html>2</html>'));
    expect(injectPrecache(sw, a, '<html>x</html>')).toContain(`const BUILD_ID = '${buildId(a, '<html>x</html>')}';`);
  });

  it('refuses a service worker without the placeholders (the build would silently lose offline support)', () => {
    expect(() => injectPrecache('self.addEventListener("fetch", () => {});', [])).toThrow(/BUILD_ASSETS/);
  });

  it('public/sw.js has each placeholder exactly once, precaches them on install and keys the cache by build', () => {
    expect(sw.split(ASSETS_PLACEHOLDER)).toHaveLength(2);
    expect(sw.split(ID_PLACEHOLDER)).toHaveLength(2);
    expect(sw).toContain('c.addAll(BUILD_ASSETS)');
    expect(sw).toMatch(/const CACHE = `cuesight-v\d+-\$\{BUILD_ID\}`/);
  });

  it('cache lookups ignore Vary (precache fetches carry no Origin header; module scripts do)', () => {
    const matches = sw.match(/caches\s*\.match\([^)]*\)/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
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
