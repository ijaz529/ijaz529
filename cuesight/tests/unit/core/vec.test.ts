import { describe, expect, it } from 'vitest';
import { angleBetween, cross, dist, norm, perp, pointSegment, rotate, v2 } from '../../../src/core/vec';

describe('vec', () => {
  it('rotates counter-clockwise', () => {
    const r = rotate(v2(1, 0), Math.PI / 2);
    expect(r.x).toBeCloseTo(0, 12);
    expect(r.y).toBeCloseTo(1, 12);
  });
  it('signed angle and cross agree', () => {
    expect(angleBetween(v2(1, 0), v2(0, 1))).toBeCloseTo(Math.PI / 2, 12);
    expect(angleBetween(v2(1, 0), v2(0, -1))).toBeCloseTo(-Math.PI / 2, 12);
    expect(cross(v2(1, 0), v2(0, 1))).toBe(1);
  });
  it('normalises and perpendiculars', () => {
    const n = norm(v2(3, 4));
    expect(n.x).toBeCloseTo(0.6);
    expect(perp(v2(1, 0))).toEqual({ x: -0, y: 1 });
    expect(norm(v2(0, 0))).toEqual({ x: 0, y: 0 });
  });
  it('point–segment distance clamps to ends', () => {
    expect(pointSegment(v2(0, 1), v2(-1, 0), v2(1, 0)).d).toBeCloseTo(1);
    const r = pointSegment(v2(3, 0), v2(-1, 0), v2(1, 0));
    expect(r.d).toBeCloseTo(2);
    expect(r.t).toBe(1);
    expect(dist(v2(0, 0), v2(3, 4))).toBe(5);
  });
});
