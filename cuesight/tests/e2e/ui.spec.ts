import { expect, test, type Page } from '@playwright/test';

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
