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

  describe('a ball reached only through the 22 px floor yields to a nearer pocket mouth (same rule as the 2D table and overlay)', () => {
    // Snooker in the overview on a phone: balls are drawn ~4.5 px wide, so a ball's natural pick radius
    // (1.8·R + 12 px) is under the 22 px floor, and a pocket mouth sits inside a nearby ball's floor.
    const sn = makeTable('snooker12');
    const gs = tableGeom(sn);
    const Rs = sn.ballRadius;
    const VW = 393;
    const VH = 700;
    const o = overviewOrbit(gs, VW / VH);
    const m = cameraMatrices(o, VW / VH);
    const px = pixelAtUnit(o.fovY, VH);
    // The pocket pick points Table3D.pick uses (2 cm inside the mouth centre).
    const snPockets: PickPocket[] = sn.pockets.map((p) => ({ id: p.id, x: p.mouthCenter.x - p.inward.x * 0.02, y: p.mouthCenter.y - p.inward.y * 0.02, r: (p.kind === 'corner' ? sn.cornerMouth : sn.sideMouth) * 0.75 }));
    const tr = snPockets.find((p) => p.id === 'TR')!;
    const qP = project(m.vp, [tr.x, tr.y, 0], VW, VH)!;
    const qC = project(m.vp, [0, 0, 0], VW, VH)!;
    const len = Math.hypot(qC.x - qP.x, qC.y - qP.y);
    const toward = { x: (qC.x - qP.x) / len, y: (qC.y - qP.y) / len };
    const ray = (sx: number, sy: number) => screenRay(m.invVP, sx, sy, VW, VH);
    /** A ball whose centre is drawn `dist` px from the pocket pick point, toward the table centre. */
    const ballAt = (dist: number) => {
      const s = { x: qP.x + toward.x * dist, y: qP.y + toward.y * dist };
      const r = ray(s.x, s.y);
      const t = (Rs - r.origin[2]) / r.dir[2];
      const b: PickBall = { id: 'red', x: r.origin[0] + r.dir[0] * t, y: r.origin[1] + r.dir[1] * t, z: Rs, r: Rs };
      return { b, s };
    };
    const pick = (sx: number, sy: number, balls: PickBall[], pk: PickPocket[] = snPockets, ballMinPx?: number) =>
      pickRay({ ray: ray(sx, sy), balls, pockets: pk, bedHalf: { x: gs.hx, y: gs.hy }, pxAtUnit: px, ballMinPx });
    /** How a tap reaches ball `b` with no pocket around: inside its natural slop, only through the 22 px floor, or not at all. */
    const reach = (sx: number, sy: number, b: PickBall) =>
      pick(sx, sy, [b], [], 0)?.kind === 'ball' ? 'natural' : pick(sx, sy, [b], [])?.kind === 'ball' ? 'floor' : 'none';

    it('a tap on the pocket mouth picks the pocket, not a ball about 21 px away', () => {
      const floorOnly: number[] = [];
      for (let d = 15; d <= 23; d += 0.1) if (reach(qP.x, qP.y, ballAt(d).b) === 'floor') floorOnly.push(d);
      expect(floorOnly.length, 'ball distances (px) reached from the pocket point only through the floor').toBeGreaterThan(5);
      const D = floorOnly[Math.floor(floorOnly.length / 2)]!;
      expect(D).toBeGreaterThan(19);
      expect(D).toBeLessThan(22.5);
      const { b } = ballAt(D);
      // The floor alone reaches the ball from the pocket point (no pockets: the ball)…
      expect(pick(qP.x, qP.y, [b], [])).toEqual({ kind: 'ball', id: 'red' });
      // …but the pocket under the finger is nearer.
      expect(pick(qP.x, qP.y, [b])).toEqual({ kind: 'pocket', id: 'TR' });
    });

    it('a ball within its natural pick radius still wins next to a pocket', () => {
      const { b } = ballAt(12);
      expect(reach(qP.x, qP.y, b)).toBe('natural');
      expect(pick(qP.x, qP.y, [b])).toEqual({ kind: 'ball', id: 'red' });
    });

    it('between the two, the nearer of the ball and the pocket wins', () => {
      const D = 30;
      const { b, s } = ballAt(D);
      const normal = { x: -toward.y, y: toward.x };
      // A tap `rb` px from the ball's centre and `dp` px from the pocket pick point (on screen).
      const tapAt = (rb: number, dp: number) => {
        const u = (rb * rb - dp * dp + D * D) / (2 * D); // from the ball back toward the pocket
        const h = Math.sqrt(rb * rb - u * u);
        return { x: s.x - toward.x * u + normal.x * h, y: s.y - toward.y * u + normal.y * h };
      };
      const cases = { nearBall: 0.8, nearPocket: -0.8 };
      for (const [name, extra] of Object.entries(cases)) {
        // Distances from the ball that only the floor reaches, with the pocket in reach too.
        const ok: number[] = [];
        for (let rb = 19.5; rb <= 22.5; rb += 0.05) {
          const q = tapAt(rb, rb + extra);
          if (reach(q.x, q.y, b) === 'floor' && pick(q.x, q.y, [], snPockets)?.kind === 'pocket') ok.push(rb);
        }
        expect(ok.length, `${name}: taps reaching both the ball (floor only) and the pocket`).toBeGreaterThan(3);
        const q = tapAt(ok[Math.floor(ok.length / 2)]!, ok[Math.floor(ok.length / 2)]! + extra);
        expect(pick(q.x, q.y, [b]), name).toEqual(extra > 0 ? { kind: 'ball', id: 'red' } : { kind: 'pocket', id: 'TR' });
      }
    });
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
