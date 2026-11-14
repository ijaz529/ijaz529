/**
 * Procedural textures. The pixel generators are pure (RGBA8 typed arrays) so they run anywhere;
 * only the number atlas needs a 2D canvas (it falls back to "no numbers" without one).
 * Everything is generated on-device at start-up — no image assets, no network (Principle V).
 */

export interface PixelImage {
  width: number;
  height: number;
  data: Uint8Array;
}

// ---------------------------------------------------------------------------------------------
// Noise
// ---------------------------------------------------------------------------------------------
function hash(ix: number, iy: number, seed: number): number {
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const smooth = (t: number) => t * t * (3 - 2 * t);

/** Tileable value noise in [0, 1) with integer periods px, py. */
export function valueNoise(x: number, y: number, px: number, py: number, seed = 1): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = smooth(x - x0);
  const fy = smooth(y - y0);
  const m = (v: number, p: number) => ((v % p) + p) % p;
  const a = hash(m(x0, px), m(y0, py), seed);
  const b = hash(m(x0 + 1, px), m(y0, py), seed);
  const c = hash(m(x0, px), m(y0 + 1, py), seed);
  const d = hash(m(x0 + 1, px), m(y0 + 1, py), seed);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

/** Tileable fBm over a texture of `w`×`h` with base cell counts (cx, cy). */
export function fbm(u: number, v: number, cx: number, cy: number, octaves: number, seed = 1): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let fx = cx;
  let fy = cy;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise(u * fx, v * fy, fx, fy, seed + o * 17);
    norm += amp;
    amp *= 0.5;
    fx *= 2;
    fy *= 2;
  }
  return sum / norm;
}

function img(width: number, height: number): PixelImage {
  return { width, height, data: new Uint8Array(width * height * 4) };
}

const to8 = (v: number) => (v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255));

// ---------------------------------------------------------------------------------------------
// Cloth
// ---------------------------------------------------------------------------------------------
/**
 * Fine cloth detail (tileable, ~5 cm per tile in the shader): a tight worsted twill weave plus
 * fibre noise. R = weave/fibre luminance, G = a second fibre layer, B = thread direction mask.
 */
export function clothWeaveImage(size = 256): PixelImage {
  const im = img(size, size);
  const threads = 64; // threads per tile in each direction
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      // Twill: warp over two, under two, shifting by one each row → diagonal ribs.
      const tx = u * threads;
      const ty = v * threads;
      const cell = (Math.floor(tx) + Math.floor(ty)) & 3;
      const warpOnTop = cell < 2;
      const fx = tx - Math.floor(tx);
      const fy = ty - Math.floor(ty);
      const across = warpOnTop ? fx : fy; // across the visible thread
      const rib = Math.sin(Math.PI * across); // rounded thread profile
      const fibre = fbm(u, v, 32, 32, 3, 7);
      const fibre2 = fbm(u, v, 9, 9, 3, 11);
      const lum = 0.52 + 0.22 * (rib - 0.64) + 0.22 * (fibre - 0.5);
      const o = (y * size + x) * 4;
      im.data[o] = to8(lum);
      im.data[o + 1] = to8(fibre2);
      im.data[o + 2] = warpOnTop ? 255 : 0;
      im.data[o + 3] = 255;
    }
  return im;
}

/** Large-scale cloth variation across the whole bed (brushing streaks along the length). */
export function clothVariationImage(w = 256, h = 128): PixelImage {
  const im = img(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const u = x / w;
      const v = y / h;
      const blotch = fbm(u, v, 6, 3, 4, 3);
      const streak = fbm(u, v, 3, 48, 3, 5);
      const o = (y * w + x) * 4;
      im.data[o] = to8(blotch);
      im.data[o + 1] = to8(streak);
      im.data[o + 2] = 128;
      im.data[o + 3] = 255;
    }
  return im;
}

// ---------------------------------------------------------------------------------------------
// Wood (rails, cabinet)
// ---------------------------------------------------------------------------------------------
/**
 * Tileable straight-grain hardwood (u = along the board). RGB = sRGB colour, A = gloss variation.
 * A dark walnut/mahogany ramp keeps the table the hero against the dark UI.
 */
export function woodImage(w = 1024, h = 256): PixelImage {
  const im = img(w, h);
  // Dark walnut: deep brown base, slightly warmer latewood lines, fine pores.
  const dark = [46, 25, 14];
  const mid = [90, 50, 27];
  const light = [138, 82, 46];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const u = x / w;
      const v = y / h;
      // Long straight grain (along u) with a gentle wobble and slowly varying line spacing.
      const wob = fbm(u, v, 3, 2, 3, 21) - 0.5;
      const lines = v * 34 + wob * 1.6 + 0.6 * (fbm(u, v, 1, 6, 2, 23) - 0.5);
      const f = lines - Math.floor(lines);
      // Asymmetric growth ring: sharp latewood edge, soft earlywood.
      const ring = Math.pow(Math.min(1, f / 0.82), 6) * (f < 0.82 ? 1 : 1 - (f - 0.82) / 0.18);
      const figure = fbm(u, v, 10, 3, 4, 31);
      const streak = fbm(u, v, 2, 40, 3, 37);
      const pores = valueNoise(u * 700, v * 90, 700, 90, 41);
      let t = 0.42 + 0.22 * ring + 0.22 * (figure - 0.5) + 0.16 * (streak - 0.5);
      if (pores > 0.86) t -= 0.08;
      t = Math.max(0, Math.min(1, t));
      const a = t < 0.5 ? dark : mid;
      const b = t < 0.5 ? mid : light;
      const k = t < 0.5 ? t / 0.5 : (t - 0.5) / 0.5;
      const o = (y * w + x) * 4;
      im.data[o] = Math.round(a[0]! + (b[0]! - a[0]!) * k);
      im.data[o + 1] = Math.round(a[1]! + (b[1]! - a[1]!) * k);
      im.data[o + 2] = Math.round(a[2]! + (b[2]! - a[2]!) * k);
      im.data[o + 3] = to8(0.7 + 0.3 * figure);
    }
  return im;
}

// ---------------------------------------------------------------------------------------------
// Cue stick (u = along the cue from the tip, v = around)
// ---------------------------------------------------------------------------------------------
/** Section boundaries as fractions of the cue length (see CUE_PROFILE in meshes.ts). */
export const CUE_SECTIONS = {
  tip: 0.012 / 1.47,
  ferrule: 0.037 / 1.47,
  joint0: 0.74 / 1.47,
  joint1: 0.77 / 1.47,
  wrap0: 1.022 / 1.47,
  wrap1: 1.27 / 1.47,
  bumper: 1.45 / 1.47,
};

export function cueImage(w = 2048, h = 64): PixelImage {
  const im = img(w, h);
  const S = CUE_SECTIONS;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w;
      const v = (y + 0.5) / h;
      let c: [number, number, number];
      let gloss = 0.8;
      if (u < S.tip * 0.35) {
        // Chalked tip: blue chalk dust over leather.
        const n = valueNoise(u * 4000, v * 40, 4000, 40, 5);
        c = [40 + 30 * n, 86 + 30 * n, 150 + 30 * n];
        gloss = 0.1;
      } else if (u < S.tip) {
        c = [96, 62, 38];
        gloss = 0.2;
      } else if (u < S.ferrule) {
        c = [236, 232, 220];
      } else if (u < S.joint0) {
        // Maple shaft with faint straight grain.
        const g = fbm(u * 6, v, 40, 4, 3, 9);
        c = [222 + 16 * (g - 0.5), 192 + 18 * (g - 0.5), 140 + 16 * (g - 0.5)];
      } else if (u < S.joint1) {
        const k = (u - S.joint0) / (S.joint1 - S.joint0);
        c = k < 0.18 || k > 0.82 ? [20, 20, 22] : [196, 160, 92];
        gloss = 1;
      } else if (u < S.wrap0) {
        // Ebony forearm with four maple points (inlays tapering toward the joint).
        const k = (u - S.joint1) / (S.wrap0 - S.joint1);
        const ang = (v * 4) % 1;
        const half = 0.36 * (1 - k); // point width shrinks toward the joint
        const inPoint = Math.abs(ang - 0.5) < half * 0.5 && k > 0.06;
        const veneer = Math.abs(Math.abs(ang - 0.5) - half * 0.5) < 0.012 && k > 0.06;
        const g = fbm(u * 3, v, 30, 4, 3, 13);
        if (veneer) c = [233, 196, 106];
        else if (inPoint) c = [214, 182, 132];
        else c = [34 + 14 * g, 20 + 8 * g, 16 + 6 * g];
      } else if (u < S.wrap1) {
        // Irish linen wrap: dark with a fine diagonal weave.
        const s = Math.sin((u * 2400 + v * 60) * Math.PI) * Math.sin((u * 2400 - v * 60) * Math.PI);
        const l = 22 + 10 * s;
        c = [l, l, l + 2];
        gloss = 0.15;
      } else if (u < S.bumper) {
        const k = (u - S.wrap1) / (S.bumper - S.wrap1);
        const ringA = Math.abs(k - 0.08) < 0.012 || Math.abs(k - 0.92) < 0.012;
        const g = fbm(u * 3, v, 30, 4, 3, 17);
        c = ringA ? [233, 196, 106] : [46 + 18 * g, 22 + 8 * g, 14 + 6 * g];
      } else {
        c = [14, 14, 15];
        gloss = 0.3;
      }
      const o = (y * w + x) * 4;
      im.data[o] = to8(c[0] / 255);
      im.data[o + 1] = to8(c[1] / 255);
      im.data[o + 2] = to8(c[2] / 255);
      im.data[o + 3] = to8(gloss);
    }
  return im;
}

// ---------------------------------------------------------------------------------------------
// Ball numbers
// ---------------------------------------------------------------------------------------------
export const ATLAS_CELLS = 4;
/** Atlas slot of a ball number (1–15) or −1. */
export function atlasSlot(label: string | undefined): number {
  if (!label || !/^\d{1,2}$/.test(label)) return -1;
  const n = Number(label);
  return n >= 1 && n <= 15 ? n - 1 : -1;
}

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

function makeCanvas(w: number, h: number): AnyCanvas | null {
  try {
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
    if (typeof document !== 'undefined') {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      return c;
    }
  } catch {
    /* no canvas */
  }
  return null;
}

/**
 * 4×4 atlas of bold numbers 1–15, black ink in the alpha channel, centred in each cell. The cell
 * maps onto the number circle via a gnomonic projection in the ball shader, so text is undistorted.
 * 6 and 9 get the traditional underline.
 */
export function numberAtlas(cell = 256): AnyCanvas | null {
  const size = cell * ATLAS_CELLS;
  const cv = makeCanvas(size, size);
  if (!cv) return null;
  const ctx = cv.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) return null;
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = '#000';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const font = '-apple-system, "SF Pro Display", "SF Pro Text", system-ui, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
  for (let n = 1; n <= 15; n++) {
    const i = n - 1;
    const cx = (i % ATLAS_CELLS) * cell + cell / 2;
    const cy = Math.floor(i / ATLAS_CELLS) * cell + cell / 2;
    const txt = String(n);
    const px = txt.length > 1 ? cell * 0.5 : cell * 0.6;
    ctx.font = `800 ${Math.round(px)}px ${font}`;
    // Narrow two-digit numbers slightly so they fit the circle like real ball printing.
    ctx.save();
    ctx.translate(cx, cy + cell * 0.035);
    if (txt.length > 1) ctx.scale(0.86, 1);
    ctx.fillText(txt, 0, 0);
    ctx.restore();
    if (n === 6 || n === 9) ctx.fillRect(cx - cell * 0.15, cy + cell * 0.3, cell * 0.3, cell * 0.045);
  }
  return cv;
}
