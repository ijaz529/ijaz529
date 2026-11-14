/**
 * Ball detection (research.md R-04):
 *  1. Rectify the image through H_R, the homography of the plane at ball-centre height. A ball's
 *     silhouette then projects to a blob centred on its true (X, Y), elongated by ≈1/sin(elevation)
 *     toward the camera (parallax corrected to first order). Scaling the along-view axis by
 *     sin(elevation) ("de-stretching") turns every silhouette into a disc of radius R.
 *  2. Mark non-cloth pixels: the table detector's loose cloth test, tightened by the cloth's own
 *     saturation spread so cloth-hued balls (snooker green, pool 6) still stand out. In the pocket
 *     throats only hole-like (dark) pixels are masked, as "unknown" (neither ball nor cloth).
 *  3. Connected blobs (small holes filled) → strip long thin attachments (a cue stick) → count and
 *     place balls with a disc model in the de-stretched frame (multi-start, local search; a ball whose
 *     silhouette adds nothing to the blob is not counted) → fit a circle to each ball's visible
 *     silhouette boundary (occluded and unknown edges excluded).
 *  4. Shape gate (fill, aspect, size, shading) rejects lamp glare and sticks.
 *  5. Colour: robust hue/brightness name from the table's palette; the cue ball is the whitest COMPLETE
 *     ball with a clear margin over the runner-up, otherwise no ball is flagged (the app then asks the
 *     player to tap the cue ball, spec edge case).
 *
 * Known limits (Constitution II): a ball whose silhouette is entirely inside its neighbours' (the
 * middle of a pack seen from low down) cannot be counted from the silhouette; a stripe whose band
 * is edge-on to the camera looks exactly like the cue ball.
 *
 * All per-pixel work runs on module-level typed arrays reused across frames (Constitution IV).
 * Thresholds below are image-processing tunables, not physical constants. ASSUMPTION: values were
 * tuned on the ray-traced fixtures (tests/unit/vision) and carry no external source.
 */
import type { TableSpec } from '../core/types';
import type { Vec2 } from '../core/vec';
import type { Calibration } from './calibration';
import { applyH, type Mat3 } from './homography';
import { hueDiff, rgbToHsv, sampleRgb, type Frame } from './image';
import { isCloth, type ClothModel } from './table-detect';

export interface DetectedBall {
  /** Table coordinates (m) of the ball centre. */
  pos: Vec2;
  /** Image position (px) of the ball centre. */
  image: Vec2;
  isCue: boolean;
  score: number;
  rgb: [number, number, number];
  label: string;
  /** Cue-ball likelihood score (diagnostic). */
  white: number;
  /** Pixel count of the ball's blob in the rectified image. */
  px: number;
}

export interface BallDetectOptions {
  /** Rectified pixels per metre (auto when omitted). */
  scale?: number;
  /** Colour names to use. Default: 'snooker' on snooker tables, otherwise 'pool'. */
  palette?: 'pool' | 'snooker';
}

export interface Rectified {
  w: number;
  h: number;
  scale: number;
  x0: number;
  y0: number;
  rgb: Float32Array;
  nonCloth: Uint8Array;
}

// --- tunables (ASSUMPTION: tuned on the synthetic fixtures, see header) ----------------------------

/**
 * Cloth pixels more saturated than the cloth's p95 S plus max(this, 2 × (p95 − p50)) plus one 8-bit
 * quantisation step of relative error are a cloth-hued ball, not cloth.
 */
const CLOTH_S_MARGIN = 0.04;
/** Need this many cloth pixels before trusting the cloth's S spread. */
const CLOTH_STATS_MIN = 500;
/** In a pocket throat, pixels darker than this × cloth V count as hole (unknown). */
const THROAT_V = 0.5;
/** Blobs smaller than this × πR²(px) are specks. */
const MIN_BLOB = 0.3;
/** Thin-part strip: opening by a disc of this × R (chamfer distance); a ball's core survives, a stick's not. */
const THIN_R = 0.5;
/** Strip only if pixels beyond twice that radius from the core add up to this × the ball area. */
const THIN_MIN = 0.15;
/** Two real balls are at least 2R apart; centres closer than this × R are one ball. */
const MIN_SEP = 1.7;
/** Hard floor for centres split from one blob (the disc fit's lattice and erosion can shave a little). */
const MIN_SEP_SPLIT = 1.5;
/** Disc model: one more ball must lower the cost (uncovered + phantom cells) by this × πR². */
const DISC_GAIN = 0.1;
/** Shape gate: fill of the predicted silhouette, aspect tolerance, single-ball minimum area. */
const MIN_FILL = 0.7;
const ASPECT_TOL = 0.35;
const MIN_SINGLE_AREA = 0.5;
/** A blob whose boundary touches unknown pixels (throat, frame edge, stick) this much is truncated. */
const TRUNC_FRAC = 0.12;
/** Cue ball: completeness, minimum white score, luminance spread, margin over the runner-up. */
const CUE_FILL = 0.7;
const CUE_MIN_WHITE = 0.05;
const CUE_SPREAD = 0.15;
const CUE_MARGIN = 0.15;
/** Any ball: luminance spread p90 − p10 at least this × p90 (shading); flat bright blobs are glare. */
const FLAT_SPREAD = 0.25;
/** Tint: saturation above this but ≤ 0.4, hue away from the cloth; weighted into the cue score. */
const TINT_S = 0.12;
const TINT_W = 1.5;
/** Most balls one blob may hold (a full snooker pack is 15 reds; a pool rack 15). */
const K_MAX = 22;

// --- colour names ---------------------------------------------------------------------------------

interface Swatch {
  name: string;
  hue: number;
  vMin?: number;
  vMax?: number;
  sMin?: number;
  sMax?: number;
}
/** Prototype hues of the ball sets (measured on the synthetic pigments, typical of real balls). */
const POOL_SWATCHES: Swatch[] = [
  { name: 'red', hue: 0, vMin: 0.45 },
  { name: 'maroon', hue: 0, vMax: 0.45 },
  { name: 'orange', hue: 24 },
  { name: 'yellow', hue: 48 },
  { name: 'green', hue: 140 },
  { name: 'blue', hue: 224 },
  { name: 'purple', hue: 278 },
];
const SNOOKER_SWATCHES: Swatch[] = [
  { name: 'red', hue: 0, sMin: 0.65 },
  { name: 'pink', hue: 343, sMax: 0.7, vMin: 0.6 },
  { name: 'brown', hue: 26, vMax: 0.55 },
  { name: 'yellow', hue: 48, vMin: 0.45 },
  { name: 'green', hue: 140 },
  { name: 'blue', hue: 224 },
];
/** Best and runner-up swatch hues closer than this → the neutral name 'ball'. */
const NAME_MARGIN = 8;

function colourName(sw: Swatch[], h: number, s: number, v: number): string {
  let best: Swatch | null = null;
  let bd = Infinity;
  let second = Infinity;
  for (let i = 0; i < sw.length; i++) {
    const e = sw[i]!;
    if ((e.vMin !== undefined && v < e.vMin) || (e.vMax !== undefined && v >= e.vMax)) continue;
    if ((e.sMin !== undefined && s < e.sMin) || (e.sMax !== undefined && s > e.sMax)) continue;
    const d = hueDiff(h, e.hue);
    if (d < bd) {
      second = bd;
      bd = d;
      best = e;
    } else if (d < second) second = d;
  }
  if (!best || bd > 45 || second - bd < NAME_MARGIN) return 'ball';
  return best.name;
}

// --- scratch (Constitution IV: reused across frames, grown only when needed) ----------------------

interface Scratch {
  cap: number;
  rgb: Float32Array;
  hue: Float32Array;
  sat: Float32Array;
  val: Float32Array;
  nonCloth: Uint8Array;
  /** 1 = unknown: outside the frame, or a hole-like pixel in a pocket throat. */
  unknown: Uint8Array;
  er: Uint8Array;
  mask: Uint8Array;
  label: Int32Array;
  queue: Int32Array;
  /** Per blob pixel: de-stretched (u, v); owning ball. */
  bcap: number;
  dq: Float64Array;
  assign: Int32Array;
  dmin: Float64Array;
  /** Local grids (bbox / de-stretched). */
  gcap: number;
  grid: Uint8Array;
  dist: Uint16Array;
  dist2: Uint16Array;
  /** Silhouette edge points (u, v). */
  ecap: number;
  edge: Float64Array;
  eown: Int32Array;
}

let SCRATCH: Scratch | null = null;

function scratchFor(n: number): Scratch {
  if (SCRATCH && SCRATCH.cap >= n) return SCRATCH;
  const cap = Math.ceil(n * 1.1);
  const prev = SCRATCH;
  SCRATCH = {
    cap,
    rgb: new Float32Array(cap * 3),
    hue: new Float32Array(cap),
    sat: new Float32Array(cap),
    val: new Float32Array(cap),
    nonCloth: new Uint8Array(cap),
    unknown: new Uint8Array(cap),
    er: new Uint8Array(cap),
    mask: new Uint8Array(cap),
    label: new Int32Array(cap),
    queue: new Int32Array(cap),
    bcap: prev?.bcap ?? 0,
    dq: prev?.dq ?? new Float64Array(0),
    assign: prev?.assign ?? new Int32Array(0),
    dmin: prev?.dmin ?? new Float64Array(0),
    gcap: prev?.gcap ?? 0,
    grid: prev?.grid ?? new Uint8Array(0),
    dist: prev?.dist ?? new Uint16Array(0),
    dist2: prev?.dist2 ?? new Uint16Array(0),
    ecap: prev?.ecap ?? 0,
    edge: prev?.edge ?? new Float64Array(0),
    eown: prev?.eown ?? new Int32Array(0),
  };
  return SCRATCH;
}

function growBlob(S: Scratch, n: number): void {
  if (S.bcap >= n) return;
  S.bcap = Math.ceil(n * 1.5);
  S.dq = new Float64Array(S.bcap * 2);
  S.assign = new Int32Array(S.bcap);
  S.dmin = new Float64Array(S.bcap);
}

function growGrid(S: Scratch, n: number): void {
  if (S.gcap >= n) return;
  S.gcap = Math.ceil(n * 1.5);
  S.grid = new Uint8Array(S.gcap);
  S.dist = new Uint16Array(S.gcap);
  S.dist2 = new Uint16Array(S.gcap);
}

function growEdge(S: Scratch, n: number): void {
  if (S.ecap >= n) return;
  S.ecap = Math.ceil(n * 1.5);
  S.edge = new Float64Array(S.ecap * 2);
  S.eown = new Int32Array(S.ecap);
}

// Small fixed buffers.
const RGB3 = [0, 0, 0];
const HSV = [0, 0, 0];
const CLOTH_HIST = new Float64Array(64);
const VHIST = new Float64Array(32);
const HUEHIST = new Float64Array(36);
const GHIST = new Float64Array(32);
const THROAT = new Float64Array(8 * 6);
const CENT = new Float64Array(K_MAX * 2);
const TRIAL = new Float64Array(K_MAX * 2);
const BEST = new Float64Array(K_MAX * 2);
const PRE = new Float64Array(K_MAX * 2);
const SUMX = new Float64Array(K_MAX);
const SUMY = new Float64Array(K_MAX);
const CNT = new Float64Array(K_MAX);
const SUBS = new Int32Array(64 * 3);
const BIG = 60000;

// --- rectification -------------------------------------------------------------------------------

interface RectGeo {
  w: number;
  h: number;
  scale: number;
  hx: number;
  hy: number;
}

function rectGeometry(calib: Calibration, table: TableSpec, opts: BallDetectOptions): RectGeo {
  const R = table.ballRadius;
  const hx = table.length / 2 + R;
  const hy = table.width / 2 + R;
  let scale = opts.scale ?? 0;
  if (!scale) {
    // Match the densest image sampling of any table side (near rails are the densest).
    const a = applyH(calib.HR, -hx, -hy);
    const b = applyH(calib.HR, hx, -hy);
    const c = applyH(calib.HR, hx, hy);
    const d = applyH(calib.HR, -hx, hy);
    const dd = (p: Vec2, q: Vec2) => Math.hypot(p.x - q.x, p.y - q.y);
    const px = Math.max(dd(a, b) / (2 * hx), dd(d, c) / (2 * hx), dd(b, c) / (2 * hy), dd(a, d) / (2 * hy));
    scale = Math.max(150, Math.min(320, px));
  }
  return { w: Math.round(2 * hx * scale), h: Math.round(2 * hy * scale), scale, hx, hy };
}

/**
 * Pocket throats: ignore hole pixels at or beyond each pocket's mouth line. Bed features seen through
 * the z = R plane appear shifted toward the camera by R·cot(elevation), so far pockets intrude further
 * into the rectified table; extend the mask by that shift where it points inward. Returns the count.
 */
function fillThroats(calib: Calibration, table: TableSpec): number {
  const R = table.ballRadius;
  const cam = calib.camera;
  const n = Math.min(8, table.pockets.length);
  for (let i = 0; i < n; i++) {
    const p = table.pockets[i]!;
    const dx = cam.x - p.mouthCenter.x;
    const dy = cam.y - p.mouthCenter.y;
    const dh = Math.hypot(dx, dy) || 1;
    const shift = (R * dh) / Math.max(0.2, cam.z - R);
    const toward = Math.max(0, (dx / dh) * p.inward.x + (dy / dh) * p.inward.y);
    THROAT[i * 6] = p.mouthCenter.x;
    THROAT[i * 6 + 1] = p.mouthCenter.y;
    THROAT[i * 6 + 2] = p.inward.x;
    THROAT[i * 6 + 3] = p.inward.y;
    THROAT[i * 6 + 4] = 0.5 * R + shift * toward;
    THROAT[i * 6 + 5] = (p.kind === 'corner' ? table.cornerMouth : table.sideMouth) / 2 + R;
  }
  return n;
}

function inThroat(n: number, X: number, Y: number): boolean {
  for (let i = 0; i < n; i++) {
    const o = i * 6;
    const dx = X - THROAT[o]!;
    const dy = Y - THROAT[o + 1]!;
    const s = dx * THROAT[o + 2]! + dy * THROAT[o + 3]!;
    const t = Math.abs(-dx * THROAT[o + 3]! + dy * THROAT[o + 2]!);
    const depth = THROAT[o + 4]!;
    if (s < depth && t < THROAT[o + 5]! + 0.5 * (depth - s)) return true;
  }
  return false;
}

/** q-quantile of a 64-bin [0, 1] histogram stored at hist[off..off+64), linear within the bin. */
function histQuantile(hist: Float64Array, off: number, bins: number, total: number, q: number): number {
  const target = q * total;
  let cum = 0;
  for (let b = 0; b < bins; b++) {
    const c = hist[off + b]!;
    if (cum + c >= target && c > 0) return (b + (target - cum) / c) / bins;
    cum += c;
  }
  return 1;
}

interface RectBuffers {
  rgb: Float32Array;
  hue: Float32Array;
  sat: Float32Array;
  val: Float32Array;
  nonCloth: Uint8Array;
  unknown: Uint8Array;
}

function rectifyInto(frame: Frame, calib: Calibration, table: TableSpec, cloth: ClothModel, g: RectGeo, b: RectBuffers): void {
  const { w, h, scale, hx, hy } = g;
  const H = calib.HR;
  const { rgb, hue, sat, val, nonCloth, unknown } = b;
  CLOTH_HIST.fill(0);
  let nCloth = 0;
  // Pass 1: sample, HSV, the loose cloth test; histogram the cloth's S.
  for (let j = 0; j < h; j++) {
    const Y = hy - (j + 0.5) / scale; // row 0 = +y (far side when viewed from the −y rail)
    for (let i = 0; i < w; i++) {
      const X = -hx + (i + 0.5) / scale;
      const ww = H[6]! * X + H[7]! * Y + H[8]!;
      const u = (H[0]! * X + H[1]! * Y + H[2]!) / ww;
      const v = (H[3]! * X + H[4]! * Y + H[5]!) / ww;
      const k = j * w + i;
      // Pixel (x, y) covers [x, x+1): its value sits at the pixel centre (x + ½, y + ½).
      if (!sampleRgb(frame, u - 0.5, v - 0.5, RGB3)) {
        rgb[k * 3] = 0;
        rgb[k * 3 + 1] = 0;
        rgb[k * 3 + 2] = 0;
        hue[k] = 0;
        sat[k] = 0;
        val[k] = 0;
        nonCloth[k] = 0;
        unknown[k] = 1;
        continue;
      }
      const r = RGB3[0]!;
      const gg = RGB3[1]!;
      const bb = RGB3[2]!;
      rgb[k * 3] = r;
      rgb[k * 3 + 1] = gg;
      rgb[k * 3 + 2] = bb;
      rgbToHsv(r, gg, bb, HSV);
      const hh = HSV[0]!;
      const s = HSV[1]!;
      const vv = HSV[2]!;
      hue[k] = hh;
      sat[k] = s;
      val[k] = vv;
      unknown[k] = 0;
      if (isCloth(hh, s, vv, cloth)) {
        nonCloth[k] = 0;
        CLOTH_HIST[Math.min(63, Math.floor(s * 64))]! += 1;
        nCloth++;
      } else nonCloth[k] = 1;
    }
  }
  // A ball that shares the cloth hue (snooker green on green cloth) is still more saturated than the
  // cloth itself. Shadows keep the cloth's S, so deliberately no darker-than-cloth test; and no
  // brighter-than-cloth test either: it grows lamp glare and the lit rim of white balls.
  const s95 = histQuantile(CLOTH_HIST, 0, 64, nCloth, 0.95);
  const sHi = nCloth >= CLOTH_STATS_MIN ? s95 + Math.max(CLOTH_S_MARGIN, 2 * (s95 - histQuantile(CLOTH_HIST, 0, 64, nCloth, 0.5))) : Infinity;
  const nT = fillThroats(calib, table);
  const darkV = THROAT_V * cloth.val;
  // Pass 2: tightened cloth test; hole-like pixels in the throats become unknown.
  for (let j = 0; j < h; j++) {
    const Y = hy - (j + 0.5) / scale;
    for (let i = 0; i < w; i++) {
      const k = j * w + i;
      if (unknown[k]) continue;
      const s = sat[k]!;
      const vv = val[k]!;
      let nc = nonCloth[k]!;
      // S of a dark pixel is quantisation noise (and video chroma clamps it toward 1): widen the margin
      // by one 8-bit step of relative error, and leave the darkest pixels to the loose test.
      if (!nc && vv >= 0.12 && s > sHi + 1 / (255 * vv)) nc = 1;
      // Any saturation: video chroma bleed makes the hole's rim dark but coloured, and a dark ball pixel
      // here is only "unknown", which the fit treats as possibly ball.
      if (nc && vv < darkV && inThroat(nT, -hx + (i + 0.5) / scale, Y)) {
        nc = 0;
        unknown[k] = 1;
      }
      nonCloth[k] = nc;
    }
  }
}

/** Rectify a frame (fresh buffers: the result may be kept by the caller). */
export function rectify(frame: Frame, calib: Calibration, table: TableSpec, cloth: ClothModel, opts: BallDetectOptions = {}): Rectified {
  const g = rectGeometry(calib, table, opts);
  const n = g.w * g.h;
  const b: RectBuffers = {
    rgb: new Float32Array(n * 3),
    hue: new Float32Array(n),
    sat: new Float32Array(n),
    val: new Float32Array(n),
    nonCloth: new Uint8Array(n),
    unknown: new Uint8Array(n),
  };
  rectifyInto(frame, calib, table, cloth, g, b);
  return { w: g.w, h: g.h, scale: g.scale, x0: -g.hx, y0: g.hy, rgb: b.rgb, nonCloth: b.nonCloth };
}

// --- per-frame context -----------------------------------------------------------------------------

interface Ctx {
  S: Scratch;
  w: number;
  h: number;
  scale: number;
  x0: number;
  y0: number;
  rp: number;
  R: number;
  cam: { x: number; y: number; z: number };
  table: TableSpec;
  clothHue: number;
  HR: Mat3;
  swatches: Swatch[];
  next: number;
  /** The frame's silhouette dilation (px, + = blobs larger than the true silhouette). */
  dil: number;
  found: Found[];
}

/** A detection plus internal evidence used for dedupe and cue selection. */
interface Found {
  ball: DetectedBall;
  blob: number;
  complete: number;
  spread: number;
}

/** Elevation and the unit viewing direction (rectified px axes) at rectified point (cx, cy). */
interface View {
  sinEl: number;
  ax: number;
  ay: number;
}
const VIEW: View = { sinEl: 1, ax: 1, ay: 0 };

function viewAt(ctx: Ctx, cx: number, cy: number): View {
  const X = ctx.x0 + cx / ctx.scale;
  const Y = ctx.y0 - cy / ctx.scale;
  const dx = X - ctx.cam.x;
  const dy = Y - ctx.cam.y;
  const dh = Math.hypot(dx, dy);
  const hz = Math.max(0.2, ctx.cam.z - ctx.R);
  VIEW.sinEl = hz / Math.hypot(dh, hz);
  const al = dh || 1;
  VIEW.ax = dx / al;
  VIEW.ay = -dy / al; // rectified j axis points to −y
  return VIEW;
}

// --- distance transforms ---------------------------------------------------------------------------

/** Chessboard distance to the nearest zero cell, in place (non-zero cells start at BIG). */
function chessboardDT(D: Uint16Array, gw: number, gh: number): void {
  for (let y = 0; y < gh; y++)
    for (let x = 0; x < gw; x++) {
      const c = y * gw + x;
      let d = D[c]!;
      if (d === 0) continue;
      if (x > 0) d = Math.min(d, D[c - 1]! + 1);
      if (y > 0) {
        d = Math.min(d, D[c - gw]! + 1);
        if (x > 0) d = Math.min(d, D[c - gw - 1]! + 1);
        if (x < gw - 1) d = Math.min(d, D[c - gw + 1]! + 1);
      }
      D[c] = d;
    }
  for (let y = gh - 1; y >= 0; y--)
    for (let x = gw - 1; x >= 0; x--) {
      const c = y * gw + x;
      let d = D[c]!;
      if (d === 0) continue;
      if (x < gw - 1) d = Math.min(d, D[c + 1]! + 1);
      if (y < gh - 1) {
        d = Math.min(d, D[c + gw]! + 1);
        if (x < gw - 1) d = Math.min(d, D[c + gw + 1]! + 1);
        if (x > 0) d = Math.min(d, D[c + gw - 1]! + 1);
      }
      D[c] = d;
    }
}

/** Chamfer (3-4) distance to the nearest zero cell, in place (≈ 3 × Euclidean px; non-zero cells start at BIG). */
function chamferDT(D: Uint16Array, gw: number, gh: number): void {
  for (let y = 0; y < gh; y++)
    for (let x = 0; x < gw; x++) {
      const c = y * gw + x;
      let d = D[c]!;
      if (d === 0) continue;
      if (x > 0) d = Math.min(d, D[c - 1]! + 3);
      if (y > 0) {
        d = Math.min(d, D[c - gw]! + 3);
        if (x > 0) d = Math.min(d, D[c - gw - 1]! + 4);
        if (x < gw - 1) d = Math.min(d, D[c - gw + 1]! + 4);
      }
      D[c] = d;
    }
  for (let y = gh - 1; y >= 0; y--)
    for (let x = gw - 1; x >= 0; x--) {
      const c = y * gw + x;
      let d = D[c]!;
      if (d === 0) continue;
      if (x < gw - 1) d = Math.min(d, D[c + 1]! + 3);
      if (y < gh - 1) {
        d = Math.min(d, D[c + gw]! + 3);
        if (x < gw - 1) d = Math.min(d, D[c + gw + 1]! + 4);
        if (x > 0) d = Math.min(d, D[c + gw - 1]! + 4);
      }
      D[c] = d;
    }
}

// --- detection -------------------------------------------------------------------------------------

export function detectBalls(frame: Frame, calib: Calibration, table: TableSpec, cloth: ClothModel, opts: BallDetectOptions = {}): DetectedBall[] {
  const R = table.ballRadius;
  const g = rectGeometry(calib, table, opts);
  const { w, h } = g;
  const N = w * h;
  const S = scratchFor(N);
  rectifyInto(frame, calib, table, cloth, g, S);
  const { nonCloth, er, mask, label, queue } = S;

  // Light morphological opening (3×3 cross erosion then dilation) to drop specks. Borders stay 0.
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const k = j * w + i;
      er[k] = j === 0 || i === 0 || j === h - 1 || i === w - 1 ? 0 : nonCloth[k]! & nonCloth[k - 1]! & nonCloth[k + 1]! & nonCloth[k - w]! & nonCloth[k + w]!;
    }
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const k = j * w + i;
      mask[k] = j === 0 || i === 0 || j === h - 1 || i === w - 1 ? 0 : er[k]! | er[k - 1]! | er[k + 1]! | er[k - w]! | er[k + w]!;
    }

  const palette = opts.palette ?? (table.id === 'snooker12' || /snooker/i.test(table.name) ? 'snooker' : 'pool');
  const ctx: Ctx = {
    S,
    w,
    h,
    scale: g.scale,
    x0: -g.hx,
    y0: g.hy,
    rp: R * g.scale,
    R,
    cam: calib.camera,
    table,
    clothHue: cloth.hue,
    HR: calib.HR,
    swatches: palette === 'snooker' ? SNOOKER_SWATCHES : POOL_SWATCHES,
    next: 1,
    dil: 0,
    found: [],
  };

  // Pass 1: connected components (4-connected) with their area and second moments.
  label.fill(0, 0, N);
  let nComp = 0;
  for (let s = 0; s < N; s++) {
    if (!mask[s] || label[s]) continue;
    const lab = ctx.next++;
    let head = 0;
    let tail = 0;
    queue[tail++] = s;
    label[s] = lab;
    let si = 0;
    let sj = 0;
    let sii = 0;
    let sjj = 0;
    let sij = 0;
    let clothLike = 0;
    while (head < tail) {
      const k = queue[head++]!;
      const i = k % w;
      const j = (k - i) / w;
      si += i;
      sj += j;
      sii += i * i;
      sjj += j * j;
      sij += i * j;
      if (S.sat[k]! > 0.4 && hueDiff(S.hue[k]!, cloth.hue) < 30) clothLike++;
      if (i > 0 && mask[k - 1] && !label[k - 1]) {
        label[k - 1] = lab;
        queue[tail++] = k - 1;
      }
      if (i < w - 1 && mask[k + 1] && !label[k + 1]) {
        label[k + 1] = lab;
        queue[tail++] = k + 1;
      }
      if (k >= w && mask[k - w] && !label[k - w]) {
        label[k - w] = lab;
        queue[tail++] = k - w;
      }
      if (k + w < N && mask[k + w] && !label[k + w]) {
        label[k + w] = lab;
        queue[tail++] = k + w;
      }
    }
    growComps(nComp + 1);
    const o = nComp * COMP_STRIDE;
    COMPS[o] = s;
    COMPS[o + 1] = lab;
    COMPS[o + 2] = tail;
    COMPS[o + 3] = si;
    COMPS[o + 4] = sj;
    COMPS[o + 5] = sii;
    COMPS[o + 6] = sjj;
    COMPS[o + 7] = sij;
    COMPS[o + 8] = clothLike / tail;
    nComp++;
  }
  // The frame's silhouette dilation: median over single-ball-like blobs of (effective de-stretched
  // radius − R). Video chroma bleed dilates silhouettes by ~1 px; that ring must not read as a ball.
  let nd = 0;
  for (let c = 0; c < nComp; c++) {
    const d = singleDilation(ctx, c);
    if (Number.isFinite(d)) DILS[nd++] = d;
  }
  ctx.dil = 0;
  if (nd >= 3) {
    DILS.subarray(0, nd).sort();
    ctx.dil = Math.max(-1, Math.min(2, DILS[nd >> 1]!));
  }
  // Pass 2: process each component.
  for (let c = 0; c < nComp; c++) {
    const o = c * COMP_STRIDE;
    const n = COMPS[o + 2]!;
    if (n < MIN_BLOB * Math.PI * ctx.rp * ctx.rp) continue;
    const lab = COMPS[o + 1]!;
    let head = 0;
    let tail = 0;
    queue[tail++] = COMPS[o]!;
    const seen = -lab - 2; // temporary mark while collecting (restored below)
    label[COMPS[o]!] = seen;
    while (head < tail) {
      const k = queue[head++]!;
      const i = k % w;
      if (i > 0 && label[k - 1] === lab) {
        label[k - 1] = seen;
        queue[tail++] = k - 1;
      }
      if (i < w - 1 && label[k + 1] === lab) {
        label[k + 1] = seen;
        queue[tail++] = k + 1;
      }
      if (k >= w && label[k - w] === lab) {
        label[k - w] = seen;
        queue[tail++] = k - w;
      }
      if (k + w < N && label[k + w] === lab) {
        label[k + w] = seen;
        queue[tail++] = k + w;
      }
    }
    for (let q = 0; q < tail; q++) label[queue[q]!] = lab;
    processComponent(ctx, tail, lab);
  }

  // De-duplicate across blobs only (a blob cut in two by the opening, or chroma bleed): two real balls
  // can't be closer than ~2R. Centres split from one blob are never merged here (the split already
  // enforced the separation). Keep the larger piece, nudged toward the pixel-weighted mean.
  const found = ctx.found;
  found.sort((a, b) => b.ball.px - a.ball.px);
  for (let i = 0; i < found.length; i++)
    for (let j = found.length - 1; j > i; j--) {
      const a = found[i]!;
      const b = found[j]!;
      if (a.blob === b.blob) continue;
      if (Math.hypot(a.ball.pos.x - b.ball.pos.x, a.ball.pos.y - b.ball.pos.y) < MIN_SEP * R) {
        const ww = a.ball.px + b.ball.px;
        a.ball.pos = { x: (a.ball.pos.x * a.ball.px + b.ball.pos.x * b.ball.px) / ww, y: (a.ball.pos.y * a.ball.px + b.ball.pos.y * b.ball.px) / ww };
        a.ball.image = applyH(calib.HR, a.ball.pos.x, a.ball.pos.y);
        a.ball.px = ww;
        a.complete = Math.max(a.complete, b.complete);
        found.splice(j, 1);
      }
    }

  // Cue ball: the whitest COMPLETE ball (a stripe whose band dropped out is not), with real shading
  // (flat glare is not), and clearly whiter than the runner-up. Otherwise no ball is the cue: the
  // tracker's vote then decays and the app asks the player to tap the cue ball (spec edge case).
  let best = -1;
  let second = -1;
  for (let i = 0; i < found.length; i++) {
    const f = found[i]!;
    if (f.complete < CUE_FILL || f.ball.white < CUE_MIN_WHITE || f.spread < CUE_SPREAD) continue;
    if (best < 0 || f.ball.white > found[best]!.ball.white) {
      second = best;
      best = i;
    } else if (second < 0 || f.ball.white > found[second]!.ball.white) second = i;
  }
  if (best >= 0 && (second < 0 || found[second]!.ball.white <= found[best]!.ball.white - CUE_MARGIN)) {
    found[best]!.ball.isCue = true;
    found[best]!.ball.label = 'cue';
  }
  const out: DetectedBall[] = [];
  for (const f of found) {
    if (!f.ball.isCue && f.ball.label === 'white') f.ball.label = 'white?';
    out.push(f.ball);
  }
  return out;
}

const COMP_STRIDE = 9;
let COMPS = new Float64Array(256 * COMP_STRIDE);
let DILS = new Float64Array(256);
/** Make room for n component records (amortised: grows ×2). */
function growComps(n: number): void {
  if (COMPS.length >= n * COMP_STRIDE) return;
  const next = new Float64Array(n * 2 * COMP_STRIDE);
  next.set(COMPS);
  COMPS = next;
  DILS = new Float64Array(n * 2);
}

/**
 * Dilation estimate from component c if it looks like one isolated, not cloth-hued ball (area 0.6–1.6
 * balls, aspect along/across the view within 20 % of 1/sin(elevation)): effective de-stretched
 * radius − R. NaN if not.
 */
function singleDilation(ctx: Ctx, c: number): number {
  const o = c * COMP_STRIDE;
  const n = COMPS[o + 2]!;
  const rp = ctx.rp;
  // A cloth-hued ball is eroded by design (its rim reads as cloth): not a measure of the frame's blur.
  if (n < MIN_BLOB * Math.PI * rp * rp || COMPS[o + 8]! > 0.3) return NaN;
  const mi = COMPS[o + 3]! / n;
  const mj = COMPS[o + 4]! / n;
  const cii = COMPS[o + 5]! / n - mi * mi;
  const cjj = COMPS[o + 6]! / n - mj * mj;
  const cij = COMPS[o + 7]! / n - mi * mj;
  const { sinEl, ax, ay } = viewAt(ctx, mi + 0.5, mj + 0.5);
  const ratio = (n * sinEl) / (Math.PI * rp * rp);
  if (ratio < 0.6 || ratio > 1.6) return NaN;
  const saa = ax * ax * cii + 2 * ax * ay * cij + ay * ay * cjj;
  const spp = ay * ay * cii - 2 * ax * ay * cij + ax * ax * cjj;
  const asp = Math.sqrt(saa / Math.max(1e-9, spp)) * sinEl;
  if (Math.abs(asp - 1) > 0.2) return NaN;
  return Math.sqrt((n * sinEl) / Math.PI) - rp;
}

/** One 4-connected component (pixel indices in queue[0..n)): strip thin attachments, then split. */
function processComponent(ctx: Ctx, n: number, lab: number): void {
  const { S, w, rp } = ctx;
  if (n < MIN_BLOB * Math.PI * rp * rp) return;
  const { queue } = S;
  let minI = w;
  let maxI = 0;
  let minJ = ctx.h;
  let maxJ = 0;
  let ci = 0;
  let cj = 0;
  for (let q = 0; q < n; q++) {
    const k = queue[q]!;
    const i = k % w;
    const j = (k - i) / w;
    if (i < minI) minI = i;
    if (i > maxI) maxI = i;
    if (j < minJ) minJ = j;
    if (j > maxJ) maxJ = j;
    ci += i + 0.5;
    cj += j + 0.5;
  }
  const v = viewAt(ctx, ci / n, cj / n);
  const a1 = (Math.PI * rp * rp) / v.sinEl;
  n = fillHoles(ctx, n, lab, minI, maxI, minJ, maxJ, a1);
  const nSub = 2 * n <= S.cap ? stripThin(ctx, n, lab, minI, maxI, minJ, maxJ, a1) : 0;
  if (nSub === 0) processBlob(ctx, 0, n, lab);
  else for (let s = 0; s < nSub; s++) processBlob(ctx, SUBS[s * 3]!, SUBS[s * 3 + 1]!, SUBS[s * 3 + 2]!);
}

/**
 * Fill small enclosed holes (cloth-classified pixels inside a ball: a cloth-hued ball's noisy edge of
 * the saturation test, a highlight) so they don't break the silhouette. Holes of up to a third of a
 * ball are filled; bigger ones (real cloth between balls) are kept. Appends to queue[0..n); returns n.
 */
function fillHoles(ctx: Ctx, n: number, lab: number, minI: number, maxI: number, minJ: number, maxJ: number, a1: number): number {
  const { S, w } = ctx;
  const { queue, label, mask } = S;
  const gw = maxI - minI + 3;
  const gh = maxJ - minJ + 3;
  const gn = gw * gh;
  if (n + 2 * gn > S.cap) return n;
  growGrid(S, gn);
  const G = S.grid; // 1 blob, 2 outside (reached from the border), 0 not yet
  G.fill(0, 0, gn);
  for (let q = 0; q < n; q++) {
    const k = queue[q]!;
    const i = k % w;
    G[((k - i) / w - minJ + 1) * gw + (i - minI + 1)] = 1;
  }
  // Flood the outside from the grid border (the grid has a 1-cell margin), using queue[n + gn..].
  const qb = n + gn;
  let tail = qb;
  G[0] = 2;
  queue[tail++] = 0;
  for (let head = qb; head < tail; head++) {
    const c = queue[head]!;
    const x = c % gw;
    if (x > 0 && G[c - 1] === 0) {
      G[c - 1] = 2;
      queue[tail++] = c - 1;
    }
    if (x < gw - 1 && G[c + 1] === 0) {
      G[c + 1] = 2;
      queue[tail++] = c + 1;
    }
    if (c >= gw && G[c - gw] === 0) {
      G[c - gw] = 2;
      queue[tail++] = c - gw;
    }
    if (c + gw < gn && G[c + gw] === 0) {
      G[c + gw] = 2;
      queue[tail++] = c + gw;
    }
  }
  // Remaining 0 cells are holes: measure each (BFS into queue[n + gn..]) and fill the small ones.
  const maxHole = a1 / 3;
  for (let c0 = 0; c0 < gn; c0++) {
    if (G[c0] !== 0) continue;
    let t = qb;
    G[c0] = 3;
    queue[t++] = c0;
    for (let head = qb; head < t; head++) {
      const c = queue[head]!;
      const x = c % gw;
      if (x > 0 && G[c - 1] === 0) {
        G[c - 1] = 3;
        queue[t++] = c - 1;
      }
      if (x < gw - 1 && G[c + 1] === 0) {
        G[c + 1] = 3;
        queue[t++] = c + 1;
      }
      if (c >= gw && G[c - gw] === 0) {
        G[c - gw] = 3;
        queue[t++] = c - gw;
      }
      if (c + gw < gn && G[c + gw] === 0) {
        G[c + gw] = 3;
        queue[t++] = c + gw;
      }
    }
    if (t - qb > maxHole) continue;
    for (let q = qb; q < t; q++) {
      const c = queue[q]!;
      const k = (Math.floor(c / gw) - 1 + minJ) * w + (c % gw) - 1 + minI;
      if (label[k] !== 0 || S.unknown[k]) continue;
      label[k] = lab;
      mask[k] = 1;
      queue[n++] = k;
    }
  }
  return n;
}

/**
 * Opening by a disc of radius THIN_R·R (chamfer distances): pixels farther than that from the border
 * are the core; regrow the core by the same amount. What does not come back is thin (a cue stick, a
 * rail band). If a long such part hangs off the blob, drop it (label −1, treated as unknown later)
 * and relabel the rest into sub-blobs stored at queue[n..]; returns their count (0 = blob unchanged).
 */
function stripThin(ctx: Ctx, n: number, lab: number, minI: number, maxI: number, minJ: number, maxJ: number, a1: number): number {
  const { S, w, h, rp } = ctx;
  const { queue, label } = S;
  const r = Math.max(1, Math.round(THIN_R * rp));
  const gw = maxI - minI + 3;
  const gh = maxJ - minJ + 3;
  const gn = gw * gh;
  growGrid(S, gn);
  const D = S.dist;
  const E = S.dist2;
  D.fill(0, 0, gn);
  for (let q = 0; q < n; q++) {
    const k = queue[q]!;
    const i = k % w;
    D[((k - i) / w - minJ + 1) * gw + (i - minI + 1)] = BIG;
  }
  chamferDT(D, gw, gh);
  // Core: farther than r px from the border; regrow by r (a disc opening, chamfer-approximated).
  for (let c = 0; c < gn; c++) E[c] = D[c]! > 3 * r ? 0 : BIG;
  chamferDT(E, gw, gh);
  // Only a long attachment counts (pixels well beyond the regrown core): an ellipse's own tips do not.
  let far = 0;
  for (let q = 0; q < n; q++) {
    const k = queue[q]!;
    const i = k % w;
    if (E[((k - i) / w - minJ + 1) * gw + (i - minI + 1)]! > 3 * (2 * r + 1)) far++;
  }
  let core = 0;
  for (let c = 0; c < gn; c++) if (E[c] === 0) core++;
  if (core === 0) return 0; // all thin: nothing to keep apart from; the shape gates decide
  if (far <= Math.max(4, THIN_MIN * a1)) return 0;
  for (let q = 0; q < n; q++) {
    const k = queue[q]!;
    const i = k % w;
    if (E[((k - i) / w - minJ + 1) * gw + (i - minI + 1)]! > 3 * r) label[k] = -1;
  }
  let wpos = n;
  let nSub = 0;
  const N = w * h;
  for (let q = 0; q < n && nSub < 64; q++) {
    const k0 = queue[q]!;
    if (label[k0] !== lab) continue;
    const sub = ctx.next++;
    const start = wpos;
    label[k0] = sub;
    queue[wpos++] = k0;
    let head = start;
    while (head < wpos) {
      const k = queue[head++]!;
      const i = k % w;
      if (i > 0 && label[k - 1] === lab) {
        label[k - 1] = sub;
        queue[wpos++] = k - 1;
      }
      if (i < w - 1 && label[k + 1] === lab) {
        label[k + 1] = sub;
        queue[wpos++] = k + 1;
      }
      if (k >= w && label[k - w] === lab) {
        label[k - w] = sub;
        queue[wpos++] = k - w;
      }
      if (k + w < N && label[k + w] === lab) {
        label[k + w] = sub;
        queue[wpos++] = k + w;
      }
    }
    SUBS[nSub * 3] = start;
    SUBS[nSub * 3 + 1] = wpos - start;
    SUBS[nSub * 3 + 2] = sub;
    nSub++;
  }
  return nSub;
}

/** Is rectified pixel k "known cloth" (a true silhouette edge lies between it and a ball pixel)? */
function knownCloth(S: Scratch, k: number): boolean {
  return !S.mask[k] && !S.unknown[k] && S.label[k] !== -1;
}

/** A blob (pixels queue[start..start+cnt), label lab): count balls, place them, gate, describe. */
function processBlob(ctx: Ctx, start: number, cnt: number, lab: number): void {
  const { S, w, h, rp } = ctx;
  if (cnt < MIN_BLOB * Math.PI * rp * rp) return;
  growBlob(S, cnt);
  const { queue, dq, label } = S;
  let cx = 0;
  let cy = 0;
  for (let q = 0; q < cnt; q++) {
    const k = queue[start + q]!;
    const i = k % w;
    cx += i + 0.5;
    cy += (k - i) / w + 0.5;
  }
  cx /= cnt;
  cy /= cnt;
  const { sinEl, ax, ay } = viewAt(ctx, cx, cy);
  const bx = -ay;
  const by = ax;
  const a1 = (Math.PI * rp * rp) / sinEl;
  // Second moments: along/across the view (expected aspect 1/sinEl for one ball) and principal axes.
  let saa = 0;
  let spp = 0;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  let uMin = Infinity;
  let uMax = -Infinity;
  let vMin = Infinity;
  let vMax = -Infinity;
  for (let q = 0; q < cnt; q++) {
    const k = queue[start + q]!;
    const i = k % w;
    const x = i + 0.5 - cx;
    const y = (k - i) / w + 0.5 - cy;
    const al = x * ax + y * ay;
    const pe = x * bx + y * by;
    saa += al * al;
    spp += pe * pe;
    sxx += x * x;
    syy += y * y;
    sxy += x * y;
    const u = al * sinEl;
    dq[q * 2] = u;
    dq[q * 2 + 1] = pe;
    if (u < uMin) uMin = u;
    if (u > uMax) uMax = u;
    if (pe < vMin) vMin = pe;
    if (pe > vMax) vMax = pe;
  }
  const tr = sxx + syy;
  const disc = Math.sqrt(Math.max(0, ((sxx - syy) / 2) ** 2 + sxy * sxy));
  const elong = Math.sqrt((tr / 2 + disc) / Math.max(1e-9, tr / 2 - disc));
  const kArea = Math.max(1, Math.round(cnt / a1 + 0.1));
  if (kArea > K_MAX + 4) return; // far bigger than any pack: not balls
  if (kArea >= 3 && elong > 6) return; // a rail band / cue stick, not balls

  // Silhouette edge points: faces between a blob pixel and known cloth. Faces against unknown pixels
  // (throat hole, frame edge, stripped stick) are not silhouette and mark the blob as truncated.
  let faces = 0;
  let truncFaces = 0;
  let nEdge = 0;
  growEdge(S, cnt * 2 + 8);
  const { edge } = S;
  for (let q = 0; q < cnt; q++) {
    const k = queue[start + q]!;
    const i = k % w;
    const j = (k - i) / w;
    for (let nb = 0; nb < 4; nb++) {
      const ii = nb === 0 ? i - 1 : nb === 1 ? i + 1 : i;
      const jj = nb === 2 ? j - 1 : nb === 3 ? j + 1 : j;
      if (ii >= 0 && jj >= 0 && ii < w && jj < h && label[jj * w + ii] === lab) continue;
      faces++;
      if (ii < 0 || jj < 0 || ii >= w || jj >= h || !knownCloth(S, jj * w + ii)) {
        truncFaces++;
        continue;
      }
      if (nEdge >= S.ecap) continue;
      // Face midpoint, in de-stretched coordinates about the blob centroid.
      const fx = (i + ii) / 2 + 0.5 - cx;
      const fy = (j + jj) / 2 + 0.5 - cy;
      edge[nEdge * 2] = (fx * ax + fy * ay) * sinEl;
      edge[nEdge * 2 + 1] = fx * bx + fy * by;
      nEdge++;
    }
  }
  const truncated = faces > 0 && truncFaces / faces > TRUNC_FRAC;

  // Count and place: the disc model (each silhouette is a disc of radius R once de-stretched).
  // Silhouettes in the mask are dilated (video chroma bleed) or eroded (dark balls) by about a pixel;
  // fit discs of the dilated radius so that ring never reads as another ball. A blob that looks like
  // one ball uses its own estimate, any other the frame's.
  const aspect = Math.sqrt(saa / Math.max(1e-9, spp));
  const ratio = (cnt * sinEl) / (Math.PI * rp * rp);
  const single = !truncated && ratio >= 0.6 && ratio <= 1.6 && Math.abs(aspect * sinEl - 1) <= 0.2;
  const dil = single ? Math.max(-1, Math.min(2, Math.sqrt((cnt * sinEl) / Math.PI) - rp)) : ctx.dil;
  const rad = rp + dil;
  const k = fitDiscs(ctx, cnt, lab, cx, cy, ax, ay, sinEl, uMin, uMax, vMin, vMax, rad);
  CENT.set(BEST.subarray(0, k * 2));
  if (k > 1 || truncated) refineCircles(ctx, nEdge, k, sinEl, rad, !truncated);
  else refineSingle(ctx, nEdge, rad);

  // Owner of each pixel: the nearest-to-camera ball whose silhouette disc contains it (occlusion),
  // else the nearest centre.
  const { assign } = S;
  const r2 = rp * rp;
  for (let q = 0; q < cnt; q++) {
    const u = dq[q * 2]!;
    const vv = dq[q * 2 + 1]!;
    let own = -1;
    let ownU = Infinity;
    let near = 0;
    let nd = Infinity;
    for (let m = 0; m < k; m++) {
      const du = u - CENT[m * 2]!;
      const dv = vv - CENT[m * 2 + 1]!;
      const d = du * du + dv * dv;
      if (d < nd) {
        nd = d;
        near = m;
      }
      if (d <= r2 && CENT[m * 2]! < ownU) {
        ownU = CENT[m * 2]!;
        own = m;
      }
    }
    assign[q] = own >= 0 ? own : near;
  }

  for (let m = 0; m < k; m++) {
    const cu = CENT[m * 2]!;
    const cv = CENT[m * 2 + 1]!;
    // Back to rectified pixels, then table metres.
    const xr = cx + (cu / sinEl) * ax + cv * bx;
    const yr = cy + (cu / sinEl) * ay + cv * by;
    const pos = { x: ctx.x0 + xr / ctx.scale, y: ctx.y0 - yr / ctx.scale };
    const table = ctx.table;
    if (Math.abs(pos.x) > table.length / 2 || Math.abs(pos.y) > table.width / 2) continue;
    // Fill: share of the predicted silhouette (0.9R disc, de-stretched) that is not cloth (any ball, or
    // unknown). Completeness: share that is THIS ball (or unknown) — low for a ball hidden behind
    // another, and for a stripe whose band reads as cloth.
    const fill = silhouetteFill(ctx, xr, yr, ax, ay, sinEl);
    let n = 0;
    let ownIn = 0;
    const rr2 = 0.81 * r2;
    for (let q = 0; q < cnt; q++) {
      if (assign[q] !== m) continue;
      n++;
      const du = dq[q * 2]! - cu;
      const dv = dq[q * 2 + 1]! - cv;
      if (du * du + dv * dv <= rr2) ownIn++;
    }
    // …and its own pixels (plus unknown ones) must add up to a whole (dilated) silhouette.
    // (The frame's dilation, not this blob's: a stripe missing its band would otherwise shrink its own disc.)
    const rf = rp + Math.max(0, ctx.dil);
    const whole = (n + FILL.unk / 0.81) / ((Math.PI * rf * rf) / sinEl);
    const own = FILL.tot > 0 ? Math.min(1, (ownIn + FILL.unk) / FILL.tot, whole) : 0;
    if (k === 1) {
      if (fill < MIN_FILL) continue;
      if (!truncated) {
        if (cnt < MIN_SINGLE_AREA * a1 || Math.abs(aspect * sinEl - 1) > ASPECT_TOL) continue;
      }
    } else {
      if (fill < MIN_FILL || n < 0.15 * Math.PI * r2) continue;
    }
    pos.x = Math.max(-(table.length / 2 - ctx.R), Math.min(table.length / 2 - ctx.R, pos.x));
    pos.y = Math.max(-(table.width / 2 - ctx.R), Math.min(table.width / 2 - ctx.R, pos.y));
    describe(ctx, start, cnt, m, n, a1, pos, lab, own);
  }
}

const FILL = { tot: 0, unk: 0 };
/**
 * Fraction of the predicted silhouette (de-stretched disc 0.9R about (xr, yr)) that is ball or unknown.
 * Also leaves the disc's pixel count and its unknown pixels in FILL.
 */
function silhouetteFill(ctx: Ctx, xr: number, yr: number, ax: number, ay: number, sinEl: number): number {
  const { S, w, h, rp } = ctx;
  const rr = 0.9 * rp;
  const ext = Math.ceil(rr / sinEl) + 1;
  let tot = 0;
  let fill = 0;
  let unk = 0;
  const i0 = Math.max(0, Math.floor(xr - ext));
  const i1 = Math.min(w - 1, Math.ceil(xr + ext));
  const j0 = Math.max(0, Math.floor(yr - ext));
  const j1 = Math.min(h - 1, Math.ceil(yr + ext));
  for (let j = j0; j <= j1; j++)
    for (let i = i0; i <= i1; i++) {
      const x = i + 0.5 - xr;
      const y = j + 0.5 - yr;
      const u = (x * ax + y * ay) * sinEl;
      const v = -x * ay + y * ax;
      if (u * u + v * v > rr * rr) continue;
      tot++;
      const k = j * w + i;
      if (S.unknown[k] || S.label[k] === -1) {
        fill++;
        unk++;
      } else if (S.mask[k]) fill++;
    }
  FILL.tot = tot;
  FILL.unk = unk;
  return tot > 0 ? fill / tot : 0;
}

/**
 * Disc-model fit in the de-stretched frame, where every ball silhouette is a disc of radius R (rp px).
 * Find k disc centres (≥ 1.7R apart in table distance) minimising
 *   cost = blob cells no disc covers + cloth cells some disc covers (+ a separation penalty),
 * unknown cells (throat hole, frame edge, stick) being free either way. k grows while one more disc
 * lowers the cost by at least DISC_GAIN·πR²: a ball whose silhouette adds nothing to the blob (fully
 * hidden behind others) is honestly not counted. Each k is tried from several starts (the previous
 * solution plus a disc at the deepest uncovered cell; farthest-point and k-means++ k-means), each
 * polished by local search. Centres (de-stretched u, v about the blob centroid) go to BEST.
 */
const GC = new Int32Array(K_MAX * 2);
const GSAVE = new Int32Array(K_MAX * 2);
const GTRY = new Int32Array(K_MAX * 2);
/** In a multi-ball fit every disc must cover at least this × its area in blob (not unknown) cells. */
const DISC_MIN_BLOB = 0.4;
/** Penalty (cells) per px that two centres are closer than the 1.7R minimum. */
const SEP_W = 40;

interface DiscGrid {
  gw: number;
  gh: number;
  u0: number;
  v0: number;
  ri: number;
  r2: number;
  sinEl: number;
  minSep: number;
}
const DG: DiscGrid = { gw: 0, gh: 0, u0: 0, v0: 0, ri: 0, r2: 0, sinEl: 1, minSep: 0 };

/** Cost change of moving a disc from cell (au, av) to (bu, bv); applies the coverage change if asked. */
function moveDelta(G: Uint8Array, COV: Uint16Array, au: number, av: number, bu: number, bv: number, apply: boolean): number {
  const { gw, ri, r2 } = DG;
  let d = 0;
  const x0 = Math.min(au, bu) - ri;
  const x1 = Math.max(au, bu) + ri;
  const y0 = Math.min(av, bv) - ri;
  const y1 = Math.max(av, bv) + ri;
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const inA = (x - au) * (x - au) + (y - av) * (y - av) <= r2;
      const inB = (x - bu) * (x - bu) + (y - bv) * (y - bv) <= r2;
      if (inA === inB) continue;
      const c = y * gw + x;
      const t = G[c]!;
      const n = COV[c]!;
      if (inA) {
        if (n === 1) d += t & 1 ? 1 : t & 2 ? 0 : -1;
        if (apply) COV[c] = n - 1;
      } else {
        if (n === 0) d += t & 1 ? -1 : t & 2 ? 0 : 1;
        if (apply) COV[c] = n + 1;
      }
    }
  return d;
}

/** Separation penalty of centre m at cell (gi, gj) against the other k−1 centres in GC. */
function sepPenalty(k: number, m: number, gi: number, gj: number): number {
  let p = 0;
  for (let j = 0; j < k; j++) {
    if (j === m) continue;
    const du = (gi - GC[j * 2]!) / DG.sinEl;
    const dv = gj - GC[j * 2 + 1]!;
    const d = Math.sqrt(du * du + dv * dv);
    if (d < DG.minSep) p += SEP_W * (DG.minSep - d);
  }
  return p;
}

/** Rebuild coverage for the k centres in GC; returns the full cost (uncovered + phantom + penalty). */
function coverAll(S: Scratch, k: number): number {
  const { gw, gh, ri, r2 } = DG;
  const G = S.grid;
  const COV = S.dist;
  COV.fill(0, 0, gw * gh);
  for (let m = 0; m < k; m++) {
    const gi = GC[m * 2]!;
    const gj = GC[m * 2 + 1]!;
    for (let dj = -ri; dj <= ri; dj++)
      for (let di = -ri; di <= ri; di++) if (di * di + dj * dj <= r2) COV[(gj + dj) * gw + gi + di]! += 1;
  }
  let cost = 0;
  for (let c = 0; c < gw * gh; c++) {
    const t = G[c]!;
    if (t & 1) {
      if (COV[c] === 0) cost++;
    } else if (!(t & 2) && COV[c]! > 0) cost++;
  }
  for (let m = 0; m < k; m++) cost += sepPenalty(k, m, GC[m * 2]!, GC[m * 2 + 1]!) / 2;
  return cost;
}

/** Cost increase of removing the disc at cell (gi, gj); applies the coverage change if asked. */
function removeDelta(S: Scratch, gi: number, gj: number, apply: boolean): number {
  const { gw, ri, r2 } = DG;
  let d = 0;
  for (let dj = -ri; dj <= ri; dj++)
    for (let di = -ri; di <= ri; di++) {
      if (di * di + dj * dj > r2) continue;
      const c = (gj + dj) * gw + gi + di;
      const n = S.dist[c]!;
      if (n === 1) {
        const t = S.grid[c]!;
        d += t & 1 ? 1 : t & 2 ? 0 : -1;
      }
      if (apply) S.dist[c] = n - 1;
    }
  return d;
}

/** Blob cells under a disc centred on grid cell (gi, gj). */
function discBlobCells(S: Scratch, gi: number, gj: number): number {
  const { gw, ri, r2 } = DG;
  let n = 0;
  for (let dj = -ri; dj <= ri; dj++)
    for (let di = -ri; di <= ri; di++) if (di * di + dj * dj <= r2 && S.grid[(gj + dj) * gw + gi + di]! & 1) n++;
  return n;
}

/**
 * Hill-climb centres by 2- then 1-cell steps (8 directions) while the cost drops. With focus ≥ 0 only
 * that centre and its neighbours (within 3R) move: the rest of a pack is already settled.
 */
function localSearch(S: Scratch, k: number, focus: number, sweeps = 10): number {
  const { gw, gh, ri } = DG;
  const near2 = 9 * ri * ri;
  let total = 0;
  for (let sweep = 0; sweep < sweeps; sweep++) {
    let improved = false;
    for (let m = 0; m < k; m++) {
      if (focus >= 0 && m !== focus) {
        const du = GC[m * 2]! - GC[focus * 2]!;
        const dv = GC[m * 2 + 1]! - GC[focus * 2 + 1]!;
        if (du * du + dv * dv > near2) continue;
      }
      for (let step = 2; step >= 1; step--)
        for (let dir = 0; dir < 8; dir++) {
          const du = dir === 0 || dir === 4 || dir === 5 ? step : dir === 1 || dir === 6 || dir === 7 ? -step : 0;
          const dv = dir === 2 || dir === 4 || dir === 6 ? step : dir === 3 || dir === 5 || dir === 7 ? -step : 0;
          const au = GC[m * 2]!;
          const av = GC[m * 2 + 1]!;
          const bu = au + du;
          const bv = av + dv;
          if (bu < ri || bv < ri || bu > gw - 1 - ri || bv > gh - 1 - ri) continue;
          const d = moveDelta(S.grid, S.dist, au, av, bu, bv, false) + sepPenalty(k, m, bu, bv) - sepPenalty(k, m, au, av);
          if (d < -1e-9) {
            moveDelta(S.grid, S.dist, au, av, bu, bv, true);
            GC[m * 2] = bu;
            GC[m * 2 + 1] = bv;
            total += d;
            improved = true;
          }
        }
    }
    if (!improved) break;
  }
  return total;
}

/** Deepest cell (chessboard) of the blob cells no disc covers yet; −1 if none. Uses S.dist2. */
function deepestUncovered(S: Scratch): number {
  const { gw, gh } = DG;
  const D = S.dist2;
  const G = S.grid;
  const COV = S.dist;
  for (let c = 0; c < gw * gh; c++) D[c] = G[c]! & 1 && COV[c] === 0 ? BIG : 0;
  chessboardDT(D, gw, gh);
  let best = -1;
  let bd = 0;
  for (let c = 0; c < gw * gh; c++)
    if (D[c]! > bd) {
      bd = D[c]!;
      best = c;
    }
  return best;
}

function clampCell(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(v)));
}

function fitDiscs(ctx: Ctx, cnt: number, lab: number, cx: number, cy: number, ax: number, ay: number, sinEl: number, uMin: number, uMax: number, vMin: number, vMax: number, rad: number): number {
  const { S, w, h } = ctx;
  const rp = rad;
  const bx = -ay;
  const by = ax;
  const ri = Math.ceil(rp);
  const pad = ri + 2;
  const u0 = Math.floor(uMin) - pad;
  const v0 = Math.floor(vMin) - pad;
  const gw = Math.ceil(uMax) - u0 + pad + 1;
  const gh = Math.ceil(vMax) - v0 + pad + 1;
  growGrid(S, gw * gh);
  DG.gw = gw;
  DG.gh = gh;
  DG.u0 = u0;
  DG.v0 = v0;
  DG.ri = ri;
  DG.r2 = rp * rp;
  DG.sinEl = sinEl;
  DG.minSep = MIN_SEP * ctx.rp;
  const G = S.grid; // bit0 blob, bit1 unknown
  for (let gj = 0; gj < gh; gj++)
    for (let gi = 0; gi < gw; gi++) {
      const u = u0 + gi + 0.5;
      const v = v0 + gj + 0.5;
      const i = Math.floor(cx + (u / sinEl) * ax + v * bx);
      const j = Math.floor(cy + (u / sinEl) * ay + v * by);
      let cell = 2;
      if (i >= 0 && j >= 0 && i < w && j < h) {
        const k = j * w + i;
        const l = S.label[k]!;
        cell = l === lab ? 1 : S.unknown[k] || l === -1 ? 2 : 0;
      }
      G[gj * gw + gi] = cell;
    }
  const lo = ri;
  const hiU = gw - 1 - ri;
  const hiV = gh - 1 - ri;
  const thresh = Math.max(6, DISC_GAIN * Math.PI * ctx.rp * ctx.rp);
  let k = 0;
  let cost = coverAll(S, 0);
  while (k < K_MAX) {
    GSAVE.set(GC.subarray(0, k * 2));
    const deep = deepestUncovered(S);
    if (deep < 0) break;
    let bestCost = Infinity;
    // Incremental start (for a pack, polishing only the new disc and its neighbours), then two short
    // k-means restarts (an incremental placement can trap a pair or a row). Kept cheap so a 15-ball
    // rack stays within the frame budget.
    const starts = k === 0 ? 2 : 3;
    for (let start = 0; start < starts; start++) {
      if (start === 0) {
        GC.set(GSAVE.subarray(0, k * 2));
        GC[k * 2] = clampCell(deep % gw, lo, hiU);
        GC[k * 2 + 1] = clampCell(Math.floor(deep / gw), lo, hiV);
      } else {
        kmeansStart(S, cnt, k + 1, start - 1);
        for (let m = 0; m <= k; m++) {
          GC[m * 2] = clampCell(TRIAL[m * 2]! - u0 - 0.5, lo, hiU);
          GC[m * 2 + 1] = clampCell(TRIAL[m * 2 + 1]! - v0 - 0.5, lo, hiV);
        }
      }
      let c = coverAll(S, k + 1);
      c += localSearch(S, k + 1, start === 0 && k >= 3 ? k : -1, start === 0 ? 10 : 4);
      let viol = false;
      for (let m = 0; m <= k && !viol; m++) if (sepPenalty(k + 1, m, GC[m * 2]!, GC[m * 2 + 1]!) > SEP_W * (MIN_SEP - MIN_SEP_SPLIT) * ctx.rp) viol = true;
      // Each of several balls must stand on blob pixels, not mostly on unknown ones (a pocket hole).
      if (k > 0) for (let m = 0; m <= k && !viol; m++) if (discBlobCells(S, GC[m * 2]!, GC[m * 2 + 1]!) < DISC_MIN_BLOB * Math.PI * rp * rp) viol = true;
      if (!viol && c < bestCost) {
        bestCost = c;
        GTRY.set(GC.subarray(0, (k + 1) * 2));
      }
    }
    if (bestCost > cost - thresh) {
      GC.set(GSAVE.subarray(0, k * 2));
      coverAll(S, k);
      break;
    }
    k++;
    GC.set(GTRY.subarray(0, k * 2));
    cost = coverAll(S, k);
  }
  if (k > 3) localSearch(S, k, -1);
  // Backward check: drop any disc whose own contribution (cells only it explains, minus cloth only it
  // covers) has fallen below the threshold once its neighbours settled.
  for (let m = k - 1; m >= 0 && k > 1; m--) {
    if (removeDelta(S, GC[m * 2]!, GC[m * 2 + 1]!, false) >= thresh) continue;
    removeDelta(S, GC[m * 2]!, GC[m * 2 + 1]!, true);
    for (let j = m; j < k - 1; j++) {
      GC[j * 2] = GC[(j + 1) * 2]!;
      GC[j * 2 + 1] = GC[(j + 1) * 2 + 1]!;
    }
    k--;
  }
  if (k === 0) {
    BEST[0] = 0;
    BEST[1] = 0;
    return 1;
  }
  for (let m = 0; m < k; m++) {
    BEST[m * 2] = u0 + GC[m * 2]! + 0.5;
    BEST[m * 2 + 1] = v0 + GC[m * 2 + 1]! + 0.5;
  }
  return k;
}

/** Deterministic LCG in [0, 1). */
let lcg = 1;
function rnd(): number {
  lcg = (Math.imul(lcg, 1664525) + 1013904223) >>> 0;
  return lcg / 4294967296;
}

/**
 * k-means on the de-stretched blob pixels into TRIAL: variant 0 = farthest-point initialisation,
 * otherwise k-means++ with a fixed seed (deterministic).
 */
function kmeansStart(S: Scratch, n: number, k: number, variant: number): void {
  const { dq, dmin } = S;
  lcg = 12345 + variant * 7919;
  dmin.fill(Infinity, 0, n);
  let pick = 0;
  if (variant === 0) {
    let mx = 0;
    let my = 0;
    for (let q = 0; q < n; q++) {
      mx += dq[q * 2]!;
      my += dq[q * 2 + 1]!;
    }
    mx /= n;
    my /= n;
    let far = -1;
    for (let q = 0; q < n; q++) {
      const d = (dq[q * 2]! - mx) ** 2 + (dq[q * 2 + 1]! - my) ** 2;
      if (d > far) {
        far = d;
        pick = q;
      }
    }
  } else pick = Math.min(n - 1, Math.floor(rnd() * n));
  for (let m = 0; m < k; m++) {
    TRIAL[m * 2] = dq[pick * 2]!;
    TRIAL[m * 2 + 1] = dq[pick * 2 + 1]!;
    let far = -1;
    let sum = 0;
    for (let q = 0; q < n; q++) {
      const d = (dq[q * 2]! - TRIAL[m * 2]!) ** 2 + (dq[q * 2 + 1]! - TRIAL[m * 2 + 1]!) ** 2;
      if (d < dmin[q]!) dmin[q] = d;
      sum += dmin[q]!;
      if (dmin[q]! > far) {
        far = dmin[q]!;
        pick = q;
      }
    }
    if (variant > 0 && sum > 0) {
      // k-means++: next centre with probability ∝ D².
      let t = rnd() * sum;
      for (let q = 0; q < n; q++) {
        t -= dmin[q]!;
        if (t <= 0) {
          pick = q;
          break;
        }
      }
    }
  }
  for (let it = 0; it < 8; it++) {
    SUMX.fill(0, 0, k);
    SUMY.fill(0, 0, k);
    CNT.fill(0, 0, k);
    for (let q = 0; q < n; q++) {
      let bm = 0;
      let bd = Infinity;
      for (let m = 0; m < k; m++) {
        const d = (dq[q * 2]! - TRIAL[m * 2]!) ** 2 + (dq[q * 2 + 1]! - TRIAL[m * 2 + 1]!) ** 2;
        if (d < bd) {
          bd = d;
          bm = m;
        }
      }
      SUMX[bm]! += dq[q * 2]!;
      SUMY[bm]! += dq[q * 2 + 1]!;
      CNT[bm]! += 1;
    }
    for (let m = 0; m < k; m++)
      if (CNT[m]! > 0) {
        TRIAL[m * 2] = SUMX[m]! / CNT[m]!;
        TRIAL[m * 2 + 1] = SUMY[m]! / CNT[m]!;
      }
  }
}

const RESHIST = new Float64Array(81);

/**
 * Circle fit (Gauss-Newton, Huber-weighted) of every centre to the silhouette edge points it explains
 * best, in the de-stretched frame, with a shared radius tracked from the edge residuals when the blob
 * is not truncated. A centre without a well-spread arc keeps its estimate; two refined centres that
 * end up closer than MIN_SEP_SPLIT·R both revert.
 */
function refineCircles(ctx: Ctx, nEdge: number, k: number, sinEl: number, rad: number, fitRadius: boolean): void {
  const { S } = ctx;
  let rp = rad;
  const { edge, eown } = S;
  PRE.set(CENT.subarray(0, k * 2));
  for (let round = 0; round < 3; round++) {
    for (let e = 0; e < nEdge; e++) {
      const x = edge[e * 2]!;
      const y = edge[e * 2 + 1]!;
      let bm = 0;
      let bd = Infinity;
      for (let m = 0; m < k; m++) {
        const d = Math.abs(Math.hypot(x - CENT[m * 2]!, y - CENT[m * 2 + 1]!) - rp);
        if (d < bd) {
          bd = d;
          bm = m;
        }
      }
      eown[e] = bd < 0.6 * rp ? bm : -1;
    }
    for (let m = 0; m < k; m++) fitCircle(edge, eown, nEdge, m, rp);
    // With only one arc per ball (touching balls) a radius error moves the centre as much: track the
    // silhouette's dilation as the median edge residual, within a pixel or so of the model radius.
    if (fitRadius) {
      RESHIST.fill(0);
      let nr = 0;
      for (let e = 0; e < nEdge; e++) {
        const m = eown[e]!;
        if (m < 0) continue;
        const r = Math.hypot(edge[e * 2]! - CENT[m * 2]!, edge[e * 2 + 1]! - CENT[m * 2 + 1]!) - rp;
        RESHIST[Math.min(80, Math.max(0, Math.round((r + 4) * 10)))]! += 1;
        nr++;
      }
      if (nr >= 12) {
        let cum = 0;
        let b = 0;
        for (; b <= 80; b++) {
          cum += RESHIST[b]!;
          if (cum >= nr / 2) break;
        }
        rp = Math.max(rad - 1, Math.min(rad + 1.5, rp + (b / 10 - 4)));
      }
    }
  }
  const minSep2 = (MIN_SEP_SPLIT * ctx.rp) ** 2;
  for (let a = 0; a < k; a++)
    for (let b = a + 1; b < k; b++) {
      const du = (CENT[a * 2]! - CENT[b * 2]!) / sinEl;
      const dv = CENT[a * 2 + 1]! - CENT[b * 2 + 1]!;
      if (du * du + dv * dv < minSep2) {
        CENT[a * 2] = PRE[a * 2]!;
        CENT[a * 2 + 1] = PRE[a * 2 + 1]!;
        CENT[b * 2] = PRE[b * 2]!;
        CENT[b * 2 + 1] = PRE[b * 2 + 1]!;
      }
    }
}

/** One untruncated ball: circle fit, but never far from the silhouette centroid. */
function refineSingle(ctx: Ctx, nEdge: number, rad: number): void {
  const { S } = ctx;
  const rp = rad;
  CENT[0] = 0;
  CENT[1] = 0;
  for (let e = 0; e < nEdge; e++) S.eown[e] = 0;
  for (let round = 0; round < 2; round++) fitCircle(S.edge, S.eown, nEdge, 0, rp);
  if (Math.hypot(CENT[0]!, CENT[1]!) > 0.5 * rp) {
    CENT[0] = 0;
    CENT[1] = 0;
  }
}

/** Gauss-Newton steps of |q − c| = rp over the edge points owned by centre m (CENT[m]). */
function fitCircle(edge: Float64Array, eown: Int32Array, nEdge: number, m: number, rp: number): void {
  let cu = CENT[m * 2]!;
  let cv = CENT[m * 2 + 1]!;
  const delta = Math.max(1, 0.25 * rp);
  for (let it = 0; it < 4; it++) {
    let a11 = 0;
    let a12 = 0;
    let a22 = 0;
    let g1 = 0;
    let g2 = 0;
    let nw = 0;
    let np = 0;
    for (let e = 0; e < nEdge; e++) {
      if (eown[e] !== m) continue;
      const dx = edge[e * 2]! - cu;
      const dy = edge[e * 2 + 1]! - cv;
      const d = Math.hypot(dx, dy);
      if (d < 1e-6) continue;
      const nx = dx / d;
      const ny = dy / d;
      const r = d - rp;
      const wgt = Math.abs(r) <= delta ? 1 : delta / Math.abs(r);
      a11 += wgt * nx * nx;
      a12 += wgt * nx * ny;
      a22 += wgt * ny * ny;
      g1 += wgt * nx * r;
      g2 += wgt * ny * r;
      nw += wgt;
      np++;
    }
    if (np < 8) return;
    // Arc spread: both eigenvalues of the normalised normal scatter must be ≥ 0.08 (arc ≳ 60°).
    const t = (a11 + a22) / nw;
    const dd = (a11 * a22 - a12 * a12) / (nw * nw);
    const lmin = t / 2 - Math.sqrt(Math.max(0, (t * t) / 4 - dd));
    if (lmin < 0.08) return;
    const det = a11 * a22 - a12 * a12;
    const du = (a22 * g1 - a12 * g2) / det;
    const dv = (a11 * g2 - a12 * g1) / det;
    cu += du;
    cv += dv;
    CENT[m * 2] = cu;
    CENT[m * 2 + 1] = cv;
    if (Math.abs(du) + Math.abs(dv) < 0.02) return;
  }
}

/** Colour statistics, name and cue score for ball m of the blob; appends a detection. */
function describe(ctx: Ctx, start: number, cnt: number, m: number, n: number, a1: number, pos: Vec2, blob: number, complete: number): void {
  const { S } = ctx;
  const { queue, assign, rgb, hue, sat, val } = S;
  if (n === 0) return;
  // Pass 1: brightness histogram, hue histogram of the coloured pixels, sums.
  VHIST.fill(0);
  HUEHIST.fill(0);
  let r = 0;
  let g = 0;
  let b = 0;
  let satSum = 0;
  let colored = 0;
  for (let q = 0; q < cnt; q++) {
    if (assign[q] !== m) continue;
    const k = queue[start + q]!;
    r += rgb[k * 3]!;
    g += rgb[k * 3 + 1]!;
    b += rgb[k * 3 + 2]!;
    const s = sat[k]!;
    const v = val[k]!;
    satSum += s;
    VHIST[Math.min(31, Math.floor(v * 32))]! += 1;
    if (s > 0.4 && v > 0.12) {
      colored++;
      HUEHIST[Math.min(35, Math.floor(hue[k]! / 10))]! += 1;
    }
  }
  const vTop = histQuantile(VHIST, 0, 32, n, 0.9);
  const vLow = histQuantile(VHIST, 0, 32, n, 0.1);
  const v75 = histQuantile(VHIST, 0, 32, n, 0.75);
  // A ball is shaded (lit top, dark lower rim, highlight); a lamp's glare on the cloth is flat.
  if (vTop - vLow < FLAT_SPREAD * Math.max(vTop, 0.05)) return;
  // Robust hue: circular mean of the coloured pixels within ±25° of the (3-bin smoothed) modal bin.
  let mode = 0;
  let modeC = -1;
  for (let i = 0; i < 36; i++) {
    const c = HUEHIST[(i + 35) % 36]! + HUEHIST[i]! + HUEHIST[(i + 1) % 36]!;
    if (c > modeC) {
      modeC = c;
      mode = i;
    }
  }
  const modeHue = mode * 10 + 5;
  // Pass 2: white pixels (relative to this ball's own brightness, so the shaded half counts), and the
  // hue group's mean hue, median S and p75 V.
  const whiteV = Math.max(0.35, 0.6 * vTop);
  let white = 0;
  let hsx = 0;
  let hsy = 0;
  let ng = 0;
  GHIST.fill(0);
  let sg = 0;
  let tint = 0;
  for (let q = 0; q < cnt; q++) {
    if (assign[q] !== m) continue;
    const k = queue[start + q]!;
    const s = sat[k]!;
    const v = val[k]!;
    if (s < 0.25 && v > whiteV) white++;
    // Faintly coloured, not by cloth bleed: the thin band of a stripe turned away from the camera
    // (video chroma subsampling washes it to a tint). The cue ball is the only all-white ball.
    if (s > TINT_S && s <= 0.4 && v > 0.2 && hueDiff(hue[k]!, ctx.clothHue) > 45) tint++;
    if (s > 0.4 && v > 0.12 && hueDiff(hue[k]!, modeHue) <= 25) {
      const a = (hue[k]! * Math.PI) / 180;
      hsx += Math.cos(a);
      hsy += Math.sin(a);
      GHIST[Math.min(31, Math.floor(v * 32))]! += 1;
      sg += s;
      ng++;
    }
  }
  const mr = r / n;
  const mg = g / n;
  const mb = b / n;
  const mx = Math.max(mr, mg, mb);
  const meanSat = mx > 0 ? (mx - Math.min(mr, mg, mb)) / mx : 0;
  const whiteFrac = white / n;
  const colFrac = colored / n;
  let base: string;
  if (v75 < 0.2 && colFrac < 0.5) base = 'black';
  else if (meanSat < 0.12 || ng < Math.max(3, 0.1 * n)) base = 'white';
  else {
    let hh = (Math.atan2(hsy, hsx) * 180) / Math.PI;
    if (hh < 0) hh += 360;
    base = colourName(ctx.swatches, hh, sg / ng, histQuantile(GHIST, 0, 32, ng, 0.75));
  }
  const label = base !== 'white' && base !== 'black' && base !== 'ball' && whiteFrac > 0.25 ? `${base} stripe` : base;
  ctx.found.push({
    ball: {
      pos,
      image: applyH(ctx.HR, pos.x, pos.y),
      isCue: false,
      score: Math.min(1, n / a1),
      rgb: [mr, mg, mb],
      label,
      // Cue-ball likelihood: lots of white, almost no saturated pixels, and a neutral MEAN colour
      // (the saturation of the mean RGB survives video chroma subsampling, unlike per-pixel S).
      white: whiteFrac - 2.5 * colFrac - 2 * meanSat - 0.25 * (satSum / n) - TINT_W * (tint / n),
      px: n,
    },
    blob,
    complete,
    spread: vTop - vLow,
  });
}
