import { describe, expect, it } from 'vitest';
import { DEFAULT_PHYSICS } from '../../../src/core/physics/params';
import { planShot } from '../../../src/core/shot/planner';
import { suggestShots } from '../../../src/core/shot/suggest';
import { makeTable, pocketById } from '../../../src/core/table';
import type { ShotSuggestion, TableLayout } from '../../../src/core/types';
import { add, scale, v2, type Vec2 } from '../../../src/core/vec';
import { layout } from '../../helpers/layout';

const T = makeTable('pool9');

/** Re-plan every suggestion: none may be blocked (the filter in suggestShots must hold). */
function expectNoneBlocked(lay: TableLayout, s: ShotSuggestion[]) {
  for (const x of s) {
    const plan = planShot(lay, { targetId: x.targetId, pocketId: x.pocketId }, DEFAULT_PHYSICS, { record: false });
    const blocked = plan.warnings.filter((w) => w.code === 'blocked-cue' || w.code === 'blocked-object');
    expect(blocked, `${x.targetId} → ${x.pocketId}`).toEqual([]);
  }
}

describe('suggestShots', () => {
  it('ranks an easy shot first and excludes blocked ones', () => {
    const tr = pocketById(T, 'TR');
    const easy = add(tr.mouthCenter, scale(tr.inward, 0.3));
    const cue = add(tr.mouthCenter, scale(tr.inward, 0.75));
    const lay = layout({
      cue,
      easy,
      hard: v2(-1.0, -0.5),
      // 'boxed' is surrounded so every pocket path is blocked.
      boxed: v2(-0.4, 0.3),
      w1: v2(-0.4 + 0.058, 0.3),
      w2: v2(-0.4 - 0.058, 0.3),
      w3: v2(-0.4, 0.3 + 0.058),
      w4: v2(-0.4, 0.3 - 0.058),
    });
    const s = suggestShots(lay, DEFAULT_PHYSICS, 3);
    expect(s[0]!.targetId).toBe('easy');
    expect(s[0]!.pocketId).toBe('TR');
    expect(s.find((x) => x.targetId === 'boxed')).toBeUndefined();
    for (let i = 1; i < s.length; i++) expect(s[i - 1]!.score).toBeGreaterThanOrEqual(s[i]!.score);
    expectNoneBlocked(lay, s);
  });

  it('a tight 15-ball rack: every shot is blocked, so nothing is suggested', () => {
    const balls: Record<string, Vec2> = { cue: v2(-0.8, 0.05) };
    let k = 0;
    for (let row = 0; row < 5; row++) for (let c = 0; c <= row; c++) balls[`b${k++}`] = v2(0.5 + row * 0.0495, (c - row / 2) * 0.0575);
    const s = suggestShots(layout(balls), DEFAULT_PHYSICS, 3);
    expect(s).toHaveLength(0);
  });

  it('an open 15-ball grid: 3 clear suggestions within the time budget (SC-008)', () => {
    const balls: Record<string, Vec2> = { cue: v2(-0.9, 0) };
    for (let i = 0; i < 5; i++) for (let j = 0; j < 3; j++) balls[`b${i}${j}`] = v2(-0.6 + 0.35 * i, -0.4 + 0.4 * j);
    const lay = layout(balls);
    suggestShots(lay, DEFAULT_PHYSICS, 3); // warm-up (JIT)
    const t0 = performance.now();
    const s = suggestShots(lay, DEFAULT_PHYSICS, 3);
    const ms = performance.now() - t0;
    console.log(`suggestShots(open 15-ball grid) ${ms.toFixed(0)} ms, ${s.length} suggestions`);
    expect(s).toHaveLength(3);
    expect(ms).toBeLessThan(2000);
    expectNoneBlocked(lay, s);
  });

  it('near-equal margins: the shot that leaves an easy next ball ranks first (suggest-ignores-position-quality)', () => {
    // b1 → TR leaves the cue ball on the top rail with a poor next shot; b3 → TL leaves an easy one.
    const lay = layout({ cue: v2(0.89, -0.35), b0: v2(-0.36, -0.39), b1: v2(1.09, 0.26), b2: v2(-1.08, -0.06), b3: v2(0.74, -0.31) });
    const s = suggestShots(lay, DEFAULT_PHYSICS, 3);
    const iRail = s.findIndex((x) => x.targetId === 'b1' && x.pocketId === 'TR');
    const iGood = s.findIndex((x) => x.targetId === 'b3' && x.pocketId === 'TL');
    expect(iGood).toBeGreaterThanOrEqual(0);
    expect(iRail).toBeGreaterThanOrEqual(0);
    // The margins really are near-equal, so only position separates them.
    expect(Math.abs(Math.log10(s[iRail]!.toleranceDeg) - Math.log10(s[iGood]!.toleranceDeg))).toBeLessThan(0.06);
    expect(iGood).toBeLessThan(iRail);
  });
});
