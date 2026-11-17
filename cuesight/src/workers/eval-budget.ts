/**
 * Evaluation budget of the planner worker's stroke search (unit-tested in
 * tests/unit/workers/eval-budget.test.ts). Kept out of planner.worker.ts so it runs under Node.
 *
 * The cost of one evaluation on this device is known per number of balls on the table: simulation
 * cost grows with the ball count, so one figure from the first, perhaps sparse, layout would
 * over-budget a full rack.
 *
 * - Calibration, the first time a ball count is searched: untimed plans first, so a fresh worker's
 *   JIT is warm (up to WARMUP_PLANS, stopping once WARMUP_MS have passed: a cold plan costs several
 *   times a warm one, and a figure timed cold starved the first search of the page into a fragile
 *   pick), then the best of TIMED_PLANS. It times the plan the search itself evaluates (no record, no
 *   wording advice): with the advice on, a frozen cue ball that is too soft runs the advice's own
 *   stroke search inside the timing and cuts the budget several times.
 * - Refinement, once: the first real search with at least REFINE_MIN_EVALUATIONS evaluations
 *   (`measure`) replaces the calibration with its own ms per evaluation — every cost of the search
 *   counted, timed over hundreds of evaluations — kept within REFINE_RANGE of the calibration either
 *   way. The figure is then final.
 *
 * The figures outlive a worker: the app may restart the planner worker to abandon a superseded
 * recommendation (planner-client.ts), so each reply returns them and the next request brings them
 * back (`seed`); a seeded figure is final. The budget is a pure function of the figure, so once it is
 * final it stays fixed per device and ball count for the page's life, and the core search,
 * deterministic for a given budget, gives the same stroke for the same request.
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
/**
 * Calibration warm-up: untimed plans before the timed ones, at most this many, stopping once
 * WARMUP_MS have passed. Measured in Node, a fresh process's plans take 30 → 1.5 ms over the first
 * 6–8 and settle near 0.6 ms after about 30 (desktop); a phone's cold plans take tens of ms, so the
 * time bound keeps the wait before its first recommendation short. Not physics: a measurement choice.
 */
export const WARMUP_PLANS = 24;
export const WARMUP_MS = 120;
/** Timed plans after the warm-up; the fastest one is the figure. */
export const TIMED_PLANS = 3;
/** A search refines the figure only when it ran at least this many evaluations (a not-makeable shot runs none). */
export const REFINE_MIN_EVALUATIONS = 30;
/** The refined figure stays within this factor of the calibration, either way. */
export const REFINE_RANGE = 4;
/**
 * A bank's evaluation against a direct shot's: its aim search simulates the cue ball and the object
 * ball to the pocket up to six times, where a direct plan runs four probes that stop at the first
 * contact. Measured on a desktop: 1.2–1.5 ms a bank plan against 0.3 ms (two balls, pool9). The
 * figures above are a direct plan's, so a bank search gets this many times fewer evaluations and
 * does not refine them (planner.worker.ts).
 */
export const BANK_EVALUATION_COST = 5;
/** Floor of any figure (ms), so a budget never divides by zero. */
const MIN_MS = 0.05;

export interface EvaluationBudget {
  /** Strokes the search may evaluate for `layout` (calibrates this ball count's cost the first time). */
  budget(layout: TableLayout, request: ShotRequest, params: PhysicsParams): number;
  /**
   * Runs one stroke search on `layout` and times it: the first with enough evaluations refines the
   * figure for this ball count from its own ms per evaluation (once, bounded). Returns `run()`'s result.
   */
  measure<T extends { evaluated: number }>(layout: TableLayout, run: () => T): T;
  /** Adopts figures an earlier worker measured, for ball counts this one has not measured itself (final). */
  seed(known: PlannerPerEvalMs | undefined): void;
  /** Every figure known here (to hand to a later worker). */
  figures(): PlannerPerEvalMs;
}

const validMs = (ms: unknown): ms is number => typeof ms === 'number' && Number.isFinite(ms) && ms > 0;

export function createEvaluationBudget(now: () => number = () => performance.now()): EvaluationBudget {
  /** Per-evaluation ms by ball count; `final` once refined by a search or adopted from a seed. */
  const perEvalMs = new Map<number, { ms: number; final: boolean }>();
  return {
    budget(layout, request, params) {
      const n = layout.balls.length;
      if (!perEvalMs.has(n)) {
        let best = Infinity;
        try {
          const req = { targetId: request.targetId, ...(request.pocketId ? { pocketId: request.pocketId } : {}) };
          const w0 = now();
          let warm = 0;
          do {
            planShot(layout, req, params, SEARCH_PLAN_OPTIONS);
            warm++;
          } while (warm < WARMUP_PLANS && now() - w0 < WARMUP_MS);
          for (let k = 0; k < TIMED_PLANS; k++) {
            const t0 = now();
            planShot(layout, req, params, SEARCH_PLAN_OPTIONS);
            best = Math.min(best, now() - t0);
          }
        } catch {
          // recommendStroke reports the error itself.
        }
        if (Number.isFinite(best)) perEvalMs.set(n, { ms: Math.max(MIN_MS, best), final: false });
      }
      const f = perEvalMs.get(n);
      if (f === undefined) return FULL_EVALUATIONS;
      return Math.max(MIN_EVALUATIONS, Math.min(FULL_EVALUATIONS, Math.floor(RECOMMEND_BUDGET_MS / f.ms)));
    },
    measure(layout, run) {
      const t0 = now();
      const r = run();
      const ms = now() - t0;
      const f = perEvalMs.get(layout.balls.length);
      if (f && !f.final && r.evaluated >= REFINE_MIN_EVALUATIONS && Number.isFinite(ms)) {
        const each = Math.max(0, ms) / r.evaluated;
        perEvalMs.set(layout.balls.length, { ms: Math.max(MIN_MS, f.ms / REFINE_RANGE, Math.min(f.ms * REFINE_RANGE, each)), final: true });
      }
      return r;
    },
    seed(known) {
      if (!known || typeof known !== 'object') return;
      for (const [k, ms] of Object.entries(known)) {
        const n = Number(k);
        if (Number.isInteger(n) && n > 0 && validMs(ms) && !perEvalMs.has(n)) perEvalMs.set(n, { ms: Math.max(MIN_MS, ms), final: true });
      }
    },
    figures() {
      return Object.fromEntries([...perEvalMs].map(([n, f]) => [String(n), f.ms]));
    },
  };
}
