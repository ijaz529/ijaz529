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
/**
 * Safety net only, at the device budget for a position search (< 1.5 s, Constitution IV): stops a
 * search the calibration under-estimated (reported as `timedOut`, so the app can say it is partial).
 */
const RECOMMEND_TIME_CAP_MS = 1500;

/**
 * Cost of one planShot on this device, measured once per number of balls on the table (best of 3
 * after the first call warms the JIT): simulation cost grows with the ball count, so one figure
 * from the first, perhaps sparse, layout would over-budget a full rack. The evaluation budget is
 * then fixed per device and ball count, and the core search stays deterministic for it.
 */
const perEvalMs = new Map<number, number>();
function evaluationBudget(layout: TableLayout, request: ShotRequest, params: PhysicsParams): number {
  const n = layout.balls.length;
  if (!perEvalMs.has(n)) {
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
    if (Number.isFinite(best)) perEvalMs.set(n, Math.max(0.05, best));
  }
  const ms = perEvalMs.get(n);
  if (ms === undefined) return FULL_EVALUATIONS;
  return Math.max(MIN_EVALUATIONS, Math.min(FULL_EVALUATIONS, Math.floor(RECOMMEND_BUDGET_MS / ms)));
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
        const values = positionHeatmap(msg.layout, msg.nextBallId, msg.cols, msg.rows, msg.excludeIds, msg.params);
        post({ v: PROTOCOL_VERSION, type: 'heatmap', id: msg.id, cols: msg.cols, rows: msg.rows, values }, [values.buffer]);
        break;
      }
    }
  } catch (e) {
    post({ v: PROTOCOL_VERSION, type: 'error', id: msg.id, message: String(e) });
  }
};
