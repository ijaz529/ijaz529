import type { Page } from '@playwright/test';

/** Luminance statistics and a coarse 8×8 signature of what the page actually shows inside `box`. */
export interface PixelStats {
  /** Mean luminance 0–255. */
  mean: number;
  /** Standard deviation of luminance: ~0 for a blank or single-colour canvas. */
  std: number;
  /** Fraction of pixels that read as green cloth (g clearly above r and b). */
  greenFrac: number;
  /** Distinct colours after quantising each channel to 4 bits. */
  colours: number;
  /** Mean luminances on a grid of ~4 px cells (row-major), to tell two renders of the same box apart. */
  grid: number[];
  /** For each colour asked for, the fraction of pixels within `tol` (RGB distance) of it. */
  matchFrac: number[];
}

/**
 * Screenshots `box` (page CSS px) and measures it in the page. Uses a real screenshot rather than
 * reading the WebGL canvas back, so it sees exactly what was composited (and works with
 * preserveDrawingBuffer: false).
 */
export async function regionStats(
  page: Page,
  box: { x: number; y: number; width: number; height: number },
  match: [number, number, number][] = [],
  tol = 28,
): Promise<PixelStats> {
  const png = await page.screenshot({ clip: box, animations: 'disabled' });
  return page.evaluate(async ([b64, match, tol]) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const c = document.createElement('canvas');
    c.width = bmp.width;
    c.height = bmp.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(bmp, 0, 0);
    const { data: d, width: w, height: h } = ctx.getImageData(0, 0, bmp.width, bmp.height);
    const GX = Math.max(1, Math.ceil(w / 4));
    const GY = Math.max(1, Math.ceil(h / 4));
    const sums = new Float64Array(GX * GY);
    const counts = new Float64Array(GX * GY);
    const buckets = new Set<number>();
    let n = 0;
    let s = 0;
    let s2 = 0;
    let green = 0;
    const hits = match.map(() => 0);
    for (let y = 0; y < h; y += 2) {
      for (let x = 0; x < w; x += 2) {
        const i = (y * w + x) * 4;
        const r = d[i]!;
        const g = d[i + 1]!;
        const b = d[i + 2]!;
        const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        s += L;
        s2 += L * L;
        n++;
        if (g > r + 25 && g > b + 10) green++;
        buckets.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4));
        for (let m = 0; m < match.length; m++) {
          const [mr, mg, mb] = match[m]!;
          if ((r - mr) ** 2 + (g - mg) ** 2 + (b - mb) ** 2 <= tol * tol) hits[m]!++;
        }
        const k = (y >> 2) * GX + (x >> 2);
        sums[k]! += L;
        counts[k]! += 1;
      }
    }
    const mean = s / Math.max(1, n);
    return {
      mean,
      std: Math.sqrt(Math.max(0, s2 / Math.max(1, n) - mean * mean)),
      greenFrac: green / Math.max(1, n),
      colours: buckets.size,
      grid: Array.from(sums, (v, k) => v / Math.max(1, counts[k]!)),
      matchFrac: hits.map((v) => v / Math.max(1, n)),
    };
  }, [png.toString('base64'), match, tol] as const);
}

/** Mean absolute difference between two signatures of the same box (0–255): a global change of view. */
export function gridDiff(a: PixelStats, b: PixelStats): number {
  return a.grid.reduce((acc, v, i) => acc + Math.abs(v - b.grid[i]!), 0) / a.grid.length;
}

/** Fraction of the ~4 px cells whose luminance changed by more than `thr`: a local change (a ball moved). */
export function changedFrac(a: PixelStats, b: PixelStats, thr = 20): number {
  return a.grid.reduce((acc, v, i) => acc + (Math.abs(v - b.grid[i]!) > thr ? 1 : 0), 0) / a.grid.length;
}

/** The element's on-screen box, clipped to the viewport. */
export async function visibleBox(page: Page, selector: string): Promise<{ x: number; y: number; width: number; height: number }> {
  return page.evaluate((sel) => {
    const r = document.querySelector(sel)!.getBoundingClientRect();
    const x = Math.max(0, r.left);
    const y = Math.max(0, r.top);
    return { x, y, width: Math.min(innerWidth, r.right) - x, height: Math.min(innerHeight, r.bottom) - y };
  }, selector);
}

/**
 * The on-screen box spanned by the six pockets (the playing surface) on whichever table view is
 * showing (3D or 2D), via the app's test hook, clipped to the viewport.
 */
export async function tableBox(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  return page.evaluate(() => {
    type V2 = { x: number; y: number };
    const h = (window as unknown as { __cuesight: { state: { table: { pockets: { mouthCenter: V2 }[] } }; practiceToScreen(p: V2): V2 } }).__cuesight;
    const pts = h.state.table.pockets.map((p) => h.practiceToScreen(p.mouthCenter));
    const x0 = Math.max(0, Math.min(...pts.map((p) => p.x)));
    const y0 = Math.max(0, Math.min(...pts.map((p) => p.y)));
    const x1 = Math.min(innerWidth, Math.max(...pts.map((p) => p.x)));
    const y1 = Math.min(innerHeight, Math.max(...pts.map((p) => p.y)));
    return { x: Math.round(x0), y: Math.round(y0), width: Math.round(x1 - x0), height: Math.round(y1 - y0) };
  });
}
