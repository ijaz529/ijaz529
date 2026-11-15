import { expect, test, type Page } from '@playwright/test';
import { changedFrac, gridDiff, regionStats, tableBox } from './pixels';

/** Feature 002 US1: the 3D practice table (falls back to the 2D table without WebGL2). */
type V2 = { x: number; y: number };
type Hook = {
  state: {
    practice: { balls: { id: string; pos: V2 }[] };
    table: { pockets: { id: string; mouthCenter: V2 }[] };
    plan: { targetId: string; pocketId: string } | null;
  };
  practiceToScreen(p: V2): V2;
  view3d: { isPlaying(): boolean; isAnimating?(): boolean; getCamera(): string } | null;
};
const hook = (page: Page) => page.evaluate(() => !!(window as unknown as { __cuesight: Hook }).__cuesight.view3d);
const camera = (page: Page) => page.evaluate(() => (window as unknown as { __cuesight: Hook }).__cuesight.view3d!.getCamera());
const playing = (page: Page) => page.evaluate(() => (window as unknown as { __cuesight: Hook }).__cuesight.view3d!.isPlaying());
const balls = (page: Page) => page.evaluate(() => (window as unknown as { __cuesight: Hook }).__cuesight.state.practice.balls.map((b) => ({ id: b.id, x: b.pos.x, y: b.pos.y })));

async function screenOf(page: Page, what: { ball?: string; pocket?: string }) {
  return page.evaluate((w) => {
    const h = (window as unknown as { __cuesight: Hook }).__cuesight;
    const p = w.ball ? h.state.practice.balls.find((b) => b.id === w.ball)!.pos : h.state.table.pockets.find((q) => q.id === w.pocket)!.mouthCenter;
    return h.practiceToScreen(p);
  }, what);
}
/** Two frames later and no camera transition running (insets are applied on the next frame). */
const settled = async (page: Page) => {
  // Playwright's waitForFunction treats a returned Promise as truthy (it does not await it), so the
  // camera wait is a plain predicate, then two frames so the final camera pose has been drawn.
  await page.waitForFunction(() => !(window as unknown as { __cuesight: Hook }).__cuesight.view3d?.isAnimating?.());
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))));
};

/**
 * Counts the recommendation requests the page sends to the planner worker and their replies (test
 * instrumentation only). Needed because a request is sent 180 ms after a tap (debounced), and a reply
 * to the request before can land inside that window and read as the new recommendation. The planner
 * client restarts the worker to abandon a superseded recommendation (src/app/planner-client.ts): a
 * terminated worker's requests will never be answered, so they stop counting as open.
 */
async function trackPlanner(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __planner: { open: Set<number>; last: number } };
    w.__planner = { open: new Set(), last: 0 };
    const sent = new WeakMap<Worker, Set<number>>();
    const orig = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (this: Worker, m: unknown, t?: unknown) {
      const msg = m as { type?: string; id?: number };
      if (msg?.type === 'recommend' && typeof msg.id === 'number') {
        let ids = sent.get(this);
        if (!ids) {
          ids = new Set();
          sent.set(this, ids);
          this.addEventListener('message', (e: MessageEvent) => {
            const d = e.data as { type?: string; id?: number };
            if (d?.type === 'recommendation' || d?.type === 'error') {
              w.__planner.open.delete(d.id!);
              sent.get(this)?.delete(d.id!);
              w.__planner.last = performance.now();
            }
          });
        }
        ids.add(msg.id);
        w.__planner.open.add(msg.id);
        w.__planner.last = performance.now();
      }
      return (orig as (this: Worker, m: unknown, t?: unknown) => void).call(this, m, t as never);
    } as typeof orig;
    const origTerminate = Worker.prototype.terminate;
    Worker.prototype.terminate = function (this: Worker) {
      for (const id of sent.get(this) ?? []) w.__planner.open.delete(id);
      sent.delete(this);
      w.__planner.last = performance.now();
      return origTerminate.call(this);
    };
  });
}

/**
 * Waits for the recommended stroke of the current target and pocket to be in the plan, with no
 * recommendation request in flight or about to be sent (the planner has been quiet for 0.5 s): the
 * card's badge, and even the state, can show an earlier recommendation for a moment.
 */
const recommendedPlan = (page: Page, pocket = 'TR') =>
  page.waitForFunction(
    (pk) => {
      const w = window as unknown as {
        __planner?: { open: Set<number>; last: number };
        __cuesight: { state: { recommended: { pending: boolean } | null; plan: { pocketId: string; strokeSource: string } | null } };
      };
      const s = w.__cuesight.state;
      const quiet = !w.__planner || (w.__planner.open.size === 0 && performance.now() - w.__planner.last > 500);
      return quiet && !!s.recommended && !s.recommended.pending && s.plan?.pocketId === pk && s.plan.strokeSource === 'recommended';
    },
    pocket,
    { timeout: 30_000 },
  );

/** Taps ball b1 then the top-right pocket: the 30° cut of the default practice layout. */
async function planB1(page: Page) {
  const ball = await screenOf(page, { ball: 'b1' });
  await page.mouse.click(ball.x, ball.y);
  // Picking a target can change the sheet's peek height, and the table re-frames (animated): locate
  // the pocket once it is still.
  await page.waitForFunction(() => (window as unknown as { __cuesight: { state: { targetId: string | null } } }).__cuesight.state.targetId === 'b1');
  let pocket = await screenOf(page, { pocket: 'TR' });
  for (let i = 0; i < 60; i++) {
    await settled(page);
    await page.waitForTimeout(150);
    const q = await screenOf(page, { pocket: 'TR' });
    if (Math.hypot(q.x - pocket.x, q.y - pocket.y) < 0.5) break;
    pocket = q;
  }
  await page.mouse.click(pocket.x, pocket.y);
  await expect(page.getByTestId('cut')).toHaveText('30.0°');
}

test.describe('3D practice table (feature 002 US1)', () => {
  test.beforeEach(async ({ page }) => {
    await trackPlanner(page);
    await page.goto('/?mode=practice');
    await expect(page.locator('#shot-card')).toContainText('Tap the ball you want to pocket');
    test.skip(!(await hook(page)), 'WebGL2 unavailable: the 2D fallback is covered by fallback2d.spec.ts');
    await expect(page.locator('body')).toHaveClass(/has-3d/);
    await settled(page);
  });

  test('the WebGL table really renders: cloth, rails and balls, not a blank canvas', async ({ page }) => {
    const box = await tableBox(page);
    expect(box.width).toBeGreaterThan(100);
    expect(box.height).toBeGreaterThan(100);
    const s = await regionStats(page, box);
    expect(s.greenFrac, 'mostly green cloth').toBeGreaterThan(0.35);
    expect(s.std, 'not a flat fill').toBeGreaterThan(8);
    expect(s.colours, 'shading, balls, diamonds').toBeGreaterThan(40);
  });

  test('tap a ball and a pocket → plan; camera presets switch the view', async ({ page }) => {
    const play = page.locator('.vc-play');
    await expect(play).toBeDisabled();
    await planB1(page);
    await expect(page.getByTestId('power')).toContainText('/10');
    // The provisional stroke is replaced by the recommended one a moment later (its label and cue-ball
    // path change): compare pictures of the final plan only.
    await expect(page.getByTestId('shot-card')).toContainText('recommended for position', { timeout: 20_000 });
    await settled(page);
    expect(await camera(page)).toBe('overview');
    const box = { x: 0, y: 0, width: page.viewportSize()!.width, height: Math.round(page.viewportSize()!.height * 0.6) };
    const top = await regionStats(page, box);

    const presets: [RegExp, string][] = [
      [/^Player view/, 'player'],
      [/^Broadcast/, 'broadcast'],
      [/^Overview/, 'overview'],
    ];
    const seen: Record<string, Awaited<ReturnType<typeof regionStats>>> = {};
    for (const [name, id] of presets) {
      const btn = page.getByRole('button', { name });
      await btn.click();
      await expect(btn).toHaveAttribute('aria-pressed', 'true');
      await expect.poll(() => camera(page)).toBe(id);
      await settled(page);
      seen[id] = await regionStats(page, box);
    }
    // Each preset frames the table differently; Overview comes back to the same picture.
    expect(gridDiff(top, seen.player!)).toBeGreaterThan(6);
    expect(gridDiff(seen.player!, seen.broadcast!)).toBeGreaterThan(6);
    expect(gridDiff(top, seen.overview!)).toBeLessThan(3);
    await expect(play).toBeEnabled();
  });

  test('Play shot replays the simulated shot to the end and leaves the layout untouched', async ({ page }) => {
    await planB1(page);
    // Replay the final plan: the recommended stroke landing during a replay is a new plan, which stops
    // the replay first (spec edge case, tested below), so wait for it.
    await recommendedPlan(page);
    const before = await balls(page);
    const box = await tableBox(page);
    const still = await regionStats(page, box);
    await page.getByRole('button', { name: 'Play shot' }).click();
    // During the replay the picture differs from the still plan (the plan lines hide, balls roll).
    let sawPlaying = false;
    let moved = 0;
    for (const t0 = Date.now(); Date.now() - t0 < 10_000 && moved <= 0.004; ) {
      const now = await playing(page);
      if (!now && sawPlaying) break;
      sawPlaying ||= now;
      if (now) moved = Math.max(moved, changedFrac(still, await regionStats(page, box)));
    }
    expect(sawPlaying).toBe(true);
    expect(moved).toBeGreaterThan(0.004);
    // ×1 speed, capped at 4 s, plus the strike and the hold: finishes on its own.
    await expect.poll(() => playing(page), { timeout: 12_000, intervals: [250] }).toBe(false);
    await expect(page.getByRole('button', { name: 'Play shot' })).toBeEnabled();
    expect(await balls(page)).toEqual(before);
    await expect(page.getByTestId('cut')).toHaveText('30.0°');
    // Right after a replay ends by itself, Play ignores taps briefly (REPLAY_TAP_GUARD_MS = 350 ms)
    // so a late tap on "Skip" does not restart it.
    await page.waitForTimeout(500);
    // Skip works too, from the button and from the keyboard (Escape). `force` skips Playwright's
    // stability wait, which takes several seconds against the software-rendered (SwiftShader) canvas,
    // so the tap lands while the replay is still running.
    for (const skip of [() => page.locator('.vc-play').click({ force: true }), () => page.keyboard.press('Escape')]) {
      await page.getByRole('button', { name: 'Play shot' }).click();
      await expect.poll(() => playing(page)).toBe(true);
      await expect(page.locator('.vc-play')).toHaveAttribute('aria-label', 'Skip the replay');
      await skip();
      await expect.poll(() => playing(page), { timeout: 5_000 }).toBe(false);
      await expect(page.getByRole('button', { name: 'Play shot' })).toBeVisible();
      // Not restarted by a late tap.
      await page.waitForTimeout(300);
      expect(await playing(page)).toBe(false);
    }
    expect(await balls(page)).toEqual(before);
    await expect(page.getByTestId('shot-card')).toBeVisible();
  });

  // The two tests below start the replay and act on it inside one page script, a frame apart: the
  // software renderer (SwiftShader) can take seconds per frame under load, so polling from the test
  // could miss a replay or outlive it. One frame after it starts, a replay is always still running (its
  // end hold is only reached on a later frame). The recommended stroke has landed first: a new plan
  // arriving would itself stop the replay (that is the second test); should a late state change still
  // stop the first start, the replay is started again (at most three times) before acting on it.
  test('a tap on the table during the replay skips straight to the planned layout (no second hold)', async ({ page }) => {
    await planB1(page);
    await recommendedPlan(page);
    const before = await balls(page);
    const r = await page.evaluate(async () => {
      const h = (window as unknown as { __cuesight: Hook & { playShot(): Promise<void> } }).__cuesight;
      let was = false;
      for (let i = 0; i < 3 && !was; i++) {
        void h.playShot();
        await new Promise((ok) => requestAnimationFrame(ok));
        was = h.view3d!.isPlaying();
      }
      // One tap on empty cloth, dispatched synchronously: the replay is over when the tap returns.
      const c = document.querySelector<HTMLCanvasElement>('#table3d')!;
      const box = c.getBoundingClientRect();
      const at = { clientX: box.left + box.width / 2, clientY: box.top + 12, bubbles: true, pointerId: 41, isPrimary: true, button: 0, pointerType: 'touch' };
      c.dispatchEvent(new PointerEvent('pointerdown', at));
      c.dispatchEvent(new PointerEvent('pointerup', at));
      return { was, after: h.view3d!.isPlaying() };
    });
    expect(r).toEqual({ was: true, after: false });
    // The Skip button turns back into Play on the next rendered frame (slow on the software renderer).
    await expect(page.getByRole('button', { name: 'Play shot' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('cut')).toHaveText('30.0°');
    expect(await balls(page)).toEqual(before);
  });

  test('a plan change during the replay stops it first and shows the new plan (spec edge case)', async ({ page }) => {
    await planB1(page);
    await recommendedPlan(page);
    const before = await balls(page);
    // Another pocket for the same ball (the planner hands back a new plan): the old trajectories must
    // not keep replaying under the new plan's lines. The new plan reaches the 3D view on the next frame
    // (the store renders once per frame), so two frames later the replay is over.
    const r = await page.evaluate(async () => {
      const h = (window as unknown as { __cuesight: Hook & { playShot(): Promise<void>; selectPocket(id: string): void } }).__cuesight;
      let was = false;
      for (let i = 0; i < 3 && !was; i++) {
        void h.playShot();
        await new Promise((ok) => requestAnimationFrame(ok));
        was = h.view3d!.isPlaying();
      }
      h.selectPocket('BR');
      for (let i = 0; i < 2; i++) await new Promise((ok) => requestAnimationFrame(ok));
      return { was, after: h.view3d!.isPlaying() };
    });
    expect(r).toEqual({ was: true, after: false });
    await expect.poll(() => page.evaluate(() => (window as unknown as { __cuesight: Hook }).__cuesight.state.plan?.pocketId), { timeout: 15_000 }).toBe('BR');
    await expect(page.getByRole('button', { name: 'Play shot' })).toBeVisible({ timeout: 15_000 });
    expect(await balls(page)).toEqual(before);
  });

  test('idle: no animation frames and no GL draws without interaction (FR-109, SC-101)', async ({ page }) => {
    await planB1(page);
    await expect(page.getByTestId('shot-card')).toContainText('recommended for position', { timeout: 20_000 });
    await settled(page);
    // Count from here on: requestAnimationFrame is looked up on window by every loop, and every 3D draw
    // goes through the WebGL2 prototype.
    await page.evaluate(() => {
      const w = window as unknown as { __rafs: number; __draws: number };
      w.__rafs = 0;
      w.__draws = 0;
      const raf = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (cb) => raf((t) => (w.__rafs++, cb(t)));
      const P = WebGL2RenderingContext.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
      for (const k of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) {
        const o = P[k]!;
        P[k] = function (this: unknown, ...a: unknown[]) {
          w.__draws++;
          return o.apply(this, a);
        };
      }
    });
    // A frame already scheduled before the counters were installed may still land: start counting after it.
    await page.waitForTimeout(700);
    await page.evaluate(() => {
      const w = window as unknown as { __rafs: number; __draws: number };
      w.__rafs = 0;
      w.__draws = 0;
    });
    await page.waitForTimeout(1500);
    expect(await page.evaluate(() => (window as unknown as { __rafs: number; __draws: number }).__rafs)).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { __rafs: number; __draws: number }).__draws)).toBe(0);
  });

  test('a GPU context lost for good falls back to the 2D table, keeping the layout and the plan (FR-110)', async ({ page }) => {
    await planB1(page);
    const before = await balls(page);
    const lost = await page.evaluate(() => {
      const gl = document.querySelector<HTMLCanvasElement>('#table3d')!.getContext('webgl2');
      const ext = gl?.getExtension('WEBGL_lose_context');
      ext?.loseContext();
      return !!ext;
    });
    test.skip(!lost, 'WEBGL_lose_context unavailable');
    // No webglcontextrestored follows: after 3 s the app switches to the 2D table and says so.
    await expect(page.locator('body')).not.toHaveClass(/has-3d/, { timeout: 6_000 });
    expect(await hook(page)).toBe(false);
    await expect(page.locator('#toast')).toContainText('2D table');
    await expect(page.locator('#table')).toBeVisible();
    expect(await balls(page)).toEqual(before);
    await expect(page.getByTestId('cut')).toHaveText('30.0°');
  });

  test('drag a ball to move it', async ({ page }) => {
    const before = (await balls(page)).find((b) => b.id === 'b2')!;
    const p = await screenOf(page, { ball: 'b2' });
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    await page.mouse.move(p.x + 25, p.y - 30, { steps: 6 });
    await page.mouse.up();
    const after = (await balls(page)).find((b) => b.id === 'b2')!;
    expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeGreaterThan(0.05);
    // The ball is drawn where the state says: the hook maps it under the pointer's end point.
    const q = await screenOf(page, { ball: 'b2' });
    expect(Math.hypot(q.x - (p.x + 25), q.y - (p.y - 30))).toBeLessThan(12);
  });
});

test('?renderer=2d forces the 2D table with every feature', async ({ page }) => {
  await page.goto('/?mode=practice&renderer=2d');
  await expect(page.locator('#shot-card')).toContainText('Tap the ball you want to pocket');
  await expect(page.locator('body')).not.toHaveClass(/has-3d/);
  await planB1(page);
});
