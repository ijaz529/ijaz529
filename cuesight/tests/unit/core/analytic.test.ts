import { describe, expect, it } from 'vitest';
import { rollingDeflection, rollingDistance, squirtAngle, throwAngle } from '../../../src/core/physics/analytic';
import { DEFAULT_PHYSICS } from '../../../src/core/physics/params';
import { deg, rad } from '../../../src/core/vec';

describe('30° rule (rolling cue-ball deflection)', () => {
  it('peaks at ≈33.7° near a 28° cut and is ≈30° across ¼–¾ ball hits', () => {
    let max = 0;
    for (let c = 0; c <= 89; c += 0.5) max = Math.max(max, deg(rollingDeflection(rad(c))));
    expect(max).toBeGreaterThan(33.4);
    expect(max).toBeLessThan(34);
    // ¾-ball (14.5°) … ¼-ball (48.6°) are all within 27°–34°
    for (const c of [14.5, 30, 48.6]) {
      const d = deg(rollingDeflection(rad(c)));
      expect(d).toBeGreaterThan(26.5);
      expect(d).toBeLessThan(34);
    }
    expect(deg(rollingDeflection(rad(30)))).toBeCloseTo(33.7, 1);
  });
});

describe('throw (Alciatore TP A.14)', () => {
  const p = DEFAULT_PHYSICS;
  it('is zero for a full-ball hit without spin', () => {
    expect(throwAngle(0, 1, 0, 0, p)).toBeCloseTo(0, 12);
  });
  it('is 3°–6° for a slow stun half-ball hit and decreases with speed', () => {
    const slow = deg(throwAngle(rad(30), 0.5, 0, 0, p));
    const fast = deg(throwAngle(rad(30), 4, 0, 0, p));
    expect(slow).toBeGreaterThan(3);
    expect(slow).toBeLessThan(6);
    expect(fast).toBeLessThan(slow);
    expect(fast).toBeGreaterThan(0);
  });
  it('is cancelled by "gearing" outside english', () => {
    const v = 1;
    const cut = rad(30);
    expect(throwAngle(cut, v, v * Math.sin(cut), 0, p)).toBeCloseTo(0, 9);
  });
  it('is reduced by follow or draw (vertical slip)', () => {
    const cut = rad(30);
    const stun = throwAngle(cut, 1, 0, 0, p);
    const roll = throwAngle(cut, 1, 0, 1, p);
    expect(roll).toBeLessThan(stun);
  });
});

describe('squirt (Alciatore TP A.31)', () => {
  it('is 1°–3° at half-tip-radius english for a standard shaft, less for low-deflection', () => {
    const std = deg(squirtAngle(0.5, 23));
    const ld = deg(squirtAngle(0.5, 35));
    expect(std).toBeGreaterThan(1);
    expect(std).toBeLessThan(3);
    expect(ld).toBeLessThan(std);
    expect(squirtAngle(0, 23)).toBe(0);
  });
});

describe('rolling distance', () => {
  it('v²/(2 μr g)', () => {
    expect(rollingDistance(1, DEFAULT_PHYSICS)).toBeCloseTo(1 / (2 * 0.01 * 9.81), 9);
  });
});
