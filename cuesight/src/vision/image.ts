/**
 * Image primitives over typed arrays. RGBA frames are row-major Uint8ClampedArray.
 */
export interface Frame {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export function createFrame(width: number, height: number): Frame {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

/** RGB (0..255) → HSV with h in degrees [0,360), s and v in [0,1]. Writes into `out` (length 3). */
export function rgbToHsv(r: number, g: number, b: number, out: Float32Array | number[]): void {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = rn > gn ? (rn > bn ? rn : bn) : gn > bn ? gn : bn;
  const min = rn < gn ? (rn < bn ? rn : bn) : gn < bn ? gn : bn;
  const d = max - min;
  let h = 0;
  if (d > 1e-6) {
    if (max === rn) h = 60 * (((gn - bn) / d) % 6);
    else if (max === gn) h = 60 * ((bn - rn) / d + 2);
    else h = 60 * ((rn - gn) / d + 4);
    if (h < 0) h += 360;
  }
  out[0] = h;
  out[1] = max > 0 ? d / max : 0;
  out[2] = max;
}

/** Smallest absolute difference between two hues in degrees (0..180). */
export function hueDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/** Fill HSV planes for a whole frame. */
export function frameToHsv(f: Frame, h: Float32Array, s: Float32Array, v: Float32Array): void {
  const n = f.width * f.height;
  const tmp = [0, 0, 0];
  const d = f.data;
  for (let i = 0; i < n; i++) {
    rgbToHsv(d[i * 4]!, d[i * 4 + 1]!, d[i * 4 + 2]!, tmp);
    h[i] = tmp[0]!;
    s[i] = tmp[1]!;
    v[i] = tmp[2]!;
  }
}

/** Bilinear RGB sample at (x, y) in pixel coordinates; writes r,g,b into out. Returns false if outside. */
export function sampleRgb(f: Frame, x: number, y: number, out: Float32Array | number[]): boolean {
  if (x < 0 || y < 0 || x > f.width - 1 || y > f.height - 1) return false;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(f.width - 1, x0 + 1);
  const y1 = Math.min(f.height - 1, y0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  const d = f.data;
  const w = f.width;
  for (let c = 0; c < 3; c++) {
    const a = d[(y0 * w + x0) * 4 + c]!;
    const b = d[(y0 * w + x1) * 4 + c]!;
    const cc = d[(y1 * w + x0) * 4 + c]!;
    const dd = d[(y1 * w + x1) * 4 + c]!;
    out[c] = (a * (1 - fx) + b * fx) * (1 - fy) + (cc * (1 - fx) + dd * fx) * fy;
  }
  return true;
}
