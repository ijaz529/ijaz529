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
 *    the same request still gets the same stroke;
 *  - the full plan with the frozen power advice (`plan`) is debounced like a recommendation (a slider
 *    drag asks once, where it settles) and accepted only for the key the app still shows; while one is
 *    awaited the worker is not restarted.
 */
import type { PhysicsParams, Recommendation, ShotPlan, ShotRequest, Stroke, TableLayout } from '../core/types';
import { PROTOCOL_VERSION, type PlannerIn, type PlannerOut, type PlannerPerEvalMs, type PlannerPlanOptions } from '../workers/protocol';

export type PlannerKind = 'recommend' | 'suggest' | 'heatmap' | 'plan';
type Msg<K extends PlannerIn['type']> = Omit<Extract<PlannerIn, { type: K }>, 'v' | 'id'>;
export type RecommendationReply = Extract<PlannerOut, { type: 'recommendation' }>;
export type PlanReply = Extract<PlannerOut, { type: 'plan' }>;

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
  /** Debounce of full-plan requests (ms, default 120). */
  planDebounceMs?: number;
  onRecommendation(key: string, m: RecommendationReply): void;
  /** The full plan (frozen power advice included) for `key`, the plan key the app still shows. */
  onPlan?(key: string, m: PlanReply): void;
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
  /** The same for full-plan requests, and the message of the one awaited (re-sent after a restart). */
  let wantedPlanKey: string | null = null;
  let planTimer: ReturnType<typeof setTimeout> | undefined;
  let planSent: Msg<'plan'> | null = null;
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
    for (const kind of ['recommend', 'suggest', 'heatmap', 'plan'] as const) {
      const id = latest[kind];
      if (id === undefined) continue;
      delete latest[kind];
      const key = kind === 'recommend' || kind === 'plan' ? keyById.get(id) : undefined;
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
      case 'plan': {
        if (m.id !== latest.plan) return;
        const key = keyById.get(m.id);
        keyById.delete(m.id);
        delete latest.plan;
        if (key === undefined || key !== wantedPlanKey) return;
        o.onPlan?.(key, m);
        return;
      }
      case 'error': {
        if (m.id !== undefined && m.id === computing) computing = null;
        if (m.id === undefined) {
          // Not tied to a request (e.g. a protocol mismatch): everything pending is lost.
          fail(m.message);
          return;
        }
        const kind = (['recommend', 'suggest', 'heatmap', 'plan'] as const).find((k) => latest[k] === m.id);
        if (!kind) return; // an old request nobody waits for any more
        delete latest[kind];
        const key = kind === 'recommend' || kind === 'plan' ? keyById.get(m.id) : undefined;
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
        // Still computing a superseded stroke and nothing else waits on this worker: start afresh. A
        // plan request queued behind it is asked again of the new worker (it takes milliseconds).
        if (computing !== null && latest.suggest === undefined && latest.heatmap === undefined) {
          const replay = latest.plan !== undefined && planSent ? { key: keyById.get(latest.plan), msg: planSent } : null;
          if (latest.plan !== undefined) keyById.delete(latest.plan);
          drop();
          if (replay?.key !== undefined) keyById.set(post('plan', replay.msg), replay.key);
          else delete latest.plan;
        }
        const id = post('recommend', Object.keys(perEvalMs).length ? { ...captured, perEvalMs: { ...perEvalMs } } : captured);
        computing = id;
        keyById.set(id, key);
      }, o.debounceMs ?? 180);
    },
    send(kind: 'suggest' | 'heatmap', msg: Msg<'suggest'> | Msg<'heatmap'>): number {
      return post(kind, msg);
    },
    /**
     * Asks for the full plan (frozen power advice included) for plan key `key` after the debounce.
     * Supersedes every earlier plan request; `msg` is captured now.
     */
    plan(key: string, msg: Msg<'plan'>): void {
      const inFlight = latest.plan !== undefined && keyById.get(latest.plan) === key;
      if (key === wantedPlanKey && (planTimer !== undefined || inFlight)) return;
      wantedPlanKey = key;
      delete latest.plan;
      clearTimeout(planTimer);
      const captured = { ...msg };
      planTimer = setTimeout(() => {
        planTimer = undefined;
        planSent = captured;
        keyById.set(post('plan', captured), key);
      }, o.planDebounceMs ?? 120);
    },
    /** Nothing of `kind` is wanted any more: a scheduled request is not sent, a late reply is dropped. */
    cancel(kind: PlannerKind): void {
      if (kind === 'recommend') {
        wantedKey = null;
        clearTimeout(timer);
        timer = undefined;
      }
      if (kind === 'plan') {
        wantedPlanKey = null;
        clearTimeout(planTimer);
        planTimer = undefined;
      }
      delete latest[kind];
    },
    /** A request of `kind` is scheduled or awaiting its reply. */
    pending(kind: PlannerKind): boolean {
      return latest[kind] !== undefined || (kind === 'recommend' && timer !== undefined) || (kind === 'plan' && planTimer !== undefined);
    },
  };
}
export type PlannerClient = ReturnType<typeof createPlannerClient>;

/** What the app shows for a recommendation reply: the stroke to use (null = the basic stroke) and a toast. */
export function recommendationOutcome(m: RecommendationReply, hasLanding: boolean): { stroke: Stroke | null; toast: string | null } {
  const found = m.evaluated > 0 && Number.isFinite(m.score);
  // Nothing evaluated: the shot itself is not makeable, which the shot card already says. Strokes
  // tried and a non-finite score: none of them pots the ball (core types.ts), so say so.
  if (!found) {
    if (m.evaluated <= 0) return { stroke: null, toast: null };
    // position.ts drops a stroke that scratches as well as one that misses: "without a scratch".
    return {
      stroke: null,
      toast: hasLanding ? 'No stroke reaches that spot cleanly — showing the basic stroke.' : 'None of the strokes tried pots this ball without a scratch — showing the basic stroke.',
    };
  }
  // `fragile` (core types.ts): no candidate was verified against ±6/±12 % speed errors — one scratched
  // or missed at some speed, or the budget ran out first. So: "may", and both ways it can go wrong.
  const fragile = m.fragile === true;
  if (hasLanding && !m.reachable) return { stroke: m.stroke, toast: 'That spot can’t be reached safely — showing the best stroke found.' };
  if (fragile) return { stroke: m.stroke, toast: 'This stroke may need precise pace: a little harder or softer could miss or scratch.' };
  return { stroke: m.stroke, toast: null };
}

/** What the app keeps of a recommendation (AppState.recommended), the shot card and labels read. */
export interface RecommendedFields {
  stroke: Stroke | null;
  pending: false;
  reachable: boolean;
  evaluated: number;
  /** Absent = not known (never "safe"); [] = the checks ran and saw no scratch. */
  risks?: Recommendation['risks'];
  /** No stroke was verified against ±6/±12 % speed errors: say the pace may matter. */
  fragile?: boolean;
  /** The search was cut short by its time cap: a partial search. */
  timedOut?: boolean;
  /** Next-shot quality 0..1 of the chosen stroke (default objective only). */
  nextQuality?: number;
}

/**
 * The recommendation reply as the app stores it: the outcome's stroke (null = the basic stroke), and
 * wave 1's fragile / timedOut / nextQuality / risks exactly as the reply has them. A field the reply
 * leaves out stays out: `risks` undefined means "not known", never an empty (safe) list.
 */
export function recommendedFromReply(m: RecommendationReply, out: { stroke: Stroke | null }): RecommendedFields {
  return {
    stroke: out.stroke,
    pending: false,
    reachable: m.reachable,
    evaluated: m.evaluated,
    ...(Array.isArray(m.risks) ? { risks: m.risks } : {}),
    ...(typeof m.fragile === 'boolean' ? { fragile: m.fragile } : {}),
    ...(typeof m.timedOut === 'boolean' ? { timedOut: m.timedOut } : {}),
    ...(typeof m.nextQuality === 'number' && Number.isFinite(m.nextQuality) ? { nextQuality: m.nextQuality } : {}),
  };
}

/**
 * The options of a plan request as planShot reads them: a request with a stroke (the player's own)
 * plays that stroke and ignores `recommended` (planner.ts: request.stroke ?? opts.recommended ??
 * the default), so it is not sent and not keyed. Kept in, a recommendation reply landing after the
 * player set a stroke changed the key of the very same plan: the worker's full plan was thrown away
 * and asked for again, and the card flickered back to the plan without the power figure.
 */
export function fullPlanOptions(request: ShotRequest, opts: PlannerPlanOptions): PlannerPlanOptions {
  if (!request.stroke || opts.recommended === undefined) return opts;
  const { recommended: _ignored, ...rest } = opts;
  return rest;
}

/**
 * The identity of a plan request (`plan` messages): the table (its size, not only its preset id),
 * the exact ball positions (not rounded: the worker's plan replaces the shown one as is), the
 * request, the physics and the options planShot reads (fullPlanOptions).
 */
export function planRequestKey(layout: TableLayout, request: ShotRequest, params: PhysicsParams, opts: PlannerPlanOptions): string {
  return JSON.stringify([layout.table, layout.balls.map((b) => [b.id, b.kind, b.pos.x, b.pos.y]), request, params, fullPlanOptions(request, opts)]);
}

/** The card plan of each plan whose frozen power advice is still coming (one object per plan). */
const cardPlans = new WeakMap<ShotPlan, ShotPlan>();

/**
 * The plan as the shot card gets it. A frozen cue ball's plan made without the power advice
 * (ShotPlan.adviceSkipped: the worker's full plan is on its way, or it failed) carries the minimum
 * for the stroke angle at the played power, not the power to play — harder throws less, so the
 * angle and the minimum move with the power. The card must not draw it as "Minimum x": it gets the
 * plan with a non-finite minPower (shot-card / power-meter draw no tick and no figure for one) and no
 * capture minimum. Any other plan goes as it is. The same plan gives the same object, so the card
 * (which redraws only for a new plan object) keeps its focus.
 */
export function cardPlanOf(plan: ShotPlan | null): ShotPlan | null {
  if (!plan?.adviceSkipped) return plan;
  let shown = cardPlans.get(plan);
  if (!shown) {
    const { minPowerCapture: _unknown, ...rest } = plan;
    shown = { ...rest, minPower: Number.NaN, minPowerSafe: Number.NaN };
    cardPlans.set(plan, shown);
  }
  return shown;
}

/**
 * Whether the card shows its details list (Settings → details): not for a plan whose power advice
 * is still coming, whose "Min power" row would print the figure cardPlanOf withholds.
 */
export function cardDetailsShown(plan: ShotPlan | null, showDetails: boolean): boolean {
  return showDetails && !plan?.adviceSkipped;
}
