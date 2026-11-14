import { describe, expect, it } from 'vitest';
import { DEFAULT_PHYSICS } from '../../../src/core/physics/params';
import { suggestShots } from '../../../src/core/shot/suggest';
import { makeTable, pocketById } from '../../../src/core/table';
import { add, scale, v2, type Vec2 } from '../../../src/core/vec';
import { layout } from '../../helpers/layout';

const T = makeTable('pool9');

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
  });

  it('handles a 15-ball rack within the time budget', () => {
    const balls: Record<string, Vec2> = { cue: v2(-0.8, 0.05) };
    let k = 0;
    for (let row = 0; row < 5; row++) for (let c = 0; c <= row; c++) balls[`b${k++}`] = v2(0.5 + row * 0.0495, (c - row / 2) * 0.0575);
    const t0 = performance.now();
    const s = suggestShots(layout(balls), DEFAULT_PHYSICS, 3);
    const ms = performance.now() - t0;
    console.log(`suggestShots(15 balls) ${ms.toFixed(0)} ms, ${s.length} suggestions`);
    expect(ms).toBeLessThan(2000);
  });
});
