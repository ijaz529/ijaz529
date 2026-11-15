/**
 * The planner worker's evaluation budget (src/workers/eval-budget.ts):
 *  - its timing plans exactly what the stroke search evaluates (wave 1's PlanOptions.advice defaults
 *    to true; timed with the advice on, a too-soft frozen cue ball ran the advice's own stroke search
 *    inside the timing and cut the budget from 324 to 60–106, so the picks went fragile);
 *  - figures measured by an earlier worker are adopted (the app restarts the worker to abandon a
 *    superseded recommendation), so the budget, and with it the stroke, stays the same.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
import {
  createEvaluationBudget,
  MIN_EVALUATIONS,
  RECOMMEND_BUDGET_MS,
  REFINE_MIN_EVALUATIONS,
  REFINE_RANGE,
  SEARCH_PLAN_OPTIONS,
  TIMED_PLANS,
  WARMUP_MS,
  WARMUP_PLANS,
} from '../../../src/workers/eval-budget';
import { createPlannerHandler } from '../../../src/workers/planner.worker';
import { PROTOCOL_VERSION, type PlannerOut } from '../../../src/workers/protocol';

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
    // The JIT warm-up (WARMUP_PLANS at 1 ms each here, under WARMUP_MS), then the best of TIMED_PLANS.
    expect(spy).toHaveBeenCalledTimes(WARMUP_PLANS + TIMED_PLANS);
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
    // Each of the calibration's plans (warm-up and timed) costs exactly one search evaluation.
    sims.mockClear();
    createEvaluationBudget(clock(1)).budget(lay, req, P);
    expect(sims.mock.calls.length).toBe((WARMUP_PLANS + TIMED_PLANS) * searched);
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

/**
 * Final-walkthrough polish (fix2c): the figure was measured with a cold JIT on the first request (in
 * Node 1.6–4.7 ms against 0.52 ms warm; in a fresh browser worker under load a budget of 60–120 and a
 * fragile pick on the first shot) and kept for the page's life. Now the calibration warms the JIT
 * first, and the first real search refines the figure once from its own ms per evaluation (bounded by
 * REFINE_RANGE either way; final afterwards, and final in a worker seeded with it).
 */
describe('evaluation budget: a warm calibration, refined once by the first real search', () => {
  const lay = drill('cut30');
  const req = { targetId: 'b1', pocketId: 'TR' as const };
  const n = String(lay.balls.length);
  const realPlan = spy.getMockImplementation()!;
  afterEach(() => spy.mockImplementation(realPlan));

  /** A clock the planShot calls advance: `cost(k)` ms for the k-th plan (0-based); searches advance it by hand. */
  function jitClock(cost: (k: number) => number) {
    let t = 0;
    let k = 0;
    spy.mockImplementation((...a: Parameters<typeof planShot>) => {
      t += cost(k++);
      return realPlan(...a);
    });
    return { now: () => t, advance: (ms: number) => (t += ms), plans: () => k };
  }

  it('warms the JIT before timing: cold plans (20 ms) do not set the figure when warm ones (1 ms) follow', () => {
    // The old calibration (one untimed plan, then the best of three) timed three 20 ms plans here: 60.
    const c = jitClock((k) => (k < 4 ? 20 : 1));
    const b = createEvaluationBudget(c.now);
    expect(b.budget(lay, req, P)).toBe(FULL_EVALUATIONS);
    expect(b.figures()).toEqual({ [n]: 1 });
    expect(c.plans()).toBe(WARMUP_PLANS + TIMED_PLANS);
  });

  it('the warm-up is bounded: at most WARMUP_PLANS plans, and it stops once WARMUP_MS have passed', () => {
    const slow = jitClock(() => 50);
    createEvaluationBudget(slow.now).budget(lay, req, P);
    expect(slow.plans()).toBe(Math.ceil(WARMUP_MS / 50) + TIMED_PLANS);
    const fast = jitClock(() => 0.1);
    createEvaluationBudget(fast.now).budget(lay, req, P);
    expect(fast.plans()).toBe(WARMUP_PLANS + TIMED_PLANS);
  });

  it('the first real search refines the figure from its own ms per evaluation, once, within REFINE_RANGE', () => {
    const c = jitClock(() => 10);
    const b = createEvaluationBudget(c.now);
    expect(b.budget(lay, req, P)).toBe(Math.floor(RECOMMEND_BUDGET_MS / 10));
    // A search that ran 120 evaluations in 480 ms: 4 ms each. measure() returns the search's result.
    const r = b.measure(lay, () => (c.advance(480), { evaluated: 120 }));
    expect(r).toEqual({ evaluated: 120 });
    expect(b.figures()).toEqual({ [n]: 4 });
    expect(b.budget(lay, req, P)).toBe(Math.floor(RECOMMEND_BUDGET_MS / 4));
    // Final: a later search (7 ms each) leaves the figure, and with it the budget, as it is.
    b.measure(lay, () => (c.advance(700), { evaluated: 100 }));
    expect(b.figures()).toEqual({ [n]: 4 });
    expect(b.budget(lay, req, P)).toBe(Math.floor(RECOMMEND_BUDGET_MS / 4));
    // Bounded: a figure moves by at most REFINE_RANGE either way.
    const lo = createEvaluationBudget(jitClock(() => 10).now);
    lo.budget(lay, req, P);
    lo.measure(lay, () => ({ evaluated: 200 })); // no time at all: clamped, never 0
    expect(lo.figures()).toEqual({ [n]: 10 / REFINE_RANGE });
    const hiClock = jitClock(() => 10);
    const hi = createEvaluationBudget(hiClock.now);
    hi.budget(lay, req, P);
    hi.measure(lay, () => (hiClock.advance(200 * 100), { evaluated: 200 }));
    expect(hi.figures()).toEqual({ [n]: 10 * REFINE_RANGE });
  });

  it('a search with too few evaluations (none: not makeable) does not refine; the next real one does', () => {
    const c = jitClock(() => 10);
    const b = createEvaluationBudget(c.now);
    b.budget(lay, req, P);
    b.measure(lay, () => (c.advance(50), { evaluated: 0 }));
    b.measure(lay, () => (c.advance(50), { evaluated: REFINE_MIN_EVALUATIONS - 1 }));
    expect(b.figures()).toEqual({ [n]: 10 });
    b.measure(lay, () => (c.advance(400), { evaluated: 100 }));
    expect(b.figures()).toEqual({ [n]: 4 });
    // A ball count without a figure is not given one by a search.
    b.measure({ ...lay, balls: lay.balls.slice(0, 2) }, () => (c.advance(200), { evaluated: 100 }));
    expect(Object.keys(b.figures())).toEqual([n]);
  });

  it('a restarted worker seeded with the figures keeps them (seeded figures are final): the same budget', () => {
    const c = jitClock(() => 10);
    const first = createEvaluationBudget(c.now);
    first.budget(lay, req, P);
    first.measure(lay, () => (c.advance(300), { evaluated: 100 }));
    expect(first.figures()).toEqual({ [n]: 3 });
    const next = createEvaluationBudget(jitClock(() => 1).now);
    next.seed(first.figures());
    const budget = next.budget(lay, req, P);
    next.measure(lay, () => ({ evaluated: 300 }));
    expect(next.figures()).toEqual({ [n]: 3 });
    expect(next.budget(lay, req, P)).toBe(budget);
  });

  it("the worker's recommendation reply carries the refined figure (the perEvalMs plumbing)", () => {
    // clock(8): every reading is 8 ms on, so the calibration's figure is 8 and the search (one reading
    // before it, one after) took 8 ms for all its evaluations: refined to the bound, 8 / REFINE_RANGE.
    const handle = createPlannerHandler(createEvaluationBudget(clock(8)));
    const out: PlannerOut[] = [];
    handle({ v: PROTOCOL_VERSION, type: 'recommend', id: 1, layout: lay, request: req, params: P }, (m) => out.push(m));
    const reply = out[0] as Extract<PlannerOut, { type: 'recommendation' }>;
    expect(reply.type).toBe('recommendation');
    expect(reply.evaluated).toBeGreaterThanOrEqual(REFINE_MIN_EVALUATIONS);
    expect(reply.perEvalMs).toEqual({ [n]: 8 / REFINE_RANGE });
  });
});
