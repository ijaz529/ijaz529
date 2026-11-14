/**
 * Performance guards (Constitution IV). Device budgets: plan < 50 ms, vision ≥ 10 Hz (< 100 ms),
 * position search < 1.5 s. CI guards are looser to absorb shared-runner noise; actual numbers are
 * printed for the record.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_PHYSICS } from '../../src/core/physics/params';
import { recommendStroke } from '../../src/core/shot/position';
import { suggestShots } from '../../src/core/shot/suggest';
import { v2, type Vec2 } from '../../src/core/vec';
import { layout } from '../helpers/layout';

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

describe('performance budgets', () => {
  const balls: Record<string, Vec2> = { cue: v2(-0.6, -0.2) };
  const spots = [
    [0.1, 0.2], [0.35, -0.3], [-0.2, 0.35], [0.42, 0.38], [-0.38, -0.3], [0.05, -0.12], [0.3, 0.05], [-0.42, 0.1], [0.44, -0.4],
  ];
  spots.forEach(([x, y], i) => (balls[`b${i + 1}`] = v2(x! * 2.54, y! * 1.27)));
  const lay = layout(balls);

  it('position search (recommended stroke) within 1.5 s', () => {
    const best = suggestShots(lay, DEFAULT_PHYSICS, 1)[0]!;
    const t: number[] = [];
    let evaluated = 0;
    for (let k = 0; k < 3; k++) {
      const t0 = performance.now();
      evaluated = recommendStroke(lay, { targetId: best.targetId, pocketId: best.pocketId }, DEFAULT_PHYSICS).evaluated;
      t.push(performance.now() - t0);
    }
    console.log(`recommendStroke median ${median(t).toFixed(0)} ms over ${evaluated} simulated strokes`);
    expect(evaluated).toBeGreaterThan(50);
    expect(median(t)).toBeLessThan(1500);
  });

  it('suggestions on a 9-ball layout within 2 s', () => {
    const t0 = performance.now();
    const s = suggestShots(lay, DEFAULT_PHYSICS, 3);
    const ms = performance.now() - t0;
    console.log(`suggestShots ${ms.toFixed(0)} ms (${s.length} shots)`);
    expect(ms).toBeLessThan(2000);
    expect(s.length).toBeGreaterThan(0);
  });
});
