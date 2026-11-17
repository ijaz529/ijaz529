/**
 * One-cushion bank shots: the object ball goes off a cushion into the pocket. Asked for with
 * ShotRequest.bank; a pocket that cannot be played directly says which bank is open (bankOption).
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_PHYSICS } from '../../src/core/physics/params';
import { planShot } from '../../src/core/shot/planner';
import { recommendStroke } from '../../src/core/shot/position';
import { makeTable, pocketById } from '../../src/core/table';
import type { PocketId, RailId, ShotPlan, TableLayout } from '../../src/core/types';
import type { Vec2 } from '../../src/core/vec';
import { layout } from '../helpers/layout';

const P = DEFAULT_PHYSICS;
const T = makeTable('pool9');
const R = T.ballRadius;
const hx = T.length / 2;
const hy = T.width / 2;
const TR = pocketById(T, 'TR').mouthCenter;
const has = (p: ShotPlan, code: string) => p.warnings.some((w) => w.code === code);
const codes = (p: ShotPlan) => p.warnings.map((w) => `${w.code}: ${w.message}`).join(' | ');

/**
 * The shot this feature came from: the object ball `off` m from the bottom cushion, the top-right
 * corner `along` m further along it, and the cue ball up-table of the ball, so the corner cannot be
 * played directly (wrong side) and the ball has to go off the bottom cushion.
 */
function reel(off = 0.37, along = 0.6): TableLayout {
  const ob = { x: TR.x - along, y: -hy + off };
  return layout({ cue: { x: ob.x + 0.015, y: ob.y + 0.6 }, ob });
}

/** The object ball's cushion contacts between the cue ball's hit and the pocket (or the end of its path). */
function cushionsBeforePocket(p: ShotPlan): number {
  const ev = p.objectPath.events;
  const from = ev.findIndex((e) => e.kind === 'ball');
  const to = ev.findIndex((e) => e.kind === 'pocket');
  return ev.filter((e, i) => i > from && (to < 0 || i < to) && (e.kind === 'cushion' || e.kind === 'jaw')).length;
}

/** The layout mirrored left-right and/or top-bottom, with the pocket and cushion that go with it. */
function mirrored(lay: TableLayout, fx: boolean, fy: boolean, pocketId: PocketId, rail: RailId) {
  const flipPocket = (id: PocketId): PocketId => {
    let s: string = id;
    if (fx) s = s.replace(/[LR]/, (c) => (c === 'L' ? 'R' : 'L'));
    if (fy) s = s.replace(/[TB]/, (c) => (c === 'T' ? 'B' : 'T'));
    return s as PocketId;
  };
  const flipRail = (r: RailId): RailId =>
    fx && (r === 'left' || r === 'right') ? (r === 'left' ? 'right' : 'left') : fy && (r === 'top' || r === 'bottom') ? (r === 'top' ? 'bottom' : 'top') : r;
  const balls = lay.balls.map((b) => ({ ...b, pos: { x: fx ? -b.pos.x : b.pos.x, y: fy ? -b.pos.y : b.pos.y } }));
  return { lay: { ...lay, balls }, pocketId: flipPocket(pocketId), rail: flipRail(rail) };
}

describe('bank shots (one cushion)', () => {
  it('a pocket that cannot be played directly says which bank is open', () => {
    const plan = planShot(reel(), { targetId: 'ob', pocketId: 'TR' }, P);
    expect(plan.makeable).toBe(false);
    expect(plan.warnings[0]!.message).toMatch(/wrong side/);
    expect(plan.bank).toBeUndefined();
    expect(plan.bankOption).toEqual({ pocketId: 'TR', rail: 'bottom' });
  });

  it('a pocket that can be played directly is planned as before: no bank, none offered', () => {
    const plan = planShot(reel(), { targetId: 'ob', pocketId: 'BR' }, P);
    expect(plan.makeable).toBe(true);
    expect(plan.obPocketed).toBe(true);
    expect(plan.bank).toBeUndefined();
    expect(plan.bankOption).toBeUndefined();
    expect(cushionsBeforePocket(plan)).toBe(0);
  });

  it('the bank pots: off the cushion once, then into the pocket asked for', () => {
    const lay = reel();
    const ob = lay.balls.find((b) => b.id === 'ob')!.pos;
    const plan = planShot(lay, { targetId: 'ob', pocketId: 'TR', bank: 'bottom' }, P);
    expect(plan.makeable, codes(plan)).toBe(true);
    expect(plan.pocketId).toBe('TR');
    expect(plan.obPocketed, codes(plan)).toBe(true);
    expect(cushionsBeforePocket(plan)).toBe(1);
    expect(plan.bank!.rail).toBe('bottom');
    // Where the ball's centre meets the cushion: a ball's radius off it, between the ball and the pocket.
    expect(plan.bank!.point.y).toBeCloseTo(-hy + R, 3);
    expect(plan.bank!.point.x).toBeGreaterThan(ob.x);
    expect(plan.bank!.point.x).toBeLessThan(TR.x);
    expect(has(plan, 'ob-missed') || has(plan, 'not-makeable') || has(plan, 'too-soft')).toBe(false);
    expect(plan.toleranceDeg).toBeGreaterThan(0);
    expect(plan.bankOption).toBeUndefined();
  });

  it('aims by the simulated bounce, not the mirror rule: a soft bank comes off wider, so it is aimed nearer', () => {
    const lay = reel();
    const at = (power: number) => planShot(lay, { targetId: 'ob', pocketId: 'TR', bank: 'bottom', stroke: { power, side: 0, vert: 0 } }, P);
    const soft = at(5);
    const firm = at(8);
    expect(soft.obPocketed, codes(soft)).toBe(true);
    expect(firm.obPocketed, codes(firm)).toBe(true);
    expect(firm.bank!.point.x - soft.bank!.point.x).toBeGreaterThan(0.005);
  });

  it('pots with the default stroke off every cushion, from near it and from the middle of the table', () => {
    const fails: string[] = [];
    for (const off of [0.1, 0.37, 0.6])
      for (const along of [0.6, 1.2])
        for (const [fx, fy] of [
          [false, false],
          [true, false],
          [false, true],
          [true, true],
        ] as const) {
          const m = mirrored(reel(off, along), fx, fy, 'TR', 'bottom');
          const plan = planShot(m.lay, { targetId: 'ob', pocketId: m.pocketId, bank: m.rail }, P);
          if (!(plan.makeable && plan.obPocketed && cushionsBeforePocket(plan) === 1 && plan.bank?.rail === m.rail))
            fails.push(`off ${off} along ${along} ${m.rail}→${m.pocketId}: ${codes(plan) || 'no warning'}`);
        }
    // Long banks: off an end cushion, down the table into a far corner.
    for (const off of [0.15, 0.5])
      for (const [fx, fy] of [
        [false, false],
        [true, true],
      ] as const) {
        const ob: Vec2 = { x: hx - off, y: 0.2 };
        const m = mirrored(layout({ cue: { x: ob.x - 0.5, y: ob.y + 0.05 }, ob }), fx, fy, 'TL', 'right');
        const plan = planShot(m.lay, { targetId: 'ob', pocketId: m.pocketId, bank: m.rail }, P);
        if (!(plan.makeable && plan.obPocketed && cushionsBeforePocket(plan) === 1 && plan.bank?.rail === m.rail))
          fails.push(`long, off ${off} ${m.rail}→${m.pocketId}: ${codes(plan) || 'no warning'}`);
      }
    expect(fails).toEqual([]);
  });

  it('says it is a bank and is rated no easier than hard, whatever the aim tolerance', () => {
    // 10 cm off the cushion: the aim tolerance alone (≈0.09°) would rate it medium.
    const plan = planShot(reel(0.1), { targetId: 'ob', pocketId: 'TR', bank: 'bottom' }, P);
    expect(plan.obPocketed, codes(plan)).toBe(true);
    expect(plan.toleranceDeg).toBeGreaterThan(0.08);
    expect(plan.difficulty).toBe('hard');
    expect(plan.tip).toMatch(/^Bank shot: .*starting point\./);
  });

  it('a stroke too soft to get there says so (stops short), not just "misses"', () => {
    const plan = planShot(reel(), { targetId: 'ob', pocketId: 'TR', bank: 'bottom', stroke: { power: 1.5, side: 0, vert: 0 } }, P);
    expect(plan.obPocketed).toBe(false);
    expect(has(plan, 'too-soft'), codes(plan)).toBe(true);
    expect(has(plan, 'ob-missed')).toBe(false);
  });

  it('a ball on the way back from the cushion blocks it', () => {
    const lay = reel();
    const open = planShot(lay, { targetId: 'ob', pocketId: 'TR', bank: 'bottom' }, P);
    const b = open.bank!.point;
    const x = { x: (b.x + TR.x) / 2, y: (b.y + TR.y) / 2 };
    const plan = planShot({ ...lay, balls: [...lay.balls, { id: 'x', kind: 'object', pos: x, label: 'x' }] }, { targetId: 'ob', pocketId: 'TR', bank: 'bottom' }, P);
    expect(plan.makeable).toBe(false);
    expect(has(plan, 'blocked-object')).toBe(true);
  });

  it('a near straight-back bank with the cue ball following it in is called a double kiss', () => {
    // Almost square at the bottom cushion (clear of the side pocket's jaws) and back toward the top side
    // pocket, with follow: the cue ball rolls on after the ball and meets it coming back.
    const lay = layout({ cue: { x: 0.16, y: 0.25 }, ob: { x: 0.12, y: -0.3 } });
    const plan = planShot(lay, { targetId: 'ob', pocketId: 'TM', bank: 'bottom', stroke: { power: 4, side: 0, vert: 0.4 } }, P);
    expect(plan.obPocketed).toBe(false);
    expect(plan.warnings.some((w) => w.code === 'kiss' && /double kiss/i.test(w.message)), codes(plan)).toBe(true);
  });

  it('no one-cushion path: a pocket on the cushion itself, or balls frozen together', () => {
    const own = planShot(reel(), { targetId: 'ob', pocketId: 'BR', bank: 'bottom' }, P);
    expect(own.makeable).toBe(false);
    expect(own.warnings[0]!.message).toMatch(/off that cushion/);
    const ob = { x: 0.6, y: -0.3 };
    const frozen = planShot(layout({ cue: { x: ob.x, y: ob.y + 2 * R }, ob }), { targetId: 'ob', pocketId: 'TR', bank: 'bottom' }, P);
    expect(frozen.makeable).toBe(false);
  });

  it('with no pocket chosen and no direct pot on, the best bank on the table is offered', () => {
    // The cue ball is above the ball (the three top pockets are on the wrong side) and a ball sits on each line to the bottom pockets.
    const ob = { x: 0.3, y: -0.1 };
    const blockers: Record<string, Vec2> = {};
    for (const id of ['BL', 'BM', 'BR'] as const) {
      const m = pocketById(T, id).mouthCenter;
      const d = Math.hypot(m.x - ob.x, m.y - ob.y);
      blockers[`x${id}`] = { x: ob.x + ((m.x - ob.x) / d) * 0.2, y: ob.y + ((m.y - ob.y) / d) * 0.2 };
    }
    const lay = layout({ cue: { x: 0.25, y: 0.45 }, ob, ...blockers });
    const direct = planShot(lay, { targetId: 'ob' }, P);
    expect(direct.makeable).toBe(false);
    expect(direct.bankOption).toBeDefined();
    const bank = planShot(lay, { targetId: 'ob', pocketId: direct.bankOption!.pocketId, bank: direct.bankOption!.rail }, P);
    expect(bank.makeable, codes(bank)).toBe(true);
    expect(bank.bank!.rail).toBe(direct.bankOption!.rail);
  });

  it('the stroke search works on a bank: it recommends a stroke that pots it off the cushion', () => {
    const lay = reel();
    const request = { targetId: 'ob', pocketId: 'TR' as const, bank: 'bottom' as const };
    const rec = recommendStroke(lay, request, P, { maxEvaluations: 90 });
    expect(rec.reachable).toBe(true);
    expect(rec.score).toBeGreaterThan(-Infinity);
    // Side spin would change the angle off the cushion: not while a centre-line stroke pots it.
    expect(rec.stroke.side).toBe(0);
    const plan = planShot(lay, { ...request, stroke: rec.stroke }, P);
    expect(plan.obPocketed, codes(plan)).toBe(true);
    expect(plan.scratch).toBe(false);
    expect(cushionsBeforePocket(plan)).toBe(1);
  });
});
