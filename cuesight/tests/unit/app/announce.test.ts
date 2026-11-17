/**
 * #plan-live (judge-coach round 2, item 3): screen-reader users hear the stroke the card shows — the
 * recommended one, not the provisional default — once, after a slider settles.
 */
import { describe, expect, it } from 'vitest';
import { DRILLS } from '../../../src/app/drills';
import { createAnnouncer, planSentence } from '../../../src/app/announce';
import { DEFAULT_SETTINGS, physicsFor } from '../../../src/app/settings';
import { planShot } from '../../../src/core/shot/planner';
import { makeTable } from '../../../src/core/table';
import type { TableLayout } from '../../../src/core/types';

const table = makeTable('pool9');
const params = physicsFor(DEFAULT_SETTINGS);
const lay = (d: string): TableLayout => ({ table, balls: DRILLS.find((x) => x.id === d)!.build(table), source: 'virtual', frozen: false });
const names = { TR: 'far right corner' };
const label = (id: string) => id.replace('b', '');

function fakeTimers() {
  let q: { f: () => void; id: number } | null = null;
  let n = 0;
  return {
    set: (f: () => void) => ((q = { f, id: ++n }), n),
    clear: (id: number) => {
      if (q?.id === id) q = null;
    },
    flush: () => {
      const x = q;
      q = null;
      x?.f();
    },
    pending: () => q !== null,
  };
}

describe('plan announcements', () => {
  it('waits for the recommended stroke, then speaks it (power and tip as the card shows them)', () => {
    const el = { textContent: '' as string | null };
    const t = fakeTimers();
    const a = createAnnouncer(el, t);
    const provisional = planShot(lay('cut30'), { targetId: 'b1', pocketId: 'TR' }, params);
    expect(provisional.strokeSource).toBe('default');
    a.update(provisional, true, names, label);
    expect(t.pending()).toBe(false);
    const rec = planShot(lay('cut30'), { targetId: 'b1', pocketId: 'TR' }, params, { recommended: { power: 6, side: 0, vert: -0.125 } });
    a.update(rec, false, names, label);
    t.flush();
    expect(el.textContent).toContain('Power 6');
    expect(el.textContent).toContain('½ tip below centre');
    expect(el.textContent).toContain('far right corner');
  });
  it('a slider drag speaks once, at the value it settles on', () => {
    const el = { textContent: '' as string | null };
    const t = fakeTimers();
    const a = createAnnouncer(el, t);
    for (const p of [3, 4, 5, 6, 7]) a.update(planShot(lay('cut30'), { targetId: 'b1', pocketId: 'TR', stroke: { power: p, side: 0, vert: 0 } }, params), false, names, label);
    t.flush();
    expect(el.textContent).toContain('Power 7');
    expect(t.pending()).toBe(false);
    // Same stroke again: nothing new to say.
    a.update(planShot(lay('cut30'), { targetId: 'b1', pocketId: 'TR', stroke: { power: 7, side: 0, vert: 0 } }, params), false, names, label);
    expect(t.pending()).toBe(false);
  });
  it('a bank is spoken as one', () => {
    // The cue ball up-table of the ball: the top-right corner only goes off the bottom cushion.
    const layout: TableLayout = { table, balls: [{ id: 'cue', kind: 'cue', pos: { x: 0.65, y: 0.33 } }, { id: 'b1', kind: 'object', pos: { x: 0.63, y: -0.27 } }], source: 'virtual', frozen: false };
    const bank = planShot(layout, { targetId: 'b1', pocketId: 'TR', bank: 'bottom' }, params);
    expect(bank.makeable).toBe(true);
    expect(planSentence(bank, names, label)).toMatch(/^Ball 1 to the far right corner, off a cushion: cut \d+ degrees/);
  });

  it('a shot that cannot happen is not given a stroke', () => {
    const blocked = planShot(lay('blocked'), { targetId: 'b1', pocketId: 'TR' }, params);
    const s = planSentence(blocked, names, label);
    expect(s).toContain('not makeable');
    expect(s).not.toMatch(/Power \d/);
    const short = planShot(lay('cut30'), { targetId: 'b1', pocketId: 'TR', stroke: { power: 1, side: 0, vert: -0.375 } }, params);
    expect(planSentence(short, names, label)).toContain('stops before it reaches');
  });
});
