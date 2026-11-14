import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { regionStats, tableBox } from './pixels';

/**
 * Feature 002 FR-110: without WebGL2 the app falls back to the 2D TableView automatically, and
 * Practice and Snap keep working. WebGL2 is made unavailable the way an old browser or a blocklisted
 * GPU presents it: getContext('webgl2') returns null.
 */
const dir = fileURLToPath(new URL('../fixtures/', import.meta.url));
type V2 = { x: number; y: number };
type Hook = {
  state: {
    practice: { balls: { id: string; pos: V2 }[] };
    snap: { step: string; layout: { id: string; pos: V2 }[] | null };
    table: { pockets: { id: string; mouthCenter: V2 }[] };
  };
  practiceToScreen(p: V2): V2;
  view3d: unknown;
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const proto = HTMLCanvasElement.prototype as unknown as { getContext(type: string, ...rest: unknown[]): unknown };
    const orig = proto.getContext;
    proto.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
      return type === 'webgl2' ? null : orig.call(this, type, ...rest);
    };
  });
});

async function tap(page: Page, p: V2) {
  const q = await page.evaluate((pp) => (window as unknown as { __cuesight: Hook }).__cuesight.practiceToScreen(pp), p);
  await page.mouse.click(q.x, q.y);
}
const pocket = (page: Page, id: string) =>
  page.evaluate((k) => (window as unknown as { __cuesight: Hook }).__cuesight.state.table.pockets.find((q) => q.id === k)!.mouthCenter, id);

test.describe('no WebGL2 → 2D table (feature 002 FR-110)', () => {
  test('Practice: says why, draws the 2D table, and plans from taps', async ({ page }) => {
    const logs: string[] = [];
    page.on('console', (m) => logs.push(m.text()));
    await page.goto('/?mode=practice');
    await expect(page.locator('#shot-card')).toContainText('Tap the ball you want to pocket');
    expect(await page.evaluate(() => (window as unknown as { __cuesight: Hook }).__cuesight.view3d)).toBeNull();
    await expect(page.locator('body')).not.toHaveClass(/has-3d/);
    await expect(page.locator('#toast')).toContainText('WebGL2');
    await expect.poll(() => logs.some((l) => l.includes('[CueSight] ready') && l.includes('renderer=2d'))).toBe(true);
    // The 3D controls are gone; the 2D canvas is showing and is not blank.
    await expect(page.getByRole('button', { name: 'Play shot' })).toBeHidden();
    await expect(page.locator('#table')).toBeVisible();
    const px = await regionStats(page, await tableBox(page));
    expect(px.greenFrac).toBeGreaterThan(0.25);
    expect(px.std).toBeGreaterThan(8);
    // Same plan as on the 3D table.
    const b1 = await page.evaluate(() => (window as unknown as { __cuesight: Hook }).__cuesight.state.practice.balls.find((b) => b.id === 'b1')!.pos);
    await tap(page, b1);
    await tap(page, await pocket(page, 'TR'));
    await expect(page.getByTestId('cut')).toHaveText('30.0°');
    await expect(page.getByTestId('power')).toContainText('/10');
  });

  test('Snap: the layout step uses the 2D table and the guide still works', async ({ page }) => {
    await page.goto('/?mode=snap');
    await page.setInputFiles('#snap-file-table', `${dir}snap-overview.png`);
    await page.waitForFunction(() => ['review', 'overview-error'].includes((window as unknown as { __cuesight: Hook }).__cuesight.state.snap.step), null, { timeout: 45_000 });
    expect(await page.evaluate(() => (window as unknown as { __cuesight: Hook }).__cuesight.state.snap.step)).toBe('review');
    await expect(page.locator('#table')).toBeVisible();
    const L = await page.evaluate(() => (window as unknown as { __cuesight: Hook }).__cuesight.state.snap.layout!);
    const one = L.reduce((a, c) => (Math.hypot(c.pos.x - 0.3, c.pos.y - 0.15) < Math.hypot(a.pos.x - 0.3, a.pos.y - 0.15) ? c : a));
    await tap(page, one.pos);
    await tap(page, await pocket(page, 'TR'));
    await expect(page.getByTestId('shot-card')).toBeVisible();
    await page.setInputFiles('#snap-file-player', `${dir}snap-player.png`);
    await page.waitForFunction(() => ['guide', 'manual-taps'].includes((window as unknown as { __cuesight: Hook }).__cuesight.state.snap.step), null, { timeout: 45_000 });
    expect(await page.evaluate(() => (window as unknown as { __cuesight: Hook }).__cuesight.state.snap.step)).toBe('guide');
    await expect(page.locator('#hud-strike')).toContainText('Strike');
  });
});
