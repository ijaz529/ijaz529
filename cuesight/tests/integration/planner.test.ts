import { describe, expect, it } from 'vitest';
import { rollingDeflection } from '../../src/core/physics/analytic';
import { DEFAULT_PHYSICS } from '../../src/core/physics/params';
import { simulate } from '../../src/core/physics/simulate';
import { strikeBall } from '../../src/core/physics/strike';
import { planShot, stunVert } from '../../src/core/shot/planner';
import { pocketWindow } from '../../src/core/shot/pocket-window';
import { advisePower, powerFigure, powerToSpeed } from '../../src/core/shot/power';
import { makeTable, pocketById } from '../../src/core/table';
import type { ShotPlan, Trajectory } from '../../src/core/types';
import { add, angleBetween, angleOf, deg, fromAngle, norm, rad, rotate, scale, sub, v2, type Vec2 } from '../../src/core/vec';
import { layout } from '../helpers/layout';

const P = DEFAULT_PHYSICS;
const T = makeTable('pool9');
const R = T.ballRadius;

/** Place the cue ball so the shot of `ob` into `pocketId` has the given cut and CB distance. */
function cutLayout(ob: Vec2, pocketId: 'TR' | 'TM' | 'BR', cutDeg: number, cbDist: number, extra: Record<string, Vec2> = {}) {
  const w = pocketWindow(ob, pocketById(T, pocketId), R);
  const ghost = sub(ob, scale(w.dir, 2 * R));
  const travel = fromAngle(angleOf(w.dir) + rad(cutDeg));
  const cue = sub(ghost, scale(travel, cbDist));
  return { lay: layout({ cue, ob, ...extra }), travel, obDir: w.dir };
}

/** Direction of the cue ball's leg right after the object-ball contact (up to the next event). */
function postContactDir(tr: Trajectory, legs = 1): Vec2 {
  const k = tr.events.findIndex((e) => e.kind === 'ball');
  const a = tr.events[k]!.pos;
  const b = tr.events[k + legs]?.pos ?? tr.points[tr.points.length - 1]!;
  return norm(sub(b, a));
}

const has = (p: ShotPlan, code: string) => p.warnings.some((w) => w.code === code);

describe('planShot', () => {
  it('straight-in: 0° cut, full ball, no throw', () => {
    const pk = pocketById(T, 'TR');
    const ob = add(pk.mouthCenter, scale(pk.inward, 0.6));
    const cue = add(pk.mouthCenter, scale(pk.inward, 1.3));
    const plan = planShot(layout({ cue, ob }), { targetId: 'ob', pocketId: 'TR' }, P);
    expect(plan.makeable).toBe(true);
    expect(plan.cutAngleDeg).toBeLessThan(0.5);
    expect(plan.fractionLabel).toBe('full');
    expect(Math.abs(plan.throwDeg)).toBeLessThan(0.05);
    expect(plan.obPocketed).toBe(true);
    expect(plan.tip).toMatch(/Straight-in/);
  });

  it('30° stun: CB leaves along the tangent line (within 4° for real balls) and names the 90° rule', () => {
    const { lay, obDir } = cutLayout(v2(0.4, 0.15), 'TR', 30, 0.7);
    const power = 6; // firm enough that backspin can wear off exactly at contact over 0.7 m
    const vert = stunVert(0.7, powerToSpeed(power), P);
    expect(vert).toBeGreaterThan(-0.45);
    const plan = planShot(lay, { targetId: 'ob', pocketId: 'TR', stroke: { power, side: 0, vert } }, P);
    expect(plan.makeable).toBe(true);
    expect(plan.obPocketed).toBe(true);
    const d = postContactDir(plan.cuePath);
    // Measure against the actual line of centres at impact (the throw-compensated ghost ball).
    void obDir;
    const ob = lay.balls.find((b) => b.id === 'ob')!.pos;
    const centres = norm(sub(ob, plan.ghost));
    const fromCentres = Math.abs(deg(angleBetween(centres, d)));
    expect(fromCentres).toBeGreaterThan(86);
    expect(fromCentres).toBeLessThan(91);
    expect(plan.tip).toMatch(/90° rule/);
    expect(Math.abs(plan.throwDeg)).toBeGreaterThan(0.5); // stun cuts throw noticeably
  });

  it('30° rolling: CB bends ≈ 30° off its original line and names the 30° rule', () => {
    const { lay, travel } = cutLayout(v2(0.4, 0.15), 'TR', 30, 0.7);
    const plan = planShot(lay, { targetId: 'ob', pocketId: 'TR', stroke: { power: 4, side: 0, vert: 0.4 } }, P);
    expect(plan.obPocketed).toBe(true);
    // After contact: slide (curve) → roll event → straight leg. Measure that straight leg.
    const tr = plan.cuePath;
    const k = tr.events.findIndex((e) => e.kind === 'ball');
    const roll = tr.events.findIndex((e, i) => i > k && e.kind === 'roll');
    const a = tr.events[roll]!.pos;
    const b = tr.events[roll + 1]?.pos ?? tr.points[tr.points.length - 1]!;
    const defl = Math.abs(deg(angleBetween(travel, norm(sub(b, a)))));
    expect(Math.abs(defl - deg(rollingDeflection(rad(30))))).toBeLessThan(4);
    expect(plan.tip).toMatch(/30° rule/);
  });

  it('flags a blocked cue-ball path and names the blocker', () => {
    const { lay } = cutLayout(v2(0.4, 0.15), 'TR', 20, 0.9);
    const cue = lay.balls.find((b) => b.id === 'cue')!.pos;
    const ob = lay.balls.find((b) => b.id === 'ob')!.pos;
    lay.balls.push({ id: 'x', kind: 'object', pos: v2((cue.x + ob.x) / 2, (cue.y + ob.y) / 2), label: '5' });
    const plan = planShot(lay, { targetId: 'ob', pocketId: 'TR' }, P);
    expect(plan.makeable).toBe(false);
    const w = plan.warnings.find((x) => x.code === 'blocked-cue')!;
    expect(w.ballId).toBe('x');
    expect(w.message).toMatch(/5/);
  });

  it('flags a blocked object-ball path', () => {
    const pk = pocketById(T, 'TR');
    const ob = add(pk.mouthCenter, scale(pk.inward, 0.8));
    const blocker = add(pk.mouthCenter, scale(pk.inward, 0.4));
    const cue = add(pk.mouthCenter, scale(pk.inward, 1.5));
    const plan = planShot(layout({ cue, ob, blk: blocker }), { targetId: 'ob', pocketId: 'TR' }, P);
    expect(has(plan, 'blocked-object')).toBe(true);
  });

  it('warns about a scratch (follow into the corner)', () => {
    const pk = pocketById(T, 'TR');
    const ob = add(pk.mouthCenter, scale(pk.inward, 0.25));
    const cue = add(pk.mouthCenter, scale(pk.inward, 0.6));
    const plan = planShot(layout({ cue, ob }), { targetId: 'ob', pocketId: 'TR', stroke: { power: 6, side: 0, vert: 0.4 } }, P);
    expect(plan.scratch).toBe(true);
    expect(has(plan, 'scratch')).toBe(true);
    expect(plan.cueRest).toBeNull();
  });

  it('an ≥88° cut is not makeable and suggests another pocket', () => {
    const ob = v2(0, 0);
    const cue = v2(-0.5, 2 * R);
    const plan = planShot(layout({ cue, ob }), { targetId: 'ob', pocketId: 'BM' }, P);
    expect(plan.makeable).toBe(false);
    const w = plan.warnings.find((x) => x.code === 'not-makeable')!;
    expect(w.message).toMatch(/Try the/);
    expect(plan.alternatives.length).toBeGreaterThan(0);
  });

  it('auto-selects the most forgiving pocket', () => {
    const pk = pocketById(T, 'TR');
    const ob = add(pk.mouthCenter, scale(pk.inward, 0.35));
    const cue = add(pk.mouthCenter, scale(pk.inward, 0.9));
    const plan = planShot(layout({ cue, ob }), { targetId: 'ob' }, P);
    expect(plan.pocketId).toBe('TR');
    expect(plan.difficulty).toBe('easy');
  });

  it('computes minimum power and warns when too soft', () => {
    const ob = v2(-0.2, 0.1);
    const cue = v2(-1.1, -0.3);
    const plan = planShot(layout({ cue, ob }), { targetId: 'ob', pocketId: 'TR', stroke: { power: 1, side: 0, vert: 0 } }, P);
    expect(plan.minPower).toBeGreaterThan(1);
    expect(plan.obPocketed).toBe(false);
    expect(has(plan, 'too-soft')).toBe(true);
    // Split messages: power 1 does not get the cue ball there or the object ball in.
    expect(plan.warnings.find((w) => w.code === 'too-soft')!.message).toMatch(/won't reach the object ball|stops short/);
    // minPower is the "arrives with pace" minimum; the bare capture minimum is at most that.
    expect(plan.minPowerCapture!).toBeLessThanOrEqual(plan.minPower);
    expect(plan.minPowerSafe).toBe(plan.minPower); // deprecated alias
    const ok = planShot(layout({ cue, ob }), { targetId: 'ob', pocketId: 'TR', stroke: { power: Math.ceil(plan.minPower) + 1, side: 0, vert: 0 } }, P);
    expect(has(ok, 'too-soft')).toBe(false);
    expect(ok.obPocketed).toBe(true);
  });

  it('minPower is the minimum the app shows: played at it the ball drops and nothing says "too soft" (minPower backward compatible)', () => {
    let seed = 99;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    let n = 0;
    for (let tries = 0; n < 40 && tries < 2000; tries++) {
      const ob = v2((rnd() * 2 - 1) * 1.1, (rnd() * 2 - 1) * 0.5);
      const cue = v2((rnd() * 2 - 1) * 1.1, (rnd() * 2 - 1) * 0.5);
      if (Math.hypot(ob.x - cue.x, ob.y - cue.y) < 0.2) continue;
      const lay = layout({ cue, ob });
      const base = planShot(lay, { targetId: 'ob' }, P, { record: false });
      if (!base.makeable || base.minPower > 9.5 || base.minPower <= 1.05) continue;
      n++;
      const where = JSON.stringify({ cue, ob, pocket: base.pocketId, minPower: base.minPower });
      expect(base.minPowerCapture!, where).toBeLessThanOrEqual(base.minPower);
      const atMin = planShot(lay, { targetId: 'ob', pocketId: base.pocketId, stroke: { power: base.minPower, side: 0, vert: 0 } }, P, { record: false });
      expect(atMin.obPocketed, where).toBe(true);
      expect(has(atMin, 'too-soft'), where).toBe(false);
      // Below it the advice quotes the one figure the app shows for it (the 3D label's
      // ceil-to-half of minPower): a power the half-step control can set, never below minPower.
      const below = planShot(lay, { targetId: 'ob', pocketId: base.pocketId, stroke: { power: Math.max(1, base.minPower - 0.5), side: 0, vert: 0 } }, P, { record: false });
      const soft = below.warnings.find((w) => w.code === 'too-soft');
      const advised = advisePower(base.minPower);
      expect(advised, where).toBeGreaterThanOrEqual(base.minPower - 1e-6);
      expect(advised, where).toBe(Math.ceil(base.minPower * 2) / 2);
      if (soft && /Use power|Power \d/.test(soft.message)) expect(soft.message, where).toContain(`${powerFigure(advised)}+`);
    }
    expect(n).toBe(40);
  });

  it('a ball that only blocks the throw-corrected ghost is reported (blocker re-check after throw correction)', () => {
    const ob = v2(0.4, 0.15);
    const { lay } = cutLayout(ob, 'TR', 30, 0.7);
    const stroke = { power: 3, side: 0, vert: 0 };
    const open = planShot(lay, { targetId: 'ob', pocketId: 'TR', stroke }, P);
    expect(open.throwShiftMm).toBeGreaterThan(1);
    // Just inside the clearance (2R − 0.5 mm) of the corrected ghost, on the side it moved to, so
    // the geometric ghost (and the cue-ball path to it) is clear of it.
    const away = norm(sub(open.ghost, open.ghostUncorrected));
    const blk = add(open.ghost, scale(away, 2 * R - 0.001));
    expect(Math.hypot(blk.x - open.ghostUncorrected.x, blk.y - open.ghostUncorrected.y)).toBeGreaterThan(2 * R - 0.0005);
    const cue = lay.balls.find((b) => b.id === 'cue')!.pos;
    const plan = planShot(layout({ cue, ob, blk }), { targetId: 'ob', pocketId: 'TR', stroke }, P);
    expect(plan.makeable).toBe(false);
    const w = plan.warnings.find((x) => x.code === 'blocked-cue');
    expect(w?.ballId).toBe('blk');
    expect(w?.message).toMatch(/once the aim is corrected for throw/);
  });

  it('with no pocket makeable, auto mode falls back to the pocket with the widest open window (ranking tie-breaks)', () => {
    // Cue ball frozen above the ball: the line of centres points straight at the bottom rail, so no
    // pocket is makeable and every tolerance is 0. The fallback is the clearest view (TR), not the
    // first pocket in table order (BL).
    const ob = v2(0.9, 0.3);
    const lay = layout({ cue: v2(0.9, 0.3 + 2 * R), ob });
    const plan = planShot(lay, { targetId: 'ob' }, P);
    expect(plan.makeable).toBe(false);
    let widest = { id: '', half: -1 };
    for (const pk of T.pockets) {
      const w = pocketWindow(ob, pk, R);
      if (w.ok && w.halfRad > widest.half) widest = { id: pk.id, half: w.halfRad };
    }
    expect(plan.pocketId).toBe(widest.id);
    expect(plan.windowHalfDeg).toBeGreaterThan(0);
  });

  it('a cue ball that touches a jaw before the object ball gives no throw correction (probe checks ball-first contact)', () => {
    // Cue ball pressed 1 mm into the top cushion next to the side pocket (vision noise): leaving
    // toward the ball it clips the jaw first, so the probe's hit is not a clean ball-first contact.
    const lay = layout({ cue: v2(-0.0772, 0.6074), ob: v2(0.1467, 0.5581) });
    const plan = planShot(lay, { targetId: 'ob', pocketId: 'BR' }, P);
    expect(plan.cuePath.events.find((e) => e.kind !== 'roll')?.kind).toBe('jaw');
    expect(plan.throwDeg).toBe(0);
    expect(plan.ghost).toEqual(plan.ghostUncorrected);
  });

  it("never says 'stops short' for a stroke the simulation pots (50 seeded layouts near the minimum)", () => {
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const hx = T.length / 2 - R;
    const hy = T.width / 2 - R;
    let n = 0;
    const potted = { below: 0, safe: 0 };
    const short = { below: 0, safe: 0 };
    for (let tries = 0; n < 50 && tries < 4000; tries++) {
      const ob = v2((rnd() * 2 - 1) * hx * 0.9, (rnd() * 2 - 1) * hy * 0.9);
      const cue = v2((rnd() * 2 - 1) * hx * 0.9, (rnd() * 2 - 1) * hy * 0.9);
      if (Math.hypot(ob.x - cue.x, ob.y - cue.y) < 4 * R) continue;
      const lay = layout({ cue, ob });
      const probe = planShot(lay, { targetId: 'ob' }, P, { record: false });
      if (!probe.makeable || probe.minPower > 10 || probe.minPowerCapture! - 0.2 < 1) continue;
      n++;
      // Just below the bare capture minimum, and just below the "with pace" minimum (where the old
      // planner said "stops short" for balls that drop).
      const powers = { below: probe.minPowerCapture! - 0.2, safe: probe.minPower - 0.2 };
      for (const k of ['below', 'safe'] as const) {
        const plan = planShot(lay, { targetId: 'ob', pocketId: probe.pocketId, stroke: { power: powers[k], side: 0, vert: 0 } }, P, { record: false });
        const saysShort = plan.warnings.some((w) => /stops short/.test(w.message));
        if (plan.obPocketed) potted[k]++;
        if (saysShort) short[k]++;
        // Never contradicts the simulation: "stops short" only when the ball stayed on the table.
        if (saysShort) expect(plan.objectPath.pocket, `${k} ${JSON.stringify({ cue, ob })}`).toBeNull();
        expect(plan.obPocketed && saysShort, `${k} ${JSON.stringify({ cue, ob })}`).toBe(false);
      }
    }
    expect(n).toBe(50);
    console.log(`of 50: potted at minPowerCapture − 0.2 ${potted.below}, at minPower − 0.2 ${potted.safe}; "stops short" ${short.below} / ${short.safe}`);
    // Not vacuous: balls do drop below the old minimum, and below the bare minimum they stop short.
    expect(potted.safe).toBeGreaterThan(25);
    expect(short.below).toBeGreaterThan(25);
  });

  it('a hanger at power 1.5 is potted and never called "stops short"', () => {
    const pk = pocketById(T, 'TR');
    const { lay } = cutLayout(add(pk.mouthCenter, scale(pk.inward, 0.08)), 'TR', 40, 0.25);
    const plan = planShot(lay, { targetId: 'ob', pocketId: 'TR', stroke: { power: 1.5, side: 0, vert: 0 } }, P);
    expect(plan.obPocketed).toBe(true);
    expect(plan.warnings.some((w) => /stops short/.test(w.message))).toBe(false);
    expect(plan.minPowerCapture!).toBeLessThanOrEqual(1.5);
  });

  it("says the cue ball won't reach when it stops before the object ball", () => {
    const pk = pocketById(T, 'TR');
    const ob = add(pk.mouthCenter, scale(pk.inward, 0.3));
    const cue = add(ob, scale(pk.inward, 1.35));
    const plan = planShot(layout({ cue, ob }), { targetId: 'ob', pocketId: 'TR', stroke: { power: 1, side: 0, vert: 0 } }, P);
    expect(plan.obPocketed).toBe(false);
    // Its own warning ('cb-short', the release branch's code for it), naming the ball, not "stops short".
    const w = plan.warnings.find((x) => x.code === 'cb-short');
    expect(w?.message).toMatch(/cue ball stops before it reaches the ob\b/);
    expect(w?.message).not.toMatch(/stops short/);
    expect(plan.warnings.some((x) => x.code === 'too-soft')).toBe(false);
  });

  it('a blocked shot names the best other pocket in the warning and the tip (blocked-shot-no-alternative)', () => {
    const ob = v2(0.6, 0.25);
    const cue = v2(-0.3, 0);
    const w = pocketWindow(ob, pocketById(T, 'TR'), R);
    const blk = v2((ob.x + w.mouthHit.x) / 2, (ob.y + w.mouthHit.y) / 2);
    const plan = planShot(layout({ cue, ob, blk }), { targetId: 'ob', pocketId: 'TR' }, P);
    expect(plan.makeable).toBe(false);
    expect(plan.alternatives[0]?.pocketId).toBe('BR');
    const blocked = plan.warnings.find((x) => x.code === 'blocked-object')!;
    expect(blocked.message).toMatch(/Try the bottom-right corner/);
    expect(plan.tip).toMatch(/bottom-right corner/);
  });

  it('a fully boxed ball says no other pocket is clear', () => {
    const ob = v2(-0.4, 0.3);
    const g = 2 * R + 0.001;
    const lay = layout({ cue: v2(0.5, -0.2), ob, w1: v2(ob.x + g, ob.y), w2: v2(ob.x - g, ob.y), w3: v2(ob.x, ob.y + g), w4: v2(ob.x, ob.y - g) });
    const plan = planShot(lay, { targetId: 'ob' }, P);
    expect(plan.makeable).toBe(false);
    expect(plan.alternatives).toHaveLength(0);
    expect(plan.warnings.some((x) => /No other pocket is clear for this ball/.test(x.message))).toBe(true);
    expect(plan.tip).toMatch(/No other pocket is clear/);
  });

  it('side spin reports squirt and compensates aim', () => {
    const { lay } = cutLayout(v2(0.4, 0.15), 'TR', 25, 0.7);
    const plan = planShot(lay, { targetId: 'ob', pocketId: 'TR', stroke: { power: 4, side: 0.3, vert: 0.1 } }, P);
    expect(plan.squirtDeg).toBeGreaterThan(0.5);
    expect(plan.squirtDeg).toBeLessThan(3);
    expect(plan.obPocketed).toBe(true);
    // The drawn line (cue → ghost) is the cue ball's path: aimDir and the first simulated leg.
    const cue = lay.balls.find((b) => b.id === 'cue')!.pos;
    const toGhost = norm(sub(plan.ghost, cue));
    expect(Math.abs(deg(angleBetween(toGhost, plan.aimDir)))).toBeLessThan(1e-6);
    const leg = norm(sub(plan.cuePath.points[1]!, plan.cuePath.points[0]!));
    expect(Math.abs(deg(angleBetween(toGhost, leg)))).toBeLessThan(0.05);
  });

  it('aiming the cue along the drawn line with side spin misses: the squirt correction is not in the line', () => {
    for (const side of [0.3, -0.3]) {
      const { lay } = cutLayout(v2(0.4, 0.15), 'TR', -25, 1.2); // −25°: the cue ball stays on the table at 1.2 m
      const stroke = { power: 4, side, vert: 0 };
      const plan = planShot(lay, { targetId: 'ob', pocketId: 'TR', stroke }, P);
      expect(plan.obPocketed).toBe(true);
      // A cue aimed along the line shown sends the ball squirt° off it, away from the english side.
      const dir = rotate(plan.aimDir, Math.sign(side) * rad(Math.abs(plan.squirtDeg)));
      const st = strikeBall(dir, powerToSpeed(stroke.power), side, 0, R, P.squirtMassRatio);
      const sim = simulate(
        T,
        lay.balls.map((b) => (b.kind === 'cue' ? { id: b.id, pos: b.pos, vel: st.vel, omega: st.omega } : { id: b.id, pos: b.pos })),
        P,
        { record: false },
      );
      expect(sim.final['ob']!.pocket).not.toBe('TR');
    }
  });

  // The 22-ball planShot timing guard lives in perf.test.ts (median of 5 < 100 ms).
});
