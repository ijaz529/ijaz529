import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPlannerClient, recommendationOutcome, recommendedFromReply, watchWorker, type PlannerKind, type RecommendationReply } from '../../../src/app/planner-client';
import { PROTOCOL_VERSION, type PlannerIn, type PlannerOut } from '../../../src/workers/protocol';

/** A planner worker the test answers by hand. */
class FakeWorker {
  posted: PlannerIn[] = [];
  terminated = false;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onmessageerror: ((ev: MessageEvent) => void) | null = null;
  postMessage(m: PlannerIn): void {
    this.posted.push(m);
  }
  terminate(): void {
    this.terminated = true;
  }
  reply(m: PlannerOut): void {
    this.onmessage?.({ data: m } as MessageEvent);
  }
  last(type: PlannerIn['type']): PlannerIn {
    return [...this.posted].reverse().find((m) => m.type === type)!;
  }
}

const stroke = { power: 4, side: 0, vert: 0 };
const recReply = (id: number, extra: Partial<RecommendationReply> = {}): RecommendationReply => ({
  v: PROTOCOL_VERSION,
  type: 'recommendation',
  id,
  stroke,
  score: 1,
  reachable: true,
  evaluated: 40,
  ...extra,
});
const msg = (target: string) => ({ type: 'recommend' as const, layout: { target } as never, request: { targetId: target }, params: {} as never });

describe('planner client: stale replies are dropped (the stale-result rule)', () => {
  let workers: FakeWorker[];
  let got: { rec: [string, number][]; sug: number; heat: number; fail: [PlannerKind, string | undefined][] };
  let client: ReturnType<typeof createPlannerClient>;
  beforeEach(() => {
    vi.useFakeTimers();
    workers = [];
    got = { rec: [], sug: 0, heat: 0, fail: [] };
    client = createPlannerClient({
      createWorker: () => {
        const w = new FakeWorker();
        workers.push(w);
        return w as unknown as Worker;
      },
      onRecommendation: (key, m) => got.rec.push([key, m.id]),
      onSuggestions: () => got.sug++,
      onHeatmap: () => got.heat++,
      onFailure: (kind, key) => got.fail.push([kind, key]),
    });
  });
  afterEach(() => vi.useRealTimers());

  it('a reply for the previous target that arrives during the next debounce is not stamped onto the new key', () => {
    client.recommend('k-b1', msg('b1'));
    vi.advanceTimersByTime(180);
    const w = workers[0]!;
    const b1 = w.last('recommend');
    vi.advanceTimersByTime(220); // tap b2 at +400 ms
    client.recommend('k-b2', msg('b2'));
    w.reply(recReply(b1.id)); // b1's answer lands inside b2's debounce
    expect(got.rec).toEqual([]);
    expect(client.pending('recommend')).toBe(true);
    vi.advanceTimersByTime(180);
    const b2 = w.last('recommend');
    expect((b2 as Extract<PlannerIn, { type: 'recommend' }>).request.targetId).toBe('b2');
    w.reply(recReply(b2.id));
    expect(got.rec).toEqual([['k-b2', b2.id]]);
    expect(client.pending('recommend')).toBe(false);
  });

  it('a superseded recommendation still computing is abandoned (fresh worker), unless other work waits on it', () => {
    client.recommend('k1', msg('b1'));
    vi.advanceTimersByTime(180);
    const w0 = workers[0]!;
    client.recommend('k2', msg('b2')); // b1's search is still running
    vi.advanceTimersByTime(180);
    expect(w0.terminated).toBe(true);
    const w1 = workers[1]!;
    expect((w1.last('recommend') as Extract<PlannerIn, { type: 'recommend' }>).request.targetId).toBe('b2');
    w1.reply(recReply(w1.last('recommend').id));
    expect(got.rec.map((r) => r[0])).toEqual(['k2']);
    // With a suggestion pending on the same worker, it is not thrown away: the new request queues.
    client.recommend('k3', msg('b3'));
    vi.advanceTimersByTime(180);
    client.send('suggest', { type: 'suggest', layout: {} as never, params: {} as never, max: 3 });
    client.recommend('k4', msg('b4'));
    vi.advanceTimersByTime(180);
    expect(w1.terminated).toBe(false);
    expect((w1.last('recommend') as Extract<PlannerIn, { type: 'recommend' }>).request.targetId).toBe('b4');
    expect(workers.length).toBe(2);
  });

  it('a restarted worker gets the evaluation-budget figures of the one it replaced (same budget, same stroke)', () => {
    const rec = (w: FakeWorker) => w.last('recommend') as Extract<PlannerIn, { type: 'recommend' }>;
    client.recommend('k1', msg('b1'));
    vi.advanceTimersByTime(180);
    const w0 = workers[0]!;
    expect(rec(w0).perEvalMs).toBeUndefined(); // nothing measured yet: the first worker measures
    w0.reply(recReply(rec(w0).id, { perEvalMs: { '4': 3.5 } }));
    // A superseded reply still carries valid figures (they describe the device, not the request).
    client.recommend('k2', msg('b2'));
    vi.advanceTimersByTime(180);
    client.recommend('k3', msg('b3'));
    w0.reply(recReply(rec(w0).id, { perEvalMs: { '4': 3.5, '10': 6.25 } }));
    vi.advanceTimersByTime(180);
    expect(rec(w0).perEvalMs).toEqual({ '4': 3.5, '10': 6.25 });
    // b3's search is still running when b4 is asked for: the worker is restarted, the figures are not lost.
    client.recommend('k4', msg('b4'));
    vi.advanceTimersByTime(180);
    expect(w0.terminated).toBe(true);
    const w1 = workers[1]!;
    expect(rec(w1).request.targetId).toBe('b4');
    expect(rec(w1).perEvalMs).toEqual({ '4': 3.5, '10': 6.25 });
  });

  it('asking again for the same key while it is scheduled or in flight keeps that request', () => {
    client.recommend('k', msg('b1'));
    vi.advanceTimersByTime(100);
    client.recommend('k', msg('b1')); // still in its debounce: not pushed back
    vi.advanceTimersByTime(80);
    const w = workers[0]!;
    expect(w.posted.length).toBe(1);
    client.recommend('k', msg('b1')); // in flight
    vi.advanceTimersByTime(500);
    expect(w.posted.length).toBe(1);
    w.reply(recReply(w.posted[0]!.id));
    expect(got.rec).toEqual([['k', w.posted[0]!.id]]);
    // Answered: a new ask for the same key is a new request.
    client.recommend('k', msg('b1'));
    vi.advanceTimersByTime(180);
    expect(w.posted.length).toBe(2);
  });

  it('the message is captured when the request is scheduled, not when the timer fires', () => {
    const m = msg('b1');
    client.recommend('k', m);
    m.request = { targetId: 'changed later' };
    vi.advanceTimersByTime(180);
    expect((workers[0]!.last('recommend') as Extract<PlannerIn, { type: 'recommend' }>).request.targetId).toBe('b1');
  });

  it('a cancelled recommendation is never sent nor accepted', () => {
    client.recommend('k', msg('b1'));
    client.cancel('recommend');
    vi.advanceTimersByTime(500);
    expect(workers.length).toBe(0);
    client.recommend('k2', msg('b2'));
    vi.advanceTimersByTime(180);
    const id = workers[0]!.last('recommend').id;
    client.cancel('recommend');
    workers[0]!.reply(recReply(id));
    expect(got.rec).toEqual([]);
  });

  it('Suggest, then close before the reply: the reply is dropped; a newer request wins', () => {
    client.send('suggest', { type: 'suggest', layout: {} as never, params: {} as never, max: 3 });
    const w = workers[0]!;
    const first = w.last('suggest').id;
    client.cancel('suggest');
    w.reply({ v: PROTOCOL_VERSION, type: 'suggestions', id: first, items: [] });
    expect(got.sug).toBe(0);
    client.send('suggest', { type: 'suggest', layout: {} as never, params: {} as never, max: 3 });
    const second = w.last('suggest').id;
    w.reply({ v: PROTOCOL_VERSION, type: 'suggestions', id: first, items: [] });
    expect(got.sug).toBe(0);
    w.reply({ v: PROTOCOL_VERSION, type: 'suggestions', id: second, items: [] });
    expect(got.sug).toBe(1);
  });

  it('an error reply for the latest request clears that request (and only that one)', () => {
    client.recommend('k', msg('b1'));
    vi.advanceTimersByTime(180);
    client.send('heatmap', { type: 'heatmap', layout: {} as never, nextBallId: 'b2', excludeIds: [], params: {} as never, cols: 4, rows: 2 });
    const w = workers[0]!;
    w.reply({ v: PROTOCOL_VERSION, type: 'error', id: w.last('recommend').id, message: 'boom' });
    expect(got.fail).toEqual([['recommend', 'k']]);
    expect(client.pending('recommend')).toBe(false);
    expect(client.pending('heatmap')).toBe(true);
    // An error for a request nobody waits for any more is ignored.
    w.reply({ v: PROTOCOL_VERSION, type: 'error', id: 9999, message: 'old' });
    expect(got.fail.length).toBe(1);
  });

  it('a worker that fails to load clears every pending request; the next send recreates it', () => {
    client.recommend('k', msg('b1'));
    vi.advanceTimersByTime(180);
    client.send('suggest', { type: 'suggest', layout: {} as never, params: {} as never, max: 3 });
    const w = workers[0]!;
    const ev = { preventDefault: vi.fn(), message: 'load failed' } as unknown as Event;
    w.onerror!(ev);
    expect((ev as unknown as { preventDefault: () => void }).preventDefault).toHaveBeenCalled();
    expect(w.terminated).toBe(true);
    expect(got.fail.map((f) => f[0]).sort()).toEqual(['recommend', 'suggest']);
    expect(client.pending('recommend') || client.pending('suggest')).toBe(false);
    client.send('suggest', { type: 'suggest', layout: {} as never, params: {} as never, max: 3 });
    expect(workers.length).toBe(2);
    expect(workers[1]!.posted.length).toBe(1);
  });

  it('a recommendation still waiting for its debounce survives a worker failure and goes to the new worker', () => {
    client.send('suggest', { type: 'suggest', layout: {} as never, params: {} as never, max: 3 });
    client.recommend('k', msg('b1'));
    workers[0]!.onmessageerror!({ data: null } as MessageEvent);
    expect(got.fail.map((f) => f[0])).toEqual(['suggest']);
    vi.advanceTimersByTime(180);
    expect(workers[1]!.last('recommend')).toBeTruthy();
    expect(client.pending('recommend')).toBe(true);
  });
});

describe('planner client: the full plan (frozen power advice) is computed in the worker', () => {
  // A too-soft frozen cue ball's advice re-plans the stroke at every half step (8–70 ms on a desktop,
  // more on a phone): main.ts shows the plan without it at once and asks the worker for the rest.
  let workers: FakeWorker[];
  let plans: [string, number][];
  let fails: [PlannerKind, string | undefined][];
  let client: ReturnType<typeof createPlannerClient>;
  const planMsg = (target: string, power: number) => ({ type: 'plan' as const, layout: { target } as never, request: { targetId: target, stroke: { power, side: 0, vert: 0 } }, params: {} as never });
  const planReply = (id: number): PlannerOut => ({ v: PROTOCOL_VERSION, type: 'plan', id, plan: {} as never });
  beforeEach(() => {
    vi.useFakeTimers();
    workers = [];
    plans = [];
    fails = [];
    client = createPlannerClient({
      createWorker: () => {
        const w = new FakeWorker();
        workers.push(w);
        return w as unknown as Worker;
      },
      onRecommendation: () => {},
      onSuggestions: () => {},
      onHeatmap: () => {},
      onPlan: (key, m) => plans.push([key, m.id]),
      onFailure: (kind, key) => fails.push([kind, key]),
    });
  });
  afterEach(() => vi.useRealTimers());

  it('is debounced (a slider drag asks once, for where it settles) and only the latest key is accepted', () => {
    client.plan('p1', planMsg('b1', 1));
    vi.advanceTimersByTime(60);
    client.plan('p1.5', planMsg('b1', 1.5));
    vi.advanceTimersByTime(60);
    client.plan('p2', planMsg('b1', 2));
    expect(workers.length).toBe(0); // nothing sent while the slider moves
    vi.advanceTimersByTime(120);
    const w = workers[0]!;
    expect(w.posted.map((m) => m.type)).toEqual(['plan']);
    expect((w.last('plan') as Extract<PlannerIn, { type: 'plan' }>).request.stroke!.power).toBe(2);
    expect(client.pending('plan')).toBe(true);
    w.reply(planReply(w.last('plan').id));
    expect(plans).toEqual([['p2', w.last('plan').id]]);
    expect(client.pending('plan')).toBe(false);
  });

  it('a reply for a plan the app no longer shows is dropped (newer request, or cancelled)', () => {
    client.plan('p1', planMsg('b1', 1));
    vi.advanceTimersByTime(120);
    const w = workers[0]!;
    const first = w.last('plan').id;
    client.plan('p2', planMsg('b1', 2));
    w.reply(planReply(first)); // lands inside p2's debounce
    expect(plans).toEqual([]);
    vi.advanceTimersByTime(120);
    const second = w.last('plan').id;
    client.cancel('plan'); // the next replan needed no advice
    w.reply(planReply(second));
    expect(plans).toEqual([]);
    expect(client.pending('plan')).toBe(false);
  });

  it('a superseded recommendation is still abandoned by a restart; a pending plan request goes to the new worker', () => {
    client.recommend('k1', msg('b1'));
    vi.advanceTimersByTime(180);
    client.plan('p', planMsg('b1', 1));
    vi.advanceTimersByTime(120); // queued behind b1's search
    client.recommend('k2', msg('b2'));
    vi.advanceTimersByTime(180);
    expect(workers.length).toBe(2);
    expect(workers[0]!.terminated).toBe(true);
    const w1 = workers[1]!;
    expect(w1.posted.map((m) => m.type).sort()).toEqual(['plan', 'recommend']);
    expect((w1.last('plan') as Extract<PlannerIn, { type: 'plan' }>).request.stroke!.power).toBe(1);
    expect(client.pending('plan')).toBe(true);
    w1.reply(planReply(w1.last('plan').id));
    expect(plans.map((p) => p[0])).toEqual(['p']);
    expect(fails).toEqual([]);
  });

  it('an error reply or a failed worker ends the wait (the plan without the advice stays)', () => {
    client.plan('p', planMsg('b1', 1));
    vi.advanceTimersByTime(120);
    const w = workers[0]!;
    w.reply({ v: PROTOCOL_VERSION, type: 'error', id: w.last('plan').id, message: 'boom' });
    expect(fails).toEqual([['plan', 'p']]);
    client.plan('q', planMsg('b1', 2));
    vi.advanceTimersByTime(120);
    w.onerror!({ preventDefault: vi.fn(), message: 'gone' } as unknown as Event);
    expect(fails).toEqual([
      ['plan', 'p'],
      ['plan', 'q'],
    ]);
    expect(client.pending('plan')).toBe(false);
  });
});

describe('recommendationOutcome: what the app shows for a recommendation', () => {
  it('keeps a found stroke, and says honestly when the spot cannot be reached', () => {
    expect(recommendationOutcome(recReply(1), false)).toEqual({ stroke, toast: null });
    expect(recommendationOutcome(recReply(1, { reachable: false }), true)).toEqual({ stroke, toast: 'That spot can’t be reached safely — showing the best stroke found.' });
  });
  it('flags a fragile stroke (needs precise pace)', () => {
    // Core `fragile` (types.ts): no candidate was verified against ±6/±12 % speed errors — one
    // scratched OR missed at some speed, or the budget ran out first. So the toast may not claim a
    // scratch (or any certainty): it says the pace may matter and what could happen.
    const m = { ...recReply(1), fragile: true } as RecommendationReply;
    expect(recommendationOutcome(m, false).toast).toBe('This stroke may need precise pace: a little harder or softer could miss or scratch.');
    expect(recommendationOutcome(m, false).stroke).toEqual(stroke);
  });
  it('falls back to the basic stroke when nothing was found', () => {
    expect(recommendationOutcome(recReply(1, { score: -Infinity, evaluated: 0, reachable: false }), false)).toEqual({ stroke: null, toast: null });
    // Not makeable at all (nothing evaluated): the card says so; no landing-spot toast on top.
    expect(recommendationOutcome(recReply(1, { score: -Infinity, evaluated: 0, reachable: false }), true)).toEqual({ stroke: null, toast: null });
    expect(recommendationOutcome(recReply(1, { score: -Infinity, evaluated: 30, reachable: false }), true)).toEqual({ stroke: null, toast: 'No stroke reaches that spot cleanly — showing the basic stroke.' });
    expect(recommendationOutcome(recReply(1, { score: Number.NaN }), false).stroke).toBeNull();
  });
  it('says so when strokes were tried and none pots the ball (score −Infinity), with or without a landing spot', () => {
    // Core types.ts: −Infinity only when no stroke pots the ball. The app falls back to the basic stroke.
    expect(recommendationOutcome(recReply(1, { score: -Infinity, evaluated: 30, reachable: false }), false)).toEqual({
      stroke: null,
      toast: 'None of the strokes tried pots this ball — showing the basic stroke.',
    });
  });
});

describe('recommendedFromReply: what the app keeps of a recommendation (wave-1 Recommendation fields)', () => {
  it('keeps fragile, timedOut, nextQuality and risks; absent stays absent (risks undefined = not known, never "safe")', () => {
    const out = recommendationOutcome(recReply(1), false);
    expect(recommendedFromReply(recReply(1), out)).toEqual({ stroke, pending: false, reachable: true, evaluated: 40 });
    const risks = [{ pocketId: 'TR' as const, scratchIf: 'harder' as const }];
    const full = { ...recReply(1, { reachable: false, evaluated: 77 }), fragile: true, timedOut: true, nextQuality: 0.42, risks } as RecommendationReply;
    const r = recommendedFromReply(full, recommendationOutcome(full, false));
    expect(r).toEqual({ stroke, pending: false, reachable: false, evaluated: 77, fragile: true, timedOut: true, nextQuality: 0.42, risks });
    // An empty list is a real "no scratch seen", kept as such.
    expect(recommendedFromReply(recReply(1, { risks: [] }), out).risks).toEqual([]);
    expect('risks' in recommendedFromReply(recReply(1), out)).toBe(false);
    // Only what the reply says: false and 0 are kept, non-finite qualities dropped.
    const r2 = recommendedFromReply({ ...recReply(1), fragile: false, timedOut: false, nextQuality: 0 } as RecommendationReply, out);
    expect(r2).toMatchObject({ fragile: false, timedOut: false, nextQuality: 0 });
    expect('nextQuality' in recommendedFromReply({ ...recReply(1), nextQuality: Number.NaN } as RecommendationReply, out)).toBe(false);
  });
  it('the stroke is the outcome’s (null = the basic stroke when nothing pots it)', () => {
    const none = recReply(1, { score: -Infinity, evaluated: 30, reachable: false });
    expect(recommendedFromReply(none, recommendationOutcome(none, false)).stroke).toBeNull();
  });
});

describe('watchWorker', () => {
  it('reports load and message errors and stops the default error logging', () => {
    const w = new FakeWorker();
    const fail = vi.fn();
    watchWorker(w as unknown as Worker, fail);
    const ev = { preventDefault: vi.fn(), message: 'SyntaxError' };
    w.onerror!(ev as unknown as Event);
    expect(ev.preventDefault).toHaveBeenCalled();
    expect(fail).toHaveBeenCalledWith('SyntaxError');
    w.onmessageerror!({} as MessageEvent);
    expect(fail).toHaveBeenCalledTimes(2);
  });
});
