/// <reference lib="webworker" />
import { planShot } from '../core/shot/planner';
import { FULL_EVALUATIONS, positionHeatmap, recommendStroke } from '../core/shot/position';
import { suggestShots } from '../core/shot/suggest';
import type { PhysicsParams, ShotRequest, TableLayout } from '../core/types';
import { PROTOCOL_VERSION, isSupported, type PlannerIn, type PlannerOut } from './protocol';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

/** Device budget for one recommendation (position search < 1.5 s, Constitution IV), with headroom. */
const RECOMMEND_BUDGET_MS = 1200;
/** Never search fewer strokes than this (every power at three tip heights, plus some robustness). */
const MIN_EVALUATIONS = 60;
/** Safety net only: stop a search that runs far over budget (reported as `timedOut`). */
const RECOMMEND_TIME_CAP_MS = 4000;

/**
 * Cost of one planShot on this device, measured once (best of 3 after the first call warms the JIT),
 * so the evaluation budget is fixed per device and the core search stays deterministic for it.
 */
let perEvalMs: number | null = null;
function evaluationBudget(layout: TableLayout, request: ShotRequest, params: PhysicsParams): number {
  if (perEvalMs === null) {
    let best = Infinity;
    try {
      const req = { targetId: request.targetId, ...(request.pocketId ? { pocketId: request.pocketId } : {}) };
      for (let k = 0; k < 4; k++) {
        const t0 = performance.now();
        planShot(layout, req, params, { record: false });
        if (k > 0) best = Math.min(best, performance.now() - t0);
      }
    } catch {
      // recommendStroke reports the error itself.
    }
    if (Number.isFinite(best)) perEvalMs = Math.max(0.05, best);
  }
  if (perEvalMs === null) return FULL_EVALUATIONS;
  return Math.max(MIN_EVALUATIONS, Math.min(FULL_EVALUATIONS, Math.floor(RECOMMEND_BUDGET_MS / perEvalMs)));
}

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
        const maxEvaluations = evaluationBudget(msg.layout, msg.request, msg.params);
        const r = recommendStroke(msg.layout, msg.request, msg.params, {
          ...(msg.request.landing ? { landing: msg.request.landing } : {}),
          maxEvaluations,
          timeCapMs: RECOMMEND_TIME_CAP_MS,
        });
        post({ v: PROTOCOL_VERSION, type: 'recommendation', id: msg.id, ...r });
        break;
      }
      case 'suggest':
        post({ v: PROTOCOL_VERSION, type: 'suggestions', id: msg.id, items: suggestShots(msg.layout, msg.params, msg.max) });
        break;
      case 'heatmap': {
        const values = positionHeatmap(msg.layout, msg.nextBallId, msg.cols, msg.rows, msg.excludeIds);
        post({ v: PROTOCOL_VERSION, type: 'heatmap', id: msg.id, cols: msg.cols, rows: msg.rows, values }, [values.buffer]);
        break;
      }
    }
  } catch (e) {
    post({ v: PROTOCOL_VERSION, type: 'error', id: msg.id, message: String(e) });
  }
};
