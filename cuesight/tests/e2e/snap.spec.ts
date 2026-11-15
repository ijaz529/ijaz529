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
const posted = (page: Page) => page.evaluate(() => (window as unknown as { __posted: { type: string; opts?: { swapAxes?: boolean; manualCorners?: unknown }; targetId?: string; manual?: boolean }[] }).__posted);

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

    // Leaving Snap releases the photos (FR-122): the session, and every pixel copy on screen (the
    // photo canvas and the table-photo thumbnail).
    expect(await retained(page)).toEqual({ photo: true, thumb: true });
    await page.locator('.mode-switch [data-mode="practice"]').click();
    expect((await H(page)).step).toBe('intro');
    await expect.poll(() => retained(page)).toEqual({ photo: false, thumb: false });
    expect(await page.evaluate(() => (window as unknown as { __cuesight: Hook }).__cuesight.snap.photos())).toEqual({ overview: null, player: null });
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
    expect(still[0]!.opts).toMatchObject({ swapAxes: false, manualCorners: null });
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
