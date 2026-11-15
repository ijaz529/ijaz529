import { describe, expect, it } from 'vitest';
import { makeTable } from '../../../src/core/table';
import {
  USER_PITCH_MAX,
  USER_PITCH_MIN,
  broadcastOrbit,
  cameraMatrices,
  clampUserOrbit,
  insetShift,
  lerpOrbit,
  orbitBasis,
  overviewOrbit,
  playerOrbit,
  PLAYER_BACK,
  PLAYER_EYE_HEIGHT,
  tableFramePoints,
} from '../../../src/app/render3d/camera';
import { tableGeom } from '../../../src/app/render3d/geom';
import { project, type V3 } from '../../../src/app/render3d/math3d';
import { cuePose } from '../../../src/app/render3d/scene-data';

const table = makeTable('pool9');
const g = tableGeom(table);

function ndc(o: ReturnType<typeof overviewOrbit>, aspect: number, p: V3, shift: [number, number] = [0, 0]) {
  const m = cameraMatrices(o, aspect, shift);
  const q = project(m.vp, p, 2, 2)!;
  return { x: q.x - 1, y: 1 - q.y };
}

describe('render3d camera presets', () => {
  it('overview looks straight down with the long axis along the long screen axis', () => {
    for (const aspect of [1280 / 800, 390 / 844]) {
      const o = overviewOrbit(g, aspect);
      expect(o.pitch).toBeCloseTo(Math.PI / 2, 6);
      const c = ndc(o, aspect, [0, 0, 0]);
      const xEnd = ndc(o, aspect, [g.hx, 0, 0]);
      const yEnd = ndc(o, aspect, [0, g.hy, 0]);
      // Measure in pixels to compare axes fairly.
      const W = aspect >= 1 ? aspect : 1;
      const H = aspect >= 1 ? 1 : 1 / aspect;
      const along = (p: { x: number; y: number }) => ({ h: Math.abs(p.x - c.x) * W, v: Math.abs(p.y - c.y) * H });
      const ax = along(xEnd);
      if (aspect >= 1) {
        expect(ax.h).toBeGreaterThan(10 * ax.v); // table x runs horizontally
        expect(yEnd.y).toBeGreaterThan(c.y); // +y is up (like the 2D view)
        expect(xEnd.x).toBeGreaterThan(c.x); // +x is right
      } else {
        expect(ax.v).toBeGreaterThan(10 * ax.h); // table x runs vertically on a portrait screen
        expect(xEnd.y).toBeGreaterThan(c.y); // +x is up
      }
      expect(Math.hypot(c.x, c.y)).toBeLessThan(1e-6);
    }
  });

  it('frames the whole table snugly for overview and broadcast', () => {
    for (const aspect of [1280 / 800, 390 / 844]) {
      for (const o of [overviewOrbit(g, aspect), broadcastOrbit(g, aspect)]) {
        let maxExtent = 0;
        for (const p of tableFramePoints(g)) {
          const q = ndc(o, aspect, p);
          expect(Math.abs(q.x)).toBeLessThanOrEqual(1);
          expect(Math.abs(q.y)).toBeLessThanOrEqual(1);
          maxExtent = Math.max(maxExtent, Math.abs(q.x), Math.abs(q.y));
        }
        expect(maxExtent).toBeGreaterThan(0.9);
      }
    }
  });

  it('keeps the table above a bottom inset (bottom sheet)', () => {
    const aspect = 390 / 844;
    const ins = { top: 0.06, right: 0, bottom: 0.3, left: 0 };
    const o = overviewOrbit(g, aspect, ins);
    for (const p of tableFramePoints(g)) {
      const q = ndc(o, aspect, p, insetShift(ins));
      expect(q.y).toBeGreaterThan(-1 + 2 * ins.bottom - 1e-6);
      expect(q.y).toBeLessThan(1 - 2 * ins.top + 1e-6);
    }
  });

  it('player view: eye low behind the cue ball, looking down the aim line', () => {
    const cue = { x: -0.5, y: -0.1 };
    const aim = { x: 0.8, y: 0.6 };
    const ghost = { x: 0.3, y: 0.5 };
    const aspect = 1280 / 800;
    const o = playerOrbit(g, cue, aim, ghost, aspect);
    const b = orbitBasis(o);
    expect(b.eye[2]).toBeCloseTo(PLAYER_EYE_HEIGHT, 6);
    expect(PLAYER_EYE_HEIGHT).toBeLessThan(0.3); // lower than the 001 view (0.3 m): down on the shot
    const back = { x: cue.x - b.eye[0], y: cue.y - b.eye[1] };
    expect(Math.hypot(back.x, back.y)).toBeCloseTo(PLAYER_BACK, 6);
    expect((back.x * aim.x + back.y * aim.y) / Math.hypot(back.x, back.y)).toBeCloseTo(1, 6);
    // Looking along the aim (horizontally) and slightly down.
    const fh = Math.hypot(b.forward[0], b.forward[1]);
    expect((b.forward[0] * aim.x + b.forward[1] * aim.y) / fh).toBeGreaterThan(0.999);
    expect(b.forward[2]).toBeLessThan(0);
    expect((o.fovY * 180) / Math.PI).toBeCloseTo(50, 6);
    // Both the cue ball and the ghost ball are in frame, cue ball lower on screen.
    const qc = ndc(o, aspect, [cue.x, cue.y, g.R]);
    const qg = ndc(o, aspect, [ghost.x, ghost.y, g.R]);
    for (const q of [qc, qg]) expect(Math.max(Math.abs(q.x), Math.abs(q.y))).toBeLessThan(0.95);
    expect(qc.y).toBeLessThan(qg.y);
  });

  it('player view with the cue ball frozen to a rail: the eye stays behind the ball, above the rail and the raised cue (spec edge case)', () => {
    // Cue ball against the top cushion, shooting away from it (the cue must clear the rail).
    const cue = { x: 0.2, y: g.hy - g.R };
    const aim = { x: 0.3, y: -1 };
    const ghost = { x: 0.45, y: -0.2 };
    const pose = cuePose(g, cue, aim, { power: 5, side: 0, vert: 0 });
    expect(pose.elevation, 'the cue is raised over the rail').toBeGreaterThan((5 * Math.PI) / 180);
    const o = playerOrbit(g, cue, aim, ghost, 852 / 393, { cueElevation: pose.elevation });
    const b = orbitBasis(o);
    const al = Math.hypot(aim.x, aim.y);
    const back = { x: cue.x - b.eye[0], y: cue.y - b.eye[1] };
    const dBack = Math.hypot(back.x, back.y);
    expect((back.x * aim.x + back.y * aim.y) / (dBack * al), 'behind the cue ball, down the aim line').toBeGreaterThan(0.999);
    expect(b.eye[2], 'above the rail top').toBeGreaterThan(g.railTop + 0.05);
    // Above the cue's own line at the eye's distance (the chin over the cue).
    expect(b.eye[2]).toBeGreaterThan(pose.strike[2] + Math.tan(pose.elevation) * dBack);
    // The cue ball's top half is seen over the cushion: the sight line to the top of the ball clears
    // the cushion where it crosses the nose line.
    const top: V3 = [cue.x, cue.y, 2 * g.R];
    const s = (g.hy - cue.y) / (b.eye[1] - cue.y);
    expect(top[2] + (b.eye[2] - top[2]) * s).toBeGreaterThan(g.cushionTop);
    // And the ball is in frame.
    const q = ndc(o, 852 / 393, [cue.x, cue.y, g.R]);
    expect(Math.max(Math.abs(q.x), Math.abs(q.y))).toBeLessThan(1);
  });

  it('player view keeps the target pocket and the object-ball path end clear of the controls', () => {
    // Portrait phone, the view-control rail covering the right 18 % and the sheet the bottom 25 %.
    const aspect = 393 / 852;
    const ins = { top: 0.08, right: 0.18, bottom: 0.25, left: 0 };
    // A cut to the shooter's right: the pocket is ~20° right of the aim line.
    const cue = { x: -0.5, y: 0 };
    const ghost = { x: 0.3, y: 0.05 };
    const aim = { x: ghost.x - cue.x, y: ghost.y - cue.y };
    const pocket: V3 = [g.hx, -g.hy, 0];
    const obEnd: V3 = [g.hx - 0.05, -g.hy + 0.05, g.R];
    const plain = playerOrbit(g, cue, aim, ghost, aspect);
    const fitted = playerOrbit(g, cue, aim, ghost, aspect, { keep: [pocket, obEnd], insets: ins });
    const inside = (o: typeof plain, p: V3, m = 0) => {
      const q = ndc(o, aspect, p, insetShift(ins));
      return q.x >= -1 + 2 * ins.left + m && q.x <= 1 - 2 * ins.right - m && q.y >= -1 + 2 * ins.bottom + m && q.y <= 1 - 2 * ins.top - m;
    };
    expect(inside(plain, pocket)).toBe(false); // the plain view loses the pocket under the rail
    for (const p of [pocket, obEnd, [cue.x, cue.y, g.R] as V3]) expect(inside(fitted, p, 0.05)).toBe(true);
    // Still a player view: behind the cue ball, low, looking roughly down the aim line.
    const b = orbitBasis(fitted);
    expect(b.eye[2]).toBeLessThan(0.45);
    const fh = Math.hypot(b.forward[0], b.forward[1]);
    const al = Math.hypot(aim.x, aim.y);
    expect((b.forward[0] * aim.x + b.forward[1] * aim.y) / (fh * al)).toBeGreaterThan(Math.cos(0.56));
  });

  it('interpolates orbits along the shortest yaw and clamps user pitch', () => {
    const a = { target: [0, 0, 0] as V3, yaw: 3.0, pitch: 0.5, dist: 1, fovY: 0.8 };
    const b = { target: [1, 0, 0] as V3, yaw: -3.0, pitch: 1.0, dist: 4, fovY: 1.0 };
    const m = lerpOrbit(a, b, 0.5);
    expect(Math.cos(m.yaw)).toBeLessThan(-0.99); // passed through π, not 0
    expect(m.dist).toBeCloseTo(2, 9); // log-space zoom
    expect(lerpOrbit(a, b, 1).target[0]).toBe(1);
    const c = clampUserOrbit({ ...a, pitch: 2, dist: 100, target: [10, -10, 0] }, g);
    expect(c.pitch).toBe(USER_PITCH_MAX);
    expect(clampUserOrbit({ ...a, pitch: 0 }, g).pitch).toBe(USER_PITCH_MIN);
    expect(c.target[0]).toBeCloseTo(g.outerX, 9);
    expect(c.target[1]).toBeCloseTo(-g.outerY, 9);
  });
});
