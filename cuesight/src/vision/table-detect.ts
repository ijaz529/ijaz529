/**
 * Table (cloth) detection (research.md R-03):
 *   cloth colour (the established model when the camera is still aimed at its table, else learned
 *   from the frame centre, grey as a fallback) → cloth mask → the connected component the camera is
 *   aimed at (else the largest) → boundary extremes → convex hull → 4-vertex reduction → robust
 *   per-side line refit (non-border points only) with an adaptive band → corners.
 * Works for any cloth colour, including grey (a low-saturation "neutral" model); robust to pocket
 * cut-outs, side-pocket notches and balls on the rail. A table cut off by the image border is
 * accepted only when every side is still supported by real edge points and the outline runs off the
 * frame wherever the cloth does; otherwise, and for frames with no table, the result is null rather
 * than a border-hugging or wrong quad (Constitution II).
 */
import type { Vec2 } from '../core/vec';
import { frameToHsv, hueDiff, type Frame } from './image';

export interface ClothModel {
  hue: number;
  sat: number;
  val: number;
  /**
   * 'neutral': grey / charcoal cloth with too little saturation for a hue; matched on low S and V near
   * `val` (`hue` is then meaningless, 0). Absent or 'chromatic': matched on hue.
   */
  kind?: 'chromatic' | 'neutral';
}

export interface TableDetection {
  /** Outer cloth-edge corners in image px, in polygon order (unordered w.r.t. the table frame). */
  corners: Vec2[];
  cloth: ClothModel;
  /** 0..1: intersection over union of the cloth component and the fitted quad (inside the frame). */
  quality: number;
}

export interface TableScratch {
  w: number;
  h: number;
  hue: Float32Array;
  sat: Float32Array;
  val: Float32Array;
  /** Cloth mask; after detectTable, 1 only on the returned detection's component. */
  mask: Uint8Array;
  label: Int32Array;
  queue: Int32Array;
  /** learnCloth histograms (allocated once per scratch). */
  satHist?: Uint32Array;
  valHist?: Uint32Array;
  hueBins?: Float64Array;
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
    satHist: new Uint32Array(256),
    valHist: new Uint32Array(256),
    hueBins: new Float64Array(36),
  };
}

export const HUE_TOL = 22;

/**
 * Minimum IoU quality for a detection the pipeline may lock on (and for keeping a prior cloth model).
 * ASSUMPTION (synthetic renders): a correct outline scores 0.96-0.98 (pockets and balls are the
 * missing cloth); half a table hidden by an arm still scores ≈ 0.6-0.8; a wrong quad scores far lower.
 */
export const MIN_TABLE_QUALITY = 0.6;

/**
 * Neutral (grey) cloth match. ASSUMPTIONS (synthetic renders, research.md R-03 lighting model):
 * - V band 0.4…1.3 × the median: shaded cushion nose faces sit at ≈ 0.5×, ball shadows at ≈ 0.55×,
 *   while the white cue ball (≥ 1.9× on mid-grey cloth) and pockets / the black ball (≤ 0.3×) stay out;
 * - a tinted grey (median S ≥ 0.08) also needs ≥ 0.7× its chroma, so a plain grey floor or wall
 *   (S ≈ 0.07) is not taken for a blue-grey cloth; S stays below max(0.2, 1.6 × the median).
 */
function isNeutralCloth(s: number, v: number, m: ClothModel): boolean {
  return s < Math.max(0.2, 1.6 * m.sat) && (m.sat < 0.08 || s > 0.7 * m.sat) && v > 0.4 * m.val && v < 1.3 * m.val;
}

export function isCloth(h: number, s: number, v: number, m: ClothModel): boolean {
  if (m.kind === 'neutral') return isNeutralCloth(s, v, m);
  return hueDiff(h, m.hue) < HUE_TOL && s > 0.4 * m.sat && v > 0.28 * m.val;
}

/** A sample of a grey cloth: unsaturated, neither black nor white (balls, pockets, highlights). */
const isNeutralSample = (s: number, v: number) => s < 0.25 && v > 0.15 && v < 0.85;
const isSaturatedSample = (s: number, v: number) => s > 0.2 && v > 0.12;

function hists(sc: TableScratch): { satHist: Uint32Array; valHist: Uint32Array; hueBins: Float64Array } {
  sc.satHist ??= new Uint32Array(256);
  sc.valHist ??= new Uint32Array(256);
  sc.hueBins ??= new Float64Array(36);
  return { satHist: sc.satHist, valHist: sc.valHist, hueBins: sc.hueBins };
}

/** 0..1 value → histogram bin (nearest k/255). */
const bin255 = (x: number) => {
  const k = (x * 255 + 0.5) | 0;
  return k < 0 ? 0 : k > 255 ? 255 : k;
};

/** Median (the element at index n >> 1 of the sorted samples) from a 256-bin histogram, within ½/255. */
function histMedian(hist: Uint32Array, n: number): number {
  if (n === 0) return 0.5;
  const target = n >> 1;
  let acc = 0;
  for (let k = 0; k < 256; k++) {
    acc += hist[k]!;
    if (acc > target) return k / 255;
  }
  return 0.5;
}

/**
 * Share of saturated pixels needed for a chromatic (hue) model, and of mid-grey pixels for a neutral
 * one. ASSUMPTION: balls, pockets, shadows and highlights take at most ≈ 40 % of a cloth region; a
 * coloured cloth keeps S > 0.2 on ≥ 20 % of it even under uneven light (the 001 threshold).
 */
const MIN_CHROMATIC_SHARE = 0.2;
const MIN_NEUTRAL_SHARE = 0.6;
/** clothStats' running hue sum (module-level and reused, so the per-pixel closure never allocates). */
const hueSum = new Float64Array(1);

/**
 * Cloth statistics over pixels selected by `visit` (which calls `take(i)` per candidate pixel index):
 * chromatic model = modal 10° hue bin of saturated pixels, refined to the mean hue within 20° of it,
 * with median S and V (the modal bin ± 1 must hold `bandShare` of all pixels); neutral (grey) model
 * when under MIN_CHROMATIC_SHARE is saturated and at least MIN_NEUTRAL_SHARE is mid-grey.
 * `neutralOnly`: the neutral model whenever at least MIN_NEUTRAL_SHARE is mid-grey, whatever the
 * saturated share (the fallback when a saturated minority — floor, rails — won the chromatic vote).
 * Allocation-free: fixed histograms on the scratch, medians from cumulative counts.
 */
function clothStats(sc: TableScratch, visit: (take: (i: number) => void) => void, bandShare: number, neutralOnly = false): ClothModel | null {
  const { hue, sat, val } = sc;
  const { satHist, valHist, hueBins } = hists(sc);
  hueBins.fill(0);
  let n = 0;
  let nSat = 0;
  let nNeutral = 0;
  visit((i) => {
    n++;
    const s = sat[i]!;
    const v = val[i]!;
    if (isSaturatedSample(s, v)) {
      nSat++;
      hueBins[Math.min(35, Math.floor(hue[i]! / 10))]! += 1;
    } else if (isNeutralSample(s, v)) nNeutral++;
  });
  if (n === 0) return null;
  satHist.fill(0);
  valHist.fill(0);
  if (neutralOnly || nSat < n * MIN_CHROMATIC_SHARE) {
    if (nNeutral < n * MIN_NEUTRAL_SHARE) return null;
    let m = 0;
    visit((i) => {
      const s = sat[i]!;
      const v = val[i]!;
      if (!isNeutralSample(s, v)) return;
      satHist[bin255(s)]! += 1;
      valHist[bin255(v)]! += 1;
      m++;
    });
    return { hue: 0, sat: histMedian(satHist, m), val: histMedian(valHist, m), kind: 'neutral' };
  }
  let mode = 0;
  for (let b = 1; b < 36; b++) if (hueBins[b]! > hueBins[mode]!) mode = b;
  if (hueBins[mode]! + hueBins[(mode + 35) % 36]! + hueBins[(mode + 1) % 36]! < n * bandShare) return null;
  const centre = mode * 10 + 5;
  // Mean signed hue offset from the bin centre (the window is ±20°, so this equals the circular mean
  // to well under 0.5°, without per-pixel trigonometry). The running sum lives in a typed array: a
  // fractional number captured and updated by the closure would be re-boxed on every pixel.
  hueSum[0] = 0;
  let m = 0;
  visit((i) => {
    const s = sat[i]!;
    const v = val[i]!;
    if (!isSaturatedSample(s, v)) return;
    let d = hue[i]! - centre;
    if (d > 180) d -= 360;
    else if (d < -180) d += 360;
    if (d <= -20 || d >= 20) return;
    hueSum[0]! += d;
    satHist[bin255(s)]! += 1;
    valHist[bin255(v)]! += 1;
    m++;
  });
  let mh = m ? centre + hueSum[0]! / m : centre;
  if (mh < 0) mh += 360;
  if (mh >= 360) mh -= 360;
  return { hue: mh, sat: histMedian(satHist, m), val: histMedian(valHist, m), kind: 'chromatic' };
}

/**
 * Learn the cloth colour from the central window: the modal hue of saturated pixels, or a neutral
 * (grey) model when under 20 % of the window is saturated and at least 60 % is mid-grey.
 */
export function learnCloth(sc: TableScratch): ClothModel | null {
  return learnClothInWindow(sc, false);
}

/**
 * The neutral (grey) model of the central window whenever at least 60 % of it is mid-grey, even when
 * a saturated minority (≥ 20 %: a wooden floor, the rails) gave learnCloth a chromatic model. detectTable
 * tries it when the chromatic model finds no table.
 */
export function learnNeutralCloth(sc: TableScratch): ClothModel | null {
  return learnClothInWindow(sc, true);
}

function learnClothInWindow(sc: TableScratch, neutralOnly: boolean): ClothModel | null {
  const { w, h } = sc;
  const x0 = Math.floor(w * 0.3);
  const x1 = Math.ceil(w * 0.7);
  const y0 = Math.floor(h * 0.3);
  const y1 = Math.ceil(h * 0.7);
  return clothStats(
    sc,
    (take) => {
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) take(y * w + x);
    },
    0,
    neutralOnly,
  );
}

/** Point-in-convex-polygon test (either winding). */
function insideConvex(q: Vec2[], x: number, y: number): boolean {
  let sign = 0;
  for (let i = 0; i < q.length; i++) {
    const a = q[i]!;
    const b = q[(i + 1) % q.length]!;
    const c = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
    if (c !== 0) {
      const sg = c > 0 ? 1 : -1;
      if (sign === 0) sign = sg;
      else if (sg !== sign) return false;
    }
  }
  return true;
}

/** convexRowSpan's result: [left, right] x of the polygon on the row (reused, no allocation). */
const rowSpan = new Float64Array(2);

/**
 * The x interval a convex polygon covers on the horizontal line y = yc, written to rowSpan; false when
 * the line misses it. Lets grid loops test insideness per row instead of per pixel.
 */
function convexRowSpan(q: Vec2[], yc: number): boolean {
  let xl = Infinity;
  let xr = -Infinity;
  for (let k = 0; k < q.length; k++) {
    const A = q[k]!;
    const B = q[(k + 1) % q.length]!;
    if ((A.y <= yc && B.y >= yc) || (B.y <= yc && A.y >= yc)) {
      const x = A.y === B.y ? Math.min(A.x, B.x) : A.x + ((yc - A.y) * (B.x - A.x)) / (B.y - A.y);
      const x2 = A.y === B.y ? Math.max(A.x, B.x) : x;
      if (x < xl) xl = x;
      if (x2 > xr) xr = x2;
    }
  }
  rowSpan[0] = xl;
  rowSpan[1] = xr;
  return xl <= xr;
}

/** Grid over a quad's bounding box (≈ 20 000 samples), clipped to the frame. */
function quadGrid(sc: TableScratch, q: Vec2[]): { x0: number; y0: number; x1: number; y1: number; step: number } {
  let minX = sc.w;
  let minY = sc.h;
  let maxX = 0;
  let maxY = 0;
  for (const p of q) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const x0 = Math.max(0, Math.floor(minX));
  const y0 = Math.max(0, Math.floor(minY));
  const x1 = Math.min(sc.w - 1, Math.ceil(maxX));
  const y1 = Math.min(sc.h - 1, Math.ceil(maxY));
  const step = Math.max(1, Math.floor(Math.sqrt(((x1 - x0) * (y1 - y0)) / 20000)));
  return { x0, y0, x1, y1, step };
}

/**
 * Learn the cloth colour inside a quad the player tapped (manual calibration), for photos where the
 * automatic search found no cloth in the central window. Same statistics as `learnCloth`, over the
 * pixels inside the (convex) quad, sampled on a grid. The model is rejected when it also explains most
 * of a ring just outside the quad: a floor, wall or carpet that fills the view is not a table cloth
 * (the rails around a real cloth differ from it). When no part of the ring is in the frame, a
 * chromatic model is kept but a grey one is not (grey surroundings are too common to assume). `sc`
 * must hold the frame's HSV (detectTable fills it).
 */
export function learnClothInQuad(sc: TableScratch, quad: Vec2[]): ClothModel | null {
  if (quad.length !== 4) return null;
  const { w } = sc;
  const q = convexHull(quad);
  if (q.length < 3) return null;
  const { x0, y0, x1, y1, step } = quadGrid(sc, q);
  const visit = (take: (i: number) => void) => {
    for (let y = y0; y <= y1; y += step) {
      if (!convexRowSpan(q, y + 0.5)) continue;
      for (let x = x0; x <= x1; x += step) if (x + 0.5 >= rowSpan[0]! && x + 0.5 <= rowSpan[1]!) take(y * w + x);
    }
  };
  // The cloth must be the bulk of the quad (balls, pockets and shadows are the rest).
  const m = clothStats(sc, visit, 0.35);
  if (!m) return null;
  const outside = outsideRingClothShare(sc, q, m);
  if (Number.isNaN(outside)) return m.kind === 'neutral' ? null : m;
  return outside < 0.5 ? m : null;
}

/** Share of samples on a ring just outside a convex polygon (inside the frame) that match the cloth; NaN when too few are in the frame. */
function outsideRingClothShare(sc: TableScratch, q: Vec2[], cloth: ClothModel): number {
  const { w, h, hue, sat, val } = sc;
  const diag = Math.hypot(w, h);
  const cx = q.reduce((a, p) => a + p.x, 0) / q.length;
  const cy = q.reduce((a, p) => a + p.y, 0) / q.length;
  let n = 0;
  let hit = 0;
  for (let k = 0; k < q.length; k++) {
    const A = q[k]!;
    const B = q[(k + 1) % q.length]!;
    const L = Math.hypot(B.x - A.x, B.y - A.y);
    if (L < 1) continue;
    let nx = (B.y - A.y) / L;
    let ny = -(B.x - A.x) / L;
    if ((cx - A.x) * nx + (cy - A.y) * ny > 0) {
      nx = -nx;
      ny = -ny;
    }
    for (const dist of [0.015 * diag, 0.03 * diag])
      for (let t = 0.1; t < 0.91; t += 0.05) {
        const x = Math.floor(A.x + (B.x - A.x) * t + nx * dist);
        const y = Math.floor(A.y + (B.y - A.y) * t + ny * dist);
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        n++;
        const i = y * w + x;
        if (isCloth(hue[i]!, sat[i]!, val[i]!, cloth)) hit++;
      }
  }
  return n >= 8 ? hit / n : NaN;
}

/**
 * Fraction of the grid samples inside a (convex) quad that match the cloth model: how much of a manual
 * quad is actually cloth. Same grid as `learnClothInQuad`; `sc` must hold the frame's HSV.
 */
export function clothCoverageInQuad(sc: TableScratch, quad: Vec2[], cloth: ClothModel): number {
  if (quad.length < 3) return 0;
  const { w, hue, sat, val } = sc;
  const q = convexHull(quad);
  if (q.length < 3) return 0;
  const { x0, y0, x1, y1, step } = quadGrid(sc, q);
  let n = 0;
  let hit = 0;
  for (let y = y0; y <= y1; y += step) {
    if (!convexRowSpan(q, y + 0.5)) continue;
    for (let x = x0; x <= x1; x += step) {
      if (x + 0.5 < rowSpan[0]! || x + 0.5 > rowSpan[1]!) continue;
      n++;
      const i = y * w + x;
      if (isCloth(hue[i]!, sat[i]!, val[i]!, cloth)) hit++;
    }
  }
  return n ? hit / n : 0;
}

/** Samples per side of a quad edge profile, at t evenly spaced in (0.1, 0.9) (clear of the corner pockets). */
export const EDGE_PROFILE_SAMPLES = 16;

/**
 * Cloth-edge profile of a quad, for telling later whether the cloth still ends where it did (the
 * camera has not moved) and where it now ends instead. For EDGE_PROFILE_SAMPLES points along each side,
 * the offset in px along the side's outward normal (+ = outward) of the outermost cloth pixel within
 * ±band (two cloth pixels in a row, so one noisy pixel does not count) is written to `out`
 * (4 · EDGE_PROFILE_SAMPLES entries, side k at k · EDGE_PROFILE_SAMPLES):
 *  - NaN: no cloth within the band (hidden, or gone), or the edge may lie beyond the image border;
 *  - +Infinity: cloth all the way to the outer end of the band.
 * `sc` must hold the frame's HSV. Allocation-free.
 */
export function quadEdgeProfile(sc: TableScratch, quad: Vec2[], cloth: ClothModel, band: number, out: Float64Array): void {
  const { w, h, hue, sat, val } = sc;
  const S = EDGE_PROFILE_SAMPLES;
  const B = Math.max(2, Math.round(band));
  const cx = (quad[0]!.x + quad[1]!.x + quad[2]!.x + quad[3]!.x) / 4;
  const cy = (quad[0]!.y + quad[1]!.y + quad[2]!.y + quad[3]!.y) / 4;
  for (let k = 0; k < 4; k++) {
    const A = quad[k]!;
    const C = quad[(k + 1) % 4]!;
    const L = Math.hypot(C.x - A.x, C.y - A.y);
    let nx = L > 0 ? (C.y - A.y) / L : 0;
    let ny = L > 0 ? -(C.x - A.x) / L : 0;
    if ((cx - A.x) * nx + (cy - A.y) * ny > 0) {
      nx = -nx;
      ny = -ny;
    }
    for (let j = 0; j < S; j++) {
      const t = 0.1 + (0.8 * (j + 0.5)) / S;
      const px = A.x + (C.x - A.x) * t;
      const py = A.y + (C.y - A.y) * t;
      let edge = NaN;
      let outer = NaN; // outermost in-frame offset scanned
      let prev = false;
      for (let s = B; s >= -B; s--) {
        const x = Math.floor(px + nx * s);
        const y = Math.floor(py + ny * s);
        if (L === 0 || x < 0 || y < 0 || x >= w || y >= h) {
          prev = false;
          continue;
        }
        if (Number.isNaN(outer)) outer = s;
        const i = y * w + x;
        const c = isCloth(hue[i]!, sat[i]!, val[i]!, cloth);
        if (c && prev) {
          edge = s + 1;
          break;
        }
        prev = c;
      }
      // Cloth from the outermost scanned pixel on: past the band (+∞), or past the image border (unknown).
      if (edge === outer) edge = outer === B ? Infinity : NaN;
      out[k * S + j] = edge;
    }
  }
}

export interface EdgeMatch {
  /** Reference samples with a cloth edge (finite or +∞). */
  known: number;
  /** ... whose edge is still within the tolerance of where it was. */
  matched: number;
  /** ... where the cloth now ends farther out (it reaches past the old edge). */
  outward: number;
  /** ... where the cloth now ends farther in. */
  inward: number;
  /** ... with no cloth near the side any more (hidden, or gone). */
  lost: number;
}

/** Compare a quad's edge profile now with a reference profile of the same quad (see quadEdgeProfile). */
export function compareEdgeProfiles(ref: Float64Array, now: Float64Array, tol: number): EdgeMatch {
  const m: EdgeMatch = { known: 0, matched: 0, outward: 0, inward: 0, lost: 0 };
  for (let i = 0; i < ref.length; i++) {
    const r = ref[i]!;
    if (Number.isNaN(r)) continue;
    m.known++;
    const n = now[i]!;
    if (Number.isNaN(n)) m.lost++;
    else if (r === Infinity) {
      if (n === Infinity) m.matched++;
      else m.inward++;
    } else if (n === Infinity || n - r > tol) m.outward++;
    else if (r - n > tol) m.inward++;
    else m.matched++;
  }
  return m;
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

function strictlyConvex(q: Vec2[]): boolean {
  let sign = 0;
  for (let k = 0; k < q.length; k++) {
    const a = q[k]!;
    const b = q[(k + 1) % q.length]!;
    const c = q[(k + 2) % q.length]!;
    const cr = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (cr === 0) return false;
    const s = cr > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

export interface RefineOptions {
  /** Convex hull of the component: sets how far outward each side's support band reaches. */
  hull?: Vec2[];
  /** Frame size: corners more than 0.5·diag outside the frame are rejected. */
  width?: number;
  height?: number;
}

/**
 * Minimum image angle (deg) between adjacent fitted sides. ASSUMPTION: sharper corners come from a
 * side fitted to the wrong edge (or a grazing view too oblique to measure), not from a usable view of
 * the rectangle.
 */
const MIN_CORNER_ANGLE_DEG = 20;

/**
 * Robustly refit each side of the quad to boundary points and re-intersect for corners. Each side's
 * support band reaches inward 3 % of the diagonal and outward past the farthest hull vertex beside it
 * (corner-pocket cut-outs put the max-area quad's sides inside the true edge, by more than a fixed
 * band when the table fills the frame); the fit is then repeated once around the new sides.
 * Returns null (no guessing) when a side has too little support — fewer than max(8, ¼ of its length
 * in px) points, as when it runs along the image border —, when adjacent sides meet at under 20°,
 * when a corner lands more than half a diagonal outside the frame, or when the result is not convex.
 */
export function refineQuad(quad: Vec2[], boundary: Vec2[], diag: number, opts: RefineOptions = {}): Vec2[] | null {
  if (quad.length !== 4) return null;
  let cur = quad;
  for (let pass = 0; pass < 2; pass++) {
    const cx = (cur[0]!.x + cur[1]!.x + cur[2]!.x + cur[3]!.x) / 4;
    const cy = (cur[0]!.y + cur[1]!.y + cur[2]!.y + cur[3]!.y) / 4;
    const lines: Line[] = [];
    for (let k = 0; k < 4; k++) {
      const A = cur[k]!;
      const B = cur[(k + 1) % 4]!;
      const L = Math.hypot(B.x - A.x, B.y - A.y);
      if (!(L > 1)) return null;
      const ux = (B.x - A.x) / L;
      const uy = (B.y - A.y) / L;
      // Outward unit normal (away from the quad centroid).
      let nx = uy;
      let ny = -ux;
      if ((cx - A.x) * nx + (cy - A.y) * ny > 0) {
        nx = -nx;
        ny = -ny;
      }
      let dOut = 0;
      if (opts.hull)
        for (const v of opts.hull) {
          const t = ((v.x - A.x) * ux + (v.y - A.y) * uy) / L;
          if (t >= 0 && t <= 1) dOut = Math.max(dOut, (v.x - A.x) * nx + (v.y - A.y) * ny);
        }
      const outMax = Math.max(0.03 * diag, dOut + 0.01 * diag);
      let sel = boundary.filter((q) => {
        const t = ((q.x - A.x) * ux + (q.y - A.y) * uy) / L;
        const d = (q.x - A.x) * nx + (q.y - A.y) * ny;
        return t > 0.1 && t < 0.9 && d > -0.03 * diag && d < outMax;
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
      if (!line || sel.length < Math.max(8, 0.25 * L)) return null;
      lines.push(line);
    }
    const out: Vec2[] = [];
    for (let k = 0; k < 4; k++) {
      const a = lines[(k + 3) % 4]!;
      const b = lines[k]!;
      const sin = Math.abs(a.dx * b.dy - a.dy * b.dx);
      if (sin < Math.sin((MIN_CORNER_ANGLE_DEG * Math.PI) / 180)) return null;
      const c = intersect(a, b);
      if (!c) return null;
      out.push(c);
    }
    if (!strictlyConvex(out)) return null;
    cur = out;
  }
  if (opts.width !== undefined && opts.height !== undefined) {
    const m = 0.5 * diag;
    for (const c of cur) if (c.x < -m || c.y < -m || c.x > opts.width + m || c.y > opts.height + m) return null;
  }
  return cur;
}

/**
 * Detection quality: |mask ∩ quad| / |mask ∪ quad| over the frame, with `sc.mask` = the cloth
 * component (as detectTable leaves it) and pixel centres tested against the convex quad. Cloth outside
 * the quad and non-cloth inside it both lower the score. Allocation-free.
 */
export function quadQuality(sc: TableScratch, quad: Vec2[]): number {
  if (quad.length !== 4) return 0;
  const { w, h, mask } = sc;
  let inter = 0;
  let uni = 0;
  for (let y = 0; y < h; y++) {
    const yc = y + 0.5;
    // The quad's span on this row (convex: one interval).
    let xl = Infinity;
    let xr = -Infinity;
    for (let k = 0; k < 4; k++) {
      const A = quad[k]!;
      const B = quad[(k + 1) % 4]!;
      if ((A.y <= yc && B.y > yc) || (B.y <= yc && A.y > yc)) {
        const x = A.x + ((yc - A.y) * (B.x - A.x)) / (B.y - A.y);
        if (x < xl) xl = x;
        if (x > xr) xr = x;
      }
    }
    const s0 = xl === Infinity ? 1 : Math.max(0, Math.ceil(xl - 0.5));
    const s1 = xr === -Infinity ? 0 : Math.min(w - 1, Math.floor(xr - 0.5));
    const base = y * w;
    let row = 0;
    let span = 0;
    for (let x = 0; x < w; x++) {
      const m = mask[base + x]!;
      row += m;
      if (x >= s0 && x <= s1) span += m;
    }
    const spanLen = s1 >= s0 ? s1 - s0 + 1 : 0;
    inter += span;
    uni += row + spanLen - span;
  }
  return uni > 0 ? inter / uni : 0;
}

/**
 * Where the cloth component runs off the frame, the table outline must run off there too: the number
 * of component pixels on the image border that lie more than `tol` px outside the (convex) quad. A
 * side fitted to the wrong edge of a truncated table ends inside the frame while the cloth beside it
 * still touches the border. Allocation-free (2·(w + h) pixels).
 */
export function borderPixelsOutsideQuad(sc: TableScratch, quad: Vec2[], tol = 2): { outside: number; total: number } {
  const { w, h, mask } = sc;
  const cx = (quad[0]!.x + quad[1]!.x + quad[2]!.x + quad[3]!.x) / 4;
  const cy = (quad[0]!.y + quad[1]!.y + quad[2]!.y + quad[3]!.y) / 4;
  let outside = 0;
  let total = 0;
  const test = (x: number, y: number) => {
    if (!mask[y * w + x]) return;
    total++;
    const px = x + 0.5;
    const py = y + 0.5;
    for (let k = 0; k < 4; k++) {
      const A = quad[k]!;
      const B = quad[(k + 1) % 4]!;
      const L = Math.hypot(B.x - A.x, B.y - A.y);
      if (!(L > 0)) continue;
      let nx = (B.y - A.y) / L;
      let ny = -(B.x - A.x) / L;
      if ((cx - A.x) * nx + (cy - A.y) * ny > 0) {
        nx = -nx;
        ny = -ny;
      }
      if ((px - A.x) * nx + (py - A.y) * ny > tol) {
        outside++;
        return;
      }
    }
  };
  for (let x = 0; x < w; x++) {
    test(x, 0);
    if (h > 1) test(x, h - 1);
  }
  for (let y = 1; y < h - 1; y++) {
    test(0, y);
    if (w > 1) test(w - 1, y);
  }
  return { outside, total };
}

/**
 * Border cloth pixels allowed more than 2 px outside the fitted quad: max(MAX_BORDER_OUTSIDE, 2 % of
 * the component's border pixels). ASSUMPTION (synthetic truncation sweeps, ≈ 1250 poses): an exact
 * outline of a truncated table leaves at most a few stragglers where its sides cross the border; a
 * side fitted to the wrong edge leaves a run of tens of pixels (136 in the review's worst case).
 */
const MAX_BORDER_OUTSIDE = 4;

/** Candidate labels for centreLabel (reused: no allocation per call). */
const CENTRE_SLOTS = 8;
const centreLabels = new Int32Array(CENTRE_SLOTS);
const centreCounts = new Int32Array(CENTRE_SLOTS);

/**
 * The component label (sc.label) covering most of the central window (the middle 20 % × 20 % of the
 * frame, sampled every 2 px), or 0 when none of it is cloth. Only the first CENTRE_SLOTS distinct
 * labels met are counted (a table fills the window with one label; balls are holes, not labels).
 */
function centreLabel(sc: TableScratch): number {
  const { w, h, label } = sc;
  centreLabels.fill(0);
  centreCounts.fill(0);
  for (let y = Math.floor(h * 0.4); y < Math.ceil(h * 0.6); y += 2)
    for (let x = Math.floor(w * 0.4); x < Math.ceil(w * 0.6); x += 2) {
      const l = label[y * w + x]!;
      if (!l) continue;
      for (let k = 0; k < CENTRE_SLOTS; k++) {
        if (centreLabels[k] === l) {
          centreCounts[k]!++;
          break;
        }
        if (centreLabels[k] === 0) {
          centreLabels[k] = l;
          centreCounts[k] = 1;
          break;
        }
      }
    }
  let bestK = 0;
  for (let k = 1; k < CENTRE_SLOTS; k++) if (centreCounts[k]! > centreCounts[bestK]!) bestK = k;
  return centreCounts[bestK]! > 0 ? centreLabels[bestK]! : 0;
}

/**
 * Fit the table quad to the component of `cloth`'s mask the camera is aimed at (else the largest);
 * leaves `sc.mask` = that component.
 */
function fitTable(sc: TableScratch, cloth: ClothModel): TableDetection | null {
  const { w, h, hue, sat, val, mask, label, queue } = sc;
  const n = w * h;
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
  // Prefer the component the camera is aimed at (most of the central window) when it passes the same
  // size gate: a floor or wall that the model also matches can be larger than the table, and so can a
  // second table nearer the camera.
  const aimed = centreLabel(sc);
  if (aimed > 0 && aimed !== best) {
    let size = 0;
    for (let i = 0; i < n; i++) if (label[i] === aimed) size++;
    if (size >= n * 0.05) best = aimed;
  }
  for (let i = 0; i < n; i++) mask[i] = label[i] === best ? 1 : 0;

  // Boundary extremes per row and column.
  const boundary: Vec2[] = [];
  for (let y = 0; y < h; y++) {
    let lo = -1;
    let hi = -1;
    for (let x = 0; x < w; x++)
      if (mask[y * w + x]) {
        if (lo < 0) lo = x;
        hi = x;
      }
    if (lo >= 0) boundary.push({ x: lo, y: y + 0.5 }, { x: hi + 1, y: y + 0.5 });
  }
  for (let x = 0; x < w; x++) {
    let lo = -1;
    let hi = -1;
    for (let y = 0; y < h; y++)
      if (mask[y * w + x]) {
        if (lo < 0) lo = y;
        hi = y;
      }
    if (lo >= 0) boundary.push({ x: x + 0.5, y: lo }, { x: x + 0.5, y: hi + 1 });
  }
  // Points on the image border are not real table edges: the side fits use only the others, so a side
  // running along the border has no support and the frame-filling colour of a floor, a wall or a cloth
  // close-up gives no quad (refineQuad), and a side fitted to the wrong edge leaves cloth on the border
  // outside the quad (below). The hull may use every extreme: it only seeds the four sides.
  const inner = boundary.filter((q) => q.x > 1 && q.x < w - 1 && q.y > 1 && q.y < h - 1);
  const hull = convexHull(boundary);
  if (hull.length < 4) return null;
  const quad0 = reduceToQuad(hull);
  const corners = refineQuad(quad0, inner, Math.hypot(w, h), { hull, width: w, height: h });
  if (!corners) return null;
  const border = borderPixelsOutsideQuad(sc, corners);
  if (border.outside > Math.max(MAX_BORDER_OUTSIDE, 0.02 * border.total)) return null;
  return { corners, cloth, quality: quadQuality(sc, corners) };
}

/**
 * Share of the central learnCloth window covered by the detection's component (`sc.mask` as fitTable
 * leaves it), sampled on a 4 px grid.
 */
function centralShare(sc: TableScratch): number {
  const { w, h, mask } = sc;
  let n = 0;
  let hit = 0;
  for (let y = Math.floor(h * 0.3); y < Math.ceil(h * 0.7); y += 4)
    for (let x = Math.floor(w * 0.3); x < Math.ceil(w * 0.7); x += 4) {
      n++;
      hit += mask[y * w + x]!;
    }
  return n ? hit / n : 0;
}

/** The table the camera is aimed at: its outline contains the frame centre, or its cloth covers most of the central window. */
function aimedAt(sc: TableScratch, det: TableDetection): boolean {
  return insideConvex(det.corners, sc.w / 2, sc.h / 2) || centralShare(sc) >= 0.5;
}

const good = (d: TableDetection | null): boolean => !!d && d.quality >= MIN_TABLE_QUALITY;

/**
 * Find the table in a frame (the one the camera is aimed at).
 * - With a `prior` cloth model (the pipeline's established one), that model is tried first and kept
 *   when it still segments a plausible table (component ≥ 5 % of the frame, quality ≥
 *   MIN_TABLE_QUALITY) that the camera is aimed at, so an object over the frame centre cannot replace
 *   the cloth, and a coloured rectangle seen earlier (a poster, a door) cannot hold on to the cloth
 *   once the camera is aimed at the real table.
 * - Otherwise the cloth is learned from the frame centre; when its chromatic model finds no good table
 *   but the window is mostly grey (grey cloth on a wooden floor), the neutral model is tried too.
 * - A good prior detection off the centre is the fallback when nothing better is found.
 * `scratch.mask` is left holding the returned detection's component.
 */
export function detectTable(frame: Frame, scratch?: TableScratch, prior?: ClothModel | null): TableDetection | null {
  const w = frame.width;
  const h = frame.height;
  const sc = scratch && scratch.w === w && scratch.h === h ? scratch : createTableScratch(w, h);
  frameToHsv(frame, sc.hue, sc.sat, sc.val);
  let fromPrior: TableDetection | null = null;
  if (prior) {
    const r = fitTable(sc, prior);
    if (r && good(r)) {
      if (aimedAt(sc, r)) return r;
      fromPrior = r;
    }
  }
  const learned = learnCloth(sc);
  let best = learned ? fitTable(sc, learned) : null;
  if (!good(best) && learned?.kind !== 'neutral') {
    const grey = learnNeutralCloth(sc);
    if (grey) {
      const alt = fitTable(sc, grey);
      if (alt && (!best || alt.quality > best.quality)) best = alt;
      else if (best) fitTable(sc, best.cloth); // restore the mask of the returned detection
    }
  }
  if (!good(best) && fromPrior) {
    fitTable(sc, fromPrior.cloth);
    return fromPrior;
  }
  return best;
}
