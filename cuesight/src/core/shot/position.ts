/**
 * Position play (FR-020…FR-022, research.md R-11): search tip offset × speed by simulation for the
 * stroke that pockets the ball and leaves the cue ball best placed — on the player's chosen spot, or
 * (default) where the easiest next shot is, judged on the table as it will be after the shot (balls
 * the shot moves at their rest spots, pocketed ones gone).
 *
 * Candidates are scored by the worst of the nominal and the ±6 %/±12 % speed outcomes; any scratch
 * or miss at those speeds disqualifies, which favours forgiving strokes as a coach would.
 *
 * Deterministic (Constitution III): the search is budgeted by evaluation count, coarse to fine, so a
 * smaller budget thins every power evenly instead of dropping the hard ones. The core never reads
 * the clock unless the caller sets the optional `timeCapMs` safety net, and the result reports when
 * that cap cut the search short.
 */
import type { Ball, PhysicsParams, Recommendation, ShotPlan, ShotRequest, Stroke, TableLayout, Vec2 } from '../types';
import { deg } from '../vec';
import { planShot, shotGeometry } from './planner';
import { POWER_SPEEDS, powerToSpeed, speedToPower } from './power';

const VERTS = [-0.4, -0.25, -0.1, 0.1, 0.25, 0.4];
const SIDES = [-0.2, 0, 0.2];
/** First pass: centre ball at three heights for every power, so a small budget still spans speed. */
const COARSE_VERTS = [-0.4, 0.1, 0.4];
/** Cue-ball speed errors a stroke must survive (±6 %, ±12 %). */
const SPEED_VARIANTS = [0.88, 0.94, 1.06, 1.12];
/** Stop the robustness walk after this many candidates pass it. */
const ROBUST_FINALISTS = 5;
/** Candidates the default budget allows the robustness walk to check (× SPEED_VARIANTS each). */
const ROBUST_CANDIDATES = 12;
/** A landing spot counts as reached within this distance (m). */
export const LANDING_RADIUS = 0.15;
/** Full power: overhits beyond it can't be played, so they can't be tested either. */
const MAX_SPEED = POWER_SPEEDS[POWER_SPEEDS.length - 1]!;

/** Default evaluation budget: the whole grid (powers 1..10) plus the robustness walk. */
export const FULL_EVALUATIONS = 10 * VERTS.length * SIDES.length + ROBUST_CANDIDATES * SPEED_VARIANTS.length;

/** Map a CB aim tolerance (deg) to 0..1 (0.02° → 0, ≥1° → 1) on a log scale. */
export function toleranceQuality(tolDeg: number): number {
  if (tolDeg <= 0) return 0;
  const q = (Math.log10(tolDeg) - Math.log10(0.02)) / (0 - Math.log10(0.02));
  return Math.max(0, Math.min(1, q));
}

/**
 * Quality (0..1) of the best next shot with the cue ball at `cuePos`. With `onlyBallId`, only that
 * ball counts (0 if it isn't an eligible object ball). With no object ball left at all, finishing
 * near the middle of the table scores best.
 */
export function nextShotQuality(layout: TableLayout, cuePos: Vec2, excludeIds: string[], onlyBallId?: string): number {
  const cue: Ball = { id: '__cue', kind: 'cue', pos: cuePos };
  const others = layout.balls.filter((b) => b.kind !== 'cue' && !excludeIds.includes(b.id));
  const all = [cue, ...others];
  let best = 0;
  let any = false;
  for (const t of others) {
    if (onlyBallId !== undefined && t.id !== onlyBallId) continue;
    any = true;
    for (const p of layout.table.pockets) {
      const g = shotGeometry(layout.table, all, cue, t, p);
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
  /** planShot simulations allowed (default FULL_EVALUATIONS). The result is a function of it. */
  maxEvaluations?: number;
  /**
   * Optional wall-clock safety net (ms). Unset by default, so the core never reads the clock. When
   * set and exceeded, the search stops and the result has `timedOut: true` (not deterministic).
   */
  timeCapMs?: number;
  /** @deprecated Old wall-clock budget; now treated as `timeCapMs` (a reported safety net). */
  budgetMs?: number;
  /** Test/debug hook: every simulated stroke and its score (null = scratch or miss). */
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
  const lo = Math.max(1, Math.floor(base.minPower));
  const powers: number[] = [];
  for (let p = lo; p <= 10; p++) powers.push(p);
  if (!powers.length || !base.makeable) return { stroke: base.stroke, score: -Infinity, reachable: false, evaluated: 0, rest: base.cueRest };

  /** Room for `n` more simulations? */
  const room = (n: number): boolean => {
    if (evaluated + n > maxEvaluations) return false;
    if (cap !== undefined && !timedOut && performance.now() - t0 > cap) timedOut = true;
    return !timedOut;
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
    let objective: number;
    let restError = 0;
    let nextQuality: number | undefined;
    if (landing) {
      restError = Math.hypot(rest.x - landing.x, rest.y - landing.y);
      objective = -restError / LANDING_RADIUS;
    } else {
      nextQuality = nextShotQuality(postShotLayout(layout, plan), rest, [request.targetId]);
      objective = 3 * nextQuality;
    }
    // Coach's bias: controllable speed, minimal spin. Hard strokes cost quadratically above 6.
    const penalty =
      0.06 * stroke.power +
      0.1 * Math.max(0, stroke.power - 6) ** 2 +
      0.6 * Math.abs(stroke.side) +
      0.3 * Math.abs(stroke.vert) +
      (kiss ? 1 : 0) +
      (contact ? 0.5 : 0);
    const score = objective - penalty;
    opts.onEvaluate?.(stroke, score);
    return { stroke, score, objective, penalty, rest, restError, ...(nextQuality !== undefined ? { nextQuality } : {}) };
  };

  // Coarse to fine: centre ball at three heights for every power first, then the rest of the grid.
  const order: Stroke[] = [];
  for (const power of powers) for (const vert of COARSE_VERTS) order.push({ power, side: 0, vert });
  for (const power of powers)
    for (const vert of VERTS)
      for (const side of SIDES) if (!(side === 0 && COARSE_VERTS.includes(vert))) order.push({ power, side, vert });
  const results: Scored[] = [];
  for (const s of order) {
    if (!room(1)) break;
    const r = evaluate(s);
    if (r) results.push(r);
  }
  const extra = timedOut ? { timedOut: true } : {};
  if (!results.length) return { stroke: base.stroke, score: -Infinity, reachable: false, evaluated, rest: base.cueRest, ...extra };
  results.sort((a, b) => b.score - a.score); // stable: ties keep evaluation order

  // A landing spot is reachable if any potting stroke ends near it; then only those strokes compete.
  const reachable = landing ? results.some((r) => r.restError <= LANDING_RADIUS) : true;
  const pool = landing && reachable ? results.filter((r) => r.restError <= LANDING_RADIUS) : results;

  // Robustness: walk the pool in score order until ROBUST_FINALISTS pass ±6/±12 % speed.
  let best: { r: Scored; robust: number } | null = null;
  let bestUntestable: { r: Scored; robust: number } | null = null;
  let passed = 0;
  for (const r of pool) {
    if (passed >= ROBUST_FINALISTS || !room(SPEED_VARIANTS.length)) break;
    const v0 = powerToSpeed(r.stroke.power);
    let untestable = false;
    let worst = Infinity;
    let failed = false;
    for (const k of SPEED_VARIANTS) {
      if (v0 * k > MAX_SPEED + 1e-9) {
        untestable = true; // an overhit past full power: can't be tested here
        continue;
      }
      const v = evaluate({ ...r.stroke, power: speedToPower(v0 * k) });
      if (!v) {
        failed = true;
        break;
      }
      worst = Math.min(worst, v.objective);
    }
    if (failed) continue;
    // Worst outcome, charged the nominal stroke's penalty (the variants are the same stroke, mis-hit).
    const robust = Math.min(r.score, worst - r.penalty);
    if (untestable) {
      if (!bestUntestable || robust > bestUntestable.robust) bestUntestable = { r, robust };
      continue;
    }
    passed++;
    if (!best || robust > best.robust) best = { r, robust };
  }
  const chosen = best ?? bestUntestable;
  const fragile = !chosen;
  const pick = chosen ? chosen.r : pool[0]!;
  const score = chosen ? chosen.robust : pick.score;
  return {
    stroke: pick.stroke,
    score,
    reachable,
    restError: pick.restError,
    rest: pick.rest,
    evaluated,
    ...(fragile ? { fragile: true } : {}),
    ...(pick.nextQuality !== undefined ? { nextQuality: pick.nextQuality } : {}),
    ...extra,
  };
}

/**
 * Next-shot quality over a grid of cue-ball positions (row-major, rows along +y from −W/2) for one
 * next ball. All zeros when `nextBallId` is not an object ball that is still to be played (the cue
 * ball, the current target in `excludeIds`, or unknown): there is no next shot to map.
 */
export function positionHeatmap(layout: TableLayout, nextBallId: string, cols: number, rows: number, excludeIds: string[] = []): Float32Array {
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
      out[j * cols + i] = nextShotQuality(layout, p, exclude, nextBallId);
    }
  return out;
}
