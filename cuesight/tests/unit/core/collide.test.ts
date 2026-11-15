/**
 * Ball–cushion contact model (collide.ts resolveCushion), single impulses and through simulate().
 *
 * Reference behaviour: a naturally rolling ball that hits a rail head-on loses most of its topspin.
 * Review ports of Han (2005) and Mathavan et al. (2010), as implemented in pooltool, give a post-rail
 * roll of ≈0.54 / ≈0.51 of the arrival speed at e_c ≈ 0.85, μc = 0.2, and a 45° roll-in leaving
 * ≈31° / ≈36° off the rail. The bounds below bracket those models and this one (0.58, ≈32°), and
 * exclude the old model that kept all top/back spin (0.32, 21.7°). Qualitatively, follow widens
 * the rebound angle and makes the ball pick up forward roll along the rail, and draw shortens the
 * angle (Alciatore, "The Illustrated Principles of Pool and Billiards", rail-rebound principles).
 */
import { describe, expect, it } from 'vitest';
import { resolveCushion, type BallArrays } from '../../../src/core/physics/collide';
import { DEFAULT_PHYSICS } from '../../../src/core/physics/params';
import { simulate, type SimBallInit } from '../../../src/core/physics/simulate';
import { strikeBall } from '../../../src/core/physics/strike';
import { makeTable } from '../../../src/core/table';
import type { Trajectory } from '../../../src/core/types';
import { v2, type Vec2 } from '../../../src/core/vec';

const table = makeTable('pool9');
const R = table.ballRadius;
const hx = table.length / 2;
const hy = table.width / 2;

function one(vx: number, vy: number, wx: number, wy: number, wz: number): BallArrays {
  const f = () => new Float64Array(1);
  const s: BallArrays = { px: f(), py: f(), vx: f(), vy: f(), wx: f(), wy: f(), wz: f() };
  s.vx[0] = vx;
  s.vy[0] = vy;
  s.wx[0] = wx;
  s.wy[0] = wy;
  s.wz[0] = wz;
  return s;
}
function energy(s: BallArrays): number {
  return 0.5 * (s.vx[0]! ** 2 + s.vy[0]! ** 2) + 0.5 * 0.4 * R * R * (s.wx[0]! ** 2 + s.wy[0]! ** 2 + s.wz[0]! ** 2);
}
/** Speed along x once cloth friction has removed the slip: (5·v + 2·R·ω_y)/7 (top/back spin only). */
function finalRollX(s: BallArrays): number {
  return (5 * s.vx[0]! + 2 * R * s.wy[0]!) / 7;
}
/** Head-on into the foot cushion (inward normal −x) at 1 m/s with topspin surface speed R·ω_y = w. */
function headOn(w: number): BallArrays {
  const s = one(1, 0, 0, w / R, 0);
  resolveCushion(s, 0, -1, 0, R, DEFAULT_PHYSICS);
  return s;
}

/** Point on a recorded trajectory `dist` metres of path after the first event of `kind`. */
function pointAfter(tr: Trajectory, kind: string, dist: number): Vec2 {
  const ev = tr.events.find((e) => e.kind === kind)!;
  let k = tr.points.findIndex((p) => p.x === ev.pos.x && p.y === ev.pos.y);
  expect(k).toBeGreaterThanOrEqual(0);
  let s = 0;
  while (k + 1 < tr.points.length && s < dist) {
    const a = tr.points[k]!;
    const b = tr.points[k + 1]!;
    s += Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2);
    k++;
  }
  expect(s).toBeGreaterThanOrEqual(dist);
  return tr.points[k]!;
}
/** Heading of travel (degrees off the bottom long rail) between `d` and `d + 0.05` m after the rail. */
function headingOffRail(tr: Trajectory, d: number): number {
  const a = pointAfter(tr, 'cushion', d);
  const b = pointAfter(tr, 'cushion', d + 0.05);
  return (Math.atan2(Math.abs(b.y - a.y), Math.abs(b.x - a.x)) * 180) / Math.PI;
}
/** A ball struck with tip height `vert` heading 45° down into the bottom long rail (clear of the side pocket). */
function into45(speed: number, vert: number, gap: number): SimBallInit[] {
  const dir = v2(Math.SQRT1_2, -Math.SQRT1_2);
  const s = strikeBall(dir, speed, 0, vert, R, DEFAULT_PHYSICS.squirtMassRatio);
  const y0 = -hy + R + gap;
  return [{ id: 'c', pos: v2(-0.95, y0), vel: s.vel, omega: s.omega }];
}

describe('cushion impulse changes top/back spin (vertical contact slip)', () => {
  it('a rolling ball loses most of its topspin at the rail: post-rail roll is 0.5–0.65 of the arrival speed', () => {
    const s = headOn(1);
    expect(s.wy[0]).not.toBeCloseTo(1 / R, 6); // topspin was changed by the rail
    expect(Math.abs(R * s.wy[0]!)).toBeLessThan(0.3 * Math.abs(s.vx[0]!));
    const roll = Math.abs(finalRollX(s));
    expect(roll).toBeGreaterThan(0.5);
    expect(roll).toBeLessThan(0.65);
    // The normal rebound itself is unchanged: v' = −e_c(v)·v.
    expect(s.vx[0]).toBeCloseTo(-(0.88 - 0.035), 9);
  });

  it('draw is not handed back as follow: draw and stun come off the rail within 0.05 m/s of each other', () => {
    const stun = Math.abs(finalRollX(headOn(0)));
    const draw = Math.abs(finalRollX(headOn(-1)));
    expect(Math.abs(draw - stun)).toBeLessThan(0.05);
  });

  it('never gains kinetic energy (1000 random impacts with wx, wy, wz)', () => {
    let seed = 11;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
    let changedTopspin = 0;
    for (let k = 0; k < 1000; k++) {
      const a = rnd() * Math.PI;
      const nx = Math.cos(a);
      const ny = Math.sin(a);
      // Velocity with an inbound normal component, random tangential part, random 3-D spin.
      const vn = -(0.05 + Math.abs(rnd()) * 4);
      const vt = rnd() * 4;
      const s = one(vn * nx - vt * ny, vn * ny + vt * nx, (rnd() * 6) / R, (rnd() * 6) / R, (rnd() * 6) / R);
      const wx0 = s.wx[0]!;
      const before = energy(s);
      resolveCushion(s, 0, nx, ny, R, DEFAULT_PHYSICS);
      expect(energy(s)).toBeLessThanOrEqual(before + 1e-12);
      if (s.wx[0] !== wx0) changedTopspin++;
    }
    expect(changedTopspin).toBeGreaterThan(900);
  });

  it('a ball rolling at 1.5 m/s into a long rail at 45° leaves 30°–40° off the rail', () => {
    const r = simulate(table, into45(1.5, 0.4, 0.3), DEFAULT_PHYSICS, { recordSpacing: 0.002 });
    const a = headingOffRail(r.trajectories[0]!, 0.5);
    expect(a).toBeGreaterThan(30);
    expect(a).toBeLessThan(40);
  });

  it('a ball rolling at 1 m/s from 0.3 m before the foot cushion comes back at least 1.0 m', () => {
    const r = simulate(table, [{ id: 'c', pos: v2(hx - R - 0.3, 0), vel: v2(1, 0), omega: { x: 0, y: 1 / R, z: 0 } }], DEFAULT_PHYSICS);
    expect(r.events.some((e) => e.kind === 'cushion')).toBe(true);
    const back = hx - R - r.final.c!.pos.x;
    expect(back).toBeGreaterThan(1.0);
  });

  it('follow widens the rebound angle and picks up forward roll along the rail; draw shortens it', () => {
    // Firm and close to the rail so the draw survives to the cushion.
    const run = (vert: number) => simulate(table, into45(2.5, vert, 0.12), DEFAULT_PHYSICS, { recordSpacing: 0.002 });
    const follow = run(0.5);
    const stun = run(0);
    const draw = run(-0.5);
    // Make sure each ball still had its intended spin at the rail.
    for (const r of [follow, stun, draw]) expect(r.trajectories[0]!.events[0]!.kind).toBe('cushion');
    // Final rolling heading, measured from the rail (smaller = wider rebound angle from the perpendicular).
    const off = (r: ReturnType<typeof run>) => headingOffRail(r.trajectories[0]!, 0.6);
    expect(off(follow)).toBeLessThan(off(stun) - 3);
    expect(off(draw)).toBeGreaterThan(off(stun) + 3);
    // Forward roll: just after the rail the follow ball's path bends towards the rail direction
    // (it accelerates along the rail); the draw ball's bends away from it.
    const early = (r: ReturnType<typeof run>) => headingOffRail(r.trajectories[0]!, 0.01);
    expect(off(follow)).toBeLessThan(early(follow));
    expect(off(draw)).toBeGreaterThan(early(draw));
  });

  it('single impulses: follow leaves overspin along the rail, draw leaves underspin (no energy gain)', () => {
    // 45° into the bottom rail (inward normal +y) at 2 m/s, moving +x and −y.
    const v = Math.SQRT2;
    const spun = (k: number) => {
      // k = R·ω/v relative to natural roll (1 = rolling, >0 follow, <0 draw).
      const s = one(v, -v, (k * v) / R, (k * v) / R, 0);
      const e0 = energy(s);
      resolveCushion(s, 0, 0, 1, R, DEFAULT_PHYSICS);
      expect(energy(s)).toBeLessThanOrEqual(e0);
      return s;
    };
    const f = spun(1.25);
    const d = spun(-1.25);
    // Along-rail bed slip vx − R·ωy: negative → cloth pushes the ball forward (picks up roll).
    expect(f.vx[0]! - R * f.wy[0]!).toBeLessThan(-0.1);
    expect(d.vx[0]! - R * d.wy[0]!).toBeGreaterThan(0.1);
  });
});
