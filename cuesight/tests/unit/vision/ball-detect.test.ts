import { describe, expect, it } from 'vitest';
import { detectBalls } from '../../../src/vision/ball-detect';
import { calibrationFromCorners } from '../../../src/vision/calibration';
import { renderSyntheticTable } from '../../../src/vision/synth/render';
import { detectTable } from '../../../src/vision/table-detect';
import { POSES, scene } from '../../helpers/scenes';

describe.each(['end', 'side', 'corner', 'overhead'] as const)('ball detection (%s view)', (pose) => {
  const sc = scene(pose);
  const frame = renderSyntheticTable(sc);
  const det = detectTable(frame)!;
  const cal = calibrationFromCorners(det.corners, sc.table, frame.width, frame.height)!;
  const balls = detectBalls(frame, cal, sc.table, det.cloth);
  // Ground truth up to the table's 180° symmetry.
  const truth = sc.balls.map((b) => b.pos);
  const errFor = (sign: number) =>
    truth.map((t) => Math.min(...balls.map((b) => Math.hypot(b.pos.x - sign * t.x, b.pos.y - sign * t.y))));
  const e1 = errFor(1);
  const e2 = errFor(-1);
  const sign = e1.reduce((a, b) => a + b, 0) <= e2.reduce((a, b) => a + b, 0) ? 1 : -1;
  const errs = (sign === 1 ? e1 : e2).map((e) => e * 1000).sort((a, b) => a - b);

  it('finds every ball, separates touching balls, no false positives', () => {
    console.log(`${pose}: ${balls.length}/${truth.length} balls, errors mm ${errs.map((e) => e.toFixed(1)).join(' ')}, focal ${cal.focal.toFixed(0)} (${cal.focalSource})`);
    expect(balls.length).toBe(truth.length);
  });
  it('median position error ≤ 10 mm and p95 ≤ 25 mm (parallax-corrected)', () => {
    const median = errs[Math.floor(errs.length / 2)]!;
    const p95 = errs[Math.min(errs.length - 1, Math.ceil(errs.length * 0.95) - 1)]!;
    expect(median).toBeLessThanOrEqual(10);
    expect(p95).toBeLessThanOrEqual(25);
  });
  it('identifies the cue ball', () => {
    const cue = balls.find((b) => b.isCue);
    expect(cue).toBeDefined();
    const t = truth[0]!;
    expect(Math.hypot(cue!.pos.x - sign * t.x, cue!.pos.y - sign * t.y)).toBeLessThan(0.03);
    expect(balls.filter((b) => b.isCue)).toHaveLength(1);
  });
  void POSES;
});
