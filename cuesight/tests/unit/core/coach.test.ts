import { describe, expect, it } from 'vitest';
import { DEFAULT_PHYSICS } from '../../../src/core/physics/params';
import { coachingTip, contactSpinOf, type TipInput } from '../../../src/core/shot/coach';
import { planShot } from '../../../src/core/shot/planner';
import { pocketWindow } from '../../../src/core/shot/pocket-window';
import { makeTable, pocketById } from '../../../src/core/table';
import { angleOf, fromAngle, rad, scale, sub, v2 } from '../../../src/core/vec';
import { layout } from '../../helpers/layout';

const base: TipInput = {
  cutDeg: 25,
  contact: 'follow',
  throwDeg: 0,
  throwShiftMm: 0,
  squirtDeg: 0,
  side: 0,
  scratch: false,
  blocked: false,
  makeable: true,
};

describe('coachingTip', () => {
  it('squirt: never claims the correction is already in the drawn line; names the cue side', () => {
    const T = makeTable('pool9');
    const R = T.ballRadius;
    const ob = v2(0.4, 0.15);
    const w = pocketWindow(ob, pocketById(T, 'TR'), R);
    const cue = sub(sub(ob, scale(w.dir, 2 * R)), scale(fromAngle(angleOf(w.dir) + rad(25)), 0.7));
    for (const side of [0.3, -0.3]) {
      const plan = planShot(layout({ cue, ob }), { targetId: 'ob', pocketId: 'TR', stroke: { power: 4, side, vert: 0.1 } }, DEFAULT_PHYSICS);
      expect(plan.tip).not.toMatch(/already in the line shown/);
      const dir = plan.squirtDeg > 0 ? 'right' : 'left';
      expect(dir).toBe(side > 0 ? 'right' : 'left');
      expect(plan.tip).toMatch(new RegExp(`aim the cue ${Math.abs(plan.squirtDeg).toFixed(1)}° to the ${dir} of the line shown`));
      expect(plan.tip).toMatch(/where the cue ball travels/);
      expect(plan.tip).toMatch(/mm at the ghost ball/);
    }
    // Direct input: the mm figure is the lateral offset at the ghost ball.
    const t = coachingTip({ ...base, squirtDeg: 2, side: 0.4, cbDistance: 1 });
    expect(t).toMatch(/≈34\.9 mm at the ghost ball/);
    expect(t).not.toMatch(/already in the line shown/);
  });

  it("the cue ball doesn't reach the object ball: no stun / stop-shot wording", () => {
    expect(contactSpinOf(0, 0)).toBe('none');
    for (const cutDeg of [0, 30]) {
      const t = coachingTip({ ...base, cutDeg, contact: 'none', cbReachesOb: false, minPower: 3.4 });
      expect(t).not.toMatch(/stun/i);
      expect(t).not.toMatch(/stop shot/i);
      expect(t).toMatch(/cue ball stops before it reaches the object ball/);
      expect(t).toMatch(/3\.4\+/);
    }
    // Even if the analytic contact state says 'stun', a cue ball that never arrives is reported as such.
    const t = coachingTip({ ...base, cutDeg: 0, contact: 'stun', cbReachesOb: false, minPower: 2 });
    expect(t).not.toMatch(/stun/i);
  });

  it('throw shift wording follows the direction the ghost actually moved', () => {
    const thin = coachingTip({ ...base, throwDeg: -2, throwShiftMm: 2, shiftDir: 'thinner' });
    expect(thin).toMatch(/pushes the object ball thick, so the ghost ball is shifted 2\.0 mm thinner/);
    const thick = coachingTip({ ...base, side: -0.3, throwDeg: 2, throwShiftMm: 2, shiftDir: 'thicker' });
    expect(thick).toMatch(/throws the object ball thin here, so the ghost ball is shifted 2\.0 mm thicker/);
    expect(thick).not.toMatch(/thinner/);
    const left = coachingTip({ ...base, cutDeg: 0, contact: 'roll', throwDeg: 1.5, throwShiftMm: 1.5, shiftDir: 'left' });
    expect(left).toMatch(/ghost ball is shifted 1\.5 mm to the left/);
    const right = coachingTip({ ...base, cutDeg: 0, contact: 'roll', throwDeg: -1.5, throwShiftMm: 1.5, shiftDir: 'right' });
    expect(right).toMatch(/to the right/);
  });

  it('a blocked shot names the best other pocket, or says none is clear', () => {
    expect(coachingTip({ ...base, blocked: true, altPocketName: 'bottom-right corner' })).toMatch(/Try the bottom-right corner instead, or play a safety/);
    expect(coachingTip({ ...base, blocked: true })).toMatch(/No other pocket is clear/);
  });
});
