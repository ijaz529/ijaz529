/**
 * Performance guards (Constitution IV). Device budgets: plan < 50 ms, vision ≥ 10 Hz (< 100 ms),
 * position search < 1.5 s. CI guards are looser to absorb shared-runner noise (about ×2); actual
 * numbers are printed for the record. recommendStroke is budgeted by evaluation count, not by the
 * clock, so the time it takes here is what the default budget really costs.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_PHYSICS } from '../../src/core/physics/params';
import { planShot } from '../../src/core/shot/planner';
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

  it('position search (recommended stroke) within 1.5 s on a device (3 s CI guard)', () => {
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
    expect(median(t)).toBeLessThan(3000); // device budget 1.5 s; CI factor 2
  });

  it('planShot on a full 22-ball snooker layout: median of 5 below 100 ms', () => {
    const sb: Record<string, Vec2> = { cue: v2(-1.2, 0.1), t: v2(0.5, 0.2) };
    let k = 0;
    for (let row = 0; row < 5; row++) for (let c = 0; c <= row; c++) sb[`r${k++}`] = v2(1.0 + row * 0.046, (c - row / 2) * 0.054);
    for (let i = 0; i < 5; i++) sb[`c${i}`] = v2(-0.9 + i * 0.3, -0.6 + 0.1 * i);
    const snooker = layout(sb, 'snooker12');
    expect(snooker.balls).toHaveLength(22);
    planShot(snooker, { targetId: 't' }, DEFAULT_PHYSICS); // warm-up (JIT)
    const runs: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      planShot(snooker, { targetId: 't' }, DEFAULT_PHYSICS);
      runs.push(performance.now() - t0);
    }
    console.log(`planShot (22 balls) median ${median(runs).toFixed(1)} ms`);
    expect(median(runs)).toBeLessThan(100); // device budget 50 ms; CI factor 2
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
