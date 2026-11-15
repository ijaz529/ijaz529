/**
 * Wave-1 × feature-002 merge coherence: the recommender keeps the ±6/±12 % speed check on the
 * evaluation budgets a device gets (planner.worker: 1200 ms / per-evaluation ms, so ≈150–230 on a
 * phone), never recommends a stroke its own plan calls too soft while a firmer one works, and the
 * power advice quotes one figure that, played, never brings the warning back.
 */
import { describe, expect, it } from 'vitest';
import { DRILLS } from '../../src/app/drills';
import { DEFAULT_PHYSICS } from '../../src/core/physics/params';
import { simulate } from '../../src/core/physics/simulate';
import { strikeBall } from '../../src/core/physics/strike';
import { coachingTip, throwSentence } from '../../src/core/shot/coach';
import { planShot } from '../../src/core/shot/planner';
import { recommendStroke } from '../../src/core/shot/position';
import { advisePower, paceDiamonds, POWER_SPEEDS, powerFigure, powerToSpeed } from '../../src/core/shot/power';
import { makeTable } from '../../src/core/table';
import type { Ball, PocketId, ShotPlan, ShotRequest, Stroke, TableLayout } from '../../src/core/types';

const P = DEFAULT_PHYSICS;
const T = makeTable('pool9');
const R = T.ballRadius;
const drill = (id: string): TableLayout => ({ table: T, balls: DRILLS.find((d) => d.id === id)!.build(T), source: 'virtual', frozen: false });
const DRILL_SHOTS: [string, ShotRequest][] = [
  ['scratch', { targetId: 'b7' }],
  ['cut30', { targetId: 'b1', pocketId: 'TR' }],
  ['straight', { targetId: 'b1', pocketId: 'TR' }],
  ['rail', { targetId: 'b9' }],
];
/** position.ts ROBUST_FINALISTS: wave-1's walk speed-checked this many strokes after the grid. */
const FINALISTS = 5;
const softWarning = (p: ShotPlan) => p.warnings.find((w) => w.code === 'too-soft' || w.code === 'cb-short');

/** Why the stroke fails a ±6/±12 % speed mis-hit on its own cue line (null: it survives them all). */
function speedFailure(lay: TableLayout, targetId: string, pocketId: PocketId, stroke: Stroke): string | null {
  const plan = planShot(lay, { targetId, pocketId, stroke }, P, { record: false });
  const cueId = lay.balls.find((b) => b.kind === 'cue')!.id;
  for (const k of [0.88, 0.94, 1.06, 1.12]) {
    const v = powerToSpeed(stroke.power) * k;
    if (v > POWER_SPEEDS[POWER_SPEEDS.length - 1]! + 1e-9) continue; // past full power: can't be played
    const st = strikeBall(plan.aimDir, v, stroke.side, stroke.vert, R, P.squirtMassRatio);
    const init = lay.balls.map((b) => (b.id === cueId ? { id: b.id, pos: b.pos, vel: st.vel, omega: st.omega } : { id: b.id, pos: b.pos }));
    const sim = simulate(lay.table, init, P, { record: false });
    if (sim.final[cueId]!.pocket !== null) return `×${k} scratches`;
    if (sim.final[targetId]!.pocket !== pocketId) return `×${k} misses`;
  }
  return null;
}

/** The whole grid the search runs before any robustness check: powers lo..10 × 18 strokes. */
function gridSize(lay: TableLayout, req: ShotRequest): number {
  const base = planShot(lay, req, P, { record: false });
  return (10 - Math.max(1, Math.floor(base.minPowerCapture ?? base.minPower)) + 1) * 18;
}

/** Seeded random pool9 layouts of `n` balls with a makeable shot on b1 (cut ≤ 60°). */
function randomShots(seed: number, count: number, nBalls: number, maxCutDeg = 60): { lay: TableLayout; req: ShotRequest }[] {
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const out: { lay: TableLayout; req: ShotRequest }[] = [];
  for (let k = 0; k < 600 && out.length < count; k++) {
    const p = () => ({ x: (rnd() * 2 - 1) * (T.length / 2 - 0.06), y: (rnd() * 2 - 1) * (T.width / 2 - 0.06) });
    const balls: Ball[] = [{ id: 'cue', kind: 'cue', pos: p(), label: 'cue' }];
    for (let i = 1; i < nBalls; i++) balls.push({ id: `b${i}`, kind: 'object', pos: p(), label: String(i) });
    if (balls.some((a, i) => balls.some((b, j) => i < j && Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y) < 0.15))) continue;
    const lay: TableLayout = { table: T, balls, source: 'virtual', frozen: false };
    const base = planShot(lay, { targetId: 'b1' }, P, { record: false });
    if (!base.makeable || base.cutAngleDeg > maxCutDeg) continue;
    out.push({ lay, req: { targetId: 'b1', pocketId: base.pocketId } });
  }
  return out;
}

describe('recommender on device-sized evaluation budgets (robustness-at-device-budgets)', () => {
  it('the drills at 200 and at grid + 4 × 5 (the wave-1-sized budget): speed-checked, never fragile', () => {
    for (const [id, req] of DRILL_SHOTS) {
      const lay = drill(id);
      const pocketId = planShot(lay, req, P, { record: false }).pocketId;
      for (const budget of [200, gridSize(lay, req) + 4 * FINALISTS]) {
        const rec = recommendStroke(lay, req, P, { maxEvaluations: budget });
        const where = `${id} @ ${budget}: ${JSON.stringify(rec.stroke)}`;
        expect(rec.evaluated, where).toBeLessThanOrEqual(budget);
        expect(rec.fragile, where).not.toBe(true);
        expect(speedFailure(lay, req.targetId, pocketId, rec.stroke), where).toBeNull();
        const plan = planShot(lay, { targetId: req.targetId, pocketId }, P, { recommended: rec.stroke, record: false });
        expect(plan.obPocketed && !plan.scratch, where).toBe(true);
        expect(softWarning(plan), where).toBeUndefined();
        if (id === 'rail') {
          // Polish's pace rule holds on a device budget too: no side, at most 3 diamonds past pocket speed.
          expect(rec.stroke.side, where).toBe(0);
          expect(paceDiamonds(plan.obPocketSpeed, T.length, P), where).toBeLessThanOrEqual(3);
        }
      }
    }
  }, 120_000);

  it('16 seeded random layouts at 200 and at grid + 4 × 5: never fragile, every pick survives ±6/±12 % speed', () => {
    const shots = randomShots(11, 16, 4);
    expect(shots.length).toBe(16);
    for (const [i, { lay, req }] of shots.entries()) {
      for (const budget of [200, gridSize(lay, req) + 4 * FINALISTS]) {
        const rec = recommendStroke(lay, req, P, { maxEvaluations: budget });
        const where = `layout ${i} @ ${budget}: ${JSON.stringify(rec.stroke)}`;
        expect(rec.fragile, where).not.toBe(true);
        expect(speedFailure(lay, req.targetId, req.pocketId!, rec.stroke), where).toBeNull();
      }
    }
  }, 120_000);

  it('room for the speed check but not the tip/aim probes: checked, not fragile, and its risks are "not known"', () => {
    const lay = drill('straight');
    const req: ShotRequest = { targetId: 'b1', pocketId: 'TR' };
    const budget = gridSize(lay, req) + 4;
    const rec = recommendStroke(lay, req, P, { maxEvaluations: budget });
    expect(rec.evaluated).toBe(budget); // the grid, then one stroke's four speed variants
    expect(rec.fragile).not.toBe(true);
    expect(speedFailure(lay, 'b1', 'TR', rec.stroke)).toBeNull();
    expect(rec.risks).toBeUndefined(); // its tip/aim probes never ran: absent, never a claimed-safe []
    // With the default budget every check runs, and the list says what they saw.
    expect(Array.isArray(recommendStroke(lay, req, P).risks)).toBe(true);
  });
});

describe('a recommended stroke is never one its own plan calls too soft (rec-soft)', () => {
  it('the drills and 16 seeded random 4-ball layouts: the recommended plan has no too-soft / cb-short warning', () => {
    const shots = [...DRILL_SHOTS.map(([id, req]) => ({ lay: drill(id), req })), ...randomShots(4242, 16, 4, 90)];
    let below = 0;
    for (const [i, { lay, req }] of shots.entries()) {
      const rec = recommendStroke(lay, req, P);
      expect(Number.isFinite(rec.score), `shot ${i}`).toBe(true);
      const pocketId = planShot(lay, req, P, { record: false }).pocketId;
      const plan = planShot(lay, { targetId: req.targetId, pocketId }, P, { recommended: rec.stroke, record: false });
      const where = `shot ${i}: ${JSON.stringify(rec.stroke)}, minPower ${plan.minPower.toFixed(2)}`;
      expect(plan.obPocketed, where).toBe(true);
      expect(softWarning(plan)?.message, where).toBeUndefined();
      // The card's badge says "recommended for position": the stroke must arrive with pace.
      if (rec.stroke.power < plan.minPower - 1e-6) below++;
    }
    expect(below).toBe(0);
  }, 120_000);
});

describe('power advice: one figure, and played at it nothing says too soft (advice-figure)', () => {
  it('cb-short / too-soft quote minPower rounded up to a settable half step; replanned at it, no warning returns', () => {
    let seed = 777;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    let n = 0;
    const seen = { 'cb-short': 0, 'too-soft': 0 };
    for (let k = 0; k < 2000 && n < 150; k++) {
      const p = () => ({ x: (rnd() * 2 - 1) * (T.length / 2 - 0.05), y: (rnd() * 2 - 1) * (T.width / 2 - 0.05) });
      const balls: Ball[] = [
        { id: 'cue', kind: 'cue', pos: p(), label: 'cue' },
        { id: 'b1', kind: 'object', pos: p(), label: '1' },
      ];
      if (Math.hypot(balls[0]!.pos.x - balls[1]!.pos.x, balls[0]!.pos.y - balls[1]!.pos.y) < 0.3) continue;
      const lay: TableLayout = { table: T, balls, source: 'virtual', frozen: false };
      const vert = [-0.4, -0.25, 0][k % 3]!;
      const plan = planShot(lay, { targetId: 'b1', stroke: { power: 1, side: 0, vert } }, P, { record: false });
      if (!plan.makeable) continue;
      n++;
      const w = softWarning(plan);
      const m = w && /[Pp]ower ([\d.]+)\+/.exec(w.message);
      if (!w || !m) continue;
      seen[w.code as 'cb-short' | 'too-soft']++;
      const where = `${JSON.stringify(balls.map((b) => b.pos))} vert ${vert}, minPower ${plan.minPower}: ${w.message}`;
      const advised = Number(m[1]);
      expect(advised, where).toBe(advisePower(plan.minPower));
      expect(advised, where).toBeGreaterThanOrEqual(plan.minPower - 1e-6);
      expect(Number.isInteger(advised * 2), where).toBe(true); // a value the half-step power control can set
      expect(advised, where).toBe(Math.ceil(plan.minPower * 2) / 2); // the figure the app's 3D label shows
      // The coaching tip of a cue ball that never arrives quotes the same figure, and names the ball.
      if (w.code === 'cb-short') expect(plan.tip, where).toMatch(new RegExp(`reaches the 1\\. Use power ${powerFigure(advised).replace('.', '\\.')}\\+`));
      const again = planShot(lay, { targetId: 'b1', pocketId: plan.pocketId, stroke: { power: advised, side: 0, vert } }, P, { record: false });
      expect(softWarning(again)?.message, where).toBeUndefined();
      expect([...again.warnings.map((x) => x.message), again.tip].some((s) => /stops (short|before)|Power [\d.]+\+/.test(s)), where).toBe(false);
    }
    expect(n).toBe(150);
    // Not vacuous: both kinds of advice were checked.
    expect(seen['cb-short']).toBeGreaterThan(20);
    expect(seen['too-soft']).toBeGreaterThan(5);
  });

  it('advisePower: rounds up to the half step, at least 1, never below the minimum; > 10 is passed through', () => {
    expect(advisePower(3.841)).toBe(4);
    expect(advisePower(3.5)).toBe(3.5);
    expect(advisePower(3.5000004)).toBe(3.5); // within the planner's own 1e-6 check
    expect(advisePower(3.51)).toBe(4);
    expect(advisePower(0.4)).toBe(1);
    expect(advisePower(9.9)).toBe(10);
    expect(advisePower(10.5)).toBe(10.5);
    expect(powerFigure(4)).toBe('4');
    expect(powerFigure(4.5)).toBe('4.5');
    expect(powerFigure(3.4)).toBe('3.4');
  });
});

describe('coaching words (merge review)', () => {
  const base = { cutDeg: 30, contact: 'short' as const, throwDeg: 0, throwShiftMm: 0, squirtDeg: 0, side: 0, scratch: false, blocked: false, makeable: true, cbReachesOb: false };
  it('a cue ball that never arrives: the tip names the ball, as the cb-short warning does', () => {
    expect(coachingTip({ ...base, minPower: 4, targetLabel: '1' })).toMatch(/^Too soft: the cue ball stops before it reaches the 1\. Use power 4\+/);
    expect(coachingTip({ ...base, minPower: 10.5, targetLabel: 'yellow' })).toBe('Too far: the cue ball stops before it reaches the yellow, even at full power.');
    expect(coachingTip({ ...base, minPower: 4 })).toMatch(/reaches the object ball\. Use power 4\+/); // no label: generic
  });
  it("a centre-ball stroke's throw on a full hit is not called side-spin throw", () => {
    const t = { throwDeg: 1.2, throwShiftMm: 0.6, throwAim: 'right' as const };
    expect(throwSentence({ ...t, side: 0 })).toBe('Throw: the ghost ball is shifted 0.6 mm to the right of full ball.');
    expect(throwSentence({ ...t, side: 0.3 })).toBe('Side-spin throw: the ghost ball is shifted 0.6 mm to the right of full ball.');
  });
  it('no stroke name for a cue ball that never reaches the object ball, makeable or not', () => {
    // Wrong side for every pocket tried, and power 1 from 2.1 m away: the cue ball stops on the way.
    const balls: Ball[] = [
      { id: 'cue', kind: 'cue', pos: { x: -1.1, y: 0 }, label: 'cue' },
      { id: 'ob', kind: 'object', pos: { x: 1.0, y: 0.3 }, label: 'ob' },
    ];
    const lay: TableLayout = { table: T, balls, source: 'virtual', frozen: false };
    for (const pocketId of ['BL', 'TL', 'BM'] as const) {
      const plan = planShot(lay, { targetId: 'ob', pocketId, stroke: { power: 1, side: 0, vert: 0 } }, P);
      expect(plan.makeable, pocketId).toBe(false);
      expect(plan.cuePath.events.some((e) => e.kind === 'ball'), pocketId).toBe(false);
      expect(plan.strokeName, pocketId).toBeNull();
    }
  });
});
