/**
 * The tip unit and the spin words (src/core/shot/power.ts, describeSpin / tipsText): 1 tip = ¼ of the
 * ball radius of offset, so the miscue limit (0.5 R, analytic.ts MISCUE_LIMIT) is 2 tips; the words are
 * the nearest quarter tip, singular up to one tip and plural above ("1 tip", "1½ tips", "2 tips").
 */
import { describe, expect, it } from 'vitest';
import { MISCUE_LIMIT } from '../../../src/core/physics/analytic';
import { describeSpin, TIP_FRACTION, tipsText } from '../../../src/core/shot/power';

describe('tip unit: 1 tip = ¼ R, the miscue limit is 2 tips', () => {
  it('TIP_FRACTION is a quarter of the radius and the miscue limit is two of them', () => {
    expect(TIP_FRACTION).toBe(0.25);
    expect(MISCUE_LIMIT / TIP_FRACTION).toBe(2);
    expect(tipsText(MISCUE_LIMIT)).toBe('2 tips');
  });

  it('the nearest quarter tip, singular up to one tip, plural above it', () => {
    const cases: [number, string][] = [
      [0.0625, '¼ tip'],
      [0.125, '½ tip'],
      [0.1875, '¾ tip'],
      [0.25, '1 tip'],
      [0.3125, '1¼ tips'],
      [0.375, '1½ tips'],
      [0.4375, '1¾ tips'],
      [0.5, '2 tips'],
    ];
    for (const [frac, words] of cases) {
      expect(tipsText(frac), String(frac)).toBe(words);
      expect(tipsText(-frac), String(-frac)).toBe(words); // the direction is said by describeSpin
    }
    // Rounds to the nearest quarter: 0.27 R is 1.08 tips → "1 tip"; 0.4 R is 1.6 tips → "1½ tips".
    expect(tipsText(0.27)).toBe('1 tip');
    expect(tipsText(0.4)).toBe('1½ tips');
    expect(tipsText(0.47)).toBe('2 tips');
    // Past the miscue limit (clamped elsewhere) it never says more than 2 tips.
    expect(tipsText(0.6)).toBe('2 tips');
  });
});

describe('describeSpin: where to strike, in the one vocabulary of the whole app', () => {
  it('centre ball below the 0.04 R threshold on both axes', () => {
    expect(describeSpin({ side: 0, vert: 0 })).toBe('centre ball');
    expect(describeSpin({ side: 0.039, vert: -0.039 })).toBe('centre ball');
  });

  it('height first, then side, with plurals above one tip', () => {
    expect(describeSpin({ side: 0, vert: 0.5 })).toBe('2 tips above centre'); // the Follow limit
    expect(describeSpin({ side: 0, vert: -0.4 })).toBe('1½ tips below centre'); // the Draw preset
    expect(describeSpin({ side: 0, vert: 0.4 })).toBe('1½ tips above centre'); // the Follow preset
    expect(describeSpin({ side: -0.25, vert: 0 })).toBe('1 tip left'); // the Left preset
    expect(describeSpin({ side: 0.25, vert: 0 })).toBe('1 tip right');
    expect(describeSpin({ side: 0.3, vert: -0.125 })).toBe('½ tip below centre, 1¼ tips right');
    expect(describeSpin({ side: -0.5, vert: 0.25 })).toBe('1 tip above centre, 2 tips left');
  });

  it('one axis only when the other is under the threshold', () => {
    expect(describeSpin({ side: 0.02, vert: 0.25 })).toBe('1 tip above centre');
    expect(describeSpin({ side: -0.125, vert: 0.03 })).toBe('½ tip left');
  });

  it('never says "tip" for more than one tip, or "tips" for one or less', () => {
    for (let side = -0.5; side <= 0.5001; side += 0.01)
      for (const vert of [-0.5, -0.3, 0, 0.2, 0.5]) {
        const s = describeSpin({ side, vert });
        for (const m of s.matchAll(/(¼|½|¾|1¼|1½|1¾|1|2) (tips?)\b/g)) {
          const n = { '¼': 0.25, '½': 0.5, '¾': 0.75, '1': 1, '1¼': 1.25, '1½': 1.5, '1¾': 1.75, '2': 2 }[m[1] as '1']!;
          expect(m[2], s).toBe(n > 1 ? 'tips' : 'tip');
        }
      }
  });
});
