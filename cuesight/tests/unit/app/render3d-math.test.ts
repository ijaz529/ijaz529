import { describe, expect, it } from 'vitest';
import {
  angleDelta,
  mat3FromQuat,
  mat4,
  mat4Invert,
  mat4LookAt,
  mat4Multiply,
  mat4Perspective,
  project,
  quatFromAxes,
  quatFromAxisAngle,
  quatMultiply,
  quatRotate,
  rayPlaneZ,
  rayPointDistance,
  raySphere,
  rayAt,
  screenRay,
  unproject,
  type V3,
} from '../../../src/app/render3d/math3d';

const close = (a: ArrayLike<number>, b: ArrayLike<number>, eps = 1e-5) => {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i++) expect(Math.abs(a[i]! - b[i]!)).toBeLessThan(eps);
};

function camera(eye: V3, target: V3, w = 800, h = 600) {
  const view = mat4LookAt(mat4(), eye, target, [0, 0, 1]);
  const proj = mat4Perspective(mat4(), (45 * Math.PI) / 180, w / h, 0.05, 20);
  const vp = mat4Multiply(mat4(), proj, view);
  const inv = mat4Invert(mat4(), vp)!;
  return { vp, inv, w, h };
}

describe('render3d math3d', () => {
  it('inverts matrices (M·M⁻¹ = I)', () => {
    const { vp, inv } = camera([1.2, -2.5, 1.7], [0.1, 0.2, 0]);
    close(mat4Multiply(mat4(), vp, inv), mat4(), 1e-4);
    expect(mat4Invert(mat4(), new Float32Array(16))).toBeNull();
  });

  it('round-trips world → screen → world', () => {
    const { vp, inv, w, h } = camera([0.4, -2, 1.5], [0, 0, 0]);
    for (const p of [
      [0, 0, 0],
      [1.1, 0.5, 0.0286],
      [-1.2, -0.6, 0.04],
    ] as V3[]) {
      const s = project(vp, p, w, h)!;
      expect(s).not.toBeNull();
      const back = unproject(inv, s.x, s.y, s.depth, w, h);
      close(back, p, 1e-3);
    }
  });

  it('returns null for points behind the camera', () => {
    const { vp, w, h } = camera([0, -2, 1], [0, 0, 0]);
    expect(project(vp, [0, -5, 1], w, h)).toBeNull();
  });

  it('screen ray through a projected table point hits that point on the bed', () => {
    const { vp, inv, w, h } = camera([2, -1.5, 1.2], [0, 0, 0]);
    const p: V3 = [0.73, -0.31, 0];
    const s = project(vp, p, w, h)!;
    const ray = screenRay(inv, s.x, s.y, w, h);
    const t = rayPlaneZ(ray, 0)!;
    close(rayAt(ray, t), p, 1e-3);
  });

  it('ray–sphere gives the nearest hit and misses cleanly', () => {
    const ray = { origin: [0, 0, 1] as V3, dir: [0, 0, -1] as V3 };
    expect(raySphere(ray, [0, 0, 0.0286], 0.0286)).toBeCloseTo(1 - 0.0572, 6);
    expect(raySphere(ray, [0.1, 0, 0.0286], 0.0286)).toBeNull();
    expect(rayPointDistance(ray, [0.05, 0, 0]).d).toBeCloseTo(0.05, 9);
    expect(rayPlaneZ({ origin: [0, 0, 1], dir: [0, 0, 1] }, 0)).toBeNull();
  });

  it('quaternions agree with their matrices and compose correctly', () => {
    const q = quatFromAxisAngle([0.3, -0.5, 0.8], 1.1);
    const m = mat3FromQuat(new Float32Array(9), q);
    const v: V3 = [0.2, 0.7, -0.4];
    const byQ = quatRotate(q, v);
    const byM: V3 = [m[0]! * v[0] + m[3]! * v[1] + m[6]! * v[2], m[1]! * v[0] + m[4]! * v[1] + m[7]! * v[2], m[2]! * v[0] + m[5]! * v[1] + m[8]! * v[2]];
    close(byQ, byM, 1e-6);
    // (a ⊗ b) v = a (b v)
    const a = quatFromAxisAngle([0, 0, 1], 0.7);
    close(quatRotate(quatMultiply(a, q), v), quatRotate(a, quatRotate(q, v)), 1e-9);
    // Rotation from axes maps the basis to the given axes.
    const r = quatFromAxes([0, 0, 1], [1, 0, 0], [0, 1, 0]);
    close(quatRotate(r, [1, 0, 0]), [0, 0, 1], 1e-9);
    close(quatRotate(r, [0, 0, 1]), [0, 1, 0], 1e-9);
  });

  it('takes the shortest way round for angles', () => {
    expect(angleDelta(0.1, -0.1)).toBeCloseTo(-0.2, 12);
    expect(angleDelta(3.0, -3.0)).toBeCloseTo(2 * Math.PI - 6, 12);
    expect(Math.abs(angleDelta(-Math.PI / 2, Math.PI))).toBeCloseTo(Math.PI / 2, 12);
  });
});
