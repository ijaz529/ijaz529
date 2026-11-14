/**
 * calibrationFromCorners under realistic corner noise and bad taps (Constitution II: a wrong frame
 * drawn with confidence is worse than none). Exact corners are projected from the synthetic camera;
 * noise is seeded so every run sees the same trials.
 */
import { describe, expect, it } from 'vitest';
import { makeTable } from '../../../src/core/table';
import type { Vec2 } from '../../../src/core/vec';
import { calibrationFromCorners, type Calibration } from '../../../src/vision/calibration';
import { applyH, invert3 } from '../../../src/vision/homography';
import { cameraModel, fixtureBalls, type SynthCamera } from '../../../src/vision/synth/render';
import { POSES } from '../../helpers/scenes';

const W = 640;
const H = 480;
const table = makeTable('pool9');
const X = table.length / 2 + table.cushionWidth;
const Y = table.width / 2 + table.cushionWidth;

/** Outer cloth-edge corners in table order (−x,−y), (+x,−y), (+x,+y), (−x,+y). */
function corners(cam: SynthCamera): Vec2[] {
  const m = cameraModel(cam, W, H);
  return [
    [-X, -Y],
    [X, -Y],
    [X, Y],
    [-X, Y],
  ].map(([x, y]) => m.project({ x: x!, y: y!, z: table.cushionHeight }));
}

/** mulberry32: small deterministic PRNG. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());

/** Where the calibration puts the true table point (x, y) on the bed. */
function mapBack(cal: Calibration, cam: SynthCamera, x: number, y: number): Vec2 {
  const px = cameraModel(cam, W, H).project({ x, y, z: 0 });
  return applyH(invert3(cal.H0), px.x, px.y);
}

/** True when the calibration swapped the long and short rails (table (1, 0) lands near (0, ±0.5)). */
function swapped(cal: Calibration, cam: SynthCamera): boolean {
  const p = mapBack(cal, cam, 1, 0);
  return Math.min(Math.hypot(p.x, p.y - 0.5), Math.hypot(p.x, p.y + 0.5)) < 0.3;
}

describe('long/short rail assignment under corner noise', () => {
  const yawedEnd: SynthCamera = { ...POSES.end!, target: { ...POSES.end!.target, y: 0.15 } };
  const cases: [string, SynthCamera, 'uniform' | 'gauss', number][] = [
    ['end view, uniform ±1.5 px', POSES.end!, 'uniform', 1.5],
    ['end view, Gaussian σ = 1 px', POSES.end!, 'gauss', 1],
    ['yawed end view, Gaussian σ = 0.5 px', yawedEnd, 'gauss', 0.5],
  ];
  it.each(cases)('%s: no trial swaps the rails (500 seeded trials)', (_name, cam, kind, s) => {
    const exact = corners(cam);
    const r = rng(1234);
    let swaps = 0;
    let none = 0;
    for (let trial = 0; trial < 500; trial++) {
      const noisy = exact.map((p) =>
        kind === 'uniform' ? { x: p.x + (2 * r() - 1) * s, y: p.y + (2 * r() - 1) * s } : { x: p.x + gauss(r) * s, y: p.y + gauss(r) * s },
      );
      const cal = calibrationFromCorners(noisy, table, W, H, { fovDeg: 65 });
      if (!cal) {
        none++;
        continue;
      }
      if (swapped(cal, cam)) swaps++;
    }
    expect(none).toBe(0);
    expect(swaps).toBe(0);
  });

  it('the corners that used to swap the rails (≤ 1.73 px from the truth) choose the correct assignment', () => {
    const noisy = [
      { x: 495.9, y: 429.6 },
      { x: 399.5, y: 168.1 },
      { x: 240.3, y: 170.5 },
      { x: 143.8, y: 429.3 },
    ];
    const cal = calibrationFromCorners(noisy, table, W, H, { fovDeg: 65 })!;
    expect(cal).not.toBeNull();
    expect(swapped(cal, POSES.end!)).toBe(false);
    const p = mapBack(cal, POSES.end!, 1, 0);
    expect(Math.hypot(Math.abs(p.x) - 1, p.y)).toBeLessThan(0.1);
  });

  it.each(['side', 'overhead', 'corner'] as const)('%s view: exact corners keep the true frame and an estimated focal', (pose) => {
    const cam = POSES[pose]!;
    const cal = calibrationFromCorners(corners(cam), table, W, H, { fovDeg: 65 })!;
    expect(cal).not.toBeNull();
    for (const [x, y] of [
      [1, 0.3],
      [-0.8, -0.4],
    ] as const) {
      const p = mapBack(cal, cam, x, y);
      expect(Math.hypot(p.x - x, p.y - y)).toBeLessThan(0.01);
    }
  });

  it('swapAxes is an absolute override: it always gives the other assignment, frame after frame', () => {
    const exact = corners(POSES.end!);
    const r = rng(77);
    let prev: Vec2[] | undefined;
    for (let i = 0; i < 50; i++) {
      const noisy = exact.map((p) => ({ x: p.x + gauss(r) * 0.7, y: p.y + gauss(r) * 0.7 }));
      const cal = calibrationFromCorners(noisy, table, W, H, { fovDeg: 65, swapAxes: true, ...(prev ? { prev } : {}) })!;
      expect(swapped(cal, POSES.end!)).toBe(true);
      prev = cal.corners;
    }
  });
});

describe('0°/180° frame choice', () => {
  /** +1 when the calibration's +x is the true +x, −1 when the frame is turned 180°. */
  const sign = (cal: Calibration, cam: SynthCamera) => Math.sign(mapBack(cal, cam, 1, 0.3).x);

  it('end view with ±1 mm sideways sway and σ = 0.3 px noise: the same orientation in every trial, and stable with prev', () => {
    const r = rng(99);
    const signsNoPrev = new Set<number>();
    let flips = 0;
    let prev: Vec2[] | undefined;
    let last = 0;
    for (let trial = 0; trial < 200; trial++) {
      const sway = (2 * r() - 1) * 0.001;
      const cam: SynthCamera = { ...POSES.end!, pos: { ...POSES.end!.pos, y: sway }, target: { ...POSES.end!.target, y: sway } };
      const noisy = corners(cam).map((p) => ({ x: p.x + gauss(r) * 0.3, y: p.y + gauss(r) * 0.3 }));
      const a = calibrationFromCorners(noisy, table, W, H, { fovDeg: 65 })!;
      signsNoPrev.add(sign(a, cam));
      const b = calibrationFromCorners(noisy, table, W, H, { fovDeg: 65, ...(prev ? { prev } : {}) })!;
      const s = sign(b, cam);
      if (last && s !== last) flips++;
      last = s;
      prev = b.corners;
    }
    expect([...signsNoPrev]).toEqual([1]); // first lock: the camera sits at the −x end in end views
    expect(flips).toBe(0);
  });

  it.each(['side', 'corner', 'overhead', 'end'] as const)('first lock (%s view) uses the true frame, not a 180° turn', (pose) => {
    const cam = POSES[pose]!;
    const cal = calibrationFromCorners(corners(cam), table, W, H, { fovDeg: 65 })!;
    expect(sign(cal, cam)).toBe(1);
  });

  it('with prev, the frame follows the previous corners even when the image-x rule would flip it', () => {
    const cam = POSES.end!;
    const exact = corners(cam);
    // Previous calibration turned 180° (e.g. locked from the other end): continuity keeps it.
    const turned = [exact[2]!, exact[3]!, exact[0]!, exact[1]!];
    const cal = calibrationFromCorners(exact, table, W, H, { fovDeg: 65, prev: turned })!;
    expect(sign(cal, cam)).toBe(-1);
    for (let k = 0; k < 4; k++) expect(Math.hypot(cal.corners[k]!.x - turned[k]!.x, cal.corners[k]!.y - turned[k]!.y)).toBeLessThan(1e-6);
  });
});

describe('quad validation (bad taps)', () => {
  const balls = fixtureBalls(table).balls;
  for (const pose of ['side', 'corner'] as const) {
    const cam = POSES[pose]!;
    const c = corners(cam);
    const m = cameraModel(cam, W, H);
    const centre = m.project({ x: 0, y: 0, z: 0 });
    const mid01 = { x: (c[0]!.x + c[1]!.x) / 2, y: (c[0]!.y + c[1]!.y) / 2 };
    const cue = m.project({ x: balls[0]!.pos.x, y: balls[0]!.pos.y, z: table.ballRadius });
    const bad: [string, Vec2[]][] = [
      ['a corner tapped twice', [c[0]!, c[1]!, c[1]!, c[3]!]],
      ['three collinear taps', [c[0]!, mid01, c[1]!, c[3]!]],
      ['a concave 4th tap inside the table', [c[0]!, c[1]!, c[2]!, centre]],
      ['the cue ball tapped instead of a corner', [c[0]!, c[1]!, cue, c[3]!]],
    ];
    it.each(bad)(`${pose} view: %s → null`, (_name, taps) => {
      expect(calibrationFromCorners(taps, table, W, H, { fovDeg: 65, source: 'manual' })).toBeNull();
    });
    it(`${pose} view: the correct taps still calibrate`, () => {
      const cal = calibrationFromCorners([c[2]!, c[0]!, c[3]!, c[1]!], table, W, H, { fovDeg: 65, source: 'manual' });
      expect(cal).not.toBeNull();
      expect(cal!.camera.z).toBeGreaterThan(1);
    });
  }
});

describe('field of view from settings', () => {
  it.each([0, Number.NaN, -10, 179, Number.POSITIVE_INFINITY])('fovDeg %s behaves like the 65° default (finite focal)', (fov) => {
    // Overhead: neither focal constraint is usable, so the assumed fov decides the focal length.
    const c = corners(POSES.overhead!);
    const ref = calibrationFromCorners(c, table, W, H, { fovDeg: 65 })!;
    const cal = calibrationFromCorners(c, table, W, H, { fovDeg: fov })!;
    expect(cal).not.toBeNull();
    expect(Number.isFinite(cal.focal)).toBe(true);
    expect(cal.focal).toBeCloseTo(ref.focal, 6);
    for (let i = 0; i < 9; i++) expect(cal.H0[i]!).toBeCloseTo(ref.H0[i]!, 6);
  });
});
