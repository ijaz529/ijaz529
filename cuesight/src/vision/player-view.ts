/**
 * Player-view photo pose (spec 002 research R-24 / R-25 / R-26, contracts/player-view-api.md).
 *
 * The player crouches behind the cue ball and photographs the table at cloth level. The ball layout is
 * already known from the overview photo, so this photo only has to give the camera: 6-DoF pose plus
 * focal length. Pipeline (pure, deterministic, typed-array scratch reused between calls):
 *
 *  1. Cloth colour from the lower-centre band of the photo (or the overview's cloth as a hint) → cloth
 *     mask → main cloth region.
 *  2. Evidence: "crack" points on the boundary between the main cloth and anything else (ball
 *     silhouettes and the cloth→rail edge), and ball circle candidates fitted to the cloth-bordered
 *     arcs of each non-cloth blob (Kåsa + deterministic RANSAC; spatially local RANSAC on large blobs
 *     such as the rail band that far balls merge into), so balls cut by the frame edge or overlapping in
 *     depth still fit. Each candidate carries a colour descriptor and a whiteness score.
 *  3. Hypotheses: for a focal guess (0.5×–2× of the prior), the cue-ball circle fixes the cue ball in
 *     camera coordinates; pairing any other circle with any colour-compatible known ball then fixes
 *     yaw and pitch in closed form for a level (roll-free) phone. Each hypothesis is scored by the known
 *     balls that land on circles of the right size and colour, the balls predicted on bare cloth, and
 *     the circles left unexplained.
 *  4. Refinement: Levenberg–Marquardt over (rotation, camera centre, log f) on exact residuals — for a
 *     ball, the angle between a crack point's ray and the silhouette cone axis minus the cone half-angle
 *     (so there is no off-axis ellipse bias); for the outer cloth edge, the angle between the ray and the
 *     plane through the camera and that edge — with ICP-style re-association under a shrinking gate,
 *     Cauchy weights, a focal prior and a level-phone prior.
 *  5. Honesty (Principle II): confidence from the matched balls, the share of the cloth boundary the
 *     model explains, the residuals and the propagated covariance of the target's image position; `ok`
 *     only when all of them agree. Failures carry the canonical player-facing reasons.
 *
 * Conventions: world = table frame (m, z up, ball centres at z = R). Camera X_c = R·X_w + t with rows
 * right, down, forward; pixel (u, v) covers [u, u+1) × [v, v+1), principal point at the image centre.
 */
import type { TableSpec, Vec2, Vec3 } from '../core/types';
import { hueDiff, rgbToHsv, type Frame } from './image';
import { HUE_TOL, type ClothModel } from './table-detect';

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
  /** Focal length in px for this frame, from the overview calibration, if the same camera took both. */
  focalPx?: number;
  /** Manual fallback: tapped image px of the cue ball and the target ball. */
  manualTaps?: { cue: Vec2; target: Vec2 };
  /**
   * Optional (non-breaking extension): the cloth colour learned from the overview photo
   * (`VisionResult.cloth`). Used when this photo's own cloth estimate fails or disagrees with it,
   * e.g. when the floor or the near rail fills the bottom of the frame.
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

/** Solve the n×n system A·x = b in place (Gaussian elimination, partial pivoting). Null if singular. */
function solveN(A: Float64Array, b: Float64Array, n: number): Float64Array | null {
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

/**
 * Image ellipse of a sphere whose centre is at camera coordinates P (exact conic centre; mean radius
 * √(a·b) of the semi-axes). Null when the silhouette is not a closed ellipse in front of the camera.
 */
function sphereImage(Px: number, Py: number, Pz: number, Rb: number, f: number, cx: number, cy: number): { u: number; v: number; r: number; d: number } | null {
  const d = Math.hypot(Px, Py, Pz);
  if (!(d > Rb) || Pz <= 0) return null;
  const s = Rb / d;
  const az = Pz / d;
  const den = az * az - s * s;
  if (den < 0.02) return null;
  const k = az / den;
  // Semi-axes (normalised): radial tanβ/cos²α-ish and tangential tanβ/cosα-ish, exact for the conic.
  const q2 = 1 - az * az;
  const c2 = 1 - s * s;
  const rho0 = Math.sqrt(q2) * k;
  const radial = (s * Math.sqrt(c2)) / den;
  const tang2 = (rho0 * Math.sqrt(q2) + az) ** 2 / c2 - rho0 * rho0 - 1;
  const tang = Math.sqrt(Math.max(0, tang2));
  return { u: cx + (f * Px * k) / d, v: cy + (f * Py * k) / d, r: f * Math.sqrt(radial * tang), d };
}

// ---------------------------------------------------------------------------------------------------
// Image evidence
// ---------------------------------------------------------------------------------------------------

interface Scratch {
  w: number;
  h: number;
  /** 0 = not cloth, 1 = cloth (stray), 2 = main cloth region. */
  mask: Uint8Array;
  /** Cloth components (negative ids) during the first pass, then non-cloth components (1-based). */
  label: Int32Array;
  queue: Int32Array;
  crackX: Float32Array;
  crackY: Float32Array;
  crackL: Int32Array;
}

const MAX_CRACKS = 1 << 17;
let scratchCache: Scratch | null = null;

function getScratch(w: number, h: number): Scratch {
  if (!scratchCache || scratchCache.w !== w || scratchCache.h !== h) {
    const n = w * h;
    scratchCache = {
      w,
      h,
      mask: new Uint8Array(n),
      label: new Int32Array(n),
      queue: new Int32Array(n),
      crackX: new Float32Array(MAX_CRACKS),
      crackY: new Float32Array(MAX_CRACKS),
      crackL: new Int32Array(MAX_CRACKS),
    };
  }
  return scratchCache;
}

/** Cloth model around a known hue (from the overview photo): median S and V of the matching pixels. */
function clothFromHint(frame: Frame, hint: ClothModel): ClothModel | null {
  const { width: w, height: h, data } = frame;
  const hsv = [0, 0, 0];
  const satH = new Float64Array(101);
  const valH = new Float64Array(101);
  let cnt = 0;
  let n = 0;
  for (let y = Math.floor(h * 0.2); y < h; y += 3)
    for (let x = 0; x < w; x += 3) {
      const i = (y * w + x) * 4;
      rgbToHsv(data[i]!, data[i + 1]!, data[i + 2]!, hsv);
      n++;
      if (hsv[1]! > 0.2 && hsv[2]! > 0.12 && hueDiff(hsv[0]!, hint.hue) < 20) {
        satH[Math.round(hsv[1]! * 100)]! += 1;
        valH[Math.round(hsv[2]! * 100)]! += 1;
        cnt++;
      }
    }
  if (cnt < 0.04 * n) return null;
  const median = (hist: Float64Array) => {
    let acc = 0;
    for (let k = 0; k <= 100; k++) {
      acc += hist[k]!;
      if (acc >= cnt / 2) return k / 100;
    }
    return 0.5;
  };
  return { hue: hint.hue, sat: median(satH), val: median(valH) };
}

/** Cloth colour = modal hue of saturated pixels in the lower-centre band (the cloth in front of the player). */
function learnClothBand(frame: Frame): { model: ClothModel | null; meanV: number } {
  const { width: w, height: h, data } = frame;
  const hsv = [0, 0, 0];
  const bins = new Float64Array(36);
  const satH = new Float64Array(101);
  const valH = new Float64Array(101);
  const windows: [number, number, number, number][] = [
    [0.15, 0.85, 0.55, 0.98],
    [0.1, 0.9, 0.3, 0.98],
  ];
  let meanV = 0;
  for (const [fx0, fx1, fy0, fy1] of windows) {
    const x0 = Math.floor(w * fx0);
    const x1 = Math.ceil(w * fx1);
    const y0 = Math.floor(h * fy0);
    const y1 = Math.ceil(h * fy1);
    bins.fill(0);
    let n = 0;
    let vSum = 0;
    for (let y = y0; y < y1; y += 2)
      for (let x = x0; x < x1; x += 2) {
        const i = (y * w + x) * 4;
        rgbToHsv(data[i]!, data[i + 1]!, data[i + 2]!, hsv);
        n++;
        vSum += hsv[2]!;
        if (hsv[1]! > 0.2 && hsv[2]! > 0.12) bins[Math.min(35, Math.floor(hsv[0]! / 10))]! += 1;
      }
    meanV = n ? vSum / n : 0;
    let mode = 0;
    for (let b = 1; b < 36; b++) if (bins[b]! > bins[mode]!) mode = b;
    // The mode and its two neighbours must cover a good share of the band.
    const share = bins[mode]! + bins[(mode + 1) % 36]! + bins[(mode + 35) % 36]!;
    if (n === 0 || share < 0.3 * n) continue;
    const centre = mode * 10 + 5;
    let sx = 0;
    let sy = 0;
    let cnt = 0;
    satH.fill(0);
    valH.fill(0);
    for (let y = y0; y < y1; y += 2)
      for (let x = x0; x < x1; x += 2) {
        const i = (y * w + x) * 4;
        rgbToHsv(data[i]!, data[i + 1]!, data[i + 2]!, hsv);
        if (hsv[1]! > 0.2 && hsv[2]! > 0.12 && hueDiff(hsv[0]!, centre) < 20) {
          const a = (hsv[0]! * Math.PI) / 180;
          sx += Math.cos(a);
          sy += Math.sin(a);
          satH[Math.round(hsv[1]! * 100)]! += 1;
          valH[Math.round(hsv[2]! * 100)]! += 1;
          cnt++;
        }
      }
    const median = (hist: Float64Array) => {
      let acc = 0;
      for (let k = 0; k <= 100; k++) {
        acc += hist[k]!;
        if (acc >= cnt / 2) return k / 100;
      }
      return 0.5;
    };
    let hue = (Math.atan2(sy, sx) * 180) / Math.PI;
    if (hue < 0) hue += 360;
    return { model: { hue, sat: median(satH), val: median(valH) }, meanV };
  }
  return { model: null, meanV };
}

/** Mask (0/1), main cloth region (2), non-cloth components and cloth-boundary cracks. */
function buildEvidence(frame: Frame, cloth: ClothModel, sc: Scratch): { nCracks: number; comps: Comp[]; mainArea: number } {
  const { w, h, mask, label, queue } = sc;
  const n = w * h;
  const data = frame.data;
  // isCloth() inlined (same thresholds: hue within HUE_TOL, s > 0.4·sat, v > 0.28·val); hue is only
  // computed for pixels that pass the cheap saturation and value tests.
  const vMin = 0.28 * cloth.val * 255;
  const sMin = 0.4 * cloth.sat;
  const hue0 = cloth.hue;
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
  return { nCracks: nc, comps, mainArea };
}

interface Comp {
  area: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

interface Candidate {
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
}

/**
 * Colour descriptor robust to shading, exposure and stripes: the hue of the saturated pixels only, and
 * the fractions of saturated, dark and white pixels.
 */
interface ColourDesc {
  hue: number;
  satFrac: number;
  darkFrac: number;
  whiteFrac: number;
}

/** Accumulates a ColourDesc pixel by pixel without allocating. */
class ColourAcc {
  n = 0;
  hx = 0;
  hy = 0;
  sat = 0;
  dark = 0;
  white = 0;
  private hsv = [0, 0, 0];
  add(r: number, g: number, b: number): void {
    const hsv = this.hsv;
    rgbToHsv(r, g, b, hsv);
    this.n++;
    if (hsv[2]! < 0.18) this.dark++;
    else if (hsv[1]! < 0.25) {
      if (hsv[2]! > 0.25) this.white++;
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
      const d = Math.hypot(dx, dy) || 1e-9;
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
 * Ball arcs on the boundary of a large blob: RANSAC whose three samples come from the same spatial
 * neighbourhood (grid buckets), so each hypothesis is a local circle; non-overlapping circles with an
 * arc of ≥ 150° and dense support are kept. Deterministic.
 */
function localCircles(X: Float32Array, Y: Float32Array, pts: Int32Array, n: number, rLimit: number, salt: number): { c: Circle; cov: number }[] {
  if (n < 12) return [];
  const G = Math.max(4, Math.ceil(rLimit));
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
  let seed = (0x9e3779b9 ^ Math.imul(salt + 1, 2246822519)) >>> 0;
  const rand = (m: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % m;
  };
  const near = new Int32Array(n);
  let nNear = 0;
  const gather = (x: number, y: number, rad: number) => {
    nNear = 0;
    const cx0 = Math.max(0, Math.floor((x - rad - minX) / G));
    const cx1 = Math.min(gw - 1, Math.floor((x + rad - minX) / G));
    const cy0 = Math.max(0, Math.floor((y - rad - minY) / G));
    const cy1 = Math.min(gh - 1, Math.floor((y + rad - minY) / G));
    for (let cy = cy0; cy <= cy1; cy++)
      for (let cx = cx0; cx <= cx1; cx++) for (let q = cStart[cy * gw + cx]!; q < cStart[cy * gw + cx + 1]!; q++) near[nNear++] = byCell[q]!;
  };
  type Hit = { c: Circle; inl: number; cov: number };
  const hits: Hit[] = [];
  const idx = new Int32Array(n);
  const iters = Math.min(900, 3 * n);
  for (let it = 0; it < iters; it++) {
    const a = byCell[rand(n)]!;
    gather(X[a]!, Y[a]!, 2 * rLimit);
    if (nNear < 10) continue;
    const b = near[rand(nNear)]!;
    const c = near[rand(nNear)]!;
    const ax = X[a]!;
    const ay = Y[a]!;
    const bx = X[b]!;
    const by = Y[b]!;
    const cx2 = X[c]!;
    const cy2 = Y[c]!;
    const d = 2 * (ax * (by - cy2) + bx * (cy2 - ay) + cx2 * (ay - by));
    if (Math.abs(d) < 1e-6) continue;
    const a2 = ax * ax + ay * ay;
    const b2 = bx * bx + by * by;
    const c2 = cx2 * cx2 + cy2 * cy2;
    const ux = (a2 * (by - cy2) + b2 * (cy2 - ay) + c2 * (ay - by)) / d;
    const uy = (a2 * (cx2 - bx) + b2 * (ax - cx2) + c2 * (bx - ax)) / d;
    const r = Math.hypot(ax - ux, ay - uy);
    if (r < 2.5 || r > rLimit) continue;
    // Skip circles already explained by a stronger hit.
    let dup = false;
    for (const hh of hits) if (Math.hypot(hh.c.x - ux, hh.c.y - uy) < 0.5 * hh.c.r && Math.abs(hh.c.r - r) < 0.5 * hh.c.r) dup = true;
    if (dup) continue;
    gather(ux, uy, r + 3);
    const tol = Math.max(1.0, 0.06 * r);
    let m = 0;
    for (let k = 0; k < nNear; k++) if (Math.abs(Math.hypot(X[near[k]!]! - ux, Y[near[k]!]! - uy) - r) < tol) idx[m++] = near[k]!;
    if (m < 10) continue;
    const cov = coverage(X, Y, idx, m, ux, uy);
    if (cov < 150 || m < 0.5 * 1.27 * r * ((cov * Math.PI) / 180)) continue;
    // Refine on the local inliers.
    const k2 = kasa(X, Y, idx, m);
    if (!k2) continue;
    const fit = refineCircle(X, Y, idx, m, k2);
    if (!(fit.r >= 2.5 && fit.r <= rLimit)) continue;
    gather(fit.x, fit.y, fit.r + 3);
    const tol2 = Math.max(1.0, 0.06 * fit.r);
    let m2 = 0;
    for (let k = 0; k < nNear; k++) if (Math.abs(Math.hypot(X[near[k]!]! - fit.x, Y[near[k]!]! - fit.y) - fit.r) < tol2) idx[m2++] = near[k]!;
    const cov2 = coverage(X, Y, idx, m2, fit.x, fit.y);
    if (cov2 < 150 || m2 < 0.5 * 1.27 * fit.r * ((cov2 * Math.PI) / 180)) continue;
    hits.push({ c: fit, inl: m2, cov: cov2 });
  }
  hits.sort((p, q) => q.inl - p.inl);
  const out: { c: Circle; cov: number }[] = [];
  for (const hh of hits) if (out.every((o) => Math.hypot(o.c.x - hh.c.x, o.c.y - hh.c.y) > 0.8 * Math.max(o.c.r, hh.c.r))) out.push({ c: hh.c, cov: hh.cov });
  return out;
}

/**
 * Circles in the cloth-bordered boundary of each compact non-cloth blob: one Kåsa fit when it explains
 * the blob, else deterministic RANSAC that peels off up to four circles (balls overlapping in depth).
 */
function findCandidates(frame: Frame, sc: Scratch, comps: Comp[], nCracks: number): Candidate[] {
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
  const acc = new ColourAcc();
  for (let k = 1; k < nComp; k++) {
    const cp = comps[k]!;
    const n0 = start[k + 1]! - start[k]!;
    if (cp.area < 12 || n0 < 10) continue;
    let n = n0;
    for (let q = 0; q < n; q++) pts[q] = order[start[k]! + q]!;
    const circles: { c: Circle; cov: number }[] = [];
    if (cp.area > 0.2 * w * h || cp.maxX - cp.minX > 0.5 * w || cp.maxY - cp.minY > 0.6 * h) {
      // A large blob (rail, floor, background): balls touching it from the cloth side show up as arcs
      // on its cloth-bordered boundary.
      circles.push(...localCircles(crackX, crackY, pts, n, Math.max(8, 0.06 * Math.max(w, h)), k));
      n = 0;
    }
    let seed = (2463534242 ^ Math.imul(k, 2654435761)) >>> 0;
    const rand = (m: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % m;
    };
    const tolOf = (r: number) => Math.max(1.0, 0.06 * r);
    const countIn = (c: Circle) => {
      const tol = tolOf(c.r);
      let m = 0;
      for (let q = 0; q < n; q++) if (Math.abs(Math.hypot(crackX[pts[q]!]! - c.x, crackY[pts[q]!]! - c.y) - c.r) < tol) m++;
      return m;
    };
    for (let round = 0; round < 4 && n >= 10; round++) {
      let best: Circle | null = null;
      let bestIn = 0;
      const all = kasa(crackX, crackY, pts, n);
      if (all && all.r >= 2.5 && all.r <= rMax) {
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
          const r = Math.hypot(ax - ux, ay - uy);
          if (r < 2.5 || r > rMax) continue;
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
        for (let q = 0; q < n; q++) if (Math.abs(Math.hypot(crackX[pts[q]!]! - fit.x, crackY[pts[q]!]! - fit.y) - fit.r) < tol) inl[m++] = pts[q]!;
        if (m < 8) break;
        const k2 = kasa(crackX, crackY, inl, m);
        if (!k2) break;
        const g2 = refineCircle(crackX, crackY, inl, m, k2);
        if (!(g2.r >= 2.5 && g2.r <= rMax)) break;
        fit = g2;
        ni = m;
      }
      if (ni < 8) break;
      const cov = coverage(crackX, crackY, inl, ni, fit.x, fit.y);
      const expected = 1.27 * fit.r * ((cov * Math.PI) / 180);
      if (cov >= 120 && ni >= Math.max(8, 0.45 * expected)) circles.push({ c: fit, cov });
      // Remove this circle's points and look for the next one in the rest of the blob.
      const tol = 1.5 * tolOf(fit.r);
      let m = 0;
      for (let q = 0; q < n; q++) if (!(Math.abs(Math.hypot(crackX[pts[q]!]! - fit.x, crackY[pts[q]!]! - fit.y) - fit.r) < tol)) pts[m++] = pts[q]!;
      if (m === n) break;
      n = m;
    }
    for (const { c, cov } of circles) {
      // Mean colour and colour descriptor of this blob's pixels inside 0.8 r.
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
          if (mask[i] === 2 || label[i] !== k) continue;
          const R0 = frame.data[i * 4]!;
          const G0 = frame.data[i * 4 + 1]!;
          const B0 = frame.data[i * 4 + 2]!;
          rgbToHsv(R0, G0, B0, hsv);
          acc.add(R0, G0, B0);
          sr += R0;
          sg += G0;
          sb += B0;
          sSum += hsv[1]!;
          if (hsv[1]! < 0.28 && hsv[2]! > 0.22) white++;
          if (hsv[1]! > 0.45 && hsv[2]! > 0.12) colored++;
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
      });
    }
  }
  return out;
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

/** Outer cloth edge (cloth → rail boundary) at cushion height, minus the pocket cut-outs. */
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
  sigRoll: number;
  /** Height prior (manual mode). */
  height?: { mu: number; sigma: number };
  /** Ball-centre observations (manual taps): ball index → image point. */
  taps: { ball: number; x: number; y: number; sigma: number }[];
  /** Main-cloth mask (2 = cloth) for "a ball should be here but the photo shows cloth". */
  mask: Uint8Array;
  frame: Frame;
  cushionZ: number;
  /** Known balls whose colour matches the cloth (e.g. green on green): not expected to be seen. */
  camo: Uint8Array;
  /** Colour class of each known ball (null when its colour is unknown). */
  cls: BallClass[];
  /** Pocket holes in plan view (x, y, radius): dark round blobs there are not balls. */
  pockets: { x: number; y: number; r: number }[];
}

/** Does the image point back-project (onto the bed or the cushion top) into a pocket hole? */
function inPocket(pr: Problem, fit: Fit, u: number, v: number): boolean {
  const mx = (u - pr.cx) / fit.f;
  const my = (v - pr.cy) / fit.f;
  const R = fit.R;
  // World direction of the ray: Rᵀ·(mx, my, 1).
  const dx = R[0]! * mx + R[3]! * my + R[6]!;
  const dy = R[1]! * mx + R[4]! * my + R[7]!;
  const dz = R[2]! * mx + R[5]! * my + R[8]!;
  if (dz >= -1e-6) return false;
  for (const z of [0, pr.cushionZ]) {
    const t = (z - fit.C.z) / dz;
    if (t <= 0) continue;
    const x = fit.C.x + dx * t;
    const y = fit.C.y + dy * t;
    for (const p of pr.pockets) if (Math.hypot(x - p.x, y - p.y) < p.r) return true;
  }
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
  const acc = new ColourAcc();
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

/** A ball whose (overview) colour reads as cloth cannot be seen against it. */
function camouflaged(rgb: [number, number, number], cloth: ClothModel): boolean {
  const hsv = [0, 0, 0];
  rgbToHsv(rgb[0], rgb[1], rgb[2], hsv);
  return hueDiff(hsv[0]!, cloth.hue) < 25 && hsv[1]! > 0.3 * cloth.sat && hsv[2]! > 0.15;
}

/** True when the photo shows plain cloth around (u, v): a predicted ball there is missing. */
function clothAt(pr: Problem, u: number, v: number, r: number): boolean {
  const rr = Math.max(1, 0.5 * r);
  let cloth = 0;
  let tot = 0;
  for (const [dx, dy] of [
    [0, 0],
    [rr, 0],
    [-rr, 0],
    [0, rr],
    [0, -rr],
  ] as const) {
    const x = Math.floor(u + dx);
    const y = Math.floor(v + dy);
    if (x < 0 || y < 0 || x >= pr.w || y >= pr.h) continue;
    tot++;
    if (pr.mask[y * pr.w + x] === 2) cloth++;
  }
  return tot >= 3 && cloth === tot;
}

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
  const segs = pr.segs.map((s) => segPlane(pr, fit, s));
  const { elem, res } = out;
  for (let i = 0; i < pr.nPts; i++) {
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
    const cap = e < nb ? maxPerBall : maxPerSeg;
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
  // Per-element camera quantities, computed lazily.
  const ne = nb + pr.segs.length;
  const cache = new Float64Array(ne * 4);
  const have = new Uint8Array(ne);
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
  out[n++] = (p[6]! - pr.logf0) / pr.sigLogF;
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

/** Visibility codes: 0 out of view, 1 centre in frame, 2 mostly hidden by a nearer ball, 3 cut by the frame edge. */
function projectAll(pr: Problem, fit: Fit, out: Projected): void {
  const nb = pr.balls.length;
  for (let k = 0; k < nb; k++) {
    const [X, Y, Z] = cameraToWorldC(fit.R, fit.C, pr.balls[k]!);
    const im = sphereImage(X, Y, Z, pr.Rb, fit.f, pr.cx, pr.cy);
    out.vis[k] = 0;
    if (!im) continue;
    out.u[k] = im.u;
    out.v[k] = im.v;
    out.r[k] = im.r;
    out.d[k] = im.d;
    if (im.u < -im.r || im.u > pr.w + im.r || im.v < -im.r || im.v > pr.h + im.r) continue;
    out.vis[k] = im.u < 0 || im.u > pr.w || im.v < 0 || im.v > pr.h ? 3 : 1;
  }
  // Mostly hidden behind a nearer ball → not expected to be seen on its own.
  for (let k = 0; k < nb; k++) {
    if (!out.vis[k]) continue;
    for (let m = 0; m < nb; m++) {
      if (m === k || !out.vis[m] || out.d[m]! >= out.d[k]!) continue;
      if (Math.hypot(out.u[k]! - out.u[m]!, out.v[k]! - out.v[m]!) < out.r[m]! - 0.3 * out.r[k]!) {
        out.vis[k] = 2;
        break;
      }
    }
  }
}

/**
 * Score a pose by how many known balls land on candidate circles of the right size and colour. Balls
 * predicted on plain cloth count against it (a moved ball); balls predicted inside other blobs (packed,
 * hidden, or the same colour as the cloth) are neutral. Circles that no predicted ball explains also
 * count against it.
 */
function scorePose(pr: Problem, fit: Fit, known: KnownBall[], cands: Candidate[], proj: Projected): number {
  projectAll(pr, fit, proj);
  let score = 0;
  for (let k = 0; k < known.length; k++) {
    if (proj.vis[k] !== 1 && proj.vis[k] !== 3) continue;
    const rk = proj.r[k]!;
    let best = Infinity;
    for (let j = 0; j < cands.length; j++) {
      const c = cands[j]!;
      const ratio = c.r / rk;
      if (ratio < 0.5 || ratio > 2) continue;
      const e = Math.hypot(c.u - proj.u[k]!, c.v - proj.v[k]!) / (0.35 * rk + 3);
      if (e >= 3) continue;
      const cost = e * e + 0.5 * colourCost(pr.cls[k]!, c.col) + 2 * Math.log(ratio) ** 2;
      if (cost < best) best = cost;
    }
    if (best < 9) score += 1.5 - 0.12 * best;
    else if (proj.vis[k] === 1 && !pr.camo[k] && clothAt(pr, proj.u[k]!, proj.v[k]!, rk)) score -= 0.6;
  }
  for (const c of cands) if (c.r >= 3 && !explained(pr, fit, c, proj)) score -= 0.4;
  return score;
}

function explained(pr: Problem, fit: Fit, c: Candidate, proj: Projected): boolean {
  for (let k = 0; k < proj.vis.length; k++) if (proj.vis[k] && Math.hypot(c.u - proj.u[k]!, c.v - proj.v[k]!) < proj.r[k]! + 0.5 * c.r + 2) return true;
  return inPocket(pr, fit, c.u, c.v) || inPocket(pr, fit, c.u, c.v + 0.8 * c.r);
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
  matched: { k: number; u: number; v: number; r: number; cov: number }[];
  visible: number;
  /** Visible balls predicted where the photo shows plain cloth. */
  missing: number;
  residualPx: number;
  edgeInliers: number;
  /** Fraction of the cloth-boundary cracks the model explains (within 2.5 px). */
  explainedFrac: number;
  unexplained: number;
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
  let explainedPts = 0;
  for (let i = 0; i < pr.nPts; i++) {
    const e = r.assign.elem[i]!;
    if (e < 0) continue;
    const res = Math.abs(r.assign.res[i]!);
    if (res < 2.5) explainedPts++;
    if (e >= nb) {
      if (res < 2) edgeInliers++;
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
    let colourOk = false;
    if (proj.vis[k] === 1 || proj.vis[k] === 3) {
      const c = colourAt(pr, proj.u[k]!, proj.v[k]!, proj.r[k]!);
      colourOk = c !== null && colourCost(pr.cls[k]!, c) < 3;
    }
    if ((proj.vis[k] === 1 || proj.vis[k] === 3) && colourOk && cov >= 120 && cnt[k]! >= Math.max(6, 0.35 * expected)) matched.push({ k, u: proj.u[k]!, v: proj.v[k]!, r: proj.r[k]!, cov });
    else if (proj.vis[k] === 1 && !pr.camo[k] && clothAt(pr, proj.u[k]!, proj.v[k]!, proj.r[k]!)) missing++;
  }
  // Candidates that no visible ball explains (a moved or unknown ball).
  let unexplained = 0;
  for (const c of cands) if (c.r >= 3 && !explained(pr, r.fit, c, proj)) unexplained++;
  const explainedFrac = explainedPts / Math.max(1, pr.nPts);
  const quality = matched.length - 0.6 * missing - 0.4 * unexplained - 0.1 * Math.min(10, residualPx) + 4 * explainedFrac;
  return { matched, visible, missing, residualPx, edgeInliers, explainedFrac, unexplained, quality };
}

function fail(reason: string, t0: number, pose: CameraPose | null = null, extra: Partial<PlayerViewResult> = {}): PlayerViewResult {
  return { ok: false, pose, confidence: 0, residualPx: Infinity, matched: [], reason, ms: performance.now() - t0, ...extra };
}

export function estimatePlayerView(input: PlayerViewInput): PlayerViewResult {
  const t0 = performance.now();
  const { frame, table, balls, cueId, targetId, manualTaps } = input;
  const w = frame.width;
  const h = frame.height;
  const cues = balls.filter((b) => b.isCue);
  if (!(w > 0 && h > 0) || frame.data.length < w * h * 4 || cues.length !== 1 || cues[0]!.id !== cueId) return fail(PLAYER_VIEW_REASONS.noFit, t0);
  if (manualTaps && (!targetId || !balls.some((b) => b.id === targetId && !b.isCue))) return fail(PLAYER_VIEW_REASONS.noFit, t0);
  const Rb = table.ballRadius;
  const diag = Math.hypot(w, h);
  const cx = w / 2;
  const cy = h / 2;
  const f0 = input.focalPx && input.focalPx > 0 ? input.focalPx : w / 2 / Math.tan((PLAYER_VIEW_DEFAULT_HFOV * Math.PI) / 360);

  // 1. Cloth.
  const learned = learnClothBand(frame);
  const meanV = learned.meanV;
  let cloth = learned.model;
  const hint = input.clothHint;
  if (hint && (!cloth || hueDiff(cloth.hue, hint.hue) > 35)) cloth = clothFromHint(frame, hint) ?? cloth;
  if (!cloth || meanV < 0.05 || cloth.val < 0.12) return fail(PLAYER_VIEW_REASONS.dark, t0);
  const sc = getScratch(w, h);
  const ev = buildEvidence(frame, cloth, sc);
  if (ev.mainArea < 0.05 * w * h) return fail(PLAYER_VIEW_REASONS.dark, t0);
  const cands = findCandidates(frame, sc, ev.comps, ev.nCracks);
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
    px,
    py,
    nPts: ev.nCracks,
    logf0: Math.log(f0),
    sigLogF: input.focalPx ? 0.1 : 0.5,
    sigRoll: ((manualTaps ? 5 : 10) * Math.PI) / 180,
    taps: [],
    mask: sc.mask,
    frame,
    cushionZ: table.cushionHeight,
    cls: known.map((b) => ballClass(b.rgb)),
    camo: Uint8Array.from(known.map((b) => (b.rgb && camouflaged(b.rgb, cloth) ? 1 : 0))),
    pockets: table.pockets.map((p) => {
      const mouth = p.kind === 'corner' ? table.cornerMouth : table.sideMouth;
      return { x: p.mouthCenter.x - p.inward.x * 0.5 * mouth, y: p.mouthCenter.y - p.inward.y * 0.5 * mouth, r: 0.9 * mouth + 0.02 };
    }),
  };
  const cueW = { x: known[cueIdx]!.pos.x, y: known[cueIdx]!.pos.y, z: Rb };
  const targetIdx = targetId ? known.findIndex((b) => b.id === targetId) : -1;
  const s = Math.max(w, h) / 1000;
  const gates = [24 * s, 12 * s, 6 * s, 3.5 * s].map((g) => Math.max(3, g));

  // 2. Cue-ball candidates (whitest circles) or the tapped circles.
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
  // Focal guesses: around focalPx when the same camera took the overview, else 0.5×–2× of the 65° prior
  // (HFOV ≈ 100° ultra-wide … 40° tele), in ~10 % steps.
  const fMuls = input.focalPx ? [0.85, 0.92, 1, 1.08, 1.17] : Array.from({ length: 15 }, (_, i) => 0.5 * 1.1 ** i);
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
    if (!whites.length) return fail(cands.length < 2 ? PLAYER_VIEW_REASONS.tooFewBalls : PLAYER_VIEW_REASONS.noCue, t0);
    for (const { c } of whites.slice(0, 2)) cueObs.push(c);
  }

  // 3. Hypotheses: cue circle + one more (circle, ball) pair → level pose, for each focal guess.
  const nb = known.length;
  const proj: Projected = { u: new Float64Array(nb), v: new Float64Array(nb), r: new Float64Array(nb), d: new Float64Array(nb), vis: new Uint8Array(nb) };
  const hyps: Hyp[] = [];
  const tmp: Fit[] = [];
  // The 16 largest circles, each paired with every colour-compatible known ball.
  const bigCands = [...cands].sort((a, b) => b.r - a.r).slice(0, 16);
  for (const co of cueObs) {
    const pairs = manualTaps
      ? pairList
      : bigCands.filter((c) => c !== co).flatMap((c) => known.map((_, k) => ({ obs: c as Obs, k })).filter(({ k }) => k !== cueIdx && colourCost(pr.cls[k]!, c.col) < 3));
    for (const fm of fMuls) {
      const f = f0 * fm;
      const cr = ballRay(co, f, cx, cy, Rb);
      if (!Number.isFinite(cr.D)) continue;
      const Pc: [number, number, number] = [cr.a[0] * cr.D, cr.a[1] * cr.D, cr.a[2] * cr.D];
      for (const pp of pairs) {
        const rj = ballRay(pp.obs, f, cx, cy, Rb);
        tmp.length = 0;
        poseFromPair(cueW, Pc, rj.a, rj.D, { x: known[pp.k]!.pos.x, y: known[pp.k]!.pos.y, z: Rb }, tmp, f);
        for (const fit of tmp) {
          let score = scorePose(pr, fit, known, cands, proj);
          if (manualTaps) score -= 0.5 * ((fit.C.z - 0.2) / 0.15) ** 2;
          hyps.push({ fit, score });
        }
      }
    }
  }
  if (!hyps.length) return fail(cands.length < 2 ? PLAYER_VIEW_REASONS.tooFewBalls : PLAYER_VIEW_REASONS.noFit, t0);
  hyps.sort((a, b) => b.score - a.score);
  const seeds: Hyp[] = [];
  for (const hy of hyps) {
    if (seeds.length >= (manualTaps ? 3 : 4)) break;
    if (seeds.every((sd) => poseDistance(sd.fit, hy.fit) > 1.5)) seeds.push(hy);
  }

  // 4. Refine the best seeds; keep the one that explains the photo best.
  let best: { r: Refined; ev: Evaluation } | null = null;
  for (const sd of seeds) {
    const r = refine(pr, sd.fit, gates);
    const e = evaluate(pr, r, cands);
    if (!best || e.quality > best.ev.quality + 1e-9) best = { r, ev: e };
    // A seed that explains everything cleanly cannot be beaten in a way that matters: stop early.
    if (best.ev.missing === 0 && best.ev.unexplained === 0 && best.ev.matched.length >= 3 && best.ev.residualPx < 1 && best.ev.explainedFrac > 0.6) break;
  }
  const { r: fitR, ev: fe } = best!;
  const fit = fitR.fit;
  const pose = toPose(fit, w, h);

  // 5. Confidence: matched balls × residual × propagated uncertainty of the target's image position.
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
  const nMatched = fe.matched.length;
  const cueMatched = fe.matched.some((m) => m.k === cueIdx);
  const targetMatched = targetIdx >= 0 && fe.matched.some((m) => m.k === targetIdx);
  const fracFound = nMatched / Math.max(1, nMatched + fe.missing);
  const countTerm = nMatched >= 3 ? 1 : nMatched === 2 ? (fe.edgeInliers >= 20 || manualTaps ? 0.75 : 0.45) : 0;
  // The model (balls + cloth edge) must explain most of the cloth boundary; a pose that lines up a few
  // balls by accident leaves the cushions unexplained.
  const explainedTerm = Math.max(0, Math.min(1, (fe.explainedFrac - 0.3) / 0.3));
  const inlierTerm = countTerm * fracFound * explainedTerm * Math.exp(-0.12 * fe.unexplained);
  const residualTerm = Math.exp(-((fe.residualPx / (0.004 * diag)) ** 2));
  const uncertaintyTerm = Number.isFinite(sigmaPx) ? Math.exp(-sigmaPx / (0.01 * diag)) : 0;
  let confidence = Math.max(0, Math.min(1, inlierTerm * residualTerm * uncertaintyTerm));
  if (manualTaps && nMatched < 3) confidence = Math.min(confidence, 0.7);
  // Two balls suffice with a cushion edge, or when the player tapped them (R-25: the level-phone and
  // height priors close the 7th degree of freedom; confidence is capped below).
  const tappedBoth = manualTaps !== undefined && cueMatched && targetMatched;
  const enoughBalls = nMatched >= 3 || (nMatched >= 2 && ((fe.edgeInliers >= 20 && fe.explainedFrac >= 0.55) || tappedBoth));
  const ok = confidence >= 0.5 && fe.residualPx <= Math.max(4, 0.006 * diag) && enoughBalls && (cueMatched || targetMatched);
  const matched = fe.matched.map((m) => ({ id: known[m.k]!.id, image: { x: m.u, y: m.v }, radiusPx: m.r }));

  let reason: string | undefined;
  if (!ok) {
    if (nMatched < 2 && cands.length < 3) reason = PLAYER_VIEW_REASONS.tooFewBalls;
    else if (fe.missing >= 2 || (fe.missing >= 1 && fe.unexplained >= 1)) reason = PLAYER_VIEW_REASONS.moved;
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
    ok,
    pose,
    confidence,
    residualPx: fe.residualPx,
    matched,
    ...(reason ? { reason } : {}),
    ms: performance.now() - t0,
  };
}
