/**
 * Evaluation budget of the planner worker's stroke search (unit-tested in
 * tests/unit/workers/eval-budget.test.ts). Kept out of planner.worker.ts so it runs under Node.
 *
 * The cost of one planShot on this device is measured once per number of balls on the table (best
 * of 3 after the first call warms the JIT): simulation cost grows with the ball count, so one figure
 * from the first, perhaps sparse, layout would over-budget a full rack. It times the plan the search
 * itself evaluates (no record, no wording advice): with the advice on, a frozen cue ball that is too
 * soft runs the advice's own stroke search inside the timing and cuts the budget several times.
 *
 * The figures outlive a worker: the app may restart the planner worker to abandon a superseded
 * recommendation (planner-client.ts), so each reply returns them and the next request brings them
 * back (`seed`). The budget then stays fixed per device and ball count for the page's life, and the
 * core search, deterministic for a given budget, gives the same stroke for the same request.
 */
import { planShot } from '../core/shot/planner';
import { FULL_EVALUATIONS } from '../core/shot/position';
import type { PhysicsParams, ShotRequest, TableLayout } from '../core/types';
import type { PlannerPerEvalMs } from './protocol';

/** Device budget for one recommendation (position search < 1.5 s, Constitution IV), with headroom. */
export const RECOMMEND_BUDGET_MS = 1200;
/** Never search fewer strokes than this (every power at three tip heights, plus some robustness). */
export const MIN_EVALUATIONS = 60;
/** The options recommendStroke evaluates its strokes with (position.ts), so the timing matches them. */
export const SEARCH_PLAN_OPTIONS = { record: false, advice: false } as const;

export interface EvaluationBudget {
  /** Strokes the search may evaluate for `layout` (measures this ball count's cost the first time). */
  budget(layout: TableLayout, request: ShotRequest, params: PhysicsParams): number;
  /** Adopts figures an earlier worker measured, for ball counts this one has not measured itself. */
  seed(known: PlannerPerEvalMs | undefined): void;
  /** Every figure known here (to hand to a later worker). */
  figures(): PlannerPerEvalMs;
}

const validMs = (ms: unknown): ms is number => typeof ms === 'number' && Number.isFinite(ms) && ms > 0;

export function createEvaluationBudget(now: () => number = () => performance.now()): EvaluationBudget {
  const perEvalMs = new Map<number, number>();
  return {
    budget(layout, request, params) {
      const n = layout.balls.length;
      if (!perEvalMs.has(n)) {
        let best = Infinity;
        try {
          const req = { targetId: request.targetId, ...(request.pocketId ? { pocketId: request.pocketId } : {}) };
          for (let k = 0; k < 4; k++) {
            const t0 = now();
            planShot(layout, req, params, SEARCH_PLAN_OPTIONS);
            if (k > 0) best = Math.min(best, now() - t0);
          }
        } catch {
          // recommendStroke reports the error itself.
        }
        if (Number.isFinite(best)) perEvalMs.set(n, Math.max(0.05, best));
      }
      const ms = perEvalMs.get(n);
      if (ms === undefined) return FULL_EVALUATIONS;
      return Math.max(MIN_EVALUATIONS, Math.min(FULL_EVALUATIONS, Math.floor(RECOMMEND_BUDGET_MS / ms)));
    },
    seed(known) {
      if (!known || typeof known !== 'object') return;
      for (const [k, ms] of Object.entries(known)) {
        const n = Number(k);
        if (Number.isInteger(n) && n > 0 && validMs(ms) && !perEvalMs.has(n)) perEvalMs.set(n, Math.max(0.05, ms));
      }
    },
    figures() {
      return Object.fromEntries([...perEvalMs].map(([n, ms]) => [String(n), ms]));
    },
  };
}
