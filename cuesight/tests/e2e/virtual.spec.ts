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

/**
 * Where a ball or pocket is on screen once the table has stopped moving: picking a target grows the
 * sheet and the 3D table re-frames (animated, and slow on the software renderer under load), so a
 * position read at once can be a pocket's old place.
 */
async function stillScreenOf(page: Page, what: { ball?: string; pocket?: string }) {
  let q = await screenOf(page, what);
  for (let i = 0; i < 60; i++) {
    await settled(page);
    await page.waitForTimeout(150);
    const next = await screenOf(page, what);
    if (Math.hypot(next.x - q.x, next.y - q.y) < 0.5) return next;
    q = next;
  }
  return q;
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
    test.setTimeout(90_000);
    await page.goto('/?mode=practice');
    await page.locator('select[aria-label="Practice layout"]').selectOption('blocked');
    const ball = await stillScreenOf(page, { ball: 'b1' });
    await page.mouse.click(ball.x, ball.y);
    await expect.poll(() => page.evaluate(() => (window as unknown as { __cuesight: SelHook }).__cuesight.state.targetId), { timeout: 15_000 }).toBe('b1');
    const pocket = await stillScreenOf(page, { pocket: 'TR' });
    await page.mouse.click(pocket.x, pocket.y);
    await expect(page.locator('.warnings')).toContainText('blocked by 5', { timeout: 15_000 });
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

/**
 * Final verify (wave 2b): the recommendation's toast talks about the stroke the card shows. A player who
 * sets their own stroke while the search is still running saw "None of the strokes tried pots this ball
 * without a scratch — showing the basic stroke." (or "This stroke may need precise pace…") next to a
 * card showing "your stroke".
 */
test.describe('recommendation toasts follow the stroke on show', () => {
  type RecHook = {
    state: {
      practice: { balls: unknown[] };
      recommended: { pending: boolean; stroke: unknown; evaluated: number } | null;
      plan: { strokeSource: string } | null;
      strokeMode: string;
    };
    selectBall(id: string): void;
    selectPocket(id: string): void;
  };
  /** A frozen cue ball no stroke pots with pace (the core's "no power" layout): the search finds nothing. */
  const frozenSoft = (page: Page, ownStroke: boolean) =>
    page.evaluate((own) => {
      const h = (window as unknown as { __cuesight: RecHook }).__cuesight;
      h.state.practice.balls = [
        { id: 'cue', kind: 'cue', pos: { x: -0.2960660046526003, y: -0.4506717941723339 }, label: 'cue' },
        { id: 'b1', kind: 'object', pos: { x: -0.25, y: -0.485 }, label: '1', color: '#e8b90f' },
      ];
      h.selectBall('b1');
      h.selectPocket('BM');
      // The player's own stroke, in the same turn: the recommendation asked for above is still on its way.
      if (own) document.querySelector<HTMLButtonElement>('[data-p="follow"]')!.click();
    }, ownStroke);
  const toastsSeen = (page: Page) =>
    page.evaluate(() => {
      const w = window as unknown as { __toasts?: string[] };
      if (!w.__toasts) {
        w.__toasts = [];
        const el = document.querySelector('#toast')!;
        new MutationObserver(() => w.__toasts!.push(el.textContent ?? '')).observe(el, { childList: true, characterData: true, subtree: true });
      }
      return w.__toasts;
    });
  const replied = (page: Page) =>
    page.waitForFunction(
      () => {
        const r = (window as unknown as { __cuesight: RecHook }).__cuesight.state.recommended;
        return !!r && !r.pending;
      },
      undefined,
      { timeout: 45_000 },
    );
  const ABOUT_THE_RECOMMENDATION = /showing the basic stroke|This stroke may need precise pace|showing the best stroke found/;

  test('with the player’s own stroke on show, a late recommendation says nothing about a stroke not shown', async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/?mode=practice&renderer=2d');
    await expect(page.locator('#shot-card')).toContainText('Tap the ball you want to pocket');
    await toastsSeen(page);
    await frozenSoft(page, true);
    await replied(page);
    const s = await page.evaluate(() => {
      const st = (window as unknown as { __cuesight: RecHook }).__cuesight.state;
      return { mode: st.strokeMode, source: st.plan?.strokeSource, found: st.recommended!.stroke !== null, evaluated: st.recommended!.evaluated };
    });
    // Not vacuous: the search ran and found nothing (the reply that toasts "showing the basic stroke").
    expect(s).toEqual({ mode: 'mine', source: 'player', found: false, evaluated: expect.any(Number) });
    expect(s.evaluated).toBeGreaterThan(0);
    await page.waitForTimeout(400);
    expect((await toastsSeen(page)).filter((t) => ABOUT_THE_RECOMMENDATION.test(t))).toEqual([]);
    await expect(page.locator('#shot-card')).toContainText('your stroke');
  });

  test('with the recommendation on show, the same reply still says so', async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/?mode=practice&renderer=2d');
    await expect(page.locator('#shot-card')).toContainText('Tap the ball you want to pocket');
    await toastsSeen(page);
    await frozenSoft(page, false);
    await replied(page);
    await expect.poll(async () => (await toastsSeen(page)).some((t) => /None of the strokes tried pots this ball without a scratch — showing the basic stroke\./.test(t)), { timeout: 10_000 }).toBe(true);
    await expect(page.locator('#shot-card')).toContainText('basic stroke');
  });
});

test.describe('bank shots (one cushion)', () => {
  type BankHook = {
    state: {
      practice: { balls: unknown[] };
      plan: { makeable: boolean; obPocketed: boolean; strokeSource: string; bank?: { rail: string } } | null;
      recommended: { pending: boolean } | null;
    };
    selectBall(id: string): void;
    selectPocket(id: string): void;
  };

  test('a pocket that cannot be played directly offers "Bank it": the shot is planned off the cushion, and picking the pocket again is the direct shot', async ({ page }) => {
    // No first-run hint over the card: its buttons are used here.
    await page.addInitScript(() => {
      try {
        localStorage.setItem('cuesight.onboarded', '1');
      } catch {
        /* storage unavailable: the hint stays */
      }
    });
    await page.goto('/?mode=practice');
    // The cue ball up-table of the ball: the top-right corner is on the wrong side, and only goes off the bottom cushion.
    await page.evaluate(() => {
      const h = (window as unknown as { __cuesight: BankHook }).__cuesight;
      h.state.practice.balls = [
        { id: 'cue', kind: 'cue', pos: { x: 0.65, y: 0.33 }, label: 'cue' },
        { id: 'b1', kind: 'object', pos: { x: 0.63, y: -0.27 }, label: '5', color: '#e8590c' },
      ];
      h.selectBall('b1');
      h.selectPocket('TR');
    });
    const card = page.getByTestId('shot-card');
    await expect(card).toContainText('wrong side');
    await expect(card.locator('.pocket-name')).not.toContainText('bank');
    await card.getByRole('button', { name: 'Bank it off a cushion' }).click();
    await expect(card.locator('.pocket-name')).toContainText('(bank)');
    await expect(page.getByTestId('tip')).toContainText('Bank shot');
    // The stroke search runs on the bank too, and the stroke it recommends pots the ball off the bottom cushion.
    await page.waitForFunction(
      () => {
        const s = (window as unknown as { __cuesight: BankHook }).__cuesight.state;
        return !!s.recommended && !s.recommended.pending && s.plan?.strokeSource === 'recommended';
      },
      undefined,
      { timeout: 45_000 },
    );
    const plan = await page.evaluate(() => {
      const p = (window as unknown as { __cuesight: BankHook }).__cuesight.state.plan!;
      return { makeable: p.makeable, obPocketed: p.obPocketed, rail: p.bank?.rail };
    });
    expect(plan).toEqual({ makeable: true, obPocketed: true, rail: 'bottom' });
    await expect(page.getByTestId('difficulty')).toContainText('hard');
    // The pocket picked again: the direct shot, with its reason, and the bank on offer once more.
    await page.evaluate(() => (window as unknown as { __cuesight: BankHook }).__cuesight.selectPocket('TR'));
    await expect(card).toContainText('wrong side');
    await expect(card.locator('.pocket-name')).not.toContainText('bank');
    await expect(card.getByRole('button', { name: 'Bank it off a cushion' })).toBeVisible();
  });
});
