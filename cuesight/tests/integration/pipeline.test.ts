import { describe, expect, it } from 'vitest';
import { cameraModel, renderSyntheticTable } from '../../src/vision/synth/render';
import { createPipeline } from '../../src/vision/pipeline';
import { scene } from '../helpers/scenes';

describe('vision pipeline (synthetic camera feed)', () => {
  const sc = scene('corner');
  const frame = renderSyntheticTable(sc);

  it('locks within a few frames and reports the full layout with the cue ball', () => {
    const p = createPipeline({ table: sc.table });
    let r = p.process(frame);
    for (let i = 0; i < 7; i++) r = p.process(frame);
    expect(r.status).toBe('locked');
    expect(r.calibration).not.toBeNull();
    expect(r.balls).toHaveLength(sc.balls.length);
    expect(r.balls.filter((b) => b.isCue)).toHaveLength(1);
    const times: number[] = [];
    for (let i = 0; i < 5; i++) times.push(p.process(frame).ms);
    times.sort((a, b) => a - b);
    console.log(`pipeline 640×480: median ${times[2]!.toFixed(1)} ms/frame`);
    expect(times[2]!).toBeLessThan(250); // device budget 100 ms (≥10 Hz); generous CI guard
  });

  it('works from four manually tapped corners (manual calibration)', () => {
    const cam = cameraModel(sc.camera, sc.width, sc.height);
    const t = sc.table;
    const X = t.length / 2 + t.cushionWidth;
    const Y = t.width / 2 + t.cushionWidth;
    const corners = [
      [X, Y],
      [-X, Y],
      [-X, -Y],
      [X, -Y],
    ].map(([x, y]) => cam.project({ x: x!, y: y!, z: t.cushionHeight }));
    const p = createPipeline({ table: t, manualCorners: corners });
    p.process(frame);
    const r = p.process(frame);
    expect(r.status).toBe('locked');
    expect(r.calibration!.source).toBe('manual');
    expect(r.balls.length).toBe(sc.balls.length);
  });
});
