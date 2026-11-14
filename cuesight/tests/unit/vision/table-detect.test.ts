import { describe, expect, it } from 'vitest';
import { cameraModel, renderSyntheticTable, type RGB } from '../../../src/vision/synth/render';
import { detectTable } from '../../../src/vision/table-detect';
import { POSES, scene } from '../../helpers/scenes';

const CLOTHS: Record<string, RGB> = { green: [40, 130, 70], blue: [30, 80, 160], red: [150, 30, 40] };

function trueCorners(pose: keyof typeof POSES) {
  const s = scene(pose);
  const cam = cameraModel(s.camera, s.width, s.height);
  const t = s.table;
  const X = t.length / 2 + t.cushionWidth;
  const Y = t.width / 2 + t.cushionWidth;
  return [
    [-X, -Y],
    [X, -Y],
    [X, Y],
    [-X, Y],
  ].map(([x, y]) => cam.project({ x: x!, y: y!, z: t.cushionHeight }));
}

describe('table detection on synthetic renders', () => {
  const cases: [keyof typeof POSES, string][] = [
    ['end', 'green'],
    ['side', 'green'],
    ['corner', 'green'],
    ['overhead', 'green'],
    ['side', 'blue'],
    ['corner', 'red'],
  ];
  it.each(cases)('%s view, %s cloth: corners within 1.5%% of the diagonal', (pose, cloth) => {
    const frame = renderSyntheticTable({ ...scene(pose, { cloth: CLOTHS[cloth]! }), ss: 1 });
    const det = detectTable(frame);
    expect(det).not.toBeNull();
    const truth = trueCorners(pose);
    const diag = Math.hypot(frame.width, frame.height);
    const errs = truth.map((t) => Math.min(...det!.corners.map((c) => Math.hypot(c.x - t.x, c.y - t.y))));
    console.log(`${pose}/${cloth}: corner errors px ${errs.map((e) => e.toFixed(1)).join(', ')} (quality ${det!.quality.toFixed(2)})`);
    for (const e of errs) expect(e / diag).toBeLessThan(0.015);
    expect(det!.quality).toBeGreaterThan(0.7);
  });

  it('returns null when there is no table', () => {
    const frame = renderSyntheticTable({ ...scene('end'), camera: { pos: { x: 0, y: 0, z: 3 }, target: { x: 0, y: 0, z: 6 }, fovDeg: 60 }, ss: 1 });
    expect(detectTable(frame)).toBeNull();
  });
});
