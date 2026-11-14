/**
 * Round-1 polish (design + player review): label placement, the in-scene power/strike label, the
 * Snap zoom mapping, compact card wording, and the 3D plan marks (blockers, scratch, target ring).
 */
import { describe, expect, it } from 'vitest';
import { DRILLS } from '../../../src/app/drills';
import { tableGeom } from '../../../src/app/render3d/geom';
import { planRibbons } from '../../../src/app/render3d/scene-data';
import { PALETTE } from '../../../src/app/render/palette';
import { DEFAULT_SETTINGS, physicsFor } from '../../../src/app/settings';
import { focusMapping } from '../../../src/app/snap/draw';
import { placeLabel, candidate } from '../../../src/app/ui/label-place';
import { powerBarSvg, shotLabelMarkup } from '../../../src/app/ui/scene-labels';
import { fractionShort, headlineWarning, marginText } from '../../../src/app/ui/shot-card';
import { planShot } from '../../../src/core/shot/planner';
import { makeTable } from '../../../src/core/table';
import type { TableLayout } from '../../../src/core/types';

const table = makeTable('pool9');
const params = physicsFor(DEFAULT_SETTINGS);
const layoutOf = (drill: string): TableLayout => ({ table, balls: DRILLS.find((d) => d.id === drill)!.build(table), source: 'virtual', frozen: false });

describe('label placement', () => {
  const free = { left: 0, top: 0, right: 400, bottom: 800 };
  it('goes to the side with nothing on it', () => {
    const anchor = { x: 200, y: 400, r: 20 };
    // A path running off to the right of the ball: the label goes left.
    const avoid = Array.from({ length: 30 }, (_, i) => ({ x: 220 + i * 6, y: 400 }));
    const p = placeLabel(anchor, { w: 120, h: 50 }, avoid, free);
    expect(p.covered).toBe(0);
    expect(p.x + 120).toBeLessThanOrEqual(anchor.x);
  });
  it('stays inside the free box and never sits on the anchor', () => {
    const anchor = { x: 390, y: 20, r: 15 };
    const p = placeLabel(anchor, { w: 150, h: 60 }, [], free);
    expect(p.x).toBeGreaterThanOrEqual(0);
    expect(p.y).toBeGreaterThanOrEqual(0);
    expect(p.x + 150).toBeLessThanOrEqual(400);
    const overlaps = anchor.x + anchor.r > p.x && anchor.x - anchor.r < p.x + 150 && anchor.y + anchor.r > p.y && anchor.y - anchor.r < p.y + 60;
    expect(overlaps).toBe(false);
  });
  it('candidates sit clear of the circle', () => {
    for (const side of ['right', 'left', 'above', 'below'] as const) {
      const q = candidate(side, { x: 0, y: 0 }, 10, 40, 20, 5);
      const cx = Math.max(q.x, Math.min(q.x + 40, 0));
      const cy = Math.max(q.y, Math.min(q.y + 20, 0));
      expect(Math.hypot(cx, cy)).toBeGreaterThanOrEqual(15 - 1e-9);
    }
  });
});

describe('in-scene power/strike label', () => {
  it('shows n/10, the speed word, a 10-segment bar and the tip in words', () => {
    const html = shotLabelMarkup({ power: 6, side: 0, vert: 0.25 });
    expect(html).toContain('<b class="num">6</b><small>/10</small>');
    expect(html).toContain('medium-firm');
    expect(html).toContain('1 tip above centre');
    expect(html).toContain('class="spin-ball-svg"');
    const bar = powerBarSvg(6.5);
    expect(bar.match(/class="seg on"/g)?.length).toBe(7); // 6 full + 1 half
  });
});

describe('Snap zoom onto the shot', () => {
  it('zooms into the region (never below fit-to-view) and keeps the crop inside the photo', () => {
    const m = focusMapping(1280, 960, 390, 520, { x0: 500, y0: 300, x1: 760, y1: 700 }, 0.15);
    const contain = 390 / 1280;
    expect(m.scale).toBeGreaterThan(contain * 2);
    // The region is fully on screen.
    const a = m.toScreen({ x: 500, y: 300 });
    const b = m.toScreen({ x: 760, y: 700 });
    expect(a.x).toBeGreaterThanOrEqual(0);
    expect(a.y).toBeGreaterThanOrEqual(0);
    expect(b.x).toBeLessThanOrEqual(390);
    expect(b.y).toBeLessThanOrEqual(520);
    // Round trip.
    const q = m.toFrame(m.toScreen({ x: 640, y: 480 }));
    expect(q.x).toBeCloseTo(640, 9);
    // A region at the photo's corner: the crop is clamped (no empty band inside the canvas).
    const c = focusMapping(1280, 960, 390, 520, { x0: 1200, y0: 900, x1: 1270, y1: 950 }, 0.15);
    expect(c.toScreen({ x: 1280, y: 960 }).x).toBeGreaterThanOrEqual(390 - 1e-6);
    expect(c.toScreen({ x: 1280, y: 960 }).y).toBeGreaterThanOrEqual(520 - 1e-6);
    // No region: the whole photo, fitted.
    expect(focusMapping(1280, 960, 390, 520, null).scale).toBeCloseTo(contain, 9);
  });
});

describe('shot card wording', () => {
  it('fraction short form, margin in mm, headline warning', () => {
    expect(fractionShort({ fractionLabel: '½', fractionPhrase: '½-ball' })).toBe('½-ball hit');
    // Non-breaking hyphen: "¾-" / "ball" must not wrap apart in a narrow column.
    expect(fractionShort({ fractionLabel: '⅜', fractionPhrase: 'a touch thicker than ⅜-ball' })).toBe('thicker than ⅜\u2011ball');
    expect(marginText({ toleranceMm: 3.04 })).toBe('±3.0 mm');
    expect(marginText({ toleranceMm: 12.4 })).toBe('±12 mm');
    const blocked = planShot(layoutOf('blocked'), { targetId: 'b1', pocketId: 'TR' }, params);
    expect(headlineWarning(blocked)?.code).toMatch(/blocked/);
    const ok = planShot(layoutOf('cut30'), { targetId: 'b1', pocketId: 'TR', stroke: { power: 4, side: 0, vert: 0 } }, params);
    expect(headlineWarning(ok)).toBeNull();
  });
});

describe('3D plan marks', () => {
  const g = tableGeom(table);
  it('not makeable: dashed vermillion aim and an ✕ on the blocker; target ring is white and optional', () => {
    const lay = layoutOf('blocked');
    const plan = planShot(lay, { targetId: 'b1', pocketId: 'TR' }, params);
    const rib = planRibbons({ table, balls: lay.balls, plan, targetId: 'b1', pocketId: 'TR', landing: null }, g);
    const aim = rib.find((r) => r.key === 'aim')!;
    expect(plan.makeable).toBe(false);
    expect(aim.dash).toBeDefined();
    expect(rib.some((r) => r.key.startsWith('block:'))).toBe(true);
    const target = rib.find((r) => r.key === 'target')!;
    expect(target.color.slice(0, 3)).toEqual([1, 1, 1]);
    expect(PALETTE.target).toBe('#FFFFFF');
    const pocket = rib.find((r) => r.key === 'pocket')!;
    expect(pocket.color[0]).toBeGreaterThan(0.85); // gold, not the 1-ball's yellow
    const noRing = planRibbons({ table, balls: lay.balls, plan, targetId: 'b1', pocketId: 'TR', landing: null }, g, { targetRing: false });
    expect(noRing.some((r) => r.key === 'target')).toBe(false);
  });
  it('makeable: solid aim line, no ✕', () => {
    const lay = layoutOf('cut30');
    const plan = planShot(lay, { targetId: 'b1', pocketId: 'TR' }, params);
    const rib = planRibbons({ table, balls: lay.balls, plan, targetId: 'b1', pocketId: 'TR', landing: null }, g);
    expect(rib.find((r) => r.key === 'aim')!.dash).toBeUndefined();
    expect(rib.some((r) => r.key.startsWith('block:') || r.key.startsWith('scratch'))).toBe(false);
  });
});
