import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PHYSICS } from '../../src/core/physics/params';
import { simulate } from '../../src/core/physics/simulate';
import { strikeBall } from '../../src/core/physics/strike';
import { planShot } from '../../src/core/shot/planner';
import { nextShotQuality, positionHeatmap, recommendStroke } from '../../src/core/shot/position';
import { POWER_SPEEDS, powerToSpeed } from '../../src/core/shot/power';
import { makeTable, pocketById } from '../../src/core/table';
import type { PocketId, ShotPlan, Stroke, TableLayout } from '../../src/core/types';
import { add, angleOf, fromAngle, rad, scale, sub, v2, type Vec2 } from '../../src/core/vec';
import { pocketWindow } from '../../src/core/shot/pocket-window';
import { layout } from '../helpers/layout';

const P = DEFAULT_PHYSICS;
const T = makeTable('pool9');

/** The table as it is after `plan`: target and pocketed balls removed, moved balls at rest. */
function postShot(lay: TableLayout, plan: ShotPlan): TableLayout {
  const balls = lay.balls.flatMap((b) => {
    if (b.kind === 'cue' || b.id === plan.targetId) return [];
    const tr = plan.otherPaths.find((t) => t.ballId === b.id);
    if (!tr) return [b];
    if (tr.pocket || !tr.rest) return [];
    return [{ ...b, pos: tr.rest }];
  });
  return { ...lay, balls };
}
const postQuality = (lay: TableLayout, plan: ShotPlan) => (plan.cueRest ? nextShotQuality(postShot(lay, plan), plan.cueRest, [plan.targetId]) : 0);

/**
 * Mis-hit the planned stroke by ±6 % and ±12 % cue-ball speed: the same cue line (the plan's aimDir)
 * at the true speed, no re-aim. None of them may scratch or miss. Overhits past full power
 * (7 m/s) can't be played and are skipped; underhits below power 1 are simulated at their real
 * speed (speedToPower would clamp them to power 1 and hide a miss).
 */
function expectSpeedRobust(lay: TableLayout, targetId: string, pocketId: PocketId, stroke: Stroke) {
  const plan = planShot(lay, { targetId, pocketId, stroke }, P, { record: false });
  const R = lay.table.ballRadius;
  for (const k of [0.88, 0.94, 1.06, 1.12]) {
    const v = powerToSpeed(stroke.power) * k;
    if (v > POWER_SPEEDS[POWER_SPEEDS.length - 1]! + 1e-9) continue;
    const st = strikeBall(plan.aimDir, v, stroke.side, stroke.vert, R, P.squirtMassRatio);
    const init = lay.balls.map((b) => (b.kind === 'cue' ? { id: b.id, pos: b.pos, vel: st.vel, omega: st.omega } : { id: b.id, pos: b.pos }));
    const sim = simulate(lay.table, init, P, { record: false });
    const cueId = lay.balls.find((b) => b.kind === 'cue')!.id;
    expect(sim.final[cueId]!.pocket, `×${k} speed scratches (${JSON.stringify(stroke)})`).toBeNull();
    expect(sim.final[targetId]!.pocket, `×${k} speed misses (${JSON.stringify(stroke)})`).toBe(pocketId);
  }
}

describe('position play', () => {
  const tr = pocketById(T, 'TR');
  const ob = add(tr.mouthCenter, scale(tr.inward, 0.5));
  const cue = add(tr.mouthCenter, scale(tr.inward, 1.0));

  afterEach(() => vi.restoreAllMocks());

  it('lands near a spot reachable with draw, using below-centre spin', () => {
    // Straight-in: a spot back toward the shooter needs draw.
    const landing = add(tr.mouthCenter, scale(tr.inward, 0.85));
    const lay = layout({ cue, ob });
    const rec = recommendStroke(lay, { targetId: 'ob', pocketId: 'TR' }, P, { landing });
    expect(rec.reachable).toBe(true);
    expect(rec.stroke.vert).toBeLessThan(0);
    expect(rec.restError!).toBeLessThan(0.15);
    console.log(`draw-to-spot: stroke ${JSON.stringify(rec.stroke)}, error ${(rec.restError! * 100).toFixed(1)} cm, ${rec.evaluated} sims`);
  });

  it('reports an unreachable spot honestly and still returns a safe stroke', () => {
    const lay = layout({ cue, ob });
    const rec = recommendStroke(lay, { targetId: 'ob', pocketId: 'TR' }, P, { landing: v2(-1.2, 0.6) });
    expect(rec.reachable).toBe(false);
    expect(Number.isFinite(rec.score)).toBe(true);
    const plan = planShot(lay, { targetId: 'ob', pocketId: 'TR', stroke: rec.stroke }, P);
    expect(plan.scratch).toBe(false);
    expect(plan.obPocketed).toBe(true);
    expectSpeedRobust(lay, 'ob', 'TR', rec.stroke);
  });

  it('the recommended stroke survives ±6/±12 % speed (robustness-allows-scratch-prone-strokes)', () => {
    const lay = layout({ cue: v2(-0.5, -0.1), ob: v2(-0.1, 0.35) });
    const rec = recommendStroke(lay, { targetId: 'ob', pocketId: 'TM' }, P, { landing: v2(-0.7, -0.1) });
    expect(Number.isFinite(rec.score)).toBe(true);
    expect(rec.fragile).not.toBe(true);
    expectSpeedRobust(lay, 'ob', 'TM', rec.stroke);
  });

  it('default recommendation leaves a better next shot than centre ball (scored on the post-shot table)', () => {
    const lay = layout({ cue, ob, next: v2(-0.6, -0.35) });
    const rec = recommendStroke(lay, { targetId: 'ob', pocketId: 'TR' }, P);
    const plain = planShot(lay, { targetId: 'ob', pocketId: 'TR' }, P);
    const recPlan = planShot(lay, { targetId: 'ob', pocketId: 'TR', stroke: rec.stroke }, P);
    expect(postQuality(lay, recPlan)).toBeGreaterThan(postQuality(lay, plain));
    expect(recPlan.scratch).toBe(false);
    expect(rec.reachable).toBe(true);
    expect(Number.isFinite(rec.score)).toBe(true);
    expect(rec.nextQuality!).toBeCloseTo(postQuality(lay, recPlan), 9);
  });

  it('scores the next shot on the table as it will be after the shot (next-shot-scored-on-stale-layout)', () => {
    const pos: Record<string, Vec2> = {
      cue: v2(1.162, -0.549),
      ob: v2(-0.206, -0.143),
      a: v2(-0.802, 0.467),
      b: v2(-0.501, 0.533),
      c: v2(0.532, 0.576),
      d: v2(0.693, -0.039),
      e: v2(0.414, 0.464),
    };
    const lay = layout(pos);
    const rec = recommendStroke(lay, { targetId: 'd', pocketId: 'TM' }, P);
    const plan = planShot(lay, { targetId: 'd', pocketId: 'TM', stroke: rec.stroke }, P, { record: false });
    expect(plan.obPocketed).toBe(true);
    const hitsE = plan.cuePath.events.some((ev) => ev.kind === 'ball' && ev.otherId === 'e');
    const q = postQuality(lay, plan);
    expect(!hitsE || Math.abs(rec.nextQuality! - q) <= 0.05).toBe(true);
    expect(rec.nextQuality!).toBeCloseTo(q, 9);
  });

  it('spots that some stroke reaches are reported reachable (reachable-flag-false-negatives)', () => {
    const lay = layout({ cue, ob });
    const rec = recommendStroke(lay, { targetId: 'ob', pocketId: 'TR' }, P, { landing: v2(0.51, -0.1) });
    expect(rec.reachable).toBe(true);
    expect(rec.restError!).toBeLessThanOrEqual(0.15);
    // A spot on the bottom rail that only speed-sensitive strokes reach, while strokes that end
    // elsewhere survive ±6/±12 %: it is reachable (flagged fragile), not traded for a robust stroke
    // that stops half a metre away.
    const rail = recommendStroke(lay, { targetId: 'ob', pocketId: 'TR' }, P, { landing: v2(0, -0.6) });
    console.log(`rail spot: reachable ${rail.reachable}, error ${(rail.restError! * 100).toFixed(1)} cm, fragile ${rail.fragile ?? false}`);
    expect(rail.reachable).toBe(true);
    expect(rail.restError!).toBeLessThanOrEqual(0.15);
    // reachable ⇔ some searched stroke pots without scratching and stops within 15 cm of the spot.
    // (The reviewer's layout below had such a grid stroke before the cushion-model rebase; with the
    // current physics the nearest grid stroke stops 19 cm away, so the invariant is what is checked.)
    const lay2 = layout({ cue: v2(-0.2, -0.3), ob: v2(0.7, 0.2), x1: v2(0.2, 0.4), x2: v2(-0.6, 0.1) });
    const lo = Math.max(1, Math.floor(planShot(lay2, { targetId: 'ob', pocketId: 'TR' }, P, { record: false }).minPowerCapture!));
    const outcomes: boolean[] = [];
    for (const spot of [v2(-0.1, 0.1), v2(0.95, 0.2), v2(0.2, -0.3)]) {
      const rec2 = recommendStroke(lay2, { targetId: 'ob', pocketId: 'TR' }, P, { landing: spot });
      let nearest = Infinity;
      for (let power = lo; power <= 10; power++)
        for (const vert of [-0.4, -0.25, -0.1, 0.1, 0.25, 0.4])
          for (const side of [-0.2, 0, 0.2]) {
            const p = planShot(lay2, { targetId: 'ob', pocketId: 'TR', stroke: { power, side, vert } }, P, { record: false });
            if (p.obPocketed && !p.scratch && p.cueRest) nearest = Math.min(nearest, Math.hypot(p.cueRest.x - spot.x, p.cueRest.y - spot.y));
          }
      expect(rec2.reachable, `spot (${spot.x}, ${spot.y}), nearest grid stroke ${(nearest * 100).toFixed(1)} cm`).toBe(nearest <= 0.15);
      if (rec2.reachable) expect(rec2.restError!).toBeLessThanOrEqual(0.15);
      outcomes.push(rec2.reachable);
    }
    expect(outcomes).toContain(true);
    expect(outcomes).toContain(false);
  });

  it('is deterministic: a slow clock does not change the result (wall-clock-budget-in-core)', () => {
    const lay = layout({ cue, ob, next: v2(-0.6, -0.35) });
    const req = { targetId: 'ob', pocketId: 'TR' as const };
    const a = recommendStroke(lay, req, P);
    // A very slow device: every clock read is 50 ms later than the last (an old 1.5 s wall-clock
    // budget would stop after a few dozen strokes).
    let fake = 0;
    const now = vi.spyOn(performance, 'now').mockImplementation(() => (fake += 50));
    const b = recommendStroke(lay, req, P);
    expect(now).not.toHaveBeenCalled(); // the core never reads the clock unless a time cap is set
    vi.restoreAllMocks();
    expect(b).toEqual(a);
    expect(a.timedOut).toBeUndefined();
    // The optional safety net is honoured and reported, never silent.
    fake = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => (fake += 50));
    const c = recommendStroke(lay, req, P, { timeCapMs: 1000 });
    vi.restoreAllMocks();
    expect(c.timedOut).toBe(true);
    expect(c.evaluated).toBeLessThan(a.evaluated);
  });

  it('a time cap that fires during the robustness pass is reported (timedOut set at return)', () => {
    const lay = layout({ cue, ob, next: v2(-0.6, -0.35) });
    const base = planShot(lay, { targetId: 'ob', pocketId: 'TR' }, P, { record: false });
    const lo = Math.max(1, Math.floor(base.minPowerCapture!));
    const grid = (10 - lo + 1) * 18;
    // The clock stands still through the grid (t0 + one read per grid stroke), then jumps.
    let reads = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => (reads++ <= grid ? 0 : 1e9));
    const rec = recommendStroke(lay, { targetId: 'ob', pocketId: 'TR' }, P, { timeCapMs: 1000 });
    vi.restoreAllMocks();
    expect(rec.evaluated).toBe(grid);
    expect(rec.timedOut).toBe(true);
    expect(rec.fragile).toBe(true);
  });

  it('underhits of a power-1 stroke are tested at their real speed (power scale clamps at 1)', () => {
    // Reviewer layouts: the old walk re-ran 0.88×/0.94× of power 1 as power 1 itself and returned a
    // non-fragile {power 1, vert 0.4} that misses at a real 6–12 % underhit.
    for (const pos of [
      { cue: v2(0.6508, -0.1747), ob: v2(0.3899, 0.1145), nx: v2(0.2602, -0.0044) },
      { cue: v2(-0.7539, -0.4844), ob: v2(-0.0863, 0.4592), nx: v2(-0.2366, 0.0133) },
    ]) {
      const lay = layout(pos);
      const pocketId = planShot(lay, { targetId: 'ob' }, P, { record: false }).pocketId;
      const rec = recommendStroke(lay, { targetId: 'ob', pocketId }, P);
      expect(Number.isFinite(rec.score)).toBe(true);
      if (rec.fragile !== true) expectSpeedRobust(lay, 'ob', pocketId, rec.stroke);
    }
  });

  it('the search starts at the bare capture minimum, below the "with pace" minimum', () => {
    const lay = layout({ cue, ob, next: v2(-0.6, -0.35) });
    const base = planShot(lay, { targetId: 'ob', pocketId: 'TR' }, P, { record: false });
    expect(base.minPowerCapture!).toBeLessThan(base.minPower);
    const seen = new Set<number>();
    recommendStroke(lay, { targetId: 'ob', pocketId: 'TR' }, P, { onEvaluate: (s) => seen.add(s.power) });
    expect(Math.min(...seen)).toBe(Math.max(1, Math.floor(base.minPowerCapture!)));
    expect(Math.min(...seen)).toBeLessThan(Math.ceil(base.minPower));
  });

  it('a small evaluation budget still covers every power (coarse-to-fine order)', () => {
    const lay = layout({ cue, ob, next: v2(-0.6, -0.35) });
    const base = planShot(lay, { targetId: 'ob', pocketId: 'TR' }, P, { record: false });
    const lo = Math.max(1, Math.floor(base.minPowerCapture!));
    const seen = new Set<number>();
    const rec = recommendStroke(lay, { targetId: 'ob', pocketId: 'TR' }, P, { maxEvaluations: 60, onEvaluate: (s) => seen.add(s.power) });
    expect(rec.evaluated).toBeLessThanOrEqual(60);
    for (let p = lo; p <= 10; p++) expect(seen.has(p), `power ${p} evaluated`).toBe(true);
  });

  it('with no budget left for the robustness pass, the best grid stroke comes back with a finite score (robust-loop-skip)', () => {
    const lay = layout({ cue, ob, next: v2(-0.6, -0.35) });
    const base = planShot(lay, { targetId: 'ob', pocketId: 'TR' }, P, { record: false });
    const lo = Math.max(1, Math.floor(base.minPowerCapture!));
    const grid = (10 - lo + 1) * 18;
    let best: { stroke: Stroke; score: number } | null = null;
    const rec = recommendStroke(lay, { targetId: 'ob', pocketId: 'TR' }, P, {
      maxEvaluations: grid,
      onEvaluate: (stroke, score) => {
        if (score !== null && (!best || score > best.score)) best = { stroke, score };
      },
    });
    expect(Number.isFinite(rec.score)).toBe(true);
    expect(best).not.toBeNull();
    expect(rec.stroke).toEqual(best!.stroke);
    expect(rec.fragile).toBe(true); // not checked against speed errors: say so
  });

  it('a hanger: the recommended stroke is never "stops short"', () => {
    const pk = pocketById(T, 'TR');
    const hob = add(pk.mouthCenter, scale(pk.inward, 0.08));
    const w = pocketWindow(hob, pk, T.ballRadius);
    const ghost = sub(hob, scale(w.dir, 2 * T.ballRadius));
    const hcue = sub(ghost, scale(fromAngle(angleOf(w.dir) + rad(40)), 0.25));
    const lay = layout({ cue: hcue, ob: hob });
    const rec = recommendStroke(lay, { targetId: 'ob', pocketId: 'TR' }, P);
    const plan = planShot(lay, { targetId: 'ob', pocketId: 'TR', stroke: rec.stroke }, P);
    expect(plan.warnings.some((x) => /stops short/.test(x.message))).toBe(false);
    expect(plan.obPocketed).toBe(true);
  });

  it('heatmap is 0..1, oriented row-major from −y, and highest in line with the next ball and a pocket', () => {
    const lay = layout({ cue, ob, next: v2(0.6, 0.3) });
    const cols = 40;
    const rows = 20;
    const hm = positionHeatmap(lay, 'next', cols, rows, ['ob']);
    expect(Math.max(...hm)).toBeLessThanOrEqual(1);
    expect(Math.min(...hm)).toBeGreaterThanOrEqual(0);
    // A spot straight behind 'next' on the line to TR beats a spot beyond it.
    const toTR = add(v2(0.6, 0.3), scale({ x: tr.mouthCenter.x - 0.6, y: tr.mouthCenter.y - 0.3 }, -0.6));
    const beyond = v2(1.05, 0.55);
    const at = (p: { x: number; y: number }) => {
      const hx = T.length / 2 - T.ballRadius;
      const hy = T.width / 2 - T.ballRadius;
      const i = Math.min(cols - 1, Math.floor(((p.x + hx) / (2 * hx)) * cols));
      const j = Math.min(rows - 1, Math.floor(((p.y + hy) / (2 * hy)) * rows));
      return hm[j * cols + i]!;
    };
    expect(at(toTR)).toBeGreaterThan(at(beyond));
    // The cell holding the next ball is 0 (the cue ball can't be there); its mirrors are not.
    expect(hm[14 * cols + 29]).toBe(0);
    expect(hm[5 * cols + 29]!).toBeGreaterThan(0);
    expect(hm[14 * cols + 10]!).toBeGreaterThan(0);
    // Orientation: behind the ball on the TR line beats the y-mirrored spot.
    expect(at(toTR)).toBeGreaterThan(at({ x: toTR.x, y: -toTR.y }));
  });

  it('heatmap for the cue ball or the current target is all zeros, not a fake centre map', () => {
    const lay = layout({ cue, ob, next: v2(0.6, 0.3) });
    for (const id of ['cue', 'ob']) {
      const hm = positionHeatmap(lay, id, 48, 24, ['ob']);
      expect(Math.max(...hm), id).toBe(0);
    }
    const real = positionHeatmap(lay, 'next', 48, 24, ['ob']);
    expect(Math.max(...real)).toBeGreaterThan(0);
  });
});
