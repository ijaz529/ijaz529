import { describe, expect, it } from 'vitest';
import { makeTable } from '../../../src/core/table';
import { broadcastOrbit, cameraMatrices, overviewOrbit, pixelAtUnit, playerOrbit } from '../../../src/app/render3d/camera';
import { tableGeom } from '../../../src/app/render3d/geom';
import { project, raySphere, screenRay, type V3 } from '../../../src/app/render3d/math3d';
import { DRILLS } from '../../../src/app/drills';
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

  it('SC-102: every visible ball projected to the screen picks back to itself, in all three presets, portrait and landscape', () => {
    // The same inputs Table3D.pick builds: balls at z = R, pixel scale of the canvas height.
    for (const [w, h] of [
      [393, 700],
      [852, 393],
      [1024, 1366],
    ] as const) {
      for (const d of DRILLS) {
        const layout = d.build(table);
        const cue = layout.find((b) => b.kind === 'cue')!;
        const tgt = layout.find((b) => b.kind !== 'cue')!;
        const aim = { x: tgt.pos.x - cue.pos.x, y: tgt.pos.y - cue.pos.y };
        const presets = {
          overview: overviewOrbit(g, w / h),
          broadcast: broadcastOrbit(g, w / h),
          player: playerOrbit(g, cue.pos, aim, tgt.pos, w / h),
        };
        const picks = layout.map((b) => ball(b.id, b.pos.x, b.pos.y));
        for (const [name, o] of Object.entries(presets)) {
          const m = cameraMatrices(o, w / h);
          const px = pixelAtUnit(o.fovY, h);
          for (const b of picks) {
            const q = project(m.vp, [b.x, b.y, R], w, h);
            if (!q || q.x < 0 || q.y < 0 || q.x > w || q.y > h) continue;
            const ray = screenRay(m.invVP, q.x, q.y, w, h);
            // Hidden behind a nearer ball (its centre is covered): that ball is the honest pick.
            const tSelf = raySphere(ray, [b.x, b.y, R], R) ?? Infinity;
            const covered = picks.some((o2) => o2 !== b && (raySphere(ray, [o2.x, o2.y, R], R) ?? Infinity) < tSelf);
            if (covered) continue;
            expect(pickRay({ ray, balls: picks, pockets, bedHalf: { x: g.hx, y: g.hy }, pxAtUnit: px }), `${d.id} ${name} ${w}×${h} ${b.id}`).toEqual({ kind: 'ball', id: b.id });
          }
        }
      }
    }
  });

  it('a ball is picked within 22 CSS px of its centre however small it is on screen (contract § pick; 44 px targets)', () => {
    // Snooker in the overview on a phone: a ball is under 10 px across. A tap 21 px from its centre
    // still selects it; one 30 px away is a tap on the cloth.
    const sn = makeTable('snooker12');
    const gs = tableGeom(sn);
    const Rs = sn.ballRadius;
    const o = overviewOrbit(gs, 393 / 700);
    const m = cameraMatrices(o, 393 / 700);
    const px = pixelAtUnit(o.fovY, 700);
    const b: PickBall = { id: 'red', x: 0.3, y: 0.1, z: Rs, r: Rs };
    const q = project(m.vp, [b.x, b.y, Rs], 393, 700)!;
    const edge = project(m.vp, [b.x + Rs, b.y, Rs], 393, 700)!;
    expect(Math.hypot(edge.x - q.x, edge.y - q.y), 'ball radius on screen (px)').toBeLessThan(5.5);
    const at = (dx: number) => pickRay({ ray: screenRay(m.invVP, q.x + dx, q.y, 393, 700), balls: [b], pockets: [], bedHalf: { x: gs.hx, y: gs.hy }, pxAtUnit: px });
    expect(at(21)).toEqual({ kind: 'ball', id: 'red' });
    expect(at(-21)).toEqual({ kind: 'ball', id: 'red' });
    expect(at(30)?.kind).toBe('cloth');
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
