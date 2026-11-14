/**
 * Table (cloth) detection (research.md R-03):
 *   cloth colour from the frame centre → cloth mask → largest connected component →
 *   boundary extremes → convex hull → 4-vertex reduction → robust per-side line refit → corners.
 * Works for any cloth colour; robust to pocket cut-outs, side-pocket notches and balls on the rail.
 */
import type { Vec2 } from '../core/vec';
import { frameToHsv, hueDiff, type Frame } from './image';

export interface ClothModel {
  hue: number;
  sat: number;
  val: number;
}

export interface TableDetection {
  /** Outer cloth-edge corners in image px, in polygon order (unordered w.r.t. the table frame). */
  corners: Vec2[];
  cloth: ClothModel;
  /** 0..1: how well the cloth component fills the fitted quad. */
  quality: number;
}

export interface TableScratch {
  w: number;
  h: number;
  hue: Float32Array;
  sat: Float32Array;
  val: Float32Array;
  mask: Uint8Array;
  label: Int32Array;
  queue: Int32Array;
}

export function createTableScratch(w: number, h: number): TableScratch {
  const n = w * h;
  return {
    w,
    h,
    hue: new Float32Array(n),
    sat: new Float32Array(n),
    val: new Float32Array(n),
    mask: new Uint8Array(n),
    label: new Int32Array(n),
    queue: new Int32Array(n),
  };
}

export const HUE_TOL = 22;

export function isCloth(h: number, s: number, v: number, m: ClothModel): boolean {
  return hueDiff(h, m.hue) < HUE_TOL && s > 0.4 * m.sat && v > 0.28 * m.val;
}

/** Learn the cloth colour as the modal hue of saturated pixels in the central window. */
export function learnCloth(sc: TableScratch): ClothModel | null {
  const { w, h, hue, sat, val } = sc;
  const bins = new Float64Array(36);
  const x0 = Math.floor(w * 0.3);
  const x1 = Math.ceil(w * 0.7);
  const y0 = Math.floor(h * 0.3);
  const y1 = Math.ceil(h * 0.7);
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const i = y * w + x;
      if (sat[i]! > 0.2 && val[i]! > 0.12) bins[Math.min(35, Math.floor(hue[i]! / 10))]! += 1;
    }
  let mode = 0;
  for (let b = 1; b < 36; b++) if (bins[b]! > bins[mode]!) mode = b;
  const total = bins.reduce((a, b) => a + b, 0);
  if (total < (x1 - x0) * (y1 - y0) * 0.2) return null;
  const centre = mode * 10 + 5;
  let sx = 0;
  let sy = 0;
  const ss: number[] = [];
  const vs: number[] = [];
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const i = y * w + x;
      if (sat[i]! > 0.2 && val[i]! > 0.12 && hueDiff(hue[i]!, centre) < 20) {
        const a = (hue[i]! * Math.PI) / 180;
        sx += Math.cos(a);
        sy += Math.sin(a);
        ss.push(sat[i]!);
        vs.push(val[i]!);
      }
    }
  ss.sort((a, b) => a - b);
  vs.sort((a, b) => a - b);
  let mh = (Math.atan2(sy, sx) * 180) / Math.PI;
  if (mh < 0) mh += 360;
  return { hue: mh, sat: ss[ss.length >> 1] ?? 0.5, val: vs[vs.length >> 1] ?? 0.5 };
}

/** Andrew's monotone chain convex hull (counter-clockwise in a y-up sense). */
export function convexHull(pts: Vec2[]): Vec2[] {
  const p = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const cr = (o: Vec2, a: Vec2, b: Vec2) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Vec2[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cr(lower[lower.length - 2]!, lower[lower.length - 1]!, q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: Vec2[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i]!;
    while (upper.length >= 2 && cr(upper[upper.length - 2]!, upper[upper.length - 1]!, q) <= 0) upper.pop();
    upper.push(q);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

/** Largest-area quadrilateral whose vertices are hull vertices (O(N³) after collinear pruning). */
export function reduceToQuad(hullIn: Vec2[]): Vec2[] {
  const tri = (a: Vec2, b: Vec2, c: Vec2) => Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) / 2;
  // Prune nearly collinear vertices so N stays small.
  let hull = [...hullIn];
  for (let pass = 0; pass < 4 && hull.length > 40; pass++) {
    const keep: Vec2[] = [];
    for (let i = 0; i < hull.length; i++) {
      const a = hull[(i - 1 + hull.length) % hull.length]!;
      const c = hull[(i + 1) % hull.length]!;
      if (tri(a, hull[i]!, c) > 2 * (pass + 1) ** 2) keep.push(hull[i]!);
    }
    if (keep.length >= 4) hull = keep;
  }
  const n = hull.length;
  if (n <= 4) return hull;
  let best: number[] = [0, 1, 2, 3];
  let bestA = -1;
  for (let i = 0; i < n; i++) {
    for (let k = i + 2; k < n; k++) {
      let aj = -1;
      let jj = -1;
      for (let j = i + 1; j < k; j++) {
        const a = tri(hull[i]!, hull[j]!, hull[k]!);
        if (a > aj) {
          aj = a;
          jj = j;
        }
      }
      let al = -1;
      let ll = -1;
      for (let l = k + 1; l < i + n; l++) {
        const a = tri(hull[k]!, hull[l % n]!, hull[i]!);
        if (a > al) {
          al = a;
          ll = l % n;
        }
      }
      if (jj >= 0 && ll >= 0 && aj + al > bestA) {
        bestA = aj + al;
        best = [i, jj, k, ll];
      }
    }
  }
  return best.map((q) => hull[q]!);
}

interface Line {
  px: number;
  py: number;
  dx: number;
  dy: number;
}

function fitLine(pts: Vec2[]): Line | null {
  if (pts.length < 4) return null;
  let mx = 0;
  let my = 0;
  for (const q of pts) {
    mx += q.x;
    my += q.y;
  }
  mx /= pts.length;
  my /= pts.length;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const q of pts) {
    const dx = q.x - mx;
    const dy = q.y - my;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return { px: mx, py: my, dx: Math.cos(ang), dy: Math.sin(ang) };
}

function intersect(a: Line, b: Line): Vec2 | null {
  const den = a.dx * b.dy - a.dy * b.dx;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((b.px - a.px) * b.dy - (b.py - a.py) * b.dx) / den;
  return { x: a.px + a.dx * t, y: a.py + a.dy * t };
}

/** Robustly refit each side of the quad to boundary points and re-intersect for corners. */
export function refineQuad(quad: Vec2[], boundary: Vec2[], diag: number): Vec2[] {
  const lines: Line[] = [];
  for (let k = 0; k < 4; k++) {
    const A = quad[k]!;
    const B = quad[(k + 1) % 4]!;
    const L = Math.hypot(B.x - A.x, B.y - A.y);
    const ux = (B.x - A.x) / L;
    const uy = (B.y - A.y) / L;
    let sel = boundary.filter((q) => {
      const t = ((q.x - A.x) * ux + (q.y - A.y) * uy) / L;
      const d = Math.abs((q.x - A.x) * uy - (q.y - A.y) * ux);
      return t > 0.1 && t < 0.9 && d < 0.03 * diag;
    });
    let line = fitLine(sel);
    for (let it = 0; it < 3 && line; it++) {
      const ln: Line = line;
      const res = sel.map((q) => Math.abs((q.x - ln.px) * ln.dy - (q.y - ln.py) * ln.dx));
      const sorted = [...res].sort((a, b) => a - b);
      const med = sorted[sorted.length >> 1] ?? 0;
      const thr = Math.max(1.0, 2.5 * med);
      sel = sel.filter((_, i) => res[i]! <= thr);
      line = fitLine(sel) ?? line;
    }
    lines.push(line ?? { px: A.x, py: A.y, dx: ux, dy: uy });
  }
  const out: Vec2[] = [];
  for (let k = 0; k < 4; k++) {
    const c = intersect(lines[(k + 3) % 4]!, lines[k]!);
    if (!c) return quad;
    out.push(c);
  }
  return out;
}

function polyArea(p: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const q = p[i]!;
    const r = p[(i + 1) % p.length]!;
    a += q.x * r.y - r.x * q.y;
  }
  return Math.abs(a) / 2;
}

export function detectTable(frame: Frame, scratch?: TableScratch, prior?: ClothModel | null): TableDetection | null {
  const w = frame.width;
  const h = frame.height;
  const sc = scratch && scratch.w === w && scratch.h === h ? scratch : createTableScratch(w, h);
  frameToHsv(frame, sc.hue, sc.sat, sc.val);
  const cloth = learnCloth(sc) ?? prior ?? null;
  if (!cloth) return null;
  const n = w * h;
  const { hue, sat, val, mask, label, queue } = sc;
  for (let i = 0; i < n; i++) mask[i] = isCloth(hue[i]!, sat[i]!, val[i]!, cloth) ? 1 : 0;

  // Largest 4-connected component.
  label.fill(0);
  let best = -1;
  let bestSize = 0;
  let next = 1;
  for (let s = 0; s < n; s++) {
    if (!mask[s] || label[s]) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = s;
    label[s] = next;
    while (head < tail) {
      const i = queue[head++]!;
      const x = i % w;
      if (x > 0 && mask[i - 1] && !label[i - 1]) {
        label[i - 1] = next;
        queue[tail++] = i - 1;
      }
      if (x < w - 1 && mask[i + 1] && !label[i + 1]) {
        label[i + 1] = next;
        queue[tail++] = i + 1;
      }
      if (i >= w && mask[i - w] && !label[i - w]) {
        label[i - w] = next;
        queue[tail++] = i - w;
      }
      if (i < n - w && mask[i + w] && !label[i + w]) {
        label[i + w] = next;
        queue[tail++] = i + w;
      }
    }
    if (tail > bestSize) {
      bestSize = tail;
      best = next;
    }
    next++;
  }
  if (best < 0 || bestSize < n * 0.05) return null;

  // Boundary extremes per row and column.
  const boundary: Vec2[] = [];
  for (let y = 0; y < h; y++) {
    let lo = -1;
    let hi = -1;
    for (let x = 0; x < w; x++)
      if (label[y * w + x] === best) {
        if (lo < 0) lo = x;
        hi = x;
      }
    if (lo >= 0) boundary.push({ x: lo, y: y + 0.5 }, { x: hi + 1, y: y + 0.5 });
  }
  for (let x = 0; x < w; x++) {
    let lo = -1;
    let hi = -1;
    for (let y = 0; y < h; y++)
      if (label[y * w + x] === best) {
        if (lo < 0) lo = y;
        hi = y;
      }
    if (lo >= 0) boundary.push({ x: x + 0.5, y: lo }, { x: x + 0.5, y: hi + 1 });
  }
  // Points on the image border are not real table edges.
  const inner = boundary.filter((q) => q.x > 1 && q.x < w - 1 && q.y > 1 && q.y < h - 1);
  const hull = convexHull(boundary);
  if (hull.length < 4) return null;
  const quad0 = reduceToQuad(hull);
  const corners = refineQuad(quad0, inner, Math.hypot(w, h));
  const area = polyArea(corners);
  const quality = Math.max(0, Math.min(1, bestSize / Math.max(area, 1)));
  return { corners, cloth, quality };
}
