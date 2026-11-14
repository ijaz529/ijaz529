/**
 * Position play (FR-020…FR-022, research.md R-11): search tip offset × speed by simulation for the
 * stroke that pockets the ball and leaves the cue ball best placed — on the player's chosen spot, or
 * (default) where the easiest next shot is. Finalists are re-simulated at ±12 % speed and scored by
 * their worst case, which favours forgiving strokes as a coach would.
 */
import type { Ball, PhysicsParams, Recommendation, ShotRequest, Stroke, TableLayout, Vec2 } from '../types';
import { deg } from '../vec';
import { planShot, shotGeometry } from './planner';

const VERTS = [-0.4, -0.25, -0.1, 0.1, 0.25, 0.4];
const SIDES = [-0.2, 0, 0.2];

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
  const landing = opts.landing ?? request.landing;
  let evaluated = 0;
  const lo = Math.max(1, Math.ceil(base.minPower));
  const powers: number[] = [];
  for (let p = lo; p <= 10; p++) powers.push(p);
  if (!powers.length || !base.makeable) return { stroke: base.stroke, score: -Infinity, reachable: false, evaluated: 0, rest: base.cueRest };

  const evaluate = (stroke: Stroke): Scored | null => {
    evaluated++;
    const plan = planShot(layout, { targetId: request.targetId, pocketId, stroke }, params, { record: false });
    if (!plan.obPocketed || plan.scratch || !plan.cueRest) return null;
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
    // Coach's bias: controllable speed, minimal spin. Hard strokes cost quadratically above 6.
    const penalty = 0.06 * stroke.power + 0.1 * Math.max(0, stroke.power - 6) ** 2 + 0.6 * Math.abs(stroke.side) + 0.3 * Math.abs(stroke.vert) + (kiss ? 1 : 0);
    return { stroke, score: objective - penalty, rest, restError };
  };

  const results: Scored[] = [];
  outer: for (const power of powers)
    for (const vert of VERTS)
      for (const side of SIDES) {
        if (performance.now() - t0 > budget * 0.8) break outer;
        const r = evaluate({ power, side, vert });
        if (r) results.push(r);
      }
  if (!results.length) return { stroke: base.stroke, score: -Infinity, reachable: false, evaluated, rest: base.cueRest };
  results.sort((a, b) => b.score - a.score);

  // Robustness: worst case over ±12 % power for the finalists.
  let best: Scored = results[0]!;
  let bestRobust = -Infinity;
  for (const r of results.slice(0, 5)) {
    if (performance.now() - t0 > budget) break;
    let worst = r.score;
    for (const k of [0.88, 1.12]) {
      const p = Math.max(1, Math.min(10, r.stroke.power * k));
      const v = evaluate({ ...r.stroke, power: p });
      worst = Math.min(worst, v ? v.score : r.score - 3);
    }
    const robust = 0.5 * r.score + 0.5 * worst;
    if (robust > bestRobust) {
      bestRobust = robust;
      best = r;
    }
  }
  const reachable = landing ? best.restError <= 0.15 : true;
  return { stroke: best.stroke, score: bestRobust, reachable, restError: best.restError, rest: best.rest, evaluated };
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
