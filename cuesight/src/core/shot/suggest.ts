/**
 * Rank every makeable shot on the table (FR-019, US4, SHOULD-8): by margin of error and cue-ball
 * position. Geometric tolerance first; the leading candidates are then simulated with the default
 * stroke so kisses/misses are demoted and the cue ball's finishing spot is scored for the next shot
 * on the post-shot table.
 */
import type { PhysicsParams, ShotSuggestion, TableLayout } from '../types';
import { deg } from '../vec';
import { difficultyOf } from './coach';
import { planShot, shotGeometry } from './planner';
import { nextShotQuality, postShotLayout } from './position';

/**
 * ASSUMPTION (coaching weight): next-shot quality (0..1) is worth up to 0.5 on the log10-tolerance
 * score, so it breaks near-ties in margin (a factor of ≈3 in tolerance at most) without letting a
 * good leave outrank a far easier pot.
 */
export const POSITION_WEIGHT = 0.5;

export function suggestShots(layout: TableLayout, params: PhysicsParams, max = 3): ShotSuggestion[] {
  const cue = layout.balls.find((b) => b.kind === 'cue');
  if (!cue) return [];
  const cands: ShotSuggestion[] = [];
  for (const target of layout.balls) {
    if (target.kind === 'cue') continue;
    for (const pocket of layout.table.pockets) {
      const g = shotGeometry(layout.table, layout.balls, cue, target, pocket, params);
      if (!g.makeable || g.blockersCue.length || g.blockersObject.length) continue;
      const tol = deg(g.toleranceRad);
      // Contact margin on the object ball (mm), the figure the shot card shows (ShotPlan.toleranceMm is
      // this same geometry value, frozen and rail-frozen shots included).
      cands.push({ targetId: target.id, pocketId: pocket.id, toleranceDeg: tol, toleranceMm: g.toleranceMm, difficulty: difficultyOf(tol), score: Math.log10(Math.max(tol, 1e-4)) });
    }
  }
  cands.sort((a, b) => b.score - a.score);
  // Verify the leaders by simulation with the default stroke; demote kisses/misses, reward the leave.
  const verified: ShotSuggestion[] = [];
  for (const c of cands.slice(0, max * 3)) {
    const plan = planShot(layout, { targetId: c.targetId, pocketId: c.pocketId }, params, { record: false, advice: false }); // codes only
    const bad = plan.warnings.some(
      (w) => w.code === 'kiss' || w.code === 'ob-missed' || w.code === 'throw-uncompensable' || w.code === 'blocked-cue' || w.code === 'blocked-object',
    );
    const q = plan.cueRest ? nextShotQuality(postShotLayout(layout, plan), plan.cueRest, [c.targetId], undefined, params) : 0;
    verified.push({ ...c, score: c.score + POSITION_WEIGHT * q - (bad ? 2 : 0) - (plan.scratch ? 0.5 : 0) });
  }
  return verified.sort((a, b) => b.score - a.score).slice(0, max);
}
