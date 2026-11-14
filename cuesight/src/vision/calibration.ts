/**
 * Calibration from four image corners of the outer cloth edge (research.md R-03/R-04/R-05):
 * order the corners, pick the long/short-side assignment, estimate focal length from the known
 * rectangle, recover the camera pose and derive the bed (z = 0) and ball-centre (z = R) homographies.
 */
import type { TableSpec } from '../core/types';
import type { Vec2, Vec3 } from '../core/vec';
import { applyH, estimateFocal, homographyFrom4, intrinsics, planeHomography, poseFromHomography, signedArea, type Mat3 } from './homography';

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
  swapAxes?: boolean;
  source?: 'auto' | 'manual';
}

/** Order 4 points as a polygon with negative image-space signed area (table CCW seen from above). */
export function orderQuad(pts: Vec2[]): Vec2[] {
  const cx = pts.reduce((a, p) => a + p.x, 0) / 4;
  const cy = pts.reduce((a, p) => a + p.y, 0) / 4;
  const sorted = [...pts].sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  return signedArea(sorted) > 0 ? sorted.reverse() : sorted;
}

export function calibrationFromCorners(cornersIn: Vec2[], table: TableSpec, width: number, height: number, opts: CalibrationOptions = {}): Calibration | null {
  if (cornersIn.length !== 4) return null;
  const q = orderQuad(cornersIn);
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
  const fAssumed = width / 2 / Math.tan((((opts.fovDeg ?? 65) * Math.PI) / 180) / 2);
  const plausible = (f: number) => Number.isFinite(f) && f > 0.35 * width && f < 3.5 * width;

  type Cand = { start: number; H: Mat3; f: number; inc: number; score: number; lenRatio: number };
  const cands: Cand[] = [];
  for (const start of [0, 1]) {
    const img = [0, 1, 2, 3].map((k) => q[(start + k) % 4]!);
    let H: Mat3;
    try {
      H = homographyFrom4(T, img);
    } catch {
      continue;
    }
    const fe = estimateFocal(H, cx, cy, fAssumed);
    // Image length of the table's long sides vs short sides (fallback heuristic).
    const d = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);
    const long = d(img[0]!, img[1]!) + d(img[2]!, img[3]!);
    const short = d(img[1]!, img[2]!) + d(img[3]!, img[0]!);
    // Score: constraint disagreement + a weak prior toward typical phone focal lengths, preferring
    // assignments supported by both constraints.
    const score = plausible(fe.f) ? fe.inconsistency + 0.35 * Math.abs(Math.log(fe.f / fAssumed)) + 0.1 * (2 - fe.constraints) : Infinity;
    cands.push({ start, H, f: fe.f, inc: plausible(fe.f) ? fe.inconsistency : Infinity, score, lenRatio: long / short });
  }
  if (!cands.length) return null;
  // Prefer the most self-consistent assignment; otherwise the one whose long sides look longer.
  cands.sort((a, b) => (Number.isFinite(a.score) || Number.isFinite(b.score) ? a.score - b.score : b.lenRatio - a.lenRatio));
  let chosen = cands[0]!;
  if (opts.swapAxes && cands[1]) chosen = cands[1];

  // Canonical orientation: table +x should point to the right of the image.
  let img = [0, 1, 2, 3].map((k) => q[(chosen.start + k) % 4]!);
  let H = chosen.H;
  const o = applyH(H, 0, 0);
  const px = applyH(H, 0.5, 0);
  if (px.x < o.x) {
    img = [img[2]!, img[3]!, img[0]!, img[1]!];
    H = homographyFrom4(T, img);
  }
  const focalOk = plausible(chosen.f) && chosen.inc < 0.25;
  const f = focalOk ? chosen.f : fAssumed;
  const K = intrinsics(f, cx, cy);
  // H maps the cloth-edge plane at cushion height.
  const pose = poseFromHomography(H, K);
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
