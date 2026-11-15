import { readFileSync } from 'node:fs';
import { PerformanceObserver } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { rollingDeflection, rollingDistance, throwAngle } from '../../../src/core/physics/analytic';
import { resolveBallBall, resolveCushion, type BallArrays } from '../../../src/core/physics/collide';
import { DEFAULT_PHYSICS, withPhysics } from '../../../src/core/physics/params';
import { simulate, type SimBallInit, type SimOptions } from '../../../src/core/physics/simulate';
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
    // Where the CB first stops: the OB rebounds off the foot rail and can come back to hit it later.
    const rest = r.trajectories[0]!.events.find((e) => e.kind === 'stop')!.pos;
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

  it('stopOnFirstHitOf ends the simulation at that ball’s first collision', () => {
    const r = simulate(table, cutSetup(30, 1, 'stun'), DEFAULT_PHYSICS, { stopOnFirstHitOf: 'ob' });
    expect(r.firstHits.ob).toBeDefined();
    expect(r.steps).toBe(0); // the hit is 0.5 mm away: inside the first step
    expect(r.time).toBe(0);
    expect(r.events.filter((e) => e.kind === 'ball')).toHaveLength(2);
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

/** A 15-ball rack (rows `gap` apart; gap 0 = frozen) and a cue ball hitting it at `cueSpeed`. */
function rack(gap: number, cueSpeed: number): SimBallInit[] {
  const balls: SimBallInit[] = [];
  let k = 0;
  for (let row = 0; row < 5; row++) {
    for (let c = 0; c <= row; c++) {
      balls.push({ id: `b${k++}`, pos: v2(0.64 + row * 2 * R * Math.cos(Math.PI / 6) + gap * row, (c - row / 2) * (2 * R + gap)) });
    }
  }
  balls.push({ id: 'cue', pos: v2(-0.64, 0.01), vel: v2(cueSpeed, 0) });
  return balls;
}
/** `count` frozen balls on y = 0 ending at x = lastX, with a cue ball 0.3 m behind hitting along the line. */
function frozenLine(count: number, lastX: number, cueSpeed: number): SimBallInit[] {
  const balls: SimBallInit[] = [];
  for (let k = 0; k < count; k++) balls.push({ id: `l${k}`, pos: v2(lastX - (count - 1 - k) * 2 * R, 0) });
  balls.push({ id: 'cue', pos: v2(lastX - (count - 1) * 2 * R - 0.3, 0), vel: v2(cueSpeed, 0) });
  return balls;
}
/**
 * Simulate with a per-step check: the deepest ball–ball overlap (2R − distance) and the deepest
 * overlap with a cushion nose or jaw point over every step, for balls still on the table.
 */
function everyStep(balls: SimBallInit[], opts: SimOptions = {}) {
  const n = balls.length;
  const jaws = table.cushions.flatMap((c) => [c.a, c.b]);
  let pair = 0;
  let rail = 0;
  let calls = 0;
  const r = simulate(table, balls, DEFAULT_PHYSICS, {
    record: false,
    ...opts,
    onStep: (_t, px, py, pocketed) => {
      calls++;
      for (let i = 0; i < n; i++) {
        if (pocketed[i]) continue;
        for (let j = i + 1; j < n; j++) {
          if (pocketed[j]) continue;
          pair = Math.max(pair, 2 * R - Math.sqrt((px[j]! - px[i]!) ** 2 + (py[j]! - py[i]!) ** 2));
        }
        for (const c of table.cushions) {
          const ex = c.b.x - c.a.x;
          const ey = c.b.y - c.a.y;
          const u = ((px[i]! - c.a.x) * ex + (py[i]! - c.a.y) * ey) / (ex * ex + ey * ey);
          if (u < 0 || u > 1) continue;
          rail = Math.max(rail, R - ((px[i]! - c.a.x) * c.n.x + (py[i]! - c.a.y) * c.n.y));
        }
        for (const q of jaws) rail = Math.max(rail, R - Math.sqrt((px[i]! - q.x) ** 2 + (py[i]! - q.y) ** 2));
      }
    },
  });
  return { r, calls, pair, rail };
}

describe('contact invariants hold at every step (frozen clusters)', () => {
  const cases: [string, () => SimBallInit[]][] = [
    ['frozen 15-ball rack at 2 m/s', () => rack(0, 2)],
    ['frozen 15-ball rack at 7 m/s', () => rack(0, 7)],
    ['frozen 15-ball rack at 10 m/s', () => rack(0, 10)],
    ['frozen line of 15 at 2 m/s', () => frozenLine(15, 0.3, 2)],
    ['frozen line of 15 at 10 m/s', () => frozenLine(15, 0.3, 10)],
    ['frozen line of 8, last ball 1 mm off the foot rail, at 10 m/s', () => frozenLine(8, table.length / 2 - R - 0.001, 10)],
  ];
  it('no round-off t = 0 contact loop: the default budget never runs out on a break (same result with a 10⁴ budget)', () => {
    // Without the approach threshold (APPROACH_EPS) a resting pair whose closing speed is round-off
    // is "hit" again and again at t = 0 with an impulse lost in rounding, until the per-step budget
    // cuts it off. The 10 µm-gap racks show it: with APPROACH_EPS = 0 they give 6426 / 18958 'ball'
    // events at the default budget and 60282 / 180526 at a 10⁴ budget; with the threshold, 168 / 226
    // at both. (The 0.1 mm-gap racks do not loop either way; they are kept as plain break checks.)
    for (const [gap, speed] of [
      [1e-5, 2],
      [1e-5, 1],
      [1e-4, 2],
      [1e-4, 8],
    ] as const) {
      const a = simulate(table, rack(gap, speed), DEFAULT_PHYSICS, { record: false });
      const b = simulate(table, rack(gap, speed), DEFAULT_PHYSICS, { record: false, maxContactsPerStep: 1e4 });
      const ballEvents = a.events.filter((e) => e.kind === 'ball').length;
      expect(ballEvents).toBeLessThan(1000);
      expect(b.events.length).toBe(a.events.length);
      for (const id of Object.keys(a.final)) expect(b.final[id]!.pos).toEqual(a.final[id]!.pos);
    }
  });
  for (const [name, layout] of cases) {
    it(`${name}: no overlap and no ball inside a cushion, ever`, () => {
      const { r, calls, pair, rail } = everyStep(layout());
      expect(calls).toBe(r.steps);
      expect(calls).toBeGreaterThan(100);
      expect(pair).toBeLessThan(1e-6);
      expect(rail).toBeLessThan(1e-6);
      expect(r.time).toBeLessThan(DEFAULT_PHYSICS.maxTime);
    });
    it(`${name}, contact budget forced down to 1 and 3 per step: the fallback still detects every contact`, () => {
      for (const maxContactsPerStep of [1, 3]) {
        const { r, calls, pair, rail } = everyStep(layout(), { maxContactsPerStep });
        expect(calls).toBe(r.steps);
        expect(pair).toBeLessThan(1e-6);
        expect(rail).toBeLessThan(1e-6);
        expect(r.time).toBeLessThan(DEFAULT_PHYSICS.maxTime);
      }
    });
  }
});

/** 9-ball diamond (rows 1-2-3-2-1, 0.1 mm gaps) broken at 8 m/s slightly off-centre. */
function nineBallBreak(): SimBallInit[] {
  const rows = [1, 2, 3, 2, 1];
  const balls: SimBallInit[] = [];
  const dx = (2 * R + 1e-4) * Math.cos(Math.PI / 6);
  let k = 1;
  rows.forEach((count, row) => {
    for (let c = 0; c < count; c++) balls.push({ id: `b${k++}`, pos: v2(0.64 + row * dx, (c - (count - 1) / 2) * (2 * R + 1e-4)) });
  });
  balls.push({ id: 'cue', pos: v2(-0.64, 0.004), vel: v2(8, 0), omega: { x: 0, y: 0, z: 0 } });
  return balls;
}
type Golden = Record<string, [number, number, string | null]>;
/**
 * Final positions of nineBallBreak() with the current model (regenerate deliberately whenever the
 * physics is changed on purpose; an unintended diff means a refactor changed the numbers).
 */
const NINE_BALL_GOLDEN: Golden = {
  b1: [-0.25084311395286146, -0.059461259127319775, null],
  b2: [0.7301361204317236, -0.005169462010223934, null],
  b3: [1.1596096064342065, 0.4324171308052692, null],
  b4: [-0.04704510808136223, -0.517809223003961, null],
  b5: [0.27884953626080267, 0.4852623882841552, null],
  b6: [1.2701277570115637, 0.6337628653164933, 'TR'],
  b7: [0.9367906087678274, -0.3831889538195755, null],
  b8: [1.0326453960844109, -0.43683905458431826, null],
  b9: [0.7076956416626747, -0.09813291787179562, null],
  cue: [-0.2713512025628345, 0.5017470138834712, null],
};
/** The same break before Math.hypot was replaced by Math.sqrt(a·a + b·b) (identical model otherwise). */
const NINE_BALL_BEFORE_SQRT: Golden = {
  b1: [-0.25084311395286324, -0.059461259127319234, null],
  b2: [0.7301361204317237, -0.005169462010222929, null],
  b3: [1.1596096064342059, 0.43241713080526867, null],
  b4: [-0.04704510808136734, -0.5178092230039599, null],
  b5: [0.2788495362608055, 0.48526238828415513, null],
  b6: [1.2701277570115637, 0.6337628653164933, 'TR'],
  b7: [0.9367906087678274, -0.38318895381957574, null],
  b8: [1.032645396084411, -0.43683905458431505, null],
  b9: [0.7076956416626784, -0.09813291787179673, null],
  cue: [-0.27135120256283185, 0.5017470138834672, null],
};

describe('per-step loop: determinism and no allocation (Constitution IV)', () => {
  it('a fixed 9-ball break is bit-identical run to run and to its golden copy', () => {
    const a = simulate(table, nineBallBreak(), DEFAULT_PHYSICS, { record: false });
    const b = simulate(table, nineBallBreak(), DEFAULT_PHYSICS, { record: false });
    for (const [id, [x, y, pocket]] of Object.entries(NINE_BALL_GOLDEN)) {
      expect(a.final[id]!.pos).toEqual(b.final[id]!.pos);
      expect(a.final[id]!.pos.x).toBe(x);
      expect(a.final[id]!.pos.y).toBe(y);
      expect(a.final[id]!.pocket).toBe(pocket);
    }
    // Math.hypot and Math.sqrt(a·a + b·b) differ in the last ulp now and then, so the switch is not
    // bit-identical; it moved this chaotic break by ~1e-14 m and changed no outcome.
    for (const [id, [x, y, pocket]] of Object.entries(NINE_BALL_BEFORE_SQRT)) {
      expect(Math.abs(a.final[id]!.pos.x - x)).toBeLessThan(1e-12);
      expect(Math.abs(a.final[id]!.pos.y - y)).toBeLessThan(1e-12);
      expect(a.final[id]!.pocket).toBe(pocket);
    }
  });

  it('100 position-play simulations, once warm, trigger fewer than 15 garbage collections', async () => {
    // A recommendStroke-style candidate: cue → object ball with side and follow, CB off a rail, 6 balls.
    // heapUsed deltas are not a usable guard here: collections keep them near zero even when the
    // loop allocates (−2.6…+1.3 MB measured with Math.hypot in the loop), and in a test worker they
    // swing by several MB without it. The number of collections is the stable signal: ≈80 per 100
    // runs with Math.hypot in the step loop, 1–3 without.
    const s = strikeBall(v2(0.8, 0.6), 2.5, 0.2, 0.3, R, DEFAULT_PHYSICS.squirtMassRatio);
    const layout: SimBallInit[] = [
      { id: 'cue', pos: v2(-0.6, -0.3), vel: s.vel, omega: s.omega },
      { id: 'ob', pos: v2(0.2, 0.3) },
      { id: 'a', pos: v2(0.9, -0.4) },
      { id: 'b', pos: v2(-0.9, 0.4) },
      { id: 'c', pos: v2(0.5, -0.1) },
      { id: 'd', pos: v2(-0.2, 0.5) },
    ];
    const run = (k: number) => {
      let steps = 0;
      for (let i = 0; i < k; i++) steps += simulate(table, layout, DEFAULT_PHYSICS, { record: false }).steps;
      return steps;
    };
    run(30); // warm up (JIT)
    let gcs = 0;
    const obs = new PerformanceObserver((list) => {
      gcs += list.getEntries().length;
    });
    obs.observe({ entryTypes: ['gc'] });
    await new Promise((r) => setTimeout(r, 20));
    gcs = 0;
    const steps = run(100);
    await new Promise((r) => setTimeout(r, 20)); // GC entries are delivered asynchronously
    obs.disconnect();
    // ≈260 k simulation steps: one 16-byte heap number per step alone would be ≈4 MB of garbage.
    expect(steps).toBeGreaterThan(200_000);
    expect(gcs).toBeLessThan(15);
  });

  it('≈3 M steps of a lone sliding, spinning ball, once warm, trigger at most 3 garbage collections', async () => {
    // A pure step-loop probe: one ball, ~4 events per run, so every byte allocated per step shows
    // (the 6-ball guard above cannot see a heap number or two per step: 4 collections before the
    // `arg` buffer in simulate.ts, 0–1 after). Slow cloth (μs 0.002, μr 0.0005) keeps the ball
    // sliding with back- and sidespin for ≈14 s of 1 ms steps, then rolling at 4 ms steps, so
    // earliest(), drift() and every branch of friction() run ≈3 M times. Measured in a vitest
    // worker: 0–2 collections; 5–6 with any single boxed double put back per step (friction()
    // reading the captured `time`, earliest(rem) or friction(i, dt) taking a double argument, or —
    // after the corner-pocket test above — the pocket event's time computed before the ball loop);
    // 17–22 for the loop before the `arg` buffer. Unphysical cloth on purpose: this checks
    // allocation, not physics. A window in which the JIT has just deoptimised the loop allocates
    // too, so the best of up to three windows counts; a real per-step allocation shows in every
    // window.
    const p = withPhysics({ muSlide: 0.002, muRoll: 0.0005, spinDecel: 1, maxTime: 60 });
    const lone: SimBallInit[] = [{ id: 'c', pos: v2(-1, 0), vel: v2(0.4, 0), omega: { x: 0, y: -20, z: 30 } }];
    const run = (k: number) => {
      let steps = 0;
      for (let i = 0; i < k; i++) steps += simulate(table, lone, p, { record: false }).steps;
      return steps;
    };
    run(20); // warm up (JIT)
    let gcs = 0;
    const obs = new PerformanceObserver((list) => {
      gcs += list.getEntries().length;
    });
    obs.observe({ entryTypes: ['gc'] });
    let best = Infinity;
    for (let attempt = 0; attempt < 3 && best > 3; attempt++) {
      await new Promise((r) => setTimeout(r, 20));
      gcs = 0;
      const steps = run(150);
      await new Promise((r) => setTimeout(r, 20)); // GC entries are delivered asynchronously
      expect(steps).toBeGreaterThan(2_700_000);
      best = Math.min(best, gcs);
    }
    obs.disconnect();
    expect(best).toBeLessThanOrEqual(3);
  });

  it('no Math.hypot on the simulation paths (it allocates in V8)', () => {
    for (const f of ['simulate.ts', 'collide.ts']) {
      const src = readFileSync(new URL(`../../../src/core/physics/${f}`, import.meta.url), 'utf8');
      expect(src).not.toMatch(/Math\.hypot/);
    }
  });
});
