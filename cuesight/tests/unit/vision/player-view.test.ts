import { describe, expect, it } from 'vitest';
import { makeTable } from '../../../src/core/table';
import { createFrame } from '../../../src/vision/image';
import { estimatePlayerView, projectBallOutline, projectPoint, strikePoint, type CameraPose, type KnownBall } from '../../../src/vision/player-view';
import { cameraModel, playerViewCamera, type SynthCamera } from '../../../src/vision/synth/render';

/** Ground-truth CameraPose of a synthetic camera (same convention as the estimator's output). */
function poseOf(cam: SynthCamera, width: number, height: number): CameraPose {
  const m = cameraModel(cam, width, height);
  const R = [m.R[0].x, m.R[0].y, m.R[0].z, m.R[1].x, m.R[1].y, m.R[1].z, m.R[2].x, m.R[2].y, m.R[2].z];
  const C = m.C;
  const t = { x: -(R[0]! * C.x + R[1]! * C.y + R[2]! * C.z), y: -(R[3]! * C.x + R[4]! * C.y + R[5]! * C.z), z: -(R[6]! * C.x + R[7]! * C.y + R[8]! * C.z) };
  return { R, t, f: m.f, cx: width / 2, cy: height / 2, width, height };
}

/** A camera at the origin looking along world +x (right = −y, down = −z). */
const axisPose: CameraPose = { R: [0, -1, 0, 0, 0, -1, 1, 0, 0], t: { x: 0, y: 0, z: 0 }, f: 800, cx: 480, cy: 360, width: 960, height: 720 };

describe('projectPoint', () => {
  it('maps the optical axis to the principal point and returns null behind the camera', () => {
    const p = projectPoint(axisPose, { x: 2, y: 0, z: 0 })!;
    expect(p.x).toBeCloseTo(480, 9);
    expect(p.y).toBeCloseTo(360, 9);
    expect(projectPoint(axisPose, { x: -1, y: 0.2, z: 0.1 })).toBeNull();
    expect(projectPoint(axisPose, { x: 0, y: 0.2, z: 0.1 })).toBeNull();
    // +y (left in the world) projects left of centre, +z (up) above it.
    const q = projectPoint(axisPose, { x: 2, y: 0.5, z: 0.25 })!;
    expect(q.x).toBeCloseTo(480 - 800 * 0.25, 9);
    expect(q.y).toBeCloseTo(360 - 800 * 0.125, 9);
  });

  it('agrees with the synthetic camera model', () => {
    const cam: SynthCamera = { pos: { x: -1.5, y: -0.3, z: 0.3 }, target: { x: 0.4, y: 0.2, z: 0 }, fovDeg: 65 };
    const pose = poseOf(cam, 960, 720);
    const m = cameraModel(cam, 960, 720);
    for (const p of [
      { x: 0, y: 0, z: 0 },
      { x: 0.8, y: -0.4, z: 0.03 },
      { x: -0.9, y: 0.1, z: 0.02 },
    ]) {
      const a = projectPoint(pose, p)!;
      const b = m.project(p);
      expect(a.x).toBeCloseTo(b.x, 6);
      expect(a.y).toBeCloseTo(b.y, 6);
    }
  });
});

describe('projectBallOutline', () => {
  it('has radius f·R/√(d² − R²) for a sphere on the optical axis', () => {
    const R = 0.028575;
    for (const d of [0.3, 0.75, 2.4]) {
      const pts = projectBallOutline(axisPose, { x: d, y: 0, z: 0 }, R);
      expect(pts).toHaveLength(48);
      const want = (axisPose.f * R) / Math.sqrt(d * d - R * R);
      for (const p of pts) expect(Math.abs(Math.hypot(p.x - 480, p.y - 360) - want)).toBeLessThan(0.1);
    }
    expect(projectBallOutline(axisPose, { x: 1, y: 0, z: 0 }, R, 12)).toHaveLength(12);
  });

  it('is empty when the camera is inside or in front of the sphere', () => {
    expect(projectBallOutline(axisPose, { x: 0.01, y: 0, z: 0 }, 0.03)).toEqual([]);
    expect(projectBallOutline(axisPose, { x: -1, y: 0, z: 0 }, 0.03)).toEqual([]);
  });

  it('every outline point is a tangent ray of the sphere (exact silhouette off-axis)', () => {
    const R = 0.028575;
    const c = { x: 0.6, y: 0.35, z: -0.2 };
    const pts = projectBallOutline(axisPose, c, R, 32);
    expect(pts).toHaveLength(32);
    for (const p of pts) {
      // Back-project the pixel to a ray from the origin; its distance to the centre must equal R.
      const xn = (p.x - 480) / 800;
      const yn = (p.y - 360) / 800;
      // camera (xn, yn, 1) → world: right = −y, down = −z, forward = +x
      const d = { x: 1, y: -xn, z: -yn };
      const L = Math.hypot(d.x, d.y, d.z);
      const u = { x: d.x / L, y: d.y / L, z: d.z / L };
      const proj = c.x * u.x + c.y * u.y + c.z * u.z;
      const dist = Math.sqrt(c.x ** 2 + c.y ** 2 + c.z ** 2 - proj * proj);
      expect(Math.abs(dist - R)).toBeLessThan(1e-9);
    }
  });
});

describe('strikePoint', () => {
  const R = 0.028575;
  const c = { x: 0.2, y: -0.1, z: R };
  const dir = { x: 0.6, y: 0.8 };

  it('is the back pole for a centre-ball hit', () => {
    const p = strikePoint(c, dir, 0, 0, R);
    expect(p.x).toBeCloseTo(c.x - R * 0.6, 12);
    expect(p.y).toBeCloseTo(c.y - R * 0.8, 12);
    expect(p.z).toBeCloseTo(R, 12);
  });

  it('stays on the sphere for every offset inside the miscue limit and clamps beyond it', () => {
    for (const [s, v] of [
      [0.5, 0],
      [0, -0.5],
      [0.3, 0.3],
      [-0.25, 0.4],
      [0.9, 0.9],
    ] as const) {
      const p = strikePoint(c, { x: 3, y: 4 }, s, v, R);
      expect(Math.hypot(p.x - c.x, p.y - c.y, p.z - c.z)).toBeCloseTo(R, 12);
    }
    // Clamped radially to 0.5 R.
    const p = strikePoint(c, dir, 0.9, 0.9, R);
    const right = { x: dir.y, y: -dir.x };
    const side = ((p.x - c.x) * right.x + (p.y - c.y) * right.y) / R;
    const vert = (p.z - c.z) / R;
    expect(Math.hypot(side, vert)).toBeCloseTo(0.5, 9);
    expect(side).toBeCloseTo(vert, 9);
  });

  it('moves to the shooter’s right for right english and up for follow', () => {
    const p = strikePoint(c, { x: 1, y: 0 }, 0.4, 0, R);
    expect(p.y).toBeLessThan(c.y); // facing +x, the right hand side is −y
    const q = strikePoint(c, { x: 1, y: 0 }, 0, 0.4, R);
    expect(q.z).toBeGreaterThan(c.z);
    const r = strikePoint(c, { x: 1, y: 0 }, 0, -0.4, R);
    expect(r.z).toBeLessThan(c.z);
    // Seen by a camera behind the ball, the dot is right of / above the ball centre.
    const cam = playerViewCamera({ cue: { x: c.x, y: c.y }, aimAt: { x: c.x + 1, y: c.y }, distance: 0.5, height: 0.25, fovDeg: 65, imageWidth: 960, imageHeight: 720, ballRadius: R });
    const pose = poseOf(cam, 960, 720);
    const pc = projectPoint(pose, strikePoint(c, { x: 1, y: 0 }, 0, 0, R))!;
    expect(projectPoint(pose, p)!.x).toBeGreaterThan(pc.x + 5);
    expect(projectPoint(pose, q)!.y).toBeLessThan(pc.y - 5);
    expect(projectPoint(pose, r)!.y).toBeGreaterThan(pc.y + 5);
  });
});

describe('estimatePlayerView input validation', () => {
  const table = makeTable('pool9');
  const balls: KnownBall[] = [
    { id: 'cue', pos: { x: -0.7, y: 0 }, isCue: true },
    { id: 'b1', pos: { x: 0.3, y: 0.1 }, isCue: false },
  ];

  it('refuses an empty frame or an inconsistent cue id with a player-facing reason', () => {
    const empty = estimatePlayerView({ frame: createFrame(0, 0), table, balls, cueId: 'cue' });
    expect(empty.ok).toBe(false);
    expect(empty.reason).toMatch(/line up this photo/);
    const wrongCue = estimatePlayerView({ frame: createFrame(64, 48), table, balls, cueId: 'b1' });
    expect(wrongCue.ok).toBe(false);
    expect(wrongCue.reason).toBeTruthy();
    expect(wrongCue.pose).toBeNull();
  });

  it('says the photo is too dark when there is no cloth to read', () => {
    const r = estimatePlayerView({ frame: createFrame(160, 120), table, balls, cueId: 'cue' });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/too dark/);
    expect(r.ms).toBeGreaterThanOrEqual(0);
  });
});
