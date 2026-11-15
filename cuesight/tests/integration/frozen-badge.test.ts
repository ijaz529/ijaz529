/**
 * Final-walkthrough polish (fix2c): honest difficulty for a cue ball frozen to the object ball.
 *
 * - The badge rates a frozen plan by the stroke-angle tolerance its own search has (the stroke
 *   angles either side of the one shown whose object ball still leaves inside the pocket window, at
 *   the stroke's speed and tip): the cue-ball direction tolerance, the same unit as any other shot's
 *   aim tolerance. It was the line of centres' margin of throw (as if the cue ball were 2R away),
 *   which rated a frozen ball 4° off the line at power 6 "easy · ±0.5 mm" next to "no stroke angle
 *   throws the object ball … the best still misses".
 * - A plan that misses as played (ob-missed, throw-uncompensable) or that no power works for
 *   (noWorkingPower, or out of reach even at full power) has no margin: never easy or medium.
 * - The 'frozen' instruction never tells the player to stroke at an angle "to throw it toward the
 *   pocket" when no angle does: it says that angle is the closest it gets.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, physicsFor } from '../../src/app/settings';
import { simulate } from '../../src/core/physics/simulate';
import { strikeBall } from '../../src/core/physics/strike';
import { difficultyOf } from '../../src/core/shot/coach';
import { planShot } from '../../src/core/shot/planner';
import { powerToSpeed } from '../../src/core/shot/power';
import { suggestShots } from '../../src/core/shot/suggest';
import { makeTable } from '../../src/core/table';
import type { Ball, PocketId, ShotPlan, Stroke, TableLayout, Vec2 } from '../../src/core/types';
import { angleBetween, angleOf, deg, fromAngle, rad } from '../../src/core/vec';

const params = physicsFor(DEFAULT_SETTINGS);
const T = makeTable('pool9');
const R = T.ballRadius;
const has = (p: ShotPlan, code: string) => p.warnings.some((w) => w.code === code);
const msg = (p: ShotPlan, code: string) => p.warnings.find((w) => w.code === code)?.message ?? '';

/** Cue ball touching the object ball, the line of centres `offDeg` off the line to the pocket mouth. */
function frozenLayout(ob: Vec2, pocket: PocketId, offDeg: number): TableLayout {
  const m = T.pockets.find((p) => p.id === pocket)!.mouthCenter;
  const a = Math.atan2(m.y - ob.y, m.x - ob.x) + rad(offDeg);
  const d = 2 * R + 0.0003;
  const balls: Ball[] = [
    { id: 'cue', kind: 'cue', pos: { x: ob.x - d * Math.cos(a), y: ob.y - d * Math.sin(a) }, label: 'cue' },
    { id: 'b1', kind: 'object', pos: ob, label: '1' },
  ];
  return { table: T, balls, source: 'virtual', frozen: false };
}

/** Object-ball departure (deg) off plan.obDir with the cue ball stroked along `a` (rad) with the plan's stroke. */
function departureDeg(lay: TableLayout, plan: ShotPlan, a: number): number {
  const cue = lay.balls.find((b) => b.kind === 'cue')!;
  const ob = lay.balls.find((b) => b.id === plan.targetId)!;
  const st = strikeBall(fromAngle(a), powerToSpeed(plan.stroke.power), plan.stroke.side, plan.stroke.vert, R, params.squirtMassRatio);
  const sim = simulate(lay.table, [{ id: cue.id, pos: cue.pos, vel: st.vel, omega: st.omega }, { id: ob.id, pos: ob.pos }], params, {
    record: false,
    stopOnFirstHitOf: ob.id,
  });
  const hit = sim.firstHits[ob.id];
  return hit && hit.other === cue.id ? deg(angleBetween(plan.obDir, fromAngle(angleOf(hit.vel)))) : Infinity;
}

const OB = { x: 0.55, y: 0.18 };
const plan = (off: number, stroke?: Stroke, pocket: PocketId = 'BL') => {
  const lay = frozenLayout(OB, pocket, off);
  return { lay, p: planShot(lay, { targetId: 'b1', pocketId: pocket, ...(stroke ? { stroke } : {}) }, params) };
};

describe('frozen cue ball: the badge is the stroke-angle tolerance the search has', () => {
  it('4° off the line at power 6: no stroke angle throws it in, so no margin and never easy or medium', () => {
    const { p } = plan(-4, { power: 6, side: 0, vert: 0 });
    expect(p.makeable).toBe(true);
    expect(msg(p, 'throw-uncompensable')).toMatch(/no stroke angle throws/);
    expect(['easy', 'medium']).not.toContain(p.difficulty);
    expect(p.toleranceDeg).toBe(0);
    expect(p.toleranceMm).toBe(0);
  });

  it('too soft with no power that works (noWorkingPower): never easy or medium', () => {
    const { p } = plan(-4, { power: 1, side: 0, vert: 0.4 });
    expect(p.noWorkingPower).toBe('throw');
    expect(['easy', 'medium']).not.toContain(p.difficulty);
    expect(p.toleranceDeg).toBe(0);
  });

  for (const off of [0, -2, -4, 2])
    it(`a potting frozen plan (${off}° off): the tolerance is the stroke angle's, measured either side of the stroke shown`, () => {
      const { lay, p } = plan(off);
      expect(p.makeable).toBe(true);
      expect(p.obPocketed).toBe(true);
      expect(has(p, 'throw-uncompensable') || has(p, 'ob-missed')).toBe(false);
      const tol = p.toleranceDeg;
      expect(tol).toBeGreaterThan(0);
      expect(p.difficulty).toBe(difficultyOf(tol));
      const half = p.windowHalfDeg;
      const a = angleOf(p.aimDir);
      // A stroke angle 0.9·tol either way still sends the object ball inside the window…
      for (const s of [1, -1]) expect(Math.abs(departureDeg(lay, p, a + s * rad(0.9 * tol))), `side ${s}`).toBeLessThanOrEqual(half);
      // …and 1.15·tol on one side does not (the figure is the nearer edge, not a lower bound far inside it).
      const out = [1, -1].map((s) => Math.abs(departureDeg(lay, p, a + s * rad(1.15 * tol))) > half);
      expect(out.some(Boolean)).toBe(true);
    });

  it('suggestions show the same tolerance, difficulty and unit as the plan they open (frozen flagged)', () => {
    const lay = frozenLayout(OB, 'BL', -2);
    const s = suggestShots(lay, params, 3).find((x) => x.targetId === 'b1' && x.pocketId === 'BL');
    expect(s).toBeDefined();
    const p = planShot(lay, { targetId: 'b1', pocketId: 'BL' }, params, { record: false, advice: false });
    expect(s!.frozen).toBe(true);
    expect(s!.toleranceDeg).toBeCloseTo(p.toleranceDeg, 9);
    expect(s!.toleranceMm).toBeCloseTo(p.toleranceMm, 9);
    expect(s!.difficulty).toBe(p.difficulty);
  });
});

describe('a plan that misses as played is never rated easy or medium (any shot)', () => {
  it('a sweep of frozen plans: every one that misses or has no working power has no margin', () => {
    let misses = 0;
    let pots = 0;
    for (const pk of ['BL', 'TL', 'BM'] as PocketId[])
      for (let off = -10; off <= 10; off += 2)
        for (const power of [2, 4, 6])
          for (const vert of [0, 0.4]) {
            const { p } = plan(off, { power, side: 0, vert }, pk);
            if (!p.makeable) continue;
            const bad = has(p, 'ob-missed') || has(p, 'throw-uncompensable') || p.noWorkingPower !== undefined;
            const where = `${pk} ${off}° power ${power} vert ${vert}: ${p.difficulty} ±${p.toleranceDeg.toFixed(3)}°`;
            if (bad) {
              misses++;
              expect(['easy', 'medium'], where).not.toContain(p.difficulty);
              expect(p.toleranceDeg, where).toBe(0);
            } else if (p.obPocketed) {
              pots++;
              expect(p.difficulty, where).toBe(difficultyOf(p.toleranceDeg));
            }
          }
    expect(misses).toBeGreaterThan(10);
    expect(pots).toBeGreaterThan(10);
  });
});

describe("the 'frozen' instruction when no stroke angle throws it in", () => {
  it('says the angle is the closest it gets, never "to throw it toward the pocket"', () => {
    const { p } = plan(-4, { power: 6, side: 0, vert: 0 });
    const f = msg(p, 'frozen');
    expect(f).not.toMatch(/to throw it toward the pocket/);
    expect(f).toMatch(/stroke \d+° to the (left|right) of it/);
    expect(f).toMatch(/closest it gets/);
  });

  it('a sweep: throw-uncompensable never sits next to "stroke N° … to throw it toward the pocket"', () => {
    let closest = 0;
    let thrown = 0;
    for (const pk of T.pockets.map((x) => x.id))
      for (let off = -12; off <= 12; off += 2)
        for (const power of [2, 4, 6])
          for (const vert of [0, 0.4]) {
            const { p } = plan(off, { power, side: 0, vert }, pk);
            if (!p.makeable) continue;
            const f = msg(p, 'frozen');
            const where = `${pk} ${off}° power ${power} vert ${vert}: ${f} | ${msg(p, 'throw-uncompensable')}`;
            if (has(p, 'throw-uncompensable')) expect(f, where).not.toMatch(/to throw it toward the pocket/);
            if (/closest it gets/.test(f)) closest++;
            if (/to throw it toward the pocket/.test(f)) thrown++;
          }
    expect(closest).toBeGreaterThan(10);
    expect(thrown).toBeGreaterThan(10);
  });
});
