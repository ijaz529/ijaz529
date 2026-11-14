/**
 * Position play (FR-020…FR-022, research.md R-11): search tip offset × speed by simulation for the
 * stroke that pockets the ball and leaves the cue ball best placed — on the player's chosen spot, or
 * (default) where the easiest next shot is. Finalists are re-simulated under the errors a real
 * player makes — ±12 % speed, ±0.05 R of tip placement, an aim error of 60 % of the shot's own
 * tolerance, and (with side) a shaft that squirts like a standard rather than the configured one —
 * and scored by their worst case, which favours forgiving strokes as a coach would.
 *
 * Side spin is a last resort, as coaches teach it: it costs 1.5·|side| (throw + squirt + miscue
 * risk), is never used on a near-straight shot without a landing spot, and a stroke with side must
 * beat the best centre-line stroke by SIDE_MIN_GAIN after the robustness check.
 */
import type { Ball, PhysicsParams, PocketId, Recommendation, ShotRequest, Stroke, StrokeRisk, TableLayout, Vec2 } from '../types';
import { deg } from '../vec';
import { planShot, shotGeometry } from './planner';
import { paceDiamonds, powerToSpeed, speedToPower } from './power';

const VERTS = [-0.4, -0.25, -0.1, 0.1, 0.25, 0.4];
const SIDES = [-0.2, 0, 0.2];
/** Cost per unit of side (fraction of R). ASSUMPTION: coaching heuristic, tuned so side is rare. */
export const SIDE_PENALTY = 1.5;
/** Objective a side-spin stroke must gain over the best centre-line stroke to be recommended. */
export const SIDE_MIN_GAIN = 0.4;
/** Below this cut (deg) and with no landing spot, side is never recommended. */
export const NO_SIDE_CUT_DEG = 5;
/** Tip placement error (fraction of R) and shaft mass ratio used by the robustness probes. ASSUMPTION. */
export const TIP_ERROR = 0.05;
export const PROBE_SQUIRT_MASS_RATIO = 23;
/** Speed error of the robustness probes (±12 % of the cue-ball speed, not of the power number). ASSUMPTION. */
export const SPEED_ERROR = 0.12;
/**
 * Pace: cost per diamond the object ball would roll past the pocket beyond PACE_FREE_DIAMONDS.
 * Nothing in the simulation rewards pocket speed (capture does not depend on speed there), but a
 * firm ball is a smaller target — the effective pocket shrinks as speed rises (Alciatore, TP 3.5–3.6)
 * — and speed control gets harder the harder you hit. ASSUMPTION: coaching heuristic, tuned so a
 * hanger is played at 2–3/10 and a 30° cut at 4/10 rather than 5–7/10.
 */
export const PACE_COST_PER_DIAMOND = 0.06;
export const PACE_FREE_DIAMONDS = 2;
/** Cost per metre the cue ball travels beyond the first metre (more travel, more to go wrong). ASSUMPTION. */
export const CB_TRAVEL_COST = 0.05;
/** Strokes whose robust score is within this of the best are compared on power: the softest wins. */
export const SOFTEST_WITHIN = 0.1;
/** A probe in which the cue ball scratches costs this much (a miss costs PROBE_FAIL). */
export const PROBE_SCRATCH = 6;
export const PROBE_FAIL = 3;

/** Map a CB aim tolerance (deg) to 0..1 (0.02° → 0, ≥1° → 1) on a log scale. */
export function toleranceQuality(tolDeg: number): number {
  if (tolDeg <= 0) return 0;
  const q = (Math.log10(tolDeg) - Math.log10(0.02)) / (0 - Math.log10(0.02));
  return Math.max(0, Math.min(1, q));
}

/** Quality (0..1) of the best next shot with the cue ball at `cuePos`. */
export function nextShotQuality(layout: TableLayout, cuePos: Vec2, excludeIds: string[], onlyBallId?: string): number {
  const cue: Ball = { id: '__cue', kind: 'cue', pos: cuePos };
  const others = layout.balls.filter((b) => b.kind !== 'cue' && !excludeIds.includes(b.id));
  const all = [cue, ...others];
  let best = 0;
  let any = false;
  for (const t of others) {
    if (onlyBallId && t.id !== onlyBallId) continue;
    any = true;
    for (const p of layout.table.pockets) {
      const g = shotGeometry(layout.table, all, cue, t, p);
      if (!g.makeable || g.blockersCue.length || g.blockersObject.length) continue;
      best = Math.max(best, toleranceQuality(deg(g.toleranceRad)));
    }
  }
  if (!any) {
    // Nothing left: prefer finishing near the middle of the table.
    const hx = layout.table.length / 2;
    const hy = layout.table.width / 2;
    return 1 - Math.min(1, Math.hypot(cuePos.x / hx, cuePos.y / hy));
  }
  return best;
}

export interface RecommendOptions {
  landing?: Vec2;
  budgetMs?: number;
}

interface Scored {
  stroke: Stroke;
  score: number;
  rest: Vec2 | null;
  restError: number;
}

export function recommendStroke(layout: TableLayout, request: ShotRequest, params: PhysicsParams, opts: RecommendOptions = {}): Recommendation {
  const t0 = performance.now();
  const budget = opts.budgetMs ?? 1500;
  const base = planShot(layout, { targetId: request.targetId, ...(request.pocketId ? { pocketId: request.pocketId } : {}) }, params, { record: false });
  const pocketId = base.pocketId;
  const cuePos = layout.balls.find((b) => b.kind === 'cue')!.pos;
  const landing = opts.landing ?? request.landing;
  let evaluated = 0;
  const lo = Math.max(1, Math.ceil(base.minPower));
  const powers: number[] = [];
  // The softest strokes in half steps (the analytic minimum is conservative: a stroke just under the
  // next whole number often pockets the ball at pocket speed), then whole numbers.
  const half = Math.max(1, Math.ceil(base.minPower * 2) / 2);
  for (const p of [half - 0.5, half]) if (p >= 1 && p < lo) powers.push(p);
  for (let p = lo; p <= 10; p++) powers.push(p);
  if (!powers.length || !base.makeable) return { stroke: base.stroke, score: -Infinity, reachable: false, evaluated: 0, rest: base.cueRest };

  type Outcome = Scored | { fail: 'scratch'; pocketId: PocketId } | { fail: 'miss' };
  const evaluate = (stroke: Stroke, probe: { aimErrorRad?: number; actualSquirtMassRatio?: number } = {}): Outcome => {
    evaluated++;
    const plan = planShot(layout, { targetId: request.targetId, pocketId, stroke }, params, { record: false, ...probe });
    if (plan.scratch) return { fail: 'scratch', pocketId: plan.cuePath.pocket ?? pocketId };
    if (!plan.obPocketed || !plan.cueRest) return { fail: 'miss' };
    const kiss = plan.warnings.some((w) => w.code === 'kiss');
    const rest = plan.cueRest;
    let objective: number;
    let restError = 0;
    if (landing) {
      restError = Math.hypot(rest.x - landing.x, rest.y - landing.y);
      objective = -restError / 0.15;
    } else {
      objective = 3 * nextShotQuality(layout, rest, [request.targetId]);
    }
    // Coach's bias: controllable speed, minimal spin. Hard strokes cost quadratically above 6, and
    // pace well past pocket speed costs per diamond (see PACE_COST_PER_DIAMOND).
    const pace = Math.min(40, paceDiamonds(plan.obPocketSpeed, layout.table.length, params));
    const travel = Math.hypot(rest.x - cuePos.x, rest.y - cuePos.y);
    const penalty =
      0.06 * stroke.power +
      0.1 * Math.max(0, stroke.power - 6) ** 2 +
      // On a spot the player chose, reaching it comes first: pace costs a quarter as much.
      (landing ? 0.25 : 1) * PACE_COST_PER_DIAMOND * Math.max(0, pace - PACE_FREE_DIAMONDS) +
      CB_TRAVEL_COST * Math.max(0, travel - 1) +
      SIDE_PENALTY * Math.abs(stroke.side) +
      0.3 * Math.abs(stroke.vert) +
      (kiss ? 1 : 0);
    return { stroke, score: objective - penalty, rest, restError };
  };
  const ok = (o: Outcome): o is Scored => !('fail' in o);

  const sides = !landing && base.cutAngleDeg < NO_SIDE_CUT_DEG ? [0] : SIDES;
  const results: Scored[] = [];
  outer: for (const power of powers)
    for (const vert of VERTS)
      for (const side of sides) {
        if (performance.now() - t0 > budget * 0.8) break outer;
        const r = evaluate({ power, side, vert });
        if (ok(r)) results.push(r);
      }
  if (!results.length) return { stroke: base.stroke, score: -Infinity, reachable: false, evaluated, rest: base.cueRest };
  results.sort((a, b) => b.score - a.score);

  // Robustness: the finalists' worst case under the errors a player really makes.
  // A typical miss inside the pocket window (60 % of the tolerance): the ball still drops, but where
  // does the cue ball go? Strokes whose position falls apart under it score lower.
  const aimErr = Math.max(1e-4, (0.6 * base.toleranceDeg * Math.PI) / 180);
  const risksOf = new Map<Scored, StrokeRisk[]>();
  const robustOf = (r: Scored): number => {
    let worst = r.score;
    const risks: StrokeRisk[] = [];
    const probes: { kind: StrokeRisk['scratchIf']; stroke: Stroke; probe?: { aimErrorRad?: number; actualSquirtMassRatio?: number } }[] = [];
    // Speed errors are a share of the cue-ball speed (±12 % of speed is ±22 % of the power number at 7).
    const v = powerToSpeed(r.stroke.power);
    for (const [kind, k] of [['softer', 1 - SPEED_ERROR], ['harder', 1 + SPEED_ERROR]] as const)
      probes.push({ kind, stroke: { ...r.stroke, power: Math.max(1, Math.min(10, speedToPower(v * k))) } });
    for (const dv of [-TIP_ERROR, TIP_ERROR]) probes.push({ kind: 'tip', stroke: { ...r.stroke, vert: r.stroke.vert + dv } });
    for (const e of [-aimErr, aimErr]) probes.push({ kind: 'aim', stroke: r.stroke, probe: { aimErrorRad: e } });
    if (r.stroke.side !== 0) probes.push({ kind: 'aim', stroke: r.stroke, probe: { actualSquirtMassRatio: PROBE_SQUIRT_MASS_RATIO } });
    for (const p of probes) {
      if (performance.now() - t0 > budget) break;
      const o = evaluate(p.stroke, p.probe);
      if (ok(o)) worst = Math.min(worst, o.score);
      else if (o.fail === 'scratch') {
        worst = Math.min(worst, r.score - PROBE_SCRATCH);
        if (!risks.some((x) => x.scratchIf === p.kind && x.pocketId === o.pocketId)) risks.push({ scratchIf: p.kind, pocketId: o.pocketId });
      } else worst = Math.min(worst, r.score - PROBE_FAIL);
    }
    risksOf.set(r, risks);
    return 0.5 * r.score + 0.5 * worst;
  };
  // Finalists: the best five overall, the best three on the centre line so side has a fair rival, and
  // the best stroke at each of the two softest powers so a gentler stroke gets its robustness check.
  const finalists = [...results.slice(0, 5)];
  const add = (r: Scored | undefined) => r && !finalists.includes(r) && finalists.push(r);
  for (const r of results.filter((x) => x.stroke.side === 0).slice(0, 3)) add(r);
  const softest = [...new Set(results.map((r) => r.stroke.power))].sort((a, b) => a - b).slice(0, 2);
  for (const p of softest) add(results.find((r) => r.stroke.power === p));
  const scored: { r: Scored; robust: number }[] = [];
  for (const r of finalists) {
    if (performance.now() - t0 > budget) break;
    scored.push({ r, robust: robustOf(r) });
  }
  if (!scored.length) scored.push({ r: results[0]!, robust: results[0]!.score });
  const top = (list: typeof scored) => list.reduce((a, b) => (b.robust > a.robust ? b : a));
  // Side only when it clearly pays.
  let pool = scored;
  const bestAll = top(scored);
  const centre = scored.filter((x) => x.r.stroke.side === 0);
  if (bestAll.r.stroke.side !== 0 && centre.length && bestAll.robust - top(centre).robust <= SIDE_MIN_GAIN) pool = centre;
  // Among strokes about as good as the best, the softest (a coach's "use the least speed that works").
  const bestRobust = top(pool).robust;
  const near = pool.filter((x) => x.robust >= bestRobust - SOFTEST_WITHIN);
  const pick = near.reduce((a, b) => (b.r.stroke.power < a.r.stroke.power || (b.r.stroke.power === a.r.stroke.power && b.robust > a.robust) ? b : a));
  const best = pick.r;
  const reachable = landing ? best.restError <= 0.15 : true;
  return { stroke: best.stroke, score: pick.robust, reachable, restError: best.restError, rest: best.rest, evaluated, risks: risksOf.get(best) ?? [] };
}

/** Next-shot quality over a grid of cue-ball positions (row-major, rows along +y from −W/2). */
export function positionHeatmap(layout: TableLayout, nextBallId: string, cols: number, rows: number, excludeIds: string[] = []): Float32Array {
  const out = new Float32Array(cols * rows);
  const R = layout.table.ballRadius;
  const hx = layout.table.length / 2 - R;
  const hy = layout.table.width / 2 - R;
  const blockers = layout.balls.filter((b) => b.kind !== 'cue' && b.id !== nextBallId && !excludeIds.includes(b.id));
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++) {
      const p = { x: -hx + ((i + 0.5) / cols) * 2 * hx, y: -hy + ((j + 0.5) / rows) * 2 * hy };
      if (blockers.some((b) => Math.hypot(b.pos.x - p.x, b.pos.y - p.y) < 2 * R)) continue;
      out[j * cols + i] = nextShotQuality(layout, p, [...excludeIds, ...layout.balls.filter((b) => b.kind === 'cue').map((b) => b.id)], nextBallId);
    }
  return out;
}
