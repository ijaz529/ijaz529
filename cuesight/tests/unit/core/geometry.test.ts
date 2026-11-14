import { describe, expect, it } from 'vitest';
import { contactPoint, cutAngle, cutSide, fractionOf, ghostBall } from '../../../src/core/shot/geometry';
import { deg, fromAngle, rad, v2 } from '../../../src/core/vec';

const R = 0.028575;

describe('aiming geometry', () => {
  it('ghost ball sits 2R behind the object ball along the pocket line', () => {
    const g = ghostBall(v2(0, 0), v2(1, 0), R);
    expect(g.x).toBeCloseTo(-2 * R, 12);
    expect(g.y).toBeCloseTo(0, 12);
    expect(contactPoint(v2(0, 0), v2(1, 0), R).x).toBeCloseTo(-R);
  });
  it('cut angle and side', () => {
    const obDir = v2(1, 0);
    const g = ghostBall(v2(0, 0), obDir, R);
    const cue = { x: g.x - Math.cos(rad(30)), y: g.y - Math.sin(rad(30)) };
    expect(deg(cutAngle(cue, g, obDir))).toBeCloseTo(30, 9);
    // CB travels at +30°, OB at 0° → OB is clockwise of the CB line.
    expect(cutSide(cue, g, obDir)).toBe(-1);
    expect(cutSide(v2(-1, 0), g, obDir)).toBe(0);
    const cue2 = { x: g.x - fromAngle(rad(-20)).x, y: g.y - fromAngle(rad(-20)).y };
    expect(cutSide(cue2, g, obDir)).toBe(1);
  });
  it('fractional aim labels', () => {
    expect(fractionOf(0).label).toBe('full');
    expect(fractionOf(rad(30)).fraction).toBeCloseTo(0.5, 9);
    expect(fractionOf(rad(30)).label).toBe('½');
    expect(fractionOf(rad(14.5)).label).toBe('¾');
    expect(fractionOf(rad(48.6)).label).toBe('¼');
    expect(fractionOf(rad(85)).label).toBe('thin');
  });
});
