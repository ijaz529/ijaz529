/**
 * Planar homography + pinhole camera helpers.
 * Matrices are row-major number[9]. A homography H maps table-plane metres (X, Y) → image pixels.
 */
import type { Vec2, Vec3 } from '../core/vec';

export type Mat3 = number[];

export function applyH(H: Mat3, x: number, y: number): Vec2 {
  const w = H[6]! * x + H[7]! * y + H[8]!;
  return { x: (H[0]! * x + H[1]! * y + H[2]!) / w, y: (H[3]! * x + H[4]! * y + H[5]!) / w };
}

export function mul3(A: Mat3, B: Mat3): Mat3 {
  const C = new Array<number>(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) C[i * 3 + j]! += A[i * 3 + k]! * B[k * 3 + j]!;
  return C;
}

export function invert3(m: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = m as [number, number, number, number, number, number, number, number, number];
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-18) throw new Error('Singular matrix');
  const s = 1 / det;
  return [A * s, -(b * i - c * h) * s, (b * f - c * e) * s, B * s, (a * i - c * g) * s, -(a * f - c * d) * s, C * s, -(a * h - b * g) * s, (a * e - b * d) * s];
}

/** Solve an n×n linear system in place (Gaussian elimination, partial pivoting). */
function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(A[r]![col]!) > Math.abs(A[piv]![col]!)) piv = r;
    if (Math.abs(A[piv]![col]!) < 1e-14) throw new Error('Degenerate point configuration');
    [A[col], A[piv]] = [A[piv]!, A[col]!];
    [b[col], b[piv]] = [b[piv]!, b[col]!];
    for (let r = col + 1; r < n; r++) {
      const k = A[r]![col]! / A[col]![col]!;
      for (let c = col; c < n; c++) A[r]![c]! -= k * A[col]![c]!;
      b[r]! -= k * b[col]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r]!;
    for (let c = r + 1; c < n; c++) s -= A[r]![c]! * x[c]!;
    x[r] = s / A[r]![r]!;
  }
  return x;
}

/** Exact 4-point homography (DLT with h33 = 1) mapping src[i] → dst[i]. */
export function homographyFrom4(src: Vec2[], dst: Vec2[]): Mat3 {
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i]!;
    const { x: u, y: v } = dst[i]!;
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  const h = solve(A, b);
  return [h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!, 1];
}

export interface FocalEstimate {
  /** Estimated focal length in px (NaN if unobservable). */
  f: number;
  /** |log(f_orthogonality / f_equalNorm)| when both constraints are usable; 0 with one; ∞ with none. */
  inconsistency: number;
  /** Number of well-conditioned constraints used (0, 1 or 2). */
  constraints: number;
}

/**
 * Focal length from a homography of a metric rectangle, assuming square pixels and a known principal
 * point (Zhang's constraints with one unknown): K⁻¹h₁ ⊥ K⁻¹h₂ and ‖K⁻¹h₁‖ = ‖K⁻¹h₂‖.
 * The orthogonality constraint degenerates when a vanishing point is at infinity (an axis parallel to
 * the image plane); the equal-norm one when both axes are equally tilted. Each is used only when
 * well-conditioned. `fRef` (≈ expected focal) only normalises the conditioning test.
 */
export function estimateFocal(H: Mat3, cx: number, cy: number, fRef = 2 * cx): FocalEstimate {
  const a = [H[0]! - cx * H[6]!, H[3]! - cy * H[6]!, H[6]!];
  const b = [H[1]! - cx * H[7]!, H[4]! - cy * H[7]!, H[7]!];
  const A1 = a[0]! * b[0]! + a[1]! * b[1]!;
  const c1 = a[2]! * b[2]!;
  const A2 = a[0]! ** 2 + a[1]! ** 2 - b[0]! ** 2 - b[1]! ** 2;
  const c2 = a[2]! ** 2 - b[2]! ** 2;
  // Tilt of each axis toward the camera (≈ tan of the angle out of the image plane).
  const za = (Math.abs(a[2]!) * fRef) / Math.hypot(a[0]!, a[1]!);
  const zb = (Math.abs(b[2]!) * fRef) / Math.hypot(b[0]!, b[1]!);
  const orthoOk = Math.min(za, zb) > 0.03;
  const normOk = Math.abs(za * za - zb * zb) > 0.03 * Math.max(za * za, zb * zb, 1e-9);
  const w1 = -c1 / A1;
  const w2 = -c2 / A2;
  const ok1 = orthoOk && Number.isFinite(w1) && w1 > 0;
  const ok2 = normOk && Number.isFinite(w2) && w2 > 0;
  let w = NaN;
  let inconsistency = Infinity;
  if (ok1 && ok2) {
    w = -(A1 * c1 + A2 * c2) / (A1 * A1 + A2 * A2);
    inconsistency = Math.abs(0.5 * Math.log(w2 / w1));
  } else if (ok1 || ok2) {
    w = ok1 ? w1 : w2;
    inconsistency = 0;
  }
  return { f: w > 0 ? 1 / Math.sqrt(w) : NaN, inconsistency, constraints: Number(ok1) + Number(ok2) };
}

export function intrinsics(f: number, cx: number, cy: number): Mat3 {
  return [f, 0, cx, 0, f, cy, 0, 0, 1];
}

export interface Pose {
  r1: Vec3;
  r2: Vec3;
  r3: Vec3;
  /** Translation of the plane origin in camera coordinates. */
  t: Vec3;
  /** Scale σ such that H = σ·K·[r1 r2 t]. */
  sigma: number;
  /** Camera centre in plane coordinates (z = height above the plane). */
  camera: Vec3;
}

const cross3 = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const dot3 = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const norm3 = (a: Vec3): Vec3 => {
  const l = Math.hypot(a.x, a.y, a.z);
  return { x: a.x / l, y: a.y / l, z: a.z / l };
};

/** Decompose H ≅ K·[r1 r2 t] into an orthonormal pose (camera above the plane). */
export function poseFromHomography(H: Mat3, K: Mat3): Pose {
  const M = mul3(invert3(K), H);
  const c0 = { x: M[0]!, y: M[3]!, z: M[6]! };
  const c1 = { x: M[1]!, y: M[4]!, z: M[7]! };
  const c2 = { x: M[2]!, y: M[5]!, z: M[8]! };
  let sigma = (Math.hypot(c0.x, c0.y, c0.z) + Math.hypot(c1.x, c1.y, c1.z)) / 2;
  if (c2.z / sigma < 0) sigma = -sigma; // plane in front of the camera
  const r1 = norm3({ x: c0.x / sigma, y: c0.y / sigma, z: c0.z / sigma });
  let r2 = { x: c1.x / sigma, y: c1.y / sigma, z: c1.z / sigma };
  const d = dot3(r1, r2);
  r2 = norm3({ x: r2.x - d * r1.x, y: r2.y - d * r1.y, z: r2.z - d * r1.z });
  const r3 = cross3(r1, r2);
  const t = { x: c2.x / sigma, y: c2.y / sigma, z: c2.z / sigma };
  // Camera centre C = −Rᵀ t (columns r1 r2 r3 are the plane axes in camera coords).
  const camera = { x: -dot3(r1, t), y: -dot3(r2, t), z: -dot3(r3, t) };
  return { r1, r2, r3, t, sigma, camera };
}

/** Homography of the parallel plane offset by dz (along the plane normal r3) from H's plane. */
export function planeHomography(H: Mat3, K: Mat3, pose: Pose, dz: number): Mat3 {
  const k = [K[0]! * pose.r3.x + K[1]! * pose.r3.y + K[2]! * pose.r3.z, K[3]! * pose.r3.x + K[4]! * pose.r3.y + K[5]! * pose.r3.z, pose.r3.z];
  const s = pose.sigma * dz;
  const out = H.slice();
  out[2] = out[2]! + s * k[0]!;
  out[5] = out[5]! + s * k[1]!;
  out[8] = out[8]! + s * k[2]!;
  return out;
}

/** Signed area of a polygon (shoelace); negative for the table-CCW order seen in image coords. */
export function signedArea(p: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const q = p[i]!;
    const r = p[(i + 1) % p.length]!;
    a += q.x * r.y - r.x * q.y;
  }
  return a / 2;
}
