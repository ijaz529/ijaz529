import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { build, type Plugin } from 'vite';

/**
 * A deploy must not break a page that is already open (Constitution V: offline after the first load).
 * The page creates its planner and vision workers lazily and fetches the Snap sample photos on demand,
 * all from the build it was loaded with, so the new service worker must neither take the page over on its
 * own nor drop the previous build's cache while a page still uses it. The update is offered in the app
 * ("Reload") instead.
 *
 * Builds A and B are made here (same sources; B's main and worker chunks carry a marker, so every hashed
 * file name differs) and served by a tiny static server whose directory is swapped to "deploy" B on the
 * same origin, as a static host would: A's hashed files are gone from the server after the deploy.
 */
const root = fileURLToPath(new URL('../../', import.meta.url));
type V2 = { x: number; y: number };
type Hook = {
  state: { practice: { balls: { id: string; pos: V2 }[] }; table: { pockets: { id: string; mouthCenter: V2 }[] }; snap: { step: string } };
  practiceToScreen(p: V2): V2;
};
type Win = Window & { __cuesight: Hook; __cuesightBuild?: string; __ctlChanged?: boolean };

/** Marks the main and worker entry chunks with the build's name (and so changes their hashes). */
function tagBuild(tag: string): Plugin {
  return {
    name: 'test-tag-build',
    transform(code, id) {
      if (!/src\/(app\/main|workers\/\w+\.worker)\.ts$/.test(id)) return null;
      return { code: `${code}\n;globalThis.__cuesightBuild = ${JSON.stringify(tag)};\n`, map: null };
    },
  };
}

async function buildTo(outDir: string, tag: string): Promise<void> {
  await build({
    root,
    configFile: join(root, 'vite.config.ts'),
    logLevel: 'silent',
    build: { outDir, emptyOutDir: true },
    plugins: [tagBuild(tag)],
    worker: { plugins: () => [tagBuild(tag)] },
  });
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

/** Serves whatever directory `site.dir` names, like a static host; everything else is a 404. */
async function serve(site: { dir: string }): Promise<{ server: Server; origin: string; notFound: string[] }> {
  const notFound: string[] = [];
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    const file = normalize(join(site.dir, path.endsWith('/') ? `${path}index.html` : path));
    if (!file.startsWith(site.dir + sep) || !existsSync(file) || !statSync(file).isFile()) {
      notFound.push(path);
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(readFileSync(file));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, notFound };
}

let tmp = '';
let dirA = '';
let dirB = '';
test.beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'cuesight-update-'));
  dirA = join(tmp, 'a');
  dirB = join(tmp, 'b');
  await buildTo(dirA, 'A');
  await buildTo(dirB, 'B');
  const workers = (d: string) => readFileSync(join(d, 'sw.js'), 'utf8').match(/assets\/\w+\.worker-[\w-]+\.js/g)?.sort();
  expect(workers(dirA)).toHaveLength(2);
  // The deploy really changes the worker file names, so A's are gone from the server afterwards.
  for (const w of workers(dirA)!) expect(workers(dirB)).not.toContain(w);
});
test.afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

const buildOf = (page: Page) => page.evaluate(() => (window as unknown as Win).__cuesightBuild);

async function openControlled(page: Page, origin: string): Promise<void> {
  await page.goto(`${origin}/?mode=practice`);
  await expect(page.locator('#shot-card')).toContainText('Tap the ball you want to pocket');
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 30_000 });
  await page.evaluate(() => navigator.serviceWorker.addEventListener('controllerchange', () => ((window as unknown as Win).__ctlChanged = true)));
}

/** The browser's update check (it runs on navigations and periodically); resolves once the new worker is installed. */
async function checkForUpdate(page: Page): Promise<void> {
  const found = await page.evaluate(async () => {
    const reg = (await navigator.serviceWorker.getRegistration())!;
    await reg.update();
    return !!(reg.installing || reg.waiting);
  });
  expect(found, 'the deploy is seen as a new service worker').toBe(true);
  await waitInstalled(page);
}

async function waitInstalled(page: Page): Promise<void> {
  await page.waitForFunction(
    async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg || reg.installing) return false;
      return !!reg.waiting || ((window as unknown as Win).__ctlChanged === true && reg.active?.state === 'activated');
    },
    null,
    { timeout: 30_000, polling: 200 },
  );
  // Give a worker that would take over on its own (skipWaiting) the time to do so.
  await page.waitForTimeout(500);
}

/** Ball 1 into the top-right pocket: the recommendation comes from the planner worker. */
async function recommend(page: Page): Promise<void> {
  const t = await page.evaluate(() => {
    const h = (window as unknown as Win).__cuesight;
    return {
      b: h.practiceToScreen(h.state.practice.balls.find((b) => b.id === 'b1')!.pos),
      p: h.practiceToScreen(h.state.table.pockets.find((q) => q.id === 'TR')!.mouthCenter),
    };
  });
  await page.mouse.click(t.b.x, t.b.y);
  await page.mouse.click(t.p.x, t.p.y);
  await expect(page.getByTestId('cut')).toHaveText('30.0°');
  await expect(page.getByTestId('shot-card')).toContainText('recommended for position', { timeout: 20_000 });
}

/** Snap with the bundled sample table photo: the layout comes from the vision worker. */
async function snapSample(page: Page): Promise<void> {
  await page.locator('.mode-switch [data-mode="snap"]').click();
  await page.getByRole('button', { name: 'Try it with sample photos' }).click();
  await page.waitForFunction(() => ['review', 'overview-error'].includes((window as unknown as Win).__cuesight.state.snap.step), null, { timeout: 45_000 });
  expect(await page.evaluate(() => (window as unknown as Win).__cuesight.state.snap.step)).toBe('review');
}

const cacheNames = (page: Page) => page.evaluate(async () => (await caches.keys()).filter((k) => k.startsWith('cuesight-')));

// @chromium-only: like offline.spec, the service-worker lifecycle is exercised in Chromium here; the iOS
// app (Capacitor) bundles its assets and registers no service worker.
test.describe('a deploy while the app is open @offline @chromium-only', () => {
  test.setTimeout(180_000);

  test('the open page keeps planning and reading photos after the deploy, then updates when asked', async ({ page, context }) => {
    const site = { dir: dirA };
    const { server, origin, notFound } = await serve(site);
    try {
      const workerRequests: string[] = [];
      page.on('request', (r) => {
        if (/\.worker-/.test(r.url())) workerRequests.push(r.url());
      });
      await openControlled(page, origin);
      expect(await buildOf(page)).toBe('A');
      expect(workerRequests, 'no worker was created before the deploy (both are created lazily)').toEqual([]);

      site.dir = dirB; // deploy B on the same origin
      await checkForUpdate(page);

      // The page opened on A still works: its workers and the sample photo load (from A's precache).
      await recommend(page);
      await snapSample(page);
      expect(notFound, 'files of the open build that were requested after the deploy').toEqual([]);
      expect(await buildOf(page)).toBe('A');

      // The update is offered, not forced; Reload switches to B.
      const reload = page.getByRole('button', { name: 'Reload' });
      await expect(reload).toBeVisible();
      await expect(page.locator('.update-toast')).toContainText('new version');
      await Promise.all([page.waitForEvent('load'), reload.click()]);
      await expect.poll(() => buildOf(page), { timeout: 15_000 }).toBe('B');
      // The reload keeps the mode the player was in (Snap); back to Practice.
      await page.locator('.mode-switch [data-mode="practice"]').click();
      await expect(page.locator('#shot-card')).toContainText('Tap the ball you want to pocket');
      await recommend(page);
      await snapSample(page);
      // A's cache goes once no page uses it.
      await expect.poll(() => cacheNames(page), { timeout: 15_000 }).toHaveLength(1);

      // B works offline, including the sample photos (precached with the build).
      await context.setOffline(true);
      await page.goto(`${origin}/?mode=practice`);
      expect(await buildOf(page)).toBe('B');
      await recommend(page);
      await snapSample(page);
      await context.setOffline(false);
      expect(notFound).toEqual([]);
    } finally {
      await context.setOffline(false);
      server.close();
    }
  });

  test('accepting the update in one tab keeps another tab on the old build working', async ({ page, context }) => {
    const site = { dir: dirA };
    const { server, origin, notFound } = await serve(site);
    try {
      await openControlled(page, origin);
      expect(await buildOf(page)).toBe('A');

      site.dir = dirB;
      // A second tab: its navigation makes the browser find B, which waits while A's tabs are open.
      const tab2 = await context.newPage();
      await tab2.goto(`${origin}/?mode=practice`);
      await expect(tab2.locator('#shot-card')).toContainText('Tap the ball you want to pocket');
      expect(await buildOf(tab2)).toBe('A');
      await tab2.evaluate(() => navigator.serviceWorker.addEventListener('controllerchange', () => ((window as unknown as Win).__ctlChanged = true)));
      await waitInstalled(tab2);
      const reload2 = tab2.getByRole('button', { name: 'Reload' });
      await expect(reload2).toBeVisible();
      await Promise.all([tab2.waitForEvent('load'), reload2.click()]);
      await expect.poll(() => buildOf(tab2), { timeout: 15_000 }).toBe('B');

      // The first tab is now controlled by B's worker but still runs A: A's files must still be served.
      await page.waitForFunction(() => (window as unknown as Win).__ctlChanged === true, null, { timeout: 15_000 });
      expect(await buildOf(page)).toBe('A');
      await recommend(page);
      await snapSample(page);
      expect(notFound, 'files of the open build that were requested after the deploy').toEqual([]);
      // ...and it is told that a new version is ready.
      await expect(page.getByRole('button', { name: 'Reload' })).toBeVisible();

      // Once the old tab is gone, A's cache is dropped.
      await page.close();
      await tab2.reload();
      await recommend(tab2);
      await expect.poll(() => cacheNames(tab2), { timeout: 15_000 }).toHaveLength(1);
    } finally {
      server.close();
    }
  });
});
