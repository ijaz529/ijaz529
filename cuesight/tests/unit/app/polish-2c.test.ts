/**
 * Final-walkthrough polish (fix2c), the app's side:
 *  1. the difficulty chip of a frozen plan gives the stroke-angle margin (degrees, there is no contact
 *     point to aim at), and a plan with no margin says so ("very hard · ±0°") instead of "easy · ±0.5 mm" — on the card
 *     and in the suggestions list;
 *  3. Snap "Add ball" puts the ball on the free spot nearest the middle of the table (the toast says
 *     where), with no number another ball already carries (the neutral 'ball');
 *  5. one sentence for a speed-sensitive recommendation, in the toast and in the card's note;
 *  6. no "Cue stops" label next to "Not makeable" (2D table, camera overlay), the stroke name in the
 *     one-line spin tile in full, and the 3D label kept off the balls (a ball's disc, not only its centre).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADD_BALL_TOASTS, addBallTo, freeSpotNearCentre } from '../../../src/app/add-ball';
import { DRILLS } from '../../../src/app/drills';
import { recommendationOutcome, type RecommendationReply } from '../../../src/app/planner-client';
import { Overlay, type OverlayData } from '../../../src/app/render/overlay';
import { TableView } from '../../../src/app/render/table-view';
import { DEFAULT_SETTINGS, physicsFor } from '../../../src/app/settings';
import type { AppState } from '../../../src/app/store';
import { tagText } from '../../../src/app/ui/ball-tags';
import { renderSuggestions } from '../../../src/app/ui/controls';
import { BALL_AVOID_WEIGHT } from '../../../src/app/render3d';
import { placeLabel } from '../../../src/app/ui/label-place';
import { blockedPoint } from '../../../src/app/ui/scene-labels';
import { REC_NOTES, marginText, renderShotCard, type CardContext } from '../../../src/app/ui/shot-card';
import { planShot } from '../../../src/core/shot/planner';
import { suggestShots } from '../../../src/core/shot/suggest';
import { makeTable } from '../../../src/core/table';
import type { Ball, PocketId, ShotPlan, TableLayout, TableSpec, Vec2 } from '../../../src/core/types';
import { recordingCanvas, stubDocument } from './helpers/rec-canvas';

const table = makeTable('pool9');
const R = table.ballRadius;
const params = physicsFor(DEFAULT_SETTINGS);
const layoutOf = (balls: Ball[], t: TableSpec = table): TableLayout => ({ table: t, balls, source: 'virtual', frozen: false });
const drill = (id: string): TableLayout => layoutOf(DRILLS.find((d) => d.id === id)!.build(table));
const ctx = (over: Partial<CardContext> = {}): CardContext => ({ targetLabel: '1', pocketName: 'bottom-left corner', status: null, recommendedPending: false, showDetails: false, hint: '', ...over });
function stubEl() {
  let html = '';
  const el = {
    dataset: {} as Record<string, string>,
    get innerHTML() {
      return html;
    },
    set innerHTML(v: string) {
      html = v;
    },
    closest: () => null,
    contains: () => false,
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener: () => {},
  };
  return el as unknown as HTMLElement;
}
const cardHtml = (plan: ShotPlan, over: Partial<CardContext> = {}) => {
  const el = stubEl();
  renderShotCard(el, plan, ctx(over));
  return el.innerHTML;
};
/** The difficulty chip: its class, its text and its title. */
const chip = (html: string) => {
  const m = /<div class="chip diff diff-([a-z-]+)" title="([^"]*)" data-testid="difficulty">([^<]*)<\/div>/.exec(html);
  return m ? { cls: m[1]!, title: m[2]!, text: m[3]! } : null;
};

/** Cue ball touching the object ball, the line of centres `offDeg` off the line to the pocket mouth. */
function frozenLayout(ob: Vec2, pocket: PocketId, offDeg: number): TableLayout {
  const m = table.pockets.find((p) => p.id === pocket)!.mouthCenter;
  const a = Math.atan2(m.y - ob.y, m.x - ob.x) + (offDeg * Math.PI) / 180;
  const d = 2 * R + 0.0003;
  return layoutOf([
    { id: 'cue', kind: 'cue', pos: { x: ob.x - d * Math.cos(a), y: ob.y - d * Math.sin(a) }, label: 'cue' },
    { id: 'b1', kind: 'object', pos: ob, label: '1' },
  ]);
}
const OB = { x: 0.55, y: 0.18 };

describe('1. the difficulty chip: stroke-angle margin for a frozen plan, none (±0) for a plan that misses as played', () => {
  it('a frozen plan that pots: degrees of stroke angle, never millimetres', () => {
    const p = planShot(frozenLayout(OB, 'BL', -2), { targetId: 'b1', pocketId: 'BL' }, params);
    expect(p.obPocketed).toBe(true);
    const c = chip(cardHtml(p))!;
    expect(c.text).toBe(`${p.difficulty} · ±${p.toleranceDeg.toFixed(1)}°`);
    expect(c.text).not.toMatch(/mm/);
    expect(c.title).toMatch(/^Stroke within ±[\d.]+° of the angle shown/);
    // The details say the same: no contact tolerance, the stroke angle's.
    const d = cardHtml(p, { showDetails: true });
    expect(d).toMatch(/<dt>Contact tolerance<\/dt><dd>—<\/dd>/);
    expect(d).toContain(`<dt>Stroke-angle tolerance</dt><dd>±${p.toleranceDeg.toFixed(1)}°</dd>`);
  });

  it('frozen, 4° off at power 6 (no stroke angle throws it in): "very hard · ±0°", not a green "easy · ±0.5 mm"', () => {
    const p = planShot(frozenLayout(OB, 'BL', -4), { targetId: 'b1', pocketId: 'BL', stroke: { power: 6, side: 0, vert: 0 } }, params);
    expect(p.warnings.some((w) => w.code === 'throw-uncompensable')).toBe(true);
    const c = chip(cardHtml(p))!;
    expect(c).toMatchObject({ cls: 'very-hard', text: 'very hard · ±0°' });
    expect(c.title).toMatch(/does not pot it/);
  });

  it('frozen, no stroke angle throws it inside the window yet the full simulation drops it: no margin, and the title says why', () => {
    const p = planShot(frozenLayout(OB, 'BL', 2), { targetId: 'b1', pocketId: 'BL', stroke: { power: 4, side: 0, vert: 0.4 } }, params);
    expect(p.obPocketed).toBe(true);
    expect(p.warnings.find((w) => w.code === 'frozen')!.message).toMatch(/the closest it gets/);
    const c = chip(cardHtml(p))!;
    expect(c).toMatchObject({ cls: 'very-hard', text: 'very hard · ±0°' });
    expect(c.title).toMatch(/no stroke sends it clearly inside the pocket/);
  });

  it('frozen too soft with no power that works: "very hard · ±0°"', () => {
    const p = planShot(frozenLayout(OB, 'BL', -4), { targetId: 'b1', pocketId: 'BL', stroke: { power: 1, side: 0, vert: 0.4 } }, params);
    expect(p.noWorkingPower).toBeDefined();
    expect(chip(cardHtml(p))).toMatchObject({ cls: 'very-hard', text: 'very hard · ±0°' });
  });

  it('a plain cut keeps its contact millimetres', () => {
    const p = planShot(drill('cut30'), { targetId: 'b1', pocketId: 'TR' }, params);
    const c = chip(cardHtml(p))!;
    expect(c.text).toBe(`${p.difficulty} · ${marginText(p)}`);
    expect(c.text).toMatch(/^(easy|medium|hard|very hard) · ±[\d.]+ mm$/);
    expect(c.title).toMatch(/^Hit the contact point within/);
  });

  it('the suggestions list shows a frozen suggestion in the card\'s unit (degrees)', () => {
    const lay = frozenLayout(OB, 'BL', -2);
    const items = suggestShots(lay, params, 3);
    const s = items.find((x) => x.targetId === 'b1' && x.pocketId === 'BL')!;
    expect(s.frozen).toBe(true);
    const el = stubEl();
    const state = { table, mode: 'practice', practice: lay, suggestions: { pending: false, items: [s] } } as unknown as AppState;
    renderSuggestions(el, state, () => '1', () => 'bottom-left corner', () => {});
    expect(el.innerHTML).toContain(`${s.difficulty} · ±${s.toleranceDeg.toFixed(1)}°</span>`);
    expect(el.innerHTML).not.toMatch(/±[\d.]+ mm/);
  });
});

describe('3. Snap "Add ball": the free spot nearest the middle, no borrowed number', () => {
  const ball = (id: string, pos: Vec2, label = id, kind: Ball['kind'] = 'object'): Ball => ({ id, kind, pos, label });
  const clear = (p: Vec2, balls: Ball[], t: TableSpec = table) => {
    const r = t.ballRadius;
    expect(Math.abs(p.x)).toBeLessThanOrEqual(t.length / 2 - r + 1e-9);
    expect(Math.abs(p.y)).toBeLessThanOrEqual(t.width / 2 - r + 1e-9);
    for (const b of balls) expect(Math.hypot(b.pos.x - p.x, b.pos.y - p.y), b.id).toBeGreaterThanOrEqual(3 * r - 1e-9);
  };

  it('an empty middle: exactly the centre, and the toast says "in the middle of the table"', () => {
    const balls = [ball('cue', { x: -0.7, y: -0.1 }, 'cue', 'cue'), ball('v1', { x: 0.3, y: 0.15 }, '8')];
    const a = addBallTo(table, balls, { neutral: true })!;
    expect(a.ball.pos).toEqual({ x: 0, y: 0 });
    expect(a.atCentre).toBe(true);
    expect(ADD_BALL_TOASTS.centre).toBe('Ball added in the middle of the table. Drag it to where it is.');
  });

  it('a ball on the centre: the nearest free spot (no overlap, on the cloth), and the toast says "near the middle"', () => {
    const balls = [ball('cue', { x: -0.7, y: -0.1 }, 'cue', 'cue'), ball('v1', { x: 0.01, y: -0.005 }, '8'), ball('v2', { x: -0.05, y: 0.04 }, 'red')];
    const a = addBallTo(table, balls, { neutral: true })!;
    clear(a.ball.pos, balls);
    expect(a.atCentre).toBe(false);
    expect(ADD_BALL_TOASTS.near).toBe('Ball added near the middle of the table. Drag it to where it is.');
    // Nearest: no free spot (on a fine grid) is closer to the centre.
    const d = Math.hypot(a.ball.pos.x, a.ball.pos.y);
    const step = R / 8;
    for (let x = -0.2; x <= 0.2; x += step)
      for (let y = -0.2; y <= 0.2; y += step)
        if (Math.hypot(x, y) < d - R / 2 + 1e-9) expect(balls.some((b) => Math.hypot(b.pos.x - x, b.pos.y - y) < 3 * R), `${x},${y}`).toBe(true);
    // Deterministic (never random): the same layout, the same spot.
    expect(addBallTo(table, balls, { neutral: true })!.ball.pos).toEqual(a.ball.pos);
  });

  it('Snap: the neutral label (no number a detected ball uses, no colour), a fresh id', () => {
    // The verifier's layout: the free id number 8 gave a second "8" next to the detected black.
    const balls = [ball('cue', { x: -0.7, y: -0.1 }, 'cue', 'cue'), ...['1', '2', '3', '4', '5', '6', '7'].map((n, i) => ball(`b${n}`, { x: -0.9 + i * 0.25, y: 0.4 }, n)), ball('v8', { x: 0.3, y: 0.15 }, 'black')];
    const a = addBallTo(table, balls, { neutral: true })!;
    expect(a.ball.kind).toBe('object');
    expect(a.ball.label).toBe('ball');
    expect(a.ball.color).toBeUndefined();
    expect(tagText(a.ball)).toBe('');
    const tags = balls.map((b) => tagText(b));
    expect(tags).toContain('8');
    expect(balls.map((b) => b.id)).not.toContain(a.ball.id);
    // The practice table keeps its numbered balls (its numbers follow its own ids).
    const p = addBallTo(table, balls, { neutral: false })!;
    expect(p.ball.label).toMatch(/^\d+$/);
    expect(balls.map((b) => tagText(b))).not.toContain(tagText(p.ball));
  });

  it('no cue ball yet: the new ball is the cue ball', () => {
    const a = addBallTo(table, [ball('v1', { x: 0.3, y: 0.15 }, '8')], { neutral: true })!;
    expect(a.ball.kind).toBe('cue');
  });

  it('a snooker table, and a table with no room left', () => {
    const snk = makeTable('snooker12');
    const balls = [ball('cue', { x: 0, y: 0 }, 'cue', 'cue')];
    const p = freeSpotNearCentre(snk, balls)!;
    clear(p, balls, snk);
    // Fill the cloth: nothing fits.
    const full: Ball[] = [];
    for (let x = -table.length / 2 + R; x <= table.length / 2 - R; x += 2 * R) for (let y = -table.width / 2 + R; y <= table.width / 2 - R; y += 2 * R) full.push(ball(`f${full.length}`, { x, y }));
    expect(freeSpotNearCentre(table, full)).toBeNull();
    expect(addBallTo(table, full, { neutral: true })).toBeNull();
  });
});

describe('5. one sentence for a speed-sensitive recommendation', () => {
  it('the toast and the card note are the same player-language sentence', () => {
    const m = { v: 2, type: 'recommendation', id: 1, stroke: { power: 4, side: 0, vert: 0 }, score: 1, reachable: true, evaluated: 100, fragile: true } as unknown as RecommendationReply;
    const toast = recommendationOutcome(m, false).toast;
    expect(toast).toBe(REC_NOTES.fragile);
    expect(toast).toBe('This stroke may need precise pace: a little harder or softer could miss or scratch.');
    const plan = planShot(drill('cut30'), { targetId: 'b1', pocketId: 'TR' }, params, { recommended: { power: 5, side: 0, vert: -0.2 } });
    expect(cardHtml(plan, { fragile: true })).toContain(`<p class="rec-note">`);
    expect(cardHtml(plan, { fragile: true })).toContain(REC_NOTES.fragile);
  });
});

describe('6. labels: no "Cue stops" next to "Not makeable"; the stroke name in full; 3D label off the balls', () => {
  beforeEach(() => stubDocument());
  afterEach(() => {
    delete (globalThis as { document?: unknown }).document;
  });
  const K = 220;
  const H = [K, 0, 320, 0, -K, 240, 0, 0, 1];
  function texts2d(plan: ShotPlan, balls: Ball[]) {
    const rec = recordingCanvas(393, 700);
    new TableView(rec.canvas).draw({ table, balls, plan, targetId: plan.targetId, pocketId: plan.pocketId, landing: null, heatmap: null });
    return rec.texts.map((t) => t.text);
  }
  function textsOverlay(plan: ShotPlan, balls: Ball[]) {
    const rec = recordingCanvas(640, 480);
    const data: OverlayData = {
      table,
      calibration: { corners: [], H0: H, HR: H, focal: 500, focalSource: 'assumed', source: 'auto', camera: { x: 0, y: 0, z: 2 }, width: 640, height: 480 } as unknown as OverlayData['calibration'],
      balls,
      plan,
      targetId: plan.targetId,
      pocketId: plan.pocketId,
      calibTaps: [],
      showPlan: true,
    };
    new Overlay(rec.canvas).draw(data, { toScreen: (p) => p, toFrame: (p) => p });
    return rec.texts.map((t) => t.text);
  }

  it('2D table and camera overlay: "Not makeable" without "Cue stops"; a makeable plan keeps it', () => {
    const lay = drill('blocked');
    const bad = planShot(lay, { targetId: 'b5', pocketId: 'BM' }, params);
    expect(bad.makeable).toBe(false);
    expect(bad.cueRest).not.toBeNull();
    const frozenLay = frozenLayout({ x: 0.87, y: 0.48 }, 'TR', 30);
    const frozenBad = planShot(frozenLay, { targetId: 'b1', pocketId: 'TR' }, params);
    expect(frozenBad.makeable).toBe(false);
    for (const [p, balls] of [
      [bad, lay.balls],
      [frozenBad, frozenLay.balls],
    ] as const) {
      for (const t of [texts2d(p, balls), textsOverlay(p, balls)]) {
        expect(t).toContain('Not makeable');
        expect(t).not.toContain('Cue stops');
      }
    }
    const good = planShot(drill('cut30'), { targetId: 'b1', pocketId: 'TR' }, params);
    expect(texts2d(good, drill('cut30').balls)).toContain('Cue stops');
    expect(textsOverlay(good, drill('cut30').balls)).toContain('Cue stops');
  });

  it('the spin tile carries the whole stroke name ("Follow, right english"), split where it may wrap', () => {
    const lay = layoutOf([
      { id: 'cue', kind: 'cue', pos: { x: -0.5, y: -0.1 }, label: 'cue' },
      { id: 'b1', kind: 'object', pos: { x: 0.6, y: 0.3 }, label: '1' },
    ]);
    const p = planShot(lay, { targetId: 'b1', pocketId: 'TR', stroke: { power: 3, side: 0.25, vert: 0.3 } }, params);
    expect(p.strokeName).toBe('Follow, right english');
    const html = cardHtml(p);
    const tile = /<div class="hero-stat spin(?: [a-z-]+)*">[\s\S]*?<div class="s"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/.exec(html);
    expect(tile, html).not.toBeNull();
    const words = tile![1]!.replace(/<[^>]+>/g, '').trim();
    expect(words).toBe('Follow, right english');
    // The base and the side are separate lines of the tile, so neither is cut off.
    expect(tile![1]).toMatch(/<span class="t">Follow,<\/span>\s*<span class="t2">right english<\/span>/);
    // A stroke name with no side stays one line.
    const plain = planShot(drill('cut30'), { targetId: 'b1', pocketId: 'TR', stroke: { power: 3, side: 0, vert: 0.3 } }, params);
    expect(cardHtml(plain)).not.toContain('class="t2"');
  });

  it('3D label placement keeps a ball\'s whole disc clear, not only its centre (sliding a little if that does it)', () => {
    const anchor = { x: 200, y: 400, r: 10 };
    const free = { left: 0, top: 0, right: 400, bottom: 800 };
    const size = { w: 120, h: 60 };
    // The right-hand spot spans x 226–346, y 370–430. A ball whose centre is 10 px below it (outside
    // the 6 px pad) but whose 14 px disc reaches 4 px under it; the left side covers a plain line point.
    const ball = { x: 276, y: 440, w: 3 };
    const discClear = (p: { x: number; y: number }) => Math.hypot(Math.max(p.x - ball.x, 0, ball.x - (p.x + size.w)), Math.max(p.y - ball.y, 0, ball.y - (p.y + size.h))) >= 14;
    const withR = placeLabel(anchor, size, [{ ...ball, r: 14 }, { x: 120, y: 400 }], free, { gap: 16, prefer: ['right', 'left'], slide: true });
    expect(withR.covered).toBe(0);
    expect(discClear(withR)).toBe(true);
    // As a bare point (the old rule) the right-hand spot was taken, and it hid the ball's edge.
    const bare = placeLabel(anchor, size, [ball, { x: 120, y: 400 }], free, { gap: 16, prefer: ['right', 'left'], slide: true });
    expect(discClear(bare)).toBe(false);
  });

  it('the Orbit view at 375 px (a recorded frame): every side covers something, and the label no longer hides the 2 ball', () => {
    // FrameInfo of the default drill, Follow + right english, Orbit preset, 375×667 (recorded from
    // the app): line points (weight 1), the two object balls (centre, on-screen radius), the stick (3).
    const pts = [[256,262],[247,256],[238,251],[230,245],[221,240],[213,235],[205,229],[196,224],[188,219],[188,217],[186,214],[185,212],[183,209],[182,206],[180,203],[178,199],[176,195],[174,191],[173,188],[171,184],[169,180],[167,177],[165,173],[163,170],[162,166],[160,163],[158,159],[156,156],[155,152],[153,149],[151,145],[149,142],[148,140],[148,140],[256,262],[246,256],[234,248],[223,241],[211,233],[200,226],[189,220],[181,220],[170,219],[159,218],[147,217],[136,216],[146,216],[157,216],[168,216],[179,216],[190,216],[190,216],[263,392],[275,259],[277,149],[145,138],[122,246],[103,376]].map(([x, y]) => ({ x: x!, y: y! }));
    const stick = [[260,261],[266,263],[271,266],[277,268],[282,271],[288,273],[294,276],[299,279],[305,281],[311,284],[317,287],[323,289],[329,292],[335,295],[341,298],[348,301],[354,303],[360,306]].map(([x, y]) => ({ x: x!, y: y!, w: 3 }));
    const balls = [{ x: 186, y: 213, r: 3.1 }, { x: 220, y: 315, r: 3.4 }];
    const anchor = { x: 256, y: 260, r: 6 };
    const free = { left: 6, top: 115, right: 369, bottom: 421 };
    const size = { w: 156, h: 101 };
    const prefer = ['right', 'left', 'above-right', 'above-left', 'below-right', 'below-left', 'above', 'below'] as const;
    const hides = (p: { x: number; y: number }) => balls.some((b) => Math.hypot(Math.max(p.x - b.x, 0, b.x - (p.x + size.w)), Math.max(p.y - b.y, 0, b.y - (p.y + size.h))) < b.r);
    const place = (w: number) => placeLabel(anchor, size, [...pts, ...stick, ...balls.map((b) => ({ ...b, w }))], free, { gap: 16, prefer: [...prefer], slide: true });
    expect(hides(place(BALL_AVOID_WEIGHT))).toBe(false);
    // Weighed like a stick point (3), as before, the cheapest spot was right on the 2 ball.
    expect(hides(place(3))).toBe(true);
  });

  it('and it does not slide under a floating control (Play, slow motion) instead', () => {
    const anchor = { x: 240, y: 400, r: 10 };
    const free = { left: 0, top: 0, right: 400, bottom: 800 };
    const size = { w: 120, h: 60 };
    // A ball under the left-hand spot, and the Play button where the right-hand spot would go: the
    // label goes above (clear of both) rather than under Play.
    const avoid = [{ x: 150, y: 400, w: BALL_AVOID_WEIGHT, r: 5 }];
    const play = { left: 330, top: 380, right: 390, bottom: 430 };
    const overlaps = (p: { x: number; y: number }) => p.x < play.right && p.x + size.w > play.left && p.y < play.bottom && p.y + size.h > play.top;
    const prefer = ['left', 'right', 'above', 'below'] as const;
    expect(overlaps(placeLabel(anchor, size, avoid, free, { gap: 16, prefer: [...prefer], slide: true }))).toBe(true);
    const p = placeLabel(anchor, size, [...avoid, blockedPoint(play)], free, { gap: 16, prefer: [...prefer], slide: true });
    expect(overlaps(p)).toBe(false);
    expect(p.covered).toBe(0);
  });

  it('a label whose every side covers something slides a few px to clear a ball rather than hide its edge', () => {
    const anchor = { x: 200, y: 400, r: 10 };
    const free = { left: 0, top: 0, right: 400, bottom: 800 };
    const size = { w: 120, h: 60 };
    // Plain line points under both sides' spots, and a ball whose disc the left-hand spot (x 54–174,
    // y 370–430) would cover by its edge (centre 8 px below it, radius 10): a short slide clears it and
    // still covers only the line point.
    const ball = { x: 170, y: 438, w: 3, r: 10 };
    const avoid = [ball, { x: 120, y: 400 }, { x: 290, y: 400 }, { x: 300, y: 400 }];
    const p = placeLabel(anchor, size, avoid, free, { gap: 16, prefer: ['left', 'right'], slide: true });
    expect(p.side).toBe('left');
    expect(p.covered).toBe(1);
    expect(Math.hypot(Math.max(p.x - ball.x, 0, ball.x - (p.x + size.w)), Math.max(p.y - ball.y, 0, ball.y - (p.y + size.h)))).toBeGreaterThanOrEqual(ball.r);
  });
});
