/**
 * Player-view photo pose (spec 002 research R-24 / R-25 / R-26, contracts/player-view-api.md).
 *
 * The player crouches behind the cue ball and photographs the table at cloth level. The ball layout is
 * already known from the overview photo, so this photo only has to give the camera: 6-DoF pose plus
 * focal length. Pipeline (pure, deterministic, typed-array scratch reused between calls):
 *
 *  1. Cloth (player-detect.ts): every hue mode and grey (neutral) value mode of the photo is a cloth
 *     candidate, ranked by structure (the cloth is the surface with ball-sized holes; a rail band, the
 *     floor or a wall has none); the overview's cloth, grey included, is promoted when this photo shows
 *     a plausible region of it. Candidates are tried in turn until one fits.
 *  2. Evidence (player-detect.ts): "crack" points on the boundary between the main cloth and anything
 *     else (ball silhouettes and the cushion edges; sensor-noise speckle removed), and ball circle
 *     candidates fitted to the cloth-bordered arcs of each non-cloth blob (Kåsa + deterministic RANSAC on
 *     compact blobs, also per colour class of the blob's edge, so a red ball in front of the cue ball does
 *     not merge with it; local-arc proposals on large blobs such as the rail band or the room that balls
 *     merge into), so balls cut by the frame edge or overlapping in depth still fit. Each candidate
 *     carries a colour descriptor of its own pixels (not those a nearer circle covers, nor those away from
 *     its own arc) and a whiteness score, with thresholds scaled by the exposure read off the brightest
 *     balls (not the cloth: a light cloth is not an over-exposed photo).
 *  3. Hypotheses: for each focal guess (a phone-lens sweep, HFOV ≈ 110°…26°, plus the overview's focal
 *     length as a soft hint), the cue-ball circle fixes the cue ball in camera coordinates; pairing any
 *     other circle with any colour-compatible known ball fixes the rotation up to a turn about the line
 *     between them: the level member in closed form, and the rolled member that the remaining circles
 *     vote for (a phone held at an angle). Each hypothesis is scored by the known balls that land, one
 *     per circle, on circles of the right size and colour, the balls predicted on bare cloth, and the
 *     circles left unexplained. Each cloth candidate is tried with its whitest circle as the cue ball
 *     first (the next one when that fit is ok but not convincing); when none fits, the candidate that
 *     explained the most is tried with the next white circle, then with a ball of unique colour as the
 *     anchor (a moved cue ball would otherwise pull every pose off), within a counted work budget.
 *  4. Refinement: Levenberg–Marquardt over (rotation, camera centre, log f) on exact residuals — for a
 *     ball, the angle between a crack point's ray and the silhouette cone axis minus the cone half-angle
 *     (so there is no off-axis ellipse bias); for a cushion edge (outer and nose), the angle between the
 *     ray and the plane through the camera and that edge — with ICP-style re-association under a
 *     shrinking gate, Cauchy weights, a focal prior (heavy-tailed around the overview's focal length:
 *     the lens may differ) and a level-phone prior.
 *  5. Honesty (Principle II): confidence from the matched balls, the share of the cloth boundary the
 *     model explains, the residuals and the propagated covariance of the target's image position (with
 *     the layout's own uncertainty unless crossing cushion lines pin the pose); `ok` only when all of
 *     them agree, near-minimal fits only with sure identities (a colour no unmatched ball of the layout
 *     shares), and a camera away from the cue ball only on a convincing fit. Failures carry the
 *     canonical player-facing reason of their true cause: too dark, too grainy (noise that broke every
 *     cloth candidate into specks), no cloth, too few balls (fewer than three ball circles), no cue ball,
 *     balls moved (a ball on bare cloth with a circle of its colour resting elsewhere on the bed, from a
 *     pose the static table pins down — this also turns an otherwise good fit into a failure, FR-121),
 *     or no fit.
 *
 * Conventions: world = table frame (m, z up, ball centres at z = R). Camera X_c = R·X_w + t with rows
 * right, down, forward; pixel (u, v) covers [u, u+1) × [v, v+1), principal point at the image centre.
 */
import type { TableSpec, Vec2, Vec3 } from '../core/types';
import { hueDiff, rgbToHsv, type Frame } from './image';
import { buildEvidence, camouflaged, clothNoise, ColourAcc, findCandidates, getScratch, learnPlayerCloth, solveN, type Candidate, type ColourDesc, type Scratch } from './player-detect';
import type { ClothModel } from './table-detect';

export interface KnownBall {
  id: string;
  pos: Vec2;
  isCue: boolean;
  rgb?: [number, number, number];
}

export interface PlayerViewInput {
  frame: Frame;
  table: TableSpec;
  balls: KnownBall[];
  cueId: string;
  targetId?: string;
  /**
   * Focal length in px for this frame, from the overview calibration. A soft hint: the player may use
   * another lens (0.5× … 3×) for this photo, and the image decides when it disagrees.
   */
  focalPx?: number;
  /** Manual fallback: tapped image px of the cue ball and the target ball. */
  manualTaps?: { cue: Vec2; target: Vec2 };
  /**
   * Optional (non-breaking extension): the cloth colour learned from the overview photo
   * (`VisionResult.cloth`, chromatic or neutral). The candidate of that colour (hue for a chromatic
   * model, grey for a neutral one) is tried first when this photo shows a plausible region of it; its
   * S and V are re-measured in this photo. A neutral model's hue (0) is never read as a hue.
   */
  clothHint?: ClothModel | null;
}

export interface CameraPose {
  /** 3×3 row-major world → camera rotation (rows: right, down, forward). */
  R: number[];
  t: Vec3;
  f: number;
  cx: number;
  cy: number;
  width: number;
  height: number;
}

export interface PlayerViewResult {
  ok: boolean;
  pose: CameraPose | null;
  /** 0..1. */
  confidence: number;
  residualPx: number;
  matched: { id: string; image: Vec2; radiusPx: number }[];
  /** Player-facing message when !ok (or the "not behind the cue ball" warning when ok). */
  reason?: string;
  ms: number;
}

/** Canonical player-facing reasons (data-model.md § PlayerViewResult). */
export const PLAYER_VIEW_REASONS = {
  tooFewBalls: "I can't see enough balls. Include the cue ball and at least two others.",
  moved: 'The balls seem to have moved. Retake the table photo.',
  dark: 'The photo is too dark to read the table. Add light or hold the phone steady.',
  noCue: "I can't find the cue ball. Tap the cue ball, then your target.",
  notBehind: "You're not behind the cue ball. The guide is drawn from where you stood.",
  noFit: "I couldn't line up this photo. Tap the cue ball, then your target.",
  /** The photo is lit, but no surface in it looks like a table cloth (any colour, grey included). */
  noCloth: "I can't find the table cloth in this photo. Aim along your shot so more of the cloth is in view.",
  /** The photo is too grainy (sensor noise, usually from low light) to line up. */
  noisy: 'The photo is too grainy to read the table. Add light or hold the phone steady.',
} as const;

/** Default horizontal field of view used as the focal prior when no focalPx is given (degrees). */
export const PLAYER_VIEW_DEFAULT_HFOV = 65;

/** √(x² + y²) and √(x² + y² + z²): Math.hypot's overflow care is not needed here and it is slow in hot loops. */
const hyp2 = (x: number, y: number) => Math.sqrt(x * x + y * y);
const hyp3 = (x: number, y: number, z: number) => Math.sqrt(x * x + y * y + z * z);

// ---------------------------------------------------------------------------------------------------
// Projection helpers (contract)
// ---------------------------------------------------------------------------------------------------

function camOf(pose: CameraPose, p: Vec3): Vec3 {
  const R = pose.R;
  return {
    x: R[0]! * p.x + R[1]! * p.y + R[2]! * p.z + pose.t.x,
    y: R[3]! * p.x + R[4]! * p.y + R[5]! * p.z + pose.t.y,
    z: R[6]! * p.x + R[7]! * p.y + R[8]! * p.z + pose.t.z,
  };
}

export function projectPoint(pose: CameraPose, p: Vec3): Vec2 | null {
  const c = camOf(pose, p);
  if (c.z <= 1e-6) return null;
  return { x: (pose.f * c.x) / c.z + pose.cx, y: (pose.f * c.y) / c.z + pose.cy };
}

/**
 * Exact silhouette of a sphere: the image of its tangent cone, `n` points in order. Empty when the
 * camera is inside the sphere or any part of the silhouette lies behind the image plane.
 */
export function projectBallOutline(pose: CameraPose, center: Vec3, R: number, n = 48): Vec2[] {
  const P = camOf(pose, center);
  const d = hyp3(P.x, P.y, P.z);
  if (!(d > R) || P.z <= 0) return [];
  const ax = P.x / d;
  const ay = P.y / d;
  const az = P.z / d;
  const sb = R / d;
  const cb = Math.sqrt(1 - sb * sb);
  // Orthonormal basis (e1, e2) perpendicular to the cone axis.
  const [rx, ry, rz] = Math.abs(ay) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let e1x = ry * az - rz * ay;
  let e1y = rz * ax - rx * az;
  let e1z = rx * ay - ry * ax;
  const l1 = hyp3(e1x, e1y, e1z);
  e1x /= l1;
  e1y /= l1;
  e1z /= l1;
  const e2x = ay * e1z - az * e1y;
  const e2y = az * e1x - ax * e1z;
  const e2z = ax * e1y - ay * e1x;
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const th = (2 * Math.PI * i) / n;
    const c = Math.cos(th);
    const s = Math.sin(th);
    const dx = cb * ax + sb * (c * e1x + s * e2x);
    const dy = cb * ay + sb * (c * e1y + s * e2y);
    const dz = cb * az + sb * (c * e1z + s * e2z);
    if (dz <= 1e-9) return [];
    out.push({ x: (pose.f * dx) / dz + pose.cx, y: (pose.f * dy) / dz + pose.cy });
  }
  return out;
}

/**
 * The point on the cue ball the tip touches: on a level cue axis along `aimDir`, offset `side·R` to the
 * shooter's right and `vert·R` up, on the back of the ball. Offsets beyond the miscue limit (0.5 R) are
 * clamped radially. |P − c| = R.
 */
export function strikePoint(cueCenter: Vec3, aimDir: Vec2, side: number, vert: number, R: number): Vec3 {
  const L = hyp2(aimDir.x, aimDir.y);
  const dx = L > 1e-12 ? aimDir.x / L : 1;
  const dy = L > 1e-12 ? aimDir.y / L : 0;
  let s = side;
  let v = vert;
  const m = hyp2(s, v);
  if (m > 0.5) {
    s *= 0.5 / m;
    v *= 0.5 / m;
  }
  const back = R * Math.sqrt(Math.max(0, 1 - s * s - v * v));
  return { x: cueCenter.x - dx * back + s * R * dy, y: cueCenter.y - dy * back - s * R * dx, z: cueCenter.z + v * R };
}

// ---------------------------------------------------------------------------------------------------
// Small 3D maths
// ---------------------------------------------------------------------------------------------------

type M3 = number[];

/** Level camera (roll 0): heading ψ of the forward axis in the table plane, pitch φ down. */
function rotYawPitch(psi: number, phi: number): M3 {
  const cps = Math.cos(psi);
  const sps = Math.sin(psi);
  const cph = Math.cos(phi);
  const sph = Math.sin(phi);
  return [sps, -cps, 0, -sph * cps, -sph * sps, -cph, cph * cps, cph * sps, -sph];
}

function mulM3(A: M3, B: M3): M3 {
  const C = new Array<number>(9);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) C[i * 3 + j] = A[i * 3]! * B[j]! + A[i * 3 + 1]! * B[3 + j]! + A[i * 3 + 2]! * B[6 + j]!;
  return C;
}

/** Rodrigues: rotation matrix of the rotation vector (wx, wy, wz). */
function rodrigues(wx: number, wy: number, wz: number): M3 {
  const th = hyp3(wx, wy, wz);
  if (th < 1e-12) return [1, -wz, wy, wz, 1, -wx, -wy, wx, 1];
  const kx = wx / th;
  const ky = wy / th;
  const kz = wz / th;
  const c = Math.cos(th);
  const s = Math.sin(th);
  const v = 1 - c;
  return [
    c + kx * kx * v,
    kx * ky * v - kz * s,
    kx * kz * v + ky * s,
    ky * kx * v + kz * s,
    c + ky * ky * v,
    ky * kz * v - kx * s,
    kz * kx * v - ky * s,
    kz * ky * v + kx * s,
    c + kz * kz * v,
  ];
}

/**
 * Image ellipse of a sphere whose centre is at camera coordinates P (exact conic centre; mean radius
 * √(a·b) of the semi-axes). Null when the silhouette is not a closed ellipse in front of the camera.
 */
function sphereImage(Px: number, Py: number, Pz: number, Rb: number, f: number, cx: number, cy: number): { u: number; v: number; r: number; d: number } | null {
  return sphereImageTo(Px, Py, Pz, Rb, f, cx, cy, sphereTmp) ? { u: sphereTmp[0]!, v: sphereTmp[1]!, r: sphereTmp[2]!, d: sphereTmp[3]! } : null;
}
const sphereTmp = new Float64Array(4);

/** sphereImage without allocation: writes (u, v, r, d) into `out`; false when there is no image. */
function sphereImageTo(Px: number, Py: number, Pz: number, Rb: number, f: number, cx: number, cy: number, out: Float64Array): boolean {
  const d = hyp3(Px, Py, Pz);
  if (!(d > Rb) || Pz <= 0) return false;
  const s = Rb / d;
  const az = Pz / d;
  const den = az * az - s * s;
  if (den < 0.02) return false;
  const k = az / den;
  // Semi-axes (normalised): radial tanβ/cos²α-ish and tangential tanβ/cosα-ish, exact for the conic.
  const q2 = 1 - az * az;
  const c2 = 1 - s * s;
  const rho0 = Math.sqrt(q2) * k;
  const radial = (s * Math.sqrt(c2)) / den;
  const tang2 = (rho0 * Math.sqrt(q2) + az) ** 2 / c2 - rho0 * rho0 - 1;
  const tang = Math.sqrt(Math.max(0, tang2));
  out[0] = cx + (f * Px * k) / d;
  out[1] = cy + (f * Py * k) / d;
  out[2] = f * Math.sqrt(radial * tang);
  out[3] = d;
  return true;
}

type BallClass = { kind: 'dark' } | { kind: 'white' } | { kind: 'colour'; hue: number } | null;

/** Class of a known ball from its (overview) mean RGB. */
function ballClass(rgb: [number, number, number] | undefined): BallClass {
  if (!rgb) return null;
  const hsv = [0, 0, 0];
  rgbToHsv(rgb[0], rgb[1], rgb[2], hsv);
  if (hsv[2]! < 0.22) return { kind: 'dark' };
  if (hsv[1]! < 0.16) return { kind: 'white' };
  return { kind: 'colour', hue: hsv[0]! };
}

// ---------------------------------------------------------------------------------------------------
// Model and fitting
// ---------------------------------------------------------------------------------------------------

interface Seg {
  ax: number;
  ay: number;
  az: number;
  bx: number;
  by: number;
  bz: number;
}

/**
 * Outer cloth edge (cloth → rail boundary) at cushion height, minus the pocket cut-outs. Seen from the
 * table side, that boundary is where the cushion top meets the rail's inner face, at cushion height.
 */
function edgeSegments(table: TableSpec): Seg[] {
  const X = table.length / 2 + table.cushionWidth;
  const Y = table.width / 2 + table.cushionWidth;
  const z = table.cushionHeight;
  const ec = 1.3 * table.cornerMouth + table.cushionWidth;
  const es = 0.75 * table.sideMouth + 0.03;
  const s = (ax: number, ay: number, bx: number, by: number): Seg => ({ ax, ay, az: z, bx, by, bz: z });
  return [
    s(-X + ec, -Y, -es, -Y),
    s(es, -Y, X - ec, -Y),
    s(-X + ec, Y, -es, Y),
    s(es, Y, X - ec, Y),
    s(-X, -Y + ec, -X, Y - ec),
    s(X, -Y + ec, X, Y - ec),
  ];
}

/**
 * Is the camera outside the table beyond this edge (behind that rail)? Then the cloth's boundary in the
 * photo is the top of the rail in front of the cushion, whose height above the cushion top the table
 * spec does not give (≈ 4 mm in the renderer, varies on real tables): from 8 cm above the bed that
 * unknown lip moves the edge by ≈ 8 px, which biased the pose (strike dot ≈ 0.09 R). Such an edge is
 * left out of the fit; the far and side edges and the balls still hold the pose.
 */
function seenFromOutside(sg: Seg, C: Vec3): boolean {
  if (sg.ax === sg.bx) return sg.ax < 0 ? C.x < sg.ax : C.x > sg.ax;
  return sg.ay < 0 ? C.y < sg.ay : C.y > sg.ay;
}

/** Band (px) around an edge seen from behind its rail that holds its cracks (the rail lip is unknown). */
const BEHIND_EDGE_BAND = 15;
/** Within that band: the occlusion line's own width, and the gate for a ball silhouette crack (px). */
const BAND_BALL_GATE = 2;

/** Does circle c lie on the image of a cushion edge line (centre within its radius + 2 px, within the segment)? */
function onEdgeLine(pr: Problem, fit: Fit, planes: (ReturnType<typeof segPlane> | null)[], c: { u: number; v: number; r: number }): boolean {
  const mx = (c.u - pr.cx) / fit.f;
  const my = (c.v - pr.cy) / fit.f;
  const mn = hyp3(mx, my, 1);
  for (const sp of planes) {
    if (!sp) continue;
    const e = fit.f * Math.asin(Math.max(-1, Math.min(1, (mx * sp.nx + my * sp.ny + sp.nz) / mn)));
    if (Math.abs(e) >= c.r + 2) continue;
    const du = sp.u1 - sp.u0;
    const dv = sp.v1 - sp.v0;
    const L2 = du * du + dv * dv;
    const t = L2 > 1e-9 ? ((c.u - sp.u0) * du + (c.v - sp.v0) * dv) / L2 : -1;
    if (t >= 0 && t <= 1) return true;
  }
  return false;
}

/** Is crack i within `band` px of one of the edge planes `planes` (and within its image extent)? */
function nearSeg(pr: Problem, fit: Fit, planes: (ReturnType<typeof segPlane> | null)[], i: number, band: number): boolean {
  const u = pr.px[i]!;
  const v = pr.py[i]!;
  const mx = (u - pr.cx) / fit.f;
  const my = (v - pr.cy) / fit.f;
  const mn = hyp3(mx, my, 1);
  for (const sp of planes) {
    if (!sp) continue;
    const e = fit.f * Math.asin(Math.max(-1, Math.min(1, (mx * sp.nx + my * sp.ny + sp.nz) / mn)));
    if (Math.abs(e) >= band) continue;
    const du = sp.u1 - sp.u0;
    const dv = sp.v1 - sp.v0;
    const L2 = du * du + dv * dv;
    const t = L2 > 1e-9 ? ((u - sp.u0) * du + (v - sp.v0) * dv) / L2 : -1;
    if (t >= 0 && t <= 1) return true;
  }
  return false;
}

interface Fit {
  R: M3;
  C: Vec3;
  f: number;
}

interface Problem {
  w: number;
  h: number;
  cx: number;
  cy: number;
  Rb: number;
  balls: { x: number; y: number; z: number }[];
  segs: Seg[];
  px: Float32Array;
  py: Float32Array;
  nPts: number;
  logf0: number;
  sigLogF: number;
  /**
   * Heavy-tailed (Cauchy) focal prior: the overview's focal length is a soft hint. It acts like a
   * Gaussian of σ = sigLogF near the hint, but costs only ≈ ln(1 + x²)/2 far from it, so a different
   * lens (0.5×–3×) for this photo is decided by the image, not by the hint.
   */
  robustF: boolean;
  sigRoll: number;
  /** Height prior (manual mode). */
  height?: { mu: number; sigma: number };
  /** Ball-centre observations (manual taps): ball index → image point. */
  taps: { ball: number; x: number; y: number; sigma: number }[];
  /** residuals() scratch: per element (balls, then segments) 4 camera quantities and a "computed" flag. */
  resCache: Float64Array;
  resHave: Uint8Array;
  /** Main-cloth mask (2 = cloth) for "a ball should be here but the photo shows cloth". */
  mask: Uint8Array;
  frame: Frame;
  cushionZ: number;
  /** Known balls whose colour matches the cloth (e.g. green on green): not expected to be seen. */
  camo: Uint8Array;
  /** Colour class of each known ball (null when its colour is unknown). */
  cls: BallClass[];
  /** Index of the cue ball in `balls`. */
  cueIdx: number;
  /** The photo's exposure relative to nominal (player-detect exposureOf), for colour thresholds. */
  vScale: number;
  /** colourCost of known ball k against circle candidate j, at [k · nCands + j] (filled once per photo). */
  cc: Float64Array;
  nCands: number;
  /** Pocket holes in plan view (x, y, radius): dark round blobs there are not balls. */
  pockets: { x: number; y: number; r: number }[];
  /** Half the playing area (cushion nose to nose), length and width, minus a ball radius (m). */
  halfL: number;
  halfW: number;
  /** An untinted grey cloth (neutral, S < 0.08): its mask cannot tell a ball's shaded side from it. */
  untinted: boolean;
}

/** Image bounding boxes (u0, v0, u1, v1) of the pocket holes for `pocketFit` (NaN: not in front). */
const pocketBox = new Float64Array(4 * 8);
let pocketFit: Fit | null = null;
const RIM_COS = Float64Array.from({ length: 8 }, (_, a) => Math.cos((a * Math.PI) / 4));
const RIM_SIN = Float64Array.from({ length: 8 }, (_, a) => Math.sin((a * Math.PI) / 4));

/**
 * Is the image circle (u, v, rc) on a pocket hole? Each hole's rim, at bed and at cushion height, is
 * projected with the pose and the circle must touch that image box. Decided in the image, not by
 * back-projecting (u, v) onto the bed: from a few cm above the bed a 1 px error moves that
 * back-projection by decimetres, so the dark mouths of far pockets would read as unexplained balls.
 */
function onPocket(pr: Problem, fit: Fit, u: number, v: number, rc: number): boolean {
  if (pocketFit !== fit) {
    pocketFit = fit;
    for (let q = 0; q < pr.pockets.length && q < 8; q++) {
      const p = pr.pockets[q]!;
      let u0 = Infinity;
      let v0 = Infinity;
      let u1 = -Infinity;
      let v1 = -Infinity;
      const R = fit.R;
      for (let z = 0; z < 2; z++)
        for (let a = 0; a < 8; a++) {
          // cameraToWorldC without allocating (this runs for every scored hypothesis).
          const dx = p.x + p.r * RIM_COS[a]! - fit.C.x;
          const dy = p.y + p.r * RIM_SIN[a]! - fit.C.y;
          const dz = (z ? pr.cushionZ : 0) - fit.C.z;
          const X = R[0]! * dx + R[1]! * dy + R[2]! * dz;
          const Y = R[3]! * dx + R[4]! * dy + R[5]! * dz;
          const Z = R[6]! * dx + R[7]! * dy + R[8]! * dz;
          if (Z <= 0.05) continue;
          const pu = (fit.f * X) / Z + pr.cx;
          const pv = (fit.f * Y) / Z + pr.cy;
          if (pu < u0) u0 = pu;
          if (pu > u1) u1 = pu;
          if (pv < v0) v0 = pv;
          if (pv > v1) v1 = pv;
        }
      pocketBox[q * 4] = u0;
      pocketBox[q * 4 + 1] = v0;
      pocketBox[q * 4 + 2] = u1;
      pocketBox[q * 4 + 3] = v1;
    }
  }
  const m = 0.5 * rc + 2;
  for (let q = 0; q < pr.pockets.length && q < 8; q++)
    if (u > pocketBox[q * 4]! - m && u < pocketBox[q * 4 + 2]! + m && v > pocketBox[q * 4 + 1]! - m && v < pocketBox[q * 4 + 3]! + m) return true;
  return false;
}

/**
 * Colour descriptor of ball k's visible pixels: non-cloth pixels inside 0.7 r of its projection that no
 * nearer ball's image covers (a red ball in front of the cue ball must not tint it); null when (almost)
 * all cloth.
 */
function colourAt(pr: Problem, proj: Projected, k: number): ColourDesc | null {
  const u = proj.u[k]!;
  const v = proj.v[k]!;
  const r = proj.r[k]!;
  const nb = proj.vis.length;
  let nOcc = 0;
  for (let m = 0; m < nb && nOcc < OCC_MAX; m++) {
    if (m === k || !proj.vis[m] || proj.d[m]! >= proj.d[k]!) continue;
    const t = r + proj.r[m]!;
    if ((u - proj.u[m]!) ** 2 + (v - proj.v[m]!) ** 2 < t * t) occIdx[nOcc++] = m;
  }
  const rr = 0.7 * r;
  const x0 = Math.max(0, Math.floor(u - rr));
  const x1 = Math.min(pr.w - 1, Math.ceil(u + rr));
  const y0 = Math.max(0, Math.floor(v - rr));
  const y1 = Math.min(pr.h - 1, Math.ceil(v + rr));
  const d = pr.frame.data;
  const acc = new ColourAcc(pr.vScale);
  let tot = 0;
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      if ((x + 0.5 - u) ** 2 + (y + 0.5 - v) ** 2 > rr * rr) continue;
      let hidden = false;
      for (let q = 0; q < nOcc && !hidden; q++) {
        const m = occIdx[q]!;
        hidden = (x + 0.5 - proj.u[m]!) ** 2 + (y + 0.5 - proj.v[m]!) ** 2 < proj.r[m]! ** 2;
      }
      if (hidden) continue;
      tot++;
      const i = y * pr.w + x;
      if (pr.mask[i] === 2) continue;
      acc.add(d[i * 4]!, d[i * 4 + 1]!, d[i * 4 + 2]!);
    }
  if (acc.n < Math.max(3, BALL_PIXEL_SHARE * tot)) return null;
  return acc.desc();
}

const OCC_MAX = 8;
const occIdx = new Int32Array(OCC_MAX);
/**
 * Share of a ball's inner disc that must be non-cloth for its colour to be read. On an untinted grey
 * cloth the shaded side of a white ball passes the neutral cloth test (it has the cloth's own grey; the
 * ball's lit cap, ≈ 10–40 % of the disc, does not), so a match leans on its crack support — a silhouette
 * arc of ≥ 120° — and needs only enough pixels to read the colour. Bare cloth has ≈ 0 %.
 */
const BALL_PIXEL_SHARE = 0.1;

/**
 * True when the photo shows cloth around (u, v): a predicted ball there is missing. (On an untinted grey
 * cloth a white ball's shaded side passes as cloth too; a missing ball alone says nothing about a moved
 * layout — that takes the moved-ball signature, displaced — so no finer test is needed here: one that
 * also compared the patch's brightness with the cloth beside it changed no outcome in the sweeps.)
 */
function clothAt(pr: Problem, u: number, v: number, r: number): boolean {
  const rr = Math.max(1, 0.5 * r);
  let tot = 0;
  for (let q = 0; q < 5; q++) {
    const x = Math.floor(u + rr * RING_DX[q]!);
    const y = Math.floor(v + rr * RING_DY[q]!);
    if (x < 0 || y < 0 || x >= pr.w || y >= pr.h) continue;
    tot++;
    if (pr.mask[y * pr.w + x] !== 2) return false;
  }
  return tot >= 3;
}
const RING_DX = [0, 1, -1, 0, 0];
const RING_DY = [0, 0, 0, 1, -1];

/** Per-point assignment: element index (balls first, then segments) or −1, and the residual (px). */
interface Assignment {
  elem: Int32Array;
  res: Float32Array;
}

function cameraToWorldC(R: M3, C: Vec3, p: { x: number; y: number; z: number }): [number, number, number] {
  const dx = p.x - C.x;
  const dy = p.y - C.y;
  const dz = p.z - C.z;
  return [R[0]! * dx + R[1]! * dy + R[2]! * dz, R[3]! * dx + R[4]! * dy + R[5]! * dz, R[6]! * dx + R[7]! * dy + R[8]! * dz];
}

/** Camera-frame plane normal through the camera centre and a segment, plus clipped image endpoints. */
function segPlane(pr: Problem, fit: Fit, s: Seg): { nx: number; ny: number; nz: number; u0: number; v0: number; u1: number; v1: number } | null {
  let [x0, y0, z0] = cameraToWorldC(fit.R, fit.C, { x: s.ax, y: s.ay, z: s.az });
  let [x1, y1, z1] = cameraToWorldC(fit.R, fit.C, { x: s.bx, y: s.by, z: s.bz });
  const near = 0.05;
  if (z0 < near && z1 < near) return null;
  if (z0 < near) {
    const t = (near - z0) / (z1 - z0);
    x0 += (x1 - x0) * t;
    y0 += (y1 - y0) * t;
    z0 = near;
  } else if (z1 < near) {
    const t = (near - z1) / (z0 - z1);
    x1 += (x0 - x1) * t;
    y1 += (y0 - y1) * t;
    z1 = near;
  }
  let nx = y0 * z1 - z0 * y1;
  let ny = z0 * x1 - x0 * z1;
  let nz = x0 * y1 - y0 * x1;
  const l = hyp3(nx, ny, nz);
  if (l < 1e-12) return null;
  nx /= l;
  ny /= l;
  nz /= l;
  return { nx, ny, nz, u0: (fit.f * x0) / z0 + pr.cx, v0: (fit.f * y0) / z0 + pr.cy, u1: (fit.f * x1) / z1 + pr.cx, v1: (fit.f * y1) / z1 + pr.cy };
}

/** Assign every crack point to the nearest model element within `gate` px. */
function assign(pr: Problem, fit: Fit, gate: number, out: Assignment): void {
  const { balls, Rb, cx, cy } = pr;
  const f = fit.f;
  const nb = balls.length;
  const bAx = new Float64Array(nb);
  const bAy = new Float64Array(nb);
  const bAz = new Float64Array(nb);
  const bBeta = new Float64Array(nb);
  const bU = new Float64Array(nb);
  const bV = new Float64Array(nb);
  const bReach = new Float64Array(nb);
  const bR = new Float64Array(nb);
  const bD = new Float64Array(nb);
  const bOk = new Uint8Array(nb);
  for (let k = 0; k < nb; k++) {
    const [X, Y, Z] = cameraToWorldC(fit.R, fit.C, balls[k]!);
    const im = sphereImage(X, Y, Z, Rb, f, cx, cy);
    if (!im) continue;
    if (im.u < -2 * im.r - gate || im.u > pr.w + 2 * im.r + gate || im.v < -2 * im.r - gate || im.v > pr.h + 2 * im.r + gate) continue;
    bOk[k] = 1;
    bR[k] = im.r;
    bD[k] = im.d;
    bAx[k] = X / im.d;
    bAy[k] = Y / im.d;
    bAz[k] = Z / im.d;
    bBeta[k] = Math.asin(Rb / im.d);
    bU[k] = im.u;
    bV[k] = im.v;
    const cosA = bAz[k]!;
    bReach[k] = (1.4 * im.r) / Math.max(0.3, cosA) + gate + 2;
  }
  // Occlusion: where a nearer ball's image covers ball k, ball k's silhouette is hidden, so a crack there
  // (the nearer ball's own outline) is never ball k's. occ lists, per ball, the nearer balls that overlap it.
  const occStart = new Int32Array(nb + 1);
  const occList: number[] = [];
  for (let k = 0; k < nb; k++) {
    occStart[k] = occList.length;
    if (!bOk[k]) continue;
    for (let m = 0; m < nb; m++) {
      if (m === k || !bOk[m] || bD[m]! >= bD[k]!) continue;
      const t = bR[k]! + bR[m]!;
      const du = bU[k]! - bU[m]!;
      const dv = bV[k]! - bV[m]!;
      if (du * du + dv * dv < t * t) occList.push(m);
    }
  }
  occStart[nb] = occList.length;
  const segs = pr.segs.map((s) => (seenFromOutside(s, fit.C) ? null : segPlane(pr, fit, s)));
  // Cracks along an edge seen from behind its rail are the rail's lip or a ball cut off by it: neither
  // an edge nor a ball silhouette the model can explain, so they are left unassigned.
  const behind = pr.segs.map((s) => (seenFromOutside(s, fit.C) ? segPlane(pr, fit, s) : null));
  const anyBehind = behind.some((p) => p !== null);
  const { elem, res } = out;
  for (let i = 0; i < pr.nPts; i++) {
    // In the band of an edge seen from behind its rail, a crack is either on the occlusion line itself
    // (left unassigned) or on the silhouette of a ball standing on it: the cue ball the player crouches
    // behind often does, and leaving its arc out of the fit left the strike dot unconstrained (0.18 R
    // off on a 12 px cue ball). There only a ball silhouette within BAND_BALL_GATE takes it.
    const inBand = anyBehind && nearSeg(pr, fit, behind, i, BEHIND_EDGE_BAND);
    if (inBand && nearSeg(pr, fit, behind, i, BAND_BALL_GATE)) {
      elem[i] = -1;
      res[i] = 0;
      continue;
    }
    const u = pr.px[i]!;
    const v = pr.py[i]!;
    const mx = (u - cx) / f;
    const my = (v - cy) / f;
    const mn = hyp3(mx, my, 1);
    let best = inBand ? Math.min(gate, BAND_BALL_GATE) : gate;
    let el = -1;
    let r = 0;
    for (let k = 0; k < nb; k++) {
      if (!bOk[k]) continue;
      if (Math.abs(u - bU[k]!) > bReach[k]! || Math.abs(v - bV[k]!) > bReach[k]!) continue;
      let covered = false;
      for (let q = occStart[k]!; q < occStart[k + 1]! && !covered; q++) {
        const m = occList[q]!;
        const rIn = bR[m]! - 1.5;
        const du = u - bU[m]!;
        const dv = v - bV[m]!;
        covered = rIn > 0 && du * du + dv * dv < rIn * rIn;
      }
      if (covered) continue;
      const dot = (mx * bAx[k]! + my * bAy[k]! + bAz[k]!) / mn;
      const crx = my * bAz[k]! - bAy[k]!;
      const cry = bAx[k]! - mx * bAz[k]!;
      const crz = mx * bAy[k]! - my * bAx[k]!;
      const sn = hyp3(crx, cry, crz) / mn;
      const e = f * (Math.atan2(sn, dot) - bBeta[k]!);
      if (Math.abs(e) < best) {
        best = Math.abs(e);
        el = k;
        r = e;
      }
    }
    for (let s = 0; s < segs.length && !inBand; s++) {
      const sp = segs[s];
      if (!sp) continue;
      const e = f * Math.asin(Math.max(-1, Math.min(1, (mx * sp.nx + my * sp.ny + sp.nz) / mn)));
      if (Math.abs(e) >= best) continue;
      const du = sp.u1 - sp.u0;
      const dv = sp.v1 - sp.v0;
      const L2 = du * du + dv * dv;
      const t = L2 > 1e-9 ? ((u - sp.u0) * du + (v - sp.v0) * dv) / L2 : -1;
      if (t < 0 || t > 1) continue;
      best = Math.abs(e);
      el = nb + s;
      r = e;
    }
    elem[i] = el;
    res[i] = r;
  }
}

/** Selected points per element (deterministic stride subsampling) for one LM stage. */
function selectPoints(pr: Problem, a: Assignment, maxPerBall: number, maxPerSeg: number): Int32Array {
  const nb = pr.balls.length;
  const ne = nb + pr.segs.length;
  const cnt = new Int32Array(ne);
  for (let i = 0; i < pr.nPts; i++) if (a.elem[i]! >= 0) cnt[a.elem[i]!]! += 1;
  const stride = new Float64Array(ne);
  for (let e = 0; e < ne; e++) {
    // The cue ball keeps CUE_WEIGHT× the points of another ball: the strike dot is drawn on it, so the
    // pose should put the layout's cue ball on the photo's own cue ball rather than spread a layout
    // error (the overview places balls within ≈ 1 cm) over it.
    const cap = e === pr.cueIdx ? CUE_WEIGHT * maxPerBall : e < nb ? maxPerBall : maxPerSeg;
    stride[e] = cnt[e]! > cap ? cnt[e]! / cap : 1;
  }
  const seen = new Float64Array(ne);
  const nextPick = new Float64Array(ne);
  const sel = new Int32Array(pr.nPts);
  let m = 0;
  for (let i = 0; i < pr.nPts; i++) {
    const e = a.elem[i]!;
    if (e < 0) continue;
    if (seen[e]! >= nextPick[e]!) {
      sel[m++] = i;
      nextPick[e] = nextPick[e]! + stride[e]!;
    }
    seen[e] = seen[e]! + 1;
  }
  return sel.subarray(0, m);
}

/** Points the cue ball's silhouette keeps in a fit, relative to another ball (selectPoints). */
const CUE_WEIGHT = 3;
/** Position uncertainty of a ball in the overview's layout (m), 001 SC-003 (median ≤ 10 mm). */
const LAYOUT_SIGMA = 0.005;
/** Step for the layout sensitivity (m): sub-pixel at the nearest ball, so the fit responds linearly. */
const LAYOUT_STEP = 0.0002;
/** Inlier cracks a cushion line needs to count as seen (Evaluation.edgeCrossed). */
const EDGE_LINE_SUPPORT = 15;
/**
 * Smallest angle (degrees) between a side and an end cushion line in the photo for them to count as
 * crossing (Evaluation.edgeCrossed). From a few cm above the cushion top, every cushion line far from the
 * camera lies near the cushion plane's horizon: a side and an end cushion then show as one nearly straight
 * line and pin no more than one line does. ASSUMPTION (synthetic renders): in the s101053 neighbourhood
 * (5–9 cm up, 92–100° lens, looking up at the far corner) the two lines met at 0–5° in every photo, and
 * crossing-line fits there passed with a camera 25–50 cm off (ghost 3–9 %); over 470 random envelope and
 * low wide-lens photos, 353 of 354 crossing fits met at ≥ 20°.
 */
const EDGE_CROSS_MIN_DEG = 10;
/** Fewest associated crack points an LM stage needs (the 7 parameters plus redundancy). */
const MIN_REFINE_POINTS = 12;
const SIG_BALL = 1.0; // px, silhouette crack points
const SIG_EDGE = 1.5; // px, cloth-edge crack points
const CAUCHY = 2.0; // in σ units

/** Residual vector (σ units) for the parameters p = (ω, C, log f) around the base rotation. */
function residuals(pr: Problem, R0: M3, p: Float64Array, sel: Int32Array, elemOf: Int32Array, out: Float64Array): number {
  const R = mulM3(rodrigues(p[0]!, p[1]!, p[2]!), R0);
  const C = { x: p[3]!, y: p[4]!, z: p[5]! };
  const f = Math.exp(p[6]!);
  const { cx, cy, Rb, balls } = pr;
  const nb = balls.length;
  // Per-element camera quantities, computed lazily (scratch on the problem: residuals runs ≈ 10× per
  // LM iteration).
  const cache = pr.resCache;
  const have = pr.resHave;
  have.fill(0);
  let n = 0;
  for (let q = 0; q < sel.length; q++) {
    const i = sel[q]!;
    const e = elemOf[i]!;
    const mx = (pr.px[i]! - cx) / f;
    const my = (pr.py[i]! - cy) / f;
    const mn = hyp3(mx, my, 1);
    if (e < nb) {
      if (!have[e]) {
        const [X, Y, Z] = cameraToWorldC(R, C, balls[e]!);
        const d = hyp3(X, Y, Z);
        cache[e * 4] = X / d;
        cache[e * 4 + 1] = Y / d;
        cache[e * 4 + 2] = Z / d;
        cache[e * 4 + 3] = d > Rb ? Math.asin(Rb / d) : Math.PI / 2;
        have[e] = 1;
      }
      const ax = cache[e * 4]!;
      const ay = cache[e * 4 + 1]!;
      const az = cache[e * 4 + 2]!;
      const dot = (mx * ax + my * ay + az) / mn;
      const crx = my * az - ay;
      const cry = ax - mx * az;
      const crz = mx * ay - my * ax;
      const sn = hyp3(crx, cry, crz) / mn;
      out[n++] = (f * (Math.atan2(sn, dot) - cache[e * 4 + 3]!)) / SIG_BALL;
    } else {
      if (!have[e]) {
        const s = pr.segs[e - nb]!;
        const [x0, y0, z0] = cameraToWorldC(R, C, { x: s.ax, y: s.ay, z: s.az });
        const [x1, y1, z1] = cameraToWorldC(R, C, { x: s.bx, y: s.by, z: s.bz });
        let nx = y0 * z1 - z0 * y1;
        let ny = z0 * x1 - x0 * z1;
        let nz = x0 * y1 - y0 * x1;
        const l = hyp3(nx, ny, nz) || 1;
        nx /= l;
        ny /= l;
        nz /= l;
        cache[e * 4] = nx;
        cache[e * 4 + 1] = ny;
        cache[e * 4 + 2] = nz;
        have[e] = 1;
      }
      const v = (mx * cache[e * 4]! + my * cache[e * 4 + 1]! + cache[e * 4 + 2]!) / mn;
      out[n++] = (f * Math.asin(Math.max(-1, Math.min(1, v)))) / SIG_EDGE;
    }
  }
  // Priors.
  const xf = (p[6]! - pr.logf0) / pr.sigLogF;
  out[n++] = pr.robustF ? Math.sign(xf) * Math.sqrt(Math.log1p(xf * xf)) : xf;
  out[n++] = Math.asin(Math.max(-1, Math.min(1, R[2]!))) / pr.sigRoll;
  out[n++] = C.z < 0.02 ? (0.02 - C.z) / 0.005 : C.z > 2 ? (C.z - 2) / 0.05 : 0;
  if (pr.height) out[n++] = (C.z - pr.height.mu) / pr.height.sigma;
  for (const tp of pr.taps) {
    const [X, Y, Z] = cameraToWorldC(R, C, balls[tp.ball]!);
    const im = sphereImage(X, Y, Z, Rb, f, cx, cy);
    if (im) {
      out[n++] = (im.u - tp.x) / tp.sigma;
      out[n++] = (im.v - tp.y) / tp.sigma;
    } else {
      out[n++] = 50;
      out[n++] = 50;
    }
  }
  return n;
}

function nPriors(pr: Problem): number {
  return 3 + (pr.height ? 1 : 0) + 2 * pr.taps.length;
}

const rho = (r: number) => 0.5 * CAUCHY * CAUCHY * Math.log(1 + (r / CAUCHY) ** 2);
const wCauchy = (r: number) => 1 / (1 + (r / CAUCHY) ** 2);

interface LmOut {
  fit: Fit;
  cost: number;
  /** JᵀWJ at the solution (7×7, σ units) and the robust residual variance. */
  A: Float64Array | null;
  s2: number;
}

/** Levenberg–Marquardt (Nielsen-style damping, forward-difference Jacobian, Cauchy IRLS weights). */
function levenberg(pr: Problem, fit0: Fit, sel: Int32Array, elemOf: Int32Array, maxIt: number): LmOut {
  const np = 7;
  const nRes = sel.length + nPriors(pr);
  const nPts = sel.length;
  let R0 = fit0.R;
  const p = new Float64Array([0, 0, 0, fit0.C.x, fit0.C.y, fit0.C.z, Math.log(fit0.f)]);
  const r0 = new Float64Array(nRes);
  const r1 = new Float64Array(nRes);
  const J = new Float64Array(nRes * np);
  const A = new Float64Array(np * np);
  const g = new Float64Array(np);
  const robustCost = (r: Float64Array) => {
    let c = 0;
    for (let i = 0; i < nRes; i++) c += i < nPts ? rho(r[i]!) : 0.5 * r[i]! * r[i]!;
    return c;
  };
  residuals(pr, R0, p, sel, elemOf, r0);
  let cost = robustCost(r0);
  let lambda = 1e-3;
  let lastA: Float64Array | null = null;
  const steps = [1e-6, 1e-6, 1e-6, 1e-6, 1e-6, 1e-6, 1e-6];
  for (let it = 0; it < maxIt; it++) {
    // Jacobian.
    for (let j = 0; j < np; j++) {
      const old = p[j]!;
      p[j] = old + steps[j]!;
      residuals(pr, R0, p, sel, elemOf, r1);
      p[j] = old;
      for (let i = 0; i < nRes; i++) J[i * np + j] = (r1[i]! - r0[i]!) / steps[j]!;
    }
    A.fill(0);
    g.fill(0);
    for (let i = 0; i < nRes; i++) {
      const wi = i < nPts ? wCauchy(r0[i]!) : 1;
      const ri = r0[i]!;
      for (let a = 0; a < np; a++) {
        const ja = J[i * np + a]! * wi;
        if (ja === 0) continue;
        g[a] = g[a]! + ja * ri;
        for (let b = a; b < np; b++) A[a * np + b] = A[a * np + b]! + ja * J[i * np + b]!;
      }
    }
    for (let a = 0; a < np; a++) for (let b = 0; b < a; b++) A[a * np + b] = A[b * np + a]!;
    lastA = A.slice();
    let accepted = false;
    let newCost = cost;
    for (let tries = 0; tries < 8; tries++) {
      const M = A.slice();
      for (let a = 0; a < np; a++) M[a * np + a] = M[a * np + a]! * (1 + lambda) + 1e-12;
      const rhs = new Float64Array(np);
      for (let a = 0; a < np; a++) rhs[a] = -g[a]!;
      const d = solveN(M, rhs, np);
      if (!d) {
        lambda *= 10;
        continue;
      }
      const q = p.slice();
      for (let a = 0; a < np; a++) q[a] = q[a]! + d[a]!;
      residuals(pr, R0, q, sel, elemOf, r1);
      const c1 = robustCost(r1);
      if (Number.isFinite(c1) && c1 < cost) {
        // Re-linearise the rotation around the new estimate.
        R0 = mulM3(rodrigues(q[0]!, q[1]!, q[2]!), R0);
        p[0] = 0;
        p[1] = 0;
        p[2] = 0;
        for (let a = 3; a < np; a++) p[a] = q[a]!;
        newCost = c1;
        accepted = true;
        lambda = Math.max(1e-9, lambda / 3);
        break;
      }
      lambda *= 6;
    }
    if (!accepted) break;
    const rel = (cost - newCost) / Math.max(1e-12, cost);
    cost = newCost;
    residuals(pr, R0, p, sel, elemOf, r0);
    if (rel < 1e-7) break;
  }
  let s2 = 0;
  let sw = 0;
  for (let i = 0; i < nPts; i++) {
    const wi = wCauchy(r0[i]!);
    s2 += wi * r0[i]! * r0[i]!;
    sw += wi;
  }
  s2 = sw > np ? s2 / (sw - np) : 1;
  return { fit: { R: R0, C: { x: p[3]!, y: p[4]!, z: p[5]! }, f: Math.exp(p[6]!) }, cost, A: lastA, s2 };
}

interface Refined {
  fit: Fit;
  lm: LmOut;
  assign: Assignment;
}

/** ICP-style refinement: re-associate under a shrinking gate, then LM on the association. */
function refine(pr: Problem, fit0: Fit, gates: number[]): Refined {
  const asg: Assignment = { elem: new Int32Array(pr.nPts), res: new Float32Array(pr.nPts) };
  let fit = fit0;
  let lm: LmOut = { fit, cost: Infinity, A: null, s2: 1 };
  for (let g = 0; g < gates.length; g++) {
    assign(pr, fit, gates[g]!, asg);
    // Coarse to fine: the wide gates only bring the seed into the basin of the right association, so they
    // run on a third of the points; the last two (the fit and its covariance) on all of them. (Fewer
    // iterations there too left a two-tap fit of a near cue ball short of its basin.)
    const coarse = g < gates.length - 2;
    const sel = coarse ? selectPoints(pr, asg, 30, 55) : selectPoints(pr, asg, 90, 160);
    // Nothing (or almost nothing) within the gate: the seed is wrong; the priors alone would only drift.
    if (sel.length < MIN_REFINE_POINTS) break;
    lm = levenberg(pr, fit, sel, asg.elem, 8);
    fit = lm.fit;
  }
  assign(pr, fit, gates[gates.length - 1]!, asg);
  return { fit, lm, assign: asg };
}

// ---------------------------------------------------------------------------------------------------
// Hypotheses
// ---------------------------------------------------------------------------------------------------

interface Hyp {
  fit: Fit;
  score: number;
}

/** 0 = compatible … 4 = clearly a different ball (dark vs white vs coloured, or another hue). */
function colourCost(cls: BallClass, c: ColourDesc): number {
  if (!cls) return 0;
  if (cls.kind === 'dark') return c.darkFrac > 0.25 && c.whiteFrac < 0.5 ? 0 : 4;
  if (cls.kind === 'white') return c.whiteFrac > 0.3 && c.satFrac < 0.3 && c.darkFrac < 0.5 ? 0 : 4;
  // A coloured ball seen mostly white is plausibly a stripe showing its white band: weak match.
  if (c.satFrac < 0.12) return c.whiteFrac > 0.5 ? 2 : 4;
  return Math.min(4, (hueDiff(c.hue, cls.hue) / 14) ** 2);
}

interface Projected {
  u: Float64Array;
  v: Float64Array;
  r: Float64Array;
  d: Float64Array;
  vis: Uint8Array;
}

/** scorePose scratch: each ball's best circle and cost, each circle's best (owning) ball and cost. */
interface ScoreScratch {
  ballCand: Int32Array;
  ballCost: Float64Array;
  candOwner: Int32Array;
  candCost: Float64Array;
}

const scoreScratch = (nb: number, nc: number): ScoreScratch => ({ ballCand: new Int32Array(nb), ballCost: new Float64Array(nb), candOwner: new Int32Array(nc), candCost: new Float64Array(nc) });

/** Visibility codes: 0 out of view, 1 centre in frame, 2 mostly hidden by a nearer ball, 3 cut by the frame edge. */
const projTmp = new Float64Array(4);

function projectAll(pr: Problem, fit: Fit, out: Projected): void {
  const nb = pr.balls.length;
  const R = fit.R;
  const C = fit.C;
  for (let k = 0; k < nb; k++) {
    // cameraToWorldC and sphereImage, without allocating (this runs for every hypothesis).
    const b = pr.balls[k]!;
    const dx = b.x - C.x;
    const dy = b.y - C.y;
    const dz = b.z - C.z;
    const X = R[0]! * dx + R[1]! * dy + R[2]! * dz;
    const Y = R[3]! * dx + R[4]! * dy + R[5]! * dz;
    const Z = R[6]! * dx + R[7]! * dy + R[8]! * dz;
    out.vis[k] = 0;
    if (!sphereImageTo(X, Y, Z, pr.Rb, fit.f, pr.cx, pr.cy, projTmp)) continue;
    const u = projTmp[0]!;
    const v = projTmp[1]!;
    const r = projTmp[2]!;
    out.u[k] = u;
    out.v[k] = v;
    out.r[k] = r;
    out.d[k] = projTmp[3]!;
    if (u < -r || u > pr.w + r || v < -r || v > pr.h + r) continue;
    out.vis[k] = u < 0 || u > pr.w || v < 0 || v > pr.h ? 3 : 1;
  }
  // Mostly hidden behind a nearer ball → not expected to be seen on its own.
  for (let k = 0; k < nb; k++) {
    if (!out.vis[k]) continue;
    for (let m = 0; m < nb; m++) {
      if (m === k || !out.vis[m] || out.d[m]! >= out.d[k]!) continue;
      const t = out.r[m]! - 0.3 * out.r[k]!;
      const du = out.u[k]! - out.u[m]!;
      const dv = out.v[k]! - out.v[m]!;
      if (du >= t || -du >= t || dv >= t || -dv >= t) continue;
      if (hyp2(du, dv) < t) {
        out.vis[k] = 2;
        break;
      }
    }
  }
}

/**
 * Score a pose by how many known balls land on candidate circles of the right size and colour, one
 * ball per circle (with 15 reds, a wrong pose could otherwise pile several reds onto one circle), and
 * only colour-compatible pairs (as for a final match). Balls predicted on plain cloth count against it
 * (a moved ball); balls predicted inside other blobs (packed, hidden, or the same colour as the cloth)
 * are neutral. Circles that no predicted ball explains also count against it.
 */
function scorePose(pr: Problem, fit: Fit, known: KnownBall[], cands: Candidate[], proj: Projected, ss: ScoreScratch): number {
  projectAll(pr, fit, proj);
  let score = 0;
  const { ballCand, ballCost, candOwner, candCost } = ss;
  candOwner.fill(-1);
  candCost.fill(Infinity);
  for (let k = 0; k < known.length; k++) {
    ballCand[k] = -1;
    if (proj.vis[k] !== 1 && proj.vis[k] !== 3) continue;
    const rk = proj.r[k]!;
    const uk = proj.u[k]!;
    const vk = proj.v[k]!;
    const gate = 3 * (0.35 * rk + 3);
    const gate2 = gate * gate;
    const ccRow = k * pr.nCands;
    let best = 9;
    for (let j = 0; j < cands.length; j++) {
      const cc = pr.cc[ccRow + j]!;
      if (cc >= 3) continue;
      const c = cands[j]!;
      const ratio = c.r / rk;
      if (ratio < 0.5 || ratio > 2) continue;
      const du = c.u - uk;
      const dv = c.v - vk;
      const d2 = du * du + dv * dv;
      if (d2 >= gate2) continue;
      const lr = Math.log(ratio);
      const cost = (9 * d2) / gate2 + 0.5 * cc + 2 * lr * lr;
      if (cost < best) {
        best = cost;
        ballCand[k] = j;
      }
    }
    ballCost[k] = best;
    const j = ballCand[k]!;
    if (j >= 0 && best < candCost[j]!) {
      candCost[j] = best;
      candOwner[j] = k;
    }
  }
  for (let k = 0; k < known.length; k++) {
    if (proj.vis[k] !== 1 && proj.vis[k] !== 3) continue;
    const j = ballCand[k]!;
    if (j >= 0) {
      if (candOwner[j] === k) score += 1.5 - 0.12 * ballCost[k]!;
    } else if (proj.vis[k] === 1 && !pr.camo[k] && clothAt(pr, proj.u[k]!, proj.v[k]!, proj.r[k]!)) score -= 0.6;
  }
  for (let j = 0; j < cands.length; j++) {
    const c = cands[j]!;
    if (c.r < 3) continue;
    // A circle its owning ball's projection already explains needs no search over every ball.
    const k = candOwner[j]!;
    if (k >= 0) {
      const t = proj.r[k]! + 0.5 * c.r + 2;
      const du = c.u - proj.u[k]!;
      const dv = c.v - proj.v[k]!;
      if (du * du + dv * dv < t * t) continue;
    }
    if (!explained(pr, fit, c, proj)) score -= 0.4;
  }
  return score;
}

function explained(pr: Problem, fit: Fit, c: Candidate, proj: Projected): boolean {
  for (let k = 0; k < proj.vis.length; k++) {
    if (!proj.vis[k]) continue;
    const t = proj.r[k]! + 0.5 * c.r + 2;
    const du = c.u - proj.u[k]!;
    const dv = c.v - proj.v[k]!;
    if (du * du + dv * dv < t * t) return true;
  }
  return onPocket(pr, fit, c.u, c.v, c.r);
}

/** Largest depth ratio between a pair hypothesis's root and its circle's apparent-size depth (poseFromPair). */
const PAIR_DEPTH_RATIO = 2;

/** Closed-form level-camera pose from the cue ball (camera frame P_c) and one more ball seen along a_j. */
function poseFromPair(cueW: Vec3, Pc: [number, number, number], aj: [number, number, number], Dj: number, ballW: Vec3, out: Fit[], f: number): void {
  const Ax = ballW.x - cueW.x;
  const Ay = ballW.y - cueW.y;
  const L = hyp2(Ax, Ay);
  if (L < 1e-6) return;
  const ap = aj[0] * Pc[0] + aj[1] * Pc[1] + aj[2] * Pc[2];
  const pc2 = Pc[0] * Pc[0] + Pc[1] * Pc[1] + Pc[2] * Pc[2];
  let disc = ap * ap - pc2 + L * L;
  if (disc < 0) {
    if (disc < -0.05 * L * L) return;
    disc = 0;
  }
  const sq = Math.sqrt(disc);
  const roots = sq > 1e-9 ? [ap + sq, ap - sq] : [ap];
  for (const D of roots) {
    if (!(D > 0.05)) continue;
    // A root must agree with the circle's apparent size within PAIR_DEPTH_RATIO: the layout distance to
    // the cue ball puts the ball at depth D along the ray, its circle at depth Dj (a circle fitted to a
    // ≥ 120° arc has its radius within ≈ 25 %, so a factor of 2 is generous). A wider window let every
    // red circle pair with every red ball at almost any depth: twice the hypotheses on a snooker photo,
    // and the ones it added never seeded a fit (same results over 100 envelope photos and 36 with an
    // occluded cue ball; failing photos 25 % faster at the 95th percentile).
    if (Number.isFinite(Dj) && (D > PAIR_DEPTH_RATIO * Dj || D < Dj / PAIR_DEPTH_RATIO)) continue;
    const vx = D * aj[0] - Pc[0];
    const vy = D * aj[1] - Pc[1];
    const vz = D * aj[2] - Pc[2];
    const hmag = hyp2(vy, vz);
    const hs = vz >= 0 ? hmag : -hmag;
    if (Math.abs(hs) < 1e-9) continue;
    const phi = Math.atan2(-vy / hs, vz / hs);
    const psi = Math.atan2(Ax * vx + Ay * hs, Ax * hs - Ay * vx);
    if (phi < -0.35 || phi > 1.45) continue;
    const R = rotYawPitch(psi, phi);
    // C = c − Rᵀ P_c
    const C = {
      x: cueW.x - (R[0]! * Pc[0] + R[3]! * Pc[1] + R[6]! * Pc[2]),
      y: cueW.y - (R[1]! * Pc[0] + R[4]! * Pc[1] + R[7]! * Pc[2]),
      z: cueW.z - (R[2]! * Pc[0] + R[5]! * Pc[1] + R[8]! * Pc[2]),
    };
    if (C.z < 0.015 || C.z > 2.5) continue;
    out.push({ R, C, f });
  }
}

/** Camera-frame direction and distance of a ball from its circle (approximate inverse of sphereImage). */
function ballRay(c: { u: number; v: number; r: number }, f: number, cx: number, cy: number, Rb: number): { a: [number, number, number]; D: number } {
  const x = (c.u - cx) / f;
  const y = (c.v - cy) / f;
  const n = hyp3(x, y, 1);
  const az = 1 / n;
  // Ellipse centre sits slightly outward of the projected centre: undo to first order.
  const beta = Number.isFinite(c.r) ? Math.atan((c.r * Math.pow(az, 1.5)) / f) : NaN;
  const corr = Number.isFinite(beta) ? 1 - Math.sin(beta) ** 2 / (az * az) : 1;
  const xx = x * corr;
  const yy = y * corr;
  const nn = hyp3(xx, yy, 1);
  return { a: [xx / nn, yy / nn, 1 / nn], D: Number.isFinite(beta) ? Rb / Math.sin(beta) : NaN };
}

function poseDistance(a: Fit, b: Fit): number {
  let rot = 0;
  for (let i = 0; i < 9; i++) rot += (a.R[i]! - b.R[i]!) ** 2;
  return hyp3(a.C.x - b.C.x, a.C.y - b.C.y, a.C.z - b.C.z) / 0.05 + Math.sqrt(rot) / 0.03 + Math.abs(Math.log(a.f / b.f)) / 0.05;
}

// ---------------------------------------------------------------------------------------------------
// Estimator
// ---------------------------------------------------------------------------------------------------

function toPose(fit: Fit, w: number, h: number): CameraPose {
  const R = fit.R.slice();
  const C = fit.C;
  return {
    R,
    t: { x: -(R[0]! * C.x + R[1]! * C.y + R[2]! * C.z), y: -(R[3]! * C.x + R[4]! * C.y + R[5]! * C.z), z: -(R[6]! * C.x + R[7]! * C.y + R[8]! * C.z) },
    f: fit.f,
    cx: w / 2,
    cy: h / 2,
    width: w,
    height: h,
  };
}

interface Evaluation {
  /**
   * Matched balls, with the colour cost of the photo's pixels against the ball's known colour, and what
   * that colour was read from: the ball's own pixels (`desc`), or else the circle fitted to its arc (`cand`).
   */
  matched: { k: number; u: number; v: number; r: number; cov: number; colour: number; desc: ColourDesc | null; cand: number }[];
  visible: number;
  /** Visible balls predicted where the photo shows plain cloth. */
  missing: number;
  residualPx: number;
  edgeInliers: number;
  /**
   * Cushion lines of both directions carry ≥ EDGE_LINE_SUPPORT inlier cracks (a side and an end
   * cushion) and meet at ≥ EDGE_CROSS_MIN_DEG in the photo: two non-parallel table lines pin the pose;
   * parallel ones (the near and far end, seen at a grazing angle), or a side and an end line that show as
   * one straight line (both on the cushion plane's horizon, seen from a few cm above it), leave it free
   * to slide.
   */
  edgeCrossed: boolean;
  /** Fraction of the cloth-boundary cracks the model explains (within 2.5 px). */
  explainedFrac: number;
  unexplained: number;
  /** The visible balls predicted on plain cloth (missing) and the circles nothing explains, by index. */
  missingIdx: number[];
  unexplainedIdx: number[];
  quality: number;
}

/** Final per-ball support (arc coverage of inlier cracks) and residual statistics for a refined fit. */
function evaluate(pr: Problem, r: Refined, cands: Candidate[]): Evaluation {
  const nb = pr.balls.length;
  const proj: Projected = { u: new Float64Array(nb), v: new Float64Array(nb), r: new Float64Array(nb), d: new Float64Array(nb), vis: new Uint8Array(nb) };
  projectAll(pr, r.fit, proj);
  const covBits = new Uint8Array(nb * 36);
  const cnt = new Int32Array(nb);
  const absRes = new Float32Array(pr.nPts);
  let nAbs = 0;
  let edgeInliers = 0;
  const segIn = new Int32Array(pr.segs.length);
  let explainedPts = 0;
  // Edges seen from behind their rail are left out of the fit (seenFromOutside); their cracks are
  // neither explained nor unexplained: they do not count in explainedFrac.
  const behind = pr.segs.map((sg) => (seenFromOutside(sg, r.fit.C) ? segPlane(pr, r.fit, sg) : null));
  let neutralPts = 0;
  for (let i = 0; i < pr.nPts; i++) {
    const e = r.assign.elem[i]!;
    if (e < 0) {
      if (nearSeg(pr, r.fit, behind, i, BEHIND_EDGE_BAND)) neutralPts++;
      continue;
    }
    const res = Math.abs(r.assign.res[i]!);
    if (res < 2.5) explainedPts++;
    if (e >= nb) {
      if (res < 2) {
        edgeInliers++;
        segIn[e - nb]! += 1;
      }
      continue;
    }
    absRes[nAbs++] = res;
    if (res > 2.5) continue;
    cnt[e]! += 1;
    const a = Math.atan2(pr.py[i]! - proj.v[e]!, pr.px[i]! - proj.u[e]!);
    covBits[e * 36 + Math.min(35, Math.floor(((a + Math.PI) / (2 * Math.PI)) * 36))] = 1;
  }
  const sorted = absRes.subarray(0, nAbs).sort();
  const residualPx = nAbs ? 1.4826 * sorted[nAbs >> 1]! : Infinity;
  const matched: Evaluation['matched'] = [];
  let visible = 0;
  let missing = 0;
  const missingIdx: number[] = [];
  for (let k = 0; k < nb; k++) {
    if (proj.vis[k] === 1) visible++;
    let bitsCount = 0;
    for (let q = 0; q < 36; q++) bitsCount += covBits[k * 36 + q]!;
    const cov = bitsCount * 10;
    const expected = 1.27 * proj.r[k]! * ((cov * Math.PI) / 180);
    let colour = Infinity;
    let desc: ColourDesc | null = null;
    let cand = -1;
    if (proj.vis[k] === 1 || proj.vis[k] === 3) {
      desc = colourAt(pr, proj, k);
      if (desc) colour = colourCost(pr.cls[k]!, desc);
      else {
        // Too few non-cloth pixels inside the ball to read its colour here (on an untinted grey cloth a
        // white ball's side-lit face has the cloth's own grey): the circle fitted to this ball's own
        // silhouette arc, if there is one, carries the colour of its blob.
        for (let j = 0; j < cands.length; j++) {
          const cj = cands[j]!;
          const ratio = cj.r / proj.r[k]!;
          if (ratio < 0.7 || ratio > 1.4 || hyp2(cj.u - proj.u[k]!, cj.v - proj.v[k]!) > 0.35 * proj.r[k]! + 2) continue;
          if (pr.cc[k * pr.nCands + j]! < colour) {
            colour = pr.cc[k * pr.nCands + j]!;
            cand = j;
          }
        }
      }
    }
    if ((proj.vis[k] === 1 || proj.vis[k] === 3) && colour < 3 && cov >= 120 && cnt[k]! >= Math.max(6, 0.35 * expected)) matched.push({ k, u: proj.u[k]!, v: proj.v[k]!, r: proj.r[k]!, cov, colour, desc, cand });
    else if (proj.vis[k] === 1 && !pr.camo[k] && clothAt(pr, proj.u[k]!, proj.v[k]!, proj.r[k]!)) {
      missing++;
      missingIdx.push(k);
    }
  }
  // Candidates that no visible ball explains (a moved or unknown ball). An arc proposed on the rail band
  // along a cushion line of this pose is the rail's own edge (its lip, its shading), not a ball: from a
  // few cm up, the far rail of an untinted grey cloth gave dozens of such 4 px arcs, which sank the
  // confidence of a pose 0.5 cm from the truth with ten balls matched.
  const allPlanes = pr.segs.map((sg) => segPlane(pr, r.fit, sg));
  let unexplained = 0;
  const unexplainedIdx: number[] = [];
  for (let j = 0; j < cands.length; j++) {
    const c = cands[j]!;
    if (c.r < 3 || explained(pr, r.fit, c, proj)) continue;
    if (c.large && onEdgeLine(pr, r.fit, allPlanes, c)) continue;
    unexplained++;
    unexplainedIdx.push(j);
  }
  const explainedFrac = explainedPts / Math.max(1, pr.nPts - neutralPts);
  const quality = matched.length - 0.6 * missing - 0.4 * unexplained - 0.1 * Math.min(10, residualPx) + 4 * explainedFrac;
  // edgeSegments order: four side-cushion segments (y = ±Y), then the two end cushions (x = ±X). A side
  // and an end line cross only where their images meet at EDGE_CROSS_MIN_DEG or more: the image line of a
  // segment's plane (camera frame normal n) has the image normal (n.x, n.y).
  const cosCross = Math.cos((EDGE_CROSS_MIN_DEG * Math.PI) / 180);
  let crossed = false;
  for (let q = 0; q < 4 && !crossed; q++) {
    const a = allPlanes[q];
    if (segIn[q]! < EDGE_LINE_SUPPORT || !a) continue;
    const la = hyp2(a.nx, a.ny);
    for (let q2 = 4; q2 < pr.segs.length; q2++) {
      const b = allPlanes[q2];
      if (segIn[q2]! < EDGE_LINE_SUPPORT || !b) continue;
      const lb = hyp2(b.nx, b.ny);
      if (la > 1e-9 && lb > 1e-9 && Math.abs(a.nx * b.nx + a.ny * b.ny) / (la * lb) <= cosCross) crossed = true;
    }
  }
  return { matched, visible, missing, residualPx, edgeInliers, edgeCrossed: crossed, explainedFrac, unexplained, missingIdx, unexplainedIdx, quality };
}

/**
 * The moved-ball signature of ball k under this pose: k is predicted on plain cloth (missing), and these
 * circles nothing explains have its colour and lie where a ball can rest (restsElsewhere). Returns their
 * indices (empty: no signature).
 */
function displacedCircles(pr: Problem, fit: Fit, cands: Candidate[], ev: Evaluation, k: number): number[] {
  const out: number[] = [];
  if (!ev.missingIdx.includes(k)) return out;
  for (const j of ev.unexplainedIdx) {
    const c = cands[j]!;
    if (pr.cc[k * pr.nCands + j]! >= 3 || c.r < 3) continue;
    if (restsElsewhere(pr, fit, c, k)) out.push(j);
  }
  return out;
}

/**
 * Does circle c put ball k elsewhere on the bed? Its ray meets the plane of the ball centres on the bed,
 * at least DISPLACED_MIN ball radii from where the layout put k, and a ball there has the circle's image
 * size (within DISPLACED_SIZE).
 */
function restsElsewhere(pr: Problem, fit: Fit, c: Candidate, k: number): boolean {
  const R = fit.R;
  const b = pr.balls[k]!;
  // Ray through the circle centre, in world coordinates (Rᵀ · camera ray).
  const mx = (c.u - pr.cx) / fit.f;
  const my = (c.v - pr.cy) / fit.f;
  const dx = R[0]! * mx + R[3]! * my + R[6]!;
  const dy = R[1]! * mx + R[4]! * my + R[7]!;
  const dz = R[2]! * mx + R[5]! * my + R[8]!;
  if (!(dz < -1e-6)) return false;
  const t = (pr.Rb - fit.C.z) / dz;
  if (!(t > 0)) return false;
  const px = fit.C.x + t * dx;
  const py = fit.C.y + t * dy;
  if (Math.abs(px) > pr.halfL || Math.abs(py) > pr.halfW) return false;
  if (hyp2(px - b.x, py - b.y) < DISPLACED_MIN * pr.Rb) return false;
  const [X, Y, Z] = cameraToWorldC(R, fit.C, { x: px, y: py, z: pr.Rb });
  if (!sphereImageTo(X, Y, Z, pr.Rb, fit.f, pr.cx, pr.cy, projTmp)) return false;
  const ratio = c.r / projTmp[2]!;
  return ratio > 1 / DISPLACED_SIZE && ratio < DISPLACED_SIZE;
}

/** Shift (ball radii, along the line of sight in the photo) of a key ball's circle that can be a move (overlappedCircles). */
const LOS_SHIFT_MIN = 0.4;
/**
 * The moved-ball signature of a key ball (target or cue ball) moved along the line of sight: predicted
 * in full view, but neither matched (its outline is off) nor on bare cloth (its circle still overlaps the
 * prediction), with a circle of its colour that only its own prediction explains, off the prediction by
 * LOS_SHIFT_MIN radii or more along the ball's line of sight, and that puts it elsewhere on the bed
 * (restsElsewhere). From behind the cue ball, 12 cm along the aim moves a ball by ≈ 1.2 radii in the
 * photo: within the guide's image tolerance, yet the cut changes by 5° (release verification: "Fit:
 * good · 99 %" with the ghost ball 12 cm off). A move under about 0.4 radii (a low camera far from the
 * ball: 12.5 cm is 5 px there) is within the circle fit's own error and is not told. Returns those
 * circles' indices.
 */
function overlappedCircles(pr: Problem, fit: Fit, cands: Candidate[], ev: Evaluation, k: number): number[] {
  const out: number[] = [];
  if (pr.camo[k] || ev.missingIdx.includes(k) || ev.matched.some((m) => m.k === k)) return out;
  const nb = pr.balls.length;
  const proj: Projected = { u: new Float64Array(nb), v: new Float64Array(nb), r: new Float64Array(nb), d: new Float64Array(nb), vis: new Uint8Array(nb) };
  projectAll(pr, fit, proj);
  if (proj.vis[k] !== 1) return out;
  // The image direction in which k moves when it moves away along its line of sight on the bed.
  const b = pr.balls[k]!;
  const lx = b.x - fit.C.x;
  const ly = b.y - fit.C.y;
  const ll = hyp2(lx, ly);
  if (ll < 1e-6) return out;
  const [X1, Y1, Z1] = cameraToWorldC(fit.R, fit.C, { x: b.x + (0.02 * lx) / ll, y: b.y + (0.02 * ly) / ll, z: pr.Rb });
  if (!sphereImageTo(X1, Y1, Z1, pr.Rb, fit.f, pr.cx, pr.cy, projTmp)) return out;
  const ex = projTmp[0]! - proj.u[k]!;
  const ey = projTmp[1]! - proj.v[k]!;
  const el = hyp2(ex, ey);
  if (el < 1e-9) return out;
  for (let j = 0; j < cands.length; j++) {
    const c = cands[j]!;
    if (pr.cc[k * pr.nCands + j]! >= 3 || c.r < 3) continue;
    // Explained by k's prediction (explained()'s reach) and by no other ball in view.
    let mine = false;
    let other = false;
    for (let o = 0; o < nb && !other; o++) {
      if (!proj.vis[o]) continue;
      const reach = proj.r[o]! + 0.5 * c.r + 2;
      if (hyp2(c.u - proj.u[o]!, c.v - proj.v[o]!) >= reach) continue;
      if (o === k) mine = true;
      else other = true;
    }
    // Off along the line of sight (nearer or farther), not sideways: a pose a little off shifts a far
    // ball sideways by a radius (from 7 cm up, 8.8 px against r 7.8 px at 0.1 r along it), which is no
    // move; a ball moved 10–17 cm along the aim shows 0.55–1.1 radii along it.
    const along = Math.abs(((c.u - proj.u[k]!) * ex + (c.v - proj.v[k]!) * ey) / el) / proj.r[k]!;
    if (mine && !other && along >= LOS_SHIFT_MIN && restsElsewhere(pr, fit, c, k)) out.push(j);
  }
  return out;
}
/** A moved ball's new spot: at least this many ball radii from the old one (layout error ≤ ≈ 1 cm). */
const DISPLACED_MIN = 2.5;
/** Image-size agreement of a stray circle with a ball resting where its ray meets the bed. */
const DISPLACED_SIZE = 1.5;

/**
 * Has ball k been moved, by the photo's own evidence? It shows the moved-ball signature, and the static
 * layout cannot put k on that circle after all, the pose being slightly off (a ball at the edge of a
 * wide-angle photo, unmatched, does not hold the focal length): refit with k pinned to the circle, an
 * unmoved ball costs the other evidence little, a ball 10 cm away drags the pose off it.
 */
function displaced(pr: Problem, rf: Refined, cands: Candidate[], ev: Evaluation, k: number): boolean {
  return displacedCircles(pr, rf.fit, cands, ev, k).some((j) => !stillFits(pr, rf, k, cands[j]!));
}

/**
 * Do several balls show the moved-ball signature, each with a circle of its own? When the whole layout
 * moved, no pose fits it and the best wrong pose is no worse with any one ball pinned to its new spot,
 * but a static table does not leave two of its balls on bare cloth with circles of their colours
 * resting elsewhere.
 */
function severalDisplaced(pr: Problem, fit: Fit, cands: Candidate[], ev: Evaluation): boolean {
  const used = new Set<number>();
  let n = 0;
  for (const k of ev.missingIdx) {
    const j = displacedCircles(pr, fit, cands, ev, k).find((q) => !used.has(q));
    if (j === undefined) continue;
    used.add(j);
    if (++n >= 2) return true;
  }
  return false;
}

/**
 * Does the refined pose still explain its evidence with ball k pinned to circle c (a tap-like prior on
 * k's image centre)? It does when the robust cost of the same points stays within STILL_FITS_RATIO of
 * the free fit's, or grows by less than STILL_FITS_ABS. Measured: an unmoved ball at the edge of a
 * 92° grey-cloth photo, mispredicted by its own width, costs × 1.3–1.8; a cue ball moved 8–20 cm costs
 * × 4.7–23 (+170 … +1000).
 */
function stillFits(pr: Problem, rf: Refined, k: number, c: Candidate, reach = false): boolean {
  const sel = selectPoints(pr, rf.assign, 90, 160);
  if (sel.length < MIN_REFINE_POINTS) return false;
  const keep = pr.taps;
  const base = levenberg(pr, rf.fit, sel, rf.assign.elem, 0).cost;
  pr.taps = [{ ball: k, x: c.u, y: c.v, sigma: Math.max(1, 0.15 * c.r) }];
  const forced = levenberg(pr, rf.fit, sel, rf.assign.elem, 8);
  pr.taps = keep;
  if (forced.cost > Math.max(STILL_FITS_RATIO * base, base + STILL_FITS_ABS)) return false;
  if (!reach) return true;
  // The refit must also put k on the circle: the pinned centre costs only (offset / σ)² / 2, so a pose
  // held by the other balls can leave k where it was within the cost allowance.
  const [X, Y, Z] = cameraToWorldC(forced.fit.R, forced.fit.C, pr.balls[k]!);
  if (!sphereImageTo(X, Y, Z, pr.Rb, forced.fit.f, pr.cx, pr.cy, projTmp)) return false;
  return hyp2(projTmp[0]! - c.u, projTmp[1]! - c.v) <= Math.max(2, STILL_FITS_REACH * c.r);
}
/** How close (circle radii) a refit with ball k pinned must bring k to the circle for k not to have moved (stillFits `reach`). */
const STILL_FITS_REACH = 0.25;
const STILL_FITS_RATIO = 2.5;
/** Neutral cloth tint below which no chroma separates it from neutral ball surfaces (table-detect's rule). */
const UNTINTED_SAT = 0.08;
const STILL_FITS_ABS = 100;

// ---------------------------------------------------------------------------------------------------
// Roll completion of a pair hypothesis
// ---------------------------------------------------------------------------------------------------

/** Largest |roll| a hypothesis may have (the spec allows ±20°; margin for the fit to settle). */
const ROLL_MAX = (35 * Math.PI) / 180;
/** θ votes: 2° bins over ±40°, each a bit set of the voting circles (≤ 31 circles) and a θ sum. */
const THETA_STEP = (2 * Math.PI) / 180;
const THETA_BINS = 40;
const voteMask = new Int32Array(THETA_BINS);
const voteSum = new Float64Array(THETA_BINS);
const voteCnt = new Int32Array(THETA_BINS);

function popcount(x: number): number {
  let v = x - ((x >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/** Camera-frame rays of the hypothesis circles at one focal guess (unit direction, image radius). */
interface Rays {
  /** Index of each hypothesis circle in the photo's candidate list. */
  idx: Int32Array;
  ax: Float64Array;
  ay: Float64Array;
  az: Float64Array;
  r: Float64Array;
  n: number;
}

/**
 * The cue ball (camera-frame centre Pc) and one more ball (index j) fix the rotation only up to a
 * turn θ about v = R·(W_j − c), the camera-frame vector between them; poseFromPair picks the level
 * member (roll 0). Here every other circle k, read as a colour-compatible known ball m, votes for the
 * θ that puts m on k's ray: with q = R0·(W_m − c), m's centre Pc + Rot_v(θ)·q runs on a circle about
 * v, and k's ray crosses that circle's plane at the point of angle θ (the radial miss, in image px, is
 * the gate). The θ that ≥ 2 distinct circles agree on gives the rolled pose, kept when its roll is
 * within ROLL_MAX. A phone held at an angle is then hypothesised as exactly as a level one.
 */
function rollCompletion(pr: Problem, fit: Fit, Pc: [number, number, number], cueIdx: number, j: number, skip0: number, skip1: number, rays: Rays, out: Fit[]): void {
  const R0 = fit.R;
  const cue = pr.balls[cueIdx]!;
  const bj = pr.balls[j]!;
  const ux = bj.x - cue.x;
  const uy = bj.y - cue.y;
  let vx = R0[0]! * ux + R0[1]! * uy;
  let vy = R0[3]! * ux + R0[4]! * uy;
  let vz = R0[6]! * ux + R0[7]! * uy;
  const vl = hyp3(vx, vy, vz);
  if (vl < 1e-9) return;
  vx /= vl;
  vy /= vl;
  vz /= vl;
  voteMask.fill(0);
  voteSum.fill(0);
  voteCnt.fill(0);
  const f = fit.f;
  const nb = pr.balls.length;
  for (let m = 0; m < nb; m++) {
    if (m === cueIdx || m === j) continue;
    const bm = pr.balls[m]!;
    const wx = bm.x - cue.x;
    const wy = bm.y - cue.y;
    const qx = R0[0]! * wx + R0[1]! * wy;
    const qy = R0[3]! * wx + R0[4]! * wy;
    const qz = R0[6]! * wx + R0[7]! * wy;
    const qv = qx * vx + qy * vy + qz * vz;
    let e1x = qx - qv * vx;
    let e1y = qy - qv * vy;
    let e1z = qz - qv * vz;
    const rho = hyp3(e1x, e1y, e1z);
    if (rho < 1e-4) continue;
    e1x /= rho;
    e1y /= rho;
    e1z /= rho;
    const e2x = vy * e1z - vz * e1y;
    const e2y = vz * e1x - vx * e1z;
    const e2z = vx * e1y - vy * e1x;
    const ox = Pc[0] + qv * vx;
    const oy = Pc[1] + qv * vy;
    const oz = Pc[2] + qv * vz;
    const ov = ox * vx + oy * vy + oz * vz;
    for (let k = 0; k < rays.n && k < 31; k++) {
      if (k === skip0 || k === skip1 || pr.cc[m * pr.nCands + rays.idx[k]!]! >= 3) continue;
      const ax = rays.ax[k]!;
      const ay = rays.ay[k]!;
      const az = rays.az[k]!;
      const av = ax * vx + ay * vy + az * vz;
      if (Math.abs(av) < 0.05) continue;
      const sd = ov / av;
      if (!(sd > 0.05)) continue;
      const dx = sd * ax - ox;
      const dy = sd * ay - oy;
      const dz = sd * az - oz;
      const d1 = dx * e1x + dy * e1y + dz * e1z;
      const d2 = dx * e2x + dy * e2y + dz * e2z;
      if ((Math.abs(hyp2(d1, d2) - rho) * f) / sd > 0.5 * rays.r[k]! + 4) continue;
      const th = Math.atan2(d2, d1);
      const b = Math.floor(th / THETA_STEP + THETA_BINS / 2);
      if (b < 0 || b >= THETA_BINS) continue;
      voteMask[b] = voteMask[b]! | (1 << k);
      voteSum[b] = voteSum[b]! + th;
      voteCnt[b] = voteCnt[b]! + 1;
    }
  }
  let bestB = -1;
  let bestVotes = 1;
  for (let b = 0; b < THETA_BINS; b++) {
    const votes = popcount(voteMask[b]! | (b > 0 ? voteMask[b - 1]! : 0) | (b < THETA_BINS - 1 ? voteMask[b + 1]! : 0));
    if (votes > bestVotes) {
      bestVotes = votes;
      bestB = b;
    }
  }
  if (bestB < 0) return;
  let sum = 0;
  let cnt = 0;
  for (let b = Math.max(0, bestB - 1); b <= Math.min(THETA_BINS - 1, bestB + 1); b++) {
    sum += voteSum[b]!;
    cnt += voteCnt[b]!;
  }
  const th = sum / cnt;
  if (Math.abs(th) < THETA_STEP) return; // the level member already is this pose
  const R = mulM3(rodrigues(th * vx, th * vy, th * vz), R0);
  if (Math.abs(Math.asin(Math.max(-1, Math.min(1, R[2]!)))) > ROLL_MAX) return;
  const C = {
    x: cue.x - (R[0]! * Pc[0] + R[3]! * Pc[1] + R[6]! * Pc[2]),
    y: cue.y - (R[1]! * Pc[0] + R[4]! * Pc[1] + R[7]! * Pc[2]),
    z: cue.z - (R[2]! * Pc[0] + R[5]! * Pc[1] + R[8]! * Pc[2]),
  };
  if (C.z < 0.015 || C.z > 2.5) return;
  out.push({ R, C, f });
}

// ---------------------------------------------------------------------------------------------------
// Estimator
// ---------------------------------------------------------------------------------------------------

function fail(reason: string, t0: number, pose: CameraPose | null = null, extra: Partial<PlayerViewResult> = {}): PlayerViewResult {
  return { ok: false, pose, confidence: 0, residualPx: Infinity, matched: [], reason, ms: performance.now() - t0, ...extra };
}

/**
 * A photo too dark to read: mean V below DARK_MEAN_V, or more than DARK_SHARE of it nearly black, or
 * a cloth dimmer than DIM_CLOTH_V. ASSUMPTION (synthetic renders, research R-13 lighting): a lit
 * table-level photo has mean V ≈ 0.25–0.5 even with a dark room above the far rail (≈ 40–55 % of
 * the frame at V ≈ 0.13), and cloth V ≈ 0.3–0.55; the ×0.15 exposure test frame has mean V ≈ 0.06.
 */
const DARK_MEAN_V = 0.12;
const DARK_SHARE = 0.8;
const DIM_CLOTH_V = 0.15;
/**
 * Smallest main cloth region (share of the frame) worth fitting. ASSUMPTION: from 8 cm above the bed
 * and 1.2 m behind the cue ball with a 100° lens the cloth is still ≈ 2.5 % of the frame.
 */
const MIN_CLOTH_AREA = 0.01;
/**
 * "I can't see enough balls" means what it says: the photo holds fewer than this many ball circles
 * (the cue ball and two others, R-25). With more circles a failed fit is "couldn't line up" (or "can't
 * find the cue ball"), however few balls the failed pose matched.
 */
const MIN_BALL_CIRCLES = 3;
/**
 * Colour cost (colourCost units: (hue difference / 14°)², 4 = another class) every ball of a
 * near-minimal fit must stay within: ≤ 1 is a hue within 14° of the overview colour, while neighbouring
 * pool colours (yellow / orange, red / maroon) differ by ≈ 20–25°.
 */
const MINIMAL_COLOUR_COST = 1;
/**
 * A pose is supported by the static scene when it explains this share of the cloth boundary, or puts
 * this share of it on the cushion edges (within 2 px). ASSUMPTION (synthetic renders): a right pose puts
 * 25–40 % of the cracks on the cushions in a view that shows them, a wrong one (mirrored layout, wrong
 * roll) 2–5 %.
 */
const SOLID_EXPLAINED = 0.5;
/** Where a player photo is taken from (spec 002 Assumptions, with margin): horizontal distance and height (m). */
const PLAUSIBLE_CAMERA_DIST = 2;
const PLAUSIBLE_CAMERA_HEIGHT = 0.8;
const SOLID_EDGES = 0.2;
/**
 * Lens sweep for the focal hypotheses, as multiples of the 65° default: 0.446 · 1.1^i for i < 20, i.e.
 * HFOV ≈ 110° (0.5× ultra-wide) … 26° (3× tele) in ≈ 10 % steps. The overview's focal length (a soft
 * hint: the player may switch lens between the photos) adds three guesses around it.
 */
const LENS_SWEEP = Array.from({ length: 20 }, (_, i) => 0.446 * 1.1 ** i);

interface Attempt {
  res: PlayerViewResult;
  /** Evaluation quality of the best fit (−∞ when no fit was made). */
  quality: number;
  /** Ball circles found on this cloth. */
  circles: number;
  /** The fit explains the photo cleanly (convincing): no other hypothesis can beat it in a way that matters. */
  clean?: boolean;
}

/**
 * A fit that explains everything cleanly: nothing predicted on bare cloth, sub-pixel residual, most of the
 * cloth boundary explained and no stray circle (with five or more balls matched, a couple of stray arcs
 * in a packed rack do not change that).
 */
function convincing(e: Evaluation): boolean {
  return e.missing === 0 && e.residualPx < 1 && e.explainedFrac > 0.6 && ((e.unexplained === 0 && e.matched.length >= 3) || (e.unexplained <= 2 && e.matched.length >= 5));
}

export function estimatePlayerView(input: PlayerViewInput): PlayerViewResult {
  const t0 = performance.now();
  const { frame, balls, cueId, targetId, manualTaps } = input;
  const w = frame.width;
  const h = frame.height;
  const cues = balls.filter((b) => b.isCue);
  if (!(w > 0 && h > 0) || frame.data.length < w * h * 4 || cues.length !== 1 || cues[0]!.id !== cueId) return fail(PLAYER_VIEW_REASONS.noFit, t0);
  if (manualTaps && (!targetId || !balls.some((b) => b.id === targetId && !b.isCue))) return fail(PLAYER_VIEW_REASONS.noFit, t0);

  // 1. Cloth candidates (chromatic or grey), most plausible first; each is tried until one fits.
  const sc = getScratch(w, h);
  const photo = learnPlayerCloth(frame, input.clothHint, sc);
  const dark = photo.meanV < DARK_MEAN_V || photo.darkFrac > DARK_SHARE;
  if (!photo.models.length) return fail(dark ? PLAYER_VIEW_REASONS.dark : PLAYER_VIEW_REASONS.noCloth, t0);
  let best: Attempt | null = null;
  let circles = 0;
  // What each cloth candidate's evidence showed (its main region and the noise specks in it).
  const seen: Seen = { mainArea: 0, grain: 0 };
  // The least noise damage of any candidate surface that kept a cloth region (see NOISY_SPECKS).
  let anyCloth = false;
  let minGrain = Infinity;
  const budget: Budget = { refines: REFINE_BUDGET };
  const better = (a: Attempt, b: Attempt | null) => !b || (a.res.ok && !b.res.ok) || (a.res.ok === b.res.ok && a.quality > b.quality);
  // Pass 1: each cloth candidate with its whitest circle as the cue ball, then the next white circle
  // (one seed), until one fits. A failure with balls matched on this cloth does not prove the cloth
  // right: under sensor noise the next candidate (a neighbouring hue or value mode) often holds the cue
  // ball or a cleaner crack set and fits, and the grey of the room can outrank a grey cloth seen as a
  // thin band from 10 cm up. The candidate whose failed fit matched the most balls is kept for pass 2.
  let kept: Prepared | null = null;
  let keptAt: Attempt | null = null;
  for (let k = 0; k < photo.models.length && !best?.res.ok; k++) {
    // A further candidate is tried only when it is a plausible cloth next to the first (≥ ¼ of its
    // structure score) or the first is no convincing cloth (fewer than two ball holes), and while the
    // photo's work budget lasts.
    if (k > 0 && photo.scores[k]! < 0.25 * photo.scores[0]! && photo.scores[0]! >= 2) break;
    if (k > 0 && budget.refines <= 0) break;
    // The kept candidate's mask is about to be overwritten by this one's evidence: keep a copy.
    if (kept && kept.ctx.pr.mask === sc.mask) {
      sc.maskKept.set(sc.mask);
      kept.ctx.pr.mask = sc.maskKept;
    }
    const prep = prepareCloth(input, photo.models[k]!, sc, t0, seen, budget);
    let at: Attempt;
    if ('res' in prep) at = prep;
    else {
      at = solveFrom(prep.ctx, prep.groups[0]!);
      // A stripe ball whose coloured band is lost in the cloth (green on green, maroon on blue-grey) shows
      // only its white band and can rank as the whitest circle: its wrong pose can pass as ok (3 balls,
      // half the cloth boundary explained) while the true cue ball explains the photo cleanly, or fail —
      // even as "moved" — where the true cue ball fits within 0.1 cm. So the next cue-ball candidate is
      // tried unless the fit is ok and convincing; its best seed decides (an ok fit needs one).
      if (!(at.res.ok && at.clean) && prep.groups.length > 1 && budget.refines > 0) {
        const at2 = solveFrom(prep.ctx, prep.groups[1]!, prep.ctx.cueIdx, 1);
        if (at2.res.ok ? better(at2, at) : !at.res.ok && at.res.reason !== PLAYER_VIEW_REASONS.moved && (at2.res.reason === PLAYER_VIEW_REASONS.moved || better(at2, at))) at = at2;
      }
      const nm = at.res.matched.length;
      if (!at.res.ok && at.quality > -Infinity && (!keptAt || nm > keptAt.res.matched.length || (nm === keptAt.res.matched.length && at.quality > keptAt.quality))) {
        kept = prep;
        keptAt = at;
      }
    }
    circles = Math.max(circles, at.circles);
    if (seen.mainArea >= MIN_CLOTH_AREA * w * h) {
      anyCloth = true;
      minGrain = Math.min(minGrain, seen.grain);
    }
    if (better(at, best)) best = at;
  }
  // Pass 2, on the candidate kept: is it a moved cue ball? The cue-ball circle then pulls every
  // hypothesis off (the layout's cue ball is put on the photo's, 12 cm away), so the pose is sought from
  // another ball instead, one whose colour identifies it uniquely (up to ALT_ANCHORS of the largest).
  // Such a pose is used when it also finds the cue ball, or when it shows the balls moved. It runs after
  // a "moved" from pass 1 too, where only a fit can overturn that verdict: a cue-anchored pose that
  // missed the true one (two blue stripes showing only white on a blue cloth) can show the moved-ball
  // signature, and a ball of unique colour then anchors the pose that explains the photo.
  if (!best!.res.ok && kept && !manualTaps) {
    const movedAlready = best!.res.reason === PLAYER_VIEW_REASONS.moved;
    const at = anchorOnOthers(kept);
    if (at && (at.res.ok || (!movedAlready && at.res.reason === PLAYER_VIEW_REASONS.moved))) best = at;
  }
  const res = best!.res;
  // Honest reasons (Principle II): a failure on a dark photo is about the light. A grainy photo — one
  // whose noise broke every candidate cloth surface into specks, at the level where fits fail, or left
  // no cloth region at all — is about the grain (spec 002: "low light or a noisy photo … suggests more
  // light or a steadier phone"), whatever else the damaged detection then hit, unless the balls moved.
  // When some candidate surface is still intact the noise is not the cause and the reason is the fit's
  // own: the cue ball out of frame stays "can't find the cue ball" at σ 5–7 (the green cloth keeps ≈ 1–5
  // specks per 1000 px; only the dark room behind it breaks up), and cloth texture is never grain. Then
  // a dim cloth is about the light; a lit photo whose surfaces enclose nothing at all (no ball, no
  // pocket) and hold no ball circle shows no table; and a cloth whose region encloses holes is a table
  // even when a candidate's own region came out too small to fit: then too few balls, or no fit.
  const grainy = anyCloth ? minGrain >= NOISY_SPECKS : clothNoise(frame, sc, true) >= NOISY_SIGMA;
  if (!res.ok && dark) res.reason = PLAYER_VIEW_REASONS.dark;
  else if (!res.ok && grainy && res.reason !== PLAYER_VIEW_REASONS.moved) res.reason = PLAYER_VIEW_REASONS.noisy;
  else if (!res.ok && photo.models[0]!.val < DIM_CLOTH_V) res.reason = PLAYER_VIEW_REASONS.dark;
  else if (!res.ok && circles < 2 && photo.enclosed.every((n) => n === 0)) res.reason = PLAYER_VIEW_REASONS.noCloth;
  else if (!res.ok && res.reason === PLAYER_VIEW_REASONS.noCloth) res.reason = circles < MIN_BALL_CIRCLES ? PLAYER_VIEW_REASONS.tooFewBalls : PLAYER_VIEW_REASONS.noFit;
  res.ms = performance.now() - t0;
  return res;
}

/** What prepareCloth saw of its cloth: main region area (px) and noise specks per 1000 px of it. */
interface Seen {
  mainArea: number;
  grain: number;
}

/**
 * Mask damage at which sensor noise defeats the fit: noise specks (non-cloth specks under SPECK_AREA
 * inside the cloth, joined back to it) per 1000 px of the main cloth region. It measures the noise
 * against the cloth's own colour band, so it holds for every cloth: in a sweep of 4 cloths × 7 noise
 * levels (σ 0–20), fits succeeded on 40/40 green and 48/48 light-blue photos below 60 and on none above
 * (0/11, 0/8); a blue-grey cloth, whose band is narrow, reaches 100 already at σ 3, where its fits fail
 * (1/8). Cloth texture and shading leave none (≤ 2.5).
 */
const NOISY_SPECKS = 60;
/**
 * When no candidate kept a cloth region at all, chroma noise (σ, 0–255, clothNoise over the frame) at
 * or above this is the cause: a smooth render reads σ ≈ 0.3, cloth texture 0.3, and σ ≥ 10 dissolves
 * even a tinted grey cloth's region.
 */
const NOISY_SIGMA = 4.5;

/**
 * The work one photo may take, counted (so the result stays deterministic), not timed: refined pose
 * seeds over all cloth candidates, cue-ball candidates and anchors. A photo that fits needs 1 (95 % of
 * the fits in a random envelope sweep of 154 runs, at most 8); a photo that fails refined up to 24,
 * which took it to 450–630 ms CPU (the budget is 250 ms at 960 × 720). The attempts are tried most
 * likely first, so the budget cuts the least likely ones: pass 1 tries each cloth candidate with its
 * whitest circle as the cue ball (SEEDS_FIRST seeds for the photo's first solve, SEEDS_LATER after) —
 * every ok fit of that sweep but two came from such an attempt — then with the next white circle (one
 * seed); pass 2 tries the anchors that tell a moved cue ball (one seed each), on the one candidate
 * whose failed fit matched the most balls.
 */
interface Budget {
  refines: number;
}
const REFINE_BUDGET = 10;
const SEEDS_FIRST = 4;
const SEEDS_LATER = 2;

/** A cloth candidate ready to fit: its evidence (in the solve context) and the cue-ball observation groups to try in turn. */
interface Prepared {
  ctx: SolveCtx;
  groups: Obs[][];
}

/** Steps 2–3 with one cloth model: evidence, circles and cue-ball candidates (or the failure that ends it early). */
function prepareCloth(input: PlayerViewInput, cloth: ClothModel, sc: Scratch, t0: number, seen: Seen, budget: Budget): Prepared | Attempt {
  const { frame, table, balls, targetId, manualTaps } = input;
  const w = frame.width;
  const h = frame.height;
  const Rb = table.ballRadius;
  const diag = hyp2(w, h);
  const cx = w / 2;
  const cy = h / 2;
  const fDefault = w / 2 / Math.tan((PLAYER_VIEW_DEFAULT_HFOV * Math.PI) / 360);
  const fHint = input.focalPx && input.focalPx > 0 ? input.focalPx : 0;
  const f0 = fHint || fDefault;
  let nCircles = 0;
  const noFit = (reason: string): Attempt => ({ res: fail(reason, t0), quality: -Infinity, circles: nCircles });

  // 2. Evidence: the main cloth region, its boundary cracks and the ball circles on it.
  const ev = buildEvidence(frame, cloth, sc);
  seen.mainArea = ev.mainArea;
  seen.grain = ev.mainArea > 0 ? (1000 * ev.specks) / ev.mainArea : 0;
  if (ev.mainArea < MIN_CLOTH_AREA * w * h) return noFit(PLAYER_VIEW_REASONS.noCloth);
  const info = { exposure: 1 };
  const cands = findCandidates(frame, sc, ev.comps, ev.nCracks, { info });
  const vScale = info.exposure;
  nCircles = cands.length;
  const px = sc.crackX.slice(0, ev.nCracks);
  const py = sc.crackY.slice(0, ev.nCracks);

  const known = balls;
  const cueIdx = known.findIndex((b) => b.isCue);
  const pr: Problem = {
    w,
    h,
    cx,
    cy,
    Rb,
    balls: known.map((b) => ({ x: b.pos.x, y: b.pos.y, z: Rb })),
    segs: edgeSegments(table),
    resCache: new Float64Array((known.length + 6) * 4),
    resHave: new Uint8Array(known.length + 6),
    px,
    py,
    nPts: ev.nCracks,
    logf0: Math.log(f0),
    sigLogF: fHint ? 0.1 : 0.5,
    robustF: fHint > 0,
    sigRoll: ((manualTaps ? 5 : 10) * Math.PI) / 180,
    taps: [],
    mask: sc.mask,
    frame,
    cushionZ: table.cushionHeight,
    cls: known.map((b) => ballClass(b.rgb)),
    cueIdx,
    vScale,
    cc: new Float64Array(0),
    nCands: cands.length,
    camo: Uint8Array.from(known.map((b) => (b.rgb && camouflaged(b.rgb, cloth) ? 1 : 0))),
    halfL: table.length / 2 - Rb,
    halfW: table.width / 2 - Rb,
    untinted: cloth.kind === 'neutral' && cloth.sat < UNTINTED_SAT,
    pockets: table.pockets.map((p) => {
      const mouth = p.kind === 'corner' ? table.cornerMouth : table.sideMouth;
      return { x: p.mouthCenter.x - p.inward.x * 0.5 * mouth, y: p.mouthCenter.y - p.inward.y * 0.5 * mouth, r: 0.9 * mouth + 0.02 };
    }),
  };
  pr.cc = new Float64Array(known.length * cands.length);
  for (let k = 0; k < known.length; k++) for (let j = 0; j < cands.length; j++) pr.cc[k * cands.length + j] = colourCost(pr.cls[k]!, cands[j]!.col);
  const cueW = { x: known[cueIdx]!.pos.x, y: known[cueIdx]!.pos.y, z: Rb };
  const targetIdx = targetId ? known.findIndex((b) => b.id === targetId) : -1;
  const s = Math.max(w, h) / 1000;
  const gates = [24 * s, 12 * s, 6 * s, 3.5 * s].map((g) => Math.max(3, g));

  // 3. Cue-ball candidates (whitest circles) or the tapped circles.
  const nearestCand = (p: Vec2): number => {
    let best = -1;
    let bd = Infinity;
    for (let j = 0; j < cands.length; j++) {
      const c = cands[j]!;
      const d = hyp2(c.u - p.x, c.v - p.y);
      if (d < 1.25 * c.r + 0.01 * diag && d / c.r < bd) {
        bd = d / c.r;
        best = j;
      }
    }
    return best;
  };
  const cueObs: Obs[] = [];
  let pairList: { obs: Obs; k: number }[] = [];
  // Focal guesses: the lens sweep, plus the overview's focal length ±5 % when given.
  const fMuls = fHint ? [...LENS_SWEEP.map((m) => (m * fDefault) / fHint), 0.95, 1, 1.05] : LENS_SWEEP;
  if (manualTaps) {
    const jc = nearestCand(manualTaps.cue);
    const jt = nearestCand(manualTaps.target);
    if (jc >= 0) cueObs.push(cands[jc]!);
    else for (const D of [0.35, 0.5, 0.7, 1.0, 1.4]) cueObs.push({ u: manualTaps.cue.x, v: manualTaps.cue.y, r: f0 * Math.tan(Math.asin(Rb / D)) });
    pairList = [{ obs: jt >= 0 ? cands[jt]! : { u: manualTaps.target.x, v: manualTaps.target.y, r: NaN }, k: targetIdx }];
    const sigTap = 0.008 * diag;
    pr.taps = [
      { ball: cueIdx, x: manualTaps.cue.x, y: manualTaps.cue.y, sigma: sigTap },
      { ball: targetIdx, x: manualTaps.target.x, y: manualTaps.target.y, sigma: sigTap },
    ];
    pr.height = { mu: 0.2, sigma: 0.15 };
  } else {
    const whites = cands
      .map((c, j) => ({ j, c }))
      .filter(({ c }) => c.white > 0.15 && colourCost(pr.cls[cueIdx]!, c.col) < 3)
      .sort((a, b) => b.c.white + 0.25 * Math.min(1, b.c.r / 40) - (a.c.white + 0.25 * Math.min(1, a.c.r / 40)));
    if (!whites.length) return noFit(cands.length < MIN_BALL_CIRCLES ? PLAYER_VIEW_REASONS.tooFewBalls : PLAYER_VIEW_REASONS.noCue);
    for (const { c } of whites.slice(0, 2)) cueObs.push(c);
  }

  // 4–6 run per cue-ball candidate (whitest first) in solveFrom.
  const ctx: SolveCtx = { input, pr, cands, known, cueIdx, cueW, targetIdx, gates, fMuls, f0, w, h, cx, cy, Rb, diag, pairList, noFit, t0, budget };
  return { ctx, groups: manualTaps ? [cueObs] : cueObs.map((c) => [c]) };
}

/**
 * Pass 2 on a cloth candidate whose cue-ball fits failed: the anchors on balls of unique colour (a moved
 * cue ball), one seed each, within the budget. The first that fits or shows the balls moved, else null.
 */
function anchorOnOthers(prep: Prepared): Attempt | null {
  const { ctx } = prep;
  const { pr, cands, known, cueIdx, budget } = ctx;
  const anchors: { j: number; k: number }[] = [];
  for (let j = 0; j < cands.length; j++) {
    if (cands[j]!.r < 4) continue;
    let kk = -1;
    let n = 0;
    for (let k = 0; k < known.length; k++)
      if (k !== cueIdx && !pr.camo[k] && pr.cc[k * cands.length + j]! <= MINIMAL_COLOUR_COST) {
        kk = k;
        n++;
      }
    if (n === 1 && pr.cc[cueIdx * cands.length + j]! >= 3) anchors.push({ j, k: kk });
  }
  anchors.sort((a, b) => cands[b.j]!.r - cands[a.j]!.r);
  for (const { j, k } of anchors.slice(0, ALT_ANCHORS)) {
    if (budget.refines <= 0) break;
    const at = solveFrom(ctx, [cands[j]!], k, 1);
    if (at.res.ok || at.res.reason === PLAYER_VIEW_REASONS.moved) return at;
  }
  return null;
}

/** Other-ball anchors tried when the cue-ball fit fails (anchorOnOthers). */
const ALT_ANCHORS = 2;
/** Hypotheses kept for seeding a solve (solveFrom): far more than the ≤ 4 diverse seeds it takes. */
const TOP_HYPS = 64;

type Obs = { u: number; v: number; r: number };

interface SolveCtx {
  input: PlayerViewInput;
  pr: Problem;
  cands: Candidate[];
  known: KnownBall[];
  cueIdx: number;
  cueW: Vec3;
  targetIdx: number;
  gates: number[];
  fMuls: number[];
  f0: number;
  w: number;
  h: number;
  cx: number;
  cy: number;
  Rb: number;
  diag: number;
  pairList: { obs: Obs; k: number }[];
  noFit: (reason: string) => Attempt;
  t0: number;
  /** The photo's work budget (shared by every attempt). */
  budget: Budget;
}

/** Steps 4–6 from one set of cue-ball observations: hypotheses, refinement, confidence and reason. */
function solveFrom(ctx: SolveCtx, cueObs: Obs[], anchor = ctx.cueIdx, maxSeeds = SEEDS_FIRST): Attempt {
  const { input, pr, cands, known, cueIdx, cueW, targetIdx, gates, fMuls, f0, w, h, cx, cy, Rb, diag, pairList, noFit, t0 } = ctx;
  const { manualTaps } = input;
  // The anchor ball whose circle fixes the first ball in camera coordinates: the cue ball, or (to tell a
  // moved cue ball from a failed fit) another ball of unique colour.
  const alt = anchor !== cueIdx;
  const aW = { x: known[anchor]!.pos.x, y: known[anchor]!.pos.y, z: Rb };
  // 4. Hypotheses: cue circle + one more (circle, ball) pair → level pose and its roll completion,
  //    for each focal guess.
  const nb = known.length;
  const proj: Projected = { u: new Float64Array(nb), v: new Float64Array(nb), r: new Float64Array(nb), d: new Float64Array(nb), vis: new Uint8Array(nb) };
  const ss = scoreScratch(nb, cands.length);
  // The best TOP_HYPS hypotheses, by score (descending; ties keep the order found, as a stable sort of all
  // of them would): seeds only ever come from the top, and keeping thousands alive until a sort cost a
  // photo with many reds more in garbage collection than in scoring.
  const hyps: Hyp[] = [];
  const offer = (fit: Fit, score: number) => {
    if (hyps.length === TOP_HYPS && !(score > hyps[TOP_HYPS - 1]!.score)) return;
    let at = hyps.length;
    while (at > 0 && hyps[at - 1]!.score < score) at--;
    hyps.splice(at, 0, { fit, score });
    if (hyps.length > TOP_HYPS) hyps.pop();
  };
  const tmp: Fit[] = [];
  // The 16 largest circles, each paired with every colour-compatible known ball.
  const bigCands = [...cands].sort((a, b) => b.r - a.r).slice(0, 16);
  const rays: Rays = { idx: Int32Array.from(bigCands.map((c) => cands.indexOf(c))), ax: new Float64Array(16), ay: new Float64Array(16), az: new Float64Array(16), r: new Float64Array(16), n: bigCands.length };
  for (const co of cueObs) {
    const coIdx = bigCands.indexOf(co as Candidate);
    const pairs = manualTaps
      ? pairList.map((p) => ({ ...p, ci: bigCands.indexOf(p.obs as Candidate) }))
      : bigCands.flatMap((c, ci) => (c === co ? [] : known.map((_, k) => ({ obs: c as Obs, k, ci })).filter(({ k }) => k !== anchor && colourCost(pr.cls[k]!, c.col) < 3)));
    for (const fm of fMuls) {
      const f = f0 * fm;
      const cr = ballRay(co, f, cx, cy, Rb);
      if (!Number.isFinite(cr.D)) continue;
      const Pc: [number, number, number] = [cr.a[0] * cr.D, cr.a[1] * cr.D, cr.a[2] * cr.D];
      for (let q = 0; q < bigCands.length; q++) {
        const rq = ballRay(bigCands[q]!, f, cx, cy, Rb);
        rays.ax[q] = rq.a[0];
        rays.ay[q] = rq.a[1];
        rays.az[q] = rq.a[2];
        rays.r[q] = bigCands[q]!.r;
      }
      for (const pp of pairs) {
        const rj = ballRay(pp.obs, f, cx, cy, Rb);
        tmp.length = 0;
        poseFromPair(aW, Pc, rj.a, rj.D, { x: known[pp.k]!.pos.x, y: known[pp.k]!.pos.y, z: Rb }, tmp, f);
        const nLevel = tmp.length;
        for (let q = 0; q < nLevel; q++) rollCompletion(pr, tmp[q]!, Pc, anchor, pp.k, coIdx, pp.ci, rays, tmp);
        for (const fit of tmp) {
          let score = scorePose(pr, fit, known, cands, proj, ss);
          if (manualTaps) score -= 0.5 * ((fit.C.z - 0.2) / 0.15) ** 2;
          offer(fit, score);
        }
      }
    }
  }
  // No pose at all from the cue-ball candidates: in automatic mode the white circles were not the cue ball.
  if (!hyps.length) return noFit(cands.length < MIN_BALL_CIRCLES ? PLAYER_VIEW_REASONS.tooFewBalls : manualTaps ? PLAYER_VIEW_REASONS.noFit : PLAYER_VIEW_REASONS.noCue);
  const seeds: Hyp[] = [];
  // The photo's first solve may refine SEEDS_FIRST seeds, later ones SEEDS_LATER (or `maxSeeds`, fewer),
  // within the budget (each solve refines at least its best seed).
  const nSeeds = Math.max(1, Math.min(manualTaps ? 3 : ctx.budget.refines >= REFINE_BUDGET ? SEEDS_FIRST : SEEDS_LATER, maxSeeds, ctx.budget.refines));
  for (const hy of hyps) {
    if (seeds.length >= nSeeds) break;
    if (seeds.every((sd) => poseDistance(sd.fit, hy.fit) > 1.5)) seeds.push(hy);
  }

  // 5. Refine the best seeds; keep the one that explains the photo best.
  let best: { r: Refined; ev: Evaluation } | null = null;
  for (const sd of seeds) {
    ctx.budget.refines--;
    const r = refine(pr, sd.fit, gates);
    const e = evaluate(pr, r, cands);
    if (!best || e.quality > best.ev.quality + 1e-9) best = { r, ev: e };
    // A seed that explains everything cleanly cannot be beaten in a way that matters: stop early. With
    // five or more balls matched, a couple of stray circles (arcs in a packed rack) do not change that.
    if (convincing(best.ev)) break;
  }
  const { r: fitR, ev: fe } = best!;
  const fit = fitR.fit;
  const pose = toPose(fit, w, h);

  // 6. Confidence: matched balls × residual × propagated uncertainty of the target's image position.
  const focus = targetIdx >= 0 ? targetIdx : fe.matched.length ? fe.matched[fe.matched.length - 1]!.k : cueIdx;
  let sigmaPx = Infinity;
  if (fitR.lm.A) {
    const np = 7;
    const inv = new Float64Array(np * np);
    let okInv = true;
    for (let c = 0; c < np && okInv; c++) {
      const e = new Float64Array(np);
      e[c] = 1;
      const col = solveN(fitR.lm.A.slice(), e, np);
      if (!col) okInv = false;
      else for (let r = 0; r < np; r++) inv[r * np + c] = col[r]!;
    }
    if (okInv) {
      const at = (p: Float64Array) => {
        const R = mulM3(rodrigues(p[0]!, p[1]!, p[2]!), fit.R);
        const [X, Y, Z] = cameraToWorldC(R, { x: fit.C.x + p[3]!, y: fit.C.y + p[4]!, z: fit.C.z + p[5]! }, pr.balls[focus]!);
        const im = sphereImage(X, Y, Z, Rb, fit.f * Math.exp(p[6]!), cx, cy);
        return im ? [im.u, im.v] : [NaN, NaN];
      };
      const base = at(new Float64Array(7));
      const Jt = new Float64Array(2 * np);
      for (let j = 0; j < np; j++) {
        const p = new Float64Array(7);
        p[j] = 1e-6;
        const q = at(p);
        Jt[j] = (q[0]! - base[0]!) / 1e-6;
        Jt[np + j] = (q[1]! - base[1]!) / 1e-6;
      }
      let tr = 0;
      for (let row = 0; row < 2; row++)
        for (let a = 0; a < np; a++) for (let b = 0; b < np; b++) tr += Jt[row * np + a]! * inv[a * np + b]! * Jt[row * np + b]!;
      sigmaPx = Math.sqrt(Math.max(0, tr * fitR.lm.s2));
    }
  }
  // The layout itself is uncertain (the overview places balls within ≈ 1 cm, 001 SC-003). With the
  // cushions out of the fit and only a few balls, the pose leans on those few positions: the target's
  // image position is propagated from LAYOUT_SIGMA per coordinate of each matched ball, by refitting
  // with that ball moved by a small step (the response is linear there; a full 5 mm step would push the
  // near cue ball's silhouette 20 px off, past the Cauchy scale, and measure its rejection instead).
  // Many balls or crossing cushion lines (a side and an end cushion) make the pose insensitive to one
  // ball; three close balls do not, nor does a single cushion line: from 7 cm up with a 96° lens, three
  // balls and the far cushion fitted a camera 35 cm off at twice the focal length within 1 px (ghost 7 %),
  // and only this propagation shows how little pins it (σ 9 px of the target, against 0.3 px from the
  // residuals alone). With the two taps the player names the balls and the fallback must draw (FR-118,
  // confidence capped): there a cushion line is enough, as before.
  if (Number.isFinite(sigmaPx) && fe.matched.length <= 4 && (manualTaps ? fe.edgeInliers < 20 : !fe.edgeCrossed)) {
    const sel = selectPoints(pr, fitR.assign, 90, 160);
    const focusAt = (f: Fit) => {
      const [X, Y, Z] = cameraToWorldC(f.R, f.C, pr.balls[focus]!);
      return sphereImage(X, Y, Z, Rb, f.f, cx, cy);
    };
    const base = focusAt(fit);
    let s2 = 0;
    for (const m of fe.matched)
      for (const axis of [0, 1]) {
        const b = pr.balls[m.k]!;
        const keep = axis ? b.y : b.x;
        if (axis) b.y += LAYOUT_STEP;
        else b.x += LAYOUT_STEP;
        const moved = focusAt(levenberg(pr, fit, sel, fitR.assign.elem, 6).fit);
        if (axis) b.y = keep;
        else b.x = keep;
        const k = LAYOUT_SIGMA / LAYOUT_STEP;
        s2 += base && moved ? k * k * ((moved.u - base.u) ** 2 + (moved.v - base.v) ** 2) : Infinity;
      }
    sigmaPx = hyp2(sigmaPx, Math.sqrt(s2));
  }
  const nMatched = fe.matched.length;
  const cueMatched = fe.matched.some((m) => m.k === cueIdx);
  const targetMatched = targetIdx >= 0 && fe.matched.some((m) => m.k === targetIdx);
  const fracFound = nMatched / Math.max(1, nMatched + fe.missing);
  const countTerm = nMatched >= 3 ? 1 : nMatched === 2 ? (fe.edgeInliers >= 20 || manualTaps ? 0.75 : 0.45) : 0;
  // The model (balls + cloth edge) must explain most of the cloth boundary; a pose that lines up a few
  // balls by accident leaves the cushions unexplained.
  const explainedTerm = Math.max(0, Math.min(1, (fe.explainedFrac - 0.3) / 0.3));
  const inlierTerm = countTerm * fracFound * explainedTerm * Math.exp(-0.12 * fe.unexplained);
  const residualLimit = Math.max(4, 0.006 * diag);
  const residualTerm = Math.exp(-((fe.residualPx / (0.004 * diag)) ** 2));
  const uncertaintyTerm = Number.isFinite(sigmaPx) ? Math.exp(-sigmaPx / (0.01 * diag)) : 0;
  let confidence = Math.max(0, Math.min(1, inlierTerm * residualTerm * uncertaintyTerm));
  if (manualTaps && nMatched < 3) confidence = Math.min(confidence, 0.7);
  // Two balls suffice with a cushion edge, or when the player tapped them (R-25: the level-phone and
  // height priors close the 7th degree of freedom; confidence is capped below).
  const tappedBoth = manualTaps !== undefined && cueMatched && targetMatched;
  // A near-minimal fit (three balls, no cushion edge) has almost no redundancy: a wrong identity (an
  // orange ball read as the yellow one) can fit as exactly as the right one. It counts only when every
  // identity is sure and no ball is predicted on bare cloth (Principle II). An identity is sure when the
  // ball's colour in the photo confirms it (within MINIMAL_COLOUR_COST) and no other layout ball that
  // the fit leaves unmatched could show that colour: a snooker red (up to 15), or a pool colour's solid
  // and stripe, is never a sure identity on its own — the same circles fit a permutation of the reds,
  // and a camera 95 cm off fitted two orange balls swapped with a third out of view (ghost 6 %).
  // Two balls and the cushions are enough only when the cushion lines cross (side and end) and the
  // identities are sure, with nothing unexplained: a grazing view of parallel cushion lines let a wrong
  // pose (camera 0.5 m off) explain 70 % of the cloth boundary in the envelope sweep, and "the cue ball
  // and a red" with crossing lines fitted one of six reds out of view (ghost 49 %).
  const minimal = nMatched === 3 && fe.edgeInliers < 20;
  const matchedSet = new Set(fe.matched.map((m) => m.k));
  const uniqueIdentity = (m: Evaluation['matched'][number]): boolean => {
    if (!pr.cls[m.k]) return false;
    for (let j = 0; j < nb; j++) {
      if (j === m.k || matchedSet.has(j) || pr.camo[j]) continue;
      const cost = m.desc ? colourCost(pr.cls[j]!, m.desc) : m.cand >= 0 ? pr.cc[j * pr.nCands + m.cand]! : 0;
      if (cost <= MINIMAL_COLOUR_COST) return false;
    }
    return true;
  };
  const identitiesSure = fe.missing === 0 && fe.matched.every((m) => m.colour <= MINIMAL_COLOUR_COST && uniqueIdentity(m));
  const twoAndCushions = fe.edgeCrossed && fe.explainedFrac >= 0.55 && identitiesSure && fe.unexplained === 0;
  const enoughBalls = (nMatched >= 3 && (!minimal || identitiesSure || tappedBoth)) || (nMatched >= 2 && (twoAndCushions || tappedBoth));
  // Where the camera stood: far from the shooting position behind the cue ball is a warning when ok.
  const camDx = cueW.x - fit.C.x;
  const camDy = cueW.y - fit.C.y;
  const camDh = hyp2(camDx, camDy);
  let offLine = false;
  if (targetIdx >= 0) {
    const tx = known[targetIdx]!.pos.x - cueW.x;
    const ty = known[targetIdx]!.pos.y - cueW.y;
    offLine = (camDx * tx + camDy * ty) / Math.max(1e-9, camDh * hyp2(tx, ty)) < Math.cos((40 * Math.PI) / 180);
  }
  const notBehind = camDh > 2.0 || offLine;
  // A pose anchored on another ball is used only when it finds the cue ball too (its own cue-ball circle
  // may have been missed); otherwise it serves to tell a moved layout from a failed fit.
  let ok = confidence >= 0.5 && fe.residualPx <= residualLimit && enoughBalls && (alt ? cueMatched : cueMatched || targetMatched);
  // The photo is taken from behind the cue ball (spec 002): a pose that says otherwise is the less likely
  // reading of the photo, so it is used only on a convincing fit (nothing on bare cloth, sub-pixel
  // residual, most of the cloth boundary explained, no stray circle). On a grey cloth whose floor-grey
  // candidate swallowed the shaded cloth, a mostly white stripe taken for the cue ball and two orange
  // balls swapped with a third out of view put the camera 95 cm off, 1.6 m from the cue ball, with 54 %
  // of the boundary explained (ghost 6 %); the cue ball is uncertain there (a stripe showing only its
  // white band, any neutral blob on a grey cloth), and so is every identity a repeated colour allows.
  if (ok && notBehind && !manualTaps && !convincing(fe)) ok = false;
  // FR-121: an otherwise good fit whose target or cue ball is not where the layout puts it — predicted in
  // full view on plain cloth — would draw the guide from a stale layout: the balls moved. Unless a circle
  // of its colour nearby is that ball after all, the pose being slightly off (stillFits). Plain cloth is
  // evidence of absence only where the cloth mask tells balls from the cloth: not on an untinted grey
  // cloth, whose own grey a ball's shaded side shares (there it takes a circle of the ball's colour
  // resting elsewhere: 4 of 117 static grey photos said "moved" otherwise).
  // Any other ball with the moved-ball signature contradicts the layout too (FR-121): after a shot, a
  // pose that put the layout's moved cue ball and moved object balls on their new circles passed as ok
  // (guide 2.3–3.7 % off) while a ball it predicted on bare cloth had a circle of its colour resting
  // elsewhere. The pose cannot be trusted, and the layout is stale either way.
  const keyMoved =
    ok &&
    ([targetIdx, cueIdx].some((k) => {
      if (k < 0) return false;
      // Moved along the line of sight: still overlapping its prediction, but off it (overlappedCircles).
      if (!fe.missingIdx.includes(k)) return overlappedCircles(pr, fit, cands, fe, k).some((j) => !stillFits(pr, fitR, k, cands[j]!, true));
      const near = displacedCircles(pr, fit, cands, fe, k);
      if (!near.length) return !pr.untinted;
      return near.some((j) => !stillFits(pr, fitR, k, cands[j]!));
    }) ||
      fe.missingIdx.some((k) => k !== targetIdx && k !== cueIdx && displaced(pr, fitR, cands, fe, k)));
  if (keyMoved) ok = false;
  // On an untinted grey cloth the same evidence cannot say "moved" (above), but it still says the guide is
  // unverified: the ghost ball is drawn next to a target the pose puts on plain cloth. Either the target
  // moved or the pose is off (from 7 cm up, three balls fitted a camera 5 cm off and 8° turned, the
  // target predicted beside its own circle: ghost 2.3 %, confidence 0.68), so the fit is not used and the
  // player is offered the two taps instead (they name the target, so they still draw: FR-118).
  else if (ok && !manualTaps && pr.untinted && targetIdx >= 0 && fe.missingIdx.includes(targetIdx)) ok = false;
  // A fit that is not good enough to use never reports a usable confidence.
  if (!ok) confidence = Math.min(confidence, 0.49);
  const matched = fe.matched.map((m) => ({ id: known[m.k]!.id, image: { x: m.u, y: m.v }, radiusPx: m.r }));

  let reason: string | undefined;
  if (!ok) {
    // "Moved" only from a pose the static scene supports (most of the cloth boundary explained, small
    // residual), and only with the moved-ball signature (displaced): a ball predicted on plain cloth AND
    // a circle of its colour resting elsewhere on the bed with the size of a ball there. Balls missing
    // and circles unexplained are not enough on their own: on an untinted grey cloth the detector leaves
    // both behind on a static table (spurious arcs along the cushion faces, a white ball whose side-lit
    // face has the cloth's grey), and the earlier "missing ≥ 2, or missing and unexplained" rule said
    // "moved" on 2–3 of 117 static grey photos.
    // The fitted camera must also be where a player photo is taken from (spec 002 assumptions: within
    // ≈ 1.5 m of the cue ball, 5–50 cm above the bed): from a few cm up, cushion lines are nearly
    // parallel and a camera metres away can line them up as well.
    const camDist = hyp2(fit.C.x - cueW.x, fit.C.y - cueW.y);
    const plausible = camDist <= PLAUSIBLE_CAMERA_DIST && fit.C.z >= 0.02 && fit.C.z <= PLAUSIBLE_CAMERA_HEIGHT;
    // And the pose must be pinned by balls that did not move: at least three of sure identity (or five in
    // all, a configuration no permutation of repeated colours fits as well), with most of the cloth
    // boundary explained or on the cushions; or three balls of any identity with crossing cushion lines
    // and most of the boundary explained (the cushions pin the pose then, as when the whole layout moved
    // around a cue ball that stayed and three reds happen to sit on the layout's red spots). Two balls
    // and the cushions pass only with nothing unexplained (twoAndCushions); from a few cm up, a pose 40
    // cm off lined two balls and crossing cushion lines up with stray circles left over (charcoal cloth,
    // grey grid); and under blur and 4:2:0, a pose at half the focal length that explained 46 % of the
    // boundary put two of three maroon balls on the wrong circles and called the third "moved".
    const sure = fe.matched.filter((m) => m.colour <= MINIMAL_COLOUR_COST && uniqueIdentity(m)).length;
    const explainedMost = fe.explainedFrac >= SOLID_EXPLAINED;
    const pinned = ((sure >= 3 || nMatched >= 5) && (explainedMost || fe.edgeInliers >= SOLID_EDGES * pr.nPts)) || (nMatched >= 3 && fe.edgeCrossed && explainedMost);
    const solid = plausible && pinned && fe.residualPx <= residualLimit;
    // A ball the static table pins down shows the moved-ball signature (missing, and a circle of its colour
    // resting elsewhere on the bed): e.g. a moved cue ball, seen from a pose anchored on another ball.
    const someDisplaced = solid && (known.some((_, k) => displaced(pr, fitR, cands, fe, k)) || severalDisplaced(pr, fit, cands, fe));
    // Fewer than three ball circles in the whole photo: it shows too few balls, whatever the fit did.
    if (cands.length < MIN_BALL_CIRCLES && nMatched < 3) reason = PLAYER_VIEW_REASONS.tooFewBalls;
    else if (keyMoved || someDisplaced) reason = PLAYER_VIEW_REASONS.moved;
    else if (!cueMatched && !manualTaps) reason = PLAYER_VIEW_REASONS.noCue;
    else reason = PLAYER_VIEW_REASONS.noFit;
  } else if (notBehind) reason = PLAYER_VIEW_REASONS.notBehind;
  return {
    res: { ok, pose, confidence, residualPx: fe.residualPx, matched, ...(reason ? { reason } : {}), ms: performance.now() - t0 },
    quality: fe.quality,
    circles: cands.length,
    clean: convincing(fe),
  };
}
