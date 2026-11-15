import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPlannerClient, recommendationOutcome, watchWorker, type PlannerKind, type RecommendationReply } from '../../../src/app/planner-client';
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
