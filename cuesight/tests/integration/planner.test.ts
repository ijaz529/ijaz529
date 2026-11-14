import { describe, expect, it } from 'vitest';
import { rollingDeflection } from '../../src/core/physics/analytic';
import { DEFAULT_PHYSICS } from '../../src/core/physics/params';
import { planShot, stunVert } from '../../src/core/shot/planner';
import { pocketWindow } from '../../src/core/shot/pocket-window';
import { powerToSpeed } from '../../src/core/shot/power';
import { makeTable, pocketById } from '../../src/core/table';
import type { ShotPlan, Trajectory } from '../../src/core/types';
import { add, angleBetween, angleOf, deg, fromAngle, norm, rad, scale, sub, v2, type Vec2 } from '../../src/core/vec';
import { layout } from '../helpers/layout';

const P = DEFAULT_PHYSICS;
const T = makeTable('pool9');
const R = T.ballRadius;

/** Place the cue ball so the shot of `ob` into `pocketId` has the given cut and CB distance. */
function cutLayout(ob: Vec2, pocketId: 'TR' | 'TM' | 'BR', cutDeg: number, cbDist: number, extra: Record<string, Vec2> = {}) {
  const w = pocketWindow(ob, pocketById(T, pocketId), R);
  const ghost = sub(ob, scale(w.dir, 2 * R));
  const travel = fromAngle(angleOf(w.dir) + rad(cutDeg));
  const cue = sub(ghost, scale(travel, cbDist));
  return { lay: layout({ cue, ob, ...extra }), travel, obDir: w.dir };
}

/** Direction of the cue ball's leg right after the object-ball contact (up to the next event). */
function postContactDir(tr: Trajectory, legs = 1): Vec2 {
  const k = tr.events.findIndex((e) => e.kind === 'ball');
  const a = tr.events[k]!.pos;
  const b = tr.events[k + legs]?.pos ?? tr.points[tr.points.length - 1]!;
  return norm(sub(b, a));
}

const has = (p: ShotPlan, code: string) => p.warnings.some((w) => w.code === code);

describe('planShot', () => {
  it('straight-in: 0° cut, full ball, no throw', () => {
    const pk = pocketById(T, 'TR');
    const ob = add(pk.mouthCenter, scale(pk.inward, 0.6));
    const cue = add(pk.mouthCenter, scale(pk.inward, 1.3));
    const plan = planShot(layout({ cue, ob }), { targetId: 'ob', pocketId: 'TR' }, P);
    expect(plan.makeable).toBe(true);
    expect(plan.cutAngleDeg).toBeLessThan(0.5);
    expect(plan.fractionLabel).toBe('full');
    expect(Math.abs(plan.throwDeg)).toBeLessThan(0.05);
    expect(plan.obPocketed).toBe(true);
    expect(plan.tip).toMatch(/Straight-in/);
  });

  it('30° stun: CB leaves along the tangent line (within 4° for real balls) and names the 90° rule', () => {
    const { lay, obDir } = cutLayout(v2(0.4, 0.15), 'TR', 30, 0.7);
    const power = 6; // firm enough that backspin can wear off exactly at contact over 0.7 m
    const vert = stunVert(0.7, powerToSpeed(power), P);
    expect(vert).toBeGreaterThan(-0.45);
    const plan = planShot(lay, { targetId: 'ob', pocketId: 'TR', stroke: { power, side: 0, vert } }, P);
    expect(plan.makeable).toBe(true);
    expect(plan.obPocketed).toBe(true);
    const d = postContactDir(plan.cuePath);
    // Measure against the actual line of centres at impact (the throw-compensated ghost ball).
    void obDir;
    const ob = lay.balls.find((b) => b.id === 'ob')!.pos;
    const centres = norm(sub(ob, plan.ghost));
    const fromCentres = Math.abs(deg(angleBetween(centres, d)));
    expect(fromCentres).toBeGreaterThan(86);
    expect(fromCentres).toBeLessThan(91);
    expect(plan.tip).toMatch(/90° rule/);
    expect(Math.abs(plan.throwDeg)).toBeGreaterThan(0.5); // stun cuts throw noticeably
  });

  it('30° rolling: CB bends ≈ 30° off its original line and names the 30° rule', () => {
    const { lay, travel } = cutLayout(v2(0.4, 0.15), 'TR', 30, 0.7);
    const plan = planShot(lay, { targetId: 'ob', pocketId: 'TR', stroke: { power: 4, side: 0, vert: 0.4 } }, P);
    expect(plan.obPocketed).toBe(true);
    // After contact: slide (curve) → roll event → straight leg. Measure that straight leg.
    const tr = plan.cuePath;
    const k = tr.events.findIndex((e) => e.kind === 'ball');
    const roll = tr.events.findIndex((e, i) => i > k && e.kind === 'roll');
    const a = tr.events[roll]!.pos;
    const b = tr.events[roll + 1]?.pos ?? tr.points[tr.points.length - 1]!;
    const defl = Math.abs(deg(angleBetween(travel, norm(sub(b, a)))));
    expect(Math.abs(defl - deg(rollingDeflection(rad(30))))).toBeLessThan(4);
    expect(plan.tip).toMatch(/30° rule/);
  });

  it('flags a blocked cue-ball path and names the blocker', () => {
    const { lay } = cutLayout(v2(0.4, 0.15), 'TR', 20, 0.9);
    const cue = lay.balls.find((b) => b.id === 'cue')!.pos;
    const ob = lay.balls.find((b) => b.id === 'ob')!.pos;
    lay.balls.push({ id: 'x', kind: 'object', pos: v2((cue.x + ob.x) / 2, (cue.y + ob.y) / 2), label: '5' });
    const plan = planShot(lay, { targetId: 'ob', pocketId: 'TR' }, P);
    expect(plan.makeable).toBe(false);
    const w = plan.warnings.find((x) => x.code === 'blocked-cue')!;
    expect(w.ballId).toBe('x');
    expect(w.message).toMatch(/5/);
  });

  it('flags a blocked object-ball path', () => {
    const pk = pocketById(T, 'TR');
    const ob = add(pk.mouthCenter, scale(pk.inward, 0.8));
    const blocker = add(pk.mouthCenter, scale(pk.inward, 0.4));
    const cue = add(pk.mouthCenter, scale(pk.inward, 1.5));
    const plan = planShot(layout({ cue, ob, blk: blocker }), { targetId: 'ob', pocketId: 'TR' }, P);
    expect(has(plan, 'blocked-object')).toBe(true);
  });

  it('warns about a scratch (follow into the corner)', () => {
    const pk = pocketById(T, 'TR');
    const ob = add(pk.mouthCenter, scale(pk.inward, 0.25));
    const cue = add(pk.mouthCenter, scale(pk.inward, 0.6));
    const plan = planShot(layout({ cue, ob }), { targetId: 'ob', pocketId: 'TR', stroke: { power: 6, side: 0, vert: 0.4 } }, P);
    expect(plan.scratch).toBe(true);
    expect(has(plan, 'scratch')).toBe(true);
    expect(plan.cueRest).toBeNull();
  });

  it('an ≥88° cut is not makeable and suggests another pocket', () => {
    const ob = v2(0, 0);
    const cue = v2(-0.5, 2 * R);
    const plan = planShot(layout({ cue, ob }), { targetId: 'ob', pocketId: 'BM' }, P);
    expect(plan.makeable).toBe(false);
    const w = plan.warnings.find((x) => x.code === 'not-makeable')!;
    expect(w.message).toMatch(/Try the/);
    expect(plan.alternatives.length).toBeGreaterThan(0);
  });

  it('auto-selects the most forgiving pocket', () => {
    const pk = pocketById(T, 'TR');
    const ob = add(pk.mouthCenter, scale(pk.inward, 0.35));
    const cue = add(pk.mouthCenter, scale(pk.inward, 0.9));
    const plan = planShot(layout({ cue, ob }), { targetId: 'ob' }, P);
    expect(plan.pocketId).toBe('TR');
    expect(plan.difficulty).toBe('easy');
  });

  it('computes minimum power and warns when too soft', () => {
    const ob = v2(-0.2, 0.1);
    const cue = v2(-1.1, -0.3);
    const plan = planShot(layout({ cue, ob }), { targetId: 'ob', pocketId: 'TR', stroke: { power: 1, side: 0, vert: 0 } }, P);
    expect(plan.minPower).toBeGreaterThan(1);
    expect(has(plan, 'too-soft')).toBe(true);
    const ok = planShot(layout({ cue, ob }), { targetId: 'ob', pocketId: 'TR', stroke: { power: Math.ceil(plan.minPower) + 1, side: 0, vert: 0 } }, P);
    expect(has(ok, 'too-soft')).toBe(false);
    expect(ok.obPocketed).toBe(true);
  });

  it('side spin reports squirt and compensates aim', () => {
    const { lay } = cutLayout(v2(0.4, 0.15), 'TR', 25, 0.7);
    const plan = planShot(lay, { targetId: 'ob', pocketId: 'TR', stroke: { power: 4, side: 0.3, vert: 0.1 } }, P);
    expect(plan.squirtDeg).toBeGreaterThan(0.5);
    expect(plan.squirtDeg).toBeLessThan(3);
    expect(plan.obPocketed).toBe(true);
  });

  it('stays fast with a full snooker layout (22 balls)', () => {
    const balls: Record<string, Vec2> = { cue: v2(-1.2, 0.1), t: v2(0.5, 0.2) };
    let k = 0;
    for (let row = 0; row < 5; row++) for (let c = 0; c <= row; c++) balls[`r${k++}`] = v2(1.0 + row * 0.046, (c - row / 2) * 0.054);
    for (let i = 0; i < 5; i++) balls[`c${i}`] = v2(-0.9 + i * 0.3, -0.6 + 0.1 * i);
    const lay = layout(balls, 'snooker12');
    planShot(lay, { targetId: 't' }, P); // warm-up (JIT)
    const runs: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      planShot(lay, { targetId: 't' }, P);
      runs.push(performance.now() - t0);
    }
    runs.sort((a, b) => a - b);
    console.log(`planShot (22 balls) median ${runs[2]!.toFixed(1)} ms`);
    expect(runs[2]!).toBeLessThan(250); // budget 50 ms on device; generous CI guard
  });
});
