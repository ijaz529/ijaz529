/**
 * The planner worker's message handler (src/workers/planner.worker.ts), run in Node:
 *  - 'plan': the full plan with the frozen power advice (the app shows the plan without it at once and
 *    asks for this one, so a too-soft frozen stroke never costs the main thread the advice's search);
 *  - 'recommend': the stroke search, with the device's evaluation-budget figures in every reply.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_PHYSICS } from '../../../src/core/physics/params';
import { planShot } from '../../../src/core/shot/planner';
import { makeTable } from '../../../src/core/table';
import type { Ball, TableLayout } from '../../../src/core/types';
import { PROTOCOL_VERSION, type PlannerIn, type PlannerOut } from '../../../src/workers/protocol';
import { createPlannerHandler } from '../../../src/workers/planner.worker';

const P = DEFAULT_PHYSICS;
const T = makeTable('pool9');
/** Cue ball frozen to the 1 (merge-coherence's verifier chain): at power 1 with draw it is too soft. */
const frozen: TableLayout = {
  table: T,
  balls: [
    { id: 'cue', kind: 'cue', pos: { x: -0.2451160266459315, y: 0.23962167347191393 }, label: 'cue' },
    { id: 'b1', kind: 'object', pos: { x: -0.1891063642501831, y: 0.25098126053810116 }, label: '1' },
    { id: 'b2', kind: 'object', pos: { x: 0.6, y: -0.3 }, label: '2' },
  ] satisfies Ball[],
  source: 'virtual',
  frozen: false,
};
const request = { targetId: 'b1', stroke: { power: 1, side: 0, vert: -0.4 } };
const names = { TR: 'far right corner' } as const;

function run(msg: PlannerIn): PlannerOut[] {
  const out: PlannerOut[] = [];
  const handle = createPlannerHandler();
  // Structured clone both ways, as postMessage does.
  handle(structuredClone(msg), (m) => out.push(structuredClone(m)));
  return out;
}

describe("planner worker 'plan': the full plan, frozen power advice included", () => {
  it('is exactly what planShot gives the app with the advice on (names and the recommended stroke passed through)', () => {
    const quick = planShot(frozen, request, P, { names, advice: false });
    expect(quick.adviceSkipped).toBe(true); // the main thread's plan: no figure yet
    const [reply] = run({ v: PROTOCOL_VERSION, type: 'plan', id: 7, layout: frozen, request, params: P, opts: { names } });
    expect(reply?.type).toBe('plan');
    const plan = (reply as Extract<PlannerOut, { type: 'plan' }>).plan;
    expect(reply!.id).toBe(7);
    expect(plan.adviceSkipped).toBeUndefined();
    expect(plan.warnings.find((w) => w.code === 'too-soft')!.message).toMatch(/Use power \d+(\.\d)?/);
    expect(plan).toEqual(structuredClone(planShot(frozen, request, P, { names })));
    // Everything but the advice is the plan the app already shows.
    expect(plan.cuePath).toEqual(structuredClone(quick.cuePath));
    expect(plan.stroke).toEqual(quick.stroke);
  });

  it('passes the recommended stroke through (a default-stroke plan is planned with it)', () => {
    const rec = { power: 6, side: 0, vert: 0.2 };
    const [reply] = run({ v: PROTOCOL_VERSION, type: 'plan', id: 3, layout: frozen, request: { targetId: 'b1' }, params: P, opts: { recommended: rec } });
    const plan = (reply as Extract<PlannerOut, { type: 'plan' }>).plan;
    expect(plan.strokeSource).toBe('recommended');
    expect(plan.stroke).toEqual(rec);
  });

  it('a bad request is an error reply for that id, not a dead worker', () => {
    const [reply] = run({ v: PROTOCOL_VERSION, type: 'plan', id: 9, layout: frozen, request: { targetId: 'nope' }, params: P });
    expect(reply).toMatchObject({ type: 'error', id: 9 });
  });
});

describe("planner worker 'recommend'", () => {
  it('replies with the stroke and the evaluation-budget figures; an unsupported version is refused', () => {
    const [reply] = run({ v: PROTOCOL_VERSION, type: 'recommend', id: 1, layout: frozen, request: { targetId: 'b1' }, params: P, perEvalMs: { '3': 1.5 } });
    expect(reply).toMatchObject({ type: 'recommendation', id: 1, perEvalMs: { '3': 1.5 } });
    const bad = run({ v: 1 as never, type: 'recommend', id: 2, layout: frozen, request: { targetId: 'b1' }, params: P });
    expect(bad[0]).toMatchObject({ type: 'error' });
  });
});

describe("planner worker 'recommend' on a bank", () => {
  it('searches fewer strokes (each costs several direct ones) and does not refine the device figure', () => {
    // The top-right corner off the bottom cushion: the cue ball is up-table of the ball.
    const bankLayout: TableLayout = {
      table: T,
      balls: [
        { id: 'cue', kind: 'cue', pos: { x: 0.65, y: 0.33 }, label: 'cue' },
        { id: 'b1', kind: 'object', pos: { x: 0.63, y: -0.27 }, label: '1' },
      ] satisfies Ball[],
      source: 'virtual',
      frozen: false,
    };
    let measured = 0;
    const budget = {
      budget: () => 300,
      measure: <R extends { evaluated: number }>(_l: TableLayout, run: () => R): R => {
        measured++;
        return run();
      },
      seed: () => {},
      figures: () => ({}),
    };
    const ask = (request: Extract<PlannerIn, { type: 'recommend' }>['request']) => {
      const out: PlannerOut[] = [];
      createPlannerHandler(budget)({ v: PROTOCOL_VERSION, type: 'recommend', id: 1, layout: bankLayout, request, params: P }, (m) => out.push(m));
      return out[0] as Extract<PlannerOut, { type: 'recommendation' }>;
    };
    const bank = ask({ targetId: 'b1', pocketId: 'TR', bank: 'bottom' });
    expect(bank.type).toBe('recommendation');
    expect(bank.reachable).toBe(true);
    expect(bank.evaluated).toBeGreaterThan(0);
    expect(bank.evaluated).toBeLessThanOrEqual(60); // 300 / BANK_EVALUATION_COST, never under MIN_EVALUATIONS
    expect(measured).toBe(0);
    const direct = ask({ targetId: 'b1', pocketId: 'BR' });
    expect(direct.evaluated).toBeGreaterThan(60);
    expect(measured).toBe(1);
  });
});
