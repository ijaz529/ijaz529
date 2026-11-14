import { describe, expect, it } from 'vitest';
import { makeTable } from '../../../src/core/table';
import { calibrationFromCorners } from '../../../src/vision/calibration';
import { applyH, estimateFocal, homographyFrom4, intrinsics, invert3, planeHomography, poseFromHomography } from '../../../src/vision/homography';
import { cameraModel } from '../../../src/vision/synth/render';
import { POSES } from '../../helpers/scenes';

const W = 640;
const H = 480;

describe('homography', () => {
  it('4-point DLT maps the points exactly and inverts', () => {
    const src = [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 1 }, { x: 0, y: 1 }];
    const dst = [{ x: 100, y: 400 }, { x: 540, y: 410 }, { x: 420, y: 150 }, { x: 210, y: 140 }];
    const Hm = homographyFrom4(src, dst);
    for (let i = 0; i < 4; i++) {
      const p = applyH(Hm, src[i]!.x, src[i]!.y);
      expect(p.x).toBeCloseTo(dst[i]!.x, 6);
      expect(p.y).toBeCloseTo(dst[i]!.y, 6);
    }
    const back = applyH(invert3(Hm), 420, 150);
    expect(back.x).toBeCloseTo(2, 6);
    expect(back.y).toBeCloseTo(1, 6);
  });

  it.each(['end', 'side', 'corner'])('recovers focal length within 3%% and plane-at-height homographies (%s)', (pose) => {
    const cam = cameraModel(POSES[pose]!, W, H);
    const H0 = cam.planeH(0);
    const fe = estimateFocal(H0, W / 2, H / 2);
    expect(Math.abs(fe.f - cam.f) / cam.f).toBeLessThan(0.03);
    expect(fe.constraints).toBeGreaterThan(0);
    expect(fe.inconsistency).toBeLessThan(0.05);
    const K = intrinsics(fe.f, W / 2, H / 2);
    const p = poseFromHomography(H0, K);
    expect(p.camera.z).toBeCloseTo(POSES[pose]!.pos.z, 1);
    const HR = planeHomography(H0, K, p, 0.03);
    const truth = cam.planeH(0.03);
    for (const [x, y] of [[0, 0], [1, 0.5], [-1.2, -0.6]] as const) {
      const a = applyH(HR, x, y);
      const b = applyH(truth, x, y);
      expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(0.5);
    }
  });

  it('calibrationFromCorners recovers H0 from the outer cloth-edge corners (any input order)', () => {
    const t = makeTable('pool9');
    for (const pose of ['end', 'side', 'corner'] as const) {
      const cam = cameraModel(POSES[pose]!, W, H);
      const Lo = t.length + 2 * t.cushionWidth;
      const Wo = t.width + 2 * t.cushionWidth;
      const z = t.cushionHeight;
      const corners = [
        cam.project({ x: Lo / 2, y: Wo / 2, z }),
        cam.project({ x: -Lo / 2, y: -Wo / 2, z }),
        cam.project({ x: -Lo / 2, y: Wo / 2, z }),
        cam.project({ x: Lo / 2, y: -Wo / 2, z }),
      ];
      const cal = calibrationFromCorners(corners, t, W, H)!;
      expect(cal.focalSource).toBe('estimated');
      const truth = cam.planeH(0);
      // Compare up to the table's 180° symmetry.
      const err = (sign: number) =>
        Math.max(...[[0.5, 0.2], [-1.0, 0.4], [1.1, -0.5]].map(([x, y]) => {
          const a = applyH(cal.H0, sign * x!, sign * y!);
          const b = applyH(truth, x!, y!);
          return Math.hypot(a.x - b.x, a.y - b.y);
        }));
      expect(Math.min(err(1), err(-1))).toBeLessThan(1);
    }
  });
});
