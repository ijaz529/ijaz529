import { describe, expect, it } from 'vitest';
import { rollingDeflection, rollingDistance, throwAngle } from '../../../src/core/physics/analytic';
import { resolveBallBall, resolveCushion, type BallArrays } from '../../../src/core/physics/collide';
import { DEFAULT_PHYSICS, withPhysics } from '../../../src/core/physics/params';
import { simulate, type SimBallInit } from '../../../src/core/physics/simulate';
import { strikeBall } from '../../../src/core/physics/strike';
import { makeTable } from '../../../src/core/table';
import type { Trajectory } from '../../../src/core/types';
import { angleBetween, deg, fromAngle, norm, rad, sub, v2, type Vec2 } from '../../../src/core/vec';

const table = makeTable('pool9');
const R = table.ballRadius;
const IDEAL = withPhysics({ eBall: 1, ballFriction: { a: 0, b: 0, c: 0 } });

function arrays(n: number): BallArrays {
  const f = () => new Float64Array(n);
  return { px: f(), py: f(), vx: f(), vy: f(), wx: f(), wy: f(), wz: f() };
}
function energy(s: BallArrays, i: number): number {
  return 0.5 * (s.vx[i]! ** 2 + s.vy[i]! ** 2) + 0.5 * 0.4 * R * R * (s.wx[i]! ** 2 + s.wy[i]! ** 2 + s.wz[i]! ** 2);
}

/** Direction of travel of a trajectory after its first event of `kind`, measured over `span` metres. */
/** Direction from event index k of a trajectory to the following event (or rest). */
function legDir(tr: Trajectory, k: number): Vec2 {
  const a = tr.events[k]!.pos;
  const b = tr.events[k + 1]?.pos ?? tr.points[tr.points.length - 1]!;
  return norm(sub(b, a));
}
/** First recorded point at least `minDist` from the start. */
function firstAway(tr: Trajectory, minDist: number): Vec2 {
  const o = tr.points[0]!;
  return tr.points.find((q) => Math.hypot(q.x - o.x, q.y - o.y) >= minDist) ?? tr.points[tr.points.length - 1]!;
}

/** Cue ball 0.5 mm before contact for a cut of `cutDeg`, OB at origin heading +x. */
function cutSetup(cutDeg: number, speed: number, spin: { vert: number; side?: number } | 'stun'): SimBallInit[] {
  const obDir = v2(1, 0);
  const ghost = v2(-2 * R, 0);
  const aim = fromAngle(rad(cutDeg)); // CB travels at +cut from OB line (OB goes clockwise of CB line)
  const cbPos = sub(ghost, { x: aim.x * 0.0005, y: aim.y * 0.0005 });
  let omega = { x: 0, y: 0, z: 0 };
  if (spin !== 'stun') omega = strikeBall(aim, speed, spin.side ?? 0, spin.vert, R, 23).omega;
  void obDir;
  return [
    { id: 'cue', pos: cbPos, vel: { x: aim.x * speed, y: aim.y * speed }, omega },
    { id: 'ob', pos: v2(0, 0) },
  ];
}

describe('collision impulses', () => {
  it('ball–ball never gains energy (random states)', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
    for (let k = 0; k < 500; k++) {
      const s = arrays(2);
      s.px[1] = 2 * R * Math.cos(rnd() * 3);
      s.py[1] = 2 * R * Math.sin(rnd() * 3);
      s.vx[0] = rnd() * 4;
      s.vy[0] = rnd() * 4;
      s.wx[0] = (rnd() * 4) / R;
      s.wy[0] = (rnd() * 4) / R;
      s.wz[0] = (rnd() * 4) / R;
      const before = energy(s, 0) + energy(s, 1);
      resolveBallBall(s, 0, 1, R, DEFAULT_PHYSICS);
      expect(energy(s, 0) + energy(s, 1)).toBeLessThanOrEqual(before + 1e-9);
    }
  });
  it('cushion rebound: normal speed × e_c; running english lengthens the angle', () => {
    const s = arrays(1);
    s.vy[0] = -1;
    resolveCushion(s, 0, 0, 1, R, DEFAULT_PHYSICS);
    expect(s.vy[0]).toBeCloseTo(0.88 - 0.035, 9);
    const angleWith = (wz: number) => {
      const t = arrays(1);
      t.vx[0] = 1;
      t.vy[0] = -1;
      t.wz[0] = wz;
      resolveCushion(t, 0, 0, 1, R, DEFAULT_PHYSICS);
      return Math.atan2(t.vx[0]!, t.vy[0]!); // angle from normal
    };
    const none = angleWith(0);
    // Running english for a ball moving +x into the bottom rail: contact slip reduced → wz such that
    // contact tangential velocity vx − wz·(−R·ny)... choose sign that reduces slip.
    const running = angleWith(-1 / R);
    const reverse = angleWith(1 / R);
    expect(running).toBeGreaterThan(none);
    expect(reverse).toBeLessThan(none);
  });
});

describe('simulate', () => {
  it('a stationary layout stays put', () => {
    const r = simulate(table, [{ id: 'a', pos: v2(0, 0) }, { id: 'b', pos: v2(0.3, 0.1) }], DEFAULT_PHYSICS);
    expect(r.steps).toBe(0);
    expect(r.final.b!.pos).toEqual({ x: 0.3, y: 0.1 });
  });

  it('a centre-ball hit slides then rolls at 5/7 speed: total distance matches theory (±2%)', () => {
    const p = DEFAULT_PHYSICS;
    const v0 = 0.8;
    const ts = (2 * v0) / (7 * p.muSlide * p.g);
    const ds = v0 * ts - 0.5 * p.muSlide * p.g * ts * ts;
    const expected = ds + rollingDistance((5 / 7) * v0, p);
    const r = simulate(table, [{ id: 'c', pos: v2(-1.2, 0), vel: v2(v0, 0) }], p);
    const d = r.final.c!.pos.x + 1.2;
    expect(Math.abs(d - expected) / expected).toBeLessThan(0.02);
    expect(r.events.some((e) => e.kind === 'roll')).toBe(true);
  });

  it('a natural-roll strike rolls v²/(2μr g) (±2%)', () => {
    const v = 0.6;
    const s = strikeBall(v2(1, 0), v, 0, 0.4, R, 23);
    const r = simulate(table, [{ id: 'c', pos: v2(-1.2, 0), vel: s.vel, omega: s.omega }], DEFAULT_PHYSICS);
    const d = r.final.c!.pos.x + 1.2;
    const expected = rollingDistance(v, DEFAULT_PHYSICS);
    expect(Math.abs(d - expected) / expected).toBeLessThan(0.02);
  });

  it('90° rule: ideal stun cut leaves on the tangent line (±0.5°)', () => {
    for (const cut of [15, 30, 45, 60]) {
      const r = simulate(table, cutSetup(cut, 0.8, 'stun'), IDEAL);
      const cue = r.trajectories[0]!;
      const ob = r.trajectories[1]!;
      const cbDir = legDir(cue, 0);
      const obDir = legDir(ob, 0);
      expect(Math.abs(Math.abs(deg(angleBetween(obDir, cbDir))) - 90)).toBeLessThan(0.5);
    }
  });

  it('realistic stun (e=0.95): CB leaves slightly forward of the tangent line (< 4°)', () => {
    const r = simulate(table, cutSetup(30, 0.8, 'stun'), DEFAULT_PHYSICS);
    const cue = r.trajectories[0]!;
    const hit = cue.events.find((e) => e.kind === 'ball')!;
    void hit;
    const cbDir = legDir(cue, 0);
    // Relative to the line of centres (+x): restitution < 1 leaves a small forward component.
    const a = Math.abs(deg(angleBetween(v2(1, 0), cbDir)));
    expect(a).toBeLessThan(90);
    expect(a).toBeGreaterThan(86);
  });

  it('30° rule: ideal rolling cue ball deflects by the analytic angle (±1°)', () => {
    for (const cut of [20, 30, 40]) {
      const r = simulate(table, cutSetup(cut, 1.0, { vert: 0.4 }), IDEAL);
      const cue = r.trajectories[0]!;
      const k = cue.events.findIndex((e, idx) => e.kind === 'roll' && idx > 0);
      const finalDir = legDir(cue, k);
      const original = fromAngle(rad(cut));
      const defl = Math.abs(deg(angleBetween(original, finalDir)));
      expect(Math.abs(defl - deg(rollingDeflection(rad(cut))))).toBeLessThan(1);
    }
  });

  it('simulated throw matches TP A.14 (e=1, stun, ±0.1°)', () => {
    const p = withPhysics({ eBall: 1 });
    for (const [cut, v] of [
      [15, 0.5],
      [30, 0.5],
      [30, 2],
      [50, 1],
    ] as const) {
      const r = simulate(table, cutSetup(cut, v, 'stun'), p, { recordSpacing: 0.005 });
      const ob = r.trajectories[1]!;
      const obDir = norm(sub(firstAway(ob, 0.004), ob.points[0]!));
      // Geometric OB direction is the line of centres (+x). The CB arrives moving at +cut, so its
      // tangential slip is +y and throw pushes the OB counter-clockwise (positive angle).
      const thrown = deg(Math.atan2(obDir.y, obDir.x));
      const expected = deg(throwAngle(rad(cut), v, 0, 0, p));
      expect(Math.abs(thrown - expected)).toBeLessThan(0.1);
      expect(thrown).toBeGreaterThan(0);
    }
  });

  it('straight-in stop shot: CB stops within 3 cm of contact', () => {
    const r = simulate(table, cutSetup(0, 2, 'stun'), DEFAULT_PHYSICS);
    const rest = r.final.cue!.pos;
    expect(Math.hypot(rest.x + 2 * R, rest.y)).toBeLessThan(0.03);
  });

  it('draw comes back, follow goes forward', () => {
    // Where the CB ends its post-impact sliding phase tells draw from follow.
    // Short (0.34 m), firm (3 m/s) shot so backspin survives the trip to the object ball.
    const run = (vert: number) => {
      const s = strikeBall(v2(1, 0), 3, 0, vert, R, 23);
      const r = simulate(table, [
        { id: 'cue', pos: v2(-0.4, 0), vel: s.vel, omega: s.omega },
        { id: 'ob', pos: v2(0, 0) },
      ], DEFAULT_PHYSICS);
      const cue = r.trajectories[0]!;
      const k = cue.events.findIndex((e) => e.kind === 'ball');
      return cue.events.slice(k + 1).find((e) => e.kind === 'roll' || e.kind === 'stop')!.pos;
    };
    expect(run(-0.5).x).toBeLessThan(-2 * R - 0.1);
    expect(run(0.4).x).toBeGreaterThan(-2 * R + 0.05);
  });

  it('a ball rolled at the corner is pocketed', () => {
    const d = norm(v2(1, 0.5));
    const r = simulate(table, [{ id: 'b', pos: v2(0, 0), vel: { x: d.x * 3, y: d.y * 3 } }], DEFAULT_PHYSICS);
    expect(r.final.b!.pocket).toBe('TR');
  });

  it('balls never overlap after a full-rack break', () => {
    const balls: SimBallInit[] = [];
    let k = 0;
    for (let row = 0; row < 5; row++) {
      for (let c = 0; c <= row; c++) {
        balls.push({ id: `b${k++}`, pos: v2(0.64 + row * 2 * R * Math.cos(Math.PI / 6) + 1e-4 * row, (c - row / 2) * (2 * R + 1e-4)) });
      }
    }
    balls.push({ id: 'cue', pos: v2(-0.64, 0.01), vel: v2(8, 0) });
    const r = simulate(table, balls, DEFAULT_PHYSICS, { record: false });
    const live = Object.values(r.final).filter((f) => !f.pocket);
    for (let i = 0; i < live.length; i++) {
      for (let j = i + 1; j < live.length; j++) {
        const dd = Math.hypot(live[i]!.pos.x - live[j]!.pos.x, live[i]!.pos.y - live[j]!.pos.y);
        expect(dd).toBeGreaterThan(2 * R - 1e-4);
      }
      expect(Math.abs(live[i]!.pos.x)).toBeLessThanOrEqual(table.length / 2);
      expect(Math.abs(live[i]!.pos.y)).toBeLessThanOrEqual(table.width / 2);
    }
    expect(r.time).toBeLessThan(DEFAULT_PHYSICS.maxTime);
  });
});
