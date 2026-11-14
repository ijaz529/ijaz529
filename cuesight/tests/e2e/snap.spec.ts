import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { regionStats, visibleBox } from './pixels';

/** Feature 002 US2: Snap, the two-photo guide, on the committed synthetic photos. */
const dir = fileURLToPath(new URL('../fixtures/', import.meta.url));
type V2 = { x: number; y: number };
const gt = JSON.parse(readFileSync(`${dir}snap-layout.json`, 'utf8')) as {
  balls: { id: string; pos: V2; isCue: boolean }[];
  photos: { playerHard: { width: number; expect: { manualTaps: { cue: V2; target: V2 } } } };
};
type Snap = { step: string; layout: { id: string; kind: string; pos: V2 }[] | null; player: { result: { ok: boolean; confidence: number; reason?: string } | null } | null };
type Hook = {
  state: { snap: Snap; plan: { targetId: string; pocketId: string; stroke: { power: number; vert: number } } | null; table: { pockets: { id: string; mouthCenter: V2 }[] } };
  practiceToScreen(p: V2): V2;
  view3d: { isAnimating?(): boolean } | null;
  snap: { photoToScreen(p: V2): V2; photos(): { player: { width: number } | null }; guide(): { strike: { visible: boolean } | null; face: { c: V2; dot: V2; r: number } | null } | null };
};
const H = (page: Page) => page.evaluate(() => (window as unknown as { __cuesight: Hook }).__cuesight.state.snap);
const stepIs = (page: Page, steps: string[]) =>
  page.waitForFunction((s) => s.includes((window as unknown as { __cuesight: Hook }).__cuesight.state.snap.step), steps, { timeout: 45_000 });

/** Okabe–Ito plan colours (src/app/render/palette.ts): aim line blue, object-ball path orange. */
const AIM_BLUE: [number, number, number] = [0x00, 0x72, 0xb2];
const OBJECT_ORANGE: [number, number, number] = [0xe6, 0x9f, 0x00];

const settled = async (page: Page) => {
  // Playwright's waitForFunction treats a returned Promise as truthy (it does not await it), so the
  // camera wait is a plain predicate, then two frames so the final camera pose has been drawn.
  await page.waitForFunction(() => !(window as unknown as { __cuesight: Hook }).__cuesight.view3d?.isAnimating?.());
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))));
};

/** The pocket's on-screen position once the table has stopped moving (re-frames are animated). */
async function stableScreenPoint(page: Page, pocket: string): Promise<V2> {
  let last: V2 | null = null;
  for (let i = 0; i < 60; i++) {
    await settled(page);
    const q = await page.evaluate((pk) => {
      const h = (window as unknown as { __cuesight: Hook }).__cuesight;
      return h.practiceToScreen(h.state.table.pockets.find((p) => p.id === pk)!.mouthCenter);
    }, pocket);
    if (last && Math.hypot(q.x - last.x, q.y - last.y) < 0.5) return q;
    last = q;
    await page.waitForTimeout(150);
  }
  return last!;
}

/**
 * Taps the detected ball nearest to `pos` (table metres) on the layout table, then a pocket. The
 * pocket is located after the ball tap, once the table is still: picking a target adds the step-2
 * call to action to the top card, and the table re-frames (animated) into the space left.
 */
async function pick(page: Page, pos: V2, pocket: string) {
  await settled(page);
  const ball = await page.evaluate((p) => {
    const h = (window as unknown as { __cuesight: Hook }).__cuesight;
    const b = h.state.snap.layout!.reduce((a, c) => (Math.hypot(c.pos.x - p.x, c.pos.y - p.y) < Math.hypot(a.pos.x - p.x, a.pos.y - p.y) ? c : a));
    return { id: b.id, at: h.practiceToScreen(b.pos) };
  }, pos);
  await page.mouse.click(ball.at.x, ball.at.y);
  await page.waitForFunction((id) => (window as unknown as { __cuesight: Hook & { state: { targetId: string | null } } }).__cuesight.state.targetId === id, ball.id);
  const at = await stableScreenPoint(page, pocket);
  await page.mouse.click(at.x, at.y);
  await page.waitForFunction((pk) => (window as unknown as { __cuesight: Hook & { state: { pocketId: string | null } } }).__cuesight.state.pocketId === pk, pocket);
}

async function tablePhoto(page: Page) {
  await page.goto('/?mode=snap');
  await expect(page.getByRole('button', { name: 'Take photo' })).toBeVisible();
  // Before any photo: no guide drawn, nothing to plan.
  expect((await H(page)).step).toBe('intro');
  await page.setInputFiles('#snap-file-table', `${dir}snap-overview.png`);
  await stepIs(page, ['review', 'overview-error']);
  expect((await H(page)).step).toBe('review');
}

test.describe('Snap two-photo guide (feature 002 US2)', () => {
  test('table photo → layout → target → player photo → guide', async ({ page }) => {
    await tablePhoto(page);
    const s = await H(page);
    // The right number of balls, one cue ball, each where the ray-traced ground truth put it.
    expect(s.layout!.length).toBe(gt.balls.length);
    expect(s.layout!.filter((b) => b.kind === 'cue')).toHaveLength(1);
    for (const b of gt.balls) {
      const near = Math.min(...s.layout!.map((d) => Math.hypot(d.pos.x - b.pos.x, d.pos.y - b.pos.y)));
      expect(near, `ball ${b.id} found within 4 cm`).toBeLessThan(0.04);
    }
    const cue = s.layout!.find((b) => b.kind === 'cue')!;
    const gtCue = gt.balls.find((b) => b.isCue)!;
    expect(Math.hypot(cue.pos.x - gtCue.pos.x, cue.pos.y - gtCue.pos.y)).toBeLessThan(0.04);
    await expect(page.locator('#snap-chip')).toContainText(`${gt.balls.length} balls`);

    await pick(page, gt.balls.find((b) => b.id === '1')!.pos, 'TR');
    await expect(page.getByTestId('shot-card')).toBeVisible();
    await expect(page.getByTestId('cut')).toContainText('°');
    await expect(page.getByRole('button', { name: 'Take the player-view photo' })).toBeVisible();

    await page.setInputFiles('#snap-file-player', `${dir}snap-player.png`);
    await stepIs(page, ['guide', 'manual-taps']);
    expect((await H(page)).step).toBe('guide');
    await expect(page.locator('#snap-fit')).toContainText('Fit: good');
    // How hard: n/10 plus a speed word; where to strike: tip offset in coaching words.
    const plan = await page.evaluate(() => (window as unknown as { __cuesight: Hook }).__cuesight.state.plan!);
    const pw = plan.stroke.power;
    await expect(page.locator('#hud-power')).toHaveText(`${pw.toFixed(pw % 1 ? 1 : 0)}/10`);
    await expect(page.locator('#snap-hud')).toContainText('/10');
    await expect(page.locator('#hud-speed')).toContainText(/soft|slow|medium|firm|hard|power/i);
    await expect(page.locator('#hud-strike')).toContainText(/^Strike .*(tip|centre)/);
    await expect(page.locator('#hud-aim')).toContainText('ghost ball');
    const strike = await page.evaluate(() => (window as unknown as { __cuesight: Hook }).__cuesight.snap.guide()?.strike);
    expect(strike?.visible).toBe(true);
    // The guide is really drawn on the photo: the blue aim line and the orange object-ball path.
    const px = await regionStats(page, await visibleBox(page, '#snap-canvas'), [AIM_BLUE, OBJECT_ORANGE]);
    expect(px.matchFrac[0], 'aim line pixels').toBeGreaterThan(0.0005);
    expect(px.matchFrac[1], 'object-ball path pixels').toBeGreaterThan(0.0002);
    // Where to strike: the cue ball's face drawn flat (as coaches draw it), on the photo and in the
    // HUD, so a high hit is above the centre in both (never a projected point that reads as low).
    await expect(page.locator('#hud-spin svg .tip-dot')).toBeVisible();
    const face = await page.evaluate(() => (window as unknown as { __cuesight: Hook }).__cuesight.snap.guide()?.face ?? null);
    expect(face).not.toBeNull();
    if (plan.stroke.vert > 0.04) expect(face!.dot.y).toBeLessThan(face!.c.y);
    if (plan.stroke.vert < -0.04) expect(face!.dot.y).toBeGreaterThan(face!.c.y);

    // Leaving Snap releases the photos (FR-122).
    await page.locator('.mode-switch [data-mode="practice"]').click();
    expect((await H(page)).step).toBe('intro');
  });

  test('a photo it cannot line up → reason → two taps → guide (manual fallback)', async ({ page }) => {
    await tablePhoto(page);
    // The 8 to the bottom-right corner (a 52° cut): a shot that can be played, so the guide gives a
    // strike point and a power. (The 8 to TR is a 92° "cut" — not makeable — and gets no stroke at all.)
    await pick(page, gt.balls.find((b) => b.id === '8')!.pos, 'BR');
    await expect(page.getByTestId('shot-card')).toBeVisible();
    await page.setInputFiles('#snap-file-player', `${dir}snap-player-hard.png`);
    await stepIs(page, ['guide', 'manual-taps']);
    expect((await H(page)).step).toBe('manual-taps');
    // Honest: no guide is drawn, the reason is shown, and the next step is spelled out.
    expect(await page.evaluate(() => (window as unknown as { __cuesight: Hook }).__cuesight.snap.guide())).toBeNull();
    await expect(page.locator('#snap-top')).toContainText("couldn't line up");
    await expect(page.locator('#snap-top')).toContainText('Tap the centre of the cue ball');
    // The table-photo hint from step 1 does not linger over these instructions.
    await expect(page.locator('#toast')).toBeHidden();
    const taps = gt.photos.playerHard.expect.manualTaps;
    const k = await page.evaluate(() => (window as unknown as { __cuesight: Hook }).__cuesight.snap.photos().player!.width);
    const at = async (p: V2) => page.evaluate((pp) => (window as unknown as { __cuesight: Hook }).__cuesight.snap.photoToScreen(pp), { x: (p.x * k) / gt.photos.playerHard.width, y: (p.y * k) / gt.photos.playerHard.width });
    const c = await at(taps.cue);
    await page.mouse.click(c.x, c.y);
    await expect(page.locator('#snap-top')).toContainText('target ball');
    const t = await at(taps.target);
    await page.mouse.click(t.x, t.y);
    await stepIs(page, ['guide']);
    const r = (await H(page)).player!.result!;
    expect(r.ok).toBe(true);
    expect(r.confidence).toBeLessThanOrEqual(0.7);
    await expect(page.locator('#snap-fit')).toContainText('Fit:');
    await expect(page.locator('#hud-strike')).toContainText('Strike');
    await expect(page.locator('#snap-hud')).toContainText('/10');
  });
});
