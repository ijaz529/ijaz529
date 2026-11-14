import { describe, expect, it } from 'vitest';
import { DEFAULT_PHYSICS } from '../../src/core/physics/params';
import { planShot } from '../../src/core/shot/planner';
import { makeTable, pocketById } from '../../src/core/table';
import type { Stroke } from '../../src/core/types';
import { add, dist, scale } from '../../src/core/vec';
import { layout } from '../helpers/layout';

const P = DEFAULT_PHYSICS;
const T = makeTable('pool9');
const tr = pocketById(T, 'TR');
const ob = add(tr.mouthCenter, scale(tr.inward, 0.5));
const cue = add(tr.mouthCenter, scale(tr.inward, 0.85));
const lay = layout({ cue, ob });
const plan = (stroke: Stroke) => planShot(lay, { targetId: 'ob', pocketId: 'TR', stroke }, P);

describe('player stroke overrides (US3)', () => {
  it('draw reverses the cue ball, follow sends it forward (straight-in)', () => {
    const draw = plan({ power: 5, side: 0, vert: -0.45 });
    const follow = plan({ power: 4, side: 0, vert: 0.4 });
    const ghost = draw.ghost;
    // Distance from the pocket: draw ends farther from the pocket than the contact point; follow nearer.
    const fromPocket = (p: { x: number; y: number } | null) => (p ? dist(p, tr.mouthCenter) : 0);
    expect(fromPocket(draw.cueRest)).toBeGreaterThan(fromPocket(ghost) + 0.05);
    expect(follow.scratch || fromPocket(follow.cueRest) < fromPocket(ghost) - 0.05).toBe(true);
  });

  it('more power never shortens the cue ball’s travel (until collisions/pockets end it)', () => {
    let prev = 0;
    for (const power of [2, 3, 4, 5, 6]) {
      const p = plan({ power, side: 0, vert: 0.1 });
      const pts = p.cuePath.points;
      let travel = 0;
      for (let i = 1; i < pts.length; i++) travel += dist(pts[i - 1]!, pts[i]!);
      if (p.scratch) break;
      expect(travel).toBeGreaterThanOrEqual(prev - 1e-3);
      prev = travel;
    }
  });

  it('side spin adds a squirt correction and changes throw', () => {
    const none = plan({ power: 4, side: 0, vert: 0 });
    const right = plan({ power: 4, side: 0.3, vert: 0 });
    expect(none.squirtDeg).toBe(0);
    expect(right.squirtDeg).toBeGreaterThan(0.5);
    expect(right.throwDeg).not.toBeCloseTo(none.throwDeg, 2);
  });

  it('flags a stroke that is too soft', () => {
    const far = layout({ cue: add(tr.mouthCenter, scale(tr.inward, 1.3)), ob: add(tr.mouthCenter, scale(tr.inward, 1.0)) });
    const p = planShot(far, { targetId: 'ob', pocketId: 'TR', stroke: { power: 1, side: 0, vert: -0.3 } }, P);
    expect(p.warnings.some((w) => w.code === 'too-soft')).toBe(true);
  });
});
