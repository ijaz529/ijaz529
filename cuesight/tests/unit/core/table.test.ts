import { describe, expect, it } from 'vitest';
import { TABLE_PRESETS, clampToTable, makeTable } from '../../../src/core/table';
import type { TablePresetId } from '../../../src/core/types';
import { dist, v2 } from '../../../src/core/vec';

const ids = Object.keys(TABLE_PRESETS) as TablePresetId[];

describe('table presets', () => {
  it.each(ids)('%s has sane geometry', (id) => {
    const t = makeTable(id);
    expect(t.length).toBeGreaterThan(t.width);
    expect(t.cornerMouth).toBeGreaterThan(2 * t.ballRadius);
    expect(t.sideMouth).toBeGreaterThan(2 * t.ballRadius);
    expect(t.pockets).toHaveLength(6);
    expect(t.cushions).toHaveLength(6);
    for (const p of t.pockets) {
      const mouth = dist(p.jawA, p.jawB);
      expect(mouth).toBeCloseTo(p.kind === 'corner' ? t.cornerMouth : t.sideMouth, 9);
      // Jaws lie on the nose rectangle.
      for (const j of [p.jawA, p.jawB]) {
        const onX = Math.abs(Math.abs(j.x) - t.length / 2) < 1e-12;
        const onY = Math.abs(Math.abs(j.y) - t.width / 2) < 1e-12;
        expect(onX || onY).toBe(true);
      }
      // Inward vector points toward the centre.
      expect(p.inward.x * -p.mouthCenter.x + p.inward.y * -p.mouthCenter.y).toBeGreaterThan(0);
    }
    // Cushions chain jaw to jaw and have inward normals.
    for (const c of t.cushions) {
      const mid = v2((c.a.x + c.b.x) / 2, (c.a.y + c.b.y) / 2);
      expect(-mid.x * c.n.x - mid.y * c.n.y).toBeGreaterThan(0);
    }
  });

  it('9-ft playing surface is 100" × 50"', () => {
    const t = makeTable('pool9');
    expect(t.length).toBeCloseTo(2.54, 3);
    expect(t.width).toBeCloseTo(1.27, 3);
    expect(t.ballRadius * 2).toBeCloseTo(0.05715, 5);
  });

  it('clamps ball centres inside cushions', () => {
    const t = makeTable('pool9');
    const p = clampToTable(t, v2(5, -5));
    expect(p.x).toBeCloseTo(t.length / 2 - t.ballRadius);
    expect(p.y).toBeCloseTo(-(t.width / 2 - t.ballRadius));
  });

  it('accepts overrides', () => {
    const t = makeTable('pool9', { cornerMouth: 0.12 });
    expect(dist(t.pockets[0]!.jawA, t.pockets[0]!.jawB)).toBeCloseTo(0.12);
  });
});
