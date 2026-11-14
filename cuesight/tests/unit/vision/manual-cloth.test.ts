/**
 * Manual corners when the automatic table search finds no cloth (feature 002 FR-113, Snap "Tap the 4
 * corners"; also Live's Calibrate): the cloth colour is learned inside the tapped quad.
 */
import { describe, expect, it } from 'vitest';
import { makeTable } from '../../../src/core/table';
import type { Frame } from '../../../src/vision/image';
import { createPipeline } from '../../../src/vision/pipeline';
import { cameraModel, renderSyntheticTable, type RGB } from '../../../src/vision/synth/render';
import { createTableScratch, detectTable, learnClothInQuad } from '../../../src/vision/table-detect';
import { POSES, scene } from '../../helpers/scenes';

/** A green cloth quad in the left part of a grey photo: the central window sees no cloth. */
function offCentreTable(w = 640, h = 480): { frame: Frame; quad: { x: number; y: number }[] } {
  const data = new Uint8ClampedArray(w * h * 4);
  const quad = [
    { x: 20, y: 140 },
    { x: 180, y: 120 },
    { x: 190, y: 400 },
    { x: 15, y: 420 },
  ];
  const inside = (x: number, y: number) => {
    let s = 0;
    for (let i = 0; i < 4; i++) {
      const a = quad[i]!;
      const b = quad[(i + 1) % 4]!;
      const c = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
      if (c !== 0) {
        if (s === 0) s = Math.sign(c);
        else if (Math.sign(c) !== s) return false;
      }
    }
    return true;
  };
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const g = inside(x + 0.5, y + 0.5);
      data[i] = g ? 20 : 128 + ((x * 7 + y * 3) % 9);
      data[i + 1] = g ? 120 : 124;
      data[i + 2] = g ? 70 : 120;
      data[i + 3] = 255;
    }
  return { frame: { width: w, height: h, data }, quad };
}

describe('manual corners without an automatic cloth', () => {
  it('learns the cloth inside the tapped quad', () => {
    const { frame, quad } = offCentreTable();
    const sc = createTableScratch(frame.width, frame.height);
    expect(detectTable(frame, sc)).toBeNull(); // the 001 search gives up (no cloth in the centre)
    const cloth = learnClothInQuad(sc, quad);
    expect(cloth).not.toBeNull();
    expect(Math.abs(cloth!.hue - 145)).toBeLessThan(12);
    // A quad over the grey background is not cloth.
    expect(learnClothInQuad(sc, [{ x: 300, y: 100 }, { x: 600, y: 100 }, { x: 600, y: 400 }, { x: 300, y: 400 }])).toBeNull();
  });

  it('the pipeline calibrates from manual corners even when the automatic search fails', () => {
    const { frame, quad } = offCentreTable();
    const table = makeTable('pool9');
    const auto = createPipeline({ table, fovDeg: 65, manualCorners: null }).process(frame);
    expect(auto.calibration).toBeNull();
    const manual = createPipeline({ table, fovDeg: 65, manualCorners: quad }).process(frame);
    expect(manual.calibration?.source).toBe('manual');
    expect(manual.status).toBe('locked');
    expect(manual.cloth).not.toBeNull();
  });

  it('a manual quad over the grey background is not locked and has quality 0', () => {
    const { frame } = offCentreTable();
    const table = makeTable('pool9');
    const p = createPipeline({ table, fovDeg: 65, manualCorners: [{ x: 300, y: 100 }, { x: 600, y: 100 }, { x: 600, y: 400 }, { x: 300, y: 400 }] });
    for (let i = 0; i < 3; i++) {
      const r = p.process(frame);
      expect(r.status).not.toBe('locked');
      expect(r.quality).toBe(0);
      expect(r.reason).toBe('cloth-unknown');
    }
  });
});

describe('grey cloth with manual corners', () => {
  const pose = POSES.corner!;
  it.each([
    [110, 116, 124],
    [80, 86, 92],
  ] as RGB[])('cloth rgb(%i, %i, %i): exact corner taps calibrate, find the balls and lock', (r, g, b) => {
    const s = scene('corner', { cloth: [r, g, b] });
    const frame = renderSyntheticTable({ ...s, ss: 1 });
    const cam = cameraModel(pose, s.width, s.height);
    const t = s.table;
    const X = t.length / 2 + t.cushionWidth;
    const Y = t.width / 2 + t.cushionWidth;
    const corners = [
      [-X, -Y],
      [X, -Y],
      [X, Y],
      [-X, Y],
    ].map(([x, y]) => cam.project({ x: x!, y: y!, z: t.cushionHeight }));
    const p = createPipeline({ table: t, fovDeg: pose.fovDeg, manualCorners: corners });
    let res = p.process(frame);
    for (let i = 0; i < 3; i++) res = p.process(frame);
    expect(res.calibration).not.toBeNull();
    expect(res.balls.length).toBeGreaterThanOrEqual(8);
    expect(res.status).toBe('locked');
    expect(res.cloth?.kind).toBe('neutral');
  });
});
