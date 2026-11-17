/// <reference lib="webworker" />
/**
 * Planner worker (protocol v2, specs/002-3d-visual-ios/contracts/worker-protocol-v2.md): the stroke
 * search ('recommend'), suggestions, the next-shot heatmap and the full plan with the frozen power
 * advice ('plan'). The handler is a plain function (testable in Node); it is bound to `onmessage`
 * only inside a worker.
 */
import { planShot } from '../core/shot/planner';
import { positionHeatmap, recommendStroke } from '../core/shot/position';
import { suggestShots } from '../core/shot/suggest';
import { BANK_EVALUATION_COST, MIN_EVALUATIONS, createEvaluationBudget, type EvaluationBudget } from './eval-budget';
import { PROTOCOL_VERSION, isSupported, type PlannerIn, type PlannerOut } from './protocol';

/**
 * Safety net only, at the device budget for a position search (< 1.5 s, Constitution IV): stops a
 * search the calibration under-estimated (reported as `timedOut`, so the app can say it is partial).
 */
const RECOMMEND_TIME_CAP_MS = 1500;

export type PlannerPost = (m: PlannerOut, transfer?: Transferable[]) => void;

/**
 * Stateful message handler. The evaluation budget is per device and ball count (eval-budget.ts): a
 * warm calibration, refined once by the first real search, then fixed; its figures come back with
 * every recommendation and return with the next request, so a restarted worker keeps them.
 */
export function createPlannerHandler(evalBudget: EvaluationBudget = createEvaluationBudget()): (msg: PlannerIn, post: PlannerPost) => void {
  return (msg, post) => {
    if (!isSupported(msg)) {
      post({ v: PROTOCOL_VERSION, type: 'error', message: 'Unsupported protocol version' });
      return;
    }
    try {
      switch (msg.type) {
        case 'recommend': {
          evalBudget.seed(msg.perEvalMs);
          // A bank's evaluations cost several direct ones: fewer of them, and no part in the figure.
          const bank = !!msg.request.bank;
          const direct = evalBudget.budget(msg.layout, msg.request, msg.params);
          const maxEvaluations = bank ? Math.max(MIN_EVALUATIONS, Math.floor(direct / BANK_EVALUATION_COST)) : direct;
          const search = () =>
            recommendStroke(msg.layout, msg.request, msg.params, {
              ...(msg.request.landing ? { landing: msg.request.landing } : {}),
              maxEvaluations,
              timeCapMs: RECOMMEND_TIME_CAP_MS,
            });
          // Timed: the first real search refines the budget's figure from its own ms per evaluation.
          const r = bank ? search() : evalBudget.measure(msg.layout, search);
          post({ v: PROTOCOL_VERSION, type: 'recommendation', id: msg.id, ...r, perEvalMs: evalBudget.figures() });
          break;
        }
        case 'plan': {
          // The plan the app shows (recorded), with the frozen power advice its own plan skipped.
          const o = msg.opts ?? {};
          const plan = planShot(msg.layout, msg.request, msg.params, { ...(o.names ? { names: o.names } : {}), ...(o.recommended ? { recommended: o.recommended } : {}), advice: true });
          post({ v: PROTOCOL_VERSION, type: 'plan', id: msg.id, plan });
          break;
        }
        case 'suggest':
          post({ v: PROTOCOL_VERSION, type: 'suggestions', id: msg.id, items: suggestShots(msg.layout, msg.params, msg.max) });
          break;
        case 'heatmap': {
          const values = positionHeatmap(msg.layout, msg.nextBallId, msg.cols, msg.rows, msg.excludeIds, msg.params);
          post({ v: PROTOCOL_VERSION, type: 'heatmap', id: msg.id, cols: msg.cols, rows: msg.rows, values }, [values.buffer]);
          break;
        }
      }
    } catch (e) {
      post({ v: PROTOCOL_VERSION, type: 'error', id: msg.id, message: String(e) });
    }
  };
}

// Bind only when running as a dedicated worker (not when imported by tests).
if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {
  const ctx = self as unknown as DedicatedWorkerGlobalScope;
  const handle = createPlannerHandler();
  ctx.onmessage = (ev: MessageEvent<PlannerIn>) => handle(ev.data, (m, t = []) => ctx.postMessage(m, t));
}
