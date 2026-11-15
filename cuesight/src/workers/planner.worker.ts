/// <reference lib="webworker" />
import { positionHeatmap, recommendStroke } from '../core/shot/position';
import { suggestShots } from '../core/shot/suggest';
import { createEvaluationBudget } from './eval-budget';
import { PROTOCOL_VERSION, isSupported, type PlannerIn, type PlannerOut } from './protocol';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

/**
 * Safety net only, at the device budget for a position search (< 1.5 s, Constitution IV): stops a
 * search the calibration under-estimated (reported as `timedOut`, so the app can say it is partial).
 */
const RECOMMEND_TIME_CAP_MS = 1500;

/**
 * Evaluation budget, fixed per device and ball count (eval-budget.ts). Its figures come back with
 * every recommendation and return with the next request, so a restarted worker keeps them.
 */
const evalBudget = createEvaluationBudget();

ctx.onmessage = (ev: MessageEvent<PlannerIn>) => {
  const msg = ev.data;
  const post = (m: PlannerOut, t: Transferable[] = []) => ctx.postMessage(m, t);
  if (!isSupported(msg)) {
    post({ v: PROTOCOL_VERSION, type: 'error', message: 'Unsupported protocol version' });
    return;
  }
  try {
    switch (msg.type) {
      case 'recommend': {
        evalBudget.seed(msg.perEvalMs);
        const maxEvaluations = evalBudget.budget(msg.layout, msg.request, msg.params);
        const r = recommendStroke(msg.layout, msg.request, msg.params, {
          ...(msg.request.landing ? { landing: msg.request.landing } : {}),
          maxEvaluations,
          timeCapMs: RECOMMEND_TIME_CAP_MS,
        });
        post({ v: PROTOCOL_VERSION, type: 'recommendation', id: msg.id, ...r, perEvalMs: evalBudget.figures() });
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
