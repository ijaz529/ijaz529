import { describe, expect, it } from 'vitest';
import { DEFAULT_PHYSICS } from '../../src/core/physics/params';
import { planShot } from '../../src/core/shot/planner';
import { nextShotQuality, positionHeatmap, recommendStroke } from '../../src/core/shot/position';
import { makeTable, pocketById } from '../../src/core/table';
import { add, scale, v2 } from '../../src/core/vec';
import { layout } from '../helpers/layout';

const P = DEFAULT_PHYSICS;
const T = makeTable('pool9');

describe('position play', () => {
  const tr = pocketById(T, 'TR');
  const ob = add(tr.mouthCenter, scale(tr.inward, 0.5));
  const cue = add(tr.mouthCenter, scale(tr.inward, 1.0));

  it('lands near a spot reachable with draw, using below-centre spin', () => {
    // Straight-in: a spot back toward the shooter needs draw.
    const landing = add(tr.mouthCenter, scale(tr.inward, 0.85));
    const lay = layout({ cue, ob });
    const rec = recommendStroke(lay, { targetId: 'ob', pocketId: 'TR' }, P, { landing });
    expect(rec.reachable).toBe(true);
    expect(rec.stroke.vert).toBeLessThan(0);
    expect(rec.restError!).toBeLessThan(0.15);
    console.log(`draw-to-spot: stroke ${JSON.stringify(rec.stroke)}, error ${(rec.restError! * 100).toFixed(1)} cm, ${rec.evaluated} sims`);
  });

  it('reports an unreachable spot honestly and still returns a safe stroke', () => {
    const lay = layout({ cue, ob });
    const rec = recommendStroke(lay, { targetId: 'ob', pocketId: 'TR' }, P, { landing: v2(-1.2, 0.6) });
    expect(rec.reachable).toBe(false);
    const plan = planShot(lay, { targetId: 'ob', pocketId: 'TR', stroke: rec.stroke }, P);
    expect(plan.scratch).toBe(false);
    expect(plan.obPocketed).toBe(true);
  });

  it('default recommendation leaves a better next shot than centre ball', () => {
    const lay = layout({ cue, ob, next: v2(-0.6, -0.35) });
    const rec = recommendStroke(lay, { targetId: 'ob', pocketId: 'TR' }, P, { budgetMs: 3000 });
    const plain = planShot(lay, { targetId: 'ob', pocketId: 'TR' }, P);
    const recPlan = planShot(lay, { targetId: 'ob', pocketId: 'TR', stroke: rec.stroke }, P);
    const q = (p: typeof plain) => (p.cueRest ? nextShotQuality(lay, p.cueRest, ['ob']) : 0);
    expect(q(recPlan)).toBeGreaterThanOrEqual(q(plain));
    expect(recPlan.scratch).toBe(false);
  });

  it('heatmap is 0..1 and highest in line with the next ball and a pocket', () => {
    const lay = layout({ cue, ob, next: v2(0.6, 0.3) });
    const cols = 40;
    const rows = 20;
    const hm = positionHeatmap(lay, 'next', cols, rows, ['ob']);
    expect(Math.max(...hm)).toBeLessThanOrEqual(1);
    expect(Math.min(...hm)).toBeGreaterThanOrEqual(0);
    // A spot straight behind 'next' on the line to TR beats a spot beyond it.
    const toTR = add(v2(0.6, 0.3), scale({ x: tr.mouthCenter.x - 0.6, y: tr.mouthCenter.y - 0.3 }, -0.6));
    const beyond = v2(1.05, 0.55);
    const at = (p: { x: number; y: number }) => {
      const hx = T.length / 2 - T.ballRadius;
      const hy = T.width / 2 - T.ballRadius;
      const i = Math.min(cols - 1, Math.floor(((p.x + hx) / (2 * hx)) * cols));
      const j = Math.min(rows - 1, Math.floor(((p.y + hy) / (2 * hy)) * rows));
      return hm[j * cols + i]!;
    };
    expect(at(toTR)).toBeGreaterThan(at(beyond));
  });
});
