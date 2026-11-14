import { expect, test } from '@playwright/test';

type Hook = {
  state: { vision: { status: string; balls: { id: string; kind: string; pos: { x: number; y: number } }[] } | null };
  overlayToScreen(p: { x: number; y: number }, z?: 'ball' | 'cloth'): { x: number; y: number } | null;
};

test.describe('live camera (US2) — synthetic table as the fake camera', () => {
  test.use({ permissions: ['camera'] });

  test('locks onto the table, finds the balls and draws a plan from a tap', async ({ page }) => {
    await page.goto('/?mode=camera');
    await expect(page.locator('#status')).toContainText('Table locked', { timeout: 20_000 });
    const n = await page.evaluate(() => (window as unknown as { __cuesight: Hook }).__cuesight.state.vision!.balls.length);
    expect(n).toBeGreaterThanOrEqual(8); // ≥ 90 % of the 9 balls
    const target = await page.evaluate(() => {
      const h = (window as unknown as { __cuesight: Hook }).__cuesight;
      const b = h.state.vision!.balls.filter((x) => x.kind !== 'cue').sort((a, c) => Math.hypot(a.pos.x, a.pos.y) - Math.hypot(c.pos.x, c.pos.y))[0]!;
      return h.overlayToScreen(b.pos)!;
    });
    await page.mouse.click(target.x, target.y);
    await expect(page.getByTestId('shot-card')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('cut')).toContainText('°');
    // Freeze keeps the layout.
    await page.getByRole('button', { name: 'Freeze the detected layout' }).click();
    await expect(page.locator('#status')).toContainText('Frozen layout');
    await expect(page.getByTestId('shot-card')).toBeVisible();
  });
});

test.describe('camera denied', () => {
  test.use({ permissions: [] });
  test('explains why and offers the practice table', async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'mediaDevices', {
        value: { getUserMedia: () => Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' })) },
      });
    });
    await page.goto('http://localhost:4173/?mode=camera');
    await expect(page.locator('#camera-msg')).toContainText('never uploaded');
    await page.getByRole('button', { name: 'Use practice table' }).click();
    await expect(page.locator('body')).toHaveAttribute('data-mode', 'practice');
    await ctx.close();
  });
});
