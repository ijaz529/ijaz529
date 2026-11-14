import { describe, expect, it } from 'vitest';
import { makeTable } from '../../../src/core/table';
import { broadcastOrbit, cameraMatrices, overviewOrbit, pixelAtUnit, playerOrbit } from '../../../src/app/render3d/camera';
import { tableGeom } from '../../../src/app/render3d/geom';
import { project, screenRay, type V3 } from '../../../src/app/render3d/math3d';
import { pickRay, type PickBall, type PickPocket } from '../../../src/app/render3d/picking';

const table = makeTable('pool9');
const g = tableGeom(table);
const R = table.ballRadius;
const W = 800;
const H = 600;

const pockets: PickPocket[] = table.pockets.map((p) => ({ id: p.id, x: p.mouthCenter.x, y: p.mouthCenter.y, r: (p.kind === 'corner' ? table.cornerMouth : table.sideMouth) * 0.75 }));
const ball = (id: string, x: number, y: number): PickBall => ({ id, x, y, z: R, r: R });

function setup(orbit: ReturnType<typeof overviewOrbit>) {
  const m = cameraMatrices(orbit, W / H);
  const at = (p: V3) => {
    const q = project(m.vp, p, W, H)!;
    return screenRay(m.invVP, q.x, q.y, W, H);
  };
  return { m, at, px: pixelAtUnit(orbit.fovY, H) };
}

describe('render3d picking', () => {
  it('picks the ball under the pointer, then pockets, then the cloth', () => {
    const { at, px } = setup(overviewOrbit(g, W / H));
    const balls = [ball('cue', -0.4, 0.1), ball('b1', 0.5, -0.2)];
    const base = { balls, pockets, bedHalf: { x: g.hx, y: g.hy }, pxAtUnit: px };
    expect(pickRay({ ...base, ray: at([0.5, -0.2, R]) })).toEqual({ kind: 'ball', id: 'b1' });
    // Bed point directly under a ball centre still picks the ball (ray passes through it).
    expect(pickRay({ ...base, ray: at([-0.4, 0.1, 0]) })).toEqual({ kind: 'ball', id: 'cue' });
    // Touch slop: just outside the ball's edge.
    expect(pickRay({ ...base, ray: at([0.5 + R * 1.5, -0.2, R]) })).toEqual({ kind: 'ball', id: 'b1' });
    const tr = table.pockets.find((p) => p.id === 'TR')!;
    expect(pickRay({ ...base, ray: at([tr.mouthCenter.x, tr.mouthCenter.y, 0]) })).toEqual({ kind: 'pocket', id: 'TR' });
    const cloth = pickRay({ ...base, ray: at([0.1, 0.3, 0]) });
    expect(cloth?.kind).toBe('cloth');
    if (cloth?.kind === 'cloth') {
      expect(cloth.pos.x).toBeCloseTo(0.1, 4);
      expect(cloth.pos.y).toBeCloseTo(0.3, 4);
    }
    // Off the table (floor/rail area, away from pockets) → null.
    expect(pickRay({ ...base, ray: at([0, g.hy + 0.12, 0]) })).toBeNull();
  });

  it('prefers the nearer of two overlapping balls along the ray', () => {
    // Low player view down a line of balls: the front ball hides the one behind it.
    const o = playerOrbit(g, { x: -0.6, y: 0 }, { x: 1, y: 0 }, { x: 0.4, y: 0 }, W / H);
    const { at, px } = setup(o);
    const front = ball('front', 0, 0);
    const behind = ball('behind', 0.12, 0.004);
    const ray = at([0.12, 0.004, R]);
    // The ray aimed at the far ball's centre passes through the near ball first.
    expect(pickRay({ ray, balls: [behind, front], pockets, bedHalf: { x: g.hx, y: g.hy }, pxAtUnit: px })).toEqual({ kind: 'ball', id: 'front' });
    expect(pickRay({ ray, balls: [front, behind], pockets, bedHalf: { x: g.hx, y: g.hy }, pxAtUnit: px })).toEqual({ kind: 'ball', id: 'front' });
  });

  it('screen rays from an oblique camera land on the right cloth point', () => {
    const { at, px } = setup(broadcastOrbit(g, W / H));
    for (const p of [
      [0.9, 0.4, 0],
      [-1.0, -0.5, 0],
      [0.05, 0.02, 0],
    ] as V3[]) {
      const hit = pickRay({ ray: at(p), balls: [], pockets: [], bedHalf: { x: g.hx, y: g.hy }, pxAtUnit: px });
      expect(hit?.kind).toBe('cloth');
      if (hit?.kind === 'cloth') {
        expect(hit.pos.x).toBeCloseTo(p[0], 4);
        expect(hit.pos.y).toBeCloseTo(p[1], 4);
      }
    }
  });
});
