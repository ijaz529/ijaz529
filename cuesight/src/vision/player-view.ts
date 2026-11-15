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
 *     else (ball silhouettes and the cushion edges), and ball circle candidates fitted to the
 *     cloth-bordered arcs of each non-cloth blob (Kåsa + deterministic RANSAC on compact blobs, local-arc
 *     proposals on large blobs such as the rail band or the room that balls merge into), so balls cut by
 *     the frame edge or overlapping in depth still fit. Each candidate carries a colour descriptor and a
 *     whiteness score.
 *  3. Hypotheses: for each focal guess (a phone-lens sweep, HFOV ≈ 110°…26°, plus the overview's focal
 *     length as a soft hint), the cue-ball circle fixes the cue ball in camera coordinates; pairing any
 *     other circle with any colour-compatible known ball fixes the rotation up to a turn about the line
 *     between them: the level member in closed form, and the rolled member that the remaining circles
 *     vote for (a phone held at an angle). Each hypothesis is scored by the known balls that land, one
 *     per circle, on circles of the right size and colour, the balls predicted on bare cloth, and the
 *     circles left unexplained.
 *  4. Refinement: Levenberg–Marquardt over (rotation, camera centre, log f) on exact residuals — for a
 *     ball, the angle between a crack point's ray and the silhouette cone axis minus the cone half-angle
 *     (so there is no off-axis ellipse bias); for a cushion edge (outer and nose), the angle between the
 *     ray and the plane through the camera and that edge — with ICP-style re-association under a
 *     shrinking gate, Cauchy weights, a focal prior (heavy-tailed around the overview's focal length:
 *     the lens may differ) and a level-phone prior.
 *  5. Honesty (Principle II): confidence from the matched balls, the share of the cloth boundary the
 *     model explains, the residuals and the propagated covariance of the target's image position; `ok`
 *     only when all of them agree, and near-minimal fits only with sure identities. Failures carry the
 *     canonical player-facing reason of their true cause: too dark, no cloth, too few balls, no cue
 *     ball, balls moved (only from a pose the static table supports), or no fit.
 *
 * Conventions: world = table frame (m, z up, ball centres at z = R). Camera X_c = R·X_w + t with rows
 * right, down, forward; pixel (u, v) covers [u, u+1) × [v, v+1), principal point at the image centre.
 */
import type { TableSpec, Vec2, Vec3 } from '../core/types';
import { hueDiff, rgbToHsv, type Frame } from './image';
import { buildEvidence, camouflaged, ColourAcc, exposureScale, findCandidates, getScratch, learnPlayerCloth, solveN, type Candidate, type ColourDesc, type Scratch } from './player-detect';
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
} as const;

/** Default horizontal field of view used as the focal prior when no focalPx is given (degrees). */
export const PLAYER_VIEW_DEFAULT_HFOV = 65;

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
  const d = Math.hypot(P.x, P.y, P.z);
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
  const l1 = Math.hypot(e1x, e1y, e1z);
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
  const L = Math.hypot(aimDir.x, aimDir.y);
  const dx = L > 1e-12 ? aimDir.x / L : 1;
  const dy = L > 1e-12 ? aimDir.y / L : 0;
  let s = side;
  let v = vert;
  const m = Math.hypot(s, v);
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
  const th = Math.hypot(wx, wy, wz);
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
  const d = Math.hypot(Px, Py, Pz);
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

/** Is crack i within `band` px of one of the edge planes `planes` (and within its image extent)? */
function nearSeg(pr: Problem, fit: Fit, planes: (ReturnType<typeof segPlane> | null)[], i: number, band: number): boolean {
  const u = pr.px[i]!;
  const v = pr.py[i]!;
  const mx = (u - pr.cx) / fit.f;
  const my = (v - pr.cy) / fit.f;
  const mn = Math.hypot(mx, my, 1);
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
  /** The photo's exposure relative to nominal (player-detect exposureScale), for colour thresholds. */
  vScale: number;
  /** colourCost of known ball k against circle candidate j, at [k · nCands + j] (filled once per photo). */
  cc: Float64Array;
  nCands: number;
  /** Pocket holes in plan view (x, y, radius): dark round blobs there are not balls. */
  pockets: { x: number; y: number; r: number }[];
}

/** Image bounding boxes (u0, v0, u1, v1) of the pocket holes for `pocketFit` (NaN: not in front). */
const pocketBox = new Float64Array(4 * 8);
let pocketFit: Fit | null = null;

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
      for (let z = 0; z < 2; z++)
        for (let a = 0; a < 8; a++) {
          const th = (a * Math.PI) / 4;
          const [X, Y, Z] = cameraToWorldC(fit.R, fit.C, { x: p.x + p.r * Math.cos(th), y: p.y + p.r * Math.sin(th), z: z ? pr.cushionZ : 0 });
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

/** Colour descriptor of the non-cloth pixels inside 0.7 r of (u, v); null when (almost) all cloth. */
function colourAt(pr: Problem, u: number, v: number, r: number): ColourDesc | null {
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
      tot++;
      const i = y * pr.w + x;
      if (pr.mask[i] === 2) continue;
      acc.add(d[i * 4]!, d[i * 4 + 1]!, d[i * 4 + 2]!);
    }
  if (acc.n < Math.max(3, 0.3 * tot)) return null;
  return acc.desc();
}

/**
 * True when the photo shows plain cloth around (u, v): a predicted ball there is missing. Plain cloth
 * is cloth by the mask and as bright as the cloth beside it (within PLAIN_CLOTH_V): on an untinted grey
 * cloth the mask tells a ball from the cloth by value alone, and the shaded side of a white ball under
 * overhead light (V ≈ 0.34 against the cloth's 0.58 in the renders) falls inside the cloth's value
 * band — the ball is there, unseen, not missing.
 */
function clothAt(pr: Problem, u: number, v: number, r: number): boolean {
  const rr = Math.max(1, 0.5 * r);
  let cloth = 0;
  let tot = 0;
  let vIn = 0;
  for (let q = 0; q < 5; q++) {
    const x = Math.floor(u + rr * RING_DX[q]!);
    const y = Math.floor(v + rr * RING_DY[q]!);
    if (x < 0 || y < 0 || x >= pr.w || y >= pr.h) continue;
    tot++;
    if (pr.mask[y * pr.w + x] !== 2) return false;
    cloth++;
    vIn += pixelV(pr, x, y);
  }
  if (tot < 3 || cloth !== tot) return false;
  // The cloth beside it: four points 2.5 r out, those the mask calls cloth.
  const ro = Math.max(3, 2.5 * r);
  let nOut = 0;
  let vOut = 0;
  for (let q = 1; q < 5; q++) {
    const x = Math.floor(u + ro * RING_DX[q]!);
    const y = Math.floor(v + ro * RING_DY[q]!);
    if (x < 0 || y < 0 || x >= pr.w || y >= pr.h || pr.mask[y * pr.w + x] !== 2) continue;
    nOut++;
    vOut += pixelV(pr, x, y);
  }
  if (nOut < 2) return true;
  const ratio = vIn / tot / Math.max(1e-6, vOut / nOut);
  return ratio > 1 - PLAIN_CLOTH_V && ratio < 1 + PLAIN_CLOTH_V;
}
const RING_DX = [0, 1, -1, 0, 0];
const RING_DY = [0, 0, 0, 1, -1];
/** HSV value (max channel) of a pixel, 0..1. */
function pixelV(pr: Problem, x: number, y: number): number {
  const d = pr.frame.data;
  const i = (y * pr.w + x) * 4;
  return Math.max(d[i]!, d[i + 1]!, d[i + 2]!) / 255;
}
/**
 * Relative brightness difference within which a patch still reads as the cloth beside it. Plain cloth
 * varies by a few % over 2.5 r (lighting gradient, sensor noise σ 4 ≈ 3 % of a mid cloth); a ball's
 * shaded side differs by ≈ 40 %.
 */
const PLAIN_CLOTH_V = 0.2;

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
  const l = Math.hypot(nx, ny, nz);
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
  const bOk = new Uint8Array(nb);
  for (let k = 0; k < nb; k++) {
    const [X, Y, Z] = cameraToWorldC(fit.R, fit.C, balls[k]!);
    const im = sphereImage(X, Y, Z, Rb, f, cx, cy);
    if (!im) continue;
    if (im.u < -2 * im.r - gate || im.u > pr.w + 2 * im.r + gate || im.v < -2 * im.r - gate || im.v > pr.h + 2 * im.r + gate) continue;
    bOk[k] = 1;
    bAx[k] = X / im.d;
    bAy[k] = Y / im.d;
    bAz[k] = Z / im.d;
    bBeta[k] = Math.asin(Rb / im.d);
    bU[k] = im.u;
    bV[k] = im.v;
    const cosA = bAz[k]!;
    bReach[k] = (1.4 * im.r) / Math.max(0.3, cosA) + gate + 2;
  }
  const segs = pr.segs.map((s) => (seenFromOutside(s, fit.C) ? null : segPlane(pr, fit, s)));
  // Cracks along an edge seen from behind its rail are the rail's lip or a ball cut off by it: neither
  // an edge nor a ball silhouette the model can explain, so they are left unassigned.
  const behind = pr.segs.map((s) => (seenFromOutside(s, fit.C) ? segPlane(pr, fit, s) : null));
  const anyBehind = behind.some((p) => p !== null);
  const { elem, res } = out;
  for (let i = 0; i < pr.nPts; i++) {
    if (anyBehind && nearSeg(pr, fit, behind, i, BEHIND_EDGE_BAND)) {
      elem[i] = -1;
      res[i] = 0;
      continue;
    }
    const u = pr.px[i]!;
    const v = pr.py[i]!;
    const mx = (u - cx) / f;
    const my = (v - cy) / f;
    const mn = Math.hypot(mx, my, 1);
    let best = gate;
    let el = -1;
    let r = 0;
    for (let k = 0; k < nb; k++) {
      if (!bOk[k]) continue;
      if (Math.abs(u - bU[k]!) > bReach[k]! || Math.abs(v - bV[k]!) > bReach[k]!) continue;
      const dot = (mx * bAx[k]! + my * bAy[k]! + bAz[k]!) / mn;
      const crx = my * bAz[k]! - bAy[k]!;
      const cry = bAx[k]! - mx * bAz[k]!;
      const crz = mx * bAy[k]! - my * bAx[k]!;
      const sn = Math.hypot(crx, cry, crz) / mn;
      const e = f * (Math.atan2(sn, dot) - bBeta[k]!);
      if (Math.abs(e) < best) {
        best = Math.abs(e);
        el = k;
        r = e;
      }
    }
    for (let s = 0; s < segs.length; s++) {
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
    const mn = Math.hypot(mx, my, 1);
    if (e < nb) {
      if (!have[e]) {
        const [X, Y, Z] = cameraToWorldC(R, C, balls[e]!);
        const d = Math.hypot(X, Y, Z);
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
      const sn = Math.hypot(crx, cry, crz) / mn;
      out[n++] = (f * (Math.atan2(sn, dot) - cache[e * 4 + 3]!)) / SIG_BALL;
    } else {
      if (!have[e]) {
        const s = pr.segs[e - nb]!;
        const [x0, y0, z0] = cameraToWorldC(R, C, { x: s.ax, y: s.ay, z: s.az });
        const [x1, y1, z1] = cameraToWorldC(R, C, { x: s.bx, y: s.by, z: s.bz });
        let nx = y0 * z1 - z0 * y1;
        let ny = z0 * x1 - x0 * z1;
        let nz = x0 * y1 - y0 * x1;
        const l = Math.hypot(nx, ny, nz) || 1;
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
  for (const gate of gates) {
    assign(pr, fit, gate, asg);
    const sel = selectPoints(pr, asg, 90, 160);
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
      if (Math.hypot(du, dv) < t) {
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
    let best = 9;
    for (let j = 0; j < cands.length; j++) {
      const c = cands[j]!;
      const ratio = c.r / rk;
      if (ratio < 0.5 || ratio > 2) continue;
      const e = Math.hypot(c.u - proj.u[k]!, c.v - proj.v[k]!) / (0.35 * rk + 3);
      if (e >= 3) continue;
      const cc = pr.cc[k * pr.nCands + j]!;
      if (cc >= 3) continue;
      const cost = e * e + 0.5 * cc + 2 * Math.log(ratio) ** 2;
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
  for (const c of cands) if (c.r >= 3 && !explained(pr, fit, c, proj)) score -= 0.4;
  return score;
}

function explained(pr: Problem, fit: Fit, c: Candidate, proj: Projected): boolean {
  for (let k = 0; k < proj.vis.length; k++) if (proj.vis[k] && Math.hypot(c.u - proj.u[k]!, c.v - proj.v[k]!) < proj.r[k]! + 0.5 * c.r + 2) return true;
  return onPocket(pr, fit, c.u, c.v, c.r);
}

/** Closed-form level-camera pose from the cue ball (camera frame P_c) and one more ball seen along a_j. */
function poseFromPair(cueW: Vec3, Pc: [number, number, number], aj: [number, number, number], Dj: number, ballW: Vec3, out: Fit[], f: number): void {
  const Ax = ballW.x - cueW.x;
  const Ay = ballW.y - cueW.y;
  const L = Math.hypot(Ax, Ay);
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
    // Prefer roots consistent with the apparent size, but keep both unless clearly wrong.
    if (Number.isFinite(Dj) && (D > 3 * Dj || D < Dj / 3)) continue;
    const vx = D * aj[0] - Pc[0];
    const vy = D * aj[1] - Pc[1];
    const vz = D * aj[2] - Pc[2];
    const hmag = Math.hypot(vy, vz);
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
  const n = Math.hypot(x, y, 1);
  const az = 1 / n;
  // Ellipse centre sits slightly outward of the projected centre: undo to first order.
  const beta = Number.isFinite(c.r) ? Math.atan((c.r * Math.pow(az, 1.5)) / f) : NaN;
  const corr = Number.isFinite(beta) ? 1 - Math.sin(beta) ** 2 / (az * az) : 1;
  const xx = x * corr;
  const yy = y * corr;
  const nn = Math.hypot(xx, yy, 1);
  return { a: [xx / nn, yy / nn, 1 / nn], D: Number.isFinite(beta) ? Rb / Math.sin(beta) : NaN };
}

function poseDistance(a: Fit, b: Fit): number {
  let rot = 0;
  for (let i = 0; i < 9; i++) rot += (a.R[i]! - b.R[i]!) ** 2;
  return Math.hypot(a.C.x - b.C.x, a.C.y - b.C.y, a.C.z - b.C.z) / 0.05 + Math.sqrt(rot) / 0.03 + Math.abs(Math.log(a.f / b.f)) / 0.05;
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
  /** Matched balls, with the colour cost of the photo's pixels against the ball's known colour. */
  matched: { k: number; u: number; v: number; r: number; cov: number; colour: number }[];
  visible: number;
  /** Visible balls predicted where the photo shows plain cloth. */
  missing: number;
  residualPx: number;
  edgeInliers: number;
  /**
   * Cushion lines of both directions carry ≥ EDGE_LINE_SUPPORT inlier cracks (a side and an end
   * cushion): two non-parallel table lines pin the pose; parallel ones (the near and far end, seen at a
   * grazing angle) leave it free to slide.
   */
  edgeCrossed: boolean;
  /** Fraction of the cloth-boundary cracks the model explains (within 2.5 px). */
  explainedFrac: number;
  unexplained: number;
  /** Some circle nothing explains has the cue ball's colour (where a moved cue ball would show). */
  strayCue: boolean;
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
  for (let k = 0; k < nb; k++) {
    if (proj.vis[k] === 1) visible++;
    let bitsCount = 0;
    for (let q = 0; q < 36; q++) bitsCount += covBits[k * 36 + q]!;
    const cov = bitsCount * 10;
    const expected = 1.27 * proj.r[k]! * ((cov * Math.PI) / 180);
    let colour = Infinity;
    if (proj.vis[k] === 1 || proj.vis[k] === 3) {
      const c = colourAt(pr, proj.u[k]!, proj.v[k]!, proj.r[k]!);
      if (c) colour = colourCost(pr.cls[k]!, c);
    }
    if ((proj.vis[k] === 1 || proj.vis[k] === 3) && colour < 3 && cov >= 120 && cnt[k]! >= Math.max(6, 0.35 * expected)) matched.push({ k, u: proj.u[k]!, v: proj.v[k]!, r: proj.r[k]!, cov, colour });
    else if (proj.vis[k] === 1 && !pr.camo[k] && clothAt(pr, proj.u[k]!, proj.v[k]!, proj.r[k]!)) missing++;
  }
  // Candidates that no visible ball explains (a moved or unknown ball).
  let unexplained = 0;
  let strayCue = false;
  for (let j = 0; j < cands.length; j++) {
    const c = cands[j]!;
    if (c.r < 3 || explained(pr, r.fit, c, proj)) continue;
    unexplained++;
    if (pr.cc[pr.cueIdx * pr.nCands + j]! < 3) strayCue = true;
  }
  const explainedFrac = explainedPts / Math.max(1, pr.nPts - neutralPts);
  const quality = matched.length - 0.6 * missing - 0.4 * unexplained - 0.1 * Math.min(10, residualPx) + 4 * explainedFrac;
  // edgeSegments order: four side-cushion segments (y = ±Y), then the two end cushions (x = ±X).
  let side = false;
  let end = false;
  for (let q = 0; q < pr.segs.length; q++) {
    if (segIn[q]! < EDGE_LINE_SUPPORT) continue;
    if (q < 4) side = true;
    else end = true;
  }
  return { matched, visible, missing, residualPx, edgeInliers, edgeCrossed: side && end, explainedFrac, unexplained, strayCue, quality };
}

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
  const vl = Math.hypot(vx, vy, vz);
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
    const rho = Math.hypot(e1x, e1y, e1z);
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
      if ((Math.abs(Math.hypot(d1, d2) - rho) * f) / sd > 0.5 * rays.r[k]! + 4) continue;
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
  for (let k = 0; k < photo.models.length; k++) {
    // A further candidate is tried only when it is a plausible cloth next to the first (≥ ¼ of its
    // structure score) or the first is no convincing cloth (fewer than two ball holes).
    if (k > 0 && photo.scores[k]! < 0.25 * photo.scores[0]! && photo.scores[0]! >= 2) break;
    const at = fitWithCloth(input, photo.models[k]!, sc, t0);
    circles = Math.max(circles, at.circles);
    if (!best || (at.res.ok && !best.res.ok) || (at.res.ok === best.res.ok && at.quality > best.quality)) best = at;
    // Done when it fits. A failure with balls matched on this cloth does not prove the cloth right: under
    // sensor noise the next candidate (a neighbouring hue or value mode) often holds the cue ball or a
    // cleaner crack set and fits (noise σ 4: 63 → 68 of 76 envelope scenes when it is tried).
    if (at.res.ok) break;
  }
  const res = best!.res;
  // Honest reasons (Principle II): a failure on a dark photo, or on a dim cloth, is about the light;
  // a lit photo whose surfaces enclose nothing at all (no ball, no pocket) and hold no ball circle
  // shows no table.
  if (!res.ok && (dark || photo.models[0]!.val < DIM_CLOTH_V)) res.reason = PLAYER_VIEW_REASONS.dark;
  else if (!res.ok && circles < 2 && photo.enclosed.every((n) => n === 0)) res.reason = PLAYER_VIEW_REASONS.noCloth;
  res.ms = performance.now() - t0;
  return res;
}

/** Steps 2–6 with one cloth model. */
function fitWithCloth(input: PlayerViewInput, cloth: ClothModel, sc: Scratch, t0: number): Attempt {
  const { frame, table, balls, targetId, manualTaps } = input;
  const w = frame.width;
  const h = frame.height;
  const Rb = table.ballRadius;
  const diag = Math.hypot(w, h);
  const cx = w / 2;
  const cy = h / 2;
  const fDefault = w / 2 / Math.tan((PLAYER_VIEW_DEFAULT_HFOV * Math.PI) / 360);
  const fHint = input.focalPx && input.focalPx > 0 ? input.focalPx : 0;
  const f0 = fHint || fDefault;
  let nCircles = 0;
  const noFit = (reason: string): Attempt => ({ res: fail(reason, t0), quality: -Infinity, circles: nCircles });

  // 2. Evidence: the main cloth region, its boundary cracks and the ball circles on it.
  const ev = buildEvidence(frame, cloth, sc);
  if (ev.mainArea < MIN_CLOTH_AREA * w * h) return noFit(PLAYER_VIEW_REASONS.noCloth);
  const vScale = exposureScale(cloth);
  const cands = findCandidates(frame, sc, ev.comps, ev.nCracks, vScale);
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
      const d = Math.hypot(c.u - p.x, c.v - p.y);
      if (d < 1.25 * c.r + 0.01 * diag && d / c.r < bd) {
        bd = d / c.r;
        best = j;
      }
    }
    return best;
  };
  type Obs = { u: number; v: number; r: number };
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
    if (!whites.length) return noFit(cands.length < 2 ? PLAYER_VIEW_REASONS.tooFewBalls : PLAYER_VIEW_REASONS.noCue);
    for (const { c } of whites.slice(0, 2)) cueObs.push(c);
  }

  // 4. Hypotheses: cue circle + one more (circle, ball) pair → level pose and its roll completion,
  //    for each focal guess.
  const nb = known.length;
  const proj: Projected = { u: new Float64Array(nb), v: new Float64Array(nb), r: new Float64Array(nb), d: new Float64Array(nb), vis: new Uint8Array(nb) };
  const ss = scoreScratch(nb, cands.length);
  const hyps: Hyp[] = [];
  const tmp: Fit[] = [];
  // The 16 largest circles, each paired with every colour-compatible known ball.
  const bigCands = [...cands].sort((a, b) => b.r - a.r).slice(0, 16);
  const rays: Rays = { idx: Int32Array.from(bigCands.map((c) => cands.indexOf(c))), ax: new Float64Array(16), ay: new Float64Array(16), az: new Float64Array(16), r: new Float64Array(16), n: bigCands.length };
  for (const co of cueObs) {
    const coIdx = bigCands.indexOf(co as Candidate);
    const pairs = manualTaps
      ? pairList.map((p) => ({ ...p, ci: bigCands.indexOf(p.obs as Candidate) }))
      : bigCands.flatMap((c, ci) => (c === co ? [] : known.map((_, k) => ({ obs: c as Obs, k, ci })).filter(({ k }) => k !== cueIdx && colourCost(pr.cls[k]!, c.col) < 3)));
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
        poseFromPair(cueW, Pc, rj.a, rj.D, { x: known[pp.k]!.pos.x, y: known[pp.k]!.pos.y, z: Rb }, tmp, f);
        const nLevel = tmp.length;
        for (let q = 0; q < nLevel; q++) rollCompletion(pr, tmp[q]!, Pc, cueIdx, pp.k, coIdx, pp.ci, rays, tmp);
        for (const fit of tmp) {
          let score = scorePose(pr, fit, known, cands, proj, ss);
          if (manualTaps) score -= 0.5 * ((fit.C.z - 0.2) / 0.15) ** 2;
          hyps.push({ fit, score });
        }
      }
    }
  }
  // No pose at all from the cue-ball candidates: in automatic mode the white circles were not the cue ball.
  if (!hyps.length) return noFit(cands.length < 2 ? PLAYER_VIEW_REASONS.tooFewBalls : manualTaps ? PLAYER_VIEW_REASONS.noFit : PLAYER_VIEW_REASONS.noCue);
  hyps.sort((a, b) => b.score - a.score);
  const seeds: Hyp[] = [];
  for (const hy of hyps) {
    if (seeds.length >= (manualTaps ? 3 : 4)) break;
    if (seeds.every((sd) => poseDistance(sd.fit, hy.fit) > 1.5)) seeds.push(hy);
  }

  // 5. Refine the best seeds; keep the one that explains the photo best.
  let best: { r: Refined; ev: Evaluation } | null = null;
  for (const sd of seeds) {
    const r = refine(pr, sd.fit, gates);
    const e = evaluate(pr, r, cands);
    if (!best || e.quality > best.ev.quality + 1e-9) best = { r, ev: e };
    // A seed that explains everything cleanly cannot be beaten in a way that matters: stop early. With
    // five or more balls matched, a couple of stray circles (arcs in a packed rack) do not change that.
    const be = best.ev;
    if (be.missing === 0 && be.residualPx < 1 && be.explainedFrac > 0.6 && ((be.unexplained === 0 && be.matched.length >= 3) || (be.unexplained <= 2 && be.matched.length >= 5))) break;
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
  // Many balls or the cushions make the pose insensitive to one ball; three close balls do not.
  if (Number.isFinite(sigmaPx) && fe.matched.length <= 4 && fe.edgeInliers < 20) {
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
    sigmaPx = Math.hypot(sigmaPx, Math.sqrt(s2));
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
  // identity is clearly confirmed by colour and no ball is predicted on bare cloth (Principle II).
  // Two balls and the cushions are enough only when the cushion lines cross (side and end) and the
  // identities are sure, with nothing unexplained: a grazing view of parallel cushion lines let a wrong
  // pose (camera 0.5 m off) explain 70 % of the cloth boundary in the envelope sweep.
  const minimal = nMatched === 3 && fe.edgeInliers < 20;
  const identitiesSure = fe.missing === 0 && fe.matched.every((m) => m.colour <= MINIMAL_COLOUR_COST);
  const twoAndCushions = fe.edgeCrossed && fe.explainedFrac >= 0.55 && identitiesSure && fe.unexplained === 0;
  const enoughBalls = (nMatched >= 3 && (!minimal || identitiesSure || tappedBoth)) || (nMatched >= 2 && (twoAndCushions || tappedBoth));
  const ok = confidence >= 0.5 && fe.residualPx <= residualLimit && enoughBalls && (cueMatched || targetMatched);
  // A fit that is not good enough to use never reports a usable confidence.
  if (!ok) confidence = Math.min(confidence, 0.49);
  const matched = fe.matched.map((m) => ({ id: known[m.k]!.id, image: { x: m.u, y: m.v }, radiusPx: m.r }));

  let reason: string | undefined;
  if (!ok) {
    // "Moved" only from a pose the static scene supports (most of the cloth boundary explained, small
    // residual): only then do balls predicted on bare cloth, or circles nothing explains, mean the
    // layout changed. A pose that explains little is a failed fit, whatever it predicts.
    // The fitted camera must also be where a player photo is taken from (spec 002 assumptions: within
    // ≈ 1.5 m of the cue ball, 5–50 cm above the bed): from a few cm up, cushion lines are nearly
    // parallel and a camera metres away can line them up as well.
    const camDist = Math.hypot(fit.C.x - cueW.x, fit.C.y - cueW.y);
    const plausible = camDist <= PLAUSIBLE_CAMERA_DIST && fit.C.z >= 0.02 && fit.C.z <= PLAUSIBLE_CAMERA_HEIGHT;
    // And the pose must be pinned by balls that did not move: at least three. Two balls and the cushions
    // pass only with nothing unexplained (twoAndCushions); from a few cm up, a pose 40 cm off lined two
    // balls and crossing cushion lines up with stray circles left over (charcoal cloth, grey grid).
    const pinned = nMatched >= 3;
    const solid = plausible && pinned && (fe.explainedFrac >= SOLID_EXPLAINED || fe.edgeInliers >= SOLID_EDGES * pr.nPts) && fe.residualPx <= residualLimit;
    // A cue ball found nowhere (not where the layout puts it, and no stray circle of its colour) is
    // unseen, not moved: the player photographs the ball they are about to strike.
    const cueAccounted = cueMatched || fe.strayCue;
    // Fewer than three ball circles in the whole photo: it shows too few balls, whatever the fit did.
    if (cands.length < 3 && nMatched < 3) reason = PLAYER_VIEW_REASONS.tooFewBalls;
    else if (solid && cueAccounted && (fe.missing >= 2 || (fe.missing >= 1 && fe.unexplained >= 1))) reason = PLAYER_VIEW_REASONS.moved;
    else if (!cueMatched && !manualTaps) reason = PLAYER_VIEW_REASONS.noCue;
    else if (nMatched < 2) reason = PLAYER_VIEW_REASONS.tooFewBalls;
    else reason = PLAYER_VIEW_REASONS.noFit;
  } else {
    // Warn (only) when the camera is far from the shooting position behind the cue ball.
    const dx = cueW.x - fit.C.x;
    const dy = cueW.y - fit.C.y;
    const dh = Math.hypot(dx, dy);
    let offLine = false;
    if (targetIdx >= 0) {
      const tx = known[targetIdx]!.pos.x - cueW.x;
      const ty = known[targetIdx]!.pos.y - cueW.y;
      const cosA = (dx * tx + dy * ty) / Math.max(1e-9, dh * Math.hypot(tx, ty));
      offLine = cosA < Math.cos((40 * Math.PI) / 180);
    }
    if (dh > 2.0 || offLine) reason = PLAYER_VIEW_REASONS.notBehind;
  }
  return {
    res: { ok, pose, confidence, residualPx: fe.residualPx, matched, ...(reason ? { reason } : {}), ms: performance.now() - t0 },
    quality: fe.quality,
    circles: nCircles,
  };
}
