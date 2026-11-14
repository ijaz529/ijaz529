/**
 * Small, allocation-light 3D math for the WebGL table renderer. Pure and DOM-free (unit-tested in
 * node). Matrices are column-major Float32Array(16) exactly as WebGL expects: m[col * 4 + row].
 * World frame = table frame: origin at the bed centre, +x along the long rail, +y along the short
 * rail, +z up, metres.
 */

export type V3 = [number, number, number];
/** Unit quaternion (x, y, z, w). */
export type Quat = [number, number, number, number];
export type Mat4 = Float32Array;

export interface Ray {
  origin: V3;
  /** Unit direction. */
  dir: V3;
}

// ---------------------------------------------------------------------------------------------
// Vectors
// ---------------------------------------------------------------------------------------------
export const v3 = (x: number, y: number, z: number): V3 => [x, y, z];
export const v3add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const v3sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const v3scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
export const v3dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const v3cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const v3len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
export const v3lerp = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export function v3norm(a: V3): V3 {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
}

// ---------------------------------------------------------------------------------------------
// Matrices
// ---------------------------------------------------------------------------------------------
export function mat4(out: Mat4 = new Float32Array(16)): Mat4 {
  out.fill(0);
  out[0] = out[5] = out[10] = out[15] = 1;
  return out;
}

/** out = a · b (apply b first, then a). `out` may alias a or b. */
export function mat4Multiply(out: Mat4, a: ArrayLike<number>, b: ArrayLike<number>): Mat4 {
  const r = new Float64Array(16);
  for (let c = 0; c < 4; c++)
    for (let row = 0; row < 4; row++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + row]! * b[c * 4 + k]!;
      r[c * 4 + row] = s;
    }
  for (let i = 0; i < 16; i++) out[i] = r[i]!;
  return out;
}

/** OpenGL perspective (NDC z in [-1, 1]); fovY in radians. */
export function mat4Perspective(out: Mat4, fovY: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovY / 2);
  out.fill(0);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (far + near) / (near - far);
  out[11] = -1;
  out[14] = (2 * far * near) / (near - far);
  return out;
}

/** View matrix from an orthonormal camera basis (right, up, forward = viewing direction). */
export function mat4View(out: Mat4, eye: V3, right: V3, up: V3, forward: V3): Mat4 {
  out[0] = right[0];
  out[4] = right[1];
  out[8] = right[2];
  out[12] = -v3dot(right, eye);
  out[1] = up[0];
  out[5] = up[1];
  out[9] = up[2];
  out[13] = -v3dot(up, eye);
  out[2] = -forward[0];
  out[6] = -forward[1];
  out[10] = -forward[2];
  out[14] = v3dot(forward, eye);
  out[3] = out[7] = out[11] = 0;
  out[15] = 1;
  return out;
}

export function mat4LookAt(out: Mat4, eye: V3, target: V3, up: V3): Mat4 {
  const f = v3norm(v3sub(target, eye));
  let r = v3cross(f, up);
  if (v3len(r) < 1e-9) r = v3cross(f, Math.abs(f[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]);
  r = v3norm(r);
  const u = v3cross(r, f);
  return mat4View(out, eye, r, u, f);
}

/** General 4×4 inverse. Returns null when singular. */
export function mat4Invert(out: Mat4, m: ArrayLike<number>): Mat4 | null {
  const a00 = m[0]!, a01 = m[1]!, a02 = m[2]!, a03 = m[3]!;
  const a10 = m[4]!, a11 = m[5]!, a12 = m[6]!, a13 = m[7]!;
  const a20 = m[8]!, a21 = m[9]!, a22 = m[10]!, a23 = m[11]!;
  const a30 = m[12]!, a31 = m[13]!, a32 = m[14]!, a33 = m[15]!;
  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det || !Number.isFinite(det)) return null;
  det = 1 / det;
  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
  return out;
}

/** Homogeneous transform m · (x, y, z, w). */
export function transform4(m: ArrayLike<number>, x: number, y: number, z: number, w = 1): [number, number, number, number] {
  return [
    m[0]! * x + m[4]! * y + m[8]! * z + m[12]! * w,
    m[1]! * x + m[5]! * y + m[9]! * z + m[13]! * w,
    m[2]! * x + m[6]! * y + m[10]! * z + m[14]! * w,
    m[3]! * x + m[7]! * y + m[11]! * z + m[15]! * w,
  ];
}

/** Model matrix from a rotation quaternion, translation and uniform scale. */
export function mat4FromRotationTranslation(out: Mat4, q: Quat, t: V3, s = 1): Mat4 {
  const m3 = mat3FromQuat(new Float32Array(9), q);
  out[0] = m3[0]! * s;
  out[1] = m3[1]! * s;
  out[2] = m3[2]! * s;
  out[3] = 0;
  out[4] = m3[3]! * s;
  out[5] = m3[4]! * s;
  out[6] = m3[5]! * s;
  out[7] = 0;
  out[8] = m3[6]! * s;
  out[9] = m3[7]! * s;
  out[10] = m3[8]! * s;
  out[11] = 0;
  out[12] = t[0];
  out[13] = t[1];
  out[14] = t[2];
  out[15] = 1;
  return out;
}

/** Model matrix whose local x/y/z axes map to the given world axes, placed at `t`. */
export function mat4FromBasis(out: Mat4, x: V3, y: V3, z: V3, t: V3): Mat4 {
  out.set([x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, t[0], t[1], t[2], 1]);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Projection, rays
// ---------------------------------------------------------------------------------------------
export interface Projected {
  /** Viewport pixels, origin top-left, y down. */
  x: number;
  y: number;
  /** NDC depth in [-1, 1]. */
  depth: number;
  /** Clip w (= distance along the view axis for a perspective camera). */
  w: number;
}

/** World point → viewport pixels (top-left origin). Null when behind the camera. */
export function project(vp: ArrayLike<number>, p: V3, width: number, height: number): Projected | null {
  const c = transform4(vp, p[0], p[1], p[2], 1);
  if (c[3] <= 1e-9) return null;
  const nx = c[0] / c[3];
  const ny = c[1] / c[3];
  return { x: (nx * 0.5 + 0.5) * width, y: (0.5 - ny * 0.5) * height, depth: c[2] / c[3], w: c[3] };
}

/** Viewport pixels + NDC depth → world point. */
export function unproject(invVP: ArrayLike<number>, sx: number, sy: number, ndcZ: number, width: number, height: number): V3 {
  const nx = (sx / width) * 2 - 1;
  const ny = 1 - (sy / height) * 2;
  const c = transform4(invVP, nx, ny, ndcZ, 1);
  return [c[0] / c[3], c[1] / c[3], c[2] / c[3]];
}

/** Ray through a viewport pixel (origin on the near plane). */
export function screenRay(invVP: ArrayLike<number>, sx: number, sy: number, width: number, height: number): Ray {
  const a = unproject(invVP, sx, sy, -1, width, height);
  const b = unproject(invVP, sx, sy, 1, width, height);
  return { origin: a, dir: v3norm(v3sub(b, a)) };
}

export function rayAt(r: Ray, t: number): V3 {
  return [r.origin[0] + r.dir[0] * t, r.origin[1] + r.dir[1] * t, r.origin[2] + r.dir[2] * t];
}

/** Distance along the ray to the horizontal plane z = h (null if parallel or behind). */
export function rayPlaneZ(r: Ray, h: number): number | null {
  if (Math.abs(r.dir[2]) < 1e-12) return null;
  const t = (h - r.origin[2]) / r.dir[2];
  return t >= 0 ? t : null;
}

/** Nearest non-negative intersection with a sphere (null on miss). */
export function raySphere(r: Ray, c: V3, radius: number): number | null {
  const ox = r.origin[0] - c[0];
  const oy = r.origin[1] - c[1];
  const oz = r.origin[2] - c[2];
  const b = ox * r.dir[0] + oy * r.dir[1] + oz * r.dir[2];
  const cc = ox * ox + oy * oy + oz * oz - radius * radius;
  const disc = b * b - cc;
  if (disc < 0) return null;
  const s = Math.sqrt(disc);
  const t0 = -b - s;
  if (t0 >= 0) return t0;
  const t1 = -b + s;
  return t1 >= 0 ? t1 : null;
}

/** Closest approach of a ray to a point: parameter t (clamped ≥ 0) and the distance. */
export function rayPointDistance(r: Ray, p: V3): { t: number; d: number } {
  const t = Math.max(0, (p[0] - r.origin[0]) * r.dir[0] + (p[1] - r.origin[1]) * r.dir[1] + (p[2] - r.origin[2]) * r.dir[2]);
  const q = rayAt(r, t);
  return { t, d: Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) };
}

// ---------------------------------------------------------------------------------------------
// Quaternions
// ---------------------------------------------------------------------------------------------
export const quatIdentity = (): Quat => [0, 0, 0, 1];

/** Hamilton product a ⊗ b (rotate by b first, then a). */
export function quatMultiply(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz];
}

export function quatNormalize(q: Quat): Quat {
  const l = Math.hypot(q[0], q[1], q[2], q[3]);
  return l > 0 ? [q[0] / l, q[1] / l, q[2] / l, q[3] / l] : [0, 0, 0, 1];
}

/** Rotation of `angle` radians about a (not necessarily unit) axis. */
export function quatFromAxisAngle(axis: V3, angle: number): Quat {
  const n = v3norm(axis);
  if (n[0] === 0 && n[1] === 0 && n[2] === 0) return [0, 0, 0, 1];
  const s = Math.sin(angle / 2);
  return [n[0] * s, n[1] * s, n[2] * s, Math.cos(angle / 2)];
}

export function quatRotate(q: Quat, v: V3): V3 {
  const [x, y, z, w] = q;
  // t = 2 q.xyz × v; v' = v + w t + q.xyz × t
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}

/** Column-major 3×3 rotation matrix (as a GLSL mat3 uniform). */
export function mat3FromQuat(out: Float32Array, q: Quat): Float32Array {
  const [x, y, z, w] = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  out[0] = 1 - (yy + zz);
  out[1] = xy + wz;
  out[2] = xz - wy;
  out[3] = xy - wz;
  out[4] = 1 - (xx + zz);
  out[5] = yz + wx;
  out[6] = xz + wy;
  out[7] = yz - wx;
  out[8] = 1 - (xx + yy);
  return out;
}

/** Quaternion of the rotation whose columns (images of the local x, y, z axes) are given. */
export function quatFromAxes(x: V3, y: V3, z: V3): Quat {
  const m00 = x[0], m10 = x[1], m20 = x[2];
  const m01 = y[0], m11 = y[1], m21 = y[2];
  const m02 = z[0], m12 = z[1], m22 = z[2];
  const tr = m00 + m11 + m22;
  let q: Quat;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, 0.25 * s];
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    q = [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    q = [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s];
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    q = [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s];
  }
  return quatNormalize(q);
}

export function quatSlerp(a: Quat, b: Quat, t: number): Quat {
  let [bx, by, bz, bw] = b;
  let cos = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
  if (cos < 0) {
    cos = -cos;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  if (cos > 0.9995) return quatNormalize([a[0] + (bx - a[0]) * t, a[1] + (by - a[1]) * t, a[2] + (bz - a[2]) * t, a[3] + (bw - a[3]) * t]);
  const th = Math.acos(cos);
  const s = Math.sin(th);
  const wa = Math.sin((1 - t) * th) / s;
  const wb = Math.sin(t * th) / s;
  return [a[0] * wa + bx * wb, a[1] * wa + by * wb, a[2] * wa + bz * wb, a[3] * wa + bw * wb];
}

// ---------------------------------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------------------------------
export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
/** Smooth deceleration close to the design-system curve cubic-bezier(.2,.8,.2,1). */
export const easeOutCubic = (t: number): number => 1 - Math.pow(1 - clamp01(t), 3);
export const easeInOutCubic = (t: number): number => {
  const x = clamp01(t);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
};
/** Shortest signed angular difference b − a in (−π, π]. */
export function angleDelta(a: number, b: number): number {
  let d = (b - a) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d <= -Math.PI) d += 2 * Math.PI;
  return d;
}
