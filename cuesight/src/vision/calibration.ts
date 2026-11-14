/**
 * Calibration from four image corners of the outer cloth edge (research.md R-03/R-04/R-05):
 * validate the quad, order the corners, pick the long/short-side assignment, estimate focal length
 * from the known rectangle, recover the camera pose and derive the bed (z = 0) and ball-centre (z = R)
 * homographies.
 */
import type { TableSpec } from '../core/types';
import type { Vec2, Vec3 } from '../core/vec';
import { applyH, estimateFocal, homographyFrom4, intrinsics, normResidual, planeHomography, poseFromHomography, signedArea, type FocalEstimate, type Mat3 } from './homography';

export interface Calibration {
  /** Outer cloth-edge corners in table order: (−x,−y), (+x,−y), (+x,+y), (−x,+y). */
  corners: Vec2[];
  /** Table plane z = 0 (metres) → image px. */
  H0: Mat3;
  /** Plane at ball-centre height z = R → image px. */
  HR: Mat3;
  focal: number;
  focalSource: 'estimated' | 'assumed';
  source: 'auto' | 'manual';
  /** Camera centre in table coordinates (z = height above the bed). */
  camera: Vec3;
  width: number;
  height: number;
}

export interface CalibrationOptions {
  fovDeg?: number;
  /** Absolute override: use the other long/short-rail assignment than the automatic (stable) choice. */
  swapAxes?: boolean;
  source?: 'auto' | 'manual';
  /**
   * The previous frame's calibration corners (table order). When given, the 0°/180° frame (and, when
   * the evidence is ambiguous, the long/short assignment) follows them, so the frame never flips
   * between frames. Pass nothing for a first lock, or after swapAxes changed.
   */
  prev?: Vec2[] | null;
}

/**
 * Default horizontal field of view (deg). ASSUMPTION: typical phone main camera in landscape
 * (≈ 26 mm-equivalent lens ≈ 65-70°); only used when the focal length is not observable.
 */
export const DEFAULT_FOV_DEG = 65;

/** The settings' fovDeg when it is a usable lens (20° telephoto … 150° ultra-wide), else the default. */
export function usableFovDeg(fovDeg: number | undefined | null): number {
  return typeof fovDeg === 'number' && Number.isFinite(fovDeg) && fovDeg > 20 && fovDeg < 150 ? fovDeg : DEFAULT_FOV_DEG;
}

/** Order 4 points as a polygon with negative image-space signed area (table CCW seen from above). */
export function orderQuad(pts: Vec2[]): Vec2[] {
  const cx = pts.reduce((a, p) => a + p.x, 0) / 4;
  const cy = pts.reduce((a, p) => a + p.y, 0) / 4;
  const sorted = [...pts].sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  return signedArea(sorted) > 0 ? sorted.reverse() : sorted;
}

/**
 * A quad that can be a table outline: four distinct points (> 3 % of the diagonal apart), strictly
 * convex in the given order, and covering more than 2 % of the frame. Rejects double taps, collinear
 * taps, a tap inside the table and a ball tapped instead of a corner.
 */
export function plausibleQuad(q: Vec2[], width: number, height: number): boolean {
  if (q.length !== 4 || !q.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) return false;
  const diag = Math.hypot(width, height);
  for (let i = 0; i < 4; i++)
    for (let j = i + 1; j < 4; j++) if (Math.hypot(q[i]!.x - q[j]!.x, q[i]!.y - q[j]!.y) <= 0.03 * diag) return false;
  let sign = 0;
  for (let k = 0; k < 4; k++) {
    const a = q[k]!;
    const b = q[(k + 1) % 4]!;
    const c = q[(k + 2) % 4]!;
    const cr = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cr) <= 1e-3 * diag * diag) return false;
    const s = Math.sign(cr);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return Math.abs(signedArea(q)) > 0.02 * width * height;
}

/** Hadamard ratio |det H| / (‖h₁‖‖h₂‖‖h₃‖) of the columns (0 = singular, 1 = orthogonal columns). */
function hadamard(H: Mat3): number {
  const col = (j: number) => Math.hypot(H[j]!, H[3 + j]!, H[6 + j]!);
  const det = H[0]! * (H[4]! * H[8]! - H[5]! * H[7]!) - H[1]! * (H[3]! * H[8]! - H[5]! * H[6]!) + H[2]! * (H[3]! * H[7]! - H[4]! * H[6]!);
  const d = col(0) * col(1) * col(2);
  return d > 0 ? Math.abs(det) / d : 0;
}

/**
 * Scores closer than this are a tie between the two long/short assignments (then the previous frame's
 * choice, else the longer-looking sides, wins). ASSUMPTION: the wrong assignment is off by
 * ≈ |log((long/short)²)| ≈ 1.3 for pool and snooker tables, so 0.05 only catches near-square views.
 */
const SCORE_MARGIN = 0.05;
/** Minimum camera height above the cushion top (m). ASSUMPTION: a phone is held ≥ 30 cm above the rail for a table photo. */
const MIN_CAMERA_ABOVE_CUSHION = 0.3;

export function calibrationFromCorners(cornersIn: Vec2[], table: TableSpec, width: number, height: number, opts: CalibrationOptions = {}): Calibration | null {
  if (cornersIn.length !== 4) return null;
  const q = orderQuad(cornersIn);
  if (!plausibleQuad(q, width, height)) return null;
  const Lo = table.length + 2 * table.cushionWidth;
  const Wo = table.width + 2 * table.cushionWidth;
  const T: Vec2[] = [
    { x: -Lo / 2, y: -Wo / 2 },
    { x: Lo / 2, y: -Wo / 2 },
    { x: Lo / 2, y: Wo / 2 },
    { x: -Lo / 2, y: Wo / 2 },
  ];
  const cx = width / 2;
  const cy = height / 2;
  const fAssumed = width / 2 / Math.tan(((usableFovDeg(opts.fovDeg) * Math.PI) / 180) / 2);
  const plausible = (f: number | undefined): f is number => typeof f === 'number' && Number.isFinite(f) && f > 0.35 * width && f < 3.5 * width;
  const rot = (s: number) => [0, 1, 2, 3].map((k) => q[(s + k) % 4]!);
  const H4 = (img: Vec2[]): Mat3 | null => {
    try {
      const H = homographyFrom4(T, img);
      return H.every(Number.isFinite) && hadamard(H) > 1e-6 ? H : null;
    } catch {
      return null;
    }
  };
  const d = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);

  // The two long/short assignments: parity 0 = q0q1 is a long side, parity 1 = q1q2 is.
  type Cand = { parity: 0 | 1; H: Mat3; fe: FocalEstimate; lenRatio: number };
  const cands: Cand[] = [];
  for (const parity of [0, 1] as const) {
    const img = rot(parity);
    const H = H4(img);
    if (!H) continue;
    const fe = estimateFocal(H, cx, cy, fAssumed);
    const long = d(img[0]!, img[1]!) + d(img[2]!, img[3]!);
    const short = d(img[1]!, img[2]!) + d(img[3]!, img[0]!);
    cands.push({ parity, H, fe, lenRatio: long / short });
  }
  if (!cands.length) return null;

  // Score both assignments at one common focal length: the orthogonality focal (identical for both)
  // when usable, else the assumed one. A correct assignment has equal metric scales on both axes
  // there; the wrong one is off by ≈ (long/short)². An equal-norm constraint with no solution counts
  // against its assignment.
  const fo = cands.map((c) => c.fe.fOrtho).find(plausible);
  const fc = fo ?? fAssumed;
  const score = (c: Cand) => normResidual(c.H, cx, cy, fc) + 0.35 * Math.abs(Math.log(fc / fAssumed)) + (c.fe.normInfeasible ? 1 : 0);
  const cost = (s: number, prev: Vec2[]) => rot(s).reduce((a, p, k) => a + d(p, prev[k]!), 0);
  const prev = opts.prev && opts.prev.length === 4 && opts.prev.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)) ? opts.prev : null;
  const swap = opts.swapAxes ? 1 : 0;

  // Start index s into q (s and s + 2 share an assignment and differ by a 180° turn of the frame).
  const c0 = cands.find((c) => c.parity === 0);
  const c1 = cands.find((c) => c.parity === 1);
  let parity: number = cands[0]!.parity;
  let start = -1;
  if (c0 && c1) {
    const s0 = score(c0);
    const s1 = score(c1);
    const tie = !(Math.abs(s0 - s1) > SCORE_MARGIN); // NaN (both unusable) is a tie too
    if (tie && prev) {
      // Keep the previous frame's assignment and orientation (it already includes swapAxes).
      start = [0, 1, 2, 3].reduce((b, s) => (cost(s, prev) < cost(b, prev) ? s : b), 0);
      parity = start % 2;
    } else parity = (tie ? (c0.lenRatio >= c1.lenRatio ? 0 : 1) : s0 < s1 ? 0 : 1) ^ swap;
  }
  if (start < 0) {
    if (prev) start = cost(parity, prev) <= cost(parity + 2, prev) ? parity : parity + 2;
    else {
      // First lock: a well-conditioned 0°/180° rule. Of the table axes, the one that runs most
      // across the image decides: +x to the right (camera on the −y side), or else +y to the left
      // (camera at the −x end).
      const H = (parity === 0 ? c0 : c1)?.H ?? cands[0]!.H;
      const o = applyH(H, 0, 0);
      const ex = applyH(H, 0.5, 0).x - o.x;
      const ey = applyH(H, 0, 0.5).x - o.x;
      const flip = Math.abs(ex) >= Math.abs(ey) ? ex < 0 : ey > 0;
      start = flip ? parity + 2 : parity;
    }
  }
  const chosen = cands.find((c) => c.parity === parity) ?? cands[0]!;
  const img = rot(start);
  const H = start === chosen.parity ? chosen.H : H4(img);
  if (!H) return null;

  const focalOk = plausible(chosen.fe.f) && chosen.fe.inconsistency < 0.25;
  const f = focalOk ? chosen.fe.f : fAssumed;
  const K = intrinsics(f, cx, cy);
  // H maps the cloth-edge plane at cushion height.
  const pose = poseFromHomography(H, K);
  // The camera must look down on the table from above the rails (r3, the table normal, faces it).
  if (!(pose.camera.z > MIN_CAMERA_ABOVE_CUSHION) || !Number.isFinite(pose.camera.x) || !Number.isFinite(pose.camera.y)) return null;
  const H0 = planeHomography(H, K, pose, -table.cushionHeight);
  const HR = planeHomography(H, K, pose, table.ballRadius - table.cushionHeight);
  const camera = { x: pose.camera.x, y: pose.camera.y, z: pose.camera.z + table.cushionHeight };
  return {
    corners: img,
    H0,
    HR,
    focal: f,
    focalSource: focalOk ? 'estimated' : 'assumed',
    source: opts.source ?? 'auto',
    camera,
    width,
    height,
  };
}
