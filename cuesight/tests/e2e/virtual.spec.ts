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
