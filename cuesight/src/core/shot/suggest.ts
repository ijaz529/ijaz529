/**
 * Rank every makeable shot on the table (FR-019): geometric tolerance first, then a quick simulated
 * check of the leading candidates so kisses/misses don't get recommended.
 */
import type { PhysicsParams, ShotSuggestion, TableLayout } from '../types';
import { deg } from '../vec';
import { difficultyOf } from './coach';
import { planShot, shotGeometry } from './planner';

export function suggestShots(layout: TableLayout, params: PhysicsParams, max = 3): ShotSuggestion[] {
  const cue = layout.balls.find((b) => b.kind === 'cue');
  if (!cue) return [];
  const cands: ShotSuggestion[] = [];
  for (const target of layout.balls) {
    if (target.kind === 'cue') continue;
    for (const pocket of layout.table.pockets) {
      const g = shotGeometry(layout.table, layout.balls, cue, target, pocket);
      if (!g.makeable || g.blockersCue.length || g.blockersObject.length) continue;
      const tol = deg(g.toleranceRad);
      // Contact margin on the object ball (mm), as the shot card shows it (planner.ts toleranceMm).
      const toleranceMm = g.window.halfRad * 2 * layout.table.ballRadius * Math.cos(g.cut) * 1000;
      cands.push({ targetId: target.id, pocketId: pocket.id, toleranceDeg: tol, toleranceMm, difficulty: difficultyOf(tol), score: Math.log10(Math.max(tol, 1e-4)) });
    }
  }
  cands.sort((a, b) => b.score - a.score);
  // Verify the leaders by simulation with the default stroke; demote kisses/misses.
  const verified: ShotSuggestion[] = [];
  for (const c of cands.slice(0, max * 3)) {
    const plan = planShot(layout, { targetId: c.targetId, pocketId: c.pocketId }, params, { record: false });
    const bad = plan.warnings.some((w) => w.code === 'kiss' || w.code === 'ob-missed' || w.code === 'blocked-cue' || w.code === 'blocked-object');
    verified.push({ ...c, score: c.score - (bad ? 2 : 0) - (plan.scratch ? 0.5 : 0) });
  }
  return verified.sort((a, b) => b.score - a.score).slice(0, max);
}
