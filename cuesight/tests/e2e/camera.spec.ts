import { expect, test, type Page } from '@playwright/test';

type V2 = { x: number; y: number };
type Hook = {
  state: {
    vision: { status: string; balls: { id: string; kind: string; pos: V2 }[] } | null;
    frozen: { layout: { balls: { id: string; kind: string }[] } } | null;
    targetId: string | null;
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
    await expect(page.getByRole('button', { name: 'Use practice table' })).toBeVisible();
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
  });

  test('a touch device with a camera still starts in Live', async ({ page }) => {
    const ready = page.waitForEvent('console', { predicate: (m) => m.text().startsWith('[CueSight] ready') });
    await page.goto('/');
    expect((await ready).text()).toContain('mode=camera');
  });
});
