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
    // Wave 1 clamps the core's tolerance at 0 past a 90° cut (this one is 143°); the card must still
    // print no margin for it, nor for a signed value (an older planner's ±-2.1 mm).
    expect(plan.cutAngleDeg).toBeGreaterThan(90);
    expect(plan.toleranceMm).toBe(0);
    for (const p of [plan, { ...plan, toleranceMm: -2.1, toleranceDeg: -0.15 }]) {
      const { el } = stubEl();
      renderShotCard(el, p, ctx({ showDetails: true }));
      expect(el.innerHTML).toContain('Contact tolerance');
      expect(el.innerHTML).not.toMatch(/±-|±0\.0/);
      expect(el.innerHTML).toMatch(/<dt>Contact tolerance<\/dt><dd>—<\/dd>/);
      expect(el.innerHTML).toMatch(/<dt>Aim tolerance<\/dt><dd>—<\/dd>/);
    }
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
    const corrOf = (html: string) => /class="corr">(.*?)<\/p>/s.exec(html)?.[1] ?? '';
    for (const [drill, side, power] of cases) {
      const lay = layoutOf(drill);
      const plan = planShot(lay, { targetId: 'b1', pocketId: 'TR', stroke: { power, side, vert: 0 } }, params);
      const { el } = stubEl();
      renderShotCard(el, plan, ctx());
      const corr = corrOf(el.innerHTML);
      const text = `${corr} ${plan.tip}`;
      const cue = lay.balls.find((b) => b.kind === 'cue')!.pos;
      const ob = lay.balls.find((b) => b.id === 'b1')!.pos;
      let want: string;
      // Wave-1 wording (coach.ts throwSentence): "the ghost ball is shifted 1.2 mm thicker" /
      // "… shifted 1.6 mm to the left of full ball" (the ghost ball shown already includes it).
      if (plan.cutAngleDeg < 1) {
        const aim = plan.aimDir;
        const d = { x: plan.ghost.x - plan.ghostUncorrected.x, y: plan.ghost.y - plan.ghostUncorrected.y };
        want = aim.x * d.y - aim.y * d.x > 0 ? 'left' : 'right';
        expect(text).toMatch(new RegExp(`shifted [\\d.]+ mm to the ${want} of full ball`));
      } else {
        want = playedCut(cue, ob, plan.ghost) < playedCut(cue, ob, plan.ghostUncorrected) ? 'thicker' : 'thinner';
        expect(text).toMatch(new RegExp(`shifted [\\d.]+ mm ${want}`));
        expect(text).not.toMatch(new RegExp(`shifted [\\d.]+ mm ${want === 'thicker' ? 'thinner' : 'thicker'}`));
      }
      // The card's own correction (shown when the tip leaves the throw out) names the stroke's english
      // the way the tip does: outside english for a thicker shift, no "side-spin" on a centre-ball hit.
      if (/shifted/.test(corr)) {
        expect(corr).not.toMatch(/already moved/);
        if (want === 'thicker' && side !== 0) expect(corr).toContain('Outside english throws the object ball thin');
        if (side === 0) expect(corr).not.toMatch(/[Ss]ide-spin/);
      }
      words[`${drill} ${side}`] = want;
    }
    // Outside english on the 30° cut reverses the throw; no english keeps the classic "thinner".
    expect(words['cut30 -0.25']).toBe('thicker');
    expect(words['cut30 0']).toBe('thinner');
    expect(words['straight 0.25']).not.toBe(words['straight -0.25']);
    // Not vacuous: the 30° cut with a touch of outside english (throw under the tip's 1° threshold)
    // gets its correction from the card.
    const soft = planShot(layoutOf('cut30'), { targetId: 'b1', pocketId: 'TR', stroke: { power: 3, side: -0.25, vert: 0 } }, params);
    const { el } = stubEl();
    renderShotCard(el, soft, ctx());
    expect(corrOf(el.innerHTML)).toMatch(/Outside english throws the object ball thin here, so the ghost ball is shifted [\d.]+ mm thicker\./);
    // A centre-ball hit thrown left or right (a near-straight cut's own throw) is not called side-spin throw.
    const straight = planShot(layoutOf('straight'), { targetId: 'b1', pocketId: 'TR', stroke: { power: 3, side: 0, vert: 0 } }, params);
    const centre = { ...straight, throwDeg: 0.4, throwShiftMm: 0.4, throwAim: 'left' as const, throwShiftDir: 'left' as const, tip: 'Straight-in with follow.' };
    const c = stubEl();
    renderShotCard(c.el, centre, ctx());
    expect(corrOf(c.el.innerHTML)).toContain('Throw: the ghost ball is shifted 0.4 mm to the left of full ball.');
  });
});

describe('ball hit areas are at least 44 CSS px across (radius ≥ 22 px)', () => {
  it('mini-map (151 × 82 px): a tap 21 px from a ball centre picks it', () => {
    const canvas = { getContext: () => ({ setTransform() {} }), getBoundingClientRect: () => ({ width: 151, height: 82 }), width: 0, height: 0 };
    const view = new TableView(canvas as unknown as HTMLCanvasElement);
    (view as unknown as { layout(t: typeof table): void }).layout(table);
    // Clear of every pocket mouth (the nearest, TR and TM, are > 30 px from the taps below): next to
    // a pocket the floor yields to the pocket (see 'the 22 px ball floor does not swallow pocket taps').
    const ball: Ball = { id: 'b1', kind: 'object', pos: { x: 0.6, y: 0 }, label: '1' } as Ball;
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

describe('the 22 px ball floor does not swallow pocket taps', () => {
  const tr = table.pockets.find((p) => p.id === 'TR')!;
  const inward = (cm: number): Vec2 => ({ x: tr.mouthCenter.x + tr.inward.x * (cm / 100), y: tr.mouthCenter.y + tr.inward.y * (cm / 100) });
  const overlayAt = (k: number, balls: Ball[], targetId: string | null = 'b1'): OverlayData => {
    const H = [k, 0, 320, 0, -k, 240, 0, 0, 1];
    return {
      table,
      calibration: { corners: [], H0: H, HR: H, focal: 500, focalSource: 'assumed', source: 'auto', camera: { x: 0, y: 0, z: 2 }, width: 640, height: 480 },
      balls,
      plan: null,
      targetId,
      pocketId: null,
      calibTaps: [],
      showPlan: true,
    };
  };
  const map = { toScreen: (p: Vec2) => p, toFrame: (p: Vec2) => p };
  const screen = (k: number, p: Vec2): Vec2 => ({ x: 320 + k * p.x, y: 240 - k * p.y });
  /**
   * A tap just outside the ball's natural pick radius (so only the 22 px floor reaches it) that is
   * nearer the ball than the pocket: on the circle of radius natural + 1.5 px around the ball, at the
   * angle where the pocket is a little farther than the ball.
   */
  const besideBall = (c: Vec2, m: Vec2, natural: number): Vec2 => {
    const r = natural + 1.5;
    const D = Math.hypot(m.x - c.x, m.y - c.y);
    const th = Math.acos(D / (2 * r) - 0.15);
    const u = Math.atan2(m.y - c.y, m.x - c.x) + th;
    const t = { x: c.x + r * Math.cos(u), y: c.y + r * Math.sin(u) };
    expect(Math.hypot(t.x - c.x, t.y - c.y)).toBeGreaterThan(natural);
    expect(Math.hypot(t.x - c.x, t.y - c.y)).toBeLessThan(22);
    expect(Math.hypot(t.x - m.x, t.y - m.y)).toBeGreaterThan(Math.hypot(t.x - c.x, t.y - c.y));
    return t;
  };

  it('camera overlay: a tap on a pocket picks the pocket, not a ball that is only in reach through the floor', () => {
    for (const [k, cm] of [
      [130, 12],
      [110, 16],
      [130, 16],
      [150, 12],
    ] as const) {
      const ball: Ball = { id: 'b1', kind: 'object', pos: inward(cm), label: '1' } as Ball;
      const hit = Overlay.hitTest(screen(k, tr.mouthCenter), overlayAt(k, [ball]), map);
      expect(hit.ball?.id, `${k} px/m, ball ${cm} cm from TR`).toBeUndefined();
      expect(hit.pocket, `${k} px/m, ball ${cm} cm from TR`).toBe('TR');
    }
  });

  it('camera overlay: the floor still picks a lone small ball, and a tap nearer the ball than the pocket picks the ball', () => {
    const k = 130;
    const ball: Ball = { id: 'b1', kind: 'object', pos: inward(12), label: '1' } as Ball;
    const c = screen(k, ball.pos);
    const m = screen(k, tr.mouthCenter);
    const natural = Math.max(14, 2.2 * table.ballRadius * k);
    const t = besideBall(c, m, natural);
    expect(Math.hypot(t.x - m.x, t.y - m.y)).toBeLessThan(26); // the pocket is in reach too
    expect(Overlay.hitTest(t, overlayAt(k, [ball]), map).ball?.id).toBe('b1');
    // Away from every pocket the floor is unchanged.
    const mid: Ball = { id: 'b2', kind: 'object', pos: { x: 0.2, y: 0.1 }, label: '2' } as Ball;
    const cm = screen(k, mid.pos);
    expect(Overlay.hitTest({ x: cm.x + 21, y: cm.y }, overlayAt(k, [ball, mid]), map).ball?.id).toBe('b2');
    // A ball inside its natural radius wins even over a nearer pocket (unchanged behaviour).
    const close: Ball = { id: 'b3', kind: 'object', pos: inward(5), label: '3' } as Ball;
    expect(Overlay.hitTest(m, overlayAt(k, [close]), map).ball?.id).toBe('b3');
  });

  const miniMap = () => {
    const canvas = { getContext: () => ({ setTransform() {} }), getBoundingClientRect: () => ({ width: 151, height: 82 }), width: 0, height: 0 };
    const view = new TableView(canvas as unknown as HTMLCanvasElement);
    (view as unknown as { layout(t: typeof table): void }).layout(table);
    return view;
  };

  it('mini-map (151 × 82 px): a tap on the TR mouth with a ball 35 cm inward picks the pocket', () => {
    const view = miniMap();
    for (const cm of [32, 35, 40]) {
      const ball: Ball = { id: 'b1', kind: 'object', pos: inward(cm), label: '1' } as Ball;
      const tap = view.toCanvas(tr.mouthCenter);
      // ballAt yields to the pocket so the caller (main.ts) falls through to pocketAt.
      expect(view.ballAt(tap, [ball]), `ball ${cm} cm from TR`).toBeNull();
      expect(view.pocketAt(tap)).toBe('TR');
    }
    // A tap 21 px above a ball at (0.3, 0.1) m lands 16 px from the top side pocket's mouth: the pocket.
    const mid: Ball = { id: 'b2', kind: 'object', pos: { x: 0.3, y: 0.1 }, label: '2' } as Ball;
    const q = view.toCanvas(mid.pos);
    expect(view.ballAt({ x: q.x, y: q.y - 21 }, [mid])).toBeNull();
    expect(view.pocketAt({ x: q.x, y: q.y - 21 })).toBe('TM');
    expect(view.ballAt({ x: q.x + 21, y: q.y }, [mid])?.id).toBe('b2');
  });

  it('mini-map: a tap nearer the ball than the pocket still picks the ball through the floor', () => {
    const view = miniMap();
    const ball: Ball = { id: 'b1', kind: 'object', pos: inward(35), label: '1' } as Ball;
    const c = view.toCanvas(ball.pos);
    const m = view.toCanvas(tr.mouthCenter);
    const natural = (table.ballRadius * 1.8 + 12 / view.scale) * view.scale;
    const t = besideBall(c, m, natural);
    expect(view.pocketAt(t)).toBe('TR'); // the pocket is in reach too
    expect(view.ballAt(t, [ball])?.id).toBe('b1');
    // A ball within its natural radius of the tap wins even on a pocket (unchanged behaviour).
    const close: Ball = { id: 'b2', kind: 'object', pos: inward(10), label: '2' } as Ball;
    expect(view.ballAt(m, [close])?.id).toBe('b2');
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
