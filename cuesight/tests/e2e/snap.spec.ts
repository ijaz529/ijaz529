import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { regionStats, visibleBox } from './pixels';
import { jpegWithOrientation } from '../../src/app/snap/exif';

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
  snap: { photoToScreen(p: V2): V2; photos(): { overview: { width: number; height: number } | null; player: { width: number } | null }; guide(): { strike: { visible: boolean } | null; face: { c: V2; dot: V2; r: number } | null } | null };
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

/** Whether the Snap photo canvas and the table-photo thumbnail still hold any pixels (FR-122). */
const retained = (page: Page) =>
  page.evaluate(() => {
    const has = (sel: string) => {
      const c = document.querySelector<HTMLCanvasElement>(sel);
      if (!c || !c.width || !c.height) return false;
      const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      for (let i = 3; i < d.length; i += 4) if (d[i]) return true;
      return false;
    };
    return { photo: has('#snap-canvas'), thumb: has('#snap-thumb') };
  });

/** Records Snap's requests to the vision worker (type, still options, the player-view target). */
async function spyVision(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __posted: { type: string; opts?: unknown; targetId?: string; manual?: boolean }[] };
    w.__posted = [];
    const orig = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (this: Worker, m: unknown, t?: unknown) {
      const msg = m as { type?: string; opts?: unknown; input?: { targetId?: string; manualTaps?: unknown } };
      if (msg && (msg.type === 'still' || msg.type === 'player-view')) w.__posted.push({ type: msg.type, opts: msg.opts, targetId: msg.input?.targetId, manual: !!msg.input?.manualTaps });
      return (orig as (this: Worker, m: unknown, t?: unknown) => void).call(this, m, t as never);
    } as typeof orig;
  });
}
const posted = (page: Page) => page.evaluate(() => (window as unknown as { __posted: { type: string; opts?: { swapAxes?: boolean; manualCorners?: unknown; fovDeg?: number }; targetId?: string; manual?: boolean }[] }).__posted);

/**
 * Counts the recommendation requests sent to the planner worker and their replies (test instrumentation
 * only): a request is sent 180 ms after a tap (debounced), and a reply to the request before can land
 * inside that window and read as the new recommendation for a moment. The planner client restarts the
 * worker to abandon a superseded recommendation (src/app/planner-client.ts): a terminated worker's
 * requests will never be answered, so they stop counting as open.
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
 * Waits for the recommended stroke of the current target and pocket to be in the plan, with the planner
 * quiet for 0.5 s: until then the plan carries the provisional stroke (e.g. 4.5/10), which the
 * recommendation (2–4 s under load) then replaces, and the HUD with it.
 */
const recommendedPlan = (page: Page, pocket: string) =>
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
    await trackPlanner(page);
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
    // How hard: n/10 plus a speed word; where to strike: tip offset in coaching words. Read from the
    // final plan (the recommended stroke), not the provisional one shown while it is worked out.
    await recommendedPlan(page, 'TR');
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

    // Leaving Snap releases the photos (FR-122): the session, and every pixel copy on screen (the
    // photo canvas and the table-photo thumbnail).
    expect(await retained(page)).toEqual({ photo: true, thumb: true });
    await page.locator('.mode-switch [data-mode="practice"]').click();
    expect((await H(page)).step).toBe('intro');
    await expect.poll(() => retained(page)).toEqual({ photo: false, thumb: false });
    expect(await page.evaluate(() => (window as unknown as { __cuesight: Hook }).__cuesight.snap.photos())).toEqual({ overview: null, player: null });
  });

  /**
   * Final walkthrough (fix2c): "Add ball" toasted "Ball added in the middle of the table." but put the
   * ball anywhere at random, labelled with the free id number (a second "8" next to the detected black).
   */
  test('Add ball: on the free spot nearest the middle, as the toast says, with no borrowed number', async ({ page }) => {
    type B = { id: string; kind: string; pos: V2; label?: string };
    const layout = async () => (await H(page)).layout as B[];
    await tablePhoto(page);
    const R = await page.evaluate(() => (window as unknown as { __cuesight: { state: { table: { ballRadius: number } } } }).__cuesight.state.table.ballRadius);
    const before = await layout();
    // On this photo the middle of the table is clear (the 15 sits 9 cm from it).
    expect(Math.min(...before.map((b) => Math.hypot(b.pos.x, b.pos.y)))).toBeGreaterThan(3 * R);
    const add = page.getByRole('button', { name: 'Add a ball' });
    await add.click();
    await expect(page.locator('#toast')).toHaveText('Ball added in the middle of the table. Drag it to where it is.');
    const one = (await layout()).filter((b) => !before.some((x) => x.id === b.id));
    expect(one).toHaveLength(1);
    expect(one[0]!.pos).toEqual({ x: 0, y: 0 });
    expect(one[0]!).toMatchObject({ kind: 'object', label: 'ball' });
    // A second one: the middle is taken, so the free spot nearest it — clear of every ball, on the cloth.
    await add.click();
    await expect(page.locator('#toast')).toHaveText('Ball added near the middle of the table. Drag it to where it is.');
    const all = await layout();
    const two = all.filter((b) => !before.some((x) => x.id === b.id) && b.id !== one[0]!.id);
    expect(two).toHaveLength(1);
    const p = two[0]!.pos;
    expect(Math.hypot(p.x, p.y)).toBeLessThan(3.5 * R);
    for (const b of all) if (b !== two[0]) expect(Math.hypot(b.pos.x - p.x, b.pos.y - p.y), b.id).toBeGreaterThanOrEqual(3 * R - 1e-9);
    // The neutral label: no number or colour another ball carries (no tag, a grey chip).
    expect(two[0]!).toMatchObject({ kind: 'object', label: 'ball' });
  });

  test('Start over discards both photos, including the thumbnail and the drawn photo (FR-122)', async ({ page }) => {
    await tablePhoto(page);
    await pick(page, gt.balls.find((b) => b.id === '1')!.pos, 'TR');
    await page.setInputFiles('#snap-file-player', `${dir}snap-player.png`);
    await stepIs(page, ['guide', 'manual-taps']);
    expect(await retained(page)).toEqual({ photo: true, thumb: true });
    await page.getByRole('button', { name: 'Start over' }).click();
    await expect.poll(async () => (await H(page)).step).toBe('intro');
    await expect.poll(() => retained(page)).toEqual({ photo: false, thumb: false });
    expect(await page.evaluate(() => (window as unknown as { __cuesight: Hook }).__cuesight.snap.photos())).toEqual({ overview: null, player: null });
  });

  test('Snap keeps to its own detection settings, and the fit chip follows the target (item 17)', async ({ page }) => {
    await spyVision(page);
    await page.goto('/?mode=snap');
    await expect(page.getByRole('button', { name: 'Take photo' })).toBeVisible();
    // Live's "Rotate" (swap long and short rails) is on: it belongs to the live camera, not to Snap.
    await page.evaluate(() => ((window as unknown as { __cuesight: { state: { swapAxes: boolean } } }).__cuesight.state.swapAxes = true));
    await page.setInputFiles('#snap-file-table', `${dir}snap-overview.png`);
    await stepIs(page, ['review', 'overview-error']);
    const still = (await posted(page)).filter((m) => m.type === 'still');
    expect(still).toHaveLength(1);
    // The field of view in Settings is this photo's lens hint (StillOptions.fovDeg).
    const fov = await page.evaluate(() => (window as unknown as { __cuesight: { state: { settings: { fovDeg: number } } } }).__cuesight.state.settings.fovDeg);
    expect(still[0]!.opts).toMatchObject({ swapAxes: false, manualCorners: null, fovDeg: fov });
    expect((await H(page)).step).toBe('review');
    // Live's setting is left as it was.
    expect(await page.evaluate(() => (window as unknown as { __cuesight: { state: { swapAxes: boolean } } }).__cuesight.state.swapAxes)).toBe(true);

    await pick(page, gt.balls.find((b) => b.id === '1')!.pos, 'TR');
    const first = await page.evaluate(() => (window as unknown as { __cuesight: { state: { targetId: string } } }).__cuesight.state.targetId);
    await page.setInputFiles('#snap-file-player', `${dir}snap-player.png`);
    await stepIs(page, ['guide', 'manual-taps']);
    expect((await H(page)).step).toBe('guide');
    await expect(page.locator('#snap-fit')).toContainText('Fit: good');
    let fits = (await posted(page)).filter((m) => m.type === 'player-view');
    expect(fits.map((m) => m.targetId)).toEqual([first]);
    // Another pocket for the same ball: the fit (about the target ball) still holds, no new fit.
    await page.evaluate(() => (window as unknown as { __cuesight: { selectPocket(id: string): void } }).__cuesight.selectPocket('BR'));
    await page.waitForTimeout(400);
    expect((await posted(page)).filter((m) => m.type === 'player-view')).toHaveLength(1);
    // Another target ball on the same photo: the photo is fitted again for it, and the chip shows that fit.
    const other = await page.evaluate((p) => {
      const h = (window as unknown as { __cuesight: Hook }).__cuesight;
      return h.state.snap.layout!.reduce((a, c) => (Math.hypot(c.pos.x - p.x, c.pos.y - p.y) < Math.hypot(a.pos.x - p.x, a.pos.y - p.y) ? c : a)).id;
    }, gt.balls.find((b) => b.id === '2')!.pos);
    expect(other).not.toBe(first);
    await page.evaluate((id) => (window as unknown as { __cuesight: { selectBall(id: string): void } }).__cuesight.selectBall(id), other);
    await expect.poll(async () => (await posted(page)).filter((m) => m.type === 'player-view').map((m) => m.targetId)).toEqual([first, other]);
    fits = (await posted(page)).filter((m) => m.type === 'player-view');
    expect(fits[1]!.manual).toBe(false);
    await expect.poll(async () => ((await H(page)) as Snap & { player: { fitTargetId?: string } }).player.fitTargetId, { timeout: 15_000 }).toBe(other);
    expect((await H(page)).step).toBe('guide');
    await expect(page.locator('#snap-fit')).toContainText(/Fit: (good|fair|low) · \d+%/);
  });

  test('a frozen cue ball too soft: the power advice comes from the planner worker, not the main thread', async ({ page }) => {
    // Records the full-plan requests ('plan', worker-protocol v2) sent to the planner worker.
    await page.addInitScript(() => {
      const w = window as unknown as { __plans: { power: number; vert: number }[] };
      w.__plans = [];
      const orig = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (this: Worker, m: unknown, t?: unknown) {
        const msg = m as { type?: string; request?: { stroke?: { power: number; vert: number } } };
        if (msg?.type === 'plan') w.__plans.push({ power: msg.request?.stroke?.power ?? -1, vert: msg.request?.stroke?.vert ?? 0 });
        return (orig as (this: Worker, m: unknown, t?: unknown) => void).call(this, m, t as never);
      } as typeof orig;
    });
    await tablePhoto(page);
    type S = {
      snap: { layout: { id: string; kind: string; pos: V2 }[] };
      strokeMode: string;
      myStroke: { power: number; side: number; vert: number };
      plan: { pocketId: string; adviceSkipped?: boolean; warnings: { code: string; message: string }[] } | null;
    };
    // Fix the layout by hand: the cue ball frozen to an object ball (the merge-coherence chain's layout).
    const target = await page.evaluate(() => {
      const h = (window as unknown as { __cuesight: { state: S; selectBall(id: string): void } }).__cuesight;
      const layout = h.state.snap.layout.map((b) => ({ ...b }));
      const cue = layout.find((b) => b.kind === 'cue')!;
      const ob = layout.find((b) => b.kind !== 'cue')!;
      cue.pos = { x: -0.2451160266459315, y: 0.23962167347191393 };
      ob.pos = { x: -0.1891063642501831, y: 0.25098126053810116 };
      const rest = layout.filter((b) => b !== cue && b !== ob && Math.hypot(b.pos.x - ob.pos.x, b.pos.y - ob.pos.y) > 0.2);
      h.state.snap = { ...h.state.snap, layout: [cue, ob, ...rest] } as S['snap'];
      h.selectBall(ob.id);
      return ob.id;
    });
    await page.waitForFunction(() => !!(window as unknown as { __cuesight: { state: S } }).__cuesight.state.plan);
    // The player's own stroke: power 1 with draw, too soft for this frozen shot.
    await page.evaluate(() => {
      const h = (window as unknown as { __cuesight: { state: S; selectPocket(id: string): void } }).__cuesight;
      h.state.strokeMode = 'mine';
      h.state.myStroke = { power: 1, side: 0, vert: -0.4 };
      h.selectPocket(h.state.plan!.pocketId);
    });
    // The full plan arrives from the worker and replaces the quick one: a power figure (or "no power").
    await page.waitForFunction(
      () => {
        const p = (window as unknown as { __cuesight: { state: S } }).__cuesight.state.plan;
        const soft = p?.warnings.find((w) => w.code === 'too-soft');
        return !!p && !p.adviceSkipped && !!soft && /(Use power|Power) \d|no power/i.test(soft.message);
      },
      undefined,
      { timeout: 20_000 },
    );
    const plans = await page.evaluate(() => (window as unknown as { __plans: { power: number; vert: number }[] }).__plans);
    expect(plans.length).toBeGreaterThanOrEqual(1);
    expect(plans[plans.length - 1]).toEqual({ power: 1, vert: -0.4 });
    const plan = await page.evaluate(() => (window as unknown as { __cuesight: { state: S & { targetId: string } } }).__cuesight.state);
    expect(plan.targetId).toBe(target);
    expect(plan.plan!.warnings.some((w) => w.code === 'frozen')).toBe(true);
  });

  test('the player’s own frozen soft stroke: no power minimum until the advice comes, and a late recommendation keeps the full plan', async ({ page }) => {
    // Holds the planner's 'recommend' and 'plan' messages until the test lets them go, so the replies
    // come in a fixed order: the full plan first, then the recommendation the tap asked for.
    await page.addInitScript(() => {
      type Held = { worker: Worker; m: unknown };
      const w = window as unknown as { __held: Record<string, Held[]>; __sent: Record<string, number>; __release(type: string): number };
      w.__held = { recommend: [], plan: [] };
      w.__sent = { recommend: 0, plan: 0 };
      const orig = Worker.prototype.postMessage as (this: Worker, m: unknown, t?: unknown) => void;
      Worker.prototype.postMessage = function (this: Worker, m: unknown, t?: unknown) {
        const type = (m as { type?: string })?.type;
        if (type === 'recommend' || type === 'plan') {
          w.__sent[type]!++;
          w.__held[type]!.push({ worker: this, m });
          return;
        }
        return orig.call(this, m, t as never);
      } as typeof Worker.prototype.postMessage;
      w.__release = (type) => {
        const q = w.__held[type]!.splice(0);
        for (const h of q) orig.call(h.worker, h.m);
        return q.length;
      };
    });
    await tablePhoto(page);
    type P = { adviceSkipped?: boolean; noWorkingPower?: string; stroke: { power: number; side: number; vert: number }; warnings: { code: string; message: string }[] };
    type S = {
      snap: { layout: { id: string; kind: string; pos: V2 }[] };
      strokeMode: string;
      myStroke: { power: number; side: number; vert: number };
      settings: { showDetails: boolean };
      recommended: { pending: boolean; stroke: unknown } | null;
      plan: P | null;
    };
    type W = { __cuesight: { state: S; selectBall(id: string): void }; __sent: Record<string, number>; __held: Record<string, unknown[]>; __release(type: string): number; __full?: unknown };
    // The cue ball frozen to an object ball (the merge-coherence chain's layout), the ball tapped in
    // the recommended mode: a recommendation is asked for (and held).
    await page.evaluate(() => {
      const h = (window as unknown as W).__cuesight;
      const layout = h.state.snap.layout.map((b) => ({ ...b }));
      const cue = layout.find((b) => b.kind === 'cue')!;
      const ob = layout.find((b) => b.kind !== 'cue')!;
      cue.pos = { x: -0.2451160266459315, y: 0.23962167347191393 };
      ob.pos = { x: -0.1891063642501831, y: 0.25098126053810116 };
      const rest = layout.filter((b) => b !== cue && b !== ob && Math.hypot(b.pos.x - ob.pos.x, b.pos.y - ob.pos.y) > 0.2);
      h.state.snap = { ...h.state.snap, layout: [cue, ob, ...rest] } as S['snap'];
      h.state.settings = { ...h.state.settings, showDetails: true };
      h.selectBall(ob.id);
    });
    await page.waitForFunction(() => (window as unknown as W).__sent.recommend >= 1, undefined, { timeout: 10_000 });
    expect(await page.evaluate(() => (window as unknown as W).__cuesight.state.strokeMode)).toBe('recommended');
    // Before it lands, the player sets their own stroke: draw (as the spin pad would), then power 1 on
    // the slider — too soft for this frozen shot. The recommendation stays pending meanwhile.
    await page.evaluate(() => {
      const h = (window as unknown as W).__cuesight;
      h.state.myStroke = { ...h.state.myStroke, side: 0, vert: -0.4 };
      const r = document.querySelector<HTMLInputElement>('#power')!;
      r.value = '1';
      r.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // The plan on show was made without the power advice; its full plan is asked of the worker (held).
    await page.waitForFunction(() => (window as unknown as W).__sent.plan >= 1, undefined, { timeout: 10_000 });
    const meter = page.locator('#shot-card .power-meter');
    await expect(meter).toHaveAttribute('aria-label', /^Power 1 of 10/);
    const quick = await page.evaluate(() => (window as unknown as W).__cuesight.state.plan!);
    expect(quick.adviceSkipped).toBe(true);
    expect(quick.stroke).toEqual({ power: 1, side: 0, vert: -0.4 });
    expect(quick.warnings.find((w) => w.code === 'too-soft')?.message).toBe('Too soft — object ball stops short.');
    // No minimum while the advice is worked out: the advice-off one is not the power to play.
    expect(await meter.getAttribute('aria-label')).not.toMatch(/Minimum|full power/);
    const card = page.locator('#shot-card');
    await expect(card).toContainText('Too soft — object ball stops short.');
    expect(await card.textContent()).not.toMatch(/NaN|Infinity|Min power/);

    // The full plan comes: its figure is on the meter, in the warning and in the details.
    expect(await page.evaluate(() => (window as unknown as W).__release('plan'))).toBe(1);
    await page.waitForFunction(
      () => {
        const p = (window as unknown as W).__cuesight.state.plan;
        return !!p && !p.adviceSkipped && /Use power \d/.test(p.warnings.find((w) => w.code === 'too-soft')?.message ?? '');
      },
      undefined,
      { timeout: 20_000 },
    );
    await page.evaluate(() => {
      const w = window as unknown as W;
      w.__full = w.__cuesight.state.plan;
    });
    await expect(meter).toHaveAttribute('aria-label', /^Power 1 of 10, .*Minimum \d/);
    await expect(card).toContainText('Min power');
    const fullText = await page.evaluate(() => (window as unknown as W).__cuesight.state.plan!.warnings.find((w) => w.code === 'too-soft')!.message);

    // Now the recommendation lands: the player's stroke is played, so the full plan stays as it is.
    expect(await page.evaluate(() => (window as unknown as W).__release('recommend'))).toBe(1);
    await page.waitForFunction(() => !(window as unknown as W).__cuesight.state.recommended?.pending, undefined, { timeout: 30_000 });
    // Not vacuous: a stroke was recommended (the plan options would have carried it).
    expect(await page.evaluate(() => (window as unknown as W).__cuesight.state.recommended?.stroke)).toBeTruthy();
    await page.waitForTimeout(600); // well past the 120 ms plan debounce
    const after = await page.evaluate(() => {
      const w = window as unknown as W;
      return { same: w.__cuesight.state.plan === w.__full, sent: w.__sent.plan, held: w.__held.plan!.length, plan: w.__cuesight.state.plan! };
    });
    expect(after.same, 'the full plan is still the one on show').toBe(true);
    expect(after.plan.adviceSkipped).toBeUndefined();
    expect(after.plan.warnings.find((w) => w.code === 'too-soft')?.message).toBe(fullText);
    expect(after.sent, 'no second full-plan request').toBe(1);
    expect(after.held).toBe(0);
    await expect(meter).toHaveAttribute('aria-label', /Minimum \d/);
    // The plan spoken is the full one, with its figure (the figure-less one was never queued).
    await expect(page.locator('#plan-live')).toContainText(fullText, { timeout: 5_000 });
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

test.describe('Snap when table detection itself fails', () => {
  test('the vision worker crashing on the table photo ends the wait with a message; the next photo starts a new worker', async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __crashStill: boolean; __visionWorkers: number };
      w.__crashStill = true;
      w.__visionWorkers = 0;
      const W = window.Worker;
      window.Worker = class extends W {
        private vision = false;
        constructor(url: string | URL, opts?: WorkerOptions) {
          super(url, opts);
          this.vision = String(url).includes('vision');
          if (this.vision) w.__visionWorkers++;
        }
        override postMessage(m: unknown, t?: Transferable[] | StructuredSerializeOptions): void {
          if (this.vision && w.__crashStill && (m as { type?: string })?.type === 'still') {
            // The worker dies on this photo (out of memory, a crash in detection): an error event, never a reply.
            setTimeout(() => this.dispatchEvent(new ErrorEvent('error', { message: 'injected crash' })), 50);
            return;
          }
          super.postMessage(m, t as Transferable[]);
        }
      };
    });
    await page.goto('/?mode=snap');
    await expect(page.getByRole('button', { name: 'Take photo' })).toBeVisible();
    await page.setInputFiles('#snap-file-table', `${dir}snap-overview.png`);
    // Not "Finding the table and the balls…" for ever: the failure is said, with the ways on.
    await stepIs(page, ['overview-error']);
    await expect(page.locator('#snap-busy')).toBeHidden();
    // (The worker never answered before it died, so the app cannot tell this from a script that did
    // not load: it says it could not start.)
    await expect(page.locator('#snap-instr')).toContainText('Table detection couldn’t start');
    expect(await page.evaluate(() => (window as unknown as { __cuesight: { snap: { busy(): boolean } } }).__cuesight.snap.busy())).toBe(false);
    // The same photo again: a new worker reads it.
    await page.evaluate(() => ((window as unknown as { __crashStill: boolean }).__crashStill = false));
    await page.setInputFiles('#snap-file-table', `${dir}snap-overview.png`);
    await stepIs(page, ['review']);
    expect(await page.evaluate(() => (window as unknown as { __visionWorkers: number }).__visionWorkers)).toBe(2);
  });
});

/**
 * Decoding a 12–48 MP phone photo takes a while on a phone: slows every decode down by `ms` and counts
 * the decodes that have finished (`__decodes`).
 */
async function slowDecode(page: Page, ms: number) {
  await page.addInitScript((delay: number) => {
    const w = window as unknown as { __decodes: number; createImageBitmap: (...a: unknown[]) => Promise<ImageBitmap> };
    w.__decodes = 0;
    const orig = window.createImageBitmap.bind(window) as (...a: unknown[]) => Promise<ImageBitmap>;
    w.createImageBitmap = async (...a: unknown[]) => {
      try {
        const bmp = await orig(...a);
        await new Promise((r) => setTimeout(r, delay));
        return bmp;
      } finally {
        w.__decodes++;
      }
    };
  }, ms);
}
/** Waits until `n` decodes have finished, and a little longer for what follows them to run. */
async function decoded(page: Page, n: number) {
  await page.waitForFunction((k) => (window as unknown as { __decodes: number }).__decodes >= k, n, { timeout: 30_000 });
  await page.waitForTimeout(600);
}
const targetOf = (page: Page) => page.evaluate(() => (window as unknown as { __cuesight: { state: { targetId: string | null } } }).__cuesight.state.targetId);

/**
 * FR-122 with a photo still decoding (or the sample still loading) when the player leaves Snap or taps
 * Start over: the photo that arrives afterwards belongs to a session that is gone. It must be dropped,
 * not kept in memory (to come back on the next visit), and must not touch the Practice selection.
 */
test.describe('Snap photos that arrive after the session ended (FR-122)', () => {
  for (const how of ['a chosen photo', 'the sample photo'] as const) {
    test(`leaving Snap while ${how} is still decoding drops it`, async ({ page }) => {
      await slowDecode(page, 1500);
      await page.goto('/?mode=snap');
      await expect(page.getByRole('button', { name: 'Take photo' })).toBeVisible();
      if (how === 'a chosen photo') await page.setInputFiles('#snap-file-table', `${dir}snap-overview.png`);
      else await page.getByRole('button', { name: 'Try it with sample photos' }).click();
      await page.locator('.mode-switch [data-mode="practice"]').click();
      await page.evaluate(() => (window as unknown as { __cuesight: { selectBall(id: string): void } }).__cuesight.selectBall('b1'));
      expect(await targetOf(page)).toBe('b1');
      await decoded(page, 1);
      expect(await page.evaluate(() => (window as unknown as { __cuesight: Hook }).__cuesight.snap.photos())).toEqual({ overview: null, player: null });
      expect((await H(page)).step).toBe('intro');
      // The Practice selection is the player's own: the late photo does not reset it.
      expect(await targetOf(page)).toBe('b1');
      expect(await retained(page)).toEqual({ photo: false, thumb: false });
      // Back in Snap: a fresh start, nothing from before.
      await page.locator('.mode-switch [data-mode="snap"]').click();
      await expect(page.getByRole('button', { name: 'Take photo' })).toBeVisible();
      expect((await H(page)).step).toBe('intro');
      expect(await page.evaluate(() => (window as unknown as { __cuesight: Hook }).__cuesight.snap.photos())).toEqual({ overview: null, player: null });
    });
  }

  test('Start over while another table photo is still decoding drops it', async ({ page }) => {
    await slowDecode(page, 1500);
    await tablePhoto(page);
    await page.setInputFiles('#snap-file-table', `${dir}snap-overview.png`);
    await page.getByRole('button', { name: 'Start over' }).click();
    await expect.poll(async () => (await H(page)).step).toBe('intro');
    await decoded(page, 2);
    expect((await H(page)).step).toBe('intro');
    expect(await page.evaluate(() => (window as unknown as { __cuesight: Hook }).__cuesight.snap.photos())).toEqual({ overview: null, player: null });
    expect(await retained(page)).toEqual({ photo: false, thumb: false });
  });
});

/**
 * Spec edge cases "Photo orientation" and "Very large photos" (critic item 13): a portrait phone photo
 * is stored landscape with EXIF orientation 6. Older WebKit decoders ignore the tag, and some reject the
 * createImageBitmap options; the photo must be upright either way, and never decoded at full size where
 * the platform can scale while decoding.
 */
test.describe('Snap photo decoding (portrait EXIF photo, older WebKit)', () => {
  for (const variant of ['decoder ignores the orientation tag', 'createImageBitmap rejects options and ignores the tag'] as const) {
    test(`a portrait photo comes out upright at the processing size: ${variant}`, async ({ page }) => {
      await page.addInitScript((rejects: boolean) => {
        const w = window as unknown as { __bitmaps: [number, number][]; createImageBitmap: (...a: unknown[]) => Promise<ImageBitmap> };
        w.__bitmaps = [];
        const orig = window.createImageBitmap.bind(window) as (...a: unknown[]) => Promise<ImageBitmap>;
        // A decoder that does not read EXIF: the APP1 (EXIF) marker is renamed to an unknown APP15.
        const blind = async (b: Blob) => {
          const u = new Uint8Array(await b.arrayBuffer());
          if (u[0] === 0xff && u[1] === 0xd8)
            for (let i = 2; i + 4 < u.length && u[i] === 0xff; ) {
              const m = u[i + 1]!;
              if (m === 0xda) break;
              if (m === 0xe1) u[i + 1] = 0xef;
              i += 2 + ((u[i + 2]! << 8) | u[i + 3]!);
            }
          return new Blob([u], { type: b.type });
        };
        w.createImageBitmap = async (src: unknown, ...rest: unknown[]) => {
          if (rejects && rest.length && typeof rest[rest.length - 1] === 'object') throw new TypeError('ImageBitmapOptions are not supported');
          const bmp = await orig(src instanceof Blob ? await blind(src) : src, ...rest);
          w.__bitmaps.push([bmp.width, bmp.height]);
          return bmp;
        };
      }, variant.startsWith('createImageBitmap'));
      await page.goto('/?mode=snap');
      await expect(page.getByRole('button', { name: 'Take photo' })).toBeVisible();
      // A 1600×1200 landscape JPEG, grey with a red block in its top-left corner, tagged "turn 90°
      // clockwise to view": upright, it is 1200×1600 with the red block in the top-right corner.
      const b64 = await page.evaluate(async () => {
        const c = document.createElement('canvas');
        c.width = 1600;
        c.height = 1200;
        const x = c.getContext('2d')!;
        x.fillStyle = '#808080';
        x.fillRect(0, 0, 1600, 1200);
        x.fillStyle = '#ff0000';
        x.fillRect(0, 0, 400, 300);
        const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/jpeg', 0.92));
        const u = new Uint8Array(await blob.arrayBuffer());
        let s = '';
        for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]!);
        return btoa(s);
      });
      const tagged = jpegWithOrientation(new Uint8Array(Buffer.from(b64, 'base64')), 6);
      await page.setInputFiles('#snap-file-table', { name: 'portrait.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(tagged) });
      await stepIs(page, ['review', 'overview-error']);
      const shown = await page.evaluate(() => (window as unknown as { __cuesight: Hook }).__cuesight.snap.photos().overview);
      expect(shown).toEqual({ width: 720, height: 960 });
      // The photo on screen: red at the top right, grey at the top left.
      const at = (p: V2) =>
        page.evaluate((pp) => {
          const h = (window as unknown as { __cuesight: Hook }).__cuesight;
          const q = h.snap.photoToScreen(pp);
          const c = document.querySelector<HTMLCanvasElement>('#snap-canvas')!;
          const r = c.getBoundingClientRect();
          const d = c.getContext('2d')!.getImageData(Math.round(((q.x - r.left) * c.width) / r.width), Math.round(((q.y - r.top) * c.height) / r.height), 1, 1).data;
          return [d[0]!, d[1]!, d[2]!];
        }, p);
      const tr = await at({ x: 720 - 40, y: 40 });
      const tl = await at({ x: 40, y: 40 });
      expect(tr[0], `top right ${tr}`).toBeGreaterThan(170);
      expect(tr[1]).toBeLessThan(90);
      expect(Math.abs(tl[0] - tl[1]), `top left ${tl}`).toBeLessThan(40);
      // Where the platform can scale while decoding, it does: no full-size bitmap is ever made.
      if (!variant.startsWith('createImageBitmap')) {
        const sizes = await page.evaluate(() => (window as unknown as { __bitmaps: [number, number][] }).__bitmaps);
        expect(sizes.length).toBeGreaterThan(0);
        for (const [w, h] of sizes) expect(w * h, `decoded ${w}×${h}`).toBeLessThanOrEqual(960 * 720);
      }
    });
  }
});
