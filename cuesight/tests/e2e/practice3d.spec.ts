import { expect, test, type Page } from '@playwright/test';
import { changedFrac, gridDiff, regionStats, tableBox } from './pixels';

/** Feature 002 US1: the 3D practice table (falls back to the 2D table without WebGL2). */

// SwiftShader draws every frame in software. At the Pixel 7's device pixel ratio (2.625) a frame took
// 0.6–3.3 s under CPU load and the camera-preset and replay tests flaked (wave-2a item 16); the
// iPhone SE and iPad projects already run at 1. The layout in CSS px stays the phone's. Chromium only:
// WebKit (playwright.webkit.config.ts, iPhone 15 at 3) keeps its device's ratio, the only DPR-3 run.
test.use({
  deviceScaleFactor: async ({ browserName }, use, testInfo) => {
    await use(browserName === 'chromium' ? 1 : (testInfo.project.use.deviceScaleFactor ?? 1));
  },
});
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

/** A replay's longest real time: strike 0.5 s + the shot x1, capped at 4 s + the hold 3.5 s (render3d/index.ts). */
const REPLAY_MAX_MS = 8_000;
const HOLD_MS = 3_500;
/** A skipped replay stops at once (stopPlayback is synchronous); this leaves room for a busy main thread. */
const SKIP_MAX_MS = 1_500;

type ReplayRec = { sawPlaying: boolean; moved: number; stillFrames: number; frames: number; tapAt: number; endedAt: number; lastAt: number; maxGap: number };

/**
 * Watches the next replay from inside the page, right after every frame the 3D view draws (rAF is
 * wrapped; a frame counts when it issued GL draws, and is read back before the browser presents it):
 * whether it played, the largest fraction of ~4 px cells of `box` whose luminance changed by more than
 * 20 against the still plan (as changedFrac), and when it ended after the Play tap. The still
 * reference is a frame drawn and read the same way just before (view3d.resize() redraws it).
 */
async function replayWatch(page: Page, box: { x: number; y: number; width: number; height: number }) {
  await page.evaluate(async (box) => {
    const w = window as unknown as { __cuesight: Hook & { view3d: { resize(): void } }; __replayRec: ReplayRec };
    const h = w.__cuesight;
    const canvas = document.querySelector<HTMLCanvasElement>('#table3d')!;
    const gl = canvas.getContext('webgl2')!; // the 3D view's own context
    const rect = canvas.getBoundingClientRect();
    const k = canvas.width / rect.width;
    const x0 = Math.max(0, Math.round((box.x - rect.left) * k));
    const W = Math.max(1, Math.min(canvas.width - x0, Math.round(box.width * k)));
    const H = Math.max(1, Math.min(canvas.height, Math.round(box.height * k)));
    const y0 = Math.max(0, canvas.height - Math.round((box.y - rect.top) * k) - H); // GL rows run bottom-up
    const cell = Math.max(1, Math.round(4 * k));
    const GX = Math.ceil(W / cell);
    const GY = Math.ceil(H / cell);
    const buf = new Uint8Array(W * H * 4);
    const grid = (): Float64Array => {
      const prev = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      gl.readPixels(x0, y0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, prev);
      const sum = new Float64Array(GX * GY);
      const n = new Float64Array(GX * GY);
      for (let y = 0; y < H; y += 2)
        for (let x = 0; x < W; x += 2) {
          const i = (y * W + x) * 4;
          const c = Math.floor(y / cell) * GX + Math.floor(x / cell);
          sum[c]! += 0.2126 * buf[i]! + 0.7152 * buf[i + 1]! + 0.0722 * buf[i + 2]!;
          n[c]! += 1;
        }
      for (let c = 0; c < sum.length; c++) sum[c] = sum[c]! / Math.max(1, n[c]!);
      return sum;
    };
    let draws = 0;
    const proto = WebGL2RenderingContext.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
    for (const name of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) {
      const orig = proto[name]!;
      proto[name] = function (this: unknown, ...a: unknown[]) {
        draws++;
        return orig.apply(this, a);
      };
    }
    const rec: ReplayRec = { sawPlaying: false, moved: 0, stillFrames: 0, frames: 0, tapAt: 0, endedAt: 0, lastAt: 0, maxGap: 0 };
    w.__replayRec = rec;
    let still: Float64Array | null = null;
    let seen = draws;
    const after = () => {
      if (rec.endedAt) return;
      const playingNow = h.view3d!.isPlaying();
      if (rec.sawPlaying && !playingNow) {
        rec.endedAt = performance.now();
        rec.maxGap = Math.max(rec.maxGap, rec.endedAt - rec.lastAt);
        return;
      }
      if (draws === seen) return;
      seen = draws;
      const g = grid();
      if (!playingNow) {
        if (!rec.sawPlaying) {
          still = g;
          rec.stillFrames++;
        }
        return;
      }
      const t = performance.now();
      if (rec.lastAt) rec.maxGap = Math.max(rec.maxGap, t - rec.lastAt);
      rec.lastAt = t;
      rec.sawPlaying = true;
      rec.frames++;
      if (!still) return;
      let changed = 0;
      for (let c = 0; c < g.length; c++) if (Math.abs(g[c]! - still[c]!) > 20) changed++;
      rec.moved = Math.max(rec.moved, changed / g.length);
    };
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb: FrameRequestCallback) =>
      raf((t) => {
        cb(t);
        after();
      });
    window.addEventListener(
      'click',
      (e) => {
        if (!rec.tapAt && (e.target as Element | null)?.closest?.('.vc-play')) rec.tapAt = performance.now();
      },
      true,
    );
    // One still frame, drawn and read back like the replay's.
    h.view3d.resize();
    for (let i = 0; i < 300 && !rec.stillFrames; i++) await new Promise((r) => setTimeout(r, 20));
  }, box);
}
/** What replayWatch saw; `endedAfterMs` runs from the Play tap to the first moment the replay is over. */
const replayRecord = (page: Page) =>
  page.evaluate(() => {
    const r = (window as unknown as { __replayRec: ReplayRec }).__replayRec;
    return { ...r, endedAfterMs: r.endedAt && r.tapAt ? r.endedAt - r.tapAt : Infinity };
  });
type SkipRec = { during: boolean; at: number; sync: boolean; stopped: number };
/**
 * Arms a page-side stopwatch for the next Skip input (a click on the Skip button, or Escape): `during`
 * when it arrived while the replay ran, `sync` when the replay was over as soon as the app had handled
 * that input (a bubble-phase listener on window runs after the app's own), `at` its time and `stopped`
 * when it was first seen over (at once, else checked every 5 ms).
 */
async function skipWatch(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __cuesight: Hook; __skipRec: SkipRec };
    const r: SkipRec = { during: false, at: 0, sync: false, stopped: 0 };
    w.__skipRec = r;
    const mine = (e: Event) => w.__skipRec === r && (e.type === 'keydown' ? (e as KeyboardEvent).key === 'Escape' : !!(e.target as Element | null)?.closest?.('.vc-play'));
    const before = (e: Event) => {
      if (r.at || !mine(e)) return;
      r.at = performance.now();
      r.during = w.__cuesight.view3d!.isPlaying();
    };
    const after = (e: Event) => {
      if (!r.at || r.stopped || !mine(e)) return;
      const check = () => (w.__cuesight.view3d!.isPlaying() ? setTimeout(check, 5) : (r.stopped = performance.now()));
      r.sync = !w.__cuesight.view3d!.isPlaying();
      if (r.sync) r.stopped = performance.now();
      else setTimeout(check, 5);
    };
    for (const type of ['click', 'keydown']) {
      window.addEventListener(type, before, true);
      window.addEventListener(type, after, false);
    }
  });
}
const skipRecord = (page: Page) => page.evaluate(() => (window as unknown as { __skipRec: SkipRec }).__skipRec);

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
    // Software rendering under load: every wait below gets 15 s (a camera transition is several frames).
    test.setTimeout(120_000);
    const play = page.locator('.vc-play');
    await expect(play).toBeDisabled();
    await planB1(page);
    await expect(page.getByTestId('power')).toContainText('/10');
    // The provisional stroke is replaced by the recommended one a moment later (its label and cue-ball
    // path change): compare pictures of the final plan only.
    await expect(page.getByTestId('shot-card')).toContainText('recommended for position', { timeout: 20_000 });
    // Under CPU load the device evaluation budget is small and the recommendation can come back
    // "fragile", with a 3.6 s toast over the top of the stage: the first picture must not hold it
    // while the one taken back in Overview does not (gridDiff 5.4 in 2 of 5 iPhone SE runs).
    await recommendedPlan(page);
    await expect(page.locator('#toast')).toBeHidden({ timeout: 15_000 });
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
      await expect(btn).toHaveAttribute('aria-pressed', 'true', { timeout: 15_000 });
      await expect.poll(() => camera(page), { timeout: 15_000 }).toBe(id);
      await settled(page);
      seen[id] = await regionStats(page, box);
    }
    // Each preset frames the table differently; Overview comes back to the same picture.
    expect(gridDiff(top, seen.player!)).toBeGreaterThan(6);
    expect(gridDiff(seen.player!, seen.broadcast!)).toBeGreaterThan(6);
    expect(gridDiff(top, seen.overview!)).toBeLessThan(3);
    await expect(play).toBeEnabled({ timeout: 15_000 });
  });

  test('Play shot replays the simulated shot to the end and leaves the layout untouched', async ({ page }) => {
    test.setTimeout(120_000);
    await planB1(page);
    // Replay the final plan: the recommended stroke landing during a replay is a new plan, which stops
    // the replay first (spec edge case, tested below), so wait for it.
    await recommendedPlan(page);
    const before = await balls(page);
    const box = await tableBox(page);
    const still = await regionStats(page, box);
    // The page itself watches the replay, right after every frame the 3D view draws (replayWatch): that
    // it ran, how much of the picture changed against the still plan, and when it ended. Polling
    // screenshots from the test can miss a whole replay when the software renderer is slow.
    await replayWatch(page, box);
    await page.getByRole('button', { name: 'Play shot' }).click();
    // During the replay the picture differs from the still plan (the plan lines hide, balls roll).
    let sawPlaying = false;
    let moved = 0;
    for (const t0 = Date.now(); Date.now() - t0 < 15_000 && moved <= 0.004; ) {
      const now = await playing(page);
      if (!now && sawPlaying) break;
      sawPlaying ||= now;
      if (now) moved = Math.max(moved, changedFrac(still, await regionStats(page, box)));
    }
    // ×1 speed, capped at 4 s, plus the strike and the hold: finishes on its own.
    await expect.poll(() => playing(page), { timeout: 20_000, intervals: [250] }).toBe(false);
    const rec = await replayRecord(page);
    test.info().annotations.push({ type: 'replay', description: JSON.stringify({ polledMoved: moved, pageMoved: rec.moved, frames: rec.frames, maxFrameGapMs: Math.round(rec.maxGap), endedAfterMs: Math.round(rec.endedAfterMs) }) });
    sawPlaying ||= rec.sawPlaying;
    moved = Math.max(moved, rec.moved);
    expect(sawPlaying).toBe(true);
    expect(rec.stillFrames, 'a still frame was read in the page').toBeGreaterThan(0);
    expect(moved).toBeGreaterThan(0.004);
    // Measured in the page from the tap: the strike (0.5 s), the shot (x1, capped at 4 s) and the hold
    // (3.5 s) make at most 8 s of real time. The replay notices the shot's end and then the hold's end on
    // a frame, so each can show up to one frame late (the slowest frame of this replay, measured), plus
    // 1 s for the tap itself. Never less than the hold.
    expect(rec.endedAfterMs, 'ends on its own, in its own time').toBeLessThan(REPLAY_MAX_MS + 2 * rec.maxGap + 1_000);
    expect(rec.endedAfterMs).toBeGreaterThan(HOLD_MS);
    await expect(page.getByRole('button', { name: 'Play shot' })).toBeEnabled({ timeout: 15_000 });
    expect(await balls(page)).toEqual(before);
    await expect(page.getByTestId('cut')).toHaveText('30.0°');
    // Right after a replay ends by itself, Play ignores taps briefly (REPLAY_TAP_GUARD_MS = 350 ms)
    // so a late tap on "Skip" does not restart it.
    await page.waitForTimeout(500);
    // Skip works too, from the button and from the keyboard (Escape). `force` skips Playwright's
    // stability wait, which takes several seconds against the software-rendered (SwiftShader) canvas,
    // so the tap lands while the replay is still running.
    for (const [how, skip] of [
      ['button', () => page.locator('.vc-play').click({ force: true })],
      ['Escape', () => page.keyboard.press('Escape')],
    ] as const) {
      let sk: SkipRec | null = null;
      // Under load the replay (8 s at most) can end before the input lands; then the input was no
      // skip (a click on "Play shot" even starts a new replay): let it end, and try again at half speed.
      for (let attempt = 0; attempt < 3 && !sk?.during; attempt++) {
        if (attempt === 1 && (await page.locator('.vc-slow').getAttribute('aria-pressed')) !== 'true') await page.locator('.vc-slow').click({ force: true });
        await page.getByRole('button', { name: 'Play shot' }).click();
        await expect.poll(() => playing(page), { timeout: 15_000 }).toBe(true);
        await expect(page.locator('.vc-play')).toHaveAttribute('aria-label', 'Skip the replay', { timeout: 15_000 });
        await skipWatch(page);
        await skip();
        await expect.poll(() => playing(page), { timeout: 15_000 }).toBe(false);
        if (!(await skipRecord(page)).during) await expect.poll(() => playing(page), { timeout: 20_000 }).toBe(false);
        await expect.poll(async () => (await skipRecord(page)).stopped, { timeout: 15_000 }).toBeGreaterThan(0);
        sk = await skipRecord(page);
        test.info().annotations.push({ type: 'skip', description: `${how} #${attempt + 1}: during ${sk.during}, sync ${sk.sync}, ${Math.round(sk.stopped - sk.at)} ms` });
        if (!sk.during) await page.waitForTimeout(500);
      }
      // Measured in the page: the replay is over as soon as the app has handled the Skip input (Skip
      // is synchronous), so a Skip that did nothing fails here even when the replay later ends on its own.
      expect(sk!.during, `${how}: the skip landed during the replay`).toBe(true);
      expect(sk!.sync, `${how}: stopped by the input itself`).toBe(true);
      expect(sk!.stopped - sk!.at, `${how}: stopped within`).toBeLessThan(SKIP_MAX_MS);
      await expect(page.getByRole('button', { name: 'Play shot' })).toBeVisible({ timeout: 15_000 });
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
    // A "fragile" recommendation (small evaluation budget under CPU load) shows a toast that clears
    // itself 3.6 s later through a store update, which asks for one frame: let it go first.
    await recommendedPlan(page);
    await expect(page.locator('#toast')).toBeHidden({ timeout: 15_000 });
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
