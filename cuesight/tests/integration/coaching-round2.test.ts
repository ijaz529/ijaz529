/**
 * Coaching fixes from the player review (round 2): recommended pace a player would actually use,
 * a pace reference that stays meaningful, no confident stroke for a cue ball that never arrives, one
 * spin vocabulary with stroke names, squirt as an aim offset, and scratch risks from the probes.
 */
import { describe, expect, it } from 'vitest';
import { DRILLS } from '../../src/app/drills';
import { DEFAULT_PHYSICS } from '../../src/core/physics/params';
import { coachingTip, contactSpinOf, squirtOffsetText, strokeName } from '../../src/core/shot/coach';
import { planShot } from '../../src/core/shot/planner';
import { recommendStroke } from '../../src/core/shot/position';
import { describeSpin, paceDiamonds, speedReference } from '../../src/core/shot/power';
import { suggestShots } from '../../src/core/shot/suggest';
import { makeTable } from '../../src/core/table';
import type { Ball, TableLayout } from '../../src/core/types';

const P = DEFAULT_PHYSICS;
const T = makeTable('pool9');
const drill = (id: string): TableLayout => ({ table: T, balls: DRILLS.find((d) => d.id === id)!.build(T), source: 'virtual', frozen: false });
const firstObject = (l: TableLayout) => l.balls.find((b) => b.kind === 'object')!.id;

describe('recommended pace', () => {
  it('a hanger is played soft: ≤ 3/10 and ≤ +3 diamonds past pocket speed', () => {
    const l = drill('scratch');
    const t = firstObject(l);
    const rec = recommendStroke(l, { targetId: t }, P, { budgetMs: 4000 });
    const plan = planShot(l, { targetId: t }, P, { recommended: rec.stroke });
    expect(rec.stroke.power).toBeLessThanOrEqual(3);
    expect(plan.scratch).toBe(false);
    expect(paceDiamonds(plan.obPocketSpeed, T.length, P)).toBeLessThanOrEqual(3.5);
  });
  it('the 30° cut is played at no more than a table length past pocket speed', () => {
    const l = drill('cut30');
    const rec = recommendStroke(l, { targetId: 'b1', pocketId: 'TR' }, P, { budgetMs: 4000 });
    const plan = planShot(l, { targetId: 'b1', pocketId: 'TR' }, P, { recommended: rec.stroke });
    expect(rec.stroke.power).toBeLessThanOrEqual(5);
    expect(paceDiamonds(plan.obPocketSpeed, T.length, P)).toBeLessThan(12);
  });
  it('over random layouts the pace text never counts beyond a table length', () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    let n = 0;
    for (let k = 0; k < 200 && n < 10; k++) {
      const p = () => ({ x: (rnd() * 2 - 1) * (T.length / 2 - 0.06), y: (rnd() * 2 - 1) * (T.width / 2 - 0.06) });
      const balls: Ball[] = [
        { id: 'cue', kind: 'cue', pos: p(), label: 'cue' },
        { id: 'b1', kind: 'object', pos: p(), label: '1' },
        { id: 'b2', kind: 'object', pos: p(), label: '2' },
      ];
      if (balls.some((a, i) => balls.some((b, j) => i < j && Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y) < 0.15))) continue;
      const l: TableLayout = { table: T, balls, source: 'virtual', frozen: false };
      const base = planShot(l, { targetId: 'b1' }, P, { record: false });
      if (!base.makeable || base.cutAngleDeg > 60) continue;
      n++;
      const rec = recommendStroke(l, { targetId: 'b1', pocketId: base.pocketId }, P, { budgetMs: 1500 });
      const plan = planShot(l, { targetId: 'b1', pocketId: base.pocketId }, P, { recommended: rec.stroke, record: false });
      const ref = speedReference(plan.obPocketSpeed, T.length, P) ?? '';
      expect(ref).not.toMatch(/\d+ table lengths/);
      expect(rec.stroke.power).toBeLessThanOrEqual(8);
    }
    expect(n).toBeGreaterThanOrEqual(5);
  });
  it('speedReference stops counting past about a table length', () => {
    expect(speedReference(5, 2.54, P)).toBe('well past pocket speed: over a table length');
    expect(speedReference(1.2, 2.54, P)).not.toMatch(/\d+ table lengths/);
  });
});

describe('a cue ball that never gets there', () => {
  it('cut30 at 1/10 with 1½ tips below centre: cb-short warning, its own tip, no "stun"', () => {
    const plan = planShot(drill('cut30'), { targetId: 'b1', pocketId: 'TR', stroke: { power: 1, side: 0, vert: -0.375 } }, P);
    expect(plan.warnings.some((w) => w.code === 'cb-short')).toBe(true);
    expect(plan.warnings.find((w) => w.code === 'cb-short')!.message).toMatch(/stops before it reaches the 1\. Use power \d/);
    expect(plan.warnings.some((w) => w.code === 'too-soft')).toBe(false);
    expect(plan.tip).toContain('stops before it reaches');
    expect(plan.tip).not.toMatch(/[Ss]tun/);
    expect(plan.strokeName).toBeNull();
    expect(contactSpinOf(0, 0)).toBe('short');
  });
});

describe('one spin vocabulary, stroke names', () => {
  it('tips above/below centre, plural above one tip', () => {
    expect(describeSpin({ side: 0, vert: -0.375 })).toBe('1½ tips below centre');
    expect(describeSpin({ side: 0.25, vert: 0.125 })).toBe('½ tip above centre, 1 tip right');
    expect(describeSpin({ side: 0, vert: 0 })).toBe('centre ball');
  });
  it('names the stroke from the spin at contact', () => {
    expect(strokeName({ contact: 'draw', contactRatio: -0.5, cutDeg: 0, vert: -0.4, side: 0 })).toBe('Draw');
    expect(strokeName({ contact: 'stun', contactRatio: 0, cutDeg: 0, vert: -0.2, side: 0 })).toBe('Stop shot');
    expect(strokeName({ contact: 'stun', contactRatio: 0, cutDeg: 30, vert: -0.2, side: 0 })).toBe('Stun');
    expect(strokeName({ contact: 'follow', contactRatio: 0.3, cutDeg: 30, vert: 0, side: 0 })).toBe('Stun-run-through');
    expect(strokeName({ contact: 'follow', contactRatio: 0.3, cutDeg: 30, vert: -0.25, side: 0 })).toBe('Drag');
    expect(strokeName({ contact: 'roll', contactRatio: 1, cutDeg: 30, vert: 0.4, side: 0.25 })).toBe('Follow, right english');
    const plan = planShot(drill('straight'), { targetId: 'b1', pocketId: 'TR', stroke: { power: 6, side: 0, vert: -0.4 } }, P);
    expect(plan.strokeName).toBe('Draw');
  });
});

describe('squirt as an aim offset at the ghost ball', () => {
  it('turns degrees into mm and balls, and the tip says it', () => {
    expect(squirtOffsetText(1.3, 1, 0.75, 0.028575)).toMatch(/^about ⅓ of a ball \(17 mm\) right of the ghost ball$/);
    expect(squirtOffsetText(0.1, -1, 0.3, 0.028575)).toBeNull();
    const tip = coachingTip({ cutDeg: 30, contact: 'stun', throwDeg: 0, throwShiftMm: 0, squirtDeg: 1.3, side: 0.25, scratch: false, blocked: false, makeable: true, cbDistance: 0.75, ballRadius: 0.028575 });
    expect(tip).toContain('right of the ghost ball');
    expect(tip).toContain('right of the blue line');
  });
});

describe('suggestions carry the card\'s unit', () => {
  it('toleranceMm matches the plan for the same shot', () => {
    const l = drill('nine');
    const s = suggestShots(l, P, 3)[0]!;
    const plan = planShot(l, { targetId: s.targetId, pocketId: s.pocketId }, P, { record: false });
    expect(s.toleranceMm).toBeCloseTo(plan.toleranceMm, 6);
  });
});

describe('scratch risk from the robustness probes', () => {
  it('reports which error scratches and where, as a list (empty when safe)', () => {
    const l = drill('rail');
    const rec = recommendStroke(l, { targetId: 'b9' }, P, { budgetMs: 4000 });
    expect(Array.isArray(rec.risks)).toBe(true);
    for (const r of rec.risks!) {
      expect(['harder', 'softer', 'aim', 'tip']).toContain(r.scratchIf);
      expect(T.pockets.map((p) => p.id)).toContain(r.pocketId);
    }
  });
});

describe('rail and ball together', () => {
  it('the rail drill at 7/10 meets the cushion within ms of the 9: the tip says so first', () => {
    const l = drill('rail');
    const p = planShot(l, { targetId: 'b9', stroke: { power: 7, side: 0, vert: -0.25 } }, P);
    expect(p.tip).toMatch(/^Rail and ball together/);
    const clear = planShot(drill('cut30'), { targetId: 'b1', pocketId: 'TR', stroke: { power: 4, side: 0, vert: 0 } }, P);
    expect(clear.tip).not.toContain('Rail and ball');
  });
});
