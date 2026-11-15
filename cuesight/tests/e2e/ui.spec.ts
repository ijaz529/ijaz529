import { expect, test, type Page } from '@playwright/test';
import { fractionOf } from '../../src/core/shot/geometry';
import { planLabel } from '../../src/app/render/plan-draw';

/**
 * SC-111 / T149 (feature 002 US3): automated accessibility checks of the Midnight Felt UI.
 * - every interactive control has a hit area of at least 44 × 44 CSS px (measured with
 *   elementFromPoint, so ::after hit areas and wrapping labels count, and overlapping neighbours
 *   that steal taps do not);
 * - body-text colour tokens reach 4.5:1 against the surfaces they sit on (--text-3 is reserved for
 *   large or decorative text and needs 3:1);
 * - keyboard focus draws a visible ring;
 * - the settings dialog saves on Enter and does not save an emptied number field.
 */

const MIN = 44;
type Miss = { what: string; w: number; h: number };

/**
 * Hit area of every visible interactive control in `scope`: the horizontal and vertical extent,
 * through the control's centre, of the points whose topmost element is the control, one of its
 * descendants or one of its labels.
 */
async function smallTargets(page: Page, scope = 'body'): Promise<Miss[]> {
  return page.evaluate(
    ({ scope, MIN }) => {
      const root = document.querySelector(scope)!;
      const sel = 'button, select, input:not([type="hidden"]), textarea, summary, a[href], [role="button"], [role="slider"], [role="switch"], [tabindex]:not([tabindex="-1"])';
      const out: { what: string; w: number; h: number }[] = [];
      const vw = innerWidth;
      const vh = innerHeight;
      for (const el of Array.from(root.querySelectorAll<HTMLElement>(sel))) {
        if (el instanceof HTMLCanvasElement) continue; // the table canvases are the whole stage
        if (el.closest('[hidden], [inert], [aria-hidden="true"]')) continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none') continue;
        // A tap on a label toggles a checkbox and focuses a text field (its whole row is the target),
        // but it does not open a select or move a slider: those count on their own box only.
        const labelled = (el instanceof HTMLInputElement && !['range', 'button', 'submit', 'reset', 'image', 'color', 'file'].includes(el.type)) || el instanceof HTMLTextAreaElement;
        const labels = labelled ? Array.from((el as HTMLInputElement).labels ?? []) : [];
        const owners: Element[] = [el, ...labels];
        const owns = (x: Element | null) => !!x && owners.some((o) => o === x || o.contains(x));
        const own = el.getBoundingClientRect();
        // A visually hidden control (e.g. a switch's checkbox) is tapped through its label.
        const face = own.width * own.height < 16 && labels.length ? labels[0]! : el;
        // Bring controls in scrolling rows (the dock, the picker rows, the sheet) into view.
        face.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        const boxes = [face, ...owners].map((o) => o.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0);
        if (!boxes.length) continue;
        // Start from the centre of the control, or of its label when the control itself is visually hidden.
        let start: { x: number; y: number } | null = null;
        for (const r of boxes) {
          const c = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
          if (c.x >= 0 && c.y >= 0 && c.x < vw && c.y < vh && owns(document.elementFromPoint(c.x, c.y))) {
            start = c;
            break;
          }
        }
        const name = `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${el.className && typeof el.className === 'string' ? `.${el.className.trim().split(/\s+/).join('.')}` : ''}[${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 30)}]`;
        if (!start) {
          // Off screen or under another element: only a problem when it is on screen.
          const r = boxes[0]!;
          const onScreen = r.right > 0 && r.bottom > 0 && r.left < vw && r.top < vh;
          if (onScreen && cs.pointerEvents !== 'none') out.push({ what: `${name} (covered)`, w: 0, h: 0 });
          continue;
        }
        const extent = (dx: number, dy: number) => {
          let n = 0;
          for (let k = 1; k <= 80; k++) {
            const x = start!.x + dx * k;
            const y = start!.y + dy * k;
            if (x < 0 || y < 0 || x >= vw || y >= vh || !owns(document.elementFromPoint(x, y))) break;
            n = k;
          }
          return n;
        };
        const w = extent(-1, 0) + extent(1, 0) + 1;
        const h = extent(0, -1) + extent(0, 1) + 1;
        if (w < MIN || h < MIN) out.push({ what: name, w, h });
      }
      return out;
    },
    { scope, MIN },
  );
}

/** The settings dialog has finished sliding in (its entry animation moves it 24 px). */
async function openedDialog(page: Page) {
  await page.locator('#settings').evaluate((d) => Promise.all((d.getAnimations?.({ subtree: true }) ?? []).map((a) => a.finished)));
}

/** The bottom sheet has stopped moving (its transitions are done or were replaced, and its top is still). */
async function sheetSettled(page: Page) {
  await page.locator('.panel').evaluate(async (p) => {
    await Promise.allSettled(p.getAnimations({ subtree: true }).map((a) => a.finished));
    const frame = () => new Promise((r) => requestAnimationFrame(r));
    for (let top = NaN, i = 0; i < 120; i++) {
      await frame();
      const t = p.getBoundingClientRect().top;
      if (t === top) break;
      top = t;
    }
  });
}

async function noOnboarding(page: Page) {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('cuesight.onboarded', '1');
    } catch {
      /* ignore */
    }
  });
}

for (const viewport of [
  { width: 393, height: 852 },
  { width: 375, height: 667 },
]) {
  test.describe(`touch targets ≥ 44 px at ${viewport.width}×${viewport.height} (SC-111)`, () => {
    test.use({ viewport });

    test('Practice: toolbar, sheet, stroke controls, pickers, suggestions', async ({ page }) => {
      await noOnboarding(page);
      await page.goto('/?mode=practice');
      await expect(page.locator('#shot-card')).toContainText('Tap the ball you want to pocket');
      const misses: Miss[] = await smallTargets(page);
      // With a ball picked: the pocket picker and the stroke controls; then the suggestions list.
      await page.evaluate(() => (window as unknown as { __cuesight: { selectBall(id: string): void } }).__cuesight.selectBall('b1'));
      await page.evaluate(() => (window as unknown as { __cuesight: { selectPocket(id: string): void } }).__cuesight.selectPocket('TR'));
      await expect(page.getByTestId('cut')).toHaveText('30.0°');
      misses.push(...(await smallTargets(page)));
      await page.getByRole('button', { name: 'Suggest the best shots' }).click();
      await expect(page.locator('#suggestions button.sugg').first()).toBeVisible({ timeout: 20_000 });
      misses.push(...(await smallTargets(page)));
      await page.getByRole('button', { name: 'More tools' }).click();
      misses.push(...(await smallTargets(page, '#toolbar')));
      expect(misses).toEqual([]);
    });

    test('Snap intro', async ({ page }) => {
      await noOnboarding(page);
      await page.goto('/?mode=snap');
      await expect(page.locator('#snap-take')).toBeVisible();
      expect(await smallTargets(page)).toEqual([]);
    });

    test('Live with the camera denied', async ({ page }) => {
      await noOnboarding(page);
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'mediaDevices', {
          value: { getUserMedia: () => Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' })) },
        });
      });
      await page.goto('/?mode=camera');
      await expect(page.locator('#camera-msg')).toBeVisible();
      expect(await smallTargets(page)).toEqual([]);
    });

    test('Settings dialog', async ({ page }) => {
      await noOnboarding(page);
      await page.goto('/?mode=practice');
      await page.getByRole('button', { name: 'Settings' }).click();
      await expect(page.locator('#settings')).toBeVisible();
      await openedDialog(page);
      expect(await smallTargets(page, '#settings')).toEqual([]);
    });

    test('first run: the onboarding hint', async ({ page }) => {
      await page.goto('/?mode=practice');
      await expect(page.locator('.onboard')).toBeVisible();
      expect(await smallTargets(page, '.onboard')).toEqual([]);
    });
  });
}

type Hook = {
  state: { settings: { cushionWidthCm: number; fovDeg: number }; plan: { pocketId: string } | null };
  selectBall(id: string): void;
  selectPocket(id: string): void;
};
const hookEval = <T>(page: Page, f: (h: Hook) => T) => page.evaluate(`(${f.toString()})(window.__cuesight)`) as Promise<T>;
/** Two animation frames: a store flush has been rendered. */
const frames = (page: Page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))));

/** Practice with a planned 30° cut and the suggestions list open: most of the controls at once. */
async function practiceWithPlan(page: Page) {
  await noOnboarding(page);
  await page.goto('/?mode=practice');
  await expect(page.locator('#shot-card')).toContainText('Tap the ball you want to pocket');
  await hookEval(page, (h) => h.selectBall('b1'));
  await hookEval(page, (h) => h.selectPocket('TR'));
  await expect(page.getByTestId('cut')).toHaveText('30.0°');
  await page.getByRole('button', { name: 'Suggest the best shots' }).click();
  await expect(page.locator('#suggestions button.sugg').first()).toBeVisible({ timeout: 20_000 });
}

test.describe('settings dialog commits (Enter saves, an empty number is never saved)', () => {
  test('Enter in a field saves; Esc and Cancel do not; an emptied number field blocks Save', async ({ page }) => {
    await noOnboarding(page);
    await page.goto('/?mode=practice');
    const dlg = page.locator('#settings');
    const open = async () => {
      await page.getByRole('button', { name: 'Settings' }).click();
      await expect(dlg).toBeVisible();
      await openedDialog(page);
    };
    const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('cuesight.settings.v1') ?? '{}') as { cushionWidthCm?: number; fovDeg?: number });
    // The close event (where the app applies a Save) fires a task after the dialog hides: count it,
    // after the app's own listener, so a check never races it.
    await page.evaluate(() => {
      const w = window as unknown as { __closes: number };
      w.__closes = 0;
      document.querySelector('#settings')!.addEventListener('close', () => w.__closes++);
    });
    let closes = 0;
    const closed = async () => {
      closes++;
      await expect(dlg).toBeHidden();
      await expect.poll(() => page.evaluate(() => (window as unknown as { __closes: number }).__closes)).toBe(closes);
    };

    // Enter (or Go on a phone keyboard) in a number field submits with Save, not with the × or Cancel.
    await open();
    await dlg.locator('input[name="cushionWidthCm"]').fill('6');
    await dlg.locator('input[name="cushionWidthCm"]').press('Enter');
    await closed();
    expect(await hookEval(page, (h) => h.state.settings.cushionWidthCm)).toBe(6);
    expect((await stored()).cushionWidthCm).toBe(6);

    // Esc after that Save closes without re-applying anything typed since.
    await open();
    await dlg.locator('input[name="cushionWidthCm"]').fill('7');
    await page.keyboard.press('Escape');
    await closed();
    expect(await hookEval(page, (h) => h.state.settings.cushionWidthCm)).toBe(6);

    // An emptied field: neither Enter nor Save closes the dialog; Cancel closes it and nothing changes.
    await open();
    const fov = dlg.locator('input[name="fovDeg"]');
    await expect(fov).toHaveValue('65');
    await fov.fill('');
    await fov.press('Enter');
    await expect(dlg).toBeVisible();
    await dlg.getByRole('button', { name: 'Save' }).click();
    await expect(dlg).toBeVisible();
    expect(await fov.evaluate((e) => (e as HTMLInputElement).validity.valueMissing)).toBe(true);
    await dlg.getByRole('button', { name: 'Cancel' }).click();
    await closed();
    expect(await hookEval(page, (h) => h.state.settings.fovDeg)).toBe(65);
    expect((await stored()).fovDeg).toBe(65);

    // The × closes without saving as well.
    await open();
    await fov.fill('80');
    await dlg.getByRole('button', { name: 'Close settings' }).click();
    await closed();
    expect(await hookEval(page, (h) => h.state.settings.fovDeg)).toBe(65);
  });
});

// Release-verify residual #10: on a makeable card the headline warning is shown once (no chip
// repeating it), so that one line must stay readable: never cut off with an ellipsis.
for (const viewport of [
  { width: 393, height: 852 },
  { width: 375, height: 667 },
]) {
  test.describe(`headline warning at ${viewport.width}×${viewport.height}`, () => {
    test.use({ viewport });
    test('shown once and in full in every sheet state (peek, medium, expanded)', async ({ page }) => {
      await noOnboarding(page);
      await page.goto('/?mode=practice');
      await expect(page.locator('#shot-card')).toContainText('Tap the ball you want to pocket');
      await hookEval(page, (h) => h.selectBall('b1'));
      await hookEval(page, (h) => h.selectPocket('TR'));
      await expect(page.getByTestId('cut')).toHaveText('30.0°');
      await page.locator('#power').evaluate((r: HTMLInputElement) => {
        r.value = '2';
        r.dispatchEvent(new Event('input', { bubbles: true }));
      });
      const head = page.locator('#shot-card .head-warn');
      await expect(head).toContainText('Too soft');
      const message = (await head.textContent())!.trim();
      expect(message).toMatch(/Use power [\d.]+\+\.$/);
      const measure = () =>
        page.evaluate((message) => {
          const card = document.querySelector('#shot-card')!;
          const span = card.querySelector<HTMLElement>('.head-warn span')!;
          const box = card.querySelector('.head-warn')!.getBoundingClientRect();
          const visible = (e: Element) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden' && !e.closest('.sr-only');
          // Every visible element whose own text is the message (the headline line, a chip, …).
          const copies = Array.from(card.querySelectorAll('span, p, li')).filter((e) => visible(e) && Array.from(e.childNodes).some((n) => n.nodeType === 3 && n.textContent!.trim() === message));
          return {
            sheet: document.querySelector<HTMLElement>('.panel')!.dataset.sheet,
            text: span.textContent,
            clippedX: span.scrollWidth - span.clientWidth,
            clippedY: span.scrollHeight - span.clientHeight,
            onScreen: box.top >= 0 && box.bottom <= innerHeight,
            // The wrapped warning must not push the cut numeral out of the peek either.
            cutOnScreen: card.querySelector('[data-testid="cut"]')!.getBoundingClientRect().bottom <= innerHeight,
            copies: copies.length,
          };
        }, message);
      const seen: string[] = [];
      for (let i = 0; i < 3; i++) {
        const m = await measure();
        seen.push(m.sheet!);
        expect(m.text, m.sheet).toContain('Use power');
        expect(m.clippedX, `${m.sheet}: cut off sideways`).toBeLessThanOrEqual(0);
        expect(m.clippedY, `${m.sheet}: cut off below`).toBeLessThanOrEqual(0);
        expect(m.onScreen, `${m.sheet}: on screen`).toBe(true);
        expect(m.copies, `${m.sheet}: shown once`).toBe(1);
        if (m.sheet === 'peek') expect(m.cutOnScreen, 'peek: the cut numeral stays in view').toBe(true);
        // Tap the handle: peek → medium → expanded.
        if (i < 2) {
          const before = m.sheet;
          await page.locator('.sheet-handle').click();
          await expect.poll(() => page.evaluate(() => document.querySelector<HTMLElement>('.panel')!.dataset.sheet)).not.toBe(before);
          await sheetSettled(page);
        }
      }
      expect(seen).toEqual(['peek', 'medium', 'expanded']);
      // The longest headline warning the planner writes ("frozen", 85 characters) fits at the peek too.
      await page.locator('.sheet-handle').click();
      await expect.poll(() => page.evaluate(() => document.querySelector<HTMLElement>('.panel')!.dataset.sheet)).toBe('peek');
      await sheetSettled(page);
      const long = await page.evaluate(() => {
        const span = document.querySelector<HTMLElement>('#shot-card .head-warn span')!;
        span.textContent = 'Cue ball is frozen to the object ball: expect extra throw; hit it softly with follow.';
        const box = span.parentElement!.getBoundingClientRect();
        return { clippedX: span.scrollWidth - span.clientWidth, clippedY: span.scrollHeight - span.clientHeight, onScreen: box.top >= 0 && box.bottom <= innerHeight };
      });
      expect(long).toEqual({ clippedX: 0, clippedY: 0, onScreen: true });
    });
  });
}

/**
 * Switches the app's font stack to DejaVu Sans, the font a Linux machine without Inter (GitHub's
 * ubuntu runner) falls back to for system-ui and sans-serif: about a fifth wider than SF Pro, Inter
 * or Roboto. False (nothing changed) where DejaVu Sans is not installed.
 */
async function wideFallbackFont(page: Page): Promise<boolean> {
  const installed = await page.evaluate(() => {
    const c = document.createElement('canvas').getContext('2d')!;
    const width = (font: string) => ((c.font = font), c.measureText('mmmm iiii WWWW 0123').width);
    return width('700 20px "DejaVu Sans", monospace') !== width('700 20px monospace');
  });
  if (installed) await page.addStyleTag({ content: `:root { --font: 'DejaVu Sans', sans-serif; }` });
  return installed;
}

// CI run 43718867091: on the ubuntu runner (DejaVu Sans) the difficulty chip dropped to a row of its
// own at 375 px, and that 28 px pushed the cut numeral and the two-line spin tile out of the peek; the
// 85-character frozen warning took three lines there. A wide font must cost the peek nothing: the chip
// stays beside the title (the pocket name wraps inside the row's height instead), the warning keeps to
// two lines, and the numerals and the stroke name stay in view. Forced here, so any Linux machine
// checks it whatever its own UI font.
for (const viewport of [
  { width: 375, height: 667 },
  { width: 393, height: 852 },
]) {
  test.describe(`the peek with a wide fallback font at ${viewport.width}×${viewport.height}`, () => {
    test.use({ viewport });
    test('one headline row, the warning in two lines, the cut numeral and the stroke name in view (DejaVu Sans)', async ({ page }) => {
      await noOnboarding(page);
      await page.goto('/?mode=practice&renderer=2d');
      await expect(page.locator('#shot-card')).toContainText('Tap the ball you want to pocket');
      test.skip(!(await wideFallbackFont(page)), 'DejaVu Sans is not installed');
      const peek = () =>
        page.evaluate(() => {
          const card = document.querySelector('#shot-card')!;
          const box = (sel: string) => card.querySelector(sel)!.getBoundingClientRect();
          const span = card.querySelector<HTMLElement>('.head-warn span');
          const spin = card.querySelector<HTMLElement>('.hero-stat.spin .s')!;
          const title = box('.title');
          const chip = box('[data-testid="difficulty"]');
          const cut = box('[data-testid="cut"]');
          const s = spin.getBoundingClientRect();
          return {
            sheet: document.querySelector<HTMLElement>('.panel')!.dataset.sheet,
            font: getComputedStyle(card).fontFamily,
            // The chip beside the title, not under it; the row no taller than the chip and ball need.
            chipBeside: chip.top < title.bottom && chip.left >= title.right,
            head: Math.round(box('.shot-head').height * 10) / 10,
            warn: span ? { clippedX: span.scrollWidth - span.clientWidth, clippedY: span.scrollHeight - span.clientHeight, onScreen: box('.head-warn').top >= 0 && box('.head-warn').bottom <= innerHeight } : null,
            cutInView: cut.top >= 0 && cut.bottom <= innerHeight,
            stroke: spin.textContent!.replace(/\s+/g, ' ').trim(),
            strokeClipped: [...spin.querySelectorAll<HTMLElement>('span')].some((e) => e.scrollWidth > e.clientWidth),
            strokeInView: s.width > 4 && s.top >= 0 && s.bottom <= innerHeight,
            hero: box('.hero').height,
          };
        });

      // The headline warning at the peek (power 2: "Too soft … Use power 3.5+."), then the 85-character
      // frozen one in its place.
      await hookEval(page, (h) => h.selectBall('b1'));
      await hookEval(page, (h) => h.selectPocket('TR'));
      await expect(page.getByTestId('cut')).toHaveText('30.0°');
      await page.locator('#power').evaluate((r: HTMLInputElement) => {
        r.value = '2';
        r.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await expect(page.locator('#shot-card .head-warn')).toContainText('Use power');
      await sheetSettled(page);
      const warned = await peek();
      expect(warned.font).toContain('DejaVu Sans');
      expect(warned).toMatchObject({ sheet: 'peek', chipBeside: true, warn: { clippedX: 0, clippedY: 0, onScreen: true }, cutInView: true });
      expect(warned.head, 'the headline row keeps its height').toBeLessThanOrEqual(36.5);
      await page.evaluate(() => {
        document.querySelector<HTMLElement>('#shot-card .head-warn span')!.textContent = 'Cue ball is frozen to the object ball: expect extra throw; hit it softly with follow.';
      });
      expect(await peek(), 'the 85-character frozen warning').toMatchObject({ warn: { clippedX: 0, clippedY: 0, onScreen: true }, cutInView: true });

      // The spin tile naming a stroke with side on two lines ("Follow," / "right english").
      const stroke = (side: number) =>
        page.evaluate((side) => {
          const h = (window as unknown as { __cuesight: PlanHook & { state: { myStroke: unknown; strokeMode: string } } }).__cuesight;
          h.state.myStroke = { power: 3, side, vert: 0.3 };
          h.state.strokeMode = 'mine';
          h.selectPocket('TR');
        }, side);
      await stroke(0);
      await expect(page.locator('#shot-card .head-warn')).toHaveCount(0);
      await expect(page.locator('#shot-card .hero-stat.spin .s')).not.toContainText('english');
      await sheetSettled(page);
      const plain = await peek();
      await stroke(0.25);
      await expect(page.locator('#shot-card .hero-stat.spin .s')).toContainText('right english');
      await sheetSettled(page);
      const side = await peek();
      expect(side.stroke).toMatch(/^[A-Z][a-z-]+( shot)?, right english$/);
      expect(side, JSON.stringify(side)).toMatchObject({ sheet: 'peek', chipBeside: true, cutInView: true, strokeClipped: false, strokeInView: true });
      expect(side.head, 'the headline row keeps its height').toBeLessThanOrEqual(36.5);
      expect(side.hero, 'the hero no taller').toBeLessThanOrEqual(plain.hero + 0.5);
    });
  });
}

test.describe('re-renders keep keyboard focus', () => {
  test('a store flush keeps the focused suggestion (the same element), and picking a pocket by keyboard keeps focus on it', async ({ page }) => {
    await practiceWithPlan(page);
    const first = page.locator('#suggestions button.sugg').first();
    await first.focus();
    await first.evaluate((b) => ((window as unknown as { __focused: Element }).__focused = b));
    // The app re-renders everything on resize (and on every vision frame in Live).
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    await frames(page);
    expect(await page.evaluate(() => document.activeElement === (window as unknown as { __focused: Element }).__focused)).toBe(true);
    expect(await page.evaluate(() => document.body.contains((window as unknown as { __focused: Element }).__focused))).toBe(true);

    // Pocket buttons on the card: Enter on "BR" re-plans (the card redraws) and focus stays on BR.
    const pick = page.locator('#shot-card [data-card-act="pocket"][data-pocket="BR"]');
    await pick.focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => hookEval(page, (h) => h.state.plan?.pocketId)).toBe('BR');
    await frames(page);
    expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.pocket ?? document.activeElement?.tagName)).toBe('BR');
    await expect(page.locator('#shot-card [data-card-act="pocket"][data-pocket="BR"]')).toHaveAttribute('aria-pressed', 'true');
  });
});

// Needs Chromium's fake y4m camera (the WebKit config skips "@chromium-only").
test.describe('re-renders keep keyboard focus in Live @chromium-only', () => {
  test.use({ permissions: ['camera'] });
  test('vision frames re-render the app many times a second; the focused suggestion keeps focus', async ({ page }) => {
    await noOnboarding(page);
    await page.goto('/?mode=camera');
    await expect(page.locator('#status')).toContainText('Table locked', { timeout: 20_000 });
    await page.getByRole('button', { name: 'Freeze the detected layout' }).click();
    await page.getByRole('button', { name: 'Suggest the best shots' }).click();
    const first = page.locator('#suggestions button.sugg').first();
    await expect(first).toBeVisible({ timeout: 20_000 });
    await first.focus();
    await first.evaluate((b) => ((window as unknown as { __focused: Element }).__focused = b));
    // The camera keeps running while focus sits on the suggestion: each vision result is a store flush.
    type W = { __cuesight: { state: { vision: unknown } }; __v0: unknown; __focused: Element };
    await page.evaluate(() => ((window as unknown as W).__v0 = (window as unknown as W).__cuesight.state.vision));
    await expect.poll(() => page.evaluate(() => (window as unknown as W).__cuesight.state.vision !== (window as unknown as W).__v0), { timeout: 10_000 }).toBe(true);
    await page.waitForTimeout(1000);
    await frames(page);
    expect(await page.evaluate(() => document.activeElement === (window as unknown as W).__focused)).toBe(true);
  });
});

test.describe('accessibility (SC-111)', () => {
  test('colour tokens: body text ≥ 4.5:1 on every surface; --text-3 (large or decorative text only) and icon colours ≥ 3:1', async ({ page }) => {
    await noOnboarding(page);
    await page.goto('/?mode=practice');
    const r = await page.evaluate(() => {
      const probe = document.createElement('i');
      document.body.appendChild(probe);
      const rgba = (token: string): number[] => {
        probe.style.color = `var(${token})`;
        const m = getComputedStyle(probe).color.match(/[\d.]+/g)!.map(Number);
        return [m[0]!, m[1]!, m[2]!, m[3] ?? 1];
      };
      const over = (fg: number[], bg: number[]) => [0, 1, 2].map((i) => fg[i]! * fg[3]! + bg[i]! * (1 - fg[3]!)).concat(1);
      const lum = (c: number[]) => {
        const [r, g, b] = c.slice(0, 3).map((v) => {
          const s = v / 255;
          return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
      };
      const ratio = (a: number[], b: number[]) => {
        const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
        return (x! + 0.05) / (y! + 0.05);
      };
      const bg = rgba('--bg');
      const solid = rgba('--surface-solid');
      const surfaces: Record<string, number[]> = {
        '--bg': bg,
        '--bg-2': rgba('--bg-2'),
        '--surface-solid': solid,
        '--surface (glass) over --bg': over(rgba('--surface'), bg),
        '--surface-2 over --surface-solid': over(rgba('--surface-2'), solid),
        '--surface-3 over --surface-solid': over(rgba('--surface-3'), solid),
      };
      // Tokens used as text colours (styles.css `color:`); --ok and --danger colour icons and marks,
      // which need 3:1 (WCAG 1.4.11), as does --text-3 (large or decorative text only).
      const body = ['--text', '--text-2', '--accent', '--gold', '--warn'];
      const large = ['--text-3', '--ok', '--danger'];
      const out: { pair: string; ratio: number; need: number }[] = [];
      for (const [name, s] of Object.entries(surfaces)) {
        for (const t of body) out.push({ pair: `${t} on ${name}`, ratio: ratio(over(rgba(t), s), s), need: 4.5 });
        for (const t of large) out.push({ pair: `${t} on ${name}`, ratio: ratio(over(rgba(t), s), s), need: 3 });
      }
      out.push({ pair: '--on-accent on --accent', ratio: ratio(rgba('--on-accent'), rgba('--accent')), need: 4.5 });
      probe.remove();
      return out;
    });
    expect(r.length).toBeGreaterThan(40);
    expect(r.filter((x) => !(x.ratio >= x.need)).map((x) => `${x.pair}: ${x.ratio.toFixed(2)} < ${x.need}`)).toEqual([]);
  });

  test('--text-3, --ok and --danger (below 4.5:1 on some surfaces) colour only large, decorative or disabled text', async ({ page }) => {
    const misuse = () =>
      page.evaluate(() => {
        const probe = document.createElement('i');
        document.body.appendChild(probe);
        const colourOf = (t: string) => {
          probe.style.color = `var(${t})`;
          return getComputedStyle(probe).color;
        };
        const limited = new Map(['--text-3', '--ok', '--danger'].map((t) => [colourOf(t), t]));
        probe.remove();
        const out: string[] = [];
        for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
          const text = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent!.trim());
          if (!text || el.closest('[aria-hidden="true"], [hidden], :disabled')) continue;
          const cs = getComputedStyle(el);
          const token = limited.get(cs.color);
          if (!token || cs.display === 'none' || cs.visibility === 'hidden' || !el.getClientRects().length) continue;
          const px = parseFloat(cs.fontSize);
          const large = px >= 24 || (px >= 18.66 && Number(cs.fontWeight) >= 700);
          if (!large) out.push(`${token}: <${el.tagName.toLowerCase()} class="${el.className}"> ${el.textContent!.trim().slice(0, 30)} (${px}px)`);
        }
        return out;
      });
    await practiceWithPlan(page);
    const found = await misuse();
    await page.getByRole('button', { name: 'Settings' }).click();
    await openedDialog(page);
    found.push(...(await misuse()));
    await page.keyboard.press('Escape');
    await hookEval(page, (h) => (h as unknown as { setMode(m: string): void }).setMode('snap'));
    await expect(page.locator('#snap-take')).toBeVisible();
    found.push(...(await misuse()));
    expect(found).toEqual([]);
  });

  // Chromium only: WebKit's Tab skips buttons unless the system's Full Keyboard Access is on.
  test('keyboard focus always shows a visible focus ring @chromium-only', async ({ page }) => {
    let seen = 0;
    const ringless = async (stops: number) => {
      const out: string[] = [];
      for (let i = 0; i < stops; i++) {
        await page.keyboard.press('Tab');
        const miss = await page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          if (!el || el === document.body) return 'body';
          // Where the ring is drawn: a visually hidden switch shows it on its track, the drill select on its wrapper.
          const host = (el.matches('.set-row.toggle input') ? el.nextElementSibling : el.matches('.drill select') ? el.closest('.drill') : el) as HTMLElement;
          const cs = getComputedStyle(host);
          const outline = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2 && !/rgba\(.*, 0\)$|transparent/.test(cs.outlineColor);
          const shadow = cs.boxShadow !== 'none' && /inset|0px 0px 0px [2-9]/.test(cs.boxShadow);
          if (outline || shadow) return null;
          return `<${el.tagName.toLowerCase()} class="${el.getAttribute('class') ?? ''}" aria-label="${el.getAttribute('aria-label') ?? ''}"> ${(el.textContent ?? '').trim().slice(0, 24)}`;
        });
        if (miss !== 'body') seen++;
        if (miss && miss !== 'body') out.push(miss);
      }
      return out;
    };
    await practiceWithPlan(page);
    const misses = await ringless(45);
    await page.getByRole('button', { name: 'Settings' }).click();
    await openedDialog(page);
    misses.push(...(await ringless(12)));
    expect(seen, 'Tab reached the controls').toBeGreaterThan(40);
    expect([...new Set(misses)]).toEqual([]);
  });

  test('every slider exposes its value (aria-valuenow within aria-valuemin…max)', async ({ page }) => {
    await practiceWithPlan(page);
    const sliders = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[role="slider"]')).map((s) => ({
        label: s.getAttribute('aria-label'),
        now: Number(s.getAttribute('aria-valuenow')),
        min: Number(s.getAttribute('aria-valuemin')),
        max: Number(s.getAttribute('aria-valuemax')),
        hasNow: s.hasAttribute('aria-valuenow'),
      })),
    );
    expect(sliders.length).toBeGreaterThan(0);
    for (const s of sliders) {
      expect(s.hasNow, `${s.label} has aria-valuenow`).toBe(true);
      expect(s.now).toBeGreaterThanOrEqual(s.min);
      expect(s.now).toBeLessThanOrEqual(s.max);
    }
  });
});

/**
 * Package plan-ui (wave 2b): the plan's words fit where they are drawn at 375 and 393 px — the
 * eighth-fraction labels ("⅜+ ball"), the frozen cue ball's tile ("Frozen · stroke left"), the long
 * frozen power advice in the headline (two lines at the peek, all of it in the medium sheet), and
 * every table label the 2D table and the camera overlay can draw.
 */
type V2 = { x: number; y: number };
type PlanHook = {
  state: { practice: { balls: { id: string; kind: string; pos: V2; label?: string; color?: string }[] }; table: { ballRadius: number; pockets: { id: string; mouthCenter: V2 }[] } };
  selectBall(id: string): void;
  selectPocket(id: string): void;
};
/**
 * Puts the practice table into a layout and plans b1: a 35.5° cut ("thick ⅜"), or a frozen cue ball
 * whose line of centres points into the pocket ('frozen': stroke straight through) or 3° off it
 * ('frozen-side': the stroke turned to throw it in).
 */
async function practiceShot(page: Page, kind: 'thick' | 'frozen' | 'frozen-side' | 'frozen-soft') {
  await page.evaluate((kind) => {
    const h = (window as unknown as { __cuesight: PlanHook }).__cuesight;
    const R = h.state.table.ballRadius;
    let cue: V2;
    let ob: V2;
    let pocket = 'TR';
    if (kind === 'frozen-soft') {
      // A frozen cue ball whose follow stroke no power pots with pace (the core's "no power" advice).
      ob = { x: -0.25, y: -0.485 };
      cue = { x: -0.2960660046526003, y: -0.4506717941723339 };
      pocket = 'BM';
    } else {
      ob = { x: 0.55, y: 0.18 };
      const m = h.state.table.pockets.find((p) => p.id === 'TR')!.mouthCenter;
      const L = Math.hypot(m.x - ob.x, m.y - ob.y);
      const u = { x: (m.x - ob.x) / L, y: (m.y - ob.y) / L };
      if (kind === 'frozen') cue = { x: ob.x - u.x * (2 * R + 0.0003), y: ob.y - u.y * (2 * R + 0.0003) };
      else if (kind === 'frozen-side') {
        const a = Math.atan2(u.y, u.x) + (3 * Math.PI) / 180;
        cue = { x: ob.x - Math.cos(a) * (2 * R + 0.0003), y: ob.y - Math.sin(a) * (2 * R + 0.0003) };
      } else {
        const a = Math.atan2(u.y, u.x) + (35.5 * Math.PI) / 180;
        cue = { x: ob.x - 2 * R * u.x - Math.cos(a) * 0.9, y: ob.y - 2 * R * u.y - Math.sin(a) * 0.9 };
      }
    }
    h.state.practice.balls = [
      { id: 'cue', kind: 'cue', pos: cue, label: 'cue' },
      { id: 'b1', kind: 'object', pos: ob, label: '1', color: '#e8b90f' },
    ];
    h.selectBall('b1');
    h.selectPocket(pocket);
  }, kind);
}
/** The hero cut tile: its caption, value and line, and whether the line is cut off (ellipsis). */
const cutTile = (page: Page) =>
  page.evaluate(() => {
    const t = document.querySelector('#shot-card .hero-stat.cut')!;
    const line = t.querySelector<HTMLElement>('.s .t')!;
    const v = t.querySelector('[data-testid="cut"]')!.getBoundingClientRect();
    return { k: t.querySelector('.k')!.textContent, t: line.textContent, clipped: line.scrollWidth - line.clientWidth, vOnScreen: v.bottom <= innerHeight && v.top >= 0 };
  });

for (const viewport of [
  { width: 393, height: 852 },
  { width: 375, height: 667 },
]) {
  test.describe(`plan words fit at ${viewport.width}×${viewport.height} (eighths, frozen cue ball)`, () => {
    test.use({ viewport });

    test('every table label fits beside the ghost ball; the card tile reads "⅜+ ball" in full', async ({ page }) => {
      await noOnboarding(page);
      await page.goto('/?mode=practice&renderer=2d');
      await expect(page.locator('#shot-card')).toContainText('Tap the ball you want to pocket');
      // Every label the 2D table and the overlay can draw, in their two fonts (12 px, 600 and 700).
      const cue = { x: 0, y: 0 };
      const base = { makeable: true, warnings: [], aimDir: { x: 1, y: 0 }, contactPoint: { x: 1, y: 0 }, cutAngleDeg: 0, fractionLabel: 'full', fractionPhrase: 'full-ball' };
      const labels = new Set<string>(['Not makeable', 'Cue stops', 'Cue stick', 'Frozen · straight through']);
      for (let c = 0; c < 90; c += 0.25) {
        const f = fractionOf((c * Math.PI) / 180);
        labels.add(planLabel({ ...base, cutAngleDeg: c, fractionLabel: f.label, fractionPhrase: f.phrase }, cue));
      }
      for (let d = 1; d <= 60; d++)
        for (const side of [1, -1]) {
          const a = (d * Math.PI) / 180;
          labels.add(planLabel({ ...base, warnings: [{ code: 'frozen', message: '' }], aimDir: { x: Math.cos(a), y: side * Math.sin(a) } }, cue));
        }
      expect([...labels].some((l) => l.includes('⅜+ ball'))).toBe(true);
      expect([...labels].some((l) => /thick|thin ⅛/.test(l))).toBe(false);
      const widest = await page.evaluate((list) => {
        const c = document.createElement('canvas').getContext('2d')!;
        let w = 0;
        for (const font of [`700 12px -apple-system, 'SF Pro Text', system-ui, sans-serif`, `600 12px -apple-system, 'SF Pro Text', system-ui, sans-serif`]) {
          c.font = font;
          for (const t of list) w = Math.max(w, c.measureText(t).width);
        }
        return w;
      }, [...labels]);
      // With the overlay's pill padding (8 px a side), a label takes under half the screen width.
      expect(widest + 16).toBeLessThan(viewport.width / 2);

      await practiceShot(page, 'thick');
      await expect(page.locator('#shot-card .hero-stat.cut .s .t')).toHaveText('⅜+ ball');
      const t = await cutTile(page);
      expect(t).toMatchObject({ k: 'Cut', t: '⅜+ ball', clipped: 0 });
    });

    // Final walkthrough (fix2c): the one-line spin tile read "Follow, right en…" at 375 and 393 px.
    test('the spin tile names a stroke with side in full at the peek: nothing cut off, the hero no taller', async ({ page }) => {
      await noOnboarding(page);
      await page.goto('/?mode=practice&renderer=2d');
      await expect(page.locator('#shot-card')).toContainText('Tap the ball you want to pocket');
      const stroke = (side: number) =>
        page.evaluate((side) => {
          const h = (window as unknown as { __cuesight: PlanHook & { state: { myStroke: unknown; strokeMode: string } } }).__cuesight;
          h.selectBall('b1');
          h.state.myStroke = { power: 3, side, vert: 0.3 };
          h.state.strokeMode = 'mine';
          h.selectPocket('TR');
        }, side);
      const tile = () =>
        page.evaluate(() => {
          const card = document.querySelector('#shot-card')!;
          const s = card.querySelector<HTMLElement>('.hero-stat.spin .s')!;
          const r = s.getBoundingClientRect();
          return {
            text: s.textContent!.replace(/\s+/g, ' ').trim(),
            clipped: [...s.querySelectorAll<HTMLElement>('span')].map((e) => e.scrollWidth - e.clientWidth),
            inView: r.width > 4 && r.bottom <= innerHeight && r.top >= 0,
            hero: card.querySelector('.hero')!.getBoundingClientRect().height,
            warn: !!card.querySelector('.head-warn'),
            sheet: document.querySelector<HTMLElement>('.panel')!.dataset.sheet,
          };
        });
      await stroke(0);
      await expect(page.locator('#shot-card .hero-stat.spin .s')).not.toContainText('english');
      await sheetSettled(page);
      const plain = await tile();
      await stroke(0.25);
      await expect(page.locator('#shot-card .hero-stat.spin .s')).toContainText('right english');
      await sheetSettled(page);
      const side = await tile();
      expect(side.sheet).toBe('peek');
      expect(side.warn).toBe(false);
      expect(side.text).toMatch(/^[A-Z][a-z-]+( shot)?, right english$/);
      expect(side.clipped.every((c) => c <= 0), JSON.stringify(side)).toBe(true);
      expect(side.inView).toBe(true);
      expect(side.hero).toBeLessThanOrEqual(plain.hero + 0.5);
    });

    // Final walkthrough (fix2c): a frozen ball 4° off at power 6 showed a green "easy · ±0.5 mm" next
    // to "no stroke angle throws the object ball … the best still misses".
    test('frozen: the difficulty chip gives the stroke-angle margin, and none (±0°) when no angle throws it in', async ({ page }) => {
      await noOnboarding(page);
      await page.goto('/?mode=practice&renderer=2d');
      await expect(page.locator('#shot-card')).toContainText('Tap the ball you want to pocket');
      await practiceShot(page, 'frozen-side');
      await expect(page.getByTestId('difficulty')).toHaveText(/^(easy|medium|hard|very hard) · ±\d+(\.\d)?°$/);
      await page.evaluate(() => {
        const h = (window as unknown as { __cuesight: PlanHook & { state: { myStroke: unknown; strokeMode: string; table: { ballRadius: number; pockets: { id: string; mouthCenter: V2 }[] } } } }).__cuesight;
        const R = h.state.table.ballRadius;
        const ob = { x: 0.55, y: 0.18 };
        const m = h.state.table.pockets.find((p) => p.id === 'BL')!.mouthCenter;
        const a = Math.atan2(m.y - ob.y, m.x - ob.x) - (4 * Math.PI) / 180;
        h.state.practice.balls = [
          { id: 'cue', kind: 'cue', pos: { x: ob.x - Math.cos(a) * (2 * R + 0.0003), y: ob.y - Math.sin(a) * (2 * R + 0.0003) }, label: 'cue' },
          { id: 'b1', kind: 'object', pos: ob, label: '1', color: '#e8b90f' },
        ];
        h.selectBall('b1');
        h.state.myStroke = { power: 6, side: 0, vert: 0 };
        h.state.strokeMode = 'mine';
        h.selectPocket('BL');
      });
      await expect(page.locator('#shot-card')).toContainText('no stroke angle throws');
      await expect(page.getByTestId('difficulty')).toHaveText('very hard · ±0°');
      await expect(page.locator('#shot-card')).toContainText('the closest it gets');
      await expect(page.locator('#shot-card')).not.toContainText('to throw it toward the pocket');
    });

    // Verify round 1: at the peek with a headline warning the tiles' captions step aside, and a frozen
    // tile showed a bare "0°" (read as a 0° cut). "Frozen" and the stroke side must be ON SCREEN there:
    // inside the viewport, inside the cut tile and the visible sheet (the top element at their centre),
    // not merely in the markup.
    test('frozen cue ball at the peek: "Frozen" and the stroke side are visible in the cut tile, never a bare 0°', async ({ page }) => {
      await noOnboarding(page);
      await page.goto('/?mode=practice');
      await expect(page.locator('#shot-card')).toContainText('Tap the ball you want to pocket');
      for (const kind of ['frozen', 'frozen-side'] as const) {
        await practiceShot(page, kind);
        await expect(page.locator('#shot-card .hero-stat.cut.frozen')).toHaveCount(1);
        await expect(page.locator('#shot-card .head-warn')).toBeVisible();
        await sheetSettled(page);
        const v = await page.evaluate(() => {
          const card = document.querySelector('#shot-card')!;
          const tile = card.querySelector('.hero-stat.cut')!.getBoundingClientRect();
          const seen = (sel: string) => {
            const e = card.querySelector<HTMLElement>(sel)!;
            const r = e.getBoundingClientRect();
            const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            return {
              text: e.textContent,
              size: r.width > 4 && r.height > 4,
              inView: r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth,
              inTile: r.left >= tile.left - 0.5 && r.right <= tile.right + 0.5 && r.top >= tile.top - 0.5 && r.bottom <= tile.bottom + 0.5,
              onTop: !!hit && (hit === e || e.contains(hit)),
              clipped: e.scrollWidth - e.clientWidth,
            };
          };
          return { sheet: document.querySelector<HTMLElement>('.panel')!.dataset.sheet, k: seen('.hero-stat.cut .fz-k'), side: seen('.hero-stat.cut .fz-side'), cut: seen('.hero-stat.cut [data-testid="cut"]') };
        });
        expect(v.sheet).toBe('peek');
        const shown = { size: true, inView: true, inTile: true, onTop: true };
        expect(v.k, `${kind}: "Frozen"`).toMatchObject({ text: 'Frozen', ...shown });
        expect(v.side, `${kind}: the stroke side`).toMatchObject(shown);
        expect(v.cut, `${kind}: the angle`).toMatchObject(shown);
        // (The recommended stroke can turn a straight frozen shot a degree or two to throw it in.)
        expect(v.cut.text).toMatch(/^\d+°$/);
        expect(v.side.text).toMatch(v.cut.text === '0°' ? /^straight$/ : /^stroke (left|right)$/);
        if (kind === 'frozen-side') expect(v.cut.text).not.toBe('0°');
      }
    });

    test('frozen cue ball: the tile says "Frozen", the long power advice fits two lines at the peek and shows in full above it', async ({ page }) => {
      test.setTimeout(120_000);
      await noOnboarding(page);
      await page.goto('/?mode=practice');
      await expect(page.locator('#shot-card')).toContainText('Tap the ball you want to pocket');
      await practiceShot(page, 'frozen');
      await expect(page.locator('#shot-card .hero-stat.cut .k')).toHaveText('Frozen');
      const t = await cutTile(page);
      expect(t).toMatchObject({ k: 'Frozen', t: 'straight', clipped: 0 });
      await expect(page.locator('#shot-card .hero-stat.cut')).not.toContainText(/full/);
      await expect(page.locator('#shot-card .head-warn')).toContainText('Frozen:');

      // The longest headline the planner now writes: the frozen "no power" advice (≈170 characters).
      await practiceShot(page, 'frozen-soft');
      await page.locator('#power').evaluate((r: HTMLInputElement) => {
        r.value = '1';
        r.dispatchEvent(new Event('input', { bubbles: true }));
        r.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-p="follow"]')!.click());
      // The main-thread plan skips the frozen power advice; the planner worker's full plan replaces it
      // (main.ts replan / planner-client 'plan'). Under SwiftShader load that takes seconds, not 120 ms
      // plus a few: measured, the request left 0.1–2.3 s after the input and the worker answered in
      // 0.1–3.0 s (4.3–7.4 s from the tap to the advice at load 4–10; over 10 s in a full run at load 13).
      // So wait for the full plan of this very stroke first, then read its words.
      await page.waitForFunction(
        () => {
          const p = (window as unknown as { __cuesight: { state: { plan: { adviceSkipped?: boolean; stroke: { power: number; vert: number } } | null } } }).__cuesight.state.plan;
          return !!p && !p.adviceSkipped && p.stroke.power === 1 && p.stroke.vert > 0;
        },
        undefined,
        { timeout: 45_000 },
      );
      const head = page.locator('#shot-card .head-warn span');
      await expect(head).toContainText('no power with this follow gets it in with pace', { timeout: 10_000 });
      await expect(page.locator('#shot-card .power-meter')).toHaveAttribute('aria-label', /No power gets it in with pace/);
      await expect(page.locator('#shot-card .power-meter')).not.toHaveAttribute('aria-label', /more than full power/);
      await sheetSettled(page);
      const at = () =>
        page.evaluate(() => {
          const span = document.querySelector<HTMLElement>('#shot-card .head-warn span')!;
          const lh = parseFloat(getComputedStyle(span).lineHeight);
          const v = document.querySelector('#shot-card [data-testid="cut"]')!.getBoundingClientRect();
          return { sheet: document.querySelector<HTMLElement>('.panel')!.dataset.sheet, lines: Math.round(span.clientHeight / lh), clippedX: span.scrollWidth - span.clientWidth, clippedY: span.scrollHeight - span.clientHeight, cutOnScreen: v.bottom <= innerHeight };
        });
      const peek = await at();
      expect(peek.sheet).toBe('peek');
      expect(peek.clippedX).toBeLessThanOrEqual(0);
      expect(peek.lines, 'two lines at the peek').toBeLessThanOrEqual(2);
      expect(peek.cutOnScreen, 'peek: the hero stays in view').toBe(true);
      await page.locator('.sheet-handle').click();
      await expect.poll(() => page.evaluate(() => document.querySelector<HTMLElement>('.panel')!.dataset.sheet)).toBe('medium');
      await sheetSettled(page);
      const medium = await at();
      expect(medium.clippedY, 'medium: the whole advice').toBeLessThanOrEqual(0);
      expect(medium.clippedX).toBeLessThanOrEqual(0);
    });
  });
}

/**
 * Verify round 1: the power slider's replan is coalesced (controls.ts perFrame). A value waiting to be
 * sent must never be overwritten by a render of the older power (the thumb jumped back a frame when
 * the range was not focused, as on a touch drag).
 */
test.describe('power slider coalescing', () => {
  test('a dragged value is not overwritten by a render already queued for that frame', async ({ page }) => {
    await noOnboarding(page);
    await page.goto('/?mode=practice&renderer=2d');
    await expect(page.locator('#shot-card')).toContainText('Tap the ball you want to pocket');
    await hookEval(page, (h) => h.selectBall('b1'));
    await hookEval(page, (h) => h.selectPocket('TR'));
    await expect(page.getByTestId('cut')).toHaveText('30.0°');
    for (const to of ['8', '3', '6.5']) {
      const seen = await page.locator('#power').evaluate(async (r: HTMLInputElement, to: string) => {
        r.blur();
        // A store update before the input: its render runs on the next frame, with the older power.
        window.dispatchEvent(new Event('resize'));
        r.value = to;
        r.dispatchEvent(new Event('input', { bubbles: true }));
        const vals: string[] = [];
        for (let i = 0; i < 3; i++) {
          await new Promise((f) => requestAnimationFrame(f));
          vals.push(r.value);
        }
        return vals;
      }, to);
      expect(seen, `slider at ${to}`).toEqual([to, to, to]);
      await expect(page.getByTestId('power')).toContainText(to);
    }
  });
});
