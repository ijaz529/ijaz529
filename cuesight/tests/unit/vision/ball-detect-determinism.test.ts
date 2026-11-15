/**
 * Constitution III: the same frame and calibration give the same detections, whatever frames the
 * detector saw before. Its scratch buffers are module-level and only ever grow; each case below loads
 * a fresh instance of the module (vi.resetModules), so its first detection meets buffers sized for
 * that first frame alone.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Calibration } from '../../../src/vision/calibration';
import { calibrationSet, POSES, rack, render, snookerPack, SNOOKER_POSES, tableOf } from './ball-detect-helpers';

type Detect = (typeof import('../../../src/vision/ball-detect'))['detectBalls'];
async function freshDetector(): Promise<Detect> {
  vi.resetModules();
  return (await import('../../../src/vision/ball-detect')).detectBalls;
}

describe('per-frame determinism', () => {
  it('a pack fitted on its own finer window: the same balls whether or not a larger frame came first', async () => {
    // The 15-ball rack in the corner view is fitted on a resampled window that it nearly fills. The
    // hole fill and the thin-part strip need a work queue of up to twice the blob's pixels; they used
    // to be skipped whenever the scratch was smaller than that, i.e. unless some earlier frame had
    // grown it (with the skip: 12 balls when the rack is the first frame under this ±0.3 px
    // calibration, 13 after a snooker pack).
    const sc = rack(15, POSES.corner!);
    const frame = render(sc);
    const det = tableOf(frame)!;
    const cal = calibrationSet(sc, [[0.3, 1, 1002]]).find((c) => c.name.endsWith('seed 1002'))!.cal!;
    const sig = (detect: Detect) =>
      detect(frame, cal, sc.table, det.cloth)
        .map((b) => `${(b.pos.x * 1000).toFixed(1)},${(b.pos.y * 1000).toFixed(1)} ${b.label}${b.isCue ? '*' : ''}`)
        .join(' | ');
    const first = sig(await freshDetector());
    const ssc = snookerPack(SNOOKER_POSES.end);
    const sf = render(ssc);
    const sd = tableOf(sf)!;
    const sCal: Calibration = calibrationSet(ssc, []).find((c) => c.name === 'exact')!.cal!;
    const after = await freshDetector();
    after(sf, sCal, ssc.table, sd.cloth);
    expect(sig(after)).toEqual(first);
  }, 60_000);
});
