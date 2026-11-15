import { expect, test, type Page } from '@playwright/test';

type Hook = {
  state: { practice: { balls: { id: string; pos: { x: number; y: number } }[] }; table: { pockets: { id: string; mouthCenter: { x: number; y: number } }[] } };
  practiceToScreen(p: { x: number; y: number }): { x: number; y: number };
};

async function screenOf(page: Page, what: { ball?: string; pocket?: string }) {
  return page.evaluate((w) => {
    const h = (window as unknown as { __cuesight: Hook }).__cuesight;
    const p = w.ball ? h.state.practice.balls.find((b) => b.id === w.ball)!.pos : h.state.table.pockets.find((q) => q.id === w.pocket)!.mouthCenter;
    return h.practiceToScreen(p);
  }, what);
}

test.describe('practice table (US1, US3)', () => {
  test('tap a ball and a pocket → full shot card with tangent-line coaching', async ({ page }) => {
    await page.goto('/?mode=practice');
    await expect(page.locator('#shot-card')).toContainText('Tap the ball you want to pocket');
    const ball = await screenOf(page, { ball: 'b1' });
    await page.mouse.click(ball.x, ball.y);
    const pocket = await screenOf(page, { pocket: 'TR' });
    await page.mouse.click(pocket.x, pocket.y);
    const card = page.getByTestId('shot-card');
    await expect(card).toBeVisible();
    await expect(page.getByTestId('cut')).toHaveText('30.0°');
    await expect(card).toContainText('½-ball hit');
    await expect(page.getByTestId('power')).toContainText('/10');
    await expect(page.getByTestId('difficulty')).toContainText('±');
    // Stun preset → the coaching tip names the 90° rule.
    await page.getByRole('button', { name: 'Stun' }).click();
    await expect(page.getByTestId('tip')).toContainText('90° rule');
    // Follow preset → 30° rule.
    await page.getByRole('button', { name: 'Follow' }).click();
    await expect(page.getByTestId('tip')).toContainText('30° rule');
    await expect(card).toContainText('your stroke');
    // Back to the recommendation (computed off the UI thread).
    await page.getByRole('button', { name: 'Use recommended' }).click();
    await expect(card).toContainText('recommended for position', { timeout: 15_000 });
  });

  test('suggestions list ranked shots and opens a plan', async ({ page }) => {
    await page.goto('/?mode=practice');
    await page.locator('select[aria-label="Practice layout"]').selectOption('nine');
    await page.getByRole('button', { name: 'Suggest the best shots' }).click();
    const list = page.locator('.suggest li button');
    await expect(list.first()).toBeVisible({ timeout: 15_000 });
    await list.first().click();
    await expect(page.getByTestId('shot-card')).toBeVisible();
  });

  test('blocked drill warns and names the blocker', async ({ page }) => {
    await page.goto('/?mode=practice');
    await page.locator('select[aria-label="Practice layout"]').selectOption('blocked');
    const ball = await screenOf(page, { ball: 'b1' });
    await page.mouse.click(ball.x, ball.y);
    const pocket = await screenOf(page, { pocket: 'TR' });
    await page.mouse.click(pocket.x, pocket.y);
    await expect(page.locator('.warnings')).toContainText('blocked by 5');
  });
});

type V2 = { x: number; y: number };
type SelHook = {
  state: {
    targetId: string | null;
    landing: V2 | null;
    interaction: string;
    heatmap: { nextBallId: string } | null;
    practice: { balls: { id: string; kind: string; pos: V2 }[] };
  };
  practiceToScreen(p: V2): V2;
  selectBall(id: string): void;
  selectPocket(id: string): void;
  view3d: { isAnimating?(): boolean } | null;
};
const selState = (page: Page) =>
  page.evaluate(() => {
    const s = (window as unknown as { __cuesight: SelHook }).__cuesight.state;
    return { targetId: s.targetId, landing: s.landing, interaction: s.interaction, heatmap: s.heatmap?.nextBallId ?? null };
  });
/** Two frames later and no 3D camera transition running (the table re-frames when the sheet grows). */
async function settled(page: Page) {
  await page.waitForFunction(() => !(window as unknown as { __cuesight: SelHook }).__cuesight.view3d?.isAnimating?.());
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))));
}
/** Selects b1 → TR through the app's own selection flow, then waits until the table stops moving. */
async function planB1(page: Page) {
  await page.evaluate(() => {
    const h = (window as unknown as { __cuesight: SelHook }).__cuesight;
    h.selectBall('b1');
    h.selectPocket('TR');
  });
  await expect.poll(() => page.evaluate(() => !!(window as unknown as { __cuesight: { state: { plan: unknown } } }).__cuesight.state.plan)).toBe(true);
  let last = await screenOf(page, { ball: 'b2' });
  for (let i = 0; i < 60; i++) {
    await settled(page);
    await page.waitForTimeout(150);
    const q = await screenOf(page, { ball: 'b2' });
    if (Math.hypot(q.x - last.x, q.y - last.y) < 0.5) break;
    last = q;
  }
}
const pressTool = (page: Page, action: string) => page.evaluate((a) => document.querySelector<HTMLButtonElement>(`#toolbar [data-action="${a}"]`)!.click(), action);

test.describe('selection modes (Position, Zones)', () => {
  test('Position: a landing tap next to another ball sets the spot and keeps the target', async ({ page }) => {
    await page.goto('/?mode=practice');
    await expect(page.locator('#shot-card')).toContainText('Tap the ball you want to pocket');
    await planB1(page);
    await pressTool(page, 'position');
    await expect.poll(async () => (await selState(page)).interaction).toBe('position');
    // 8 cm beside b2: well inside the ball-tap slop of both the 3D and the 2D table.
    const spot = await page.evaluate(() => {
      const b2 = (window as unknown as { __cuesight: SelHook }).__cuesight.state.practice.balls.find((b) => b.id === 'b2')!;
      return { x: b2.pos.x + 0.08, y: b2.pos.y };
    });
    const q = await page.evaluate((p) => (window as unknown as { __cuesight: SelHook }).__cuesight.practiceToScreen(p), spot);
    await page.mouse.click(q.x, q.y);
    await expect(page.locator('#toast')).toContainText('Finding the stroke');
    const st = await selState(page);
    expect(st.targetId).toBe('b1');
    expect(st.interaction).toBe('select');
    expect(st.landing).not.toBeNull();
    expect(Math.hypot(st.landing!.x - spot.x, st.landing!.y - spot.y)).toBeLessThan(0.03);
  });

  test('Zones: the cue ball and the ball being potted are not accepted as the next ball', async ({ page }) => {
    await page.goto('/?mode=practice');
    await expect(page.locator('#shot-card')).toContainText('Tap the ball you want to pocket');
    await planB1(page);
    await pressTool(page, 'zones');
    const pick = async (id: string) => {
      await page.evaluate((i) => (window as unknown as { __cuesight: SelHook }).__cuesight.selectBall(i), id);
      const s = await selState(page);
      return { heatmap: s.heatmap, interaction: s.interaction };
    };
    expect(await pick('cue')).toEqual({ heatmap: null, interaction: 'pick-next' });
    await expect(page.locator('#toast')).toContainText('different object ball');
    expect(await pick('b1')).toEqual({ heatmap: null, interaction: 'pick-next' });
    expect(await pick('b2')).toEqual({ heatmap: 'b2', interaction: 'select' });
  });
});
