/**
 * UI building blocks of feature 002 (US3, package "ui"): icon set, power gauge, spin ball, fraction
 * glyph and the redesigned shot card. Vitest runs in Node, so these test the pure markup builders and
 * render the shot card into a minimal element stub; the 001 e2e test ids and texts must survive.
 */
import { describe, expect, it } from 'vitest';
import { planShot } from '../../../src/core/shot/planner';
import { makeTable } from '../../../src/core/table';
import type { TableLayout } from '../../../src/core/types';
import { DRILLS } from '../../../src/app/drills';
import { DEFAULT_SETTINGS, physicsFor } from '../../../src/app/settings';
import { ICON_NAMES, iconMarkup, type IconName } from '../../../src/app/ui/icons';
import { powerMeterSvg, powerText, segmentFill } from '../../../src/app/ui/power-meter';
import { spinBallSvg, spinText } from '../../../src/app/ui/spin-ball';
import { fractionGlyphSvg, fractionText, glyphOffset } from '../../../src/app/ui/fraction-glyph';
import { ballChip, renderShotCard, type CardContext } from '../../../src/app/ui/shot-card';

const CONTRACT_ICONS: IconName[] = [
  'play', 'pause', 'camera', 'image', 'target', 'crosshair', 'cube', 'layers', 'sparkles', 'settings', 'info', 'close', 'check',
  'chevron-up', 'chevron-down', 'refresh', 'snowflake', 'hand', 'ruler', 'cue', 'ball', 'eye', 'rotate-3d', 'upload',
];

describe('icons', () => {
  it('covers every icon named in the UI contract', () => {
    for (const n of CONTRACT_ICONS) expect(ICON_NAMES).toContain(n);
  });
  it('draws on a 24 px grid with 1.75 px round currentColor strokes, hidden from assistive tech', () => {
    for (const n of ICON_NAMES) {
      const svg = iconMarkup(n, 20);
      expect(svg).toMatch(/^<svg [^>]*viewBox="0 0 24 24"/);
      expect(svg).toContain('width="20" height="20"');
      expect(svg).toContain('stroke="currentColor"');
      expect(svg).toContain('stroke-width="1.75"');
      expect(svg).toContain('stroke-linecap="round"');
      expect(svg).toContain('aria-hidden="true"');
      expect(svg).toMatch(/<(path|circle|rect|ellipse) /);
      // No remote references and no embedded raster images.
      expect(svg.replace(' xmlns="http://www.w3.org/2000/svg"', '')).not.toMatch(/https?:|<image|xlink:href|url\(/);
    }
  });
  it('builds a closed gear outline for settings', () => {
    expect(iconMarkup('settings')).toMatch(/<path d="M[\d. L]+Z"\/>/);
  });
});

describe('power meter', () => {
  it('gives a player-facing text equivalent', () => {
    expect(powerText(6, null)).toBe('Power 6 of 10, medium-firm');
    expect(powerText(4.5, 3.25)).toBe('Power 4.5 of 10, medium. Minimum 3.3');
    expect(powerText(10, 12)).toContain('Needs more than full power');
  });
  it('fills whole and half segments', () => {
    expect([0, 5, 6].map((i) => segmentFill(i, 6))).toEqual([1, 1, 0]);
    expect(segmentFill(6, 6.5)).toBe(0.5);
    expect(segmentFill(9, 10)).toBe(1);
  });
  it('draws 10 tracks, the lit segments and the minimum-power tick', () => {
    const svg = powerMeterSvg(6, 3);
    expect(svg.match(/stroke="rgba\(255,255,255,0.1\)"/g)).toHaveLength(10);
    expect(svg.match(/class="seg on"/g)).toHaveLength(6);
    expect(svg).toContain('class="min-tick"');
    expect(powerMeterSvg(6, null)).not.toContain('min-tick');
  });
});

describe('spin ball', () => {
  it('places the tip dot on the ball face (side right, vert up)', () => {
    const svg = spinBallSvg(0.5, 0, 56, 't1');
    expect(svg).toContain('class="tip-dot" cx="73.0" cy="50.0"');
    expect(spinBallSvg(0, 0.5, 56, 't2')).toContain('class="tip-dot" cx="50.0" cy="27.0"');
  });
  it('draws the miscue ring at half the radius and keeps gradient ids unique', () => {
    const a = spinBallSvg(0, 0);
    const b = spinBallSvg(0, 0);
    expect(a).toContain('class="miscue" cx="50" cy="50" r="23"');
    const id = (s: string) => /id="([^"]+)-base"/.exec(s)![1];
    expect(id(a)).not.toBe(id(b));
  });
  it('describes the tip in coaching words', () => {
    expect(spinText(0, 0)).toBe('Cue tip: centre ball');
    expect(spinText(-0.25, 0.25)).toContain('1 tip above centre, 1 tip left');
  });
});

describe('fraction glyph', () => {
  it('offsets the cue ball by 2R(1 − fraction) toward the side it covers', () => {
    expect(glyphOffset(0.5, 'left')).toBeCloseTo(1);
    expect(glyphOffset(0.5, 'right')).toBeCloseTo(-1);
    expect(glyphOffset(1, 'left')).toBeCloseTo(0);
    expect(glyphOffset(0, 'right')).toBeCloseTo(-2);
    expect(glyphOffset(0.3, 'straight')).toBe(0);
  });
  it('has a title text equivalent', () => {
    expect(fractionText(0.5, 'left')).toBe('50% ball overlap, cut to the left');
    expect(fractionText(1, 'right')).toBe('Full-ball hit, straight');
    const svg = fractionGlyphSvg(0.5, 'left', 'g1');
    expect(svg).toContain('role="img"');
    expect(svg).toContain('<title>50% ball overlap, cut to the left</title>');
  });
});

/** Minimal element stub: renderShotCard only writes innerHTML and reads dataset/closest. */
function stubEl(): HTMLElement {
  return { innerHTML: '', dataset: {}, closest: () => null } as unknown as HTMLElement;
}

describe('shot card (001 regression contract)', () => {
  const table = makeTable('pool9');
  const params = physicsFor(DEFAULT_SETTINGS);
  const ctx = (over: Partial<CardContext> = {}): CardContext => ({
    targetLabel: '1',
    pocketName: 'top-right corner',
    status: null,
    recommendedPending: false,
    showDetails: false,
    hint: 'Tap the ball you want to pocket, then a pocket (or let CueSight pick the best one).',
    ...over,
  });
  const layoutOf = (drill: string): TableLayout => ({ table, balls: DRILLS.find((d) => d.id === drill)!.build(table), source: 'virtual', frozen: false });

  it('keeps every tested id and text for the 30° drill', () => {
    const plan = planShot(layoutOf('cut30'), { targetId: 'b1', pocketId: 'TR' }, params);
    const el = stubEl();
    renderShotCard(el, plan, ctx({ targetColor: '#e8b90f' }));
    const html = el.innerHTML;
    expect(html).toContain('data-testid="shot-card"');
    expect(html).toMatch(/data-testid="cut">30\.0°</);
    expect(html).toMatch(/data-testid="power">\d+(\.\d)?<small>\/10<\/small>/);
    expect(html).toMatch(/data-testid="difficulty">[^<]*±/);
    expect(html).toContain('data-testid="tip"');
    expect(html).toContain('½-ball hit');
    expect(html).toContain('data-testid="spin"');
    // Every visual has a text equivalent.
    expect(html).toMatch(/class="power-meter" role="img" aria-label="Power \d/);
    expect(html).toMatch(/class="spin-ball" role="img" aria-label="Cue tip: /);
    expect(html).toContain('class="fraction-glyph"');
    expect(el.dataset.shot).toBe('b1>TR');
  });

  it('names the blocker in the warnings list', () => {
    const plan = planShot(layoutOf('blocked'), { targetId: 'b1', pocketId: 'TR' }, params);
    const el = stubEl();
    renderShotCard(el, plan, ctx());
    // Not role="alert": that re-announced every warning on each re-plan (e.g. while dragging the
    // power slider). Warnings are announced once, when they first appear, by main.ts's live region.
    expect(el.innerHTML).toMatch(/<ul class="warnings"[^>]*>.*blocked by 5/s);
    expect(el.innerHTML).not.toContain('role="alert"');
    // Not makeable: the reason and what to do instead lead the card (shown at the sheet's peek).
    expect(el.innerHTML).toMatch(/class="hero blocked">.*blocked by 5/s);
    expect(el.innerHTML).toContain('data-card-act="suggest"');
  });

  it('offers "Bank it" on a shot that is not makeable when a bank is open: the main action unless another pocket is offered', () => {
    const plan = planShot(layoutOf('blocked'), { targetId: 'b1', pocketId: 'TR' }, params);
    const html = (over: Partial<CardContext>) => {
      const el = stubEl();
      renderShotCard(el, plan, ctx(over));
      return el.innerHTML;
    };
    expect(html({})).not.toContain('data-card-act="bank"');
    expect(html({ bankOption: { pocketName: null } })).toMatch(/class="btn primary" data-card-act="bank">.*<span>Bank it off a cushion<\/span>/s);
    const both = html({ bankOption: { pocketName: 'far left corner' }, altPocket: { id: 'TL', name: 'far left corner' } });
    expect(both).toMatch(/class="btn primary" data-card-act="alt"/);
    expect(both).toMatch(/class="btn secondary" data-card-act="bank">.*<span>Bank it into the far left corner<\/span>/s);
  });

  it('shows the hint (and the status) when there is no plan', () => {
    const el = stubEl();
    renderShotCard(el, null, ctx({ status: 'Table locked' }));
    expect(el.innerHTML).toContain('Tap the ball you want to pocket');
    expect(el.innerHTML).toContain('Table locked');
    expect(el.innerHTML).not.toContain('data-testid="shot-card"');
  });

  it('escapes labels and draws stripe chips', () => {
    expect(ballChip('<b>', '#fff')).not.toContain('<b>');
    expect(ballChip('9', '#e8b90f', true)).toContain('ball-chip stripe');
    expect(ballChip('9', '#e8b90f', true)).toContain('<i>9</i>');
    expect(ballChip('cue')).toContain('ball-chip cue');
  });
});
