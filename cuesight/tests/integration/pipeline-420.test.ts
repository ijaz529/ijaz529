/**
 * The vision pipeline on video-like frames (YUV 4:2:0 chroma), the way a phone camera delivers them:
 * the tracked cue ball must be the real cue ball, not merely "some ball flagged as the cue".
 */
import { describe, expect, it } from 'vitest';
import { detectBalls } from '../../src/vision/ball-detect';
import type { Frame } from '../../src/vision/image';
import { createPipeline } from '../../src/vision/pipeline';
import { BALL_COLORS, renderSyntheticTable, type SynthBall } from '../../src/vision/synth/render';
import { scene } from '../helpers/scenes';

/** Simulate video chroma subsampling (YUV 4:2:0): full-res luma, 2×2-averaged chroma. */
function chroma420(f: Frame): Frame {
  const { width: w, height: h, data } = f;
  const out = new Uint8ClampedArray(data.length);
  const ys = [0, 0, 0, 0];
  const off = [0, 0, 1, 0, 0, 1, 1, 1];
  for (let j = 0; j < h; j += 2)
    for (let i = 0; i < w; i += 2) {
      let cb = 0;
      let cr = 0;
      for (let q = 0; q < 4; q++) {
        const k = ((j + off[q * 2 + 1]!) * w + i + off[q * 2]!) * 4;
        const r = data[k]!;
        const g = data[k + 1]!;
        const b = data[k + 2]!;
        ys[q] = 0.299 * r + 0.587 * g + 0.114 * b;
        cb += -0.168736 * r - 0.331264 * g + 0.5 * b;
        cr += 0.5 * r - 0.418688 * g - 0.081312 * b;
      }
      cb /= 4;
      cr /= 4;
      for (let q = 0; q < 4; q++) {
        const k = ((j + off[q * 2 + 1]!) * w + i + off[q * 2]!) * 4;
        const y = ys[q]!;
        out[k] = y + 1.402 * cr;
        out[k + 1] = y - 0.344136 * cb - 0.714136 * cr;
        out[k + 2] = y + 1.772 * cb;
        out[k + 3] = 255;
      }
    }
  return { width: w, height: h, data: out };
}

describe('vision pipeline on 4:2:0 video frames: touching pairs, the cue the only isolated ball', () => {
  it('tracks exactly the five balls (no phantom from the chroma ring)', () => {
    const base = scene('corner');
    const cam = base.camera.pos;
    const R = base.table.ballRadius;
    const balls: SynthBall[] = [{ pos: { x: -0.75, y: -0.12 }, color: BALL_COLORS.cue! }];
    for (const [cx, cy] of [
      [0.3, 0.1],
      [0.8, 0.35],
    ]) {
      const a = Math.atan2(cy! - cam.y, cx! - cam.x) + Math.PI / 2; // side by side, square to the view
      const g = R + 0.0002;
      balls.push({ pos: { x: cx! - g * Math.cos(a), y: cy! - g * Math.sin(a) }, color: BALL_COLORS.red! });
      balls.push({ pos: { x: cx! + g * Math.cos(a), y: cy! + g * Math.sin(a) }, color: BALL_COLORS.blue! });
    }
    const frame = chroma420(renderSyntheticTable({ ...base, balls }));
    const p = createPipeline({ table: base.table });
    let r = p.process(frame);
    for (let i = 1; i < 8; i++) r = p.process(frame);
    expect(r.status).toBe('locked');
    expect(r.balls.map((b) => `${b.pos.x.toFixed(2)},${b.pos.y.toFixed(2)}`)).toHaveLength(balls.length);
    expect(r.balls.filter((b) => b.isCue)).toHaveLength(1);
  });

  it('racked 15 in the end view: ball detection costs at most ~2.25× the 9-ball fixture frame’s, the pipeline stays under the cap', () => {
    // Constitution IV / SC-002: 100 ms per frame on the device. A 15-ball pack is the costliest scene for
    // the disc model; the guard is relative to the fixture frame timed interleaved with it, so a loaded
    // CI machine slows both alike, plus the same generous absolute cap as the 640×480 pipeline test.
    // The relative guard times the ball-detection stage it protects, not the whole pipeline: the
    // pipeline ratio also moves with every other stage's cost. (Wave-1 integration: the prior-first
    // table detection cut the rest of the pipeline from ≈29 to ≈12 ms per frame, so the whole-pipeline
    // ratio rose from 1.33–1.39× to 1.63–1.66× while both frames got faster: rack 69–73 → 56–63 ms,
    // fixture 51–53 → 35–38 ms.) detectBalls on the pack vs the fixture, fastest of 15 interleaved runs:
    // current detector 1.82–1.90× (alone and beside a full vitest load), the 0.3.0 detector 2.45–2.46×
    // (which this guard was written to catch).
    const base = scene('end');
    const R = base.table.ballRadius;
    const cols = ['yellow', 'blue', 'red', 'purple', 'orange', 'green', 'maroon', 'black'];
    const balls: SynthBall[] = [{ pos: { x: -0.635, y: 0.1 }, color: BALL_COLORS.cue! }];
    const g = R + 0.0001;
    let idx = 0;
    for (let row = 0; row < 5; row++)
      for (let k = 0; k <= row; k++) {
        balls.push({ pos: { x: 0.635 + row * Math.sqrt(3) * g, y: (k - row / 2) * 2 * g }, color: BALL_COLORS[cols[idx % cols.length]!]!, ...(idx >= 8 ? { stripe: true } : {}) });
        idx++;
      }
    const rack = renderSyntheticTable({ ...base, balls });
    const fix = renderSyntheticTable(base);
    const pr = createPipeline({ table: base.table });
    const pf = createPipeline({ table: base.table });
    let lr = pr.process(rack);
    let lf = pf.process(fix);
    for (let i = 1; i < 3; i++) {
      lr = pr.process(rack);
      lf = pf.process(fix);
    }
    const tr: number[] = [];
    const tf: number[] = [];
    for (let i = 0; i < 9; i++) {
      let t0 = performance.now();
      lr = pr.process(rack);
      tr.push(performance.now() - t0);
      t0 = performance.now();
      lf = pf.process(fix);
      tf.push(performance.now() - t0);
    }
    // The ball-detection stage alone, on each frame's own (pipeline) calibration and cloth, alternated
    // call by call; each frame's fastest run is its cost with the least interference from other work
    // on a shared machine (medians of 9 swung to 2.47× in a loaded full run).
    expect(lr.calibration && lr.cloth && lf.calibration && lf.cloth, 'both frames calibrated').toBeTruthy();
    const dr = () => detectBalls(rack, lr.calibration!, base.table, lr.cloth!);
    const df = () => detectBalls(fix, lf.calibration!, base.table, lf.cloth!);
    dr();
    df();
    const br: number[] = [];
    const bf: number[] = [];
    for (let i = 0; i < 15; i++) {
      let t0 = performance.now();
      dr();
      br.push(performance.now() - t0);
      t0 = performance.now();
      df();
      bf.push(performance.now() - t0);
    }
    for (const a of [tr, tf, br, bf]) a.sort((x, y) => x - y);
    console.log(
      `pipeline, end view: racked 15 median ${tr[4]!.toFixed(1)} ms, fixture ${tf[4]!.toFixed(1)} ms (×${(tr[4]! / tf[4]!).toFixed(2)}); ` +
        `detectBalls racked 15 min ${br[0]!.toFixed(1)} / median ${br[7]!.toFixed(1)} ms, fixture ${bf[0]!.toFixed(1)} / ${bf[7]!.toFixed(1)} ms (×${(br[0]! / bf[0]!).toFixed(2)} / ×${(br[7]! / bf[7]!).toFixed(2)})`,
    );
    expect(br[0]! / bf[0]!).toBeLessThan(2.25);
    expect(tr[4]!).toBeLessThan(250);
  });
});

describe('vision pipeline on 4:2:0 video frames (corner view, the fake-camera scene)', () => {
  it('locks and tracks the REAL cue ball within 3 cm', () => {
    const sc = scene('corner');
    const frame = chroma420(renderSyntheticTable(sc));
    const p = createPipeline({ table: sc.table });
    let r = p.process(frame);
    for (let i = 1; i < 8; i++) r = p.process(frame);
    expect(r.status).toBe('locked');
    expect(r.balls).toHaveLength(sc.balls.length);
    const cues = r.balls.filter((b) => b.isCue);
    expect(cues).toHaveLength(1);
    // Resolve the table's 180° symmetry from the whole layout, then check the cue's identity.
    const truth = sc.balls.map((b) => b.pos);
    const sumErr = (sign: number) => truth.reduce((a, t) => a + Math.min(...r.balls.map((b) => Math.hypot(b.pos.x - sign * t.x, b.pos.y - sign * t.y))), 0);
    const sign = sumErr(1) <= sumErr(-1) ? 1 : -1;
    const cue = cues[0]!;
    const err = Math.hypot(cue.pos.x - sign * truth[0]!.x, cue.pos.y - sign * truth[0]!.y);
    console.log(`4:2:0 corner pipeline: cue ${(err * 1000).toFixed(1)} mm from the real cue ball`);
    expect(err).toBeLessThan(0.03);
  });
});
