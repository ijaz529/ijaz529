/**
 * Ball detection (research.md R-04):
 *  1. Rectify the image through H_R, the homography of the plane at ball-centre height. A ball's
 *     silhouette then projects to a blob centred on its true (X, Y), elongated by ≈1/sin(elevation)
 *     toward the camera (parallax corrected to first order). Scaling the along-view axis by
 *     sin(elevation) ("de-stretching") turns every silhouette into a disc of radius R.
 *  2. Mark non-cloth pixels: the table detector's loose cloth test, tightened by the cloth's own
 *     saturation spread so cloth-hued balls (snooker green, pool 6) still stand out, plus the
 *     white/green blend seams inside a cloth-coloured stripe. Pixels a near cushion hides, and hole-like
 *     (dark) pixels in the pocket throats, are "unknown" (neither ball nor cloth).
 *  3. Connected blobs (small holes filled) → strip long thin attachments (a cue stick) → count and
 *     place balls with a disc model in the de-stretched frame (multi-start, local search; a ball whose
 *     silhouette adds nothing to the blob is not counted; the silhouettes' dilation is measured on
 *     coloured single balls, in image pixels) → fit a circle to each ball's visible silhouette boundary
 *     (occluded and unknown edges excluded).
 *  4. Shape gate (fill, aspect, size, shading, width across the view) rejects lamp glare and sticks.
 *  5. Colour: robust hue and brightness (relative to the frame's white through the cloth beside each
 *     ball) named from the table's palette; the cue ball is the whitest COMPLETE ball with a clear
 *     margin over the runner-up, otherwise no ball is flagged (the app then asks the player to tap the
 *     cue ball, spec edge case).
 *
 * Known limits (Constitution II), measured on the ray-traced fixtures:
 *  - a ball whose silhouette is (almost) entirely inside its neighbours' (the middle of a pack seen from
 *    low down) cannot be counted from the silhouette;
 *  - a stripe whose band is edge-on to the camera looks exactly like the cue ball;
 *  - on 4:2:0 video a cloth-coloured stripe's band is partly averaged into the caps' chroma and reads
 *    as cloth: with its band facing the camera the green 14 on green cloth is lost in most 4:2:0 frames
 *    (RGB: 11 of 12 found);
 *  - a black ball 1R inside a far pocket (its dark pixels merge with the hole) is missed in about a
 *    third of the views, as by the 0.2.x detector;
 *  - on 4:2:0 video a snooker pack in the end and corner views loses 3–5 reds (median error 14–20 mm);
 *  - a cue stick crossing the near cushion diagonally (butt raised ≥ 8°) can leave one piece that
 *    passes as a ball.
 *
 * All per-pixel work runs on module-level typed arrays reused across frames (Constitution IV), with no
 * per-pixel function calls taking double arguments (they would be boxed). Thresholds below are
 * image-processing tunables, not physical constants. ASSUMPTION: values were tuned on the ray-traced
 * fixtures (tests/unit/vision) and carry no external source.
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
/**
 * Seams (markSeams): S below the cloth's median by SEAM_S_MARGIN (a desaturated, i.e. whitened, cloth-hued
 * pixel); white = S < 0.25 and V above the cloth's by SEAM_WHITE_V; both sides within SEAM_REACH px.
 */
const SEAM_S_Q = 0.5;
const SEAM_S_MARGIN = 0.02;
const SEAM_WHITE_V = 0.1;
const SEAM_REACH = 4;
/** …and the saturated side must be a non-cloth pixel at least this bright (a dark shadow's S is noise). */
const SEAM_SAT_V = 0.2;
/** …and the seam pixel itself at least this × the cloth's V. */
const SEAM_V = 0.75;
/** Need this many cloth pixels before trusting the cloth's S spread. */
const CLOTH_STATS_MIN = 500;
/** In a pocket throat, pixels darker than this × cloth V count as hole (unknown). */
const THROAT_V = 0.5;
/** Near-cushion occlusion: the hidden strip is widened by this many rectified px. */
const CUSH_MARGIN = 1.5;
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
/** Width-across-the-view check (wideAcross): sample half-width and along-view offsets, × R. */
const WIDE_R = 0.82;
const WIDE_U = 0.3;
/** A blob whose boundary touches unknown pixels (throat, frame edge, stick) this much is truncated. */
const TRUNC_FRAC = 0.12;
/**
 * Cue ball: completeness (own + hidden share of the true-size silhouette) at least CUE_FILL minus the
 * rim a white ball's mask can lose (about half a pixel of blur or chroma erosion: 1/rp of its area);
 * minimum white score, luminance spread, margin over the runner-up. Measured on the fixtures: a real
 * cue ball 0.84–1.0 (0.84 = snooker on 4:2:0, rp ≈ 4 px), a stripe whose band reads as cloth 0.5–0.87.
 */
const CUE_FILL = 0.92;
const CUE_FILL_MIN = 0.75;
const CUE_MIN_WHITE = 0.05;
const CUE_SPREAD = 0.15;
const CUE_MARGIN = 0.15;
/** Any ball: luminance spread p90 − p10 at least this × p90 (shading); flat bright blobs are glare. */
const FLAT_SPREAD = 0.25;
/** Tint: saturation above this but ≤ 0.4, hue away from the cloth; weighted into the cue score. */
const TINT_S = 0.12;
const TINT_W = 1.5;
/**
 * Coloured-silhouette dilation (image px) of a video frame. ASSUMPTION: measured on the ray-traced
 * fixtures (coloured single balls, truth calibration): median 0.29–0.41 image px on sharp RGB frames,
 * 0.44–0.64 on 4:2:0 video frames (chroma averaged over 2×2 blocks bleeds into the cloth). Without a
 * coloured single ball the fit starts at the sharp-frame size (dilation 0, the regime the disc model's
 * pack sensitivity is tuned in) and tries this when that fit is not self-consistent.
 */
const CHROMA_DIL = 0.5;
/** A single blob with more than this share of low-S pixels is a white (or black) ball: luma-bound rim. */
const WHITE_BLOB = 0.7;
/** Self-consistency refit: clusters of at most this many balls whose plain-view part is > VIS_CLOTH cloth. */
const SMALL_CLUSTER = 4;
const VIS_CLOTH = 0.08;
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
/**
 * Prototype hues of the ball sets and brightness bounds (V relative to white, see nameBalls).
 * ASSUMPTION: measured on the synthetic pigments over 4 poses × RGB/4:2:0 × gains 0.65–1.25, green and
 * blue cloth (hue medians: red 359–2°, orange 25–30°, yellow 48–54°, green 140°, blue 219–223°, purple
 * 275°; relative V: red 0.64–0.87, red stripe 0.68–1.0, maroon stripe 0.35–0.66 at gain ≤ 1); typical
 * of real balls, no colorimetric source. Red and maroon share a hue: between their V bounds the name is
 * the neutral 'ball'. (A white reference clipped by over-exposure reads maroon up to ~0.67.)
 */
const POOL_SWATCHES: Swatch[] = [
  { name: 'red', hue: 2, vMin: 0.66 },
  { name: 'maroon', hue: 2, vMax: 0.62 },
  { name: 'orange', hue: 30 },
  { name: 'yellow', hue: 53 },
  { name: 'green', hue: 140 },
  { name: 'blue', hue: 220 },
  { name: 'purple', hue: 275 },
];
const SNOOKER_SWATCHES: Swatch[] = [
  { name: 'red', hue: 2, sMin: 0.65 },
  { name: 'pink', hue: 343, sMax: 0.7, vMin: 0.64 },
  { name: 'brown', hue: 26, vMax: 0.585 },
  { name: 'yellow', hue: 53, vMin: 0.48 },
  { name: 'green', hue: 140 },
  { name: 'blue', hue: 220 },
];
/**
 * Best and runner-up swatch hues closer than this → the neutral name 'ball' (the hue is near the
 * midpoint of two ball colours: naming either would be a guess). With the measured prototypes the
 * nearest pair (red–orange, 28° apart) leaves ±10° of each prototype unambiguous.
 */
const NAME_MARGIN = 8;
/** A ball whose white share (stripe caps) is above this is a stripe; a solid's highlight is ≲ 1 %. */
const STRIPE_WHITE = 0.05;
/** Without a white ball in view, white ≈ this × the cloth's V. ASSUMPTION: fixture value (1.9). */
const WHITE_PER_CLOTH = 1.9;

function colourName(sw: Swatch[], h: number, s: number, v: number): string {
  let best: Swatch | null = null;
  let bd = Infinity;
  let second = Infinity;
  let nearest = Infinity;
  for (let i = 0; i < sw.length; i++) {
    const e = sw[i]!;
    nearest = Math.min(nearest, hueDiff(h, e.hue));
    if ((e.vMin !== undefined && v < e.vMin) || (e.vMax !== undefined && v >= e.vMax)) continue;
    if ((e.sMin !== undefined && s < e.sMin) || (e.sMax !== undefined && s > e.sMax)) continue;
    const d = hueDiff(h, e.hue);
    if (d < bd) {
      second = bd;
      bd = d;
      best = e;
    } else if (d < second) second = d;
  }
  // The hue says one colour but its brightness/saturation bounds rule it out (between red and maroon):
  // a farther hue's name would be a guess.
  if (!best || bd > 45 || second - bd < NAME_MARGIN || bd - nearest > NAME_MARGIN) return 'ball';
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
  /** k-means lower bounds (Hamerly); seeding distances of the two k-means variants. */
  dlo: Float64Array;
  km0: Float64Array;
  km1: Float64Array;
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
    dlo: prev?.dlo ?? new Float64Array(0),
    km0: prev?.km0 ?? new Float64Array(0),
    km1: prev?.km1 ?? new Float64Array(0),
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
  S.dlo = new Float64Array(S.bcap);
  S.km0 = new Float64Array(S.bcap);
  S.km1 = new Float64Array(S.bcap);
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
const WHIST = new Float64Array(32);
const THROAT = new Float64Array(8 * 6);
const CENT = new Float64Array(K_MAX * 2);
const TRIAL = new Float64Array(K_MAX * 2);
const BEST = new Float64Array(K_MAX * 2);
const PRE = new Float64Array(K_MAX * 2);
const SAVE = new Float64Array(K_MAX * 2);
/** Quality of the last fitDiscs: largest visible-cloth share of a disc (small clusters only). */
const FITQ = { visCloth: 0 };
const SUMX = new Float64Array(K_MAX);
const SUMY = new Float64Array(K_MAX);
const CNT = new Float64Array(K_MAX);
const HALF = new Float64Array(K_MAX);
const MOVED = new Float64Array(K_MAX);
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
    const dh = Math.sqrt(dx * dx + dy * dy) || 1;
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

/** Point for inThroat (passed through a typed array: boxed double arguments would allocate per pixel). */
const TXY = new Float64Array(2);

function inThroat(n: number): boolean {
  const X = TXY[0]!;
  const Y = TXY[1]!;
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

/**
 * Cushions between the camera and the playing surface. Seen from behind a rail, the cushion (nose at
 * cushionHeight > R) hides the part of the z = R plane just inside its nose, and everything over the
 * cushion itself: there a ball is occluded, so those rectified pixels are unknown (neither ball nor
 * cloth), and the cushion's edge in the image is no silhouette edge. Far cushions (camera on the
 * playing side of the nose line) hide nothing a ball could be behind: a ball occludes them instead.
 * Per near cushion segment: a.x, a.y, tangent, length, inward normal, |camera distance|, max depth.
 */
const CUSH = new Float64Array(8 * 9);

function fillCushions(calib: Calibration, table: TableSpec, margin: number): number {
  const cam = calib.camera;
  const R = table.ballRadius;
  const hc = table.cushionHeight;
  if (!(cam.z > hc + 0.05) || !(hc > R)) return 0;
  let n = 0;
  const segs = table.cushions;
  for (let i = 0; i < segs.length && n < 8; i++) {
    const s = segs[i]!;
    const dC = (cam.x - s.a.x) * s.n.x + (cam.y - s.a.y) * s.n.y;
    if (dC >= -1e-3) continue; // camera on the playing side: this cushion hides nothing
    const tx = s.b.x - s.a.x;
    const ty = s.b.y - s.a.y;
    const len = Math.sqrt(tx * tx + ty * ty);
    if (len < 1e-6) continue;
    const o = n * 9;
    CUSH[o] = s.a.x;
    CUSH[o + 1] = s.a.y;
    CUSH[o + 2] = tx / len;
    CUSH[o + 3] = ty / len;
    CUSH[o + 4] = len;
    CUSH[o + 5] = s.n.x;
    CUSH[o + 6] = s.n.y;
    CUSH[o + 7] = -dC;
    // A ray to (X, Y, R) at depth d inside the nose crosses the nose line at height
    // R + (cam.z − R)·d / (|dC| + d); it clears the nose (height hc) once d ≥ |dC|·(hc − R)/(cam.z − hc).
    // Plus a margin: the occlusion line is only known to a pixel or so (blur, chroma erosion of the rim).
    CUSH[o + 8] = (-dC * (hc - R)) / (cam.z - hc) + margin;
    n++;
  }
  return n;
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
  const nC = fillCushions(calib, table, CUSH_MARGIN / scale);
  const camX = calib.camera.x;
  const camY = calib.camera.y;
  const cw = table.cushionWidth;
  const darkV = THROAT_V * cloth.val;
  // Pass 2: tightened cloth test; pixels hidden by a near cushion, and hole-like pixels in the
  // throats, become unknown.
  for (let j = 0; j < h; j++) {
    const Y = hy - (j + 0.5) / scale;
    for (let i = 0; i < w; i++) {
      const k = j * w + i;
      if (unknown[k]) continue;
      // Hidden by a near cushion? (Inlined: a per-pixel call with double arguments would box them.)
      let hid = false;
      if (nC > 0) {
        const X = -hx + (i + 0.5) / scale;
        for (let c = 0; c < nC && !hid; c++) {
          const o = c * 9;
          const d = (X - CUSH[o]!) * CUSH[o + 5]! + (Y - CUSH[o + 1]!) * CUSH[o + 6]!;
          if (d > CUSH[o + 8]! || d < -cw) continue;
          // Where the ray from the camera crosses the nose line (P itself when over the cushion).
          const t = d > 0 ? CUSH[o + 7]! / (CUSH[o + 7]! + d) : 1;
          const qx = camX + t * (X - camX);
          const qy = camY + t * (Y - camY);
          const along = (qx - CUSH[o]!) * CUSH[o + 2]! + (qy - CUSH[o + 1]!) * CUSH[o + 3]!;
          if (along >= 0 && along <= CUSH[o + 4]!) hid = true;
        }
      }
      if (hid) {
        nonCloth[k] = 0;
        unknown[k] = 1;
        continue;
      }
      const s = sat[k]!;
      const vv = val[k]!;
      let nc = nonCloth[k]!;
      // S of a dark pixel is quantisation noise (and video chroma clamps it toward 1): widen the margin
      // by one 8-bit step of relative error, and leave the darkest pixels to the loose test.
      if (!nc && vv >= 0.12 && s > sHi + 1 / (255 * vv)) nc = 1;
      // Any saturation: video chroma bleed makes the hole's rim dark but coloured, and a dark ball pixel
      // here is only "unknown", which the fit treats as possibly ball.
      if (nc && vv < darkV) {
        TXY[0] = -hx + (i + 0.5) / scale;
        TXY[1] = Y;
      }
      if (nc && vv < darkV && inThroat(nT)) {
        nc = 0;
        unknown[k] = 1;
      }
      nonCloth[k] = nc;
    }
  }
  if (Number.isFinite(sHi)) markSeams(w, h, b, cloth, histQuantile(CLOTH_HIST, 0, 64, nCloth, SEAM_S_Q) - SEAM_S_MARGIN, sHi);
}

/**
 * From seam candidate k, step through blend pixels (cloth-hued, S below sLo) for up to SEAM_REACH px:
 * 1 = reached a white pixel, 2 = a saturated cloth-hued ball pixel, 0 = neither (plain cloth, unknown,
 * anything else, or too far). Integer arguments only (per-pixel call: doubles would be boxed).
 */
function seamEnd(b: RectBuffers, k: number, step: number): number {
  const { hue, sat, val, nonCloth, unknown } = b;
  const sLo = SEAMP[0]!;
  const sHi = SEAMP[1]!;
  const vWhite = SEAMP[2]!;
  const clothHue = SEAMP[3]!;
  for (let r = 1; r <= SEAM_REACH; r++) {
    const p = k + r * step;
    if (unknown[p]) return 0;
    const s = sat[p]!;
    if (s < 0.25 && val[p]! > vWhite) return 1;
    if (nonCloth[p] && s > sHi && val[p]! >= SEAM_SAT_V && hueDiff(hue[p]!, clothHue) < 30) return 2;
    if (s >= sLo || hueDiff(hue[p]!, clothHue) > 30) return 0; // plain cloth (or another colour)
  }
  return 0;
}

/** seamEnd's thresholds: sLo, sHi, white V, cloth hue. */
const SEAMP = new Float64Array(4);
/** Pixel offsets of the 4 seam directions (dx, dy). */
const SEAM_DIRS = new Int32Array([1, 0, 0, 1, 1, 1, 1, -1]);

/**
 * A stripe in the cloth's own colour (the green 14 on green cloth): where its white cap meets its band,
 * the blurred pixels are white + green mixes, cloth-hued and less saturated than the cloth, and read as
 * cloth, cutting the ball into fragments that each fail the shape gate. Such a pixel is non-cloth when
 * a white pixel lies within SEAM_REACH px on one side and a cloth-hued pixel more saturated than any
 * cloth (sHi) on the opposite side. A white ball's rim on cloth, or lamp glare, has no saturated side.
 */
function markSeams(w: number, h: number, b: RectBuffers, cloth: ClothModel, sLo: number, sHi: number): void {
  const { hue, sat, val, nonCloth, unknown } = b;
  const vWhite = cloth.val + SEAM_WHITE_V;
  SEAMP[0] = sLo;
  SEAMP[1] = sHi;
  SEAMP[2] = vWhite;
  SEAMP[3] = cloth.hue;
  for (let j = SEAM_REACH; j < h - SEAM_REACH; j++)
    for (let i = SEAM_REACH; i < w - SEAM_REACH; i++) {
      const k = j * w + i;
      if (nonCloth[k] || unknown[k]) continue;
      const s0 = sat[k]!;
      // A white + green blend is about as bright as the cloth or brighter; a ball's shaded rim next to
      // its own (video-chroma-saturated) shadow is darker.
      if (s0 >= sLo || s0 < 0.1 || val[k]! < SEAM_V * cloth.val || hueDiff(hue[k]!, cloth.hue) > 30) continue;
      let seam = false;
      for (let d = 0; d < 4 && !seam; d++) {
        const step = SEAM_DIRS[d * 2 + 1]! * w + SEAM_DIRS[d * 2]!;
        // Walk out on each side through further blend pixels to the first white or saturated pixel; a
        // plain cloth pixel on the way (a real gap, as between two touching balls) ends the walk.
        const pos = seamEnd(b, k, step);
        if (pos === 0) continue;
        const neg = seamEnd(b, k, -step);
        seam = (pos === 1 && neg === 2) || (pos === 2 && neg === 1);
      }
      if (seam) nonCloth[k] = 1;
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
  /** The cloth's typical brightness V (the exposure reference for brightness-based colour names). */
  clothVal: number;
  HR: Mat3;
  swatches: Swatch[];
  next: number;
  /** Focal length (image px). */
  focal: number;
  /**
   * The frame's silhouette dilation in IMAGE px (+ = coloured blobs larger than the true silhouette),
   * measured on coloured single balls; NaN when the frame has none to measure it by.
   */
  dil: number;
  found: Found[];
}

/** A detection plus internal evidence used for dedupe, cue selection and naming. */
interface Found {
  ball: DetectedBall;
  blob: number;
  complete: number;
  spread: number;
  /** Colour evidence: robust hue (°), median S and p75 V of the hue group; the ball's p90 V; white share. */
  hue: number;
  sat: number;
  v75: number;
  vTop: number;
  whiteFrac: number;
  /** p75 V of the ball's own white pixels (a stripe's caps; 0 if too few). */
  whiteV: number;
  /** The cloth's brightness next to the ball (local illumination reference). */
  clothV: number;
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
  const dh = Math.sqrt(dx * dx + dy * dy);
  const hz = Math.max(0.2, ctx.cam.z - ctx.R);
  VIEW.sinEl = hz / Math.sqrt(dh * dh + hz * hz);
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
    clothVal: cloth.val,
    HR: calib.HR,
    swatches: palette === 'snooker' ? SNOOKER_SWATCHES : POOL_SWATCHES,
    next: 1,
    focal: calib.focal,
    dil: NaN,
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
    let whiteLike = 0;
    while (head < tail) {
      const k = queue[head++]!;
      const i = k % w;
      const j = (k - i) / w;
      si += i;
      sj += j;
      sii += i * i;
      sjj += j * j;
      sij += i * j;
      const sk = S.sat[k]!;
      if (sk > 0.4 && hueDiff(S.hue[k]!, cloth.hue) < 30) clothLike++;
      else if (sk < 0.25) whiteLike++;
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
    COMPS[o + 9] = whiteLike / tail;
    nComp++;
  }
  // The frame's silhouette dilation: median over coloured single-ball-like blobs of (effective
  // de-stretched radius − R), in image px (it is image blur and chroma bleed: a far blob's rectified
  // silhouette is dilated by more rectified px). Video chroma bleed dilates coloured silhouettes by
  // ~1 px; that ring must not read as a ball. With no such blob in view, each cluster picks its own
  // (processBlob).
  let nd = 0;
  for (let c = 0; c < nComp; c++) {
    // A white ball's rim is set by luma (chroma bleed tints it toward the cloth): not a measure of the
    // coloured balls' dilation.
    if (COMPS[c * COMP_STRIDE + 9]! > WHITE_BLOB) continue;
    const d = singleDilation(ctx, c);
    if (Number.isFinite(d)) DILS[nd++] = d;
  }
  ctx.dil = NaN;
  if (nd >= 1) {
    DILS.subarray(0, nd).sort();
    ctx.dil = Math.max(-1, Math.min(2, nd & 1 ? DILS[nd >> 1]! : (DILS[(nd >> 1) - 1]! + DILS[nd >> 1]!) / 2));
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
      const ex = a.ball.pos.x - b.ball.pos.x;
      const ey = a.ball.pos.y - b.ball.pos.y;
      if (ex * ex + ey * ey < MIN_SEP * MIN_SEP * R * R) {
        const ww = a.ball.px + b.ball.px;
        a.ball.pos = { x: (a.ball.pos.x * a.ball.px + b.ball.pos.x * b.ball.px) / ww, y: (a.ball.pos.y * a.ball.px + b.ball.pos.y * b.ball.px) / ww };
        a.ball.image = applyH(calib.HR, a.ball.pos.x, a.ball.pos.y);
        a.ball.px = ww;
        a.complete = Math.max(a.complete, b.complete);
        found.splice(j, 1);
      }
    }

  nameBalls(ctx);

  // Cue ball: the whitest COMPLETE ball (a stripe whose band dropped out is not), with real shading
  // (flat glare is not), and clearly whiter than the runner-up. Otherwise no ball is the cue: the
  // tracker's vote then decays and the app asks the player to tap the cue ball (spec edge case).
  let best = -1;
  let second = -1;
  const cueFill = Math.max(CUE_FILL_MIN, CUE_FILL - 0.5 / ctx.rp);
  for (let i = 0; i < found.length; i++) {
    const f = found[i]!;
    if (f.complete < cueFill || f.ball.white < CUE_MIN_WHITE || f.spread < CUE_SPREAD) continue;
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

const COMP_STRIDE = 10;
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
  return (Math.sqrt((n * sinEl) / Math.PI) - rp) / pxPerImagePx(ctx, mi + 0.5, mj + 0.5);
}

/**
 * De-stretched rectified px per image px at rectified point (cx, cy): an image pixel's footprint on the
 * ball-centre plane is D/f across the view and D/(f·sinEl) along it, i.e. D/f in both axes once
 * de-stretched (D = camera distance, f = focal length in px).
 */
function pxPerImagePx(ctx: Ctx, cx: number, cy: number): number {
  const dx = ctx.x0 + cx / ctx.scale - ctx.cam.x;
  const dy = ctx.y0 - cy / ctx.scale - ctx.cam.y;
  const dz = ctx.R - ctx.cam.z;
  const D = Math.sqrt(dx * dx + dy * dy + dz * dz);
  return Math.max(0.3, Math.min(4, (D * ctx.scale) / Math.max(1, ctx.focal)));
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
  const rho = pxPerImagePx(ctx, cx, cy);
  const known = Number.isFinite(ctx.dil);
  const dil = single ? Math.max(-1, Math.min(2, Math.sqrt((cnt * sinEl) / Math.PI) - rp)) : known ? Math.max(-1, Math.min(2.5, ctx.dil * rho)) : 0;
  let rad = rp + dil;
  let k = fitDiscs(ctx, cnt, lab, cx, cy, ax, ay, sinEl, uMin, uMax, vMin, vMax, rad);
  if (!single && !known && !truncated && k > 1 && k <= SMALL_CLUSTER && FITQ.visCloth > VIS_CLOTH) {
    // The frame has no coloured single ball to measure its dilation by (a lone cue ball and touching
    // pairs), and the fit at the sharp-frame size is not self-consistent: some ball's part in plain
    // view lies on cloth. That is what too-small discs on a dilated (video chroma) silhouette do: they
    // put extra balls on the ring and push the real ones off centre. Refit at the 4:2:0-video size and
    // keep it if it needs fewer balls or is more consistent (larger discs show a little more cloth at
    // their rims, so that is compared only at equal counts). Packs are left alone: their half-hidden
    // balls show only as slivers, and the shared outline fits tightly.
    const c0 = FITQ.visCloth;
    SAVE.set(BEST.subarray(0, k * 2));
    const rad1 = rp + Math.min(1.5, CHROMA_DIL * rho);
    const k1 = fitDiscs(ctx, cnt, lab, cx, cy, ax, ay, sinEl, uMin, uMax, vMin, vMax, rad1);
    if (k1 < k || (k1 === k && FITQ.visCloth < c0)) {
      k = k1;
      rad = rad1;
    } else BEST.set(SAVE.subarray(0, k * 2));
  }
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
    // unknown). Completeness: share that is THIS ball, or hidden (unknown: a cushion, a pocket, the
    // frame edge; or a nearer ball in front of it) — low for a stripe whose band reads as cloth.
    const fill = silhouetteFill(ctx, xr, yr, ax, ay, sinEl);
    let n = 0;
    let ownIn = 0;
    let occ = 0;
    const rr2 = 0.81 * r2;
    for (let q = 0; q < cnt; q++) {
      const a = assign[q]!;
      if (a !== m) {
        // A nearer ball's pixels inside this one's silhouette hide it: occluded, not missing.
        if (CENT[a * 2]! < cu) {
          const du = dq[q * 2]! - cu;
          const dv = dq[q * 2 + 1]! - cv;
          if (du * du + dv * dv <= rr2) occ++;
        }
        continue;
      }
      n++;
      const du = dq[q * 2]! - cu;
      const dv = dq[q * 2 + 1]! - cv;
      if (du * du + dv * dv <= rr2) ownIn++;
    }
    // …and its own pixels (plus unknown ones) must add up to a whole silhouette of the TRUE radius (not
    // this blob's own size: a stripe missing its band would shrink its own disc). Not the frame's dilation
    // either: video chroma bleed dilates the coloured balls' masks by about a pixel, but a white ball's
    // rim is set by luma and its chroma is pulled toward the cloth, so its mask is if anything eroded
    // (measured on the fixture: coloured +5–15 % pixels on 4:2:0, white −3–7 %). Only cue candidates use this.
    const hidden = FILL.unk + occ;
    const whole = (n + hidden / 0.81) / ((Math.PI * r2) / sinEl);
    const own = FILL.tot > 0 ? Math.min(1, (ownIn + hidden) / FILL.tot, whole) : 0;
    if (k === 1) {
      if (fill < MIN_FILL) continue;
      if (!truncated) {
        if (cnt < MIN_SINGLE_AREA * a1 || Math.abs(aspect * sinEl - 1) > ASPECT_TOL) continue;
      }
    } else {
      if (fill < MIN_FILL || n < 0.15 * Math.PI * r2) continue;
    }
    // A ball is ~2R wide across the view at any elevation; a cue stick seen end-on is a strip ≲ 1.2R
    // wide, which the disc model reads as a chain of balls, or cut into truncated pieces by the thin-part
    // strip. (An untruncated single-ball blob has the aspect gate.)
    if ((k > 1 || truncated) && !wideAcross(ctx, xr, yr, ax, ay, sinEl)) continue;
    pos.x = Math.max(-(table.length / 2 - ctx.R), Math.min(table.length / 2 - ctx.R, pos.x));
    pos.y = Math.max(-(table.width / 2 - ctx.R), Math.min(table.width / 2 - ctx.R, pos.y));
    describe(ctx, start, cnt, m, n, a1, pos, lab, own);
  }
}

/**
 * Width across the view: does the silhouette (any ball, or unknown) reach WIDE_R·R to both sides of the
 * centre (xr, yr), measured at the centre and WIDE_U·R before and behind it along the view? A ball does
 * (its half-chord there is ≥ 0.95R; a white ball's mask erodes by ≲ 0.1R); a cue butt (≤ 15 mm radius,
 * ≲ 1.2× magnified when raised above the ball-centre plane, plus ~1 px of chroma) reaches ≲ 0.76R.
 * Each side, and the centre line, needs 2 of its 3 samples. The flank samples sit half a pixel
 * further in: a white ball's mask erodes by about that on video (chroma pulled toward the cloth).
 */
function wideAcross(ctx: Ctx, xr: number, yr: number, ax: number, ay: number, sinEl: number): boolean {
  const { S, w, h, rp } = ctx;
  const bx = -ay;
  const by = ax;
  // side −1 / +1: the two flanks; side 0: the centre line itself (a ball's centre is inside it).
  for (let side = -1; side <= 1; side++) {
    let ok = 0;
    for (let t = -1; t <= 1; t++) {
      const u = t * WIDE_U * rp; // de-stretched along the view
      const v = side * (WIDE_R * rp - 0.5);
      const i = Math.floor(xr + (u / sinEl) * ax + v * bx);
      const j = Math.floor(yr + (u / sinEl) * ay + v * by);
      if (i < 0 || j < 0 || i >= w || j >= h) {
        ok++;
        continue;
      }
      const k = j * w + i;
      if (S.mask[k] || S.unknown[k] || S.label[k] === -1) ok++;
    }
    if (ok < 2) return false;
  }
  return true;
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

/**
 * Coverage change of each local-search move (2- and 1-cell steps in 8 directions), precomputed for the
 * fit's disc: the cells that leave (−1) or enter (+1) the disc, relative to its old centre. A move then
 * touches only its symmetric difference (~4·ri cells) instead of the discs' whole bounding box.
 */
const MOVE_MAX = 16 * 600;
const MOFF = new Int32Array(MOVE_MAX * 3);
const MSTART = new Int32Array(17);
const MBUILT = { ri: -1, r2: -1 };

function moveDir(type: number, out: Int32Array): void {
  const step = type < 8 ? 2 : 1;
  const dir = type & 7;
  out[0] = dir === 0 || dir === 4 || dir === 5 ? step : dir === 1 || dir === 6 || dir === 7 ? -step : 0;
  out[1] = dir === 2 || dir === 4 || dir === 6 ? step : dir === 3 || dir === 5 || dir === 7 ? -step : 0;
}
const MDIR = new Int32Array(2);

/** Build the move tables for the current DG.ri / DG.r2; false if they would not fit (generic path). */
function buildMoves(): boolean {
  const { ri, r2 } = DG;
  if (MBUILT.ri === ri && MBUILT.r2 === r2) return MSTART[16]! > 0;
  MBUILT.ri = ri;
  MBUILT.r2 = r2;
  let n = 0;
  for (let type = 0; type < 16; type++) {
    MSTART[type] = n;
    moveDir(type, MDIR);
    const du = MDIR[0]!;
    const dv = MDIR[1]!;
    for (let y = Math.min(0, dv) - ri; y <= Math.max(0, dv) + ri; y++)
      for (let x = Math.min(0, du) - ri; x <= Math.max(0, du) + ri; x++) {
        const inA = x * x + y * y <= r2;
        const inB = (x - du) * (x - du) + (y - dv) * (y - dv) <= r2;
        if (inA === inB) continue;
        if (n >= MOVE_MAX) {
          MSTART[16] = 0;
          return false;
        }
        MOFF[n * 3] = x;
        MOFF[n * 3 + 1] = y;
        MOFF[n * 3 + 2] = inA ? -1 : 1;
        n++;
      }
  }
  MSTART[16] = n;
  return true;
}

/** moveDelta through the move table (same cells, same result). */
function moveDeltaT(G: Uint8Array, COV: Uint16Array, au: number, av: number, type: number, apply: boolean): number {
  const gw = DG.gw;
  let d = 0;
  const e1 = MSTART[type + 1]!;
  for (let e = MSTART[type]!; e < e1; e++) {
    const c = (av + MOFF[e * 3 + 1]!) * gw + au + MOFF[e * 3]!;
    const t = G[c]!;
    const n = COV[c]!;
    if (MOFF[e * 3 + 2]! < 0) {
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
  const tables = buildMoves();
  let total = 0;
  for (let sweep = 0; sweep < sweeps; sweep++) {
    let improved = false;
    for (let m = 0; m < k; m++) {
      if (focus >= 0 && m !== focus) {
        const du = GC[m * 2]! - GC[focus * 2]!;
        const dv = GC[m * 2 + 1]! - GC[focus * 2 + 1]!;
        if (du * du + dv * dv > near2) continue;
      }
      // The separation penalty where centre m stands now (recomputed only when it moves).
      let pa = sepPenalty(k, m, GC[m * 2]!, GC[m * 2 + 1]!);
      for (let step = 2; step >= 1; step--)
        for (let dir = 0; dir < 8; dir++) {
          const du = dir === 0 || dir === 4 || dir === 5 ? step : dir === 1 || dir === 6 || dir === 7 ? -step : 0;
          const dv = dir === 2 || dir === 4 || dir === 6 ? step : dir === 3 || dir === 5 || dir === 7 ? -step : 0;
          const au = GC[m * 2]!;
          const av = GC[m * 2 + 1]!;
          const bu = au + du;
          const bv = av + dv;
          if (bu < ri || bv < ri || bu > gw - 1 - ri || bv > gh - 1 - ri) continue;
          const type = (2 - step) * 8 + dir;
          const cov = tables ? moveDeltaT(S.grid, S.dist, au, av, type, false) : moveDelta(S.grid, S.dist, au, av, bu, bv, false);
          // The new penalty is ≥ 0, so a move that does not pay even without it cannot pay with it.
          if (cov - pa >= -1e-9) continue;
          const pb = sepPenalty(k, m, bu, bv);
          const d = cov + pb - pa;
          if (d < -1e-9) {
            pa = pb;
            if (tables) moveDeltaT(S.grid, S.dist, au, av, type, true);
            else moveDelta(S.grid, S.dist, au, av, bu, bv, true);
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

/**
 * Occlusion self-consistency of the current fit (centres in GC): the part of a ball no nearer ball
 * hides is in plain view, so it must be ball (or unknown), not cloth. Returns the largest share of
 * known cloth over the visible part of any disc.
 */
function maxVisibleCloth(S: Scratch, k: number): number {
  const { gw, ri, r2 } = DG;
  let worst = 0;
  for (let m = 0; m < k; m++) {
    const mu = GC[m * 2]!;
    const mv = GC[m * 2 + 1]!;
    let vis = 0;
    let cl = 0;
    for (let dj = -ri; dj <= ri; dj++)
      for (let di = -ri; di <= ri; di++) {
        if (di * di + dj * dj > r2) continue;
        const gi = mu + di;
        const gj = mv + dj;
        let hidden = false;
        for (let o = 0; o < k && !hidden; o++) {
          if (o === m || GC[o * 2]! >= mu) continue; // only a nearer ball (smaller u) can hide it
          const ei = gi - GC[o * 2]!;
          const ej = gj - GC[o * 2 + 1]!;
          if (ei * ei + ej * ej <= r2) hidden = true;
        }
        if (hidden) continue;
        vis++;
        if (!(S.grid[gj * gw + gi]! & 3)) cl++;
      }
    if (vis > 0 && cl / vis > worst) worst = cl / vis;
  }
  return worst;
}

/** Cost one more disc must save (cells): DISC_GAIN·πR². */
function discToll(ctx: Ctx): number {
  return Math.max(6, DISC_GAIN * Math.PI * ctx.rp * ctx.rp);
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
  const thresh = discToll(ctx);
  KMI.m0 = 0;
  KMI.m1 = 0;
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
  FITQ.visCloth = k > 1 && k <= SMALL_CLUSTER ? maxVisibleCloth(S, k) : 0;
  return k;
}

/**
 * Seeding state per k-means variant for the current blob. The seeding of k + 1 centres is the seeding
 * of k plus one more (the same deterministic sequence), so it is extended rather than redone at every
 * k of fitDiscs (identical centres; O(n) per k instead of O(k·n)).
 */
const KMI = { m0: 0, pick0: 0, lcg0: 0, m1: 0, pick1: 0, lcg1: 0 };
const INIT0 = new Float64Array(K_MAX * 2);
const INIT1 = new Float64Array(K_MAX * 2);

/** Fill TRIAL[0..k) with the seeding of variant 0 (farthest point) or 1 (k-means++, fixed seed). */
function kmeansInit(S: Scratch, n: number, k: number, variant: number): void {
  const { dq } = S;
  const D = variant === 0 ? S.km0 : S.km1;
  const P = variant === 0 ? INIT0 : INIT1;
  let m0 = variant === 0 ? KMI.m0 : KMI.m1;
  let pick = 0;
  if (m0 === 0 || m0 > k) {
    lcg = 12345 + variant * 7919;
    D.fill(Infinity, 0, n);
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
        const ex = dq[q * 2]! - mx;
        const ey = dq[q * 2 + 1]! - my;
        const d = ex * ex + ey * ey;
        if (d > far) {
          far = d;
          pick = q;
        }
      }
    } else pick = Math.min(n - 1, Math.floor(rnd() * n));
    m0 = 0;
  } else {
    pick = variant === 0 ? KMI.pick0 : KMI.pick1;
    lcg = variant === 0 ? KMI.lcg0 : KMI.lcg1;
  }
  for (let m = m0; m < k; m++) {
    const tx = dq[pick * 2]!;
    const ty = dq[pick * 2 + 1]!;
    P[m * 2] = tx;
    P[m * 2 + 1] = ty;
    let far = -1;
    let sum = 0;
    for (let q = 0; q < n; q++) {
      const ex = dq[q * 2]! - tx;
      const ey = dq[q * 2 + 1]! - ty;
      const d = ex * ex + ey * ey;
      if (d < D[q]!) D[q] = d;
      sum += D[q]!;
      if (D[q]! > far) {
        far = D[q]!;
        pick = q;
      }
    }
    if (variant > 0 && sum > 0) {
      // k-means++: next centre with probability ∝ D².
      let t = rnd() * sum;
      for (let q = 0; q < n; q++) {
        t -= D[q]!;
        if (t <= 0) {
          pick = q;
          break;
        }
      }
    }
  }
  if (variant === 0) {
    KMI.m0 = k;
    KMI.pick0 = pick;
    KMI.lcg0 = lcg;
  } else {
    KMI.m1 = k;
    KMI.pick1 = pick;
    KMI.lcg1 = lcg;
  }
  for (let m = 0; m < k * 2; m++) TRIAL[m] = P[m]!;
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
  kmeansInit(S, n, k, variant);
  // Lloyd iterations; once no pixel changes cluster the centres are final. Hamerly's bounds skip the
  // pixels whose nearest centre cannot have changed (same assignments as a full search: a pixel is
  // skipped only when its distance to its own centre is provably below that to any other).
  // S.assign, S.dmin (upper bounds) and S.dlo (lower bounds) are free here.
  const lab = S.assign;
  const ub = dmin;
  const lb = S.dlo;
  let maxMove = 0;
  for (let it = 0; it < 8; it++) {
    SUMX.fill(0, 0, k);
    SUMY.fill(0, 0, k);
    CNT.fill(0, 0, k);
    let changed = it === 0;
    // Half the distance from each centre to its nearest other centre.
    for (let m = 0; m < k; m++) {
      let nn = Infinity;
      for (let o = 0; o < k; o++) {
        if (o === m) continue;
        const ex = TRIAL[m * 2]! - TRIAL[o * 2]!;
        const ey = TRIAL[m * 2 + 1]! - TRIAL[o * 2 + 1]!;
        const d = ex * ex + ey * ey;
        if (d < nn) nn = d;
      }
      HALF[m] = 0.5 * Math.sqrt(nn);
    }
    for (let q = 0; q < n; q++) {
      const px = dq[q * 2]!;
      const py = dq[q * 2 + 1]!;
      if (it > 0) {
        const a = lab[q]!;
        // Bounds kept valid for the centres' last move (applied here, lazily).
        ub[q] = ub[q]! + MOVED[a]!;
        lb[q] = lb[q]! - maxMove;
        const z = Math.max(lb[q]!, HALF[a]!);
        if (ub[q]! < z) {
          SUMX[a]! += px;
          SUMY[a]! += py;
          CNT[a]! += 1;
          continue;
        }
        const ex = px - TRIAL[a * 2]!;
        const ey = py - TRIAL[a * 2 + 1]!;
        ub[q] = Math.sqrt(ex * ex + ey * ey);
        if (ub[q]! < z) {
          SUMX[a]! += px;
          SUMY[a]! += py;
          CNT[a]! += 1;
          continue;
        }
      }
      let bm = 0;
      let bd = Infinity;
      let b2 = Infinity;
      for (let m = 0; m < k; m++) {
        const ex = px - TRIAL[m * 2]!;
        const ey = py - TRIAL[m * 2 + 1]!;
        const d = ex * ex + ey * ey;
        if (d < bd) {
          b2 = bd;
          bd = d;
          bm = m;
        } else if (d < b2) b2 = d;
      }
      if (it === 0 || lab[q] !== bm) {
        lab[q] = bm;
        changed = true;
      }
      ub[q] = Math.sqrt(bd);
      lb[q] = Math.sqrt(b2);
      SUMX[bm]! += px;
      SUMY[bm]! += py;
      CNT[bm]! += 1;
    }
    if (!changed) break;
    maxMove = 0;
    for (let m = 0; m < k; m++) {
      MOVED[m] = 0;
      if (CNT[m]! > 0) {
        const nx = SUMX[m]! / CNT[m]!;
        const ny = SUMY[m]! / CNT[m]!;
        const ex = nx - TRIAL[m * 2]!;
        const ey = ny - TRIAL[m * 2 + 1]!;
        MOVED[m] = Math.sqrt(ex * ex + ey * ey);
        if (MOVED[m]! > maxMove) maxMove = MOVED[m]!;
        TRIAL[m * 2] = nx;
        TRIAL[m * 2 + 1] = ny;
      }
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
        const ex = x - CENT[m * 2]!;
        const ey = y - CENT[m * 2 + 1]!;
        const d = Math.abs(Math.sqrt(ex * ex + ey * ey) - rp);
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
        const ex = edge[e * 2]! - CENT[m * 2]!;
        const ey = edge[e * 2 + 1]! - CENT[m * 2 + 1]!;
        const r = Math.sqrt(ex * ex + ey * ey) - rp;
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
  if (CENT[0]! * CENT[0]! + CENT[1]! * CENT[1]! > 0.25 * rp * rp) {
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
      const d = Math.sqrt(dx * dx + dy * dy); // not Math.hypot: it allocates (Constitution IV)
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
  WHIST.fill(0);
  let sg = 0;
  let tint = 0;
  for (let q = 0; q < cnt; q++) {
    if (assign[q] !== m) continue;
    const k = queue[start + q]!;
    const s = sat[k]!;
    const v = val[k]!;
    if (s < 0.25 && v > whiteV) {
      white++;
      WHIST[Math.min(31, Math.floor(v * 32))]! += 1;
    }
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
  // The colour name itself is given once every ball is described (nameBalls): red and maroon differ
  // only in brightness, which is judged against the frame's own white.
  let label: string;
  let hh = 0;
  if (v75 < 0.2 && colFrac < 0.5) label = 'black';
  else if (meanSat < 0.12 || ng < Math.max(3, 0.1 * n)) label = 'white';
  else {
    hh = (Math.atan2(hsy, hsx) * 180) / Math.PI;
    if (hh < 0) hh += 360;
    // Pass 3: the hue of the group's purer half (S at least its mean). The rim pixels are blends with
    // the cloth and pull the hue toward it (orange on blue cloth reads ~10° redder otherwise).
    const sMean = sg / ng;
    let px = 0;
    let py = 0;
    for (let q = 0; q < cnt; q++) {
      if (assign[q] !== m) continue;
      const k = queue[start + q]!;
      const s = sat[k]!;
      if (s >= sMean && val[k]! > 0.12 && hueDiff(hue[k]!, hh) <= 25) {
        const a = (hue[k]! * Math.PI) / 180;
        px += Math.cos(a);
        py += Math.sin(a);
      }
    }
    if (px * px + py * py > 0) {
      hh = (Math.atan2(py, px) * 180) / Math.PI;
      if (hh < 0) hh += 360;
    }
    label = '';
  }
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
    hue: hh,
    sat: ng > 0 ? sg / ng : 0,
    v75: ng > 0 ? histQuantile(GHIST, 0, 32, ng, 0.75) : 0,
    vTop,
    whiteFrac,
    whiteV: white >= 4 ? histQuantile(WHIST, 0, 32, white, 0.75) : 0,
    clothV: localClothV(ctx, pos),
  });
}

const LHIST = new Float64Array(32);
/**
 * The cloth's brightness next to a ball: p75 V of the cloth pixels in a ring 1.4–2.4 R about it
 * (de-stretched; p75 so the ball's own shadow does not count). The lamp's falloff across the table is
 * shared by the ball and this ring, so brightness relative to it is comparable between balls.
 */
function localClothV(ctx: Ctx, pos: Vec2): number {
  const { S, w, h, rp } = ctx;
  const xr = (pos.x - ctx.x0) * ctx.scale;
  const yr = (ctx.y0 - pos.y) * ctx.scale;
  const { sinEl, ax, ay } = viewAt(ctx, xr, yr);
  const r0 = 1.4 * rp;
  const r1 = 2.4 * rp;
  const ext = Math.ceil(r1 / sinEl) + 1;
  LHIST.fill(0);
  let n = 0;
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
      const d2 = u * u + v * v;
      if (d2 < r0 * r0 || d2 > r1 * r1) continue;
      const k = j * w + i;
      if (S.nonCloth[k] || S.unknown[k] || S.mask[k]) continue;
      LHIST[Math.min(31, Math.floor(S.val[k]! * 32))]! += 1;
      n++;
    }
  return n >= 8 ? histQuantile(LHIST, 0, 32, n, 0.75) : ctx.clothVal;
}

/**
 * Colour names (after every ball is described). Brightness is judged relative to white pigment under
 * the same light and exposure: each ball's p75 V over the cloth next to it (the lamp's falloff across
 * the table cancels), against the same ratio of the frame's whitest white-ish ball (the cue ball, a
 * stripe's caps). Without one, white ≈ WHITE_PER_CLOTH × cloth. A ball that shows white besides its
 * colour is a stripe (a solid shows only a small specular highlight).
 */
function nameBalls(ctx: Ctx): void {
  const found = ctx.found;
  let wref = 0;
  for (let i = 0; i < found.length; i++) {
    const f = found[i]!;
    if (!(f.ball.label === 'white' || (f.ball.label === '' && f.whiteFrac > 0.25))) continue;
    const r = f.vTop / Math.max(0.02, f.clothV);
    if (r > wref) wref = r;
  }
  if (!(wref > 0.2)) wref = WHITE_PER_CLOTH;
  for (let i = 0; i < found.length; i++) {
    const f = found[i]!;
    if (f.ball.label !== '') continue;
    // Against the frame's white through the cloth beside each; a stripe also carries its own white (its
    // caps, same light and view as its band), and the two estimates are averaged (geometric mean).
    const stripe = f.whiteFrac > STRIPE_WHITE;
    const relFrame = f.v75 / Math.max(0.02, f.clothV) / wref;
    const rel = stripe && f.whiteV > 0.05 ? Math.sqrt(relFrame * (f.v75 / f.whiteV)) : relFrame;
    const base = colourName(ctx.swatches, f.hue, f.sat, rel);
    f.ball.label = base !== 'ball' && stripe ? `${base} stripe` : base;
  }
}
