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
 *  3. Connected blobs (small holes filled) → strip long thin attachments (a cue stick; judged on the
 *     closed silhouette) → count and place balls with a disc model in the de-stretched frame → fit a
 *     circle to each ball's visible silhouette boundary (occluded and unknown edges excluded). The count
 *     is a model selection over k: the least whole-cluster residual (uncovered blob + covered cloth,
 *     the mask sampled once per rectified px along the view) plus a toll per ball, over every count a
 *     grow-past-the-toll search and a backward elimination visit; insertions start where the residual's
 *     matched filter peaks; a ball the cluster can do without once its neighbours re-settle is not
 *     counted. When the frame has no coloured single ball to measure its silhouette dilation by, the
 *     discs keep the true ball radius and the mask's outer ring, as wide as a coloured silhouette may
 *     have grown at the cluster's chroma resolution, is evidence neither way (no size to choose, so no
 *     knife edge). The chroma resolution is read on the frame around the cluster, whatever filter
 *     upsampled it: block replication by the 2×2-block parity of its differences, smooth upsampling by
 *     the width of its transitions (chromaBand). A pack seen at less than RP_FIT px of ball radius is
 *     resampled finer in its own window first.
 *  4. Shape gate (fill, aspect, size, shading, width across the view) rejects lamp glare and sticks.
 *  5. Colour: robust hue and brightness (relative to the frame's white through the cloth beside each
 *     ball) named from the table's palette; the cue ball is the whitest COMPLETE ball with a clear
 *     margin over the runner-up, otherwise no ball is flagged (the app then asks the player to tap the
 *     cue ball, spec edge case). A white ball partly hidden and walled in on opposite sides by its
 *     neighbours (a stripe in a rack's back row shows only its caps: its band can be out of sight) is
 *     ambiguous: the cue is chosen among the other candidates, and it is the cue only when no other ball
 *     is white at all.
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
 *  - on 4:2:0 video a snooker pack in the end, corner and mirrored corner views loses or misplaces
 *    3–5 reds (25–40 mm; median error 15–18 mm, the wave-1 detector 17–20 mm): its chroma is about one
 *    sample per ball radius there. Over 62 calibrations × replicated, YUV and bilinear chroma, phantoms
 *    next to the pack: end 119, corner 151, mirrored corner 167 (wave-1: 141, 199, 211);
 *  - on 960-px Snap frames from 1280-px video with bilinear chroma, the snooker end view loses a
 *    28 %-visible red in 5 of 6 calibrations (wave-1 3; its ring is set for the 0.69–0.76 px such
 *    frames bleed, the end view's thin crescents are 1–2 px);
 *  - the 15-ball end view under the exact calibration loses the green 6 (29 % of its outline, green
 *    on green cloth): its neighbours' discs take most of its slice of the outline and one disc goes to
 *    the hidden #5 and #8 instead (14 mask samples better against a toll of 33; the auto calibration and
 *    the wave-1 detector find it);
 *  - under jittered calibrations (60 per scene, ±0.15–1 px corners) the end views lose one ball at
 *    28–56 % of its outline in 6–11 of 60 (the pool pack's green 6 or black 8, a snooker row-2 end
 *    ball) and the snooker corner views reach a 10–12 mm median in 5–6 of 60; the auto and exact
 *    calibrations are not affected;
 *  - with corner error a pocket's hole can fall outside its throat mask and read as a dark ball in the
 *    pocket, 0.6–1 m from any ball (2 of 1798 fresh-seed runs, at ±0.3 and ±0.5 px; more at ±2 px);
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
  /** Pixel count of the ball's blob in the (whole-table) rectified image. */
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
 * Width (image px) of the mask's outer ring that a cluster's fit treats as neither ball nor cloth when
 * the frame's dilation is unknown (fitDiscs' band), for full-resolution chroma and for 4:2:0 video.
 * ASSUMPTION: the dilation of coloured silhouettes measured on the ray-traced fixtures against the
 * true centres (exact calibration; the mask's best-fitting disc radius minus R): sharp frames
 * 0.13–0.20 image px for multi-coloured pool racks, 0.28–0.40 for 3-ball rows, 0.37 for red snooker
 * packs; 4:2:0 video 0.13–0.23 for pool racks and 0.55–0.62 for red packs (chroma averaged over 2×2
 * blocks bleeds into the cloth). Discs at the dilated size instead lose interior balls (neighbours'
 * fat discs fill the hole a missing ball leaves: 4–10 cells of evidence against a toll of 15 for the
 * snooker side view's #8 and #9); discs at the true size without the ring put extra balls on it
 * (snooker packs). Measured with the sharp ring at 0.33 / 0.37 / 0.40 over 62 calibrations of the
 * snooker end, corner and mirrored corner views: 18 / 23 / 32 fail (the end view loses more as it
 * grows, the corner views fewer), none with a phantom next to the pack; on fresh seeds (74
 * calibrations × the 16 cluster scenes) 0.33 / 0.37: 34 / 48 visible balls missed, 0 / 0 phantoms
 * next to a cluster. BAND_SMOOTH: 4:2:0 chroma upsampled bilinearly (a GPU's YUV → RGB conversion, a
 * JPEG decoder's fancy upsampling) bleeds further, over its ~4 px transitions: red packs 0.81–0.97 image
 * px at the processing size, 0.69–0.76 for 960-px Snap frames from 1280-px video, 0.48–0.56 for 640-px
 * live frames from 1280-px video; pairs 0.56–0.75. Measured on 240 bilinear runs (pairs, rows, racks
 * and packs in 4 views) with the ring at 0.6 / 0.8 / 0.9 for it: phantoms next to a cluster
 * 22 / 14 / 8, visible balls missed 47 / 50 / 52 (wave-1 detector 23 and 57). At 0.8 (the final width
 * mapping: 15 and 50) every bilinear snooker view stays at or under the wave-1 detector's phantoms and
 * visible misses over 62 calibrations; 0.9 loses more of the end view's thin crescents.
 */
const BAND_SHARP = 0.33;
const BAND_VIDEO = 0.6;
const BAND_SMOOTH = 0.8;
/**
 * chromaBand's readings (its comment has the measure): block parity at or above PARITY_FULL is not
 * replicated 4:2:0 (measured 0.39–0.98 around ray-traced clusters with full-resolution or bilinear
 * chroma, ≤ 0.02 replicated); a chroma transition width (lag-2 / lag-1 energy) at or below WIDTH_FULL
 * is full-resolution chroma (measured 2.47–2.88 on RGB frames, 2.53–2.88 on 640-px frames grabbed from
 * replicated 1280-px video, 1.99–2.04 replicated), at or above WIDTH_VIDEO bilinear 4:2:0 (3.44–3.67 at
 * the processing size; 3.04–3.29 grabbed at 640 px and 3.44–3.60 at 960 px from 1280-px video, which
 * the interpolation between the two places in between). The ring width follows the transition width
 * continuously (no knife edge: a frame between the two gets a ring between the two).
 */
const PARITY_FULL = 0.6;
const WIDTH_FULL = 3.0;
const WIDTH_VIDEO = 3.5;
/** A single blob with more than this share of low-S pixels is a white (or black) ball: luma-bound rim. */
const WHITE_BLOB = 0.7;
/**
 * A cluster is fitted at no less than this ball radius (rectified px). The scale matched to the image
 * leaves a far snooker pack at 4–5 px, where the outline's scallops between touching balls are ≲ 1 px
 * deep and the disc fit cannot tell which ball a slice of the outline belongs to (jittered ±0.3 px
 * corners changed the count by up to 3). Resampled finer, the colour is interpolated before the cloth
 * test, so the silhouette's edge falls between image pixels and the scallops resolve. Measured on the
 * ray-traced packs (20 calibrations each): snooker end view at 5.2 px 16 of 20 lose a visible ball, at
 * 7 px none; corner views of pool racks at 5 px vs 7 px: 13 vs 1 of 20 over today's allowance.
 */
const RP_FIT = 7;
/** Margin (× R) around a deferred cluster's bbox in its window: the ring localClothV reads, plus blur. */
const WIN_MARGIN = 3;
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
  /** Every st-th blob pixel's (u, v): the k-means restarts' sample (KM_PIX at most). */
  dqs: Float64Array;
  assign: Int32Array;
  dmin: Float64Array;
  /** k-means lower bounds (Hamerly); seeding distances of the two k-means variants. */
  dlo: Float64Array;
  km0: Float64Array;
  km1: Float64Array;
  /** Local grids (bbox / de-stretched). */
  gcap: number;
  grid: Uint8Array;
  /**
   * Fit grid: cost change when a cell becomes covered by an inner disc (cloth − blob samples; with a
   * band, cloth samples) and, with a band, by an outer disc (−blob samples, gB).
   */
  gE: Float32Array;
  gB: Float32Array;
  /** Fit coverage: inner discs (dist), outer discs (cov2); dist and dist2 are also distance scratch. */
  dist: Uint16Array;
  cov2: Uint16Array;
  dist2: Uint16Array;
  /** Fit grid: chamfer distance (×3 px) to the nearest known-cloth cell (with a band). */
  dcl: Uint16Array;
  /** Silhouette edge points (u, v). */
  ecap: number;
  edge: Float64Array;
  eown: Int32Array;
}

let SCRATCH: Scratch | null = null;
/** A second set for the cluster window pass (the whole-table pass's buffers stay intact). */
let SCRATCH_W: Scratch | null = null;

function scratchFor(n: number): Scratch {
  if (SCRATCH && SCRATCH.cap >= n) return SCRATCH;
  SCRATCH = makeScratch(n, SCRATCH);
  return SCRATCH;
}

function windowScratchFor(n: number): Scratch {
  if (SCRATCH_W && SCRATCH_W.cap >= n) return SCRATCH_W;
  SCRATCH_W = makeScratch(n, SCRATCH_W);
  return SCRATCH_W;
}

function makeScratch(n: number, prev: Scratch | null): Scratch {
  const cap = Math.ceil(n * 1.1);
  return {
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
    dqs: prev?.dqs ?? new Float64Array(0),
    assign: prev?.assign ?? new Int32Array(0),
    dmin: prev?.dmin ?? new Float64Array(0),
    dlo: prev?.dlo ?? new Float64Array(0),
    km0: prev?.km0 ?? new Float64Array(0),
    km1: prev?.km1 ?? new Float64Array(0),
    gcap: prev?.gcap ?? 0,
    grid: prev?.grid ?? new Uint8Array(0),
    gE: prev?.gE ?? new Float32Array(0),
    gB: prev?.gB ?? new Float32Array(0),
    dist: prev?.dist ?? new Uint16Array(0),
    cov2: prev?.cov2 ?? new Uint16Array(0),
    dist2: prev?.dist2 ?? new Uint16Array(0),
    dcl: prev?.dcl ?? new Uint16Array(0),
    ecap: prev?.ecap ?? 0,
    edge: prev?.edge ?? new Float64Array(0),
    eown: prev?.eown ?? new Int32Array(0),
  };
}

function growBlob(S: Scratch, n: number): void {
  if (S.bcap >= n) return;
  S.bcap = Math.ceil(n * 1.5);
  S.dq = new Float64Array(S.bcap * 2);
  S.dqs = new Float64Array(S.bcap * 2);
  S.assign = new Int32Array(S.bcap);
  S.dmin = new Float64Array(S.bcap);
  S.dlo = new Float64Array(S.bcap);
  S.km0 = new Float64Array(S.bcap);
  S.km1 = new Float64Array(S.bcap);
}

/**
 * Make room for n entries in the work queue, keeping its contents. The hole fill and the thin-part strip
 * need up to twice a blob's pixels: a pack can fill most of its own window, and whether they ran must
 * not depend on how large an earlier frame left the scratch (Constitution III: same frame, same result).
 */
function growQueue(S: Scratch, n: number): void {
  if (S.queue.length >= n) return;
  const q = new Int32Array(Math.ceil(n * 1.5));
  q.set(S.queue);
  S.queue = q;
}

function growGrid(S: Scratch, n: number): void {
  if (S.gcap >= n) return;
  S.gcap = Math.ceil(n * 1.5);
  S.grid = new Uint8Array(S.gcap);
  S.gE = new Float32Array(S.gcap);
  S.gB = new Float32Array(S.gcap);
  S.dist = new Uint16Array(S.gcap);
  S.cov2 = new Uint16Array(S.gcap);
  S.dist2 = new Uint16Array(S.gcap);
  S.dcl = new Uint16Array(S.gcap);
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
  /** Table coordinates (m) of the rectified image's top-left corner (row 0 = largest y). */
  x0: number;
  y0: number;
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
  return { w: Math.round(2 * hx * scale), h: Math.round(2 * hy * scale), scale, x0: -hx, y0: hy };
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

/** The whole-table pass's cloth saturation statistics, reused by window passes (too little cloth in view). */
const RSTATS = { sHi: Infinity, sLo: 0 };

function rectifyInto(frame: Frame, calib: Calibration, table: TableSpec, cloth: ClothModel, g: RectGeo, b: RectBuffers, window = false): void {
  const { w, h, scale, x0, y0 } = g;
  const H = calib.HR;
  const { rgb, hue, sat, val, nonCloth, unknown } = b;
  CLOTH_HIST.fill(0);
  let nCloth = 0;
  // Pass 1: sample, HSV, the loose cloth test; histogram the cloth's S.
  for (let j = 0; j < h; j++) {
    const Y = y0 - (j + 0.5) / scale; // row 0 = +y (far side when viewed from the −y rail)
    for (let i = 0; i < w; i++) {
      const X = x0 + (i + 0.5) / scale;
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
  if (!window) {
    const s95 = histQuantile(CLOTH_HIST, 0, 64, nCloth, 0.95);
    RSTATS.sHi = nCloth >= CLOTH_STATS_MIN ? s95 + Math.max(CLOTH_S_MARGIN, 2 * (s95 - histQuantile(CLOTH_HIST, 0, 64, nCloth, 0.5))) : Infinity;
    RSTATS.sLo = histQuantile(CLOTH_HIST, 0, 64, nCloth, SEAM_S_Q) - SEAM_S_MARGIN;
  }
  const sHi = RSTATS.sHi;
  const nT = fillThroats(calib, table);
  const nC = fillCushions(calib, table, CUSH_MARGIN / scale);
  const camX = calib.camera.x;
  const camY = calib.camera.y;
  const cw = table.cushionWidth;
  const darkV = THROAT_V * cloth.val;
  // Pass 2: tightened cloth test; pixels hidden by a near cushion, and hole-like pixels in the
  // throats, become unknown.
  for (let j = 0; j < h; j++) {
    const Y = y0 - (j + 0.5) / scale;
    for (let i = 0; i < w; i++) {
      const k = j * w + i;
      if (unknown[k]) continue;
      // Hidden by a near cushion? (Inlined: a per-pixel call with double arguments would box them.)
      let hid = false;
      if (nC > 0) {
        const X = x0 + (i + 0.5) / scale;
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
        TXY[0] = x0 + (i + 0.5) / scale;
        TXY[1] = Y;
      }
      if (nc && vv < darkV && inThroat(nT)) {
        nc = 0;
        unknown[k] = 1;
      }
      nonCloth[k] = nc;
    }
  }
  if (Number.isFinite(sHi)) markSeams(w, h, b, cloth, RSTATS.sLo, sHi);
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
  return { w: g.w, h: g.h, scale: g.scale, x0: g.x0, y0: g.y0, rgb: b.rgb, nonCloth: b.nonCloth };
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
  /** The frame itself (chroma resolution is measured on it, see chromaBand). */
  frame: Frame;
  /**
   * The frame's silhouette dilation in IMAGE px (+ = coloured blobs larger than the true silhouette),
   * measured on coloured single balls; NaN when the frame has none to measure it by.
   */
  dil: number;
  found: Found[];
  /** Whole-table pass at less than RP_FIT px of ball radius: set clusters aside for the window pass. */
  defer: boolean;
  /** Whole-table rectified px per px of this pass, squared (1, or < 1 in a finer cluster window): DetectedBall.px is reported in whole-table px. */
  pxScale: number;
}

/** A detection plus internal evidence used for dedupe, cue selection and naming. */
interface Found {
  ball: DetectedBall;
  blob: number;
  complete: number;
  /** Share of the predicted silhouette that nearer balls hide (counted in `complete`). */
  occ: number;
  /**
   * Whether the ball's rim against known cloth leaves a pair of opposite rim directions hidden (by
   * nearer balls, touching neighbours or unknown pixels): only then can a stripe's band, which reaches
   * the rim at two opposite points, be out of sight (see enclosedRim).
   */
  enclosed: boolean;
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
  const S = scratchFor(g.w * g.h);
  rectifyInto(frame, calib, table, cloth, g, S);
  openMask(S, g.w, g.h);

  const palette = opts.palette ?? (table.id === 'snooker12' || /snooker/i.test(table.name) ? 'snooker' : 'pool');
  const ctx: Ctx = {
    S,
    w: g.w,
    h: g.h,
    scale: g.scale,
    x0: g.x0,
    y0: g.y0,
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
    frame,
    dil: NaN,
    found: [],
    defer: R * g.scale < RP_FIT,
    pxScale: 1,
  };

  // Pass 1: connected components (4-connected) with their area and second moments.
  const nComp = labelComponents(ctx);
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
  // Pass 2: process each component. A cluster seen at less than RP_FIT px of ball radius is set aside
  // (DEFER) and fitted on a finer resampling of its own window (Pass 3).
  NDEFER = 0;
  processComponents(ctx, nComp, null, 0);
  const nDefer = NDEFER;
  for (let d = 0; d < nDefer; d++) windowPass(ctx, frame, calib, table, cloth, d);

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
        a.occ = Math.min(a.occ, b.occ);
        a.enclosed = a.enclosed && b.enclosed;
        found.splice(j, 1);
      }
    }

  nameBalls(ctx);

  // Cue ball: the whitest COMPLETE ball (a stripe whose band dropped out is not), with real shading
  // (flat glare is not), and clearly whiter than the runner-up. Otherwise no ball is the cue: the
  // tracker's vote then decays and the app asks the player to tap the cue ball (spec edge case).
  // A white ball in a cluster may instead be a stripe whose band is out of sight (a pack's back row
  // shows only its caps, lit toward the camera, and reads whiter than the real cue ball whose camera
  // side is in shade; on video the rest of a band between two touching neighbours blends into its caps).
  // A band reaches the silhouette's rim at two opposite points, so it can be out of sight only where
  // the ball's rim against the cloth leaves an opposite pair hidden (enclosed: walled in by nearer balls
  // and touching neighbours, as in a pack's back row). Such a ball is ambiguous: its whiteness is no
  // evidence for or against any other ball, so the cue is chosen among the unambiguous candidates (a
  // cue ball partly behind one object ball is one) with the margin over them; an ambiguous one is the
  // cue only when no other ball is white at all.
  let best = -1;
  let second = -1;
  let amb = -1;
  let nWhite = 0;
  const cueFill = Math.max(CUE_FILL_MIN, CUE_FILL - 0.5 / ctx.rp);
  for (let i = 0; i < found.length; i++) {
    const f = found[i]!;
    if (f.ball.white >= CUE_MIN_WHITE) nWhite++;
    if (f.complete < cueFill || f.ball.white < CUE_MIN_WHITE || f.spread < CUE_SPREAD) continue;
    if (f.enclosed) {
      if (amb < 0 || f.ball.white > found[amb]!.ball.white) amb = i;
      continue;
    }
    if (best < 0 || f.ball.white > found[best]!.ball.white) {
      second = best;
      best = i;
    } else if (second < 0 || f.ball.white > found[second]!.ball.white) second = i;
  }
  if (best < 0 && amb >= 0 && nWhite === 1) best = amb;
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

/** Light morphological opening of nonCloth into mask (3×3 cross erosion then dilation): drops specks. Borders stay 0. */
function openMask(S: Scratch, w: number, h: number): void {
  const { nonCloth, er, mask } = S;
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
}

/** Label the 4-connected components of ctx's mask; records each one's start, label, area and moments in COMPS. */
function labelComponents(ctx: Ctx): number {
  const { S, w, h } = ctx;
  const N = w * h;
  const { mask, label, queue } = S;
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
      if (sk > 0.4 && hueDiff(S.hue[k]!, ctx.clothHue) < 30) clothLike++;
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
  return nComp;
}

/**
 * Collect each component's pixels into queue[0..n) and process it. With `owner` (a window pass), only a
 * component whose pixels mostly lie on the deferred blob `ownLab` of the whole-table pass is processed.
 */
function processComponents(ctx: Ctx, nComp: number, owner: Ctx | null, ownLab: number): void {
  const { S, w, h } = ctx;
  const N = w * h;
  const { label } = S;
  for (let c = 0; c < nComp; c++) {
    // (re-read per component: processComponent may grow the queue)
    const queue = S.queue;
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
    if (owner) {
      let on = 0;
      for (let q = 0; q < tail; q++) {
        const k = queue[q]!;
        const i = k % w;
        const j = (k - i) / w;
        const i1 = Math.floor((ctx.x0 + (i + 0.5) / ctx.scale - owner.x0) * owner.scale);
        const j1 = Math.floor((owner.y0 - (ctx.y0 - (j + 0.5) / ctx.scale)) * owner.scale);
        if (i1 >= 0 && j1 >= 0 && i1 < owner.w && j1 < owner.h && owner.S.label[j1 * owner.w + i1] === ownLab) on++;
      }
      if (2 * on < tail) continue;
    }
    processComponent(ctx, tail, lab);
  }
}

/** Clusters set aside by the whole-table pass: label and pixel bbox (minI, maxI, minJ, maxJ). */
const DEFER = new Float64Array(64 * 5);
let NDEFER = 0;

/**
 * Pass 3 for deferred cluster d: resample its window (bbox plus 3R, clipped to the table) at the scale
 * that gives RP_FIT px of ball radius, and detect its balls there with the whole-table pass's cloth
 * statistics and frame dilation. Results join ctx.found.
 */
function windowPass(ctx: Ctx, frame: Frame, calib: Calibration, table: TableSpec, cloth: ClothModel, d: number): void {
  const o = d * 5;
  const lab = DEFER[o]!;
  const sc = ctx.scale;
  const scale2 = sc * (RP_FIT / ctx.rp);
  const m = WIN_MARGIN * ctx.R;
  const X0 = Math.max(ctx.x0, ctx.x0 + DEFER[o + 1]! / sc - m);
  const X1 = Math.min(ctx.x0 + ctx.w / sc, ctx.x0 + (DEFER[o + 2]! + 1) / sc + m);
  const Y1 = Math.min(ctx.y0, ctx.y0 - DEFER[o + 3]! / sc + m);
  const Y0 = Math.max(ctx.y0 - ctx.h / sc, ctx.y0 - (DEFER[o + 4]! + 1) / sc - m);
  const g2: RectGeo = { w: Math.max(3, Math.ceil((X1 - X0) * scale2)), h: Math.max(3, Math.ceil((Y1 - Y0) * scale2)), scale: scale2, x0: X0, y0: Y1 };
  const S2 = windowScratchFor(g2.w * g2.h);
  rectifyInto(frame, calib, table, cloth, g2, S2, true);
  openMask(S2, g2.w, g2.h);
  // Same field order as detectBalls' context (one object shape for every Ctx).
  const c2: Ctx = {
    S: S2,
    w: g2.w,
    h: g2.h,
    scale: scale2,
    x0: X0,
    y0: Y1,
    rp: ctx.R * scale2,
    R: ctx.R,
    cam: ctx.cam,
    table: ctx.table,
    clothHue: ctx.clothHue,
    clothVal: ctx.clothVal,
    HR: ctx.HR,
    swatches: ctx.swatches,
    next: ctx.next,
    focal: ctx.focal,
    frame: ctx.frame,
    dil: ctx.dil,
    found: ctx.found,
    defer: false,
    pxScale: (sc / scale2) * (sc / scale2),
  };
  const n2 = labelComponents(c2);
  processComponents(c2, n2, ctx, lab);
  ctx.next = c2.next;
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
  growQueue(S, 2 * n);
  const nSub = stripThin(ctx, n, lab, minI, maxI, minJ, maxJ, a1);
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
  const gw = maxI - minI + 3;
  const gh = maxJ - minJ + 3;
  const gn = gw * gh;
  growQueue(S, n + 2 * gn);
  const { queue, label, mask } = S;
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
  const G = S.grid;
  G.fill(0, 0, gn);
  for (let q = 0; q < n; q++) {
    const k = queue[q]!;
    const i = k % w;
    G[((k - i) / w - minJ + 1) * gw + (i - minI + 1)] = 1;
  }
  // Thinness is judged on the closed silhouette (3×3 closing): the saturation test leaves 1–2 px
  // cloth-classified cracks across a cloth-hued ball (its lit and shaded parts desaturate toward the
  // cloth's S), which would cut it into strips that read as a stick and get stripped. A stick stays
  // thin when closed; only original blob pixels are ever stripped.
  for (let y = 0; y < gh; y++)
    for (let x = 0; x < gw; x++) {
      let any = 0;
      for (let dy = -1; dy <= 1 && !any; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < gw && yy < gh && G[yy * gw + xx]) {
            any = 1;
            break;
          }
        }
      E[y * gw + x] = any;
    }
  for (let y = 0; y < gh; y++)
    for (let x = 0; x < gw; x++) {
      let all = 1;
      for (let dy = -1; dy <= 1 && all; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= gw || yy >= gh || !E[yy * gw + xx]) {
            all = 0;
            break;
          }
        }
      D[y * gw + x] = all || G[y * gw + x] ? BIG : 0;
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

/** Image bbox scratch for chromaBand. */
const PBOX = new Float64Array(4);
/**
 * The dilation ring's width (image px, fitDiscs' band) for a cluster (blob pixels queue[start..start+cnt)
 * of the rectified frame) whose frame has no coloured single ball to measure the dilation by: how far
 * a coloured silhouette may have bled at the chroma resolution where the cluster is. Two readings over
 * the cluster's image bounding box (plus 2 px), each independent of the chroma's content and contrast:
 *  - parity: the share of the squared chroma (Cb, Cr) differences between neighbouring pixels that
 *    falls between the two pixels of an aligned 2×2 block, against the share across blocks, as
 *    min/max (alignment-free): ≈ 0 when the chroma is one sample per 2×2 block upsampled by
 *    replication, 0.4–1 otherwise;
 *  - width: the chroma's lag-2 over lag-1 squared differences (both axes). A step edge reads 2, a linear
 *    ramp of width w px 4 − 2/w: it is the chroma's transition width, which an interpolating upsampler
 *    leaves about as wide as its sample spacing or wider. Replicated 4:2:0 reads ≈ 2 (its steps are
 *    sharp: parity tells it), full-resolution chroma 2.5–2.9 (the image's own blur), 4:2:0 upsampled
 *    bilinearly (a GPU's YUV → RGB conversion, a JPEG decoder's fancy upsampling) 3.4–3.7.
 * Replicated chroma moves the ring from BAND_SHARP toward BAND_VIDEO, smooth chroma toward BAND_SMOOTH
 * (each by linear interpolation of its reading), whichever is wider. No chroma variation (nothing to
 * tell by): BAND_SHARP.
 */
function chromaBand(ctx: Ctx, start: number, cnt: number): number {
  const { S, w } = ctx;
  const f = ctx.frame;
  const fw = f.width;
  const fh = f.height;
  const d = f.data;
  PBOX[0] = Infinity;
  PBOX[1] = -Infinity;
  PBOX[2] = Infinity;
  PBOX[3] = -Infinity;
  // The blob's rectified bbox corners, through the ball-centre plane to the image.
  let i0 = w;
  let i1 = 0;
  let j0 = ctx.h;
  let j1 = 0;
  for (let q = 0; q < cnt; q++) {
    const k = S.queue[start + q]!;
    const i = k % w;
    const j = (k - i) / w;
    if (i < i0) i0 = i;
    if (i > i1) i1 = i;
    if (j < j0) j0 = j;
    if (j > j1) j1 = j;
  }
  const H = ctx.HR;
  for (let c = 0; c < 4; c++) {
    const X = ctx.x0 + (c & 1 ? i1 + 1 : i0) / ctx.scale;
    const Y = ctx.y0 - (c & 2 ? j1 + 1 : j0) / ctx.scale;
    const ww = H[6]! * X + H[7]! * Y + H[8]!;
    const u = (H[0]! * X + H[1]! * Y + H[2]!) / ww;
    const v = (H[3]! * X + H[4]! * Y + H[5]!) / ww;
    if (u < PBOX[0]!) PBOX[0] = u;
    if (u > PBOX[1]!) PBOX[1] = u;
    if (v < PBOX[2]!) PBOX[2] = v;
    if (v > PBOX[3]!) PBOX[3] = v;
  }
  const x0 = Math.max(0, Math.floor(PBOX[0]!) - 2);
  const x1 = Math.min(fw - 3, Math.ceil(PBOX[1]!) + 2);
  const y0 = Math.max(0, Math.floor(PBOX[2]!) - 2);
  const y1 = Math.min(fh - 3, Math.ceil(PBOX[3]!) + 2);
  let eh0 = 0;
  let eh1 = 0;
  let ev0 = 0;
  let ev1 = 0;
  let e2 = 0;
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const k = (y * fw + x) * 4;
      const cb = -0.168736 * d[k]! - 0.331264 * d[k + 1]! + 0.5 * d[k + 2]!;
      const cr = 0.5 * d[k]! - 0.418688 * d[k + 1]! - 0.081312 * d[k + 2]!;
      const kx = k + 4;
      const ex = -0.168736 * d[kx]! - 0.331264 * d[kx + 1]! + 0.5 * d[kx + 2]! - cb;
      const fx = 0.5 * d[kx]! - 0.418688 * d[kx + 1]! - 0.081312 * d[kx + 2]! - cr;
      const ky = k + fw * 4;
      const ey = -0.168736 * d[ky]! - 0.331264 * d[ky + 1]! + 0.5 * d[ky + 2]! - cb;
      const fy = 0.5 * d[ky]! - 0.418688 * d[ky + 1]! - 0.081312 * d[ky + 2]! - cr;
      const kx2 = k + 8;
      const ex2 = -0.168736 * d[kx2]! - 0.331264 * d[kx2 + 1]! + 0.5 * d[kx2 + 2]! - cb;
      const fx2 = 0.5 * d[kx2]! - 0.418688 * d[kx2 + 1]! - 0.081312 * d[kx2 + 2]! - cr;
      const ky2 = k + fw * 8;
      const ey2 = -0.168736 * d[ky2]! - 0.331264 * d[ky2 + 1]! + 0.5 * d[ky2 + 2]! - cb;
      const fy2 = 0.5 * d[ky2]! - 0.418688 * d[ky2 + 1]! - 0.081312 * d[ky2 + 2]! - cr;
      const eh = ex * ex + fx * fx;
      const ev = ey * ey + fy * fy;
      e2 += ex2 * ex2 + fx2 * fx2 + ey2 * ey2 + fy2 * fy2;
      if (x & 1) eh1 += eh;
      else eh0 += eh;
      if (y & 1) ev1 += ev;
      else ev0 += ev;
    }
  const e1 = eh0 + eh1 + ev0 + ev1;
  const h = eh0 + eh1 > 1 ? Math.min(eh0, eh1) / Math.max(eh0, eh1) : 1;
  const v = ev0 + ev1 > 1 ? Math.min(ev0, ev1) / Math.max(ev0, ev1) : 1;
  const parity = Math.max(0, Math.min(1, (h + v) / 2));
  const width = e1 > 1 ? e2 / e1 : 2;
  const vRep = 1 - Math.min(1, parity / PARITY_FULL);
  const vSmooth = Math.max(0, Math.min(1, (width - WIDTH_FULL) / (WIDTH_VIDEO - WIDTH_FULL)));
  return BAND_SHARP + Math.max((BAND_VIDEO - BAND_SHARP) * vRep, (BAND_SMOOTH - BAND_SHARP) * vSmooth);
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
  if (ctx.defer && kArea >= 3 && NDEFER < 64) {
    // A pack at too few px per ball: fitted on its own finer window (windowPass).
    let minI = w;
    let maxI = 0;
    let minJ = h;
    let maxJ = 0;
    for (let q = 0; q < cnt; q++) {
      const k = queue[start + q]!;
      const i = k % w;
      const j = (k - i) / w;
      if (i < minI) minI = i;
      if (i > maxI) maxI = i;
      if (j < minJ) minJ = j;
      if (j > maxJ) maxJ = j;
    }
    const o = NDEFER * 5;
    DEFER[o] = lab;
    DEFER[o + 1] = minI;
    DEFER[o + 2] = maxI;
    DEFER[o + 3] = minJ;
    DEFER[o + 4] = maxJ;
    NDEFER++;
    return;
  }
  const rho = pxPerImagePx(ctx, cx, cy);
  const known = Number.isFinite(ctx.dil);
  const dil = single ? Math.max(-1, Math.min(2, Math.sqrt((cnt * sinEl) / Math.PI) - rp)) : known ? Math.max(-1, Math.min(2.5, ctx.dil * rho)) : 0;
  const rad = rp + dil;
  // Without a measured dilation, the discs keep the true radius and the mask's outer ring, as wide as
  // a coloured silhouette may have grown in such a frame, is evidence neither way (fitDiscs' band). How
  // far it may have grown depends on the chroma resolution where the cluster is (video chroma is one
  // sample per 2×2 block; its bleed widens the rim).
  let band = 0;
  if (!single && !known) {
    band = Math.min(2.5, chromaBand(ctx, start, cnt) * rho);
  }
  const k = fitDiscs(ctx, cnt, lab, cx, cy, ax, ay, sinEl, uMin, uMax, vMin, vMax, rad, band);
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
    describe(ctx, start, cnt, m, n, a1, pos, lab, own, FILL.tot > 0 ? occ / FILL.tot : 0, k > 1 && enclosedRim(S.edge, nEdge, k, m, rad));
  }
}

/** Rim direction bins for enclosedRim (each 2π/ENC_BINS wide; ENC_BINS even). */
const ENC_BINS = 32;
/**
 * Opposite rim directions (consecutive bins) that must be hidden together for a band to be out of
 * sight. A band's end spans about ±27° of rim (|n·axis| ≲ 0.45, the renderer's; a real stripe's
 * 0.4–0.5), but where it meets a touching neighbour its pixels go to that ball, so a hidden arc just
 * over 180° can already hide it. Measured (11.25° bins): back-row stripes of a 15-ball rack that read
 * white (0.21–0.82) are hidden over 202–236°, with 2–5 opposite pairs; a cue ball behind an object
 * ball offset 0.6 R sideways, 101° and none. Requiring 3 pairs let two such stripes through as the cue
 * in 392 rack runs (an earlier form of the cue rule); with 1, none, and the cue behind an object ball is
 * still flagged in 647 of 648 runs.
 */
const ENC_MIN = 1;
const ENC = new Uint8Array(ENC_BINS);
const ENC2 = new Uint8Array(ENC_BINS);
/**
 * Could a stripe's band be out of sight on ball m of a k-ball fit? A band (a belt about a great
 * circle) reaches the silhouette's rim at two opposite points, so it can be hidden only if two
 * opposite rim arcs, each about a band end wide, show no silhouette edge against known cloth (they are
 * behind nearer balls, against touching neighbours, or unknown). The edge faces (edge[0..nEdge),
 * de-stretched about the blob centroid) nearest to m's centre (CENT) and within 1.5 radii of it are
 * binned by direction; single-bin gaps between visible bins (sampling: about one face per px of rim)
 * count as visible and single visible bins between hidden ones (a crevice pixel) as hidden. Enclosed:
 * at least ENC_MIN consecutive directions are hidden together with their opposite.
 */
function enclosedRim(edge: Float64Array, nEdge: number, k: number, m: number, rad: number): boolean {
  ENC.fill(0);
  const cu = CENT[m * 2]!;
  const cv = CENT[m * 2 + 1]!;
  const lim = 2.25 * rad * rad;
  for (let e = 0; e < nEdge; e++) {
    const x = edge[e * 2]!;
    const y = edge[e * 2 + 1]!;
    const du = x - cu;
    const dv = y - cv;
    const d2 = du * du + dv * dv;
    if (d2 > lim) continue;
    let mine = true;
    for (let o = 0; o < k && mine; o++) {
      if (o === m) continue;
      const eu = x - CENT[o * 2]!;
      const ev = y - CENT[o * 2 + 1]!;
      if (eu * eu + ev * ev < d2) mine = false;
    }
    if (!mine) continue;
    const b = Math.floor(((Math.atan2(dv, du) + Math.PI) / (2 * Math.PI)) * ENC_BINS);
    ENC[b < ENC_BINS ? b : 0] = 1;
  }
  const n = ENC_BINS;
  for (let i = 0; i < n; i++) ENC2[i] = ENC[i]! || (ENC[(i + n - 1) % n]! && ENC[(i + 1) % n]!) ? 1 : 0;
  for (let i = 0; i < n; i++) ENC[i] = ENC2[i]! && (ENC2[(i + n - 1) % n]! || ENC2[(i + 1) % n]!) ? 1 : 0;
  // Longest circular run of directions hidden together with their opposite (pairs i, i + n/2).
  const h = n / 2;
  let run = 0;
  let best = 0;
  for (let i = 0; i < 2 * h; i++) {
    const j = i % h;
    if (ENC[j] || ENC[j + h]) run = 0;
    else if (++run > best) best = run;
  }
  return best >= ENC_MIN;
}

/**
 * Width across the view: does the silhouette (any ball, or unknown) reach WIDE_R·R to both sides of the
 * centre (xr, yr), measured at the centre and WIDE_U·R before and behind it along the view? A ball does
 * (its half-chord there is ≥ 0.95R; a white ball's mask erodes by ≲ 0.1R); a cue butt (≤ 15 mm radius,
 * ≲ 1.2× magnified when raised above the ball-centre plane, plus ~1 px of chroma) reaches ≲ 0.76R.
 * Each side, and the centre line, needs 2 of its 3 samples. The flank samples sit half a pixel
 * further in: a white ball's mask erodes by about that on video (chroma pulled toward the cloth). A
 * sample counts when it is in the silhouette's 3×3 closing (inClosed): a 1–2 px cloth-classified crack
 * across a cloth-hued ball is not its edge, while closing leaves a straight stick's width unchanged.
 */
function wideAcross(ctx: Ctx, xr: number, yr: number, ax: number, ay: number, sinEl: number): boolean {
  const { w, h, rp } = ctx;
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
      if (inClosed(ctx, i, j)) ok++;
    }
    if (ok < 2) return false;
  }
  return true;
}

/** Silhouette (any ball, unknown, or a stripped part) at rectified pixel (i, j)? Outside the frame: yes. */
function silAt(ctx: Ctx, i: number, j: number): boolean {
  if (i < 0 || j < 0 || i >= ctx.w || j >= ctx.h) return true;
  const S = ctx.S;
  const k = j * ctx.w + i;
  return S.mask[k] !== 0 || S.unknown[k] !== 0 || S.label[k] === -1;
}

/** Is (i, j) in the 3×3 closing of the silhouette: every 3×3 neighbour has silhouette within its own 3×3? */
function inClosed(ctx: Ctx, i: number, j: number): boolean {
  if (silAt(ctx, i, j)) return true;
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      let near = false;
      for (let ey = -1; ey <= 1 && !near; ey++) for (let ex = -1; ex <= 1 && !near; ex++) near = silAt(ctx, i + dx + ex, j + dy + ey);
      if (!near) return false;
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
 * unknown cells (throat hole, frame edge, stick) being free either way. With a band (the frame's
 * silhouette dilation is unknown, see BAND_SHARP), each disc also has an outer disc of radius
 * rad + band, and the mask's outer ring (blob cells within `band` of known cloth, by the share of the
 * cell inside it) costs only outside every outer disc: a dilated rim is evidence neither way, so no
 * disc is placed to cover it. Deeper blob cells (the hole a missing interior ball leaves) and cloth
 * cells count against the inner discs, as without a band. The cost separates into one coverage term
 * per radius (inner discs: cloth − the non-ring share of blob; outer discs: −the ring share of blob;
 * plus the blob total); the outer coverage is only ever read on ring cells. The count is a model
 * selection over k (see fitDiscs). Centres (de-stretched u, v about the blob centroid) go to BEST.
 */
const GC = new Int32Array(K_MAX * 2);
const GSAVE = new Int32Array(K_MAX * 2);
const GTRY = new Int32Array(K_MAX * 2);
/** In a multi-ball fit every disc must cover at least this × its area in blob (not unknown) cells. */
const DISC_MIN_BLOB = 0.4;
/** Penalty (cells) per px that two centres are closer than the 1.7R minimum. */
const SEP_W = 40;
/** Most mask samples per fit cell along the view (one per rectified px up to a 1/4 de-stretch). */
const NS_MAX = 4;
/** Most pixels the k-means restarts of the disc fit look at (a regular subsample of a larger blob). */
const KM_PIX = 700;
/**
 * Search over the count (fitDiscs): grow while one more disc saves at least GROW_FRAC of the toll, and
 * at most GROW_PAST discs beyond the first count where it no longer paid the whole toll; then prune
 * back down to PRUNE_BELOW below that count. Every count on the way is kept for the model selection.
 * Each insertion tries the deepest uncovered cell and the N_PEAKS − 1 best residual peaks.
 */
const GROW_FRAC = 0.25;
const GROW_PAST = 3;
const PRUNE_BELOW = 2;
const N_PEAKS = 4;

interface DiscGrid {
  gw: number;
  gh: number;
  u0: number;
  v0: number;
  /** Inner disc: integer reach and squared radius (cells). */
  ri: number;
  r2: number;
  /** Outer disc (inner + band); equal to the inner one without a band. */
  ro: number;
  ro2: number;
  band: boolean;
  /** The band (px); 0 without. */
  bandPx: number;
  sinEl: number;
  minSep: number;
  /** The hard floor MIN_SEP_SPLIT·R (table-metric px). */
  hardSep: number;
  /** Mask samples per cell (along the view): costs are in samples. */
  ns: number;
}
/** The current fit's inner coverage array (the outer one is kept on ring cells only). */
const DG_INNER: { cov: Uint16Array } = { cov: new Uint16Array(0) };
const DG: DiscGrid = { gw: 0, gh: 0, u0: 0, v0: 0, ri: 0, r2: 0, ro: 0, ro2: 0, band: false, bandPx: 0, sinEl: 1, minSep: 0, hardSep: 0, ns: 1 };

/** One coverage term of moving a disc of reach ri, radius² r2 from cell (au, av) to (bu, bv). */
function moveDelta1(E: Float32Array, COV: Uint16Array, ri: number, r2: number, au: number, av: number, bu: number, bv: number, apply: boolean): number {
  const gw = DG.gw;
  const outer = COV !== DG_INNER.cov;
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
      if (outer && E[c] === 0) continue;
      const n = COV[c]!;
      if (inA) {
        if (n === 1) d -= E[c]!;
        if (apply) COV[c] = n - 1;
      } else {
        if (n === 0) d += E[c]!;
        if (apply) COV[c] = n + 1;
      }
    }
  return d;
}

/** Cost change of moving a disc from cell (au, av) to (bu, bv); applies the coverage change if asked. */
function moveDelta(S: Scratch, au: number, av: number, bu: number, bv: number, apply: boolean): number {
  let d = moveDelta1(S.gE, S.dist, DG.ri, DG.r2, au, av, bu, bv, apply);
  if (DG.band) d += moveDelta1(S.gB, S.cov2, DG.ro, DG.ro2, au, av, bu, bv, apply);
  return d;
}

/**
 * Coverage change of each local-search move (2- and 1-cell steps in 8 directions), precomputed for the
 * fit's inner and outer discs: the cells that leave (−1) or enter (+1) the disc, relative to its old
 * centre. A move then touches only its symmetric difference (~4·ri cells) instead of the discs' whole
 * bounding box.
 */
const MOVE_MAX = 16 * 600;
/** Per move type: cells leaving the disc, then cells entering it, as (x, y); linear offsets for the grid width. */
const MOFF = new Int32Array(MOVE_MAX * 2);
const MLIN = new Int32Array(MOVE_MAX);
const MSTART = new Int32Array(17);
const MMID = new Int32Array(16);
const MOFF2 = new Int32Array(MOVE_MAX * 2);
const MLIN2 = new Int32Array(MOVE_MAX);
const MSTART2 = new Int32Array(17);
const MMID2 = new Int32Array(16);
const MBUILT = { ri: -1, r2: -1, ro: -1, ro2: -1, gw: -1, gw2: -1 };

function moveDir(type: number, out: Int32Array): void {
  const step = type < 8 ? 2 : 1;
  const dir = type & 7;
  out[0] = dir === 0 || dir === 4 || dir === 5 ? step : dir === 1 || dir === 6 || dir === 7 ? -step : 0;
  out[1] = dir === 2 || dir === 4 || dir === 6 ? step : dir === 3 || dir === 5 || dir === 7 ? -step : 0;
}
const MDIR = new Int32Array(2);

/** Fill one move table for reach ri, radius² r2 (leaving cells first, then entering ones); false if it would not fit. */
function buildMoveTable(ri: number, r2: number, off: Int32Array, start: Int32Array, mid: Int32Array): boolean {
  let n = 0;
  for (let type = 0; type < 16; type++) {
    start[type] = n;
    moveDir(type, MDIR);
    const du = MDIR[0]!;
    const dv = MDIR[1]!;
    for (let pass = 0; pass < 2; pass++) {
      if (pass === 1) mid[type] = n;
      for (let y = Math.min(0, dv) - ri; y <= Math.max(0, dv) + ri; y++)
        for (let x = Math.min(0, du) - ri; x <= Math.max(0, du) + ri; x++) {
          const inA = x * x + y * y <= r2;
          const inB = (x - du) * (x - du) + (y - dv) * (y - dv) <= r2;
          if (inA === inB || inA !== (pass === 0)) continue;
          if (n >= MOVE_MAX) {
            start[16] = 0;
            return false;
          }
          off[n * 2] = x;
          off[n * 2 + 1] = y;
          n++;
        }
    }
  }
  start[16] = n;
  return true;
}

/** Linear grid offsets of a move table for grid width gw. */
function linearize(off: Int32Array, lin: Int32Array, n: number, gw: number): void {
  for (let e = 0; e < n; e++) lin[e] = off[e * 2 + 1]! * gw + off[e * 2]!;
}

/** Build the move tables for the current DG discs and grid; false if they would not fit (generic path). */
function buildMoves(): boolean {
  const { ri, r2, ro, ro2, gw } = DG;
  if (MBUILT.ri !== ri || MBUILT.r2 !== r2) {
    MBUILT.ri = ri;
    MBUILT.r2 = r2;
    MBUILT.gw = -1;
    buildMoveTable(ri, r2, MOFF, MSTART, MMID);
  }
  if (MBUILT.gw !== gw) {
    MBUILT.gw = gw;
    linearize(MOFF, MLIN, MSTART[16]!, gw);
  }
  if (DG.band) {
    if (MBUILT.ro !== ro || MBUILT.ro2 !== ro2) {
      MBUILT.ro = ro;
      MBUILT.ro2 = ro2;
      MBUILT.gw2 = -1;
      buildMoveTable(ro, ro2, MOFF2, MSTART2, MMID2);
    }
    if (MBUILT.gw2 !== gw) {
      MBUILT.gw2 = gw;
      linearize(MOFF2, MLIN2, MSTART2[16]!, gw);
    }
  }
  return MSTART[16]! > 0 && (!DG.band || MSTART2[16]! > 0);
}

/** One coverage term through a move table (same cells, same result as moveDelta1); base = the disc's cell. */
function moveDeltaT1(E: Float32Array, COV: Uint16Array, lin: Int32Array, start: Int32Array, mid: Int32Array, base: number, type: number, apply: boolean): number {
  let d = 0;
  const e0 = start[type]!;
  const em = mid[type]!;
  const e1 = start[type + 1]!;
  if (apply) {
    for (let e = e0; e < em; e++) {
      const c = base + lin[e]!;
      const n = COV[c]!;
      if (n === 1) d -= E[c]!;
      COV[c] = n - 1;
    }
    for (let e = em; e < e1; e++) {
      const c = base + lin[e]!;
      const n = COV[c]!;
      if (n === 0) d += E[c]!;
      COV[c] = n + 1;
    }
  } else {
    for (let e = e0; e < em; e++) {
      const c = base + lin[e]!;
      if (COV[c] === 1) d -= E[c]!;
    }
    for (let e = em; e < e1; e++) {
      const c = base + lin[e]!;
      if (COV[c] === 0) d += E[c]!;
    }
  }
  return d;
}

/**
 * moveDelta through the move tables. The outer discs' term only matters where its disc can reach a
 * ring cell (the ring lies within band + 1 of known cloth): `ring` false skips it (the outer coverage
 * is only ever read on ring cells).
 */
function moveDeltaT(S: Scratch, au: number, av: number, type: number, apply: boolean, ring: boolean): number {
  const base = av * DG.gw + au;
  let d = moveDeltaT1(S.gE, S.dist, MLIN, MSTART, MMID, base, type, apply);
  if (ring) d += moveDeltaT1(S.gB, S.cov2, MLIN2, MSTART2, MMID2, base, type, apply);
  return d;
}

/** Separation penalty (samples) of centre m at cell (gi, gj) against the other k−1 centres in GC. */
function sepPenalty(k: number, m: number, gi: number, gj: number): number {
  let p = 0;
  for (let j = 0; j < k; j++) {
    if (j === m) continue;
    const du = (gi - GC[j * 2]!) / DG.sinEl;
    const dv = gj - GC[j * 2 + 1]!;
    const d = Math.sqrt(du * du + dv * dv);
    if (d < DG.minSep) p += SEP_W * DG.ns * (DG.minSep - d);
  }
  return p;
}

/** Are any two of the k centres in GC closer than MIN_SEP_SPLIT·R on the table (the hard floor)? */
function tooClose(k: number): boolean {
  const lim2 = DG.hardSep * DG.hardSep;
  for (let a = 0; a < k; a++)
    for (let b = a + 1; b < k; b++) {
      const du = (GC[a * 2]! - GC[b * 2]!) / DG.sinEl;
      const dv = GC[a * 2 + 1]! - GC[b * 2 + 1]!;
      if (du * du + dv * dv < lim2) return true;
    }
  return false;
}

/** Add disc coverage of reach ri, radius² r2 at every centre of GC[0..k) into COV (cleared first). */
function coverDiscs(COV: Uint16Array, k: number, ri: number, r2: number): void {
  const { gw, gh } = DG;
  COV.fill(0, 0, gw * gh);
  for (let m = 0; m < k; m++) {
    const gi = GC[m * 2]!;
    const gj = GC[m * 2 + 1]!;
    for (let dj = -ri; dj <= ri; dj++)
      for (let di = -ri; di <= ri; di++) if (di * di + dj * dj <= r2) COV[(gj + dj) * gw + gi + di]! += 1;
  }
}

/** Rebuild coverage for the k centres in GC; returns the full cost (uncovered + phantom + penalty). */
function coverAll(S: Scratch, k: number): number {
  const { gw, gh } = DG;
  const n = gw * gh;
  const G = S.grid;
  coverDiscs(S.dist, k, DG.ri, DG.r2);
  const E = S.gE;
  const COV = S.dist;
  let cost = 0;
  for (let c = 0; c < n; c++) cost += COV[c]! > 0 ? G[c]! + E[c]! : G[c]!;
  if (DG.band) {
    coverDiscs(S.cov2, k, DG.ro, DG.ro2);
    const B = S.gB;
    const C2 = S.cov2;
    for (let r = 0; r < RING.n; r++) {
      const c = RINGL[r]!;
      if (C2[c]! > 0) cost += B[c]!;
    }
  }
  for (let m = 0; m < k; m++) cost += sepPenalty(k, m, GC[m * 2]!, GC[m * 2 + 1]!) / 2;
  return cost;
}

/** One coverage term of removing a disc of reach ri, radius² r2 at (gi, gj). */
function removeDelta1(E: Float32Array, COV: Uint16Array, ri: number, r2: number, gi: number, gj: number, apply: boolean): number {
  const gw = DG.gw;
  const outer = COV !== DG_INNER.cov;
  let d = 0;
  for (let dj = -ri; dj <= ri; dj++)
    for (let di = -ri; di <= ri; di++) {
      if (di * di + dj * dj > r2) continue;
      const c = (gj + dj) * gw + gi + di;
      if (outer && E[c] === 0) continue;
      const n = COV[c]!;
      if (n === 1) d -= E[c]!;
      if (apply) COV[c] = n - 1;
    }
  return d;
}

/** Cost increase of removing the disc at cell (gi, gj); applies the coverage change if asked. */
function removeDelta(S: Scratch, gi: number, gj: number, apply: boolean): number {
  let d = removeDelta1(S.gE, S.dist, DG.ri, DG.r2, gi, gj, apply);
  if (DG.band) d += removeDelta1(S.gB, S.cov2, DG.ro, DG.ro2, gi, gj, apply);
  return d;
}

/** Blob cells under a disc centred on grid cell (gi, gj) (blob samples / samples per cell). */
function discBlobCells(S: Scratch, gi: number, gj: number): number {
  const { gw, ri, r2 } = DG;
  let n = 0;
  for (let dj = -ri; dj <= ri; dj++)
    for (let di = -ri; di <= ri; di++) if (di * di + dj * dj <= r2) n += S.grid[(gj + dj) * gw + gi + di]!;
  return n / DG.ns;
}

/**
 * Hill-climb centres by 2- then 1-cell steps (8 directions) while the cost drops. With focus ≥ 0 only
 * that centre and its neighbours (within 3R) move: the rest of a pack is already settled.
 */
function localSearch(S: Scratch, k: number, focus: number, sweeps = 10): number {
  const { gw, gh, ri, ro } = DG;
  const near2 = 9 * ri * ri;
  const tables = buildMoves();
  // A disc at chamfer distance > ringLim from cloth reaches no ring cell from here or a step away.
  const ringLim = 3 * (ro + DG.bandPx + 5);
  let total = 0;
  for (let sweep = 0; sweep < sweeps; sweep++) {
    let improved = false;
    for (let m = 0; m < k; m++) {
      if (focus >= 0 && m !== focus) {
        const du = GC[m * 2]! - GC[focus * 2]!;
        const dv = GC[m * 2 + 1]! - GC[focus * 2 + 1]!;
        if (du * du + dv * dv > near2) continue;
      } else if (focus === FOCUS_POINT) {
        // Only the centres around a point (where a disc was just removed).
        const du = GC[m * 2]! - FOC[0]!;
        const dv = GC[m * 2 + 1]! - FOC[1]!;
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
          if (bu < ro || bv < ro || bu > gw - 1 - ro || bv > gh - 1 - ro) continue;
          const type = (2 - step) * 8 + dir;
          const ring = DG.band && S.dcl[av * gw + au]! <= ringLim;
          const cov = tables ? moveDeltaT(S, au, av, type, false, ring) : moveDelta(S, au, av, bu, bv, false);
          // The new penalty is ≥ 0, so a move that does not pay even without it cannot pay with it.
          if (cov - pa >= -1e-9) continue;
          const pb = sepPenalty(k, m, bu, bv);
          const d = cov + pb - pa;
          if (d < -1e-9) {
            pa = pb;
            if (tables) moveDeltaT(S, au, av, type, true, ring);
            else moveDelta(S, au, av, bu, bv, true);
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

/** Deepest cell (chessboard) of the blob cells no (outer) disc covers yet; −1 if none. Uses S.dist2. */
function deepestUncovered(S: Scratch): number {
  const { gw, gh } = DG;
  const D = S.dist2;
  const G = S.grid;
  const COV = S.dist;
  const C2 = S.cov2;
  const B = S.gB;
  // Uncovered: a blob cell no outer disc covers, or no inner disc where less than half of it is ring.
  if (DG.band) for (let c = 0; c < gw * gh; c++) D[c] = 2 * G[c]! >= DG.ns && (B[c]! < 0 ? C2[c] === 0 || (COV[c] === 0 && -2 * B[c]! < G[c]!) : COV[c] === 0) ? BIG : 0;
  else for (let c = 0; c < gw * gh; c++) D[c] = 2 * G[c]! >= DG.ns && COV[c] === 0 ? BIG : 0;
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

/** Insertion candidates: cells of PEAKS[0..n). */
const PEAKS = new Int32Array(8);
/** Disc half-width per row offset (index dv + reach) for the fit's inner and outer discs; row prefix sums; gain map. */
const HW = new Int32Array(64);
const HW2 = new Int32Array(64);
let ROWSUM = new Float64Array(0);
let GAINMAP = new Float64Array(0);
/** The current fit's ring cells (grid indices of cells with an outer-disc weight), RING.n of them. */
let RINGL = new Int32Array(0);
const RING = { n: 0 };

/** Row prefix sums of −E over the cells COV leaves uncovered, into RS (gw + 1 per row). */
function rowSums(RS: Float64Array, E: Float32Array, COV: Uint16Array): void {
  const { gw, gh } = DG;
  for (let y = 0; y < gh; y++) {
    let acc = 0;
    const o = y * (gw + 1);
    RS[o] = 0;
    for (let x = 0; x < gw; x++) {
      const c = y * gw + x;
      if (COV[c] === 0) acc -= E[c]!;
      RS[o + x + 1] = acc;
    }
  }
}

/**
 * Insertion candidates: what one more disc would gain before anything moves, at every centre (a
 * matched filter of the residual: uncovered blob +1 and uncovered known cloth −1 under the disc; with
 * a band, uncovered blob under the outer disc and uncovered cloth under the inner one), by row prefix
 * sums: O(cells · disc diameter). Up to `max` peaks, each more than a disc radius from the others, with
 * a positive gain go to PEAKS. A disc wedged between two balls leaves a pocket on each side; the
 * deepest uncovered cell alone may be a cloth-hued ball's sliver elsewhere.
 */
function residualPeaks(S: Scratch, first: number, max: number): number {
  const { gw, gh, ri, r2, ro, ro2 } = DG;
  const n = gw * gh;
  if (ROWSUM.length < (gw + 1) * gh) ROWSUM = new Float64Array(Math.ceil((gw + 1) * gh * 1.5));
  if (GAINMAP.length < n) GAINMAP = new Float64Array(Math.ceil(n * 1.5));
  for (let dv = -ri; dv <= ri; dv++) HW[dv + ri] = Math.floor(Math.sqrt(Math.max(0, r2 - dv * dv)) + 1e-9);
  rowSums(ROWSUM, S.gE, S.dist);
  GAINMAP.fill(0, 0, n);
  for (let y = ro; y < gh - ro; y++)
    for (let x = ro; x < gw - ro; x++) {
      let s = 0;
      for (let dv = -ri; dv <= ri; dv++) {
        const hw = HW[dv + ri]!;
        const o = (y + dv) * (gw + 1);
        s += ROWSUM[o + x + hw + 1]! - ROWSUM[o + x - hw]!;
      }
      GAINMAP[y * gw + x] = s;
    }
  if (DG.band) {
    // The outer discs' part, scattered from each uncovered ring cell to the centres whose outer disc
    // holds it (the ring is thin: far fewer cells than centres).
    for (let dv = -ro; dv <= ro; dv++) HW2[dv + ro] = Math.floor(Math.sqrt(Math.max(0, ro2 - dv * dv)) + 1e-9);
    const C2 = S.cov2;
    const B = S.gB;
    for (let r = 0; r < RING.n; r++) {
      const q = RINGL[r]!;
      if (C2[q] !== 0) continue;
      const w = -B[q]!;
      const qx = q % gw;
      const qy = (q - qx) / gw;
      for (let dv = -ro; dv <= ro; dv++) {
        const y = qy + dv;
        if (y < ro || y >= gh - ro) continue;
        const hw = HW2[dv + ro]!;
        const x0 = Math.max(ro, qx - hw);
        const x1 = Math.min(gw - ro - 1, qx + hw);
        for (let x = x0; x <= x1; x++) GAINMAP[y * gw + x]! += w;
      }
    }
  }
  for (let p = 0; p < first; p++) {
    const pu = PEAKS[p]! % gw;
    const pv = (PEAKS[p]! - pu) / gw;
    for (let y = Math.max(0, pv - ri); y <= Math.min(gh - 1, pv + ri); y++) for (let x = Math.max(0, pu - ri); x <= Math.min(gw - 1, pu + ri); x++) GAINMAP[y * gw + x] = 0;
  }
  let np = first;
  while (np < max) {
    let best = -1;
    let bg = 0;
    for (let c = 0; c < n; c++)
      if (GAINMAP[c]! > bg) {
        bg = GAINMAP[c]!;
        best = c;
      }
    if (best < 0) break;
    PEAKS[np++] = best;
    const pu = best % gw;
    const pv = (best - pu) / gw;
    for (let y = Math.max(0, pv - ri); y <= Math.min(gh - 1, pv + ri); y++) for (let x = Math.max(0, pu - ri); x <= Math.min(gw - 1, pu + ri); x++) GAINMAP[y * gw + x] = 0;
  }
  return np;
}

/** Best configuration found per count k (grid cells, k centres at KCFG[k·K_MAX·2…]) and its cost. */
const KCFG = new Int32Array((K_MAX + 1) * K_MAX * 2);
const KCOST = new Float64Array(K_MAX + 1);
/** localSearch focus: move only the centres near the point FOC (grid cells). */
const FOCUS_POINT = -2;
const FOC = new Int32Array(2);

function recordK(k: number, cost: number): void {
  if (!(cost < KCOST[k]!)) return;
  KCOST[k] = cost;
  KCFG.set(GC.subarray(0, k * 2), k * K_MAX * 2);
}

/** Cost one more disc must save (cells): DISC_GAIN·πR². */
function discToll(ctx: Ctx): number {
  return Math.max(6, DISC_GAIN * Math.PI * ctx.rp * ctx.rp);
}

function clampCell(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(v)));
}

/**
 * The count is a model selection over k: the least whole-cluster cost plus the toll per ball, over
 * every count a grow-past-the-toll search and a backward elimination visit; insertions start where the
 * residual's matched filter peaks; a ball the cluster can do without once its neighbours re-settle is
 * not counted. `band` (px, ≥ 0): the outer discs' extra radius (see the section comment).
 */
function fitDiscs(ctx: Ctx, cnt: number, lab: number, cx: number, cy: number, ax: number, ay: number, sinEl: number, uMin: number, uMax: number, vMin: number, vMax: number, rad: number, band: number): number {
  const { S, w, h } = ctx;
  const rp = rad;
  const bx = -ay;
  const by = ax;
  const ri = Math.ceil(rp);
  const ro = Math.ceil(rp + band);
  const pad = ro + 2;
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
  DG.band = band > 0;
  DG.bandPx = band;
  DG.ro = DG.band ? ro : ri;
  DG.ro2 = DG.band ? (rp + band) * (rp + band) : DG.r2;
  DG.sinEl = sinEl;
  DG_INNER.cov = S.dist;
  DG.minSep = MIN_SEP * ctx.rp;
  DG.hardSep = MIN_SEP_SPLIT * ctx.rp;
  // One cell spans 1/sinEl rectified px along the view: sample the mask that many times along it (not
  // once, which would alias the silhouette's edge by up to a cell as the calibration shifts the
  // sampling phase). Per cell: G = blob samples (the cost while uncovered); gE = cloth − blob samples
  // (the cost change once covered), or with a band cloth samples (inner) and gB = −blob (outer);
  // unknown samples are free either way.
  const ns = Math.max(1, Math.min(NS_MAX, Math.round(1 / sinEl)));
  DG.ns = ns;
  const G = S.grid;
  const E = S.gE;
  const B = S.gB;
  const withBand = DG.band;
  for (let gj = 0; gj < gh; gj++)
    for (let gi = 0; gi < gw; gi++) {
      const v = v0 + gj + 0.5;
      let nb = 0;
      let nc = 0;
      for (let q = 0; q < ns; q++) {
        const u = u0 + gi + (q + 0.5) / ns;
        const i = Math.floor(cx + (u / sinEl) * ax + v * bx);
        const j = Math.floor(cy + (u / sinEl) * ay + v * by);
        if (i < 0 || j < 0 || i >= w || j >= h) continue;
        const k = j * w + i;
        const l = S.label[k]!;
        if (l === lab) nb++;
        else if (!S.unknown[k] && l !== -1) nc++;
      }
      const c = gj * gw + gi;
      G[c] = nb;
      E[c] = nc - nb;
    }
  if (withBand) {
    // The dilation ring is the mask's outer layer: blob cells within `band` of known cloth. Only there
    // is an uncovered blob cell forgiven (counted against the outer discs); deeper blob cells (a hole
    // where an interior ball is missing) are charged against the inner discs as without a band.
    // A cell whose centre lies t = DT/3 − ½ px inside the mask's edge (chamfer DT to the nearest cloth
    // cell) has the share clamp(band − t + ½, 0, 1) of its width in the outer `band` px: that share of
    // its blob samples is forgiven (moved to the outer discs' term). Continuous in the band.
    const D = S.dcl;
    for (let c = 0; c < gw * gh; c++) D[c] = E[c]! + G[c]! > 0 ? 0 : BIG;
    chamferDT(D, gw, gh);
    if (RINGL.length < gw * gh) RINGL = new Int32Array(Math.ceil(gw * gh * 1.5));
    let nr = 0;
    for (let c = 0; c < gw * gh; c++) {
      const nb = G[c]!;
      const wr = nb > 0 ? Math.max(0, Math.min(1, band + 1 - D[c]! / 3)) : 0;
      E[c] = E[c]! + nb * wr;
      B[c] = -nb * wr;
      if (wr > 0) RINGL[nr++] = c;
    }
    RING.n = nr;
  }
  const lo = DG.ro;
  const hiU = gw - 1 - DG.ro;
  const hiV = gh - 1 - DG.ro;
  const thresh = discToll(ctx) * ns;
  const gLow = Math.max(2, GROW_FRAC * thresh);
  KMI.m0 = 0;
  KMI.m1 = 0;
  KCOST.fill(Infinity, 0, K_MAX + 1);
  // The k-means restarts run on a regular subsample of the blob's pixels: their centres move by a
  // fraction of a pixel, and the local search polishes them on the full grid anyway.
  const st = Math.max(1, Math.ceil(cnt / KM_PIX));
  let nkm = 0;
  for (let q = 0; q < cnt; q += st) {
    S.dqs[nkm * 2] = S.dq[q * 2]!;
    S.dqs[nkm * 2 + 1] = S.dq[q * 2 + 1]!;
    nkm++;
  }
  let k = 0;
  let cost = coverAll(S, 0);
  recordK(0, cost);
  let kStop = K_MAX;
  while (k < K_MAX && k < kStop + GROW_PAST) {
    GSAVE.set(GC.subarray(0, k * 2));
    const deep = deepestUncovered(S);
    if (deep < 0) break;
    let bestCost = Infinity;
    // Incremental start (for a pack, polishing only the new disc and its neighbours), then two short
    // k-means restarts (an incremental placement can trap a pair or a row). Kept cheap so a 15-ball
    // rack stays within the frame budget.
    PEAKS[0] = deep;
    const nPk = k === 0 ? 1 : residualPeaks(S, 1, N_PEAKS);
    const starts = nPk + (k === 0 ? 1 : 2);
    for (let start = 0; start < starts; start++) {
      const inc = start < nPk;
      if (inc) {
        GC.set(GSAVE.subarray(0, k * 2));
        const pk = PEAKS[start]!;
        GC[k * 2] = clampCell(pk % gw, lo, hiU);
        GC[k * 2 + 1] = clampCell(Math.floor(pk / gw), lo, hiV);
      } else {
        kmeansStart(S, nkm, k + 1, start - nPk);
        for (let m = 0; m <= k; m++) {
          GC[m * 2] = clampCell(TRIAL[m * 2]! - u0 - 0.5, lo, hiU);
          GC[m * 2 + 1] = clampCell(TRIAL[m * 2 + 1]! - v0 - 0.5, lo, hiV);
        }
      }
      let c = coverAll(S, k + 1);
      c += localSearch(S, k + 1, inc && k >= 3 ? k : -1, inc ? 10 : 4);
      let viol = false;
      if (tooClose(k + 1)) viol = true;
      // Each of several balls must stand on blob pixels, not mostly on unknown ones (a pocket hole).
      if (k > 0) for (let m = 0; m <= k && !viol; m++) if (discBlobCells(S, GC[m * 2]!, GC[m * 2 + 1]!) < DISC_MIN_BLOB * Math.PI * rp * rp) viol = true;
      if (!viol && c < bestCost) {
        bestCost = c;
        GTRY.set(GC.subarray(0, (k + 1) * 2));
      }
    }
    if (!(bestCost <= cost - gLow)) {
      GC.set(GSAVE.subarray(0, k * 2));
      coverAll(S, k);
      break;
    }
    if (bestCost > cost - thresh && kStop === K_MAX) kStop = k;
    k++;
    GC.set(GTRY.subarray(0, k * 2));
    cost = coverAll(S, k);
    recordK(k, cost);
  }
  if (k > 1) {
    cost += localSearch(S, k, -1);
    recordK(k, cost);
  }
  // Backward elimination from the deepest fit: drop the disc that explains least, let its neighbours
  // settle, record the cost at each count.
  const kLow = Math.max(1, Math.min(kStop, k) - PRUNE_BELOW);
  while (k > kLow) {
    let wm = 0;
    let wg = Infinity;
    for (let m = 0; m < k; m++) {
      const g = removeDelta(S, GC[m * 2]!, GC[m * 2 + 1]!, false);
      if (g < wg) {
        wg = g;
        wm = m;
      }
    }
    FOC[0] = GC[wm * 2]!;
    FOC[1] = GC[wm * 2 + 1]!;
    for (let j = wm; j < k - 1; j++) {
      GC[j * 2] = GC[(j + 1) * 2]!;
      GC[j * 2 + 1] = GC[(j + 1) * 2 + 1]!;
    }
    k--;
    cost = coverAll(S, k);
    cost += localSearch(S, k, FOCUS_POINT, 6);
    recordK(k, cost);
  }
  // Model selection over the count: least whole-cluster cost plus the toll per ball.
  let kSel = -1;
  let jSel = Infinity;
  for (let kk = 0; kk <= K_MAX; kk++) {
    const J = KCOST[kk]! + thresh * kk;
    if (J < jSel - 1e-9) {
      jSel = J;
      kSel = kk;
    }
  }
  k = kSel;
  GC.set(KCFG.subarray(kSel * K_MAX * 2, kSel * K_MAX * 2 + kSel * 2));
  coverAll(S, k);
  if (k > 3) localSearch(S, k, -1);
  if (k >= 3) {
    // Leave-one-out with re-settling: a ball is counted only if the cluster cannot be explained nearly
    // as well without it once its neighbours have moved (within one toll). A disc squeezed between two
    // pushed-apart balls, or a ball whose slice of the outline its neighbours can take over, is not
    // evidence of a ball (Constitution II): the image does not say it is there.
    let cur = coverAll(S, k);
    for (let m = k - 1; m >= 0 && k > 3; m--) {
      GSAVE.set(GC.subarray(0, k * 2));
      FOC[0] = GC[m * 2]!;
      FOC[1] = GC[m * 2 + 1]!;
      for (let j = m; j < k - 1; j++) {
        GC[j * 2] = GC[(j + 1) * 2]!;
        GC[j * 2 + 1] = GC[(j + 1) * 2 + 1]!;
      }
      let c = coverAll(S, k - 1);
      c += localSearch(S, k - 1, FOCUS_POINT, 6);
      if (c - cur < thresh) {
        k--;
        cur = c;
      } else {
        GC.set(GSAVE.subarray(0, k * 2));
        coverAll(S, k);
      }
    }
  }
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
  const dq = S.dqs;
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
  const { dmin } = S;
  const dq = S.dqs;
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
/** The silhouette radius refineCircles settled on (de-stretched px). */
const REFR = { rp: 0 };

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
  REFR.rp = rp;
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
function describe(ctx: Ctx, start: number, cnt: number, m: number, n: number, a1: number, pos: Vec2, blob: number, complete: number, occ: number, enclosed: boolean): void {
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
      px: Math.max(1, Math.round(n * ctx.pxScale)),
    },
    blob,
    complete,
    occ,
    enclosed,
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
