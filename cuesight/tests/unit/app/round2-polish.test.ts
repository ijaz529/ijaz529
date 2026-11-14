/**
 * Round-2 polish (design + coach review): no stroke for a shot that cannot happen (card, 3D label,
 * Snap how-to), one-line hero tiles, pocket buttons in visual order, the strike disc drawn on the
 * 3D cue ball in Player view, a single-hue power ramp, and the pocket target as an arc on the cloth.
 */
import { describe, expect, it } from 'vitest';
import { DRILLS } from '../../../src/app/drills';
import { tableGeom } from '../../../src/app/render3d/geom';
import { ADDRESS_GAP, mouthArc, planRibbons, practiceStroke } from '../../../src/app/render3d/scene-data';
import { DEFAULT_SETTINGS, physicsFor } from '../../../src/app/settings';
import { playable, unplayableHeadline } from '../../../src/app/snap/guide';
import { placeLabel } from '../../../src/app/ui/label-place';
import { powerBarSvg, powerRamp, shotLabelMarkup, strikeFaceSvg, warnLabelMarkup } from '../../../src/app/ui/scene-labels';
import { fractionTile, pocketOrder, renderShotCard, type CardContext } from '../../../src/app/ui/shot-card';
import { planShot } from '../../../src/core/shot/planner';
import { makeTable } from '../../../src/core/table';
import type { TableLayout } from '../../../src/core/types';

const table = makeTable('pool9');
const params = physicsFor(DEFAULT_SETTINGS);
const lay = (d: string): TableLayout => ({ table, balls: DRILLS.find((x) => x.id === d)!.build(table), source: 'virtual', frozen: false });
const stubEl = () => ({ innerHTML: '', dataset: {}, closest: () => null }) as unknown as HTMLElement;
const ctx = (o: Partial<CardContext> = {}): CardContext => ({ targetLabel: '1', pocketName: 'far right corner', status: null, recommendedPending: false, showDetails: false, hint: '', ...o });

describe('no stroke for a shot that cannot happen', () => {
  it('blocked: the card lists each reason once, in the hero, with no power, spin or aim corrections', () => {
    const plan = planShot(lay('blocked'), { targetId: 'b1', pocketId: 'TR' }, params);
    expect(plan.makeable).toBe(false);
    const el = stubEl();
    renderShotCard(el, plan, ctx());
    const html = el.innerHTML;
    expect(html.match(/blocked by 5/g)?.length).toBe(1);
    expect(html).not.toContain('class="power-meter"');
    expect(html).not.toContain('class="corr"');
    expect(html).not.toContain('recommended for position');
  });
  it('cue ball stops short: the label and the Snap how-to say so instead of a stroke', () => {
    const plan = planShot(lay('cut30'), { targetId: 'b1', pocketId: 'TR', stroke: { power: 1, side: 0, vert: -0.375 } }, params);
    expect(playable(plan)).toBe(false);
    const u = unplayableHeadline(plan);
    expect(u.title).toContain('Too soft');
    expect(u.reason).toContain('stops before it reaches');
    const blocked = planShot(lay('blocked'), { targetId: 'b1', pocketId: 'TR' }, params);
    const b = unplayableHeadline(blocked);
    expect(b.title).toBe('Not makeable');
    expect(b.reason).toMatch(/^[A-Z]/);
    const w = warnLabelMarkup('Not makeable', 'Try the far left corner');
    expect(w).toContain('Try the far left corner');
    expect(w).not.toMatch(/\/10/);
  });
});

describe('hero tiles and pickers', () => {
  it('one short line per tile', () => {
    expect(fractionTile({ fractionLabel: '½', fractionPhrase: '½-ball' })).toBe('½-ball hit');
    expect(fractionTile({ fractionLabel: '¾', fractionPhrase: 'a touch thicker than ¾-ball' })).toBe('¾+ ball');
    expect(fractionTile({ fractionLabel: '⅝', fractionPhrase: 'a touch thinner than ⅝-ball' })).toBe('⅝− ball');
    const plan = planShot(lay('cut30'), { targetId: 'b1', pocketId: 'TR', stroke: { power: 6, side: 0, vert: -0.4 } }, params);
    const el = stubEl();
    renderShotCard(el, plan, ctx());
    expect(el.innerHTML).toContain(`<span class="t">${plan.strokeName}</span>`);
    expect(el.innerHTML).toMatch(/strike <span data-testid="spin">1½ tips below centre<\/span>/);
  });
  it('pocket buttons read ahead → beside → behind, left before right', () => {
    const names = ['near left corner', 'far right corner', 'corner on your left', 'corner straight ahead', 'right side', 'corner behind you'];
    const sorted = [...names].sort((a, b) => pocketOrder(a) - pocketOrder(b));
    expect(sorted.indexOf('corner straight ahead')).toBeLessThan(sorted.indexOf('corner on your left'));
    expect(sorted.indexOf('corner on your left')).toBeLessThan(sorted.indexOf('right side'));
    expect(sorted.indexOf('right side')).toBeLessThan(sorted.indexOf('near left corner'));
    expect(sorted.indexOf('far right corner')).toBeLessThan(sorted.indexOf('near left corner'));
  });
});

describe('in-scene label and strike disc', () => {
  it('compact Player-view label: power and the stroke name, no mini ball', () => {
    const html = shotLabelMarkup({ power: 6, side: 0, vert: -0.25 }, { compact: true, name: 'Draw' });
    expect(html).not.toContain('sl-ball');
    expect(html).toContain('Draw');
    expect(html).toContain('<b class="num">6</b>');
  });
  it('the strike disc puts a low hit below centre and a right hit right of centre', () => {
    const at = (svg: string) => {
      const m = /class="tip-dot" cx="([-\d.]+)" cy="([-\d.]+)"/.exec(svg)!;
      return { x: Number(m[1]), y: Number(m[2]) };
    };
    expect(at(strikeFaceSvg(0, -0.25)).y).toBeGreaterThan(0.2);
    expect(at(strikeFaceSvg(0.25, 0)).x).toBeGreaterThan(0.2);
    expect(Number(/class="tip-dot"[^>]* r="([\d.]+)"/.exec(strikeFaceSvg(0, 0))![1])).toBeLessThan(0.3);
  });
  it('the power bar is one hue (white → sky)', () => {
    const fills = [...powerBarSvg(10).matchAll(/class="seg on"[^>]*fill="([^"]+)"/g)].map((m) => m[1]);
    expect(fills).toHaveLength(10);
    expect(fills[0]).toBe(powerRamp(0));
    expect(powerRamp(9)).toBe('rgb(86,180,233)');
    for (const f of fills) expect(f).not.toMatch(/#E69F00|#18A374|#E9C46A/i);
  });
  it('a weighted avoid point (the cue stick) outweighs plain ones', () => {
    const anchor = { x: 200, y: 400, r: 20 };
    const free = { left: 0, top: 0, right: 400, bottom: 800 };
    // Three plain points on the left, one stick point (weight 3 ×2) on the right.
    const avoid = [{ x: 120, y: 400 }, { x: 110, y: 400 }, { x: 100, y: 400 }, { x: 280, y: 400, w: 3 }, { x: 300, y: 400, w: 3 }];
    const p = placeLabel(anchor, { w: 120, h: 40 }, avoid, free, { prefer: ['right', 'left'] });
    expect(p.side).toBe('left');
  });
});

describe('3D cue and pocket marks', () => {
  it('the cue rests at address; practice strokes grow with power', () => {
    expect(ADDRESS_GAP).toBeCloseTo(0.015, 9);
    expect(practiceStroke(8)).toBeGreaterThan(practiceStroke(2));
    expect(practiceStroke(6)).toBeCloseTo(0.15, 9);
  });
  it('the target pocket is a gold arc on the cloth, jaw to jaw, bulging into the table', () => {
    const g = tableGeom(table);
    const l = lay('cut30');
    const plan = planShot(l, { targetId: 'b1', pocketId: 'TR' }, params);
    const rib = planRibbons({ table, balls: l.balls, plan, targetId: 'b1', pocketId: 'TR', landing: null }, g);
    const pk = rib.find((r) => r.key === 'pocket')!;
    expect(pk.z).toBeLessThan(0.005);
    expect(pk.closed).toBeFalsy();
    const spec = table.pockets.find((p) => p.id === 'TR')!;
    const hole = g.holes.find((h) => h.id === 'TR')!;
    const arc = mouthArc(spec, hole);
    expect(Math.hypot(arc[0]!.x - spec.jawA.x, arc[0]!.y - spec.jawA.y)).toBeLessThan(1e-9);
    expect(Math.hypot(arc[arc.length - 1]!.x - spec.jawB.x, arc[arc.length - 1]!.y - spec.jawB.y)).toBeLessThan(1e-9);
    const mid = arc[Math.floor(arc.length / 2)]!;
    expect((mid.x - hole.x) * spec.inward.x + (mid.y - hole.y) * spec.inward.y).toBeGreaterThan(0);
  });
  it('the top view outlines the ghost ball in solid sky (never two white rings side by side)', () => {
    const g = tableGeom(table);
    const l = lay('cut30');
    const plan = planShot(l, { targetId: 'b1', pocketId: 'TR' }, params);
    const top = planRibbons({ table, balls: l.balls, plan, targetId: 'b1', pocketId: 'TR', landing: null }, g, { ghostSolid: true }).find((r) => r.key === 'ghost')!;
    expect(top.dash).toBeUndefined();
    expect(top.color[2]).toBeGreaterThan(top.color[0]);
  });
});

describe('top-view ball tags', () => {
  it('numbers for numbered balls, an initial for colours, nothing on the cue ball', async () => {
    const { tagText } = await import('../../../src/app/ui/ball-tags');
    expect(tagText({ kind: 'object', label: '9', id: 'b9' })).toBe('9');
    expect(tagText({ kind: 'object', label: 'yellow stripe', id: 'x' })).toBe('9');
    expect(tagText({ kind: 'object', label: 'black', id: 'x' })).toBe('8');
    expect(tagText({ kind: 'object', label: 'blue', id: 'x' })).toBe('2');
    expect(tagText({ kind: 'object', label: 'white?', id: 'x' })).toBe('W');
    expect(tagText({ kind: 'object', label: 'black', id: 'x' }, true)).toBe('Bk');
    expect(tagText({ kind: 'object', label: 'blue', id: 'x' }, true)).toBe('Bl');
    expect(tagText({ kind: 'cue', label: 'cue', id: 'cue' })).toBe('');
  });
});
