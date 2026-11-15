/**
 * The planner worker's evaluation budget (src/workers/eval-budget.ts):
 *  - its timing plans exactly what the stroke search evaluates (wave 1's PlanOptions.advice defaults
 *    to true; timed with the advice on, a too-soft frozen cue ball ran the advice's own stroke search
 *    inside the timing and cut the budget from 324 to 60–106, so the picks went fragile);
 *  - figures measured by an earlier worker are adopted (the app restarts the worker to abandon a
 *    superseded recommendation), so the budget, and with it the stroke, stays the same.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/core/shot/planner', async (importOriginal) => {
  const m = await importOriginal<typeof import('../../../src/core/shot/planner')>();
  return { ...m, planShot: vi.fn(m.planShot) };
});
// Simulations run: a deterministic stand-in for the time a plan costs.
vi.mock('../../../src/core/physics/simulate', async (importOriginal) => {
  const m = await importOriginal<typeof import('../../../src/core/physics/simulate')>();
  return { ...m, simulate: vi.fn(m.simulate) };
});

import { DRILLS } from '../../../src/app/drills';
import { DEFAULT_PHYSICS } from '../../../src/core/physics/params';
import { simulate } from '../../../src/core/physics/simulate';
import { planShot } from '../../../src/core/shot/planner';
import { FULL_EVALUATIONS, recommendStroke } from '../../../src/core/shot/position';
import { makeTable } from '../../../src/core/table';
import type { Ball, TableLayout } from '../../../src/core/types';
import { createEvaluationBudget, MIN_EVALUATIONS, RECOMMEND_BUDGET_MS, SEARCH_PLAN_OPTIONS } from '../../../src/workers/eval-budget';

const P = DEFAULT_PHYSICS;
const T = makeTable('pool9');
const R = T.ballRadius;
const spy = vi.mocked(planShot);
const sims = vi.mocked(simulate);
/** A clock that advances `step` ms per reading: every timed planShot then "costs" exactly `step`. */
const clock = (step: number) => {
  let t = 0;
  return () => (t += step);
};
const drill = (id: string): TableLayout => ({ table: T, balls: DRILLS.find((d) => d.id === id)!.build(T), source: 'virtual', frozen: false });
/**
 * Cue ball frozen to the 1 (found by a seeded search of frozen 4-ball layouts): the default plan is
 * too soft, so with the advice on it runs the frozen advice's power-by-power stroke search
 * (about 14 ms against 1 ms on a desktop).
 */
const frozenSoft = (): TableLayout => {
  const ob = { x: -0.7763, y: -0.094 };
  const a = Math.atan2(-0.0564 - ob.y, -0.7332 - ob.x);
  const balls: Ball[] = [
    { id: 'cue', kind: 'cue', pos: { x: ob.x + Math.cos(a) * 2 * R, y: ob.y + Math.sin(a) * 2 * R }, label: 'cue' },
    { id: 'b1', kind: 'object', pos: ob, label: '1' },
    { id: 'b2', kind: 'object', pos: { x: 0.8752, y: 0.2057 }, label: '2' },
    { id: 'b3', kind: 'object', pos: { x: -0.3256, y: 0.2063 }, label: '3' },
  ];
  return { table: T, balls, source: 'virtual', frozen: false };
};

beforeEach(() => {
  spy.mockClear();
  sims.mockClear();
});

describe('evaluation budget: the calibration times what the search evaluates', () => {
  it('every timed planShot uses the options recommendStroke evaluates with (no record, no wording advice)', () => {
    const lay = drill('cut30');
    const req = { targetId: 'b1', pocketId: 'TR' as const };
    recommendStroke(lay, req, P, { maxEvaluations: 80 });
    const searchOpts = new Set(spy.mock.calls.map((c) => JSON.stringify(c[3])));
    expect(searchOpts).toEqual(new Set([JSON.stringify(SEARCH_PLAN_OPTIONS)]));
    spy.mockClear();
    createEvaluationBudget(clock(1)).budget(lay, req, P);
    expect(spy).toHaveBeenCalledTimes(4); // one warm-up, best of three
    for (const c of spy.mock.calls) expect(c[3]).toEqual(SEARCH_PLAN_OPTIONS);
  });

  it('a too-soft frozen cue ball: the timed plans skip the advice (and its stroke search)', () => {
    const lay = frozenSoft();
    const req = { targetId: 'b1', pocketId: 'BL' as const };
    // Not vacuous: on this layout the default plan's advice runs (its wording differs) and costs
    // several times the simulations of the plan the search evaluates.
    const words = (o: object) => planShot(lay, req, P, o).warnings.map((w) => w.message).join(' | ');
    expect(words({ record: false, advice: true })).not.toBe(words(SEARCH_PLAN_OPTIONS));
    sims.mockClear();
    planShot(lay, req, P, { record: false, advice: true });
    const withAdvice = sims.mock.calls.length;
    sims.mockClear();
    planShot(lay, req, P, SEARCH_PLAN_OPTIONS);
    const searched = sims.mock.calls.length;
    expect(withAdvice).toBeGreaterThan(3 * searched);
    // The calibration's four timed plans cost exactly four search evaluations.
    sims.mockClear();
    createEvaluationBudget(clock(1)).budget(lay, req, P);
    expect(sims.mock.calls.length).toBe(4 * searched);
    // And a caller that only says record: false (a search) no longer pays for the advice either: the
    // core's default is advice = record !== false.
    sims.mockClear();
    planShot(lay, req, P, { record: false });
    expect(sims.mock.calls.length).toBe(searched);
    expect(words({ record: false })).toBe(words(SEARCH_PLAN_OPTIONS));
  });

  it('the budget is RECOMMEND_BUDGET_MS / per-evaluation ms, between MIN_EVALUATIONS and FULL_EVALUATIONS', () => {
    const lay = drill('cut30');
    const req = { targetId: 'b1', pocketId: 'TR' as const };
    expect(createEvaluationBudget(clock(5)).budget(lay, req, P)).toBe(Math.floor(RECOMMEND_BUDGET_MS / 5));
    expect(createEvaluationBudget(clock(0.5)).budget(lay, req, P)).toBe(FULL_EVALUATIONS);
    expect(createEvaluationBudget(clock(100)).budget(lay, req, P)).toBe(MIN_EVALUATIONS);
  });
});

describe('evaluation budget: figures survive a worker restart', () => {
  const lay = drill('cut30');
  const req = { targetId: 'b1', pocketId: 'TR' as const };
  const n = String(lay.balls.length);

  it('a new worker seeded with the old figures does not re-measure and gives the same budget', () => {
    const first = createEvaluationBudget(clock(5));
    const budget = first.budget(lay, req, P);
    expect(first.figures()).toEqual({ [n]: 5 });
    spy.mockClear();
    // The restarted worker's clock would say 9 ms (a cold JIT, a busy phone): the old figure wins.
    const next = createEvaluationBudget(clock(9));
    next.seed(first.figures());
    expect(next.budget(lay, req, P)).toBe(budget);
    expect(spy).not.toHaveBeenCalled();
    expect(next.figures()).toEqual({ [n]: 5 });
  });

  it('a figure this worker measured itself is kept; unusable seeds are ignored', () => {
    const b = createEvaluationBudget(clock(4));
    b.budget(lay, req, P);
    b.seed({ [n]: 8, '22': Number.NaN, '7': -1, '8': Infinity, x: 3, '0': 2, '1.5': 2 });
    b.seed(undefined);
    expect(b.figures()).toEqual({ [n]: 4 });
    b.seed({ '22': 12 });
    expect(b.figures()).toEqual({ [n]: 4, '22': 12 });
  });

  it('the same request gets the same stroke from a restarted worker seeded with the figures', () => {
    const first = createEvaluationBudget(clock(5.5));
    const a = recommendStroke(lay, req, P, { maxEvaluations: first.budget(lay, req, P) });
    const next = createEvaluationBudget(clock(4.1));
    next.seed(first.figures());
    const b = recommendStroke(lay, req, P, { maxEvaluations: next.budget(lay, req, P) });
    expect(b.stroke).toEqual(a.stroke);
    expect(b.evaluated).toBe(a.evaluated);
  });
});
