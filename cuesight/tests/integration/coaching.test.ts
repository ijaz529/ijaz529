/**
 * Coaching fixes from the player review (round 1): fractional-aim labels that do not mislead, the
 * cue's own direction under squirt, throw in aiming terms, a recommender that keeps side spin for
 * when it pays, a speed reference players can calibrate to, and replays that show spin.
 */
import { describe, expect, it } from 'vitest';
import { DRILLS } from '../../src/app/drills';
import { buildTrack, sampleTrack, type BallPose } from '../../src/app/render3d/playback';
import { DEFAULT_PHYSICS } from '../../src/core/physics/params';
import { coachingTip, throwSentence } from '../../src/core/shot/coach';
import { cutOfFraction, fractionOf } from '../../src/core/shot/geometry';
import { planShot } from '../../src/core/shot/planner';
import { recommendStroke } from '../../src/core/shot/position';
import { speedReference } from '../../src/core/shot/power';
import { makeTable, pocketById } from '../../src/core/table';
import type { TableLayout } from '../../src/core/types';
import { add, cross, deg, rad, scale } from '../../src/core/vec';
import { layout } from '../helpers/layout';

const P = DEFAULT_PHYSICS;
const T = makeTable('pool9');
const drill = (id: string): TableLayout => ({ table: T, balls: DRILLS.find((d) => d.id === id)!.build(T), source: 'virtual', frozen: false });
const firstObject = (l: TableLayout) => l.balls.find((b) => b.kind === 'object')!.id;

describe('fractional aim', () => {
  it('has a label every ⅛ of overlap, at the right angles', () => {
    expect(deg(cutOfFraction(0.875))).toBeCloseTo(7.18, 1);
    expect(deg(cutOfFraction(0.625))).toBeCloseTo(22.02, 1);
    expect(deg(cutOfFraction(0.375))).toBeCloseTo(38.68, 1);
    expect(fractionOf(rad(7.2)).label).toBe('⅞');
    expect(fractionOf(rad(22)).label).toBe('⅝');
    expect(fractionOf(rad(38.7)).label).toBe('⅜');
    expect(fractionOf(rad(38.7)).phrase).toBe('⅜-ball');
  });
  it('says which way a cut differs from its label when it is more than 1.5° off', () => {
    expect(fractionOf(rad(30)).phrase).toBe('½-ball');
    expect(fractionOf(rad(31)).phrase).toBe('½-ball');
    // The rail drill (35.7°) used to headline "½-ball": aiming half-ball undercuts it by ~6°.
    expect(fractionOf(rad(35.7)).phrase).toBe('a touch thicker than ⅜-ball');
    // 12° is not "¾-ball" (14.5°).
    expect(fractionOf(rad(12)).phrase).toBe('a touch thicker than ¾-ball');
    expect(fractionOf(rad(24.5)).phrase).toBe('a touch thinner than ⅝-ball');
    expect(fractionOf(rad(85)).phrase).toBe('a thin hit');
  });
  it('the planner carries the phrase', () => {
    const plan = planShot(drill('rail'), { targetId: firstObject(drill('rail')) }, P);
    expect(plan.fractionPhrase).toMatch(/⅜|½/);
    expect(plan.fractionPhrase).not.toBe('½-ball');
  });
});

describe('squirt: the cue points off the cue-ball path', () => {
  const pk = pocketById(T, 'TR');
  const ob = add(pk.mouthCenter, scale(pk.inward, 0.6));
  const cue = add(pk.mouthCenter, scale(pk.inward, 1.3));
  const lay = layout({ cue, ob });
  it('right english: cue aimed right (clockwise) of the blue line; left english: left', () => {
    const r = planShot(lay, { targetId: 'ob', pocketId: 'TR', stroke: { power: 4, side: 0.3, vert: 0 } }, P);
    const l = planShot(lay, { targetId: 'ob', pocketId: 'TR', stroke: { power: 4, side: -0.3, vert: 0 } }, P);
    const c = planShot(lay, { targetId: 'ob', pocketId: 'TR', stroke: { power: 4, side: 0, vert: 0 } }, P);
    expect(cross(r.aimDir, r.cueDir)).toBeLessThan(0);
    expect(cross(l.aimDir, l.cueDir)).toBeGreaterThan(0);
    expect(Math.abs(deg(Math.asin(cross(r.aimDir, r.cueDir))))).toBeCloseTo(Math.abs(r.squirtDeg), 6);
    expect(c.cueDir.x).toBeCloseTo(c.aimDir.x, 12);
    expect(c.cueDir.y).toBeCloseTo(c.aimDir.y, 12);
  });
  it('the tip says to aim the cue off the blue line, not that it is already in it', () => {
    const r = planShot(lay, { targetId: 'ob', pocketId: 'TR', stroke: { power: 4, side: 0.3, vert: 0 } }, P);
    expect(r.tip).toContain('right of the blue line');
    expect(r.tip).not.toContain('already in the line shown');
  });
});

describe('throw in aiming terms', () => {
  it('straight-in with side: left/right of full ball, never "thinner"', () => {
    const pk = pocketById(T, 'TR');
    const ob = add(pk.mouthCenter, scale(pk.inward, 0.6));
    const cue = add(pk.mouthCenter, scale(pk.inward, 1.3));
    const lay = layout({ cue, ob });
    const r = planShot(lay, { targetId: 'ob', pocketId: 'TR', stroke: { power: 3, side: 0.35, vert: 0 } }, P);
    const l = planShot(lay, { targetId: 'ob', pocketId: 'TR', stroke: { power: 3, side: -0.35, vert: 0 } }, P);
    expect(r.throwAim === 'left' || r.throwAim === 'right').toBe(true);
    expect(l.throwAim === 'left' || l.throwAim === 'right').toBe(true);
    expect(r.throwAim).not.toBe(l.throwAim);
    expect(throwSentence(r)).toMatch(/of full ball/);
  });
  it('a cut with inside vs outside english moves the ghost ball opposite ways', () => {
    const pk = pocketById(T, 'TR');
    const ob = add(pk.mouthCenter, scale(pk.inward, 0.5));
    const dir = { x: -pk.inward.x, y: -pk.inward.y };
    const g = { x: ob.x - 2 * T.ballRadius * dir.x, y: ob.y - 2 * T.ballRadius * dir.y };
    const a = Math.atan2(dir.y, dir.x) + rad(10);
    const cue = { x: g.x - 0.6 * Math.cos(a), y: g.y - 0.6 * Math.sin(a) };
    const lay = layout({ cue, ob });
    const plus = planShot(lay, { targetId: 'ob', pocketId: 'TR', stroke: { power: 3, side: 0.3, vert: 0 } }, P);
    const minus = planShot(lay, { targetId: 'ob', pocketId: 'TR', stroke: { power: 3, side: -0.3, vert: 0 } }, P);
    const centre = planShot(lay, { targetId: 'ob', pocketId: 'TR', stroke: { power: 3, side: 0, vert: 0 } }, P);
    for (const p of [plus, minus, centre]) expect(['thinner', 'thicker']).toContain(p.throwAim);
    // Centre-ball throw always pushes the object ball thick → aim thinner.
    expect(centre.throwAim).toBe('thinner');
    expect(new Set([plus.throwAim, minus.throwAim]).size).toBe(2);
    expect(throwSentence({ throwDeg: 1.6, throwShiftMm: 1.2, throwAim: 'thicker' })).toContain('thicker');
  });
  it('coachingTip names the throw direction', () => {
    const t = coachingTip({ cutDeg: 20, contact: 'stun', throwDeg: -1.4, throwShiftMm: 1.3, throwAim: 'thicker', squirtDeg: 0, side: 0, scratch: false, blocked: false, makeable: true });
    expect(t).toContain('1.3 mm thicker');
  });
});

describe('recommended stroke keeps side spin for when it pays', () => {
  for (const id of ['straight', 'scratch']) {
    it(`${id} drill: no side`, () => {
      const l = drill(id);
      const rec = recommendStroke(l, { targetId: firstObject(l) }, P, { budgetMs: 4000 });
      expect(rec.stroke.side).toBe(0);
    });
  }
  it('cut30 drill: no side either (centre-line strokes give position here)', () => {
    const l = drill('cut30');
    const t = l.balls.find((b) => b.id === 'b1')!.id;
    const rec = recommendStroke(l, { targetId: t, pocketId: 'TR' }, P, { budgetMs: 4000 });
    expect(rec.stroke.side).toBe(0);
  });
});

describe('speed in player terms', () => {
  it('diamonds past pocket speed, from the object ball speed at the mouth', () => {
    expect(speedReference(0, 2.54, P)).toBeNull();
    expect(speedReference(0.05, 2.54, P)).toBe('pocket speed: it just drops');
    // v²/(2μr g) = 2 diamonds (2 × 0.3175 m) → v = √(2·0.635·μr·g).
    const v2d = Math.sqrt(2 * 0.635 * P.muRoll * P.g);
    expect(speedReference(v2d, 2.54, P)).toBe('pocket speed + 2 diamonds');
    expect(speedReference(5, 2.54, P)).toMatch(/table lengths?$/);
  });
  it('the plan carries the object ball speed at the mouth', () => {
    const l = drill('cut30');
    const plan = planShot(l, { targetId: 'b1', pocketId: 'TR', stroke: { power: 4, side: 0, vert: 0 } }, P);
    expect(plan.obPocketed).toBe(true);
    expect(plan.obPocketSpeed).toBeGreaterThan(0);
    expect(plan.obPocketSpeed).toBeLessThan(plan.obSpeed);
  });
});

describe('replay shows the spin the simulator computed', () => {
  it('a draw shot turns backward on its way to the object ball (not forward like a rolling ball)', () => {
    const pk = pocketById(T, 'TR');
    const ob = add(pk.mouthCenter, scale(pk.inward, 0.6));
    const cue = add(pk.mouthCenter, scale(pk.inward, 1.4));
    const lay = layout({ cue, ob });
    const plan = planShot(lay, { targetId: 'ob', pocketId: 'TR', stroke: { power: 6, side: 0, vert: -0.4 } }, P);
    expect(plan.cuePath.spins?.length).toBe(plan.cuePath.points.length);
    expect(plan.cuePath.times?.length).toBe(plan.cuePath.points.length);
    const tr = buildTrack(plan.cuePath, T.ballRadius);
    expect(tr.span).not.toBeNull();
    const hit = plan.cuePath.events.find((e) => e.kind === 'ball')!;
    // Rotation per recorded span (axis·angle), signed against the rolling axis ẑ × d̂: rolling
    // forward is +, backspin is −. Angles accumulate over many turns, so check the spans, not the
    // wrapped total.
    const d = plan.aimDir;
    let before = 0;
    let rolling = 0;
    for (let i = 0; i + 1 < tr.t.length && tr.t[i + 1]! <= hit.t + 1e-9; i++) {
      const k = 4 * i;
      before += (tr.span![k]! * -d.y + tr.span![k + 1]! * d.x) * tr.span![k + 3]!;
      rolling += Math.hypot(tr.x[i + 1]! - tr.x[i]!, tr.y[i + 1]! - tr.y[i]!) / T.ballRadius;
    }
    expect(rolling).toBeGreaterThan(5);
    expect(before).toBeLessThan(-0.3 * rolling); // backspin all the way in
    // And sampling inside a span applies part of it (frame-rate independent pose).
    const pose: BallPose = { x: 0, y: 0, z: 0, q: [0, 0, 0, 1], visible: true };
    sampleTrack(tr, hit.t * 0.5, T.ballRadius, pose);
    expect(Math.hypot(...pose.q)).toBeCloseTo(1, 9);
  });
  it('a stun shot slides: far less rotation than rolling the same distance', () => {
    const pk = pocketById(T, 'TR');
    const ob = add(pk.mouthCenter, scale(pk.inward, 0.5));
    const cue = add(pk.mouthCenter, scale(pk.inward, 0.9));
    const lay = layout({ cue, ob });
    const plan = planShot(lay, { targetId: 'ob', pocketId: 'TR', stroke: { power: 7, side: 0, vert: -0.12 } }, P);
    const tr = buildTrack(plan.cuePath, T.ballRadius);
    const hit = plan.cuePath.events.find((e) => e.kind === 'ball')!;
    let turned = 0;
    let rolling = 0;
    for (let i = 0; i + 1 < tr.t.length && tr.t[i + 1]! <= hit.t + 1e-9; i++) {
      turned += tr.span![4 * i + 3]!;
      rolling += Math.hypot(tr.x[i + 1]! - tr.x[i]!, tr.y[i + 1]! - tr.y[i]!) / T.ballRadius;
    }
    expect(rolling).toBeGreaterThan(5);
    expect(turned).toBeLessThan(0.5 * rolling);
  });
});
