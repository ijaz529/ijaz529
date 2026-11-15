import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

/**
 * Wave 2b integration: the places where the plan-ui package (card, meter, labels, Snap guide) meets
 * the live-snap package (main.ts, the Snap controller, the planner worker). Each test fails if one
 * side's helper is written but the other side does not call it:
 *
 * - the Snap photo labels a plan with no ghost ball at its anchor in canvas px (snap/draw.ts reads
 *   PlayerGuide.aimLabel through aimLabelAnchor), clear of the strike label; the HUD meter words the
 *   plan as the card's meter does (meterMinPower / meterOptions) and the HUD aim line gives the same
 *   stroke angle and side as the photo label;
 * - the card title chip letters a vision-named ball as the Suggestions list and the 3D tags do
 *   (CardContext.snooker from main.ts);
 * - a fragile, cut-short recommendation with no risk data shows the card's honesty notes
 *   (main.ts stores the reply's fields, recommendationContext reads them);
 * - the 3D label of a snooker ball touching the cue ball gives the push-stroke reason (main.ts
 *   labelContentOf → planLabelContent).
 */
const dir = fileURLToPath(new URL('../fixtures/', import.meta.url));
type V2 = { x: number; y: number };
// The app's test hook (window.__cuesight) and its state, read loosely: only the fields used here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const step = (page: Page) => page.evaluate(() => (window as Any).__cuesight.state.snap.step as string);

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('cuesight.onboarded', '1'));
});

test('Snap photo: a frozen plan is labelled at its anchor on the canvas; HUD meter and aim line agree with the card and the label', async ({ page }) => {
  test.setTimeout(150_000);
  // Record every text drawn on the photo canvas, with the transform it was drawn under.
  await page.addInitScript(() => {
    const w = window as Any;
    w.__texts = [];
    const orig = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (this: CanvasRenderingContext2D, t: string, x: number, y: number, mw?: number) {
      if ((this.canvas as HTMLCanvasElement).id === 'snap-canvas') {
        const m = this.getTransform();
        w.__texts.push({ t: String(t), x, y, w: this.measureText(String(t)).width, a: m.a, d: m.d, e: m.e, f: m.f });
      }
      return mw === undefined ? orig.call(this, t, x, y) : orig.call(this, t, x, y, mw);
    };
  });
  await page.goto('/?mode=snap');
  await page.setInputFiles('#snap-file-table', `${dir}snap-overview.png`);
  await page.waitForFunction(() => ['review', 'overview-error'].includes((window as Any).__cuesight.state.snap.step), undefined, { timeout: 45_000 });
  expect(await step(page)).toBe('review');
  // Ball 1 → top right, as the main Snap test, then the player photo: the guide step.
  const gt1 = (JSON.parse(readFileSync(`${dir}snap-layout.json`, 'utf8')) as { balls: { id: string; pos: V2 }[] }).balls.find((b) => b.id === '1')!.pos;
  const oneId = await page.evaluate((p) => {
    const h = (window as Any).__cuesight;
    const b = h.state.snap.layout.reduce((a: Any, c: Any) => (Math.hypot(c.pos.x - p.x, c.pos.y - p.y) < Math.hypot(a.pos.x - p.x, a.pos.y - p.y) ? c : a));
    h.selectBall(b.id);
    return b.id as string;
  }, gt1);
  await page.waitForFunction((id) => (window as Any).__cuesight.state.targetId === id, oneId);
  await page.evaluate(() => (window as Any).__cuesight.selectPocket('TR'));
  await page.waitForFunction(() => !!(window as Any).__cuesight.state.plan);
  await page.setInputFiles('#snap-file-player', `${dir}snap-player.png`);
  await page.waitForFunction(() => ['guide', 'manual-taps'].includes((window as Any).__cuesight.state.snap.step), undefined, { timeout: 45_000 });
  // Freeze the cue ball to ball 1 (2R + 0.3 mm behind it, `off` degrees off the line to the pocket),
  // play the player's own soft draw stroke and replan: the guide is rebuilt on the same photo pose.
  for (const off of [8, 0]) {
    await page.evaluate(() => ((window as Any).__texts = []));
    await page.evaluate((offDeg) => {
      const h = (window as Any).__cuesight;
      const t = h.state.table;
      const layout = h.state.snap.layout.map((b: Any) => ({ ...b }));
      const cue = layout.find((b: Any) => b.kind === 'cue');
      const ob = layout.find((b: Any) => b.id === h.state.targetId);
      const pk = t.pockets.find((p: Any) => p.id === 'TR');
      const a = Math.atan2(pk.mouthCenter.y - ob.pos.y, pk.mouthCenter.x - ob.pos.x) + (offDeg * Math.PI) / 180;
      const d = 2 * t.ballRadius + 0.0003;
      cue.pos = { x: ob.pos.x - d * Math.cos(a), y: ob.pos.y - d * Math.sin(a) };
      const rest = layout.filter((b: Any) => b !== cue && b !== ob && Math.hypot(b.pos.x - cue.pos.x, b.pos.y - cue.pos.y) > 0.12);
      h.state.snap = { ...h.state.snap, layout: [cue, ob, ...rest] };
      h.state.strokeMode = 'mine';
      h.state.myStroke = { power: 1, side: 0, vert: -0.4 };
      h.selectPocket('TR');
    }, off);
    // The full plan (the worker's power advice included), not the quick one.
    await page.waitForFunction(() => {
      const p = (window as Any).__cuesight.state.plan;
      return !!p && !p.adviceSkipped && p.warnings.some((w: Any) => w.code === 'frozen');
    }, undefined, { timeout: 30_000 });
    expect(await step(page)).toBe('guide');
    await page.waitForFunction(() => !!(window as Any).__cuesight.snap.guide()?.aimLabel, undefined, { timeout: 20_000 });
    // The label text is drawn at all (red before snap/draw.ts read aimLabel: nothing was drawn).
    await page
      .waitForFunction(
        () => {
          const t = (window as Any).__cuesight.snap.guide()?.aimLabel?.text;
          return !!t && ((window as Any).__texts as Any[]).some((x) => x.t === t);
        },
        undefined,
        { timeout: 10_000 },
      )
      .catch(() => undefined);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))));
    const res = await page.evaluate(() => {
      const h = (window as Any).__cuesight;
      const g = h.snap.guide();
      const a = h.snap.photoToScreen(g.aimLabel.at) as V2;
      const b = h.snap.photoToScreen({ x: g.aimLabel.at.x + 1, y: g.aimLabel.at.y }) as V2;
      const scale = Math.hypot(b.x - a.x, b.y - a.y);
      const cv = document.querySelector<HTMLCanvasElement>('#snap-canvas')!;
      const rect = cv.getBoundingClientRect();
      const dpr = cv.width / rect.width;
      // Each text's pill (snap/draw.ts label(): fillText at x0 + 9, y0 + 13, 25 px high) in page px.
      const texts = ((window as Any).__texts as Any[]).map((t) => {
        const X = (u: number) => rect.left + (t.a * u + t.e) / dpr;
        const Y = (v: number) => rect.top + (t.d * v + t.f) / dpr;
        return { t: t.t as string, pill: { left: X(t.x - 9), right: X(t.x - 9 + t.w + 18), top: Y(t.y - 13), bottom: Y(t.y + 12) } };
      });
      return {
        aimLabel: g.aimLabel as { text: string; r: number },
        ghost: g.ghost.length as number,
        anchor: { x: a.x, y: a.y, r: g.aimLabel.r * scale },
        texts,
        hud: document.querySelector('#hud-meter')?.getAttribute('aria-label') ?? null,
        card: document.querySelector('#shot-card .power-meter')?.getAttribute('aria-label') ?? null,
        hudAim: document.querySelector('#hud-aim')?.textContent ?? '',
        makeable: h.state.plan.makeable as boolean,
      };
    });
    expect(res.ghost, `off ${off}°: a frozen plan has no ghost ball`).toBe(0);
    const lab = res.texts.filter((t) => t.t === res.aimLabel.text).pop();
    expect(lab, `off ${off}°: "${res.aimLabel.text}" is drawn on the photo`).toBeTruthy();
    const pl = lab!.pill;
    const d = Math.hypot(Math.max(pl.left - res.anchor.x, 0, res.anchor.x - pl.right), Math.max(pl.top - res.anchor.y, 0, res.anchor.y - pl.bottom));
    expect(d, `off ${off}°: the label's pill is next to its anchor on the canvas`).toBeLessThanOrEqual(res.anchor.r + 20);
    const strike = res.texts.filter((t) => t.t.startsWith('Strike here')).pop();
    if (strike) {
      const b = strike.pill;
      const overlap = Math.min(pl.right, b.right) > Math.max(pl.left, b.left) && Math.min(pl.bottom, b.bottom) > Math.max(pl.top, b.top);
      expect(overlap, `off ${off}°: the aim label is clear of the strike label`).toBe(false);
    }
    if (res.makeable) {
      // One meter reader for the card and the HUD: the same words, never "more than full power" here.
      expect(res.card).not.toBeNull();
      expect(res.hud).toBe(res.card);
      expect(res.hud).not.toMatch(/more than full power/);
      // The HUD aim line and the photo label give the same stroke: the same degrees and side.
      const m = /^Frozen · (?:stroke (\d+)° (left|right)|straight through)$/.exec(res.aimLabel.text);
      expect(m, `off ${off}°: photo label "${res.aimLabel.text}"`).toBeTruthy();
      if (m![1]) expect(res.hudAim).toContain(`Frozen: stroke ${m![1]}° to the ${m![2]} of the line of centres`);
      else expect(res.hudAim).toContain('Frozen: stroke straight through the line of centres');
    }
  }
});

test('chips: a vision-named pool ball has one letter in the card title, the ball picker and Suggestions', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/?mode=practice&renderer=2d');
  await page.waitForFunction(() => !!(window as Any).__cuesight);
  await page.evaluate(() => {
    const h = (window as Any).__cuesight;
    h.state.practice.balls = [
      { id: 'cue', kind: 'cue', pos: { x: -0.5, y: -0.1 }, label: 'cue' },
      { id: 'b1', kind: 'object', pos: { x: 0.6, y: 0.3 }, label: 'red', color: '#c81e1e' },
      { id: 'b2', kind: 'object', pos: { x: 0.2, y: -0.3 }, label: 'ball' },
      { id: 'b3', kind: 'object', pos: { x: -0.9, y: 0.3 }, label: 'yellow stripe', color: '#e8b90f', stripe: true },
    ];
    h.selectBall('b1');
    h.selectPocket('TR');
  });
  await page.waitForFunction(() => !!document.querySelector('#shot-card h2.title .ball-chip'));
  // On a pool table a colour-named ball is numbered, as on the 2D table and the 3D tags: red → 3.
  expect(await page.evaluate(() => document.querySelector('#shot-card h2.title .ball-chip')?.textContent ?? null)).toBe('3');
  await page.getByRole('button', { name: /Suggest/ }).first().click();
  await page.waitForFunction(() => document.querySelectorAll('.suggest li .ball-chip').length > 0, undefined, { timeout: 30_000 });
  const chips = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.suggest li')).map((li) => ({ chip: li.querySelector('.ball-chip')?.textContent ?? '', text: (li.textContent ?? '').replace(/\s+/g, ' ').trim() })),
  );
  const stripe = chips.filter((c) => /yellow stripe/.test(c.text));
  expect(stripe.length, JSON.stringify(chips)).toBeGreaterThan(0);
  for (const c of stripe) expect(c.chip).toBe('9');
  // A ball vision could not name ('ball') gets no letter.
  for (const c of chips.filter((x) => /^\d+ ball →/.test(x.text))) expect(c.chip).toBe('');
});

test('recommendation notes: a fragile, cut-short reply with no risk data shows the three notes on the card', async ({ page }) => {
  test.setTimeout(90_000);
  // Tag every recommendation reply as fragile and cut short, with its risk list removed (not known).
  await page.addInitScript(() => {
    const d = Object.getOwnPropertyDescriptor(Worker.prototype, 'onmessage')!;
    Object.defineProperty(Worker.prototype, 'onmessage', {
      configurable: true,
      get() {
        return d.get!.call(this);
      },
      set(fn: ((ev: MessageEvent) => void) | null) {
        d.set!.call(
          this,
          fn
            ? (ev: MessageEvent) => {
                const m = ev.data as Any;
                if (m?.type === 'recommendation') {
                  const nm = { ...m, fragile: true, timedOut: true };
                  delete nm.risks;
                  fn.call(this, { data: nm } as MessageEvent);
                  return;
                }
                fn.call(this, ev);
              }
            : fn,
        );
      },
    });
  });
  await page.goto('/?mode=practice&renderer=2d');
  await page.waitForFunction(() => !!(window as Any).__cuesight);
  await page.evaluate(() => {
    const h = (window as Any).__cuesight;
    h.state.practice.balls = [
      { id: 'cue', kind: 'cue', pos: { x: -0.5, y: -0.1 }, label: 'cue' },
      { id: 'b1', kind: 'object', pos: { x: 0.6, y: 0.3 }, label: '1' },
    ];
    h.selectBall('b1');
    h.selectPocket('TR');
  });
  await page.waitForFunction(
    () => {
      const s = (window as Any).__cuesight.state;
      return !!s.recommended && !s.recommended.pending && s.plan?.strokeSource === 'recommended';
    },
    undefined,
    { timeout: 45_000 },
  );
  const rec = await page.evaluate(() => {
    const r = (window as Any).__cuesight.state.recommended;
    return { fragile: r.fragile, timedOut: r.timedOut, risksKnown: r.risks !== undefined };
  });
  expect(rec).toEqual({ fragile: true, timedOut: true, risksKnown: false });
  // One note line under the stroke (icon + text), carrying all three notes.
  const notes = page.locator('#shot-card .rec-note');
  await expect(notes).toHaveCount(1, { timeout: 10_000 });
  await expect(notes).toBeVisible();
  const text = (await notes.allTextContents()).map((t) => t.trim()).join(' | ');
  expect(text).toContain('Speed-sensitive — small changes in pace may change the result.');
  expect(text).toContain('Search cut short — the best stroke found in time.');
  expect(text).toContain('Scratch risk from small errors not checked.');
});

test('3D label: a snooker ball touching the cue ball gives the push-stroke reason', async ({ page }) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => localStorage.setItem('cuesight.settings.v1', JSON.stringify({ table: 'snooker12' })));
  await page.goto('/?mode=practice');
  await page.waitForFunction(() => !!(window as Any).__cuesight && (window as Any).__cuesight.state.table.id === 'snooker12');
  await page.evaluate(() => {
    const h = (window as Any).__cuesight;
    const t = h.state.table;
    const R = t.ballRadius;
    const pk = t.pockets.find((p: Any) => p.id === 'TR');
    const ob = { x: 0.9, y: 0.45 };
    const a = Math.atan2(pk.mouthCenter.y - ob.y, pk.mouthCenter.x - ob.x);
    const d = 2 * R + 0.0003;
    h.state.practice.balls = [
      { id: 'cue', kind: 'cue', pos: { x: ob.x - d * Math.cos(a), y: ob.y - d * Math.sin(a) }, label: 'cue' },
      { id: 'b1', kind: 'object', pos: ob, label: 'red' },
    ];
    h.selectBall('b1');
    h.selectPocket('TR');
  });
  await page.waitForFunction(() => (window as Any).__cuesight.state.plan?.makeable === false);
  const label = page.locator('.scene-label');
  await expect(label.first()).toContainText('Not makeable · touching ball', { timeout: 15_000 });
  await expect(label.first()).toContainText('Play away from it (a push is a foul)');
});
