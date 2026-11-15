/**
 * Planner-worker plumbing with the stale-result rule enforced against the player's latest request
 * (unit-tested in tests/unit/app/planner-client.test.ts):
 *  - a recommendation is debounced; the message and its key are captured when it is scheduled, and a
 *    reply is accepted only for the latest request *and* the key still wanted (a reply for the previous
 *    target arriving during the next debounce is dropped);
 *  - suggestions and heatmaps: only the latest request's reply, and none after `cancel`;
 *  - a superseded recommendation still being computed (one stroke search, up to ~1.5 s) is abandoned
 *    by restarting the worker when nothing else waits on it, so the latest request starts at once;
 *  - `error` replies and a worker that fails to load or to deliver a message clear what was pending
 *    (`onFailure`), so no spinner waits forever; a failed worker is dropped and recreated on the next send;
 *  - the worker's evaluation-budget figures (`perEvalMs`, from every recommendation reply) are kept
 *    here and sent with each recommendation, so a restarted worker searches with the same budget and
 *    the same request still gets the same stroke.
 */
import type { Stroke } from '../core/types';
import { PROTOCOL_VERSION, type PlannerIn, type PlannerOut, type PlannerPerEvalMs } from '../workers/protocol';

export type PlannerKind = 'recommend' | 'suggest' | 'heatmap';
type Msg<K extends PlannerIn['type']> = Omit<Extract<PlannerIn, { type: K }>, 'v' | 'id'>;
export type RecommendationReply = Extract<PlannerOut, { type: 'recommendation' }>;

/** Calls `onFail` when `worker` cannot load its script or deliver a message (and stops the default console error). */
export function watchWorker(worker: Worker, onFail: (message: string) => void): void {
  const fail = (ev: Event) => {
    ev.preventDefault?.();
    onFail((ev as ErrorEvent).message || (ev.type === 'messageerror' ? 'message could not be read' : 'worker failed'));
  };
  worker.onerror = fail;
  worker.onmessageerror = fail;
}

export interface PlannerClientOptions {
  createWorker(): Worker;
  /** Debounce of recommendations (ms, default 180). */
  debounceMs?: number;
  onRecommendation(key: string, m: RecommendationReply): void;
  onSuggestions(m: Extract<PlannerOut, { type: 'suggestions' }>): void;
  onHeatmap(m: Extract<PlannerOut, { type: 'heatmap' }>): void;
  /** A pending request of `kind` failed (an error reply, or the worker died); `key` for recommendations. */
  onFailure(kind: PlannerKind, key: string | undefined, message: string): void;
}

export function createPlannerClient(o: PlannerClientOptions) {
  let worker: Worker | null = null;
  let reqId = 0;
  /** The request whose reply is awaited, per kind (absent = nothing awaited). */
  const latest: Partial<Record<PlannerKind, number>> = {};
  /** The key the app currently wants a recommendation for, and the key each sent request was for. */
  let wantedKey: string | null = null;
  const keyById = new Map<number, string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** A sent recommendation whose reply has not arrived yet (the worker is busy with it). */
  let computing: number | null = null;
  /** Per-evaluation cost by ball count measured by a planner worker of this page (outlives restarts). */
  const perEvalMs: PlannerPerEvalMs = {};

  function drop(): void {
    const w = worker;
    worker = null;
    computing = null;
    try {
      w?.terminate();
    } catch {
      /* already gone */
    }
  }

  function fail(message: string): void {
    drop();
    for (const kind of ['recommend', 'suggest', 'heatmap'] as const) {
      const id = latest[kind];
      if (id === undefined) continue;
      delete latest[kind];
      const key = kind === 'recommend' ? keyById.get(id) : undefined;
      keyById.delete(id);
      o.onFailure(kind, key, message);
    }
  }

  function ensure(): Worker {
    if (!worker) {
      const w = o.createWorker();
      worker = w;
      w.onmessage = (ev: MessageEvent<PlannerOut>) => onMessage(ev.data);
      watchWorker(w, (msg) => {
        if (worker === w) fail(msg);
      });
    }
    return worker;
  }

  function post(kind: PlannerKind, msg: Omit<PlannerIn, 'v' | 'id'>): number {
    const id = ++reqId;
    latest[kind] = id;
    ensure().postMessage({ ...msg, v: PROTOCOL_VERSION, id } as PlannerIn);
    return id;
  }

  function onMessage(m: PlannerOut): void {
    switch (m.type) {
      case 'recommendation': {
        // Budget figures are valid whatever the reply's fate (even a superseded request measured them).
        if (m.perEvalMs && typeof m.perEvalMs === 'object') Object.assign(perEvalMs, m.perEvalMs);
        if (m.id === computing) computing = null;
        if (m.id !== latest.recommend) return;
        const key = keyById.get(m.id);
        keyById.delete(m.id);
        delete latest.recommend;
        if (key === undefined || key !== wantedKey) return;
        o.onRecommendation(key, m);
        return;
      }
      case 'suggestions':
        if (m.id !== latest.suggest) return;
        delete latest.suggest;
        o.onSuggestions(m);
        return;
      case 'heatmap':
        if (m.id !== latest.heatmap) return;
        delete latest.heatmap;
        o.onHeatmap(m);
        return;
      case 'error': {
        if (m.id !== undefined && m.id === computing) computing = null;
        if (m.id === undefined) {
          // Not tied to a request (e.g. a protocol mismatch): everything pending is lost.
          fail(m.message);
          return;
        }
        const kind = (['recommend', 'suggest', 'heatmap'] as const).find((k) => latest[k] === m.id);
        if (!kind) return; // an old request nobody waits for any more
        delete latest[kind];
        const key = kind === 'recommend' ? keyById.get(m.id) : undefined;
        keyById.delete(m.id);
        o.onFailure(kind, key, m.message);
        return;
      }
    }
  }

  return {
    /**
     * Asks for the recommended stroke for `key` after the debounce. Supersedes every earlier request:
     * their replies are dropped from now on. `msg` is captured now (not read when the timer fires).
     */
    recommend(key: string, msg: Msg<'recommend'>): void {
      // Exactly this is already scheduled or being computed (e.g. the state was reset and re-asked for
      // the same inputs): keep that request rather than start the work again.
      const inFlight = latest.recommend !== undefined && keyById.get(latest.recommend) === key;
      if (key === wantedKey && (timer !== undefined || inFlight)) return;
      wantedKey = key;
      delete latest.recommend;
      clearTimeout(timer);
      const captured = { ...msg };
      timer = setTimeout(() => {
        timer = undefined;
        // Still computing a superseded stroke and nothing else waits on this worker: start afresh.
        if (computing !== null && latest.suggest === undefined && latest.heatmap === undefined) drop();
        const id = post('recommend', Object.keys(perEvalMs).length ? { ...captured, perEvalMs: { ...perEvalMs } } : captured);
        computing = id;
        keyById.set(id, key);
      }, o.debounceMs ?? 180);
    },
    send(kind: 'suggest' | 'heatmap', msg: Msg<'suggest'> | Msg<'heatmap'>): number {
      return post(kind, msg);
    },
    /** Nothing of `kind` is wanted any more: a scheduled recommendation is not sent, a late reply is dropped. */
    cancel(kind: PlannerKind): void {
      if (kind === 'recommend') {
        wantedKey = null;
        clearTimeout(timer);
        timer = undefined;
      }
      delete latest[kind];
    },
    /** A request of `kind` is scheduled or awaiting its reply. */
    pending(kind: PlannerKind): boolean {
      return latest[kind] !== undefined || (kind === 'recommend' && timer !== undefined);
    },
  };
}
export type PlannerClient = ReturnType<typeof createPlannerClient>;

/** What the app shows for a recommendation reply: the stroke to use (null = the basic stroke) and a toast. */
export function recommendationOutcome(m: RecommendationReply, hasLanding: boolean): { stroke: Stroke | null; toast: string | null } {
  const found = m.evaluated > 0 && Number.isFinite(m.score);
  // Nothing evaluated: the shot itself is not makeable, which the shot card already says.
  if (!found) return { stroke: null, toast: hasLanding && m.evaluated > 0 ? 'No stroke reaches that spot cleanly — showing the basic stroke.' : null };
  // `fragile` (core types.ts): no candidate was verified against ±6/±12 % speed errors — one scratched
  // or missed at some speed, or the budget ran out first. So: "may", and both ways it can go wrong.
  const fragile = m.fragile === true;
  if (hasLanding && !m.reachable) return { stroke: m.stroke, toast: 'That spot can’t be reached safely — showing the best stroke found.' };
  if (fragile) return { stroke: m.stroke, toast: 'This stroke may need precise pace: a little harder or softer could miss or scratch.' };
  return { stroke: m.stroke, toast: null };
}
