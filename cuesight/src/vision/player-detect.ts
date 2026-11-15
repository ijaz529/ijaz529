/**
 * Player-photo detection for the player-view pose (spec 002 R-24; tasks T133): the cloth model of a
 * table-level photo, the cloth-boundary "crack" evidence and the ball circle candidates that
 * estimatePlayerView fits the known layout to. Pure and deterministic; per-pixel loops run on
 * typed-array scratch that is reused between calls (Constitution IV).
 *
 * Cloth (learnPlayerCloth): a table-level photo is mostly not cloth — the wall or room above the far
 * rail, the near rail and the floor below it — and the cloth can be any colour, grey included
 * (ClothModel `kind: 'neutral'`, as in table-detect). So the cloth is not "the colour of the bottom of
 * the photo": every chromatic hue mode and every grey (neutral) value mode of the photo is a candidate,
 * and candidates are ranked by structure — the cloth is the surface the balls lie on, so its main
 * region has round, ball-sized holes, while a rail band, a floor or a wall has none, and a grey band
 * that cuts through a surface's own shading leaves speckle. The overview's cloth (`hint`) is promoted
 * when this photo shows a structurally plausible region of that colour. Every candidate is tried in
 * turn by estimatePlayerView until one fits.
 */
import { hueDiff, rgbToHsv, type Frame } from './image';
import { HUE_TOL, isCloth, type ClothModel } from './table-detect';

/** √(x² + y²): Math.hypot's overflow care is not needed here and it is slow in hot loops. */
const hyp2 = (x: number, y: number) => Math.sqrt(x * x + y * y);

// ---------------------------------------------------------------------------------------------------
// Scratch
// ---------------------------------------------------------------------------------------------------

export interface Scratch {
  w: number;
  h: number;
  /** 0 = not cloth, 1 = cloth (stray), 2 = main cloth region. */
  mask: Uint8Array;
  /** A copy of `mask` kept for a cloth candidate the fit comes back to after building another one's. */
  maskKept: Uint8Array;
  /** Cloth components (negative ids) during the first pass, then non-cloth components (1-based). */
  label: Int32Array;
  queue: Int32Array;
  crackX: Float32Array;
  crackY: Float32Array;
  crackL: Int32Array;
}

export const MAX_CRACKS = 1 << 17;
let scratchCache: Scratch | null = null;

export function getScratch(w: number, h: number): Scratch {
  if (!scratchCache || scratchCache.w !== w || scratchCache.h !== h) {
    const n = w * h;
    scratchCache = {
      w,
      h,
      mask: new Uint8Array(n),
      maskKept: new Uint8Array(n),
      label: new Int32Array(n),
      queue: new Int32Array(n),
      crackX: new Float32Array(MAX_CRACKS),
      crackY: new Float32Array(MAX_CRACKS),
      crackL: new Int32Array(MAX_CRACKS),
    };
  }
  return scratchCache;
}

// ---------------------------------------------------------------------------------------------------
// Cloth
// ---------------------------------------------------------------------------------------------------

/** Saturated sample (it has a hue) and grey sample (neither black nor white), as in table-detect. */
const SAT_S = 0.2;
const SAT_V = 0.12;
const GREY_S = 0.25;
const GREY_V0 = 0.15;
const GREY_V1 = 0.85;
/**
 * Smallest share of the photo's samples a cloth candidate must cover. ASSUMPTION (synthetic table-level
 * renders, spec 002 envelope): from 8 cm above the bed and 1.2 m behind the cue ball with a 100° lens
 * the visible cloth is a sliver of ≈ 2.5 % of the frame (≈ 6–10 % with a 40–65° lens); 1.5 % leaves
 * margin. A ball's own colour can pass this share up close; structureScore ranks it last (no holes).
 */
const MIN_CANDIDATE_SHARE = 0.015;
/**
 * Hue modes taken as cloth candidates (by sample count, ≥ 30° apart). Sensor noise gives the dark,
 * slightly blue room above the far rail hue modes of its own (S just over SAT_S at V ≈ 0.14), which
 * outnumber a cloth seen as a 2.6 % sliver: with 4 slots, σ 6 noise pushed the green cloth off the list
 * of a photo aimed past the cue ball, and the reason became "too grainy" instead of "no cue ball".
 */
const MAX_CANDIDATES = 6;

/** Histograms of learnPlayerCloth (module-level, reused: no allocation per call or per pixel). */
const hueBins = new Float64Array(36);
const hueSmooth = new Float64Array(36);
const greyBins = new Float64Array(64);
const greySmooth = new Float64Array(64);
const satHist = new Float64Array(101);
const valHist = new Float64Array(101);
const hsvTmp = [0, 0, 0];

/**
 * The photo's coarse sample grid (≈ 320 samples across the long side) in HSV, computed once per photo
 * and shared by every cloth statistic and structure score (module-level, grown on demand).
 */
interface Grid {
  gw: number;
  gh: number;
  H: Float32Array;
  S: Float32Array;
  V: Float32Array;
}
const grid: Grid = { gw: 0, gh: 0, H: new Float32Array(0), S: new Float32Array(0), V: new Float32Array(0) };

function sampleGrid(frame: Frame): Grid {
  const { width: w, height: h, data } = frame;
  const st = strideOf(w, h);
  const gw = Math.floor(w / st);
  const gh = Math.floor(h / st);
  const n = gw * gh;
  if (grid.H.length < n) {
    grid.H = new Float32Array(n);
    grid.S = new Float32Array(n);
    grid.V = new Float32Array(n);
  }
  grid.gw = gw;
  grid.gh = gh;
  // Each cell is the mean of its st × st block (a proper downsample, not a point sample): sensor noise
  // drops by a factor st, so at σ 6–8 a noisy cloth still reads as one colour mode with clean holes,
  // instead of losing its share and its structure to speckle (the green cloth sliver of a photo from
  // 10 cm up then did not even make the candidate list).
  const inv = 1 / (st * st);
  for (let gy = 0; gy < gh; gy++)
    for (let gx = 0; gx < gw; gx++) {
      let r = 0;
      let gg = 0;
      let b = 0;
      for (let dy = 0; dy < st; dy++) {
        let i = ((gy * st + dy) * w + gx * st) * 4;
        for (let dx = 0; dx < st; dx++, i += 4) {
          r += data[i]!;
          gg += data[i + 1]!;
          b += data[i + 2]!;
        }
      }
      rgbToHsv(r * inv, gg * inv, b * inv, hsvTmp);
      const g = gy * gw + gx;
      grid.H[g] = hsvTmp[0]!;
      grid.S[g] = hsvTmp[1]!;
      grid.V[g] = hsvTmp[2]!;
    }
  return grid;
}

export interface PhotoCloth {
  /** Cloth models to try, most plausible first (empty when the photo shows no candidate surface). */
  models: ClothModel[];
  /**
   * Non-cloth regions of any size enclosed by each model's largest region, away from the frame edge
   * (balls, pockets, a near cue ball). 0 for every model: a plain surface — a wall, a floor — no table.
   */
  enclosed: number[];
  /** Structure score of each model (ball-sized holes + area share), the ranking key. */
  scores: number[];
  /** Mean V (0..1) of the photo. */
  meanV: number;
  /** Share of the photo's samples that are dark (V < 0.12). */
  darkFrac: number;
}

/** Quantile q of the samples in a 0..1 histogram (bin k ↔ k / (bins − 1)). */
function histQuantile(hist: Float64Array, cnt: number, q: number): number {
  let acc = 0;
  for (let k = 0; k < hist.length; k++) {
    acc += hist[k]!;
    if (acc >= cnt * q) return k / (hist.length - 1);
  }
  return 0.5;
}
const histMedian = (hist: Float64Array, cnt: number) => histQuantile(hist, cnt, 0.5);

/** Sampling stride of the cloth statistics (≈ 320 samples across the long side). */
const strideOf = (w: number, h: number) => Math.max(2, Math.round(Math.max(w, h) / 320));

/** Chromatic model around hue `centre` (±20°): circular-mean hue and median S, V; null if too rare. */
function chromaticModel(g: Grid, centre: number, minCount: number): ClothModel | null {
  satHist.fill(0);
  valHist.fill(0);
  let sx = 0;
  let sy = 0;
  let cnt = 0;
  const n = g.gw * g.gh;
  for (let i = 0; i < n; i++) {
    const hh = g.H[i]!;
    const ss = g.S[i]!;
    const vv = g.V[i]!;
    if (ss > SAT_S && vv > SAT_V && hueDiff(hh, centre) < 20) {
      const a = (hh * Math.PI) / 180;
      sx += Math.cos(a);
      sy += Math.sin(a);
      satHist[Math.round(ss * 100)]! += 1;
      valHist[Math.round(vv * 100)]! += 1;
      cnt++;
    }
  }
  if (cnt < minCount) return null;
  let hue = (Math.atan2(sy, sx) * 180) / Math.PI;
  if (hue < 0) hue += 360;
  return { hue, sat: histMedian(satHist, cnt), val: histMedian(valHist, cnt), kind: 'chromatic' };
}

/**
 * Neutral (grey) model around value `v0` (0.7–1.4 × v0): median S, and the 75th percentile of V as the
 * reference value. The neutral band (0.4–1.3 × val, table-detect) must hold the lit cloth: at table
 * level the photo spans the cloth from under the lamp to the far end, and shadows and cushion faces pull
 * the median down to ≈ 0.8 of the lit level, which would put the brightest cloth outside the band (as
 * spurious "white balls"); the 75th percentile sits at the lit level, and shadows (≈ 0.55×) stay inside.
 */
function neutralModel(g: Grid, v0: number, minCount: number): ClothModel | null {
  satHist.fill(0);
  valHist.fill(0);
  let cnt = 0;
  const n = g.gw * g.gh;
  for (let i = 0; i < n; i++) {
    const s = g.S[i]!;
    const v = g.V[i]!;
    if (s < GREY_S && v > GREY_V0 && v < GREY_V1 && v > 0.7 * v0 && v < 1.4 * v0) {
      satHist[Math.round(s * 100)]! += 1;
      valHist[Math.round(v * 100)]! += 1;
      cnt++;
    }
  }
  if (cnt < minCount) return null;
  return { hue: 0, sat: histMedian(satHist, cnt), val: histQuantile(valHist, cnt, 0.75), kind: 'neutral' };
}

/**
 * Cloth predicate, the same rule as table-detect's isCloth (hue within HUE_TOL, S > 0.4·sat,
 * V > 0.28·val for a chromatic model; the neutral band for a grey one) on 0..255 RGB, computing the
 * hue only when the cheap S and V tests pass.
 */
export function clothTest(r: number, g: number, b: number, m: ClothModel): boolean {
  const mx = r > g ? (r > b ? r : b) : g > b ? g : b;
  const mn = r < g ? (r < b ? r : b) : g < b ? g : b;
  const d = mx - mn;
  if (m.kind === 'neutral') {
    if (mx === 0) return false;
    // isCloth(·, s, v, m) for a neutral model ignores the hue.
    return isCloth(0, d / mx, mx / 255, m);
  }
  if (mx <= 0.28 * m.val * 255 || d <= 0.4 * m.sat * mx || d === 0) return false;
  let hh: number;
  if (mx === r) hh = 60 * (((g - b) / d) % 6);
  else if (mx === g) hh = 60 * ((b - r) / d + 2);
  else hh = 60 * ((r - g) / d + 4);
  if (hh < 0) hh += 360;
  let dh = Math.abs(hh - m.hue) % 360;
  if (dh > 180) dh = 360 - dh;
  return dh < HUE_TOL;
}

/**
 * Structure score of a cloth candidate on a coarse grid: the number of ball-sized holes (non-cloth
 * regions enclosed by its main region, away from the frame edge) plus its area share as the tie
 * break, discounted by speckle. Balls and pocket holes make holes in the cloth; a rail band, a floor or
 * a wall has (almost) none, however large it is.
 */
function structureScore(g: Grid, m: ClothModel, sc: Scratch): { score: number; enclosed: number } {
  const { gw, gh } = g;
  const n = gw * gh;
  const { mask, label, queue } = sc;
  for (let i = 0; i < n; i++) mask[i] = isCloth(g.H[i]!, g.S[i]!, g.V[i]!, m) ? 1 : 0;
  // Cloth components; the main region is the largest and every comparable one (≥ 25 % of it, ≥ 1 % of
  // the frame), as in buildEvidence: a dark room of the same grey must not hide the cloth below it.
  label.fill(0, 0, n);
  let next = 1;
  let best = 0;
  const sizes: number[] = [0];
  for (let s = 0; s < n; s++) {
    if (mask[s] !== 1 || label[s] !== 0) continue;
    const id = next++;
    let head = 0;
    let tail = 0;
    queue[tail++] = s;
    label[s] = id;
    while (head < tail) {
      const i = queue[head++]!;
      const x = i % gw;
      for (let q = 0; q < 4; q++) {
        const j = q === 0 ? (x > 0 ? i - 1 : -1) : q === 1 ? (x < gw - 1 ? i + 1 : -1) : q === 2 ? i - gw : i + gw;
        if (j < 0 || j >= n || mask[j] !== 1 || label[j] !== 0) continue;
        label[j] = id;
        queue[tail++] = j;
      }
    }
    sizes.push(tail);
    if (tail > best) best = tail;
  }
  if (!best) return { score: 0, enclosed: 0 };
  const kept = new Uint8Array(next);
  let keptArea = 0;
  for (let id = 1; id < next; id++)
    if (sizes[id]! >= 0.25 * best && sizes[id]! >= 0.01 * n) {
      kept[id] = 1;
      keptArea += sizes[id]!;
    }
  // Holes: non-cloth components (marked −1…) whose every 4-neighbour is non-cloth or the main region,
  // that do not touch the frame edge, and whose size is that of a ball or a pocket: ≥ 2 × 2 cells (a
  // model whose value band cuts through the cloth's own shading leaves 1–3-cell speckle holes, which
  // must not make it look like a cloth full of balls), ≤ 2 % of the frame, and round.
  let holes = 0;
  let enclosed = 0;
  let speckle = 0;
  const maxHole = Math.max(4, 0.02 * n);
  for (let s = 0; s < n; s++) {
    if (label[s] !== 0) continue;
    if (mask[s] === 1) continue; // a stray cloth cell of another component
    let head = 0;
    let tail = 0;
    queue[tail++] = s;
    label[s] = -1;
    let edge = false;
    let foreign = false;
    let bx0 = gw;
    let bx1 = 0;
    let by0 = gh;
    let by1 = 0;
    while (head < tail) {
      const i = queue[head++]!;
      const x = i % gw;
      const y = (i - x) / gw;
      if (x < bx0) bx0 = x;
      if (x > bx1) bx1 = x;
      if (y < by0) by0 = y;
      if (y > by1) by1 = y;
      if (x === 0 || x === gw - 1 || i < gw || i >= n - gw) edge = true;
      const nb0 = x > 0 ? i - 1 : -1;
      const nb1 = x < gw - 1 ? i + 1 : -1;
      const nb2 = i >= gw ? i - gw : -1;
      const nb3 = i < n - gw ? i + gw : -1;
      for (let q = 0; q < 4; q++) {
        const j = q === 0 ? nb0 : q === 1 ? nb1 : q === 2 ? nb2 : nb3;
        if (j < 0) continue;
        if (mask[j] === 1) {
          if (!kept[label[j]!]) foreign = true;
        } else if (label[j] === 0) {
          label[j] = -1;
          queue[tail++] = j;
        }
      }
    }
    if (!edge && !foreign && tail < 4) speckle++;
    if (!edge && !foreign && tail >= 4) {
      enclosed++;
      // A ball's hole is a disc or an ellipse (bounding-box fill ≈ π/4, aspect ≤ 1:3 at a grazing view).
      const bw = bx1 - bx0 + 1;
      const bh = by1 - by0 + 1;
      if (tail <= maxHole && tail >= 0.5 * bw * bh && Math.max(bw, bh) <= 3 * Math.min(bw, bh)) holes++;
    }
  }
  // Speckle — enclosed 1–3-cell specks — marks a model whose band cuts through a surface's own
  // shading: a grey band wide enough to swallow the room, the floor and a charcoal cloth leaves hundreds
  // of specks (and speckle clumps that pass as holes); the cloth's own model leaves almost none.
  return { score: (holes + keptArea / n) / (1 + speckle / 10), enclosed };
}

/**
 * Cloth models for a table-level photo, most plausible first: each chromatic hue mode and each grey
 * value mode covering ≥ MIN_CANDIDATE_SHARE of the photo, ranked by structureScore. The overview's
 * cloth (`hint`) goes first when this photo has a candidate of that colour whose structure is at least
 * half as convincing as the best one; a neutral hint matches a neutral candidate, a chromatic hint one
 * within 25° of its hue (re-estimated in this photo: exposure and white balance differ between photos).
 */
export function learnPlayerCloth(frame: Frame, hint: ClothModel | null | undefined, sc: Scratch): PhotoCloth {
  const g = sampleGrid(frame);
  hueBins.fill(0);
  greyBins.fill(0);
  const n = g.gw * g.gh;
  let vSum = 0;
  let dark = 0;
  for (let i = 0; i < n; i++) {
    const s = g.S[i]!;
    const v = g.V[i]!;
    vSum += v;
    if (v < SAT_V) dark++;
    if (s > SAT_S && v > SAT_V) hueBins[Math.min(35, Math.floor(g.H[i]! / 10))]! += 1;
    else if (s < GREY_S && v > GREY_V0 && v < GREY_V1) greyBins[Math.min(63, Math.floor(v * 64))]! += 1;
  }
  const meanV = n ? vSum / n : 0;
  const darkFrac = n ? dark / n : 1;
  const minCount = MIN_CANDIDATE_SHARE * n;
  const found: { m: ClothModel; score: number; enclosed: number; hinted: boolean }[] = [];
  // Chromatic hue modes (3-bin windows), at least 30° apart.
  for (let b = 0; b < 36; b++) hueSmooth[b] = hueBins[(b + 35) % 36]! + hueBins[b]! + hueBins[(b + 1) % 36]!;
  const takenHue: number[] = [];
  for (let k = 0; k < MAX_CANDIDATES; k++) {
    let mb = -1;
    for (let b = 0; b < 36; b++) {
      if (hueSmooth[b]! < minCount) continue;
      if (takenHue.some((t) => Math.min(Math.abs(t - b), 36 - Math.abs(t - b)) < 3)) continue;
      if (mb < 0 || hueSmooth[b]! > hueSmooth[mb]!) mb = b;
    }
    if (mb < 0) break;
    takenHue.push(mb);
    const m = chromaticModel(g, mb * 10 + 5, minCount);
    if (m && m.val >= SAT_V) found.push({ m, score: 0, enclosed: 0, hinted: false });
  }
  // Grey value modes (5-bin windows), at least a factor 1.5 apart.
  for (let b = 0; b < 64; b++) {
    let s = 0;
    for (let d = -2; d <= 2; d++) if (b + d >= 0 && b + d < 64) s += greyBins[b + d]!;
    greySmooth[b] = s;
  }
  const takenGrey: number[] = [];
  for (let k = 0; k < 2; k++) {
    let mb = -1;
    for (let b = 0; b < 64; b++) {
      if (greySmooth[b]! < minCount) continue;
      const v = (b + 0.5) / 64;
      if (takenGrey.some((t) => Math.max(t / v, v / t) < 1.5)) continue;
      if (mb < 0 || greySmooth[b]! > greySmooth[mb]!) mb = b;
    }
    if (mb < 0) break;
    const v0 = (mb + 0.5) / 64;
    takenGrey.push(v0);
    const m = neutralModel(g, v0, minCount);
    if (m) found.push({ m, score: 0, enclosed: 0, hinted: false });
  }
  if (!found.length) return { models: [], enclosed: [], scores: [], meanV, darkFrac };
  for (const f of found) {
    const st = structureScore(g, f.m, sc);
    f.score = st.score;
    f.enclosed = st.enclosed;
  }
  if (hint) {
    // The hinted candidate: for a chromatic hint the nearest hue within 25°; for a neutral one the grey
    // closest in value and tint (|log V ratio| + |ΔS|·5), within a factor 1.6 in V (exposure may differ
    // between the photos, a grey floor beside a grey cloth usually differs more).
    let hi = -1;
    let hd = Infinity;
    for (let k = 0; k < found.length; k++) {
      const m = found[k]!.m;
      let d = Infinity;
      if (hint.kind === 'neutral') {
        if (m.kind === 'neutral' && Math.abs(Math.log(m.val / Math.max(1e-3, hint.val))) < Math.log(1.6)) d = Math.abs(Math.log(m.val / Math.max(1e-3, hint.val))) + 5 * Math.abs(m.sat - hint.sat);
      } else if (m.kind !== 'neutral' && hueDiff(m.hue, hint.hue) < 25) d = hueDiff(m.hue, hint.hue);
      if (d < hd) {
        hd = d;
        hi = k;
      }
    }
    if (hi >= 0) found[hi]!.hinted = true;
  }
  const top = Math.max(...found.map((f) => f.score));
  found.sort((a, b) => {
    const ah = a.hinted && a.score >= 0.5 * top ? 1 : 0;
    const bh = b.hinted && b.score >= 0.5 * top ? 1 : 0;
    return bh - ah || b.score - a.score;
  });
  const top3 = found.slice(0, 3);
  return { models: top3.map((f) => f.m), enclosed: top3.map((f) => f.enclosed), scores: top3.map((f) => f.score), meanV, darkFrac };
}

/** A ball whose (overview) colour reads as this cloth cannot be seen against it. */
export function camouflaged(rgb: [number, number, number], cloth: ClothModel): boolean {
  rgbToHsv(rgb[0], rgb[1], rgb[2], hsvTmp);
  if (cloth.kind === 'neutral') return isCloth(0, hsvTmp[1]!, hsvTmp[2]!, cloth);
  return hueDiff(hsvTmp[0]!, cloth.hue) < 25 && hsvTmp[1]! > 0.3 * cloth.sat && hsvTmp[2]! > 0.15;
}

// ---------------------------------------------------------------------------------------------------
// Linear algebra
// ---------------------------------------------------------------------------------------------------

/** Solve the n×n system A·x = b in place (Gaussian elimination, partial pivoting). Null if singular. */
export function solveN(A: Float64Array, b: Float64Array, n: number): Float64Array | null {
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(A[r * n + col]!) > Math.abs(A[piv * n + col]!)) piv = r;
    if (Math.abs(A[piv * n + col]!) < 1e-300) return null;
    if (piv !== col) {
      for (let c = 0; c < n; c++) {
        const t = A[col * n + c]!;
        A[col * n + c] = A[piv * n + c]!;
        A[piv * n + c] = t;
      }
      const t = b[col]!;
      b[col] = b[piv]!;
      b[piv] = t;
    }
    for (let r = col + 1; r < n; r++) {
      const k = A[r * n + col]! / A[col * n + col]!;
      if (k === 0) continue;
      for (let c = col; c < n; c++) A[r * n + c] = A[r * n + c]! - k * A[col * n + c]!;
      b[r] = b[r]! - k * b[col]!;
    }
  }
  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r]!;
    for (let c = r + 1; c < n; c++) s -= A[r * n + c]! * x[c]!;
    x[r] = s / A[r * n + r]!;
  }
  return x;
}


// ---------------------------------------------------------------------------------------------------
// Evidence: cloth mask, non-cloth components, cloth-boundary cracks
// ---------------------------------------------------------------------------------------------------

/** Non-cloth specks inside the cloth below this area (px) are noise (findCandidates needs ≥ 12 px). */
const SPECK_AREA = 10;

/**
 * Mask (0/1), main cloth region (2), non-cloth components and cloth-boundary cracks; `specks` counts the
 * non-cloth specks inside the cloth that were noise (joined to the cloth).
 */
export function buildEvidence(frame: Frame, cloth: ClothModel, sc: Scratch): { nCracks: number; comps: Comp[]; mainArea: number; specks: number } {
  const { w, h, mask, label, queue } = sc;
  const n = w * h;
  const data = frame.data;
  // isCloth() inlined (same thresholds: hue within HUE_TOL, s > 0.4·sat, v > 0.28·val); hue is only
  // computed for pixels that pass the cheap saturation and value tests.
  const vMin = 0.28 * cloth.val * 255;
  const sMin = 0.4 * cloth.sat;
  const hue0 = cloth.hue;
  if (cloth.kind === 'neutral') {
    // table-detect's neutral rule inlined: S < max(0.2, 1.6·sat), S > 0.7·sat for a tinted grey
    // (sat ≥ 0.08), 0.4·val < V < 1.3·val.
    const sHi = Math.max(0.2, 1.6 * cloth.sat);
    const sLo = cloth.sat < 0.08 ? -1 : 0.7 * cloth.sat;
    const vLo = 0.4 * cloth.val * 255;
    const vHi = 1.3 * cloth.val * 255;
    for (let i = 0; i < n; i++) {
      const r = data[i * 4]!;
      const g = data[i * 4 + 1]!;
      const b = data[i * 4 + 2]!;
      const mx = r > g ? (r > b ? r : b) : g > b ? g : b;
      const mn = r < g ? (r < b ? r : b) : g < b ? g : b;
      const d = mx - mn;
      mask[i] = mx > vLo && mx < vHi && d < sHi * mx && d > sLo * mx ? 1 : 0;
    }
  } else {
    for (let i = 0; i < n; i++) {
      const r = data[i * 4]!;
      const g = data[i * 4 + 1]!;
      const b = data[i * 4 + 2]!;
      const mx = r > g ? (r > b ? r : b) : g > b ? g : b;
      const mn = r < g ? (r < b ? r : b) : g < b ? g : b;
      const d = mx - mn;
      if (mx <= vMin || d <= sMin * mx || d === 0) {
        mask[i] = 0;
        continue;
      }
      let hh: number;
      if (mx === r) hh = 60 * (((g - b) / d) % 6);
      else if (mx === g) hh = 60 * ((b - r) / d + 2);
      else hh = 60 * ((r - g) / d + 4);
      if (hh < 0) hh += 360;
      let dh = Math.abs(hh - hue0) % 360;
      if (dh > 180) dh = 360 - dh;
      mask[i] = dh < HUE_TOL ? 1 : 0;
    }
  }
  // Cloth components: keep the largest (and any comparable one) as the main cloth region.
  label.fill(0);
  let next = 1;
  let bestSize = 0;
  const sizes: number[] = [0];
  for (let s = 0; s < n; s++) {
    if (mask[s] !== 1 || label[s] !== 0) continue;
    const id = next++;
    let head = 0;
    let tail = 0;
    queue[tail++] = s;
    label[s] = -id;
    while (head < tail) {
      const i = queue[head++]!;
      const x = i % w;
      if (x > 0 && mask[i - 1] === 1 && label[i - 1] === 0) {
        label[i - 1] = -id;
        queue[tail++] = i - 1;
      }
      if (x < w - 1 && mask[i + 1] === 1 && label[i + 1] === 0) {
        label[i + 1] = -id;
        queue[tail++] = i + 1;
      }
      if (i >= w && mask[i - w] === 1 && label[i - w] === 0) {
        label[i - w] = -id;
        queue[tail++] = i - w;
      }
      if (i < n - w && mask[i + w] === 1 && label[i + w] === 0) {
        label[i + w] = -id;
        queue[tail++] = i + w;
      }
    }
    sizes.push(tail);
    if (tail > bestSize) bestSize = tail;
  }
  const keep = new Uint8Array(next);
  let mainArea = 0;
  for (let id = 1; id < next; id++)
    if (sizes[id]! >= 0.25 * bestSize && sizes[id]! >= 0.01 * n) {
      keep[id] = 1;
      mainArea += sizes[id]!;
    }
  for (let i = 0; i < n; i++) {
    const l = label[i]!;
    mask[i] = l < 0 && keep[-l] ? 2 : 0;
  }
  // Non-cloth components (everything that is not main cloth), 4-connected.
  label.fill(0);
  const comps: Comp[] = [{ area: 0, minX: 0, maxX: 0, minY: 0, maxY: 0 }];
  next = 1;
  for (let s = 0; s < n; s++) {
    if (mask[s] === 2 || label[s] !== 0) continue;
    const id = next++;
    let head = 0;
    let tail = 0;
    queue[tail++] = s;
    label[s] = id;
    let minX = w;
    let maxX = 0;
    let minY = h;
    let maxY = 0;
    while (head < tail) {
      const i = queue[head++]!;
      const x = i % w;
      const y = (i - x) / w;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x > 0 && mask[i - 1] !== 2 && label[i - 1] === 0) {
        label[i - 1] = id;
        queue[tail++] = i - 1;
      }
      if (x < w - 1 && mask[i + 1] !== 2 && label[i + 1] === 0) {
        label[i + 1] = id;
        queue[tail++] = i + 1;
      }
      if (i >= w && mask[i - w] !== 2 && label[i - w] === 0) {
        label[i - w] = id;
        queue[tail++] = i - w;
      }
      if (i < n - w && mask[i + w] !== 2 && label[i + w] === 0) {
        label[i + w] = id;
        queue[tail++] = i + w;
      }
    }
    comps.push({ area: tail, minX, maxX, minY, maxY });
  }
  // Sensor-noise speckle: non-cloth specks inside the cloth smaller than any ball circle the detector
  // can fit (SPECK_AREA) are the cloth's own noisy pixels, not objects; left in, every speck adds four
  // cracks that no model element explains (noise σ 6 on a shaded cloth: thousands). Area opening: they
  // join the cloth (frame-edge specks may be cut-off objects and stay).
  let specks = 0;
  for (let id = 1; id < comps.length; id++) {
    const cp = comps[id]!;
    if (cp.area < SPECK_AREA && cp.minX > 0 && cp.minY > 0 && cp.maxX < w - 1 && cp.maxY < h - 1) {
      cp.area = -cp.area;
      specks++;
    }
  }
  if (specks)
    for (let i = 0; i < n; i++) {
      const l = label[i]!;
      if (l > 0 && comps[l]!.area < 0) {
        mask[i] = 2;
        label[i] = 0;
        mainArea++;
      }
    }
  for (let id = 1; id < comps.length; id++) if (comps[id]!.area < 0) comps[id]!.area = 0;
  // Cracks: unit edges between a main-cloth pixel and a non-cloth pixel, at the shared pixel border.
  const { crackX, crackY, crackL } = sc;
  let nc = 0;
  for (let y = 0; y < h && nc < MAX_CRACKS - 4; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (mask[i] !== 2) continue;
      if (x > 0 && mask[i - 1] !== 2) {
        crackX[nc] = x;
        crackY[nc] = y + 0.5;
        crackL[nc++] = label[i - 1]!;
      }
      if (x < w - 1 && mask[i + 1] !== 2) {
        crackX[nc] = x + 1;
        crackY[nc] = y + 0.5;
        crackL[nc++] = label[i + 1]!;
      }
      if (y > 0 && mask[i - w] !== 2) {
        crackX[nc] = x + 0.5;
        crackY[nc] = y;
        crackL[nc++] = label[i - w]!;
      }
      if (y < h - 1 && mask[i + w] !== 2) {
        crackX[nc] = x + 0.5;
        crackY[nc] = y + 1;
        crackL[nc++] = label[i + w]!;
      }
      if (nc >= MAX_CRACKS - 4) break;
    }
  }
  return { nCracks: nc, comps, mainArea, specks };
}

/** Histogram of clothNoise's chroma differences, in NOISE_BIN-level bins (module-level scratch). */
const dHist = new Uint32Array(256);
const NOISE_BIN = 0.25;
/** Median of |e| for e a 2-D Gaussian of σ² = 2 per axis (the chroma difference of two pixels of unit noise). */
const RAYLEIGH_MEDIAN = Math.SQRT2 * Math.sqrt(2 * Math.LN2);

/**
 * Sensor noise of the photo (σ per channel, 0–255 levels), read off the main cloth region after
 * buildEvidence, from what sensor noise changes and the scene does not: the chromaticity. For two cloth
 * pixels two apart on a row, c₁ and c₂, the part of c₂ − c₁ orthogonal to their mean colour is zero for
 * any change of brightness — the cloth's shading, a ball's shadow, and the cloth's own texture (a
 * reflectance pattern scales R, G and B alike) — while independent noise of σ per channel gives it a
 * 2-D Gaussian of 2σ² per axis, whose length has median σ·√2·√(2 ln 2). So the median length over that
 * constant is σ. (The cloth mask, which is what noise breaks, is a hue / saturation test: brightness
 * texture leaves it intact, chroma noise does not.) Pixels two apart are compared so that 4:2:0 chroma,
 * shared by a 2 × 2 block, is read across blocks: what is left of the chroma noise there is what the
 * mask sees. NaN when too little cloth is in view. With `wholeFrame`, every pair of the photo counts (for
 * a photo whose noise left no cloth region: its flat surfaces dominate the median, edges are few).
 */
export function clothNoise(frame: Frame, sc: Scratch, wholeFrame = false): number {
  const { w, h, mask } = sc;
  const d = frame.data;
  dHist.fill(0);
  let n = 0;
  for (let y = 0; y < h; y += 2)
    for (let x = 0; x + 2 < w; x++) {
      const i = y * w + x;
      if (!wholeFrame && (mask[i] !== 2 || mask[i + 2] !== 2)) continue;
      const r1 = d[i * 4]!;
      const g1 = d[i * 4 + 1]!;
      const b1 = d[i * 4 + 2]!;
      const r2 = d[i * 4 + 8]!;
      const g2 = d[i * 4 + 9]!;
      const b2 = d[i * 4 + 10]!;
      const sx = r1 + r2;
      const sy = g1 + g2;
      const sz = b1 + b2;
      const s2 = sx * sx + sy * sy + sz * sz;
      if (s2 < 4) continue;
      const dx = r2 - r1;
      const dy = g2 - g1;
      const dz = b2 - b1;
      const ds = dx * sx + dy * sy + dz * sz;
      const e2 = dx * dx + dy * dy + dz * dz - (ds * ds) / s2;
      const b = Math.floor(Math.sqrt(Math.max(0, e2)) / NOISE_BIN);
      dHist[b < 255 ? b : 255]! += 1;
      n++;
    }
  if (n < 200) return NaN;
  let acc = 0;
  for (let k = 0; k < 256; k++) {
    acc += dHist[k]!;
    if (acc >= 0.5 * n) {
      // Interpolate within the bin.
      const below = acc - dHist[k]!;
      return ((k + (0.5 * n - below) / Math.max(1, dHist[k]!)) * NOISE_BIN) / RAYLEIGH_MEDIAN;
    }
  }
  return NaN;
}

export interface Comp {
  area: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export interface Candidate {
  u: number;
  v: number;
  r: number;
  /** Arc coverage in degrees. */
  cov: number;
  comp: number;
  rgb: [number, number, number];
  /** Colour descriptor of the blob's pixels inside the circle. */
  col: ColourDesc;
  /** Cue-ball likelihood (higher = whiter, less coloured). */
  white: number;
  /** Proposed on the boundary of a large blob (the rail band, the floor, the room): an arc, maybe of a ball. */
  large: boolean;
}

/**
 * Colour descriptor robust to shading, exposure and stripes: the hue of the saturated pixels only, and
 * the fractions of saturated, dark and white pixels.
 */
export interface ColourDesc {
  hue: number;
  satFrac: number;
  darkFrac: number;
  whiteFrac: number;
}

/** Accumulates a ColourDesc pixel by pixel without allocating. */
export class ColourAcc {
  n = 0;
  hx = 0;
  hy = 0;
  sat = 0;
  dark = 0;
  white = 0;
  private hsv = [0, 0, 0];
  /** `vScale`: the photo's exposure relative to nominal (exposureScale); the V thresholds follow it. */
  constructor(private readonly vScale = 1) {}
  add(r: number, g: number, b: number): void {
    const hsv = this.hsv;
    rgbToHsv(r, g, b, hsv);
    this.n++;
    if (hsv[2]! < 0.18 * this.vScale) this.dark++;
    else if (hsv[1]! < 0.25) {
      if (hsv[2]! > 0.25 * this.vScale) this.white++;
    } else if (hsv[1]! > 0.35) {
      const a = (hsv[0]! * Math.PI) / 180;
      this.hx += Math.cos(a);
      this.hy += Math.sin(a);
      this.sat++;
    }
  }
  desc(): ColourDesc {
    let hue = (Math.atan2(this.hy, this.hx) * 180) / Math.PI;
    if (hue < 0) hue += 360;
    const n = Math.max(1, this.n);
    return { hue, satFrac: this.sat / n, darkFrac: this.dark / n, whiteFrac: this.white / n };
  }
}

// ---------------------------------------------------------------------------------------------------
// Ball circle candidates
// ---------------------------------------------------------------------------------------------------

interface Circle {
  x: number;
  y: number;
  r: number;
}

/** Algebraic (Kåsa) circle fit on the points idx[0..n) in centred coordinates. */
function kasa(X: Float32Array, Y: Float32Array, idx: Int32Array, n: number): Circle | null {
  if (n < 3) return null;
  let mx = 0;
  let my = 0;
  for (let q = 0; q < n; q++) {
    mx += X[idx[q]!]!;
    my += Y[idx[q]!]!;
  }
  mx /= n;
  my /= n;
  let suu = 0;
  let suv = 0;
  let svv = 0;
  let suuu = 0;
  let svvv = 0;
  let suvv = 0;
  let svuu = 0;
  for (let q = 0; q < n; q++) {
    const u = X[idx[q]!]! - mx;
    const v = Y[idx[q]!]! - my;
    suu += u * u;
    suv += u * v;
    svv += v * v;
    suuu += u * u * u;
    svvv += v * v * v;
    suvv += u * v * v;
    svuu += v * u * u;
  }
  const det = suu * svv - suv * suv;
  if (Math.abs(det) < 1e-9) return null;
  const b1 = 0.5 * (suuu + suvv);
  const b2 = 0.5 * (svvv + svuu);
  const uc = (b1 * svv - b2 * suv) / det;
  const vc = (suu * b2 - suv * b1) / det;
  const r2 = uc * uc + vc * vc + (suu + svv) / n;
  if (!(r2 > 0)) return null;
  return { x: uc + mx, y: vc + my, r: Math.sqrt(r2) };
}

/** Geometric circle refinement (Gauss–Newton on Σ(|p − c| − r)²). */
function refineCircle(X: Float32Array, Y: Float32Array, idx: Int32Array, n: number, c0: Circle): Circle {
  let a = c0.x;
  let b = c0.y;
  let r = c0.r;
  const A = new Float64Array(9);
  const g = new Float64Array(3);
  for (let it = 0; it < 6; it++) {
    A.fill(0);
    g.fill(0);
    for (let q = 0; q < n; q++) {
      const dx = X[idx[q]!]! - a;
      const dy = Y[idx[q]!]! - b;
      const d = hyp2(dx, dy) || 1e-9;
      const res = d - r;
      const j0 = -dx / d;
      const j1 = -dy / d;
      const j2 = -1;
      A[0] += j0 * j0;
      A[1] += j0 * j1;
      A[2] += j0 * j2;
      A[4] += j1 * j1;
      A[5] += j1 * j2;
      A[8] += j2 * j2;
      g[0] += j0 * res;
      g[1] += j1 * res;
      g[2] += j2 * res;
    }
    A[3] = A[1]!;
    A[6] = A[2]!;
    A[7] = A[5]!;
    for (let k = 0; k < 3; k++) g[k] = -g[k]!;
    const x = solveN(A, g, 3);
    if (!x) break;
    a += x[0]!;
    b += x[1]!;
    r += x[2]!;
    if (Math.abs(x[0]!) + Math.abs(x[1]!) + Math.abs(x[2]!) < 1e-4) break;
  }
  return { x: a, y: b, r };
}

const covBins = new Uint8Array(36);

/** Arc coverage (degrees, 10° bins) of the points around a centre. */
function coverage(X: Float32Array, Y: Float32Array, idx: Int32Array, n: number, cx: number, cy: number): number {
  covBins.fill(0);
  let cnt = 0;
  for (let q = 0; q < n; q++) {
    const a = Math.atan2(Y[idx[q]!]! - cy, X[idx[q]!]! - cx);
    const b = Math.min(35, Math.floor(((a + Math.PI) / (2 * Math.PI)) * 36));
    if (!covBins[b]) {
      covBins[b] = 1;
      cnt++;
    }
  }
  return cnt * 10;
}

/**
 * Ball arcs on the boundary of a large blob (rail, floor, background that balls touch from the cloth
 * side). Proposals: a Kåsa circle through the cracks near each seed crack, at neighbourhood sizes
 * ρ = 3·1.6^i px, kept when the neighbourhood is a clean arc (small RMS, ≥ 50° of it) of radius
 * 0.45ρ…2.5ρ. Every crack on a ball's arc proposes that ball at the matching scale, so a small far ball
 * is proposed as reliably as the near cue ball; random triples over the whole blob almost never land
 * on a 15 px arc among thousands of rail cracks. Proposals vote into (centre, radius) cells, and the
 * cells are verified most-voted first (support within the 6 %·r band over the whole blob, arc ≥ 120°,
 * dense support, refined), skipping those a verified circle already explains; verified circles are
 * ranked by support within a tight band and must not overlap.
 * Deterministic.
 */
/** Local-arc proposals a circle needs before it is verified (localCircles). */
const MIN_VOTES = 3;
/**
 * Cloth-bordered arc a circle on a large blob needs (as for compact blobs, contract R-24: ≥ 120°): a cue
 * ball in front of the target, its bottom cut off by the near cushion, shows ≈ 130° of arc.
 */
const LOCAL_MIN_ARC = 120;

function localCircles(X: Float32Array, Y: Float32Array, pts: Int32Array, n: number, rMin: number, rLimit: number): { c: Circle; cov: number }[] {
  if (n < 12) return [];
  const G = 8;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let q = 0; q < n; q++) {
    const x = X[pts[q]!]!;
    const y = Y[pts[q]!]!;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const gw = Math.floor((maxX - minX) / G) + 1;
  const gh = Math.floor((maxY - minY) / G) + 1;
  const cellOf = (q: number) => Math.floor((Y[pts[q]!]! - minY) / G) * gw + Math.floor((X[pts[q]!]! - minX) / G);
  const cStart = new Int32Array(gw * gh + 1);
  for (let q = 0; q < n; q++) cStart[cellOf(q) + 1]! += 1;
  for (let c = 0; c < gw * gh; c++) cStart[c + 1] = cStart[c + 1]! + cStart[c]!;
  const cFill = cStart.slice(0, gw * gh);
  const byCell = new Int32Array(n);
  for (let q = 0; q < n; q++) byCell[cFill[cellOf(q)]!++] = pts[q]!;
  const near = new Int32Array(n);
  let nNear = 0;
  const gather = (x: number, y: number, rad: number) => {
    nNear = 0;
    const cx0 = Math.max(0, Math.floor((x - rad - minX) / G));
    const cx1 = Math.min(gw - 1, Math.floor((x + rad - minX) / G));
    const cy0 = Math.max(0, Math.floor((y - rad - minY) / G));
    const cy1 = Math.min(gh - 1, Math.floor((y + rad - minY) / G));
    for (let cy = cy0; cy <= cy1; cy++)
      for (let cx = cx0; cx <= cx1; cx++)
        for (let q = cStart[cy * gw + cx]!; q < cStart[cy * gw + cx + 1]!; q++) {
          const k = byCell[q]!;
          if ((X[k]! - x) ** 2 + (Y[k]! - y) ** 2 <= rad * rad) near[nNear++] = k;
        }
  };
  // 1. Proposals (x, y, r, quality) from local arcs.
  const prop: number[] = [];
  for (let rho = 3; 0.45 * rho <= rLimit; rho *= 1.6) {
    if (2.5 * rho < rMin) continue;
    const stride = Math.max(1, Math.round(rho / 4));
    for (let q = 0; q < n; q += stride) {
      const a = byCell[q]!;
      gather(X[a]!, Y[a]!, rho);
      if (nNear < 6) continue;
      const c = kasa(X, Y, near, nNear);
      if (!c || c.r < Math.max(rMin, 0.45 * rho) || c.r > Math.min(rLimit, 2.5 * rho)) continue;
      let e2 = 0;
      for (let k = 0; k < nNear; k++) e2 += (hyp2(X[near[k]!]! - c.x, Y[near[k]!]! - c.y) - c.r) ** 2;
      const rms = Math.sqrt(e2 / nNear);
      if (rms > 0.6 + 0.03 * c.r || coverage(X, Y, near, nNear, c.x, c.y) < 50) continue;
      prop.push(c.x, c.y, c.r, nNear / (rms + 0.3));
    }
  }
  // 2. Votes: proposals of the same circle (centre within ¼ r, radius within ≈ 12 %) pool into one
  //    cell; a ball's arc proposes it from many of its cracks, a stray curve from one or two. A cell's
  //    support is the votes of its 3 × 3 × 3 neighbourhood (the proposals from two short arcs of one
  //    ball scatter across cell borders); cells with ≥ MIN_VOTES are verified, best-supported first,
  //    at their own mean circle.
  const cells = new Map<number, number>();
  const acc: number[] = []; // per cell: votes, Σq·x, Σq·y, Σq·r, Σq, radius bin, x cell, y cell
  const keyOf = (rb: number, xq: number, yq: number) => ((rb + 64) * 8192 + xq + 4096) * 8192 + yq + 4096;
  for (let i = 0; i < prop.length; i += 4) {
    const r = prop[i + 2]!;
    const q = Math.max(2, 0.25 * r);
    const rb = Math.round(Math.log(r) / 0.12);
    const xq = Math.floor(prop[i]! / q);
    const yq = Math.floor(prop[i + 1]! / q);
    const key = keyOf(rb, xq, yq);
    let c = cells.get(key);
    if (c === undefined) {
      c = acc.length;
      cells.set(key, c);
      acc.push(0, 0, 0, 0, 0, rb, xq, yq);
    }
    const wq = prop[i + 3]!;
    acc[c]! += 1;
    acc[c + 1]! += wq * prop[i]!;
    acc[c + 2]! += wq * prop[i + 1]!;
    acc[c + 3]! += wq * r;
    acc[c + 4]! += wq;
  }
  const support = new Float64Array(acc.length / 8);
  const order: number[] = [];
  for (let c = 0; c < acc.length; c += 8) {
    let v = 0;
    for (let dr = -1; dr <= 1; dr++)
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++) {
          const o = cells.get(keyOf(acc[c + 5]! + dr, acc[c + 6]! + dx, acc[c + 7]! + dy));
          if (o !== undefined) v += acc[o]!;
        }
    support[c / 8] = v;
    if (v >= MIN_VOTES) order.push(c);
  }
  order.sort((a, b) => support[b / 8]! - support[a / 8]! || acc[b]! - acc[a]! || a - b);
  // 3. Verification, most-voted first; a cell that repeats a verified or a rejected circle is skipped.
  type Hit = { c: Circle; tight: number; cov: number };
  const hits: Hit[] = [];
  const tried: number[] = [];
  const idx = new Int32Array(n);
  for (const c of order) {
    const ux = acc[c + 1]! / acc[c + 4]!;
    const uy = acc[c + 2]! / acc[c + 4]!;
    const r = acc[c + 3]! / acc[c + 4]!;
    let dup = false;
    // tried: (x, y, r, tolerance) — 30 % around a verified circle, 10 % around a rejected proposal.
    for (let t = 0; t < tried.length && !dup; t += 4) if (hyp2(tried[t]! - ux, tried[t + 1]! - uy) < tried[t + 3]! * tried[t + 2]! && Math.abs(tried[t + 2]! - r) < tried[t + 3]! * tried[t + 2]!) dup = true;
    if (dup) continue;
    tried.push(ux, uy, r, 0.1);
    gather(ux, uy, r + 3);
    const tol = Math.max(1.0, 0.06 * r);
    let m = 0;
    for (let k = 0; k < nNear; k++) if (Math.abs(hyp2(X[near[k]!]! - ux, Y[near[k]!]! - uy) - r) < tol) idx[m++] = near[k]!;
    if (m < 10) continue;
    const cov = coverage(X, Y, idx, m, ux, uy);
    if (cov < LOCAL_MIN_ARC || m < 0.5 * 1.27 * r * ((cov * Math.PI) / 180)) continue;
    // Refine on the inliers.
    const k2 = kasa(X, Y, idx, m);
    if (!k2) continue;
    const fit = refineCircle(X, Y, idx, m, k2);
    if (!(fit.r >= rMin && fit.r <= rLimit)) continue;
    gather(fit.x, fit.y, fit.r + 3);
    const tol2 = Math.max(1.0, 0.06 * fit.r);
    let m2 = 0;
    for (let k = 0; k < nNear; k++) if (Math.abs(hyp2(X[near[k]!]! - fit.x, Y[near[k]!]! - fit.y) - fit.r) < tol2) idx[m2++] = near[k]!;
    const cov2 = coverage(X, Y, idx, m2, fit.x, fit.y);
    if (cov2 < LOCAL_MIN_ARC || m2 < 0.5 * 1.27 * fit.r * ((cov2 * Math.PI) / 180)) continue;
    // Rank by support within a tight band: the 6 %·r band lets a too-large circle through the arcs of two
    // touching balls collect more points than either ball's true circle, the tight band does not.
    const tolT = Math.max(1.0, 0.025 * fit.r);
    let tight = 0;
    for (let k = 0; k < m2; k++) if (Math.abs(hyp2(X[idx[k]!]! - fit.x, Y[idx[k]!]! - fit.y) - fit.r) < tolT) tight++;
    hits.push({ c: fit, tight, cov: cov2 });
    tried.push(fit.x, fit.y, fit.r, 0.3);
  }
  hits.sort((p, q) => q.tight - p.tight);
  const out: { c: Circle; cov: number }[] = [];
  for (const hh of hits) if (out.every((o) => hyp2(o.c.x - hh.c.x, o.c.y - hh.c.y) > 0.8 * Math.max(o.c.r, hh.c.r))) out.push({ c: hh.c, cov: hh.cov });
  return out;
}

/** A large non-cloth blob (rail band, floor, the room): balls only show as arcs on its boundary. */
const isLargeBlob = (cp: Comp, w: number, h: number) => cp.area > 0.2 * w * h || cp.maxX - cp.minX > 0.5 * w || cp.maxY - cp.minY > 0.6 * h;

/** Largest ball radius looked for on a large blob, as a share of the image's long side. */
const BIG_BALL = 0.2;

/**
 * Exposure of a photo relative to the nominal one the colour thresholds (dark, white) were set on. It is
 * read off the balls, not the cloth: a light-blue or pale-green cloth is not an over-exposed photo (a
 * cloth-based scale took the cloth's albedo for exposure, raised the thresholds and lost the cue ball on
 * light cloths). The brightest part of the brightest ball circle — the lit side of the white cue ball,
 * or a specular highlight on any ball — sits near the top of the range in a well-exposed photo
 * (V ≈ BRIGHT_NOMINAL) and scales with exposure in an under-exposed one, whatever the cloth. Scaled
 * thresholds only ever go down (an under-exposed photo darkens the shaded side of the white cue ball
 * below the nominal "white" threshold); over-exposure clips the brightest ball at V = 1 and needs none.
 */
export const exposureOf = (brightV: number) => Math.max(MIN_EXPOSURE, Math.min(1, brightV / BRIGHT_NOMINAL));
/** V of the brightest 10 % of the brightest ball circle at nominal exposure (lit white ball / highlight). */
const BRIGHT_NOMINAL = 0.9;
const MIN_EXPOSURE = 0.5;

/** Per-circle V histogram (64 bins) for the brightest-part estimate (module-level scratch). */
const vHist = new Uint32Array(64);

/** Crack colour classes: 0 dark, 1 white, 2–7 hue sextants (findCandidates' colour split). */
const N_CLS = 8;
const clsCount = new Int32Array(N_CLS);
let crackCls = new Int8Array(1024);
const clsHsv = [0, 0, 0];

/**
 * Colour class of the blob pixel two pixels inside crack q (away from the cloth pixel it borders; the
 * pixel on the crack itself mixes with the cloth), or −1 when that pixel is not blob k's.
 */
function crackClass(frame: Frame, sc: Scratch, q: number, k: number): number {
  const { w, h, mask, label, crackX, crackY } = sc;
  const cx = crackX[q]!;
  const cy = crackY[q]!;
  let x: number;
  let y: number;
  let dx = 0;
  let dy = 0;
  if (Number.isInteger(cx)) {
    // Vertical edge between pixels (cx − 1, y) and (cx, y).
    y = Math.floor(cy);
    const left = cx - 1;
    if (left >= 0 && mask[y * w + left] !== 2) {
      x = left;
      dx = -1;
    } else {
      x = cx;
      dx = 1;
    }
  } else {
    x = Math.floor(cx);
    const up = cy - 1;
    if (up >= 0 && mask[up * w + x] !== 2) {
      y = up;
      dy = -1;
    } else {
      y = cy;
      dy = 1;
    }
  }
  for (let step = 2; step >= 0; step--) {
    const xx = x + dx * step;
    const yy = y + dy * step;
    if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
    const i = yy * w + xx;
    if (label[i] !== k || mask[i] === 2) continue;
    const d = frame.data;
    rgbToHsv(d[i * 4]!, d[i * 4 + 1]!, d[i * 4 + 2]!, clsHsv);
    if (clsHsv[2]! < 0.2) return 0;
    if (clsHsv[1]! < 0.25) return 1;
    return 2 + (Math.floor((clsHsv[0]! + 30) / 60) % 6);
  }
  return -1;
}

/** Extra output of findCandidates. */
export interface CandidateInfo {
  /** The photo's exposure relative to nominal (exposureOf), as used for the colour thresholds. */
  exposure: number;
}

/**
 * Circles in the cloth-bordered boundary of each compact non-cloth blob: one Kåsa fit when it explains
 * the blob, else deterministic RANSAC that peels off up to four circles (balls overlapping in depth);
 * local-arc proposals on large blobs. Each circle's colour comes from its own blob's pixels inside 0.8 r
 * that no nearer circle covers: of two equal balls overlapping in the image the nearer has the larger
 * image radius, and the overlap is its surface (a red ball in front of the cue ball must not tint it).
 */
export function findCandidates(frame: Frame, sc: Scratch, comps: Comp[], nCracks: number, opts: { info?: CandidateInfo } = {}): Candidate[] {
  const { w, h, crackX, crackY, crackL, mask, label } = sc;
  const nComp = comps.length;
  const start = new Int32Array(nComp + 1);
  for (let q = 0; q < nCracks; q++) start[crackL[q]! + 1]! += 1;
  for (let k = 0; k < nComp; k++) start[k + 1] = start[k + 1]! + start[k]!;
  const fill = start.slice(0, nComp);
  const order = new Int32Array(nCracks);
  for (let q = 0; q < nCracks; q++) order[fill[crackL[q]!]!++] = q;

  const rMax = 0.3 * Math.max(w, h);
  const out: Candidate[] = [];
  const pts = new Int32Array(Math.max(16, nCracks));
  const inl = new Int32Array(Math.max(16, nCracks));
  const hsv = [0, 0, 0];
  const raw: { c: Circle; cov: number; k: number; large: boolean }[] = [];
  if (crackCls.length < nCracks) crackCls = new Int8Array(nCracks);
  for (let k = 1; k < nComp; k++) {
    const cp = comps[k]!;
    const n0 = start[k + 1]! - start[k]!;
    if (cp.area < 12 || n0 < 10) continue;
    let n = n0;
    for (let q = 0; q < n; q++) pts[q] = order[start[k]! + q]!;
    // A circle with a cloth-bordered arc of ≥ 120° has a chord ≥ √3·r inside the blob, so r ≤ diag/√3
    // (diag/1.5 leaves slack for the arc's blur). Without this cap, RANSAC on a blob of two touching
    // balls prefers a huge circle whose 6 %·r tolerance band swallows most of the blob.
    const rBlob = Math.min(rMax, Math.max(4, hyp2(cp.maxX - cp.minX + 1, cp.maxY - cp.minY + 1) / 1.5));
    const circles: { c: Circle; cov: number }[] = [];
    if (isLargeBlob(cp, w, h)) {
      // A large blob (rail, floor, background): balls touching it from the cloth side show up as arcs
      // on its cloth-bordered boundary, far balls of a few px up to the near cue ball (0.3 m from a
      // 28°-HFOV lens it is ≈ BIG_BALL of the long side).
      circles.push(...localCircles(crackX, crackY, pts, n, 2.5, BIG_BALL * Math.max(w, h)));
      n = 0;
    }
    let seed = (2463534242 ^ Math.imul(k, 2654435761)) >>> 0;
    const rand = (m: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % m;
    };
    const tolOf = (r: number) => Math.max(1.0, 0.06 * r);
    // Deterministic RANSAC that peels up to four circles off the cracks pts[0..n), radius ≤ rLim.
    const peel = (n: number, rLim: number, out: { c: Circle; cov: number }[]) => {
      const countIn = (c: Circle) => {
        const tol = tolOf(c.r);
        let m = 0;
        for (let q = 0; q < n; q++) if (Math.abs(hyp2(crackX[pts[q]!]! - c.x, crackY[pts[q]!]! - c.y) - c.r) < tol) m++;
        return m;
      };
      for (let round = 0; round < 4 && n >= 10; round++) {
        let best: Circle | null = null;
        let bestIn = 0;
        const all = kasa(crackX, crackY, pts, n);
        if (all && all.r >= 2.5 && all.r <= rLim) {
          best = all;
          bestIn = countIn(all);
        }
        if (!best || bestIn < 0.9 * n) {
          const iters = Math.min(250, 20 + n);
          for (let it = 0; it < iters; it++) {
            const a = pts[rand(n)]!;
            const b = pts[rand(n)]!;
            const c = pts[rand(n)]!;
            const ax = crackX[a]!;
            const ay = crackY[a]!;
            const bx = crackX[b]!;
            const by = crackY[b]!;
            const cx2 = crackX[c]!;
            const cy2 = crackY[c]!;
            const d = 2 * (ax * (by - cy2) + bx * (cy2 - ay) + cx2 * (ay - by));
            if (Math.abs(d) < 1e-6) continue;
            const a2 = ax * ax + ay * ay;
            const b2 = bx * bx + by * by;
            const c2 = cx2 * cx2 + cy2 * cy2;
            const ux = (a2 * (by - cy2) + b2 * (cy2 - ay) + c2 * (ay - by)) / d;
            const uy = (a2 * (cx2 - bx) + b2 * (ax - cx2) + c2 * (bx - ax)) / d;
            const r = hyp2(ax - ux, ay - uy);
            if (r < 2.5 || r > rLim) continue;
            const cand = { x: ux, y: uy, r };
            const m = countIn(cand);
            if (m > bestIn) {
              bestIn = m;
              best = cand;
            }
          }
        }
        if (!best) break;
        // Refine on the inliers (repeatedly: the inlier set grows as the fit improves).
        let fit: Circle = best;
        let ni = 0;
        for (let pass = 0; pass < 3; pass++) {
          const tol = 1.5 * tolOf(fit.r);
          let m = 0;
          for (let q = 0; q < n; q++) if (Math.abs(hyp2(crackX[pts[q]!]! - fit.x, crackY[pts[q]!]! - fit.y) - fit.r) < tol) inl[m++] = pts[q]!;
          if (m < 8) break;
          const k2 = kasa(crackX, crackY, inl, m);
          if (!k2) break;
          const g2 = refineCircle(crackX, crackY, inl, m, k2);
          if (!(g2.r >= 2.5 && g2.r <= rLim)) break;
          fit = g2;
          ni = m;
        }
        if (ni < 8) break;
        const cov = coverage(crackX, crackY, inl, ni, fit.x, fit.y);
        const expected = 1.27 * fit.r * ((cov * Math.PI) / 180);
        if (cov >= 120 && ni >= Math.max(8, 0.45 * expected)) out.push({ c: fit, cov });
        // Remove this circle's points and look for the next one in the rest of the blob.
        const tol = 1.5 * tolOf(fit.r);
        let m = 0;
        for (let q = 0; q < n; q++) if (!(Math.abs(hyp2(crackX[pts[q]!]! - fit.x, crackY[pts[q]!]! - fit.y) - fit.r) < tol)) pts[m++] = pts[q]!;
        if (m === n) break;
        n = m;
      }
    };
    if (n >= 10) {
      peel(n, rBlob, circles);
      // Balls of different colours that touch in the image (a red ball in front of the cue ball) form one
      // blob whose outline no single circle fits, and the whole-blob fit can be a large circle around
      // the pair. Each crack's colour class (the blob pixel just inside it: dark, white or a hue sextant)
      // tells the balls apart: every class with an arc of its own is peeled on its own cracks too, with
      // the radius cap of its own extent.
      let nCls = 0;
      clsCount.fill(0);
      for (let q = 0; q < n0; q++) {
        const cl = crackClass(frame, sc, order[start[k]! + q]!, k);
        crackCls[q] = cl;
        if (cl >= 0 && clsCount[cl]!++ === 9) nCls++;
      }
      if (nCls >= 2)
        for (let cl = 0; cl < N_CLS; cl++) {
          if (clsCount[cl]! < 10) continue;
          let m = 0;
          let bx0 = Infinity;
          let bx1 = -Infinity;
          let by0 = Infinity;
          let by1 = -Infinity;
          for (let q = 0; q < n0; q++) {
            if (crackCls[q] !== cl) continue;
            const id = order[start[k]! + q]!;
            pts[m++] = id;
            bx0 = Math.min(bx0, crackX[id]!);
            bx1 = Math.max(bx1, crackX[id]!);
            by0 = Math.min(by0, crackY[id]!);
            by1 = Math.max(by1, crackY[id]!);
          }
          const sub: { c: Circle; cov: number }[] = [];
          peel(m, Math.min(rBlob, Math.max(4, hyp2(bx1 - bx0 + 1, by1 - by0 + 1) / 1.5)), sub);
          for (const cc of sub)
            if (circles.every((o) => hyp2(o.c.x - cc.c.x, o.c.y - cc.c.y) > 0.3 * Math.max(o.c.r, cc.c.r) || Math.abs(o.c.r - cc.c.r) > 0.25 * Math.max(o.c.r, cc.c.r))) circles.push(cc);
        }
    }
    const large = isLargeBlob(cp, w, h);
    for (const { c, cov } of circles) raw.push({ c, cov, k, large });
  }
  // Sectors (10°) of each circle where it borders the cloth (its inlier cracks, ± one sector). Where it
  // does not, something else is in front of it or beside it — a nearer ball whose circle was not found,
  // the rail, the frame edge — so its pixels there may not be this ball's.
  const sectors = new Uint8Array(raw.length * 36);
  for (let q = 0; q < raw.length; q++) {
    const { c, k } = raw[q]!;
    const tol = 1.5 * Math.max(1.0, 0.06 * c.r);
    for (let t = start[k]!; t < start[k + 1]!; t++) {
      const id = order[t]!;
      const dx = crackX[id]! - c.x;
      const dy = crackY[id]! - c.y;
      if (Math.abs(Math.sqrt(dx * dx + dy * dy) - c.r) >= tol) continue;
      const b = Math.min(35, Math.floor(((Math.atan2(dy, dx) + Math.PI) / (2 * Math.PI)) * 36));
      sectors[q * 36 + b] = 1;
      sectors[q * 36 + ((b + 1) % 36)] = 1;
      sectors[q * 36 + ((b + 35) % 36)] = 1;
    }
  }
  // Is pixel (x, y) of circle q not this ball's: covered by a nearer (larger) circle of the same blob, or
  // in a sector where the circle does not border the cloth?
  const hidden = (q: number, x: number, y: number): boolean => {
    const a = raw[q]!;
    const ax = x + 0.5 - a.c.x;
    const ay = y + 0.5 - a.c.y;
    // Pixels near the centre are this ball's whatever is beside it.
    if (ax * ax + ay * ay > 0.09 * a.c.r * a.c.r && !sectors[q * 36 + Math.min(35, Math.floor(((Math.atan2(ay, ax) + Math.PI) / (2 * Math.PI)) * 36))]) return true;
    for (let o = 0; o < raw.length; o++) {
      const b = raw[o]!;
      if (o === q || b.k !== a.k || b.c.r <= a.c.r) continue;
      // A circle that contains this one is no nearer ball (it would hide this one entirely).
      if (hyp2(a.c.x - b.c.x, a.c.y - b.c.y) < b.c.r - a.c.r) continue;
      const dx = x + 0.5 - b.c.x;
      const dy = y + 0.5 - b.c.y;
      if (dx * dx + dy * dy < b.c.r * b.c.r) return true;
    }
    return false;
  };
  // 1. Exposure from the brightest part of the brightest circle.
  let brightV = 0;
  for (let q = 0; q < raw.length; q++) {
    const { c, k } = raw[q]!;
    vHist.fill(0);
    let cnt = 0;
    const rr = 0.8 * c.r;
    const x0 = Math.max(0, Math.floor(c.x - rr));
    const x1 = Math.min(w - 1, Math.ceil(c.x + rr));
    const y0 = Math.max(0, Math.floor(c.y - rr));
    const y1 = Math.min(h - 1, Math.ceil(c.y + rr));
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        if ((x + 0.5 - c.x) ** 2 + (y + 0.5 - c.y) ** 2 > rr * rr) continue;
        const i = y * w + x;
        if (mask[i] === 2 || label[i] !== k || hidden(q, x, y)) continue;
        const d = frame.data;
        const mx = Math.max(d[i * 4]!, d[i * 4 + 1]!, d[i * 4 + 2]!);
        vHist[mx >> 2]! += 1;
        cnt++;
      }
    if (cnt < 5) continue;
    let accN = 0;
    for (let b = 63; b >= 0; b--) {
      accN += vHist[b]!;
      if (accN >= 0.1 * cnt) {
        brightV = Math.max(brightV, (b * 4 + 2) / 255);
        break;
      }
    }
  }
  // …and of every compact blob (a ball whose circle was not found, e.g. one merged with its neighbour,
  // still shows its lit side): a missed white ball must not read as an under-exposed photo.
  for (let k = 1; k < nComp && brightV < BRIGHT_NOMINAL; k++) {
    const cp = comps[k]!;
    if (cp.area < 12 || isLargeBlob(cp, w, h)) continue;
    vHist.fill(0);
    let cnt = 0;
    const d = frame.data;
    for (let y = cp.minY; y <= cp.maxY; y++)
      for (let x = cp.minX; x <= cp.maxX; x++) {
        const i = y * w + x;
        if (label[i] !== k || mask[i] === 2) continue;
        vHist[Math.max(d[i * 4]!, d[i * 4 + 1]!, d[i * 4 + 2]!) >> 2]! += 1;
        cnt++;
      }
    let accN = 0;
    for (let b = 63; b >= 0; b--) {
      accN += vHist[b]!;
      if (accN >= 0.1 * cnt) {
        brightV = Math.max(brightV, (b * 4 + 2) / 255);
        break;
      }
    }
  }
  const vScale = exposureOf(brightV);
  if (opts.info) opts.info.exposure = vScale;
  // 2. Colour descriptors with the exposure-scaled thresholds.
  const acc = new ColourAcc(vScale);
  for (let q = 0; q < raw.length; q++) {
    const { c, cov, k, large } = raw[q]!;
    {
      // Mean colour and colour descriptor of this blob's pixels inside 0.8 r that no nearer circle covers.
      let cnt = 0;
      let sr = 0;
      let sg = 0;
      let sb = 0;
      let white = 0;
      let colored = 0;
      let sSum = 0;
      acc.n = acc.hx = acc.hy = acc.sat = acc.dark = acc.white = 0;
      const rr = 0.8 * c.r;
      const x0 = Math.max(0, Math.floor(c.x - rr));
      const x1 = Math.min(w - 1, Math.ceil(c.x + rr));
      const y0 = Math.max(0, Math.floor(c.y - rr));
      const y1 = Math.min(h - 1, Math.ceil(c.y + rr));
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) {
          if ((x + 0.5 - c.x) ** 2 + (y + 0.5 - c.y) ** 2 > rr * rr) continue;
          const i = y * w + x;
          if (mask[i] === 2 || label[i] !== k || hidden(q, x, y)) continue;
          const R0 = frame.data[i * 4]!;
          const G0 = frame.data[i * 4 + 1]!;
          const B0 = frame.data[i * 4 + 2]!;
          rgbToHsv(R0, G0, B0, hsv);
          acc.add(R0, G0, B0);
          sr += R0;
          sg += G0;
          sb += B0;
          sSum += hsv[1]!;
          if (hsv[1]! < 0.28 && hsv[2]! > 0.22 * vScale) white++;
          if (hsv[1]! > 0.45 && hsv[2]! > 0.12 * vScale) colored++;
          cnt++;
        }
      if (cnt < 5) continue;
      const mr = sr / cnt;
      const mg = sg / cnt;
      const mb = sb / cnt;
      const mx = Math.max(mr, mg, mb);
      const meanSat = mx > 0 ? (mx - Math.min(mr, mg, mb)) / mx : 0;
      out.push({
        u: c.x,
        v: c.y,
        r: c.r,
        cov,
        comp: k,
        rgb: [mr, mg, mb],
        col: acc.desc(),
        white: white / cnt - 2.5 * (colored / cnt) - 2 * meanSat - 0.25 * (sSum / cnt),
        large,
      });
    }
  }
  return out;
}

