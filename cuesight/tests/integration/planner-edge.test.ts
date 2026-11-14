/**
 * Planner edge cases from the deep review: balls frozen to a rail, a cue ball frozen to the object
 * ball, corner hangers, throw compensation next to a rail, cuts past 90°, the "cue ball never
 * arrives" tip and the direction of the throw shift.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_PHYSICS } from '../../src/core/physics/params';
import { simulate } from '../../src/core/physics/simulate';
import { strikeBall } from '../../src/core/physics/strike';
import { planShot } from '../../src/core/shot/planner';
import { pocketWindow } from '../../src/core/shot/pocket-window';
import { powerToSpeed } from '../../src/core/shot/power';
import { suggestShots } from '../../src/core/shot/suggest';
import { clampToTable, makeTable, pocketById } from '../../src/core/table';
import type { PocketId, ShotPlan, Stroke, TableLayout, TablePresetId } from '../../src/core/types';
import { add, angleBetween, angleOf, deg, fromAngle, len, rad, rotate, scale, sub, v2, type Vec2 } from '../../src/core/vec';
import { layout } from '../helpers/layout';

const P = DEFAULT_PHYSICS;
const has = (p: ShotPlan, code: string) => p.warnings.some((w) => w.code === code);
const msg = (p: ShotPlan, code: string) => p.warnings.find((w) => w.code === code)?.message ?? '';

/** First event of the cue ball that is a contact (ignores slide→roll transitions). */
function firstContact(plan: ShotPlan): string | undefined {
  return plan.cuePath.events.find((e) => e.kind !== 'roll')?.kind;
}

/** Object-ball departure error (deg) vs plan.obDir when the cue ball is launched along `dir`. */
function residualDeg(lay: TableLayout, plan: ShotPlan, dir: Vec2): number {
  const cue = lay.balls.find((b) => b.kind === 'cue')!;
  const ob = lay.balls.find((b) => b.id === plan.targetId)!;
  const R = lay.table.ballRadius;
  const st = strikeBall(dir, powerToSpeed(plan.stroke.power), plan.stroke.side, plan.stroke.vert, R, P.squirtMassRatio);
  const sim = simulate(lay.table, [{ id: cue.id, pos: cue.pos, vel: st.vel, omega: st.omega }, { id: ob.id, pos: ob.pos }], P, {
    record: false,
    stopOnFirstHitOf: ob.id,
  });
  const hit = sim.firstHits[ob.id];
  if (!hit) return Infinity;
  return deg(angleBetween(plan.obDir, fromAngle(angleOf(hit.vel))));
}

/** Does the full layout pot the target when the cue ball is launched along `dir` with `stroke`? */
function potsAlong(lay: TableLayout, targetId: string, pocket: PocketId, dir: Vec2, stroke: Stroke): boolean {
  const R = lay.table.ballRadius;
  const st = strikeBall(dir, powerToSpeed(stroke.power), stroke.side, stroke.vert, R, P.squirtMassRatio);
  const sim = simulate(
    lay.table,
    lay.balls.map((b) => (b.kind === 'cue' ? { id: b.id, pos: b.pos, vel: st.vel, omega: st.omega } : { id: b.id, pos: b.pos })),
    P,
    { record: false },
  );
  return sim.final[targetId]!.pocket === pocket && sim.final['cue']!.pocket === null;
}

describe('object ball frozen to a rail (rail-frozen-ob-not-makeable)', () => {
  for (const preset of ['pool9', 'snooker12'] as TablePresetId[]) {
    const T = makeTable(preset);
    const R = T.ballRadius;
    const hx = T.length / 2;
    const hy = T.width / 2;
    for (const d of [0.15, 0.2, 0.3, 0.5]) {
      const ob = clampToTable(T, v2(hx - d, hy - R));
      for (const cue of [add(ob, v2(-0.5, -0.35)), v2(0.62, 0.56)]) {
        it(`${preset}: ball frozen ${d * 100} cm from TR, cue (${cue.x.toFixed(2)}, ${cue.y.toFixed(2)}) is makeable and pots`, () => {
          const lay = layout({ cue, ob }, preset);
          const plan = planShot(lay, { targetId: 'ob', pocketId: 'TR' }, P);
          expect(has(plan, 'not-makeable'), msg(plan, 'not-makeable')).toBe(false);
          expect(plan.makeable).toBe(true);
          expect(plan.obPocketed).toBe(true);
          expect(plan.ghost.y).toBeLessThanOrEqual(hy - R + 1e-3);
          expect(plan.toleranceDeg).toBeGreaterThan(0);
          const s = suggestShots(lay, P, 3);
          expect(s.some((x) => x.targetId === 'ob' && x.pocketId === 'TR')).toBe(true);
        });
      }
    }
  }
  it('pool9: far case 0.97 m from TR also pots', () => {
    const T = makeTable('pool9');
    const R = T.ballRadius;
    const ob = clampToTable(T, v2(T.length / 2 - 0.97, T.width / 2 - R));
    const plan = planShot(layout({ cue: add(ob, v2(-0.5, -0.35)), ob }), { targetId: 'ob', pocketId: 'TR' }, P);
    expect(plan.makeable).toBe(true);
    expect(plan.obPocketed).toBe(true);
  });
});

describe('cue ball frozen to the object ball (frozen-cb)', () => {
  const T = makeTable('pool9');
  const R = T.ballRadius;
  const ob = v2(0.5, 0.1);
  const w = pocketWindow(ob, pocketById(T, 'TR'), R);
  /** Cue ball at separation 2R − overlap, with the line of centres `offDeg` off the pocket line. */
  const frozenAt = (overlap: number, offDeg: number) => sub(ob, scale(rotate(w.dir, rad(offDeg)), 2 * R - overlap));

  for (const overlap of [0, 0.0003, 0.001])
    for (const off of [0, 1, -1, 3, -3]) {
      it(`separation 2R − ${overlap * 1000} mm, line of centres ${off}° off: makeable and pots`, () => {
        const lay = layout({ cue: frozenAt(overlap, off), ob });
        const plan = planShot(lay, { targetId: 'ob', pocketId: 'TR' }, P);
        expect(plan.makeable, plan.warnings.map((x) => x.message).join(' | ')).toBe(true);
        expect(plan.cutAngleDeg).toBe(0);
        expect(plan.toleranceDeg).toBeGreaterThanOrEqual(0);
        expect(plan.toleranceMm).toBeGreaterThanOrEqual(0);
        expect(plan.warnings.some((x) => /Too far/.test(x.message))).toBe(false);
        expect(len(plan.aimDir)).toBeGreaterThan(0.99);
        expect(has(plan, 'frozen')).toBe(true);
        expect(msg(plan, 'frozen')).toMatch(/line of centres/);
        expect(plan.obPocketed).toBe(true);
      });
    }

  it('line of centres 8° off the pocket: not makeable, and the reason names the line of centres', () => {
    const plan = planShot(layout({ cue: frozenAt(0, 8), ob }), { targetId: 'ob', pocketId: 'TR' }, P);
    expect(plan.makeable).toBe(false);
    const m = msg(plan, 'not-makeable');
    expect(m).toMatch(/line of centres/);
    expect(m).not.toMatch(/too thin/);
    expect(plan.toleranceDeg).toBeGreaterThanOrEqual(0);
  });

  it('suggestShots includes the frozen 1° shot', () => {
    const s = suggestShots(layout({ cue: frozenAt(0, 1), ob }), P, 3);
    expect(s.some((x) => x.targetId === 'ob' && x.pocketId === 'TR')).toBe(true);
  });
});

describe('corner hanger past the mouth line (corner-hanger-window-reversed)', () => {
  it('a ball at the clamp corner is makeable into the corner and auto mode picks it', () => {
    const T = makeTable('pool9');
    const R = T.ballRadius;
    const ob = v2(T.length / 2 - R, T.width / 2 - R);
    const lay = layout({ cue: v2(0.5, 0.2), ob });
    const forced = planShot(lay, { targetId: 'ob', pocketId: 'TR' }, P);
    expect(forced.makeable).toBe(true);
    const auto = planShot(lay, { targetId: 'ob' }, P);
    expect(auto.pocketId).toBe('TR');
    expect(auto.makeable).toBe(true);
    expect(auto.obPocketed).toBe(true);
  });
});

describe('throw compensation next to a rail (throw-iteration-ghost-in-cushion)', () => {
  const T = makeTable('pool9');
  const R = T.ballRadius;
  const hy = T.width / 2;

  it('OB 1 mm off the top rail, default stroke: ghost on the table, ball-first contact, pots', () => {
    const lay = layout({ cue: v2(0.377, -0.216), ob: v2(-0.837, hy - R - 0.001) });
    const plan = planShot(lay, { targetId: 'ob', pocketId: 'TL' }, P);
    expect(plan.makeable).toBe(true);
    expect(plan.ghost.y).toBeLessThanOrEqual(hy - R + 1e-3);
    expect(firstContact(plan)).toBe('ball');
    expect(plan.obPocketed).toBe(true);
  });

  it('OB 3.4 mm off the rail, power 4 draw: the residual at the final aim is inside the window', () => {
    const lay = layout({ cue: v2(0.517, 0.396), ob: v2(0.731, 0.603) });
    const plan = planShot(lay, { targetId: 'ob', pocketId: 'TR', stroke: { power: 4, side: 0, vert: -0.2 } }, P);
    const res = residualDeg(lay, plan, plan.aimDir);
    expect(Math.abs(res)).toBeLessThanOrEqual(plan.windowHalfDeg);
    expect(plan.ghost.y).toBeLessThanOrEqual(hy - R + 1e-3);
  });

  it('rail-frozen TL case (power 7, side 0.3, vert −0.4): the corrected aim is no worse than the uncorrected one', () => {
    const lay = layout({ cue: v2(-0.105, 0.024), ob: v2(-0.599, 0.606) });
    const stroke = { power: 7, side: 0.3, vert: -0.4 };
    const plan = planShot(lay, { targetId: 'ob', pocketId: 'TL', stroke }, P);
    const cue = lay.balls.find((b) => b.id === 'cue')!.pos;
    const uncorrected = sub(plan.ghostUncorrected, cue);
    const dirU = scale(uncorrected, 1 / len(uncorrected));
    const resU = residualDeg(lay, plan, dirU);
    const resP = residualDeg(lay, plan, plan.aimDir);
    expect(Math.abs(resP)).toBeLessThanOrEqual(Math.abs(resU) + 1e-6);
    if (potsAlong(lay, 'ob', 'TL', dirU, stroke)) expect(plan.obPocketed).toBe(true);
    expect(plan.ghost.y).toBeLessThanOrEqual(hy - R + 1e-3);
  });
});

describe('cuts past 90° (negative-tolerance-cut-over-90)', () => {
  const cases: [string, Vec2, Vec2, PocketId][] = [
    ['cue beyond the object ball toward TR', v2(1.0, 0.45), v2(0.6, 0.2), 'TR'],
    ['cue ahead of the object ball toward BL', v2(-1.0, -0.45), v2(-0.6, -0.2), 'BL'],
  ];
  for (const [name, cue, ob, pocket] of cases)
    it(`${name}: tolerance is never negative and the reason is not "too thin"`, () => {
      const plan = planShot(layout({ cue, ob }), { targetId: 'ob', pocketId: pocket }, P);
      expect(plan.makeable).toBe(false);
      expect(plan.toleranceDeg).toBeGreaterThanOrEqual(0);
      expect(plan.toleranceMm).toBeGreaterThanOrEqual(0);
      const m = msg(plan, 'not-makeable');
      expect(m).not.toMatch(/too thin/);
      expect(m).toMatch(/wrong side/);
    });
});

describe('the cue ball never reaches the object ball (stun-tip-when-cb-never-arrives)', () => {
  const T = makeTable('pool9');
  const tr = pocketById(T, 'TR');
  it('straight-in, cue ball 1.35 m back, power 1 with draw: no stun/stop-shot tip', () => {
    const ob = add(tr.mouthCenter, scale(tr.inward, 0.3));
    const cue = add(ob, scale(tr.inward, 1.35));
    const plan = planShot(layout({ cue, ob }), { targetId: 'ob', pocketId: 'TR', stroke: { power: 1, side: 0, vert: -0.4 } }, P);
    expect(plan.tip).not.toMatch(/stun/i);
    expect(plan.tip).not.toMatch(/stop shot/i);
    expect(plan.tip).toMatch(/cue ball stops before it reaches the object ball/);
  });
  it('cut shot, cue (−0.9, 0) → ob (0.4, 0) into BR at power 2 with draw: no stun tip', () => {
    const plan = planShot(layout({ cue: v2(-0.9, 0), ob: v2(0.4, 0) }), { targetId: 'ob', pocketId: 'BR', stroke: { power: 2, side: 0, vert: -0.4 } }, P);
    expect(plan.tip).not.toMatch(/stun/i);
    expect(plan.tip).not.toMatch(/stop shot/i);
    expect(plan.tip).toMatch(/cue ball stops before it reaches the object ball/);
  });
});

describe('direction of the throw shift (throw-shift-always-thinner)', () => {
  const T = makeTable('pool9');
  const R = T.ballRadius;
  /** Cue position for a given cut of `ob` into `pocketId` (cut sign: + puts the CB line CCW of the OB line). */
  const cueFor = (ob: Vec2, pocketId: PocketId, cutDeg: number, d: number) => {
    const w = pocketWindow(ob, pocketById(T, pocketId), R);
    const ghost = sub(ob, scale(w.dir, 2 * R));
    return sub(ghost, scale(fromAngle(angleOf(w.dir) + rad(cutDeg)), d));
  };
  const mirror = (p: Vec2) => v2(p.x, -p.y);

  it('5° cut with outside english (side −0.3, cutSide −1): shifted thicker', () => {
    const ob = v2(0.4, 0.15);
    const cue = cueFor(ob, 'TR', 5, 0.7);
    const plan = planShot(layout({ cue, ob }), { targetId: 'ob', pocketId: 'TR', stroke: { power: 4, side: -0.3, vert: 0 } }, P);
    expect(plan.cutSide).toBe(-1);
    expect(plan.throwShiftDir).toBe('thicker');
    expect(plan.tip).toMatch(/thicker/);
    expect(plan.tip).not.toMatch(/thinner/);
  });
  it('the y-mirrored shot with side +0.3 is also shifted thicker', () => {
    const ob = mirror(v2(0.4, 0.15));
    const cue = mirror(cueFor(v2(0.4, 0.15), 'TR', 5, 0.7));
    const plan = planShot(layout({ cue, ob }), { targetId: 'ob', pocketId: 'BR', stroke: { power: 4, side: 0.3, vert: 0 } }, P);
    expect(plan.cutSide).toBe(1);
    expect(plan.throwShiftDir).toBe('thicker');
    expect(plan.tip).toMatch(/thicker/);
  });
  it('no english at 30°, both mirrors: shifted thinner', () => {
    const ob = v2(0.4, 0.15);
    const cue = cueFor(ob, 'TR', 30, 0.7);
    const stroke = { power: 3, side: 0, vert: 0 };
    const a = planShot(layout({ cue, ob }), { targetId: 'ob', pocketId: 'TR', stroke }, P);
    const b = planShot(layout({ cue: mirror(cue), ob: mirror(ob) }), { targetId: 'ob', pocketId: 'BR', stroke }, P);
    for (const p of [a, b]) {
      expect(p.throwShiftDir).toBe('thinner');
      expect(Math.abs(p.throwDeg)).toBeGreaterThan(1);
      expect(p.tip).toMatch(/thinner/);
    }
    expect(a.cutSide).toBe(-b.cutSide);
  });
  it('straight-in with side ±0.25: shifted left / right, opposite for opposite english', () => {
    const tr = pocketById(T, 'TR');
    const ob = add(tr.mouthCenter, scale(tr.inward, 0.5));
    const cue = add(tr.mouthCenter, scale(tr.inward, 1.2));
    const lay = layout({ cue, ob });
    const l = planShot(lay, { targetId: 'ob', pocketId: 'TR', stroke: { power: 4, side: -0.25, vert: 0 } }, P);
    const r = planShot(lay, { targetId: 'ob', pocketId: 'TR', stroke: { power: 4, side: 0.25, vert: 0 } }, P);
    expect([l.throwShiftDir, r.throwShiftDir].sort()).toEqual(['left', 'right']);
    expect(l.tip).toMatch(new RegExp(`to the ${l.throwShiftDir}`));
    expect(r.tip).toMatch(new RegExp(`to the ${r.throwShiftDir}`));
    // The ghost really moved to the side the text names.
    const along = sub(ob, cue);
    const lat = (p: ShotPlan) => along.x * (p.ghost.y - p.ghostUncorrected.y) - along.y * (p.ghost.x - p.ghostUncorrected.x);
    for (const p of [l, r]) expect(Math.sign(lat(p))).toBe(p.throwShiftDir === 'left' ? 1 : -1);
  });
});

describe('squirt: the drawn line is the cue-ball path, the cue aims off it (squirt-tip-claims-compensated-line)', () => {
  it('cueAimDir is aimDir rotated by the squirt correction, toward the english side', () => {
    const T = makeTable('pool9');
    const R = T.ballRadius;
    const ob = v2(0.4, 0.15);
    const w = pocketWindow(ob, pocketById(T, 'TR'), R);
    const cue = sub(sub(ob, scale(w.dir, 2 * R)), scale(fromAngle(angleOf(w.dir) + rad(25)), 0.7));
    for (const side of [0.3, -0.3]) {
      const plan = planShot(layout({ cue, ob }), { targetId: 'ob', pocketId: 'TR', stroke: { power: 4, side, vert: 0 } }, P);
      expect(plan.cueAimDir).toBeDefined();
      const a = deg(angleBetween(plan.aimDir, plan.cueAimDir!));
      expect(a).toBeCloseTo(-plan.squirtDeg, 6);
      // Right english → cue aimed to the right (clockwise) of the ball path.
      expect(Math.sign(a)).toBe(side > 0 ? -1 : 1);
      expect(plan.tip).toMatch(new RegExp(`to the ${side > 0 ? 'right' : 'left'} of the line shown`));
    }
  });
});
