import { expect, test, type Page } from '@playwright/test';

type V2 = { x: number; y: number };
type Hook = {
  state: {
    vision: { status: string; balls: { id: string; kind: string; pos: V2 }[] } | null;
    frozen: { layout: { balls: { id: string; kind: string }[] } } | null;
    targetId: string | null;
    cueOverrideId: string | null;
    pocketId: string | null;
    interaction: string;
    manualCorners: V2[] | null;
    cameraError: string | null;
  };
  overlayToScreen(p: V2, z?: 'ball' | 'cloth'): V2 | null;
  selectBall(id: string): void;
};
const pressTool = (page: Page, action: string) => page.evaluate((a) => document.querySelector<HTMLButtonElement>(`#toolbar [data-action="${a}"]`)!.click(), action);
const locked = (page: Page) => expect(page.locator('#status')).toContainText('Table locked', { timeout: 20_000 });

test.describe('live camera (US2) — synthetic table as the fake camera', () => {
  test.use({ permissions: ['camera'] });

  test('locks onto the table, finds the balls and draws a plan from a tap', async ({ page }) => {
    await page.goto('/?mode=camera');
    await locked(page);
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

  test('the live status region changes only with the lock state, not with every frame', async ({ page }) => {
    await page.goto('/?mode=camera');
    await locked(page);
    const seen = await page.evaluate(
      () =>
        new Promise<{ mutations: number; texts: string[] }>((res) => {
          const el = document.querySelector('#status')!;
          const texts = new Set<string>();
          let mutations = 0;
          const mo = new MutationObserver(() => {
            mutations++;
            texts.add(el.textContent ?? '');
          });
          mo.observe(el, { childList: true, characterData: true, subtree: true });
          setTimeout(() => {
            mo.disconnect();
            texts.add(el.textContent ?? '');
            res({ mutations, texts: [...texts] });
          }, 2500);
        }),
    );
    // ~25 vision results arrive in that time; the polite live region must not be rewritten for each.
    expect(seen.mutations).toBeLessThanOrEqual(2);
    for (const t of seen.texts) expect(t).not.toMatch(/\d/);
    await expect(page.locator('#status')).toHaveAttribute('role', 'status');
    // The per-frame counters still show, outside the live region and hidden from assistive tech.
    await expect(page.locator('#status-meta')).toHaveAttribute('aria-hidden', 'true');
    await expect(page.locator('#status-meta')).toContainText(/\d+ balls · \d+ ms/);
    // …and read as one line, one space after the lock state (not a flex gap, not glued on).
    const pill = await page.evaluate(() => {
      const a = document.querySelector('#status')!.getBoundingClientRect();
      const b = document.querySelector('#status-meta')!.getBoundingClientRect();
      const text = (sel: string) => document.querySelector(sel)!.textContent ?? '';
      return { gap: b.left - a.right, top: Math.abs(b.top - a.top), pill: text('#status-pill'), status: text('#status'), meta: text('#status-meta') };
    });
    expect(pill.meta).toMatch(/^· \d+ balls · \d+ ms$/);
    expect(pill.pill).toBe(`${pill.status} ${pill.meta}`);
    expect(pill.gap).toBeGreaterThan(1);
    expect(pill.gap).toBeLessThan(6);
    expect(pill.top).toBeLessThan(4);
  });

  test('Settings saved without a camera-related change keep the tracker, so the target stays on its ball', async ({ page }) => {
    await page.addInitScript(() => {
      const W = window.Worker;
      const w = window as unknown as { __configs: number };
      w.__configs = 0;
      window.Worker = class extends W {
        override postMessage(m: unknown, t?: unknown): void {
          if ((m as { type?: string })?.type === 'config') w.__configs++;
          (super.postMessage as (a: unknown, b?: unknown) => void)(m, t);
        }
      };
    });
    await page.goto('/?mode=camera');
    await locked(page);
    const before = await page.evaluate(() => (window as unknown as { __configs: number }).__configs);
    expect(before).toBeGreaterThanOrEqual(1);
    const target = await page.evaluate(() => {
      const h = (window as unknown as { __cuesight: Hook }).__cuesight;
      const b = h.state.vision!.balls.filter((x) => x.kind !== 'cue')[0]!;
      h.selectBall(b.id);
      return { id: b.id, pos: b.pos };
    });
    await page.locator('#btn-settings').click();
    await page.locator('#settings label.toggle', { hasText: 'Show physics details' }).click();
    await page.getByRole('button', { name: 'Save' }).click();
    await page.waitForTimeout(800);
    // No config was sent (each one rebuilds the tracker and restarts the ball ids)…
    expect(await page.evaluate(() => (window as unknown as { __configs: number }).__configs)).toBe(before);
    // …so the target is still the same physical ball.
    const now = await page.evaluate(() => {
      const s = (window as unknown as { __cuesight: Hook }).__cuesight.state;
      return { id: s.targetId, pos: s.vision!.balls.find((b) => b.id === s.targetId)?.pos ?? null };
    });
    expect(now.id).toBe(target.id);
    expect(Math.hypot(now.pos!.x - target.pos.x, now.pos!.y - target.pos.y)).toBeLessThan(0.03);
  });

  test('marking the cue ball on a frozen layout changes the frozen layout', async ({ page }) => {
    await page.goto('/?mode=camera');
    await locked(page);
    await page.getByRole('button', { name: 'Freeze the detected layout' }).click();
    await expect(page.locator('#status')).toContainText('Frozen layout');
    const id = await page.evaluate(() => (window as unknown as { __cuesight: Hook }).__cuesight.state.frozen!.layout.balls.find((b) => b.kind !== 'cue')!.id);
    await pressTool(page, 'mark-cue');
    await page.evaluate((i) => (window as unknown as { __cuesight: Hook }).__cuesight.selectBall(i), id);
    const cues = await page.evaluate(() => (window as unknown as { __cuesight: Hook }).__cuesight.state.frozen!.layout.balls.filter((b) => b.kind === 'cue').map((b) => b.id));
    expect(cues).toEqual([id]);
  });

  test('four corner taps that cannot be a table are refused, not "calibrated"', async ({ page }) => {
    await page.goto('/?mode=camera');
    await locked(page);
    await pressTool(page, 'calibrate');
    const box = (await page.locator('#overlay').boundingBox())!;
    // Four points on one line.
    for (let i = 0; i < 4; i++) await page.mouse.click(box.x + box.width * (0.2 + 0.2 * i), box.y + box.height * 0.5);
    await expect(page.locator('#toast')).toContainText('don’t make a table');
    await expect(page.locator('#toast')).not.toContainText('Calibrated');
    const st = await page.evaluate(() => {
      const s = (window as unknown as { __cuesight: Hook }).__cuesight.state;
      return { interaction: s.interaction, manual: s.manualCorners };
    });
    expect(st).toEqual({ interaction: 'calibrate', manual: null });
  });

  test('overlapping camera starts leave exactly one live camera (and none after leaving Live)', async ({ page }) => {
    await page.addInitScript(() => {
      const md = navigator.mediaDevices;
      const orig = md.getUserMedia.bind(md);
      const w = window as unknown as { __streams: MediaStream[] };
      w.__streams = [];
      // A slow camera start (permission prompt, cold sensor).
      md.getUserMedia = async (c) => {
        await new Promise((r) => setTimeout(r, 600));
        const s = await orig(c);
        w.__streams.push(s);
        return s;
      };
    });
    const liveTracks = () => page.evaluate(() => (window as unknown as { __streams: MediaStream[] }).__streams.flatMap((s) => s.getVideoTracks()).filter((t) => t.readyState === 'live').length);
    await page.goto('/?mode=camera');
    // Live → Practice → Live while the first start is still pending.
    await page.evaluate(() => {
      document.querySelector<HTMLButtonElement>('.mode-switch [data-mode="practice"]')!.click();
      document.querySelector<HTMLButtonElement>('.mode-switch [data-mode="camera"]')!.click();
    });
    await locked(page);
    await page.waitForTimeout(1500);
    expect(await liveTracks()).toBe(1);
    // Leave Live in the middle of a new start: nothing keeps capturing.
    await page.evaluate(() => {
      document.querySelector<HTMLButtonElement>('.mode-switch [data-mode="practice"]')!.click();
      document.querySelector<HTMLButtonElement>('.mode-switch [data-mode="camera"]')!.click();
      document.querySelector<HTMLButtonElement>('.mode-switch [data-mode="practice"]')!.click();
    });
    await page.waitForTimeout(1500);
    expect(await liveTracks()).toBe(0);
    await expect(page.locator('body')).toHaveAttribute('data-mode', 'practice');
  });

  test('a table-detection worker that cannot load is reported, not "Starting camera…" forever', async ({ page }) => {
    await page.addInitScript(() => {
      const W = window.Worker;
      window.Worker = class extends W {
        constructor(url: string | URL, opts?: WorkerOptions) {
          super(String(url).includes('vision') ? '/__missing__/vision.worker.js' : url, opts);
        }
      };
    });
    await page.goto('/?mode=camera');
    await expect(page.locator('#camera-msg')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#camera-msg')).toContainText('Table detection couldn’t start');
    // The camera itself works: the title says what is off.
    await expect(page.locator('#camera-msg h2')).toHaveText('Table detection is off');
    await expect(page.getByRole('button', { name: 'Use practice table' })).toBeVisible();
  });

  test('table detection that stops mid-session is restarted by “Try again” without keeping the old ball ids as the selection', async ({ page }) => {
    // Turns the vision worker's live results into `error` replies on demand (3 in a row = detection failed).
    await page.addInitScript(() => {
      const W = window.Worker;
      const w = window as unknown as { __breakVision: boolean; __visionWorkers: number };
      w.__breakVision = false;
      w.__visionWorkers = 0;
      window.Worker = class extends W {
        private plain = true;
        private fn: ((ev: MessageEvent) => void) | null = null;
        constructor(url: string | URL, opts?: WorkerOptions) {
          super(url, opts);
          if (!String(url).includes('vision')) return;
          this.plain = false;
          w.__visionWorkers++;
          super.addEventListener('message', (ev: MessageEvent) => {
            const m = ev.data as { v: number; type: string; id?: number };
            if (w.__breakVision && m?.type === 'result') this.fn?.({ data: { v: m.v, type: 'error', id: m.id, message: 'injected' } } as MessageEvent);
            else this.fn?.(ev);
          });
        }
        override set onmessage(f: ((ev: MessageEvent) => void) | null) {
          if (this.plain) super.onmessage = f;
          else this.fn = f;
        }
        override get onmessage(): ((ev: MessageEvent) => void) | null {
          return this.plain ? super.onmessage : this.fn;
        }
      };
    });
    const state = () =>
      page.evaluate(() => {
        const s = (window as unknown as { __cuesight: Hook }).__cuesight.state;
        return { targetId: s.targetId, cueOverrideId: s.cueOverrideId, pocketId: s.pocketId, workers: (window as unknown as { __visionWorkers: number }).__visionWorkers };
      });
    await page.goto('/?mode=camera');
    await locked(page);
    // A marked cue ball and a target, both held as ids of this tracker.
    const ids = await page.evaluate(() => {
      const h = (window as unknown as { __cuesight: Hook }).__cuesight;
      const obj = h.state.vision!.balls.filter((x) => x.kind !== 'cue');
      return { cue: obj[0]!.id, target: obj[1]!.id };
    });
    await pressTool(page, 'mark-cue');
    await page.evaluate((i) => (window as unknown as { __cuesight: Hook }).__cuesight.selectBall(i), ids.cue);
    await page.evaluate((i) => (window as unknown as { __cuesight: Hook }).__cuesight.selectBall(i), ids.target);
    expect(await state()).toMatchObject({ targetId: ids.target, cueOverrideId: ids.cue, workers: 1 });

    await page.evaluate(() => ((window as unknown as { __breakVision: boolean }).__breakVision = true));
    await expect(page.locator('#camera-msg')).toBeVisible({ timeout: 10_000 });
    // The worker did run: this is not the "couldn't load (offline?)" case.
    await expect(page.locator('#camera-msg')).toContainText('Table detection stopped working');
    await expect(page.locator('#camera-msg')).not.toContainText('offline');
    await expect(page.locator('#camera-msg h2')).toHaveText('Table detection is off');
    // The tracker that issued those ids is gone: nothing is selected by them any more.
    expect(await state()).toMatchObject({ targetId: null, cueOverrideId: null, pocketId: null });

    await page.evaluate(() => ((window as unknown as { __breakVision: boolean }).__breakVision = false));
    await page.getByRole('button', { name: 'Try again' }).click();
    await locked(page);
    await page.waitForTimeout(500); // a few results of the new tracker
    // A new worker (a new tracker, ids from b1 again): the old ids are not re-attached to whatever now carries them.
    expect(await state()).toMatchObject({ targetId: null, cueOverrideId: null, pocketId: null, workers: 2 });
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
    await page.goto('/?mode=camera');
    await expect(page.locator('#camera-msg')).toContainText('never uploaded');
    await expect(page.locator('#camera-msg h2')).toHaveText('Camera unavailable');
    await page.getByRole('button', { name: 'Use practice table' }).click();
    await expect(page.locator('body')).toHaveAttribute('data-mode', 'practice');
    await ctx.close();
  });
});

test.describe('no camera on the device (desktop, iOS Simulator)', () => {
  const noCamera = (page: Page) =>
    page.addInitScript(() => {
      const w = window as unknown as { __gum: number };
      w.__gum = 0;
      Object.defineProperty(navigator, 'mediaDevices', {
        value: {
          enumerateDevices: () => Promise.resolve([{ kind: 'audioinput', deviceId: '', groupId: '', label: '' }]),
          getUserMedia: () => {
            w.__gum++;
            return Promise.reject(Object.assign(new Error('none'), { name: 'NotFoundError' }));
          },
        },
      });
    });

  test('a touch device without a camera starts in Practice, without asking for the camera', async ({ page }) => {
    await noCamera(page);
    const ready = page.waitForEvent('console', { predicate: (m) => m.text().startsWith('[CueSight] ready') });
    await page.goto('/');
    expect((await ready).text()).toContain('mode=practice');
    await expect(page.locator('body')).toHaveAttribute('data-mode', 'practice');
    expect(await page.evaluate(() => (window as unknown as { __gum: number }).__gum)).toBe(0);
  });

  test('?mode=camera still opens Live and explains there is no camera', async ({ page }) => {
    await noCamera(page);
    await page.goto('/?mode=camera');
    await expect(page.locator('body')).toHaveAttribute('data-mode', 'camera');
    await expect(page.locator('#camera-msg')).toContainText('No camera was found');
    await expect(page.locator('#camera-msg h2')).toHaveText('Camera unavailable');
  });

  test('a touch device with a camera still starts in Live', async ({ page }) => {
    const ready = page.waitForEvent('console', { predicate: (m) => m.text().startsWith('[CueSight] ready') });
    await page.goto('/');
    expect((await ready).text()).toContain('mode=camera');
  });
});
