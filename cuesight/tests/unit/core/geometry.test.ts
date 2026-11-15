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
  it('fraction labels are never more than 2° off the real cut without saying thick/thin (coarse-fraction-labels)', () => {
    const REFS: Record<string, number> = { full: 1, '⅞': 7 / 8, '¾': 3 / 4, '⅝': 5 / 8, '½': 1 / 2, '⅜': 3 / 8, '¼': 1 / 4, '⅛': 1 / 8 };
    const refCut = (f: number) => deg(Math.asin(1 - f));
    for (let c = 0; c <= 80; c += 0.25) {
      const { label } = fractionOf(rad(c));
      const m = /^(thick |thin )?(.+)$/.exec(label)!;
      const qual = m[1]?.trim();
      const ref = m[2]!;
      if (ref === 'thin') {
        // Catch-all for very thin hits: only used beyond the ⅛-ball cut.
        expect(qual, `${c}°`).toBeUndefined();
        expect(c, `${c}° labelled thin`).toBeGreaterThan(refCut(1 / 8) + 2);
        continue;
      }
      expect(REFS[ref], `${c}° → ${label}`).toBeDefined();
      const rc = refCut(REFS[ref]!);
      if (!qual) expect(Math.abs(c - rc), `${c}° → ${label} (ref ${rc.toFixed(1)}°)`).toBeLessThanOrEqual(2 + 1e-9);
      else if (qual === 'thin') expect(c, `${c}° → ${label}`).toBeGreaterThan(rc);
      else expect(c, `${c}° → ${label}`).toBeLessThan(rc);
    }
    for (const c of [7.2, 22]) expect(['full', '¾']).not.toContain(fractionOf(rad(c)).label);
    expect(fractionOf(rad(30)).label).toBe('½');
    expect(fractionOf(rad(40)).label).not.toBe('¼'); // a 40° cut is not a ¼-ball (48.6°) hit
    expect(fractionOf(rad(1)).label).toBe('full'); // ≥ 97 % overlap, as the fraction glyph says
    expect(fractionOf(rad(3)).label).not.toBe('full');
  });
});
