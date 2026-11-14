import { describe, expect, it } from 'vitest';
import { clampTip, strikeBall } from '../../../src/core/physics/strike';
import { angleBetween, v2 } from '../../../src/core/vec';

const R = 0.028575;

describe('cue strike', () => {
  it('2/5 R above centre gives natural roll (no slip)', () => {
    const r = strikeBall(v2(1, 0), 2, 0, 0.4, R, 23);
    const ux = r.vel.x - R * r.omega.y;
    const uy = r.vel.y + R * r.omega.x;
    expect(Math.hypot(ux, uy)).toBeLessThan(1e-12);
  });
  it('ω = 5/2·v·b/R² for vertical and side offsets', () => {
    const v = 3;
    const r = strikeBall(v2(0, 1), v, 0.3, -0.2, R, 23);
    // travel +y, draw: ω about −x axis → wx positive? rolling forward along +y requires wx = −v/R.
    expect(r.omega.x).toBeCloseTo((2.5 * v * 0.2) / R, 9); // draw = backward roll sense
    expect(r.omega.z).toBeCloseTo((2.5 * v * 0.3) / R, 9);
  });
  it('clamps offsets radially to the miscue limit', () => {
    const c = clampTip(0.6, 0.8);
    expect(Math.hypot(c.side, c.vert)).toBeCloseTo(0.5, 12);
    expect(c.vert / c.side).toBeCloseTo(0.8 / 0.6, 12);
  });
  it('compensates squirt: right english → cue aimed right (clockwise) of travel line', () => {
    const r = strikeBall(v2(1, 0), 2, 0.4, 0, R, 23);
    expect(r.squirtRad).toBeGreaterThan(0);
    expect(angleBetween(v2(1, 0), r.cueDir)).toBeCloseTo(-r.squirtRad, 12);
  });
});
