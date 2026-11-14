import { fileURLToPath } from 'node:url';
import { expect, test, type Page, type Request } from '@playwright/test';

/**
 * Constitution V (privacy by architecture): everything runs on the device, nothing is sent to any
 * network endpoint, and the app works offline after the first load (service worker, production
 * build). Practice (3D table + planner worker) and Snap (vision worker on a local photo) are both
 * exercised with the network switched off.
 */
const dir = fileURLToPath(new URL('../fixtures/', import.meta.url));
type V2 = { x: number; y: number };
type Hook = {
  state: { practice: { balls: { id: string; pos: V2 }[] }; table: { pockets: { id: string; mouthCenter: V2 }[] }; snap: { step: string; layout: unknown[] | null } };
  practiceToScreen(p: V2): V2;
};

async function tapB1TR(page: Page) {
  const t = await page.evaluate(() => {
    const h = (window as unknown as { __cuesight: Hook }).__cuesight;
    return {
      b: h.practiceToScreen(h.state.practice.balls.find((b) => b.id === 'b1')!.pos),
      p: h.practiceToScreen(h.state.table.pockets.find((q) => q.id === 'TR')!.mouthCenter),
    };
  });
  await page.mouse.click(t.b.x, t.b.y);
  await page.mouse.click(t.p.x, t.p.y);
}

// @chromium-only: Playwright's offline emulation of service-worker traffic is only verified in Chromium
// here; the iOS app itself (Capacitor) bundles its assets and does not use the service worker.
test('works offline after the first load, with zero external requests @offline @chromium-only', async ({ page, context, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const external: string[] = [];
  const failedOffline: string[] = [];
  let offline = false;
  const isLocal = (u: string) => u.startsWith(origin) || u.startsWith('data:') || u.startsWith('blob:');
  const onRequest = (r: Request) => {
    if (!isLocal(r.url())) external.push(r.url());
  };
  context.on('request', onRequest);
  context.on('requestfailed', (r) => {
    // While offline the service worker's own background refresh of the page is expected to fail.
    if (offline && !r.serviceWorker()) failedOffline.push(`${r.url()} ${r.failure()?.errorText}`);
  });

  // First (online) visit: Practice with a plan, so the planner worker is loaded too.
  await page.goto('/?mode=practice');
  await expect(page.locator('#shot-card')).toContainText('Tap the ball you want to pocket');
  // The service worker installs (precaching the whole build) and activates.
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          if (!('serviceWorker' in navigator)) return 'unsupported';
          const reg = await navigator.serviceWorker.ready;
          return reg.active ? reg.active.state : 'none';
        }),
      { timeout: 20_000 },
    )
    .toBe('activated');
  await tapB1TR(page);
  await expect(page.getByTestId('cut')).toHaveText('30.0°');

  // Offline: reload and use the app.
  offline = true;
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('#shot-card')).toContainText('Tap the ball you want to pocket');
  expect(await page.evaluate(() => navigator.onLine)).toBe(false);
  await tapB1TR(page);
  await expect(page.getByTestId('cut')).toHaveText('30.0°');
  await expect(page.getByTestId('shot-card')).toContainText('recommended for position', { timeout: 20_000 });

  // Snap offline: the vision worker reads a local photo.
  await page.locator('.mode-switch [data-mode="snap"]').click();
  await page.setInputFiles('#snap-file-table', `${dir}snap-overview.png`);
  await page.waitForFunction(() => ['review', 'overview-error'].includes((window as unknown as { __cuesight: Hook }).__cuesight.state.snap.step), null, { timeout: 45_000 });
  expect(await page.evaluate(() => (window as unknown as { __cuesight: Hook }).__cuesight.state.snap.step)).toBe('review');

  // A cold start offline in a new tab of the same profile works too.
  const page2 = await context.newPage();
  await page2.goto('/?mode=practice');
  await expect(page2.locator('#shot-card')).toContainText('Tap the ball you want to pocket');
  await page2.close();

  await context.setOffline(false);
  expect(failedOffline, 'requests that failed while offline').toEqual([]);
  expect(external, 'requests to any other origin').toEqual([]);
});
