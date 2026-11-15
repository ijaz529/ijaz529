/**
 * Position play (FR-020…FR-022, research.md R-11): search tip offset × speed by simulation for the
 * stroke that pockets the ball and leaves the cue ball best placed — on the player's chosen spot, or
 * (default) where the easiest next shot is, judged on the table as it will be after the shot (balls
 * the shot moves at their rest spots, pocketed ones gone).
 *
 * Candidates are first checked against the speed errors every player makes: the same cue line
 * mis-hit at ±6 %/±12 % of its true speed (no re-aim; underhits below power 1 are simulated at their
 * real speed, not clamped to the power scale). Any scratch or miss at those speeds disqualifies, and
 * the robust score is the worst of the nominal and those outcomes. Overhits past full power can't be
 * played, so they aren't tested; a stroke that would need them is used only when no fully tested
 * one survives. Survivors are then mis-hit the other ways a player does — ±0.05 R of tip height, an
 * aim error of 60 % of the shot's own tolerance, and (with side) a shaft that squirts like a
 * standard one rather than the configured one — and half of the worst of those outcomes counts too
 * (a scratch costs PROBE_SCRATCH, a miss PROBE_FAIL). Every cue-ball scratch seen is reported in
 * Recommendation.risks.
 *
 * Coaching rules on top of the score: side spin is a last resort, as coaches teach it — it costs
 * SIDE_PENALTY·|side|, is not used on a near-straight shot without a landing spot while any
 * centre-line stroke works, and must beat the best centre-line stroke by SIDE_MIN_GAIN after the
 * robustness checks; pace well past pocket speed costs per diamond; and among strokes about as good
 * as the best (SOFTEST_WITHIN), the softest wins.
 *
 * Deterministic (Constitution III): the search is budgeted by evaluation count, coarse to fine, so a
 * smaller budget thins every power evenly instead of dropping the hard ones. The core never reads
 * the clock unless the caller sets the optional `timeCapMs` safety net, and the result reports when
 * that cap cut the search short.
 */
import { simulate } from '../physics/simulate';
import { strikeBall } from '../physics/strike';
import type { Ball, PhysicsParams, PocketId, Recommendation, ShotPlan, ShotRequest, Stroke, StrokeRisk, TableLayout, Trajectory, Vec2 } from '../types';
import { deg, fromAngle, angleOf } from '../vec';
import { planShot, shotGeometry } from './planner';
import { paceDiamonds, POWER_SPEEDS, powerToSpeed } from './power';

const VERTS = [-0.4, -0.25, -0.1, 0.1, 0.25, 0.4];
const SIDES = [-0.2, 0, 0.2];
/** First pass: centre ball at three heights for every power, so a small budget still spans speed. */
const COARSE_VERTS = [-0.4, 0.1, 0.4];
/** Cue-ball speed errors a stroke must survive (±6 %, ±12 %). */
const SPEED_VARIANTS = [0.88, 0.94, 1.06, 1.12];
/** Stop the robustness walk after this many candidates pass it. */
const ROBUST_FINALISTS = 5;
/** Candidates the default budget allows the robustness walk to check. */
const ROBUST_CANDIDATES = 12;
/** A landing spot counts as reached within this distance (m). */
export const LANDING_RADIUS = 0.15;
/** Full power: overhits beyond it can't be played, so they can't be tested either. */
const MAX_SPEED = POWER_SPEEDS[POWER_SPEEDS.length - 1]!;

/** Cost per unit of side (fraction of R). ASSUMPTION: coaching heuristic, tuned so side is rare. */
export const SIDE_PENALTY = 1.5;
/** Objective a side-spin stroke must gain over the best centre-line stroke to be recommended. ASSUMPTION. */
export const SIDE_MIN_GAIN = 0.4;
/** Below this cut (deg) and with no landing spot, side is a last resort (see NO_SIDE_PENALTY). ASSUMPTION. */
export const NO_SIDE_CUT_DEG = 5;
/**
 * Extra cost of side on a near-straight shot with no landing spot. ASSUMPTION (coaching rule, not a
 * measurement): larger than the default objective's whole range (0..3) plus every other penalty
 * (≈ 7 at most), so any potting centre-line stroke outranks it and side is chosen only when no
 * centre-line stroke pots the ball.
 */
export const NO_SIDE_PENALTY = 10;
/** Tip placement error (fraction of R) and shaft mass ratio used by the robustness probes. ASSUMPTION. */
export const TIP_ERROR = 0.05;
export const PROBE_SQUIRT_MASS_RATIO = 23;
/** Aim error of the robustness probes, as a share of the shot's own CB aim tolerance. ASSUMPTION. */
export const AIM_ERROR_SHARE = 0.6;
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
/** Strokes whose robust score is within this of the best are compared on power: the softest wins. ASSUMPTION. */
export const SOFTEST_WITHIN = 0.1;
/** A tip/aim/shaft probe in which the cue ball scratches costs this much (a miss costs PROBE_FAIL). ASSUMPTION. */
export const PROBE_SCRATCH = 6;
export const PROBE_FAIL = 3;
/** Tip, aim and shaft probes per candidate that passes the speed check (at most). */
const SOFT_PROBES = 5;
/** Default objective: the softest potting powers are refined by this many half steps. */
const HALF_STEPS = 2;

/** Default evaluation budget: the whole grid (powers 1..10), the half steps, and the robustness walk. */
export const FULL_EVALUATIONS =
  10 * VERTS.length * SIDES.length + HALF_STEPS * VERTS.length * SIDES.length + ROBUST_CANDIDATES * (SPEED_VARIANTS.length + SOFT_PROBES);

/** Map a CB aim tolerance (deg) to 0..1 (0.02° → 0, ≥1° → 1) on a log scale. */
export function toleranceQuality(tolDeg: number): number {
  if (tolDeg <= 0) return 0;
  const q = (Math.log10(tolDeg) - Math.log10(0.02)) / (0 - Math.log10(0.02));
  return Math.max(0, Math.min(1, q));
}

/**
 * Quality (0..1) of the best next shot with the cue ball at `cuePos`. With `onlyBallId`, only that
 * ball counts (0 if it isn't an eligible object ball). With no object ball left at all, finishing
 * near the middle of the table scores best. `params` only matters for a frozen cue ball (throw bound).
 */
export function nextShotQuality(layout: TableLayout, cuePos: Vec2, excludeIds: string[], onlyBallId?: string, params?: PhysicsParams): number {
  const cue: Ball = { id: '__cue', kind: 'cue', pos: cuePos };
  const others = layout.balls.filter((b) => b.kind !== 'cue' && !excludeIds.includes(b.id));
  const all = [cue, ...others];
  let best = 0;
  let any = false;
  for (const t of others) {
    if (onlyBallId !== undefined && t.id !== onlyBallId) continue;
    any = true;
    for (const p of layout.table.pockets) {
      const g = shotGeometry(layout.table, all, cue, t, p, params);
      if (!g.makeable || g.blockersCue.length || g.blockersObject.length) continue;
      best = Math.max(best, toleranceQuality(deg(g.toleranceRad)));
    }
  }
  if (!any) {
    if (onlyBallId !== undefined) return 0; // asked about one ball that isn't there to play
    // Nothing left: prefer finishing near the middle of the table.
    const hx = layout.table.length / 2;
    const hy = layout.table.width / 2;
    return 1 - Math.min(1, Math.hypot(cuePos.x / hx, cuePos.y / hy));
  }
  return best;
}

/**
 * The table as it will be after `plan`: the target, the cue ball and every pocketed ball removed,
 * balls the shot moved at their rest spots (simulate fills rest/pocket even with record off).
 */
export function postShotLayout(layout: TableLayout, plan: Pick<ShotPlan, 'targetId' | 'otherPaths'>): TableLayout {
  const balls: Ball[] = [];
  for (const b of layout.balls) {
    if (b.kind === 'cue' || b.id === plan.targetId) continue;
    const tr = plan.otherPaths.find((t) => t.ballId === b.id);
    if (!tr) balls.push(b);
    else if (!tr.pocket && tr.rest) balls.push({ ...b, pos: tr.rest });
  }
  return { ...layout, balls };
}

export interface RecommendOptions {
  landing?: Vec2;
  /** Simulations allowed: grid plans, half steps and robustness mis-hits (default FULL_EVALUATIONS). The result is a function of it. */
  maxEvaluations?: number;
  /**
   * Optional wall-clock safety net (ms). Unset by default, so the core never reads the clock. When
   * set and exceeded, the search stops and the result has `timedOut: true` (not deterministic).
   */
  timeCapMs?: number;
  /** @deprecated Old wall-clock budget; now treated as `timeCapMs` (a reported safety net). */
  budgetMs?: number;
  /** Test/debug hook: every planned grid stroke (half steps included) and its score (null = scratch or miss); not the mis-hits. */
  onEvaluate?: (stroke: Stroke, score: number | null) => void;
}

interface Scored {
  stroke: Stroke;
  score: number;
  /** Outcome part of the score (landing error or next-shot quality), without the stroke penalty. */
  objective: number;
  penalty: number;
  rest: Vec2;
  restError: number;
  nextQuality?: number;
  /** The plan's cue-ball travel direction, so the mis-hits keep the same cue line. */
  aimDir: Vec2;
}

/** A mis-hit's outcome: the objective, or why it failed (and where the cue ball went). */
type MisHit = { objective: number } | { fail: 'scratch'; pocketId: PocketId } | { fail: 'miss' };

/** A candidate after the robustness walk. */
interface Checked {
  r: Scored;
  /** Final robust score (see the header). */
  robust: number;
  /** Passed every testable speed variant. */
  passed: boolean;
  /** Some speed variant was an untestable overhit past full power. */
  untestable: boolean;
  risks: StrokeRisk[];
}

export function recommendStroke(layout: TableLayout, request: ShotRequest, params: PhysicsParams, opts: RecommendOptions = {}): Recommendation {
  const cap = opts.timeCapMs ?? opts.budgetMs;
  const t0 = cap !== undefined ? performance.now() : 0;
  let timedOut = false;
  const maxEvaluations = Math.max(0, Math.floor(opts.maxEvaluations ?? FULL_EVALUATIONS));
  const base = planShot(layout, { targetId: request.targetId, ...(request.pocketId ? { pocketId: request.pocketId } : {}) }, params, { record: false });
  const pocketId = base.pocketId;
  const landing = opts.landing ?? request.landing;
  let evaluated = 0;
  // From the bare capture minimum: between it and minPower the ball only just drops, which can still
  // be the stroke that leaves the cue ball best.
  const lo = Math.max(1, Math.floor(base.minPowerCapture ?? base.minPower));
  const powers: number[] = [];
  for (let p = lo; p <= 10; p++) powers.push(p);
  if (!powers.length || !base.makeable) return { stroke: base.stroke, score: -Infinity, reachable: false, evaluated: 0, rest: base.cueRest };
  /** Reported at every return, so a cap that fires in any phase is never silent. */
  const capped = (): { timedOut?: true } => (timedOut ? { timedOut: true } : {});
  const cueBall = layout.balls.find((b) => b.kind === 'cue')!;
  const cueId = cueBall.id;
  const R = layout.table.ballRadius;
  // Side on a near-straight shot with no spot to reach is a last resort (see NO_SIDE_PENALTY).
  const noSide = !landing && base.cutAngleDeg < NO_SIDE_CUT_DEG;

  /** Room for `n` more simulations? */
  const room = (n: number): boolean => {
    if (evaluated + n > maxEvaluations) return false;
    if (cap !== undefined && !timedOut && performance.now() - t0 > cap) timedOut = true;
    return !timedOut;
  };

  /** Outcome part of the score for a cue-ball rest spot and the other balls' paths. */
  const outcome = (rest: Vec2, otherPaths: Trajectory[]): { objective: number; restError: number; nextQuality?: number } => {
    if (landing) {
      const restError = Math.hypot(rest.x - landing.x, rest.y - landing.y);
      return { objective: -restError / LANDING_RADIUS, restError };
    }
    const nextQuality = nextShotQuality(postShotLayout(layout, { targetId: request.targetId, otherPaths }), rest, [request.targetId], undefined, params);
    return { objective: 3 * nextQuality, restError: 0, nextQuality };
  };

  const evaluate = (stroke: Stroke): Scored | null => {
    evaluated++;
    const plan = planShot(layout, { targetId: request.targetId, pocketId, stroke }, params, { record: false });
    if (!plan.obPocketed || plan.scratch || !plan.cueRest) {
      opts.onEvaluate?.(stroke, null);
      return null;
    }
    const kiss = plan.warnings.some((w) => w.code === 'kiss');
    // Any cue-ball contact with another ball moves the layout in ways a player can't control (R-11).
    const contact = plan.cuePath.events.some((e) => e.kind === 'ball' && e.otherId !== request.targetId);
    const rest = plan.cueRest;
    const { objective, restError, nextQuality } = outcome(rest, plan.otherPaths);
    // Coach's bias: controllable speed, minimal spin. Hard strokes cost quadratically above 6, and
    // pace well past pocket speed costs per diamond (see PACE_COST_PER_DIAMOND).
    const pace = Math.min(40, paceDiamonds(plan.obPocketSpeed, layout.table.length, params));
    const travel = Math.hypot(rest.x - cueBall.pos.x, rest.y - cueBall.pos.y);
    const penalty =
      0.06 * stroke.power +
      0.1 * Math.max(0, stroke.power - 6) ** 2 +
      // On a spot the player chose, reaching it comes first: pace costs a quarter as much.
      (landing ? 0.25 : 1) * PACE_COST_PER_DIAMOND * Math.max(0, pace - PACE_FREE_DIAMONDS) +
      CB_TRAVEL_COST * Math.max(0, travel - 1) +
      SIDE_PENALTY * Math.abs(stroke.side) +
      (noSide && stroke.side !== 0 ? NO_SIDE_PENALTY : 0) +
      0.3 * Math.abs(stroke.vert) +
      (kiss ? 1 : 0) +
      (contact ? 0.5 : 0);
    const score = objective - penalty;
    opts.onEvaluate?.(stroke, score);
    return { stroke, score, objective, penalty, rest, restError, aimDir: plan.aimDir, ...(nextQuality !== undefined ? { nextQuality } : {}) };
  };

  /**
   * The candidate mis-hit: its planned cue line (aimDir, squirt-compensated as planned) turned by
   * `turn` rad, at cue-ball `speed`, with tip height `vert` — what a player who misjudges the pace,
   * the tip or the aim does (no re-aim).
   */
  const misHit = (r: Scored, speed: number, vert: number, turn: number): MisHit => {
    evaluated++;
    const dir = turn === 0 ? r.aimDir : fromAngle(angleOf(r.aimDir) + turn);
    const st = strikeBall(dir, speed, r.stroke.side, vert, R, params.squirtMassRatio);
    const init = layout.balls.map((b) => (b.id === cueId ? { id: b.id, pos: b.pos, vel: st.vel, omega: st.omega } : { id: b.id, pos: b.pos }));
    const sim = simulate(layout.table, init, params, { record: false });
    const scratched = sim.final[cueId]!.pocket;
    if (scratched !== null) return { fail: 'scratch', pocketId: scratched };
    if (sim.final[request.targetId]?.pocket !== pocketId) return { fail: 'miss' };
    const others = sim.trajectories.filter((t) => t.ballId !== cueId && t.ballId !== request.targetId && t.events.length > 0);
    return { objective: outcome(sim.final[cueId]!.pos, others).objective };
  };

  // Coarse to fine: centre ball at three heights for every power first, then the rest of the grid
  // (on a near-straight shot with no landing spot, the centre line before any side).
  const order: Stroke[] = [];
  for (const power of powers) for (const vert of COARSE_VERTS) order.push({ power, side: 0, vert });
  const fine: Stroke[] = [];
  for (const power of powers)
    for (const vert of VERTS)
      for (const side of SIDES) if (!(side === 0 && COARSE_VERTS.includes(vert))) fine.push({ power, side, vert });
  if (noSide) order.push(...fine.filter((s) => s.side === 0), ...fine.filter((s) => s.side !== 0));
  else order.push(...fine);
  const results: Scored[] = [];
  for (const s of order) {
    if (!room(1)) break;
    const r = evaluate(s);
    if (r) results.push(r);
  }
  // Default objective: the softest strokes that pot are refined in half steps (just below the
  // softest potting whole power, and just above it): a stroke between whole numbers often pockets
  // the ball at pocket speed with a better leave. Never below the first searched power.
  if (!landing && results.length) {
    const p1 = Math.min(...results.map((r) => r.stroke.power));
    const halves = [p1 - 0.5, p1 + 0.5].filter((p) => p > lo && p <= 10).slice(0, HALF_STEPS);
    halfSteps: for (const power of halves)
      for (const vert of VERTS)
        for (const side of noSide ? [0] : SIDES) {
          if (!room(1)) break halfSteps;
          const r = evaluate({ power, side, vert });
          if (r) results.push(r);
        }
  }
  if (!results.length) return { stroke: base.stroke, score: -Infinity, reachable: false, evaluated, rest: base.cueRest, ...capped() };
  results.sort((a, b) => b.score - a.score); // stable: ties keep evaluation order

  // A landing spot is reachable if any potting stroke ends near it; then only those strokes compete.
  const reachable = landing ? results.some((r) => r.restError <= LANDING_RADIUS) : true;
  const pool = landing && reachable ? results.filter((r) => r.restError <= LANDING_RADIUS) : results;

  // Robustness: one candidate's checks (speed first; tip, aim and shaft for a survivor).
  const aimErr = Math.max(1e-4, (AIM_ERROR_SHARE * base.toleranceDeg * Math.PI) / 180);
  const squirtOf = (s: Stroke, ratio: number) => (s.side === 0 ? 0 : strikeBall(base.aimDir, 1, s.side, s.vert, R, ratio).squirtRad);
  const check = (r: Scored): Checked => {
    const risks: StrokeRisk[] = [];
    const note = (scratchIf: StrokeRisk['scratchIf'], p: PocketId) => {
      if (!risks.some((x) => x.scratchIf === scratchIf && x.pocketId === p)) risks.push({ scratchIf, pocketId: p });
    };
    const v0 = powerToSpeed(r.stroke.power);
    let untestable = false;
    let worst = Infinity;
    for (const k of SPEED_VARIANTS) {
      if (v0 * k > MAX_SPEED + 1e-9) {
        untestable = true; // an overhit past full power: can't be tested here
        continue;
      }
      const m = misHit(r, v0 * k, r.stroke.vert, 0);
      if ('fail' in m) {
        if (m.fail === 'scratch') note(k < 1 ? 'softer' : 'harder', m.pocketId);
        return { r, robust: -Infinity, passed: false, untestable, risks };
      }
      worst = Math.min(worst, m.objective);
    }
    // Worst outcome, charged the nominal stroke's penalty (the variants are the same stroke, mis-hit).
    const robust = Math.min(r.score, worst - r.penalty);
    // Tip height, aim, and a standard shaft's squirt instead of the configured one.
    const soft: { kind: StrokeRisk['scratchIf']; vert: number; turn: number }[] = [
      { kind: 'tip', vert: r.stroke.vert - TIP_ERROR, turn: 0 },
      { kind: 'tip', vert: r.stroke.vert + TIP_ERROR, turn: 0 },
      { kind: 'aim', vert: r.stroke.vert, turn: -aimErr },
      { kind: 'aim', vert: r.stroke.vert, turn: aimErr },
    ];
    // The cue points as compensated for the configured shaft; a standard shaft squirts the ball
    // by its own angle instead (no probe when the two are the same).
    const dSquirt = Math.sign(r.stroke.side) * (squirtOf(r.stroke, PROBE_SQUIRT_MASS_RATIO) - squirtOf(r.stroke, params.squirtMassRatio));
    if (r.stroke.side !== 0 && Math.abs(dSquirt) > 1e-9) soft.push({ kind: 'aim', vert: r.stroke.vert, turn: dSquirt });
    let worstSoft = robust;
    for (const p of soft) {
      const m = misHit(r, v0, p.vert, p.turn);
      if (!('fail' in m)) worstSoft = Math.min(worstSoft, m.objective - r.penalty);
      else if (m.fail === 'scratch') {
        worstSoft = Math.min(worstSoft, r.score - PROBE_SCRATCH);
        note(p.kind, m.pocketId);
      } else worstSoft = Math.min(worstSoft, r.score - PROBE_FAIL);
    }
    return { r, robust: 0.5 * robust + 0.5 * worstSoft, passed: true, untestable, risks };
  };
  const cost = (r: Scored) => SPEED_VARIANTS.length + 4 + (r.stroke.side !== 0 ? 1 : 0);

  // Walk the pool in score order until ROBUST_FINALISTS pass; then give the polish finalists their
  // check too: the best three centre-line strokes (so side has a fair rival) and the best stroke at
  // each of the two softest powers (so a gentler stroke can win on SOFTEST_WITHIN).
  const checked = new Map<Scored, Checked>();
  let passedN = 0;
  for (const r of pool) {
    if (passedN >= ROBUST_FINALISTS || !room(cost(r))) break;
    const c = check(r);
    checked.set(r, c);
    if (c.passed && !c.untestable) passedN++;
  }
  const extras: Scored[] = pool.filter((x) => x.stroke.side === 0).slice(0, 3);
  const softest = [...new Set(pool.map((x) => x.stroke.power))].sort((a, b) => a - b).slice(0, 2);
  for (const p of softest) {
    const r = pool.find((x) => x.stroke.power === p);
    if (r) extras.push(r);
  }
  for (const r of extras) {
    if (checked.has(r)) continue;
    if (!room(cost(r))) break;
    checked.set(r, check(r));
  }

  // Pick among the fully tested survivors (else those that needed an untestable overhit).
  const survivors = [...checked.values()].filter((c) => c.passed);
  const tested = survivors.filter((c) => !c.untestable);
  let group = tested.length ? tested : survivors;
  if (noSide && group.some((c) => c.r.stroke.side === 0)) group = group.filter((c) => c.r.stroke.side === 0);
  let pick: Checked | null = null;
  if (group.length) {
    const top = (list: Checked[]) => list.reduce((a, b) => (b.robust > a.robust ? b : a));
    // Side only when it clearly pays.
    const bestAll = top(group);
    const centre = group.filter((c) => c.r.stroke.side === 0);
    const sidePool = bestAll.r.stroke.side !== 0 && centre.length && bestAll.robust - top(centre).robust <= SIDE_MIN_GAIN ? centre : group;
    // Among strokes about as good as the best, the softest (a coach's "use the least speed that works").
    const bestRobust = top(sidePool).robust;
    const near = sidePool.filter((c) => c.robust >= bestRobust - SOFTEST_WITHIN);
    pick = near.reduce((a, b) => (b.r.stroke.power < a.r.stroke.power || (b.r.stroke.power === a.r.stroke.power && b.robust > a.robust) ? b : a));
  }
  const fragile = !pick;
  const chosen = pick ? pick.r : pool[0]!;
  const score = pick ? pick.robust : chosen.score;
  // risks: what the chosen stroke's checks saw. A fragile stroke never claims to be safe: its list
  // is given only when its check found a scratch, and is absent ("not known") otherwise.
  const seen = checked.get(chosen)?.risks;
  const risks = pick ? pick.risks : seen && seen.length ? seen : undefined;
  return {
    stroke: chosen.stroke,
    score,
    reachable,
    restError: chosen.restError,
    rest: chosen.rest,
    evaluated,
    ...(risks ? { risks } : {}),
    ...(fragile ? { fragile: true } : {}),
    ...(chosen.nextQuality !== undefined ? { nextQuality: chosen.nextQuality } : {}),
    ...capped(),
  };
}

/**
 * Next-shot quality over a grid of cue-ball positions (row-major, rows along +y from −W/2) for one
 * next ball. All zeros when `nextBallId` is not an object ball that is still to be played (the cue
 * ball, the current target in `excludeIds`, or unknown): there is no next shot to map.
 */
export function positionHeatmap(layout: TableLayout, nextBallId: string, cols: number, rows: number, excludeIds: string[] = [], params?: PhysicsParams): Float32Array {
  const out = new Float32Array(cols * rows);
  const next = layout.balls.find((b) => b.id === nextBallId);
  if (!next || next.kind === 'cue' || excludeIds.includes(nextBallId)) return out;
  const R = layout.table.ballRadius;
  const hx = layout.table.length / 2 - R;
  const hy = layout.table.width / 2 - R;
  // Balls the cue ball can't overlap: every object ball still on the table, the next ball included.
  const occupied = layout.balls.filter((b) => b.kind !== 'cue' && !excludeIds.includes(b.id));
  const exclude = [...excludeIds, ...layout.balls.filter((b) => b.kind === 'cue').map((b) => b.id)];
  const p = { x: 0, y: 0 };
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++) {
      p.x = -hx + ((i + 0.5) / cols) * 2 * hx;
      p.y = -hy + ((j + 0.5) / rows) * 2 * hy;
      let free = true;
      for (const b of occupied) if (Math.hypot(b.pos.x - p.x, b.pos.y - p.y) < 2 * R) free = false;
      if (!free) continue;
      out[j * cols + i] = nextShotQuality(layout, p, exclude, nextBallId, params);
    }
  return out;
}
