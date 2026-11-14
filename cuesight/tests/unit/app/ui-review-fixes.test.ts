/**
 * Review fixes in package "ui" (wave 2): re-renders that do not rebuild unchanged markup (keyboard
 * focus and screen-reader position survive a store flush), the shot card's warning, tolerance and
 * throw texts, ball hit areas of at least 44 CSS px, and the spin pad's slider value. Vitest runs in
 * Node: the renderers write into small element stubs that count their innerHTML writes.
 */
import { describe, expect, it, vi } from 'vitest';
import { planShot } from '../../../src/core/shot/planner';
import { makeTable } from '../../../src/core/table';
import type { Ball, ShotSuggestion, TableLayout, Vec2 } from '../../../src/core/types';
import { DRILLS } from '../../../src/app/drills';
import { DEFAULT_SETTINGS, physicsFor } from '../../../src/app/settings';
import type { AppState } from '../../../src/app/store';
import { renderSuggestions } from '../../../src/app/ui/controls';
import { headlineWarning, renderShotCard, type CardContext } from '../../../src/app/ui/shot-card';
import { TableView } from '../../../src/app/render/table-view';
import { Overlay, type OverlayData } from '../../../src/app/render/overlay';
import * as spinPadModule from '../../../src/app/ui/spin-pad';

const table = makeTable('pool9');
const params = physicsFor(DEFAULT_SETTINGS);
const layoutOf = (drill: string): TableLayout => ({ table, balls: DRILLS.find((d) => d.id === drill)!.build(table), source: 'virtual', frozen: false });
const ctx = (over: Partial<CardContext> = {}): CardContext => ({
  targetLabel: '1',
  pocketName: 'far right corner',
  status: null,
  recommendedPending: false,
  showDetails: false,
  hint: 'Tap the ball you want to pocket.',
  ...over,
});

type Handler = (e: { target: unknown }) => void;
/** An element stub that counts innerHTML writes and records event listeners. */
function stubEl() {
  let html = '';
  const handlers: Record<string, Handler[]> = {};
  const writes = { n: 0 };
  const el = {
    dataset: {} as Record<string, string>,
    get innerHTML() {
      return html;
    },
    set innerHTML(v: string) {
      writes.n++;
      html = v;
    },
    closest: () => null,
    contains: () => false,
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener: (type: string, h: Handler) => (handlers[type] ??= []).push(h),
  };
  return { el: el as unknown as HTMLElement, writes, handlers };
}

describe('suggestions list: unchanged suggestions are not rebuilt (focus survives a store flush)', () => {
  const sugg = (targetId: string, pocketId: string): ShotSuggestion =>
    ({ targetId, pocketId, difficulty: 'easy', toleranceMm: 4.2, toleranceDeg: 0.4, score: 1 }) as unknown as ShotSuggestion;
  const state = (items: ShotSuggestion[]): AppState =>
    ({ mode: 'practice', practice: { balls: layoutOf('nine').balls }, suggestions: { pending: false, items } }) as unknown as AppState;
  const labelOf = (id: string) => id.replace(/^b/, '');
  const pocketName = (id: string) => `pocket ${id}`;

  it('rendering the same suggestions twice writes the markup once', () => {
    const { el, writes } = stubEl();
    const s = state([sugg('b1', 'TR'), sugg('b2', 'BL')]);
    renderSuggestions(el, s, labelOf, pocketName, () => {});
    expect(el.innerHTML).toContain('data-i="1"');
    renderSuggestions(el, s, labelOf, pocketName, () => {});
    // A new store flush with an equal list (same object, or a re-sent equal one): still one write.
    renderSuggestions(el, { ...s } as AppState, labelOf, pocketName, () => {});
    expect(writes.n).toBe(1);
    // New content is written.
    renderSuggestions(el, state([sugg('b3', 'TL')]), labelOf, pocketName, () => {});
    expect(writes.n).toBe(2);
    expect(el.innerHTML).toContain('data-i="0"');
    expect(el.innerHTML).not.toContain('data-i="1"');
  });

  it('one delegated click listener picks the clicked suggestion from the latest list', () => {
    const { el, handlers } = stubEl();
    const first = vi.fn();
    const latest = vi.fn();
    const items = [sugg('b1', 'TR'), sugg('b2', 'BL')];
    renderSuggestions(el, state(items), labelOf, pocketName, first);
    renderSuggestions(el, state(items), labelOf, pocketName, latest);
    expect(handlers.click).toHaveLength(1);
    const button = { dataset: { i: '1' } };
    handlers.click![0]!({ target: { closest: (sel: string) => (sel.includes('data-i') ? button : null) } });
    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledWith(items[1]);
    // A click outside a suggestion button does nothing.
    handlers.click![0]!({ target: { closest: () => null } });
    expect(latest).toHaveBeenCalledTimes(1);
  });
});

describe('shot card: an unchanged plan is not rebuilt on every store flush', () => {
  it('the same plan and an equal context write the markup once', () => {
    const plan = planShot(layoutOf('cut30'), { targetId: 'b1', pocketId: 'TR' }, params);
    const { el, writes } = stubEl();
    renderShotCard(el, plan, ctx());
    renderShotCard(el, plan, ctx());
    expect(writes.n).toBe(1);
    // A changed context (e.g. the pace line) or a new plan is drawn.
    renderShotCard(el, plan, ctx({ speedRef: 'pocket speed + 2 diamonds' }));
    expect(writes.n).toBe(2);
    expect(el.innerHTML).toContain('pocket speed + 2 diamonds');
    renderShotCard(el, planShot(layoutOf('cut30'), { targetId: 'b1', pocketId: 'TR', stroke: { power: 6, side: 0, vert: 0 } }, params), ctx({ speedRef: 'pocket speed + 2 diamonds' }));
    expect(writes.n).toBe(3);
    renderShotCard(el, null, ctx());
    renderShotCard(el, null, ctx());
    expect(writes.n).toBe(4);
  });
});

describe('shot card texts', () => {
  it('a headline warning on a makeable card is shown once, not again as a chip', () => {
    const plan = planShot(layoutOf('cut30'), { targetId: 'b1', pocketId: 'TR', stroke: { power: 2, side: 0, vert: 0 } }, params);
    expect(plan.makeable).toBe(true);
    const head = headlineWarning(plan)!;
    expect(head.code).toBe('too-soft');
    const { el } = stubEl();
    renderShotCard(el, plan, ctx());
    expect(el.innerHTML).toContain('class="head-warn warn-too-soft"');
    expect(el.innerHTML.split(`<span>${head.message}</span>`).length - 1).toBe(1);
  });

  it('a not-makeable plan never shows a negative tolerance ("±-2.1 mm")', () => {
    const plan = planShot(layoutOf('blocked'), { targetId: 'b5', pocketId: 'BM' }, params);
    expect(plan.makeable).toBe(false);
    expect(plan.toleranceMm).toBeLessThan(0); // the planner's value (core) is still signed
    const { el } = stubEl();
    renderShotCard(el, plan, ctx({ showDetails: true }));
    expect(el.innerHTML).toContain('Contact tolerance');
    expect(el.innerHTML).not.toMatch(/±-/);
    expect(el.innerHTML).toMatch(/<dt>Contact tolerance<\/dt><dd>—<\/dd>/);
    expect(el.innerHTML).toMatch(/<dt>Aim tolerance<\/dt><dd>—<\/dd>/);
  });

  it('the details give the tip offset in millimetres next to the tip words', () => {
    const plan = planShot(layoutOf('cut30'), { targetId: 'b1', pocketId: 'TR', stroke: { power: 5, side: 0.25, vert: -0.4 } }, params);
    const { el } = stubEl();
    renderShotCard(el, plan, ctx({ showDetails: true, ballRadius: table.ballRadius, cbDistance: 0.8 }));
    const mm = (f: number) => Math.round(Math.abs(f) * table.ballRadius * 1000);
    expect(el.innerHTML).toContain(`<dt>Tip offset</dt><dd>${mm(-0.4)} mm below centre, ${mm(0.25)} mm right</dd>`);
  });

  /** The contact cut actually played through a ghost ball position. */
  const playedCut = (cue: Vec2, ob: Vec2, ghost: Vec2) => {
    const a = { x: ghost.x - cue.x, y: ghost.y - cue.y };
    const b = { x: ob.x - ghost.x, y: ob.y - ghost.y };
    return Math.acos((a.x * b.x + a.y * b.y) / (Math.hypot(a.x, a.y) * Math.hypot(b.x, b.y)));
  };
  it('the throw correction names the way the ghost ball really moved (thicker / thinner / left / right)', () => {
    const cases: [string, number, number][] = [
      ['cut30', -0.25, 3],
      ['cut30', -0.3, 3],
      ['cut30', 0.25, 3],
      ['cut30', 0, 5],
      ['straight', 0.25, 3],
      ['straight', -0.25, 3],
    ];
    const words: Record<string, string> = {};
    for (const [drill, side, power] of cases) {
      const lay = layoutOf(drill);
      const plan = planShot(lay, { targetId: 'b1', pocketId: 'TR', stroke: { power, side, vert: 0 } }, params);
      const { el } = stubEl();
      renderShotCard(el, plan, ctx());
      const text = `${/class="corr">(.*?)<\/p>/s.exec(el.innerHTML)?.[1] ?? ''} ${plan.tip}`;
      const cue = lay.balls.find((b) => b.kind === 'cue')!.pos;
      const ob = lay.balls.find((b) => b.id === 'b1')!.pos;
      let want: string;
      if (plan.cutAngleDeg < 1) {
        const aim = plan.aimDir;
        const d = { x: plan.ghost.x - plan.ghostUncorrected.x, y: plan.ghost.y - plan.ghostUncorrected.y };
        want = aim.x * d.y - aim.y * d.x > 0 ? 'left' : 'right';
        expect(text).toContain(`mm ${want} of full ball`);
      } else {
        want = playedCut(cue, ob, plan.ghost) < playedCut(cue, ob, plan.ghostUncorrected) ? 'thicker' : 'thinner';
        expect(text).toMatch(new RegExp(`aim [\\d.]+ mm ${want}`));
        expect(text).not.toMatch(new RegExp(`aim [\\d.]+ mm ${want === 'thicker' ? 'thinner' : 'thicker'}`));
      }
      words[`${drill} ${side}`] = want;
    }
    // Outside english on the 30° cut reverses the throw; no english keeps the classic "thinner".
    expect(words['cut30 -0.25']).toBe('thicker');
    expect(words['cut30 0']).toBe('thinner');
    expect(words['straight 0.25']).not.toBe(words['straight -0.25']);
  });
});

describe('ball hit areas are at least 44 CSS px across (radius ≥ 22 px)', () => {
  it('mini-map (151 × 82 px): a tap 21 px from a ball centre picks it', () => {
    const canvas = { getContext: () => ({ setTransform() {} }), getBoundingClientRect: () => ({ width: 151, height: 82 }), width: 0, height: 0 };
    const view = new TableView(canvas as unknown as HTMLCanvasElement);
    (view as unknown as { layout(t: typeof table): void }).layout(table);
    const ball: Ball = { id: 'b1', kind: 'object', pos: { x: 0.3, y: 0.1 }, label: '1' } as Ball;
    const q = view.toCanvas(ball.pos);
    expect(view.ballAt({ x: q.x + 21, y: q.y }, [ball])?.id).toBe('b1');
    expect(view.ballAt({ x: q.x, y: q.y - 21 }, [ball])?.id).toBe('b1');
    expect(view.ballAt({ x: q.x + 30, y: q.y }, [ball])).toBeNull();
    // Two balls in reach: the nearer one wins.
    const other: Ball = { ...ball, id: 'b2', pos: { x: ball.pos.x + 20 / view.scale, y: ball.pos.y } };
    expect(view.ballAt({ x: q.x + 14, y: q.y }, [ball, other])?.id).toBe('b2');
  });

  it('camera overlay: a tap 21 px from a small, far ball picks it', () => {
    // Table metres → frame px at 150 px/m (a whole 9-ft table across a phone screen: R ≈ 4 px).
    const k = 150;
    const H = [k, 0, 320, 0, -k, 240, 0, 0, 1];
    const ball: Ball = { id: 'b1', kind: 'object', pos: { x: 0.4, y: 0.2 }, label: '1' } as Ball;
    const data: OverlayData = {
      table,
      calibration: { corners: [], H0: H, HR: H, focal: 500, focalSource: 'assumed', source: 'auto', camera: { x: 0, y: 0, z: 2 }, width: 640, height: 480 },
      balls: [ball],
      plan: null,
      targetId: null,
      pocketId: null,
      calibTaps: [],
      showPlan: true,
    };
    const map = { toScreen: (p: Vec2) => p, toFrame: (p: Vec2) => p };
    const c = { x: 320 + k * 0.4, y: 240 - k * 0.2 };
    expect(Overlay.hitTest({ x: c.x + 21, y: c.y }, data, map).ball?.id).toBe('b1');
    expect(Overlay.hitTest({ x: c.x, y: c.y + 21 }, data, map).ball?.id).toBe('b1');
    expect(Overlay.hitTest({ x: c.x + 30, y: c.y }, data, map).ball).toBeUndefined();
  });
});

describe('spin pad slider value (ARIA 1.2: role=slider needs aria-valuenow)', () => {
  it('exposes the tip offset as a number 0…50 (% of the ball radius, 50 = miscue limit)', () => {
    const aria = (spinPadModule as unknown as { padValue?: (side: number, vert: number) => { now: number; text: string } }).padValue;
    expect(typeof aria).toBe('function');
    expect(aria!(0, 0)).toEqual({ now: 0, text: 'centre ball' });
    expect(aria!(0.25, 0).now).toBe(25);
    expect(aria!(0.3, -0.4).now).toBe(50);
    expect(aria!(0.3, -0.4).text).toContain('below centre');
  });

  it('the pad element carries aria-valuemin/max/now and updates them when the stroke changes', () => {
    const attrs = new Map<string, string>();
    const node = () => {
      const a = new Map<string, string>();
      return { style: {}, setAttribute: (k: string, v: string) => a.set(k, v), getAttribute: (k: string) => a.get(k) ?? null };
    };
    const circles: Record<string, ReturnType<typeof node>> = { '.tip': node(), '.tip-shadow': node(), '.rec': node() };
    const svg = {
      setAttribute: (k: string, v: string) => attrs.set(k, v),
      getAttribute: (k: string) => attrs.get(k) ?? null,
      set innerHTML(_: string) {},
      querySelector: (s: string) => circles[s],
      addEventListener: () => {},
    };
    const g = globalThis as unknown as { document?: unknown };
    const had = 'document' in g;
    g.document = { createElement: () => ({ className: '', appendChild: () => {} }), createElementNS: () => svg };
    try {
      const pad = spinPadModule.createSpinPad(() => {});
      expect(attrs.get('role')).toBe('slider');
      expect(attrs.get('aria-valuemin')).toBe('0');
      expect(attrs.get('aria-valuemax')).toBe('50');
      expect(attrs.get('aria-valuenow')).toBe('0');
      pad.set(0.25, 0);
      expect(attrs.get('aria-valuenow')).toBe('25');
      expect(attrs.get('aria-valuetext')).toContain('right');
    } finally {
      if (!had) delete g.document;
    }
  });
});
