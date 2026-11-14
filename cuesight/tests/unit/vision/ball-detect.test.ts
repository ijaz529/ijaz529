import { describe, expect, it } from 'vitest';
import { detectBalls } from '../../../src/vision/ball-detect';
import { calibrationFromCorners } from '../../../src/vision/calibration';
import { renderSyntheticTable } from '../../../src/vision/synth/render';
import { detectTable } from '../../../src/vision/table-detect';
import type { Frame } from '../../../src/vision/image';
import { POSES, scene } from '../../helpers/scenes';

/** Simulate video chroma subsampling (YUV 4:2:0): full-res luma, 2×2-averaged chroma. */
function chroma420(f: Frame): Frame {
  const { width: w, height: h, data } = f;
  const out = new Uint8ClampedArray(data.length);
  for (let j = 0; j < h; j += 2)
    for (let i = 0; i < w; i += 2) {
      let cb = 0;
      let cr = 0;
      const ys: number[] = [];
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
        const k = ((j + dy) * w + i + dx) * 4;
        const r = data[k]!;
        const g = data[k + 1]!;
        const b = data[k + 2]!;
        ys.push(0.299 * r + 0.587 * g + 0.114 * b);
        cb += -0.168736 * r - 0.331264 * g + 0.5 * b;
        cr += 0.5 * r - 0.418688 * g - 0.081312 * b;
      }
      cb /= 4;
      cr /= 4;
      [[0, 0], [1, 0], [0, 1], [1, 1]].forEach(([dx, dy], q) => {
        const k = ((j + dy!) * w + i + dx!) * 4;
        const y = ys[q]!;
        out[k] = y + 1.402 * cr;
        out[k + 1] = y - 0.344136 * cb - 0.714136 * cr;
        out[k + 2] = y + 1.772 * cb;
        out[k + 3] = 255;
      });
    }
  return { width: w, height: h, data: out };
}

describe('ball detection on video-like (4:2:0) frames', () => {
  it.each(['corner', 'end'] as const)('%s view: no over-splitting, cue found', (pose) => {
    const sc = scene(pose);
    const frame = chroma420(renderSyntheticTable(sc));
    const det = detectTable(frame)!;
    const cal = calibrationFromCorners(det.corners, sc.table, frame.width, frame.height)!;
    const balls = detectBalls(frame, cal, sc.table, det.cloth);
    expect(balls.length).toBe(sc.balls.length);
    expect(balls.filter((b) => b.isCue)).toHaveLength(1);
    // The flagged ball must BE the cue ball (up to the table's 180° symmetry), not just any ball.
    const truth = sc.balls.map((b) => b.pos);
    const sumErr = (sign: number) => truth.reduce((a, t) => a + Math.min(...balls.map((b) => Math.hypot(b.pos.x - sign * t.x, b.pos.y - sign * t.y))), 0);
    const sign = sumErr(1) <= sumErr(-1) ? 1 : -1;
    const cue = balls.find((b) => b.isCue)!;
    expect(Math.hypot(cue.pos.x - sign * truth[0]!.x, cue.pos.y - sign * truth[0]!.y)).toBeLessThan(0.03);
  });
});

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
