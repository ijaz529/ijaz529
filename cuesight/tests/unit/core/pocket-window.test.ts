import { describe, expect, it } from 'vitest';
import { pocketById, makeTable } from '../../../src/core/table';
import { pocketWindow } from '../../../src/core/shot/pocket-window';
import { add, deg, scale, v2 } from '../../../src/core/vec';

const t = makeTable('pool9');
const R = t.ballRadius;

describe('pocket window', () => {
  it('straight-in corner: half-width ≈ (mouth − 2R)/2 / d', () => {
    const p = pocketById(t, 'TR');
    const d = 1;
    const from = add(p.mouthCenter, scale(p.inward, d));
    const w = pocketWindow(from, p, R);
    expect(w.ok).toBe(true);
    expect(w.halfRad).toBeCloseTo(((t.cornerMouth - 2 * R) / 2) / d, 3);
    expect(w.dir.x).toBeCloseTo(-p.inward.x, 6);
    expect(w.distance).toBeCloseTo(d, 6);
  });
  it('side pocket closes at steep approach angles', () => {
    const p = pocketById(t, 'TM');
    const straight = pocketWindow(v2(0, 0), p, R);
    const steep = pocketWindow(v2(1.1, 0.45), p, R);
    expect(straight.ok).toBe(true);
    expect(steep.ok).toBe(false);
    const medium = pocketWindow(v2(0.4, 0), p, R);
    expect(medium.ok).toBe(true);
    expect(medium.halfRad).toBeLessThan(straight.halfRad);
  });
  it('a rail-frozen ball still has a small window down the rail', () => {
    const p = pocketById(t, 'TR');
    const from = v2(0.3, t.width / 2 - R);
    const w = pocketWindow(from, p, R);
    expect(w.ok).toBe(true);
    expect(deg(w.halfRad)).toBeLessThan(1);
    expect(deg(w.halfRad)).toBeGreaterThan(0.05);
  });
  it('a ball on or past the corner mouth line still has a window that faces the pocket (corner-hanger-window-reversed)', () => {
    for (const preset of ['pool9', 'pool8', 'pool7', 'uk7', 'snooker12'] as const) {
      const tb = makeTable(preset);
      const r = tb.ballRadius;
      const hx = tb.length / 2;
      const hy = tb.width / 2;
      for (const p of tb.pockets.filter((q) => q.kind === 'corner')) {
        const spots = [0, -0.005, -0.016].map((d) => add(p.mouthCenter, scale(p.inward, d)));
        spots.push(v2(Math.sign(p.mouthCenter.x) * (hx - r), Math.sign(p.mouthCenter.y) * (hy - r))); // clamp corner
        for (const from of spots) {
          const w = pocketWindow(from, p, r);
          expect(w.ok, `${preset} ${p.id} (${from.x.toFixed(3)}, ${from.y.toFixed(3)})`).toBe(true);
          expect(-(w.dir.x * p.inward.x + w.dir.y * p.inward.y), `${preset} ${p.id} faces the pocket`).toBeGreaterThan(0.9);
          expect(w.halfRad).toBeGreaterThan(0);
        }
      }
    }
    // A ball in front of the mouth line keeps its old window.
    const p = pocketById(t, 'TR');
    const w = pocketWindow(add(p.mouthCenter, scale(p.inward, 0.3)), p, R);
    expect(w.dir.x).toBeCloseTo(-p.inward.x, 9);
    expect(w.distance).toBeCloseTo(0.3, 9);
  });
  it('a near-rail ball can go down the rail but not into the side pocket it is beside', () => {
    expect(pocketWindow(v2(-1.2, 0.6), pocketById(t, 'TR'), R).ok).toBe(true); // 6 mm off the rail: still a window
    expect(pocketWindow(v2(1.0, 0.6), pocketById(t, 'TM'), R).ok).toBe(false); // far too steep for the side
  });
});
