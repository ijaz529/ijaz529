/**
 * Continuous-collision, time-stepped rigid-ball simulator (research.md R-06).
 *
 * Per step: positions drift linearly; inside the step the earliest ball–ball / ball–cushion /
 * ball–jaw contact is solved exactly (quadratic) and resolved, then drifting continues. Cloth friction
 * then updates velocities analytically (sliding → rolling → stop transitions are clamped exactly).
 *
 * Ball motion states:
 *  SLIDING  – contact-point slip u = v + ω×(−R ẑ) ≠ 0 → friction μs·g opposite û, slip decays at 7/2·μs·g
 *  ROLLING  – u = 0 → decelerates at μr·g, ω_xy locked to v
 *  SPINNING – at rest with sidespin only (ωz decays)
 *  STATIONARY, POCKETED
 */
import type { PocketId, PhysicsParams, SimEvent, SimEventKind, TableSpec, Trajectory, Vec2, Vec3 } from '../types';
import { resolveBallBall, resolveCushion, type BallArrays } from './collide';

const STATIONARY = 0;
const SPINNING = 1;
const SLIDING = 2;
const ROLLING = 3;
const POCKETED = 4;

const EPS_V = 1e-3; // m/s
const EPS_U = 1e-4; // m/s slip
const EPS_W = 0.05; // rad/s

export interface SimBallInit {
  id: string;
  pos: Vec2;
  vel?: Vec2;
  omega?: Vec3;
}

export interface SimOptions {
  maxTime?: number;
  /** Record trajectory polylines (needed for drawing; off for searches). */
  record?: boolean;
  /** Spacing of recorded points (m). */
  recordSpacing?: number;
  /** End the simulation as soon as this ball has its first ball–ball collision (cheap aim probes). */
  stopOnFirstHitOf?: string;
}

export interface FirstHit {
  other: string;
  t: number;
  pos: Vec2;
  /** Velocity immediately after the collision. */
  vel: Vec2;
}

export interface BallFinal {
  pos: Vec2;
  pocket: PocketId | null;
  /** Speed when it crossed into the pocket (pocketed balls only). */
  pocketSpeed: number;
}

export interface SimResult {
  trajectories: Trajectory[];
  events: SimEvent[];
  final: Record<string, BallFinal>;
  /** Each ball's first ball–ball collision (if any). */
  firstHits: Record<string, FirstHit>;
  time: number;
  steps: number;
}

interface Contact {
  t: number;
  kind: 0 | 1 | 2; // 0 ball, 1 cushion, 2 jaw
  i: number;
  j: number; // other ball, cushion index, or jaw index
}

export function simulate(table: TableSpec, init: SimBallInit[], params: PhysicsParams, opts: SimOptions = {}): SimResult {
  const n = init.length;
  const R = table.ballRadius;
  const hx = table.length / 2;
  const hy = table.width / 2;
  const record = opts.record ?? true;
  const spacing = opts.recordSpacing ?? 0.02;
  const maxTime = opts.maxTime ?? params.maxTime;
  const g = params.g;

  const s: BallArrays = {
    px: new Float64Array(n),
    py: new Float64Array(n),
    vx: new Float64Array(n),
    vy: new Float64Array(n),
    wx: new Float64Array(n),
    wy: new Float64Array(n),
    wz: new Float64Array(n),
  };
  const st = new Uint8Array(n);
  const pocketOf: (PocketId | null)[] = new Array(n).fill(null);
  const pocketSpeed = new Float64Array(n);
  const lastX = new Float64Array(n);
  const lastY = new Float64Array(n);
  const points: Vec2[][] = [];
  // Per recorded point: simulated time and ω (only when recording; replays show slide and spin).
  const times: number[][] = [];
  const spins: Vec3[][] = [];
  const ballEvents: SimEvent[][] = [];
  const events: SimEvent[] = [];
  const firstHits: Record<string, FirstHit> = {};
  const stopId = opts.stopOnFirstHitOf;
  let stopNow = false;

  for (let i = 0; i < n; i++) {
    const b = init[i]!;
    s.px[i] = b.pos.x;
    s.py[i] = b.pos.y;
    s.vx[i] = b.vel?.x ?? 0;
    s.vy[i] = b.vel?.y ?? 0;
    s.wx[i] = b.omega?.x ?? 0;
    s.wy[i] = b.omega?.y ?? 0;
    s.wz[i] = b.omega?.z ?? 0;
    lastX[i] = b.pos.x;
    lastY[i] = b.pos.y;
    points.push([{ x: b.pos.x, y: b.pos.y }]);
    times.push([0]);
    spins.push([{ x: s.wx[i]!, y: s.wy[i]!, z: s.wz[i]! }]);
    ballEvents.push([]);
    classify(i);
  }

  // Jaw points (unique segment endpoints).
  const jawX: number[] = [];
  const jawY: number[] = [];
  for (const c of table.cushions) {
    jawX.push(c.a.x, c.b.x);
    jawY.push(c.a.y, c.b.y);
  }

  function classify(i: number): void {
    if (st[i] === POCKETED) return;
    const ux = s.vx[i]! - R * s.wy[i]!;
    const uy = s.vy[i]! + R * s.wx[i]!;
    const speed = Math.hypot(s.vx[i]!, s.vy[i]!);
    if (Math.hypot(ux, uy) > EPS_U) {
      st[i] = SLIDING;
    } else if (speed > EPS_V) {
      st[i] = ROLLING;
      s.wx[i] = -s.vy[i]! / R;
      s.wy[i] = s.vx[i]! / R;
    } else {
      s.vx[i] = 0;
      s.vy[i] = 0;
      s.wx[i] = 0;
      s.wy[i] = 0;
      if (Math.abs(s.wz[i]!) > EPS_W) st[i] = SPINNING;
      else {
        s.wz[i] = 0;
        st[i] = STATIONARY;
      }
    }
  }

  function pushEvent(t: number, kind: SimEventKind, i: number, other?: string): void {
    const ev: SimEvent = { t, kind, ballId: init[i]!.id, pos: { x: s.px[i]!, y: s.py[i]! } };
    if (other !== undefined) ev.otherId = other;
    events.push(ev);
    ballEvents[i]!.push(ev);
    if (record) mark(i, t);
  }

  /** Records point i at time t (with its ω after any event at that instant). */
  function mark(i: number, t: number): void {
    points[i]!.push({ x: s.px[i]!, y: s.py[i]! });
    times[i]!.push(t);
    spins[i]!.push({ x: s.wx[i]!, y: s.wy[i]!, z: s.wz[i]! });
    lastX[i] = s.px[i]!;
    lastY[i] = s.py[i]!;
  }

  function moving(i: number): boolean {
    const k = st[i];
    return (k === SLIDING || k === ROLLING) && (s.vx[i] !== 0 || s.vy[i] !== 0);
  }

  const contact: Contact = { t: Infinity, kind: 0, i: -1, j: -1 };

  /** Find the earliest contact within [0, horizon]. */
  function earliest(horizon: number): void {
    contact.t = Infinity;
    contact.i = -1;
    const R2 = 4 * R * R;
    for (let i = 0; i < n; i++) {
      if (!moving(i)) continue;
      const pxi = s.px[i]!;
      const pyi = s.py[i]!;
      const vxi = s.vx[i]!;
      const vyi = s.vy[i]!;
      const spi = Math.hypot(vxi, vyi);
      // Ball–ball
      for (let j = 0; j < n; j++) {
        if (j === i || st[j] === POCKETED) continue;
        const jMoving = moving(j);
        if (jMoving && j < i) continue; // pair already handled from j
        const dx = s.px[j]! - pxi;
        const dy = s.py[j]! - pyi;
        const wx = s.vx[j]! - vxi;
        const wy = s.vy[j]! - vyi;
        const reach = (spi + Math.hypot(s.vx[j]!, s.vy[j]!)) * horizon;
        const dd = Math.hypot(dx, dy);
        if (dd - 2 * R > reach + 1e-9) continue;
        const b = dx * wx + dy * wy;
        if (b >= 0) continue; // not approaching
        const a = wx * wx + wy * wy;
        const c = dx * dx + dy * dy - R2;
        let t: number;
        if (c <= 0) t = 0;
        else {
          const disc = b * b - a * c;
          if (disc < 0) continue;
          t = (-b - Math.sqrt(disc)) / a;
        }
        if (t >= 0 && t <= horizon && t < contact.t) {
          contact.t = t;
          contact.kind = 0;
          contact.i = i;
          contact.j = j;
        }
      }
      // Cushion segments
      for (let k = 0; k < table.cushions.length; k++) {
        const cu = table.cushions[k]!;
        const vn = vxi * cu.n.x + vyi * cu.n.y;
        if (vn >= 0) continue;
        const dn = (pxi - cu.a.x) * cu.n.x + (pyi - cu.a.y) * cu.n.y - R;
        const t = dn <= 0 ? 0 : dn / -vn;
        if (t > horizon || t >= contact.t) continue;
        const cx = pxi + vxi * t;
        const cy = pyi + vyi * t;
        const ex = cu.b.x - cu.a.x;
        const ey = cu.b.y - cu.a.y;
        const u = ((cx - cu.a.x) * ex + (cy - cu.a.y) * ey) / (ex * ex + ey * ey);
        if (u <= 0 || u >= 1) continue; // ends handled as jaws
        if (dn < -R) continue; // already past the cushion (in the pocket throat)
        contact.t = t;
        contact.kind = 1;
        contact.i = i;
        contact.j = k;
      }
      // Jaw points (radius 0): |p + v t − J| = R
      for (let k = 0; k < jawX.length; k++) {
        const dx = pxi - jawX[k]!;
        const dy = pyi - jawY[k]!;
        const b = dx * vxi + dy * vyi;
        if (b >= 0) continue;
        const c = dx * dx + dy * dy - R * R;
        const a = vxi * vxi + vyi * vyi;
        let t: number;
        if (c <= 0) t = 0;
        else {
          const disc = b * b - a * c;
          if (disc < 0) continue;
          t = (-b - Math.sqrt(disc)) / a;
        }
        if (t >= 0 && t <= horizon && t < contact.t) {
          contact.t = t;
          contact.kind = 2;
          contact.i = i;
          contact.j = k;
        }
      }
    }
  }

  function drift(dt: number): void {
    for (let i = 0; i < n; i++) {
      if (st[i] === SLIDING || st[i] === ROLLING) {
        s.px[i] = s.px[i]! + s.vx[i]! * dt;
        s.py[i] = s.py[i]! + s.vy[i]! * dt;
      }
    }
  }

  function friction(i: number, dt: number): void {
    // Sidespin decay (independent of translation for a level-cue model).
    const wz = s.wz[i]!;
    if (wz !== 0) {
      const d = params.spinDecel * dt;
      s.wz[i] = Math.abs(wz) <= d ? 0 : wz - Math.sign(wz) * d;
    }
    let rem = dt;
    if (st[i] === SLIDING) {
      const ux = s.vx[i]! - R * s.wy[i]!;
      const uy = s.vy[i]! + R * s.wx[i]!;
      const U = Math.hypot(ux, uy);
      const rate = 3.5 * params.muSlide * g;
      const tau = Math.min(rem, U / rate);
      const ex = ux / U;
      const ey = uy / U;
      const a = params.muSlide * g * tau;
      s.vx[i] = s.vx[i]! - a * ex;
      s.vy[i] = s.vy[i]! - a * ey;
      const k = ((2.5 * params.muSlide * g) / R) * tau;
      s.wx[i] = s.wx[i]! - k * ey;
      s.wy[i] = s.wy[i]! + k * ex;
      rem -= tau;
      if (rem > 0 || tau === U / rate) {
        // reached natural roll
        s.wx[i] = -s.vy[i]! / R;
        s.wy[i] = s.vx[i]! / R;
        st[i] = Math.hypot(s.vx[i]!, s.vy[i]!) > EPS_V ? ROLLING : STATIONARY;
        if (st[i] === STATIONARY) classify(i);
        else if (record) pushEvent(time + dt - rem, 'roll', i);
      }
    }
    if (st[i] === ROLLING && rem > 0) {
      const sp = Math.hypot(s.vx[i]!, s.vy[i]!);
      const dv = params.muRoll * g * rem;
      if (sp <= dv) {
        s.vx[i] = 0;
        s.vy[i] = 0;
        s.wx[i] = 0;
        s.wy[i] = 0;
        st[i] = Math.abs(s.wz[i]!) > EPS_W ? SPINNING : STATIONARY;
        pushEvent(time + dt, 'stop', i);
      } else {
        const k = (sp - dv) / sp;
        s.vx[i] = s.vx[i]! * k;
        s.vy[i] = s.vy[i]! * k;
        s.wx[i] = -s.vy[i]! / R;
        s.wy[i] = s.vx[i]! / R;
      }
    }
    if (st[i] === SPINNING && s.wz[i] === 0) st[i] = STATIONARY;
  }

  function nearestPocket(x: number, y: number): PocketId {
    let best = table.pockets[0]!;
    let bd = Infinity;
    for (const p of table.pockets) {
      const d = Math.hypot(p.mouthCenter.x - x, p.mouthCenter.y - y);
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    return best.id;
  }

  let time = 0;
  let steps = 0;
  while (time < maxTime) {
    let anyMoving = false;
    let anySliding = false;
    for (let i = 0; i < n; i++) {
      if (st[i] === SLIDING) {
        anySliding = true;
        anyMoving = true;
      } else if (st[i] === ROLLING) anyMoving = true;
    }
    if (!anyMoving) break;
    const dt = anySliding ? params.dt : Math.max(params.dt, 0.004);

    // Drift with exact contact handling.
    let rem = dt;
    for (let iter = 0; iter < 24 && rem > 0; iter++) {
      earliest(rem);
      if (contact.i < 0) {
        drift(rem);
        rem = 0;
        break;
      }
      drift(contact.t);
      rem -= contact.t;
      const i = contact.i;
      const tNow = time + (dt - rem);
      if (contact.kind === 0) {
        const j = contact.j;
        resolveBallBall(s, i, j, R, params);
        for (const [a, b] of [
          [i, j],
          [j, i],
        ] as const) {
          const id = init[a]!.id;
          if (!firstHits[id]) {
            firstHits[id] = { other: init[b]!.id, t: tNow, pos: { x: s.px[a]!, y: s.py[a]! }, vel: { x: s.vx[a]!, y: s.vy[a]! } };
            if (id === stopId) stopNow = true;
          }
        }
        pushEvent(tNow, 'ball', i, init[j]!.id);
        pushEvent(tNow, 'ball', j, init[i]!.id);
        classify(i);
        classify(j);
        if (stopNow) break;
      } else if (contact.kind === 1) {
        const cu = table.cushions[contact.j]!;
        resolveCushion(s, i, cu.n.x, cu.n.y, R, params);
        pushEvent(tNow, 'cushion', i);
        classify(i);
      } else {
        const k = contact.j;
        let nx = s.px[i]! - jawX[k]!;
        let ny = s.py[i]! - jawY[k]!;
        const d = Math.hypot(nx, ny) || 1;
        nx /= d;
        ny /= d;
        resolveCushion(s, i, nx, ny, R, params);
        pushEvent(tNow, 'jaw', i);
        classify(i);
      }
    }
    if (stopNow) break;
    if (rem > 0) drift(rem); // safety: iteration cap reached

    for (let i = 0; i < n; i++) {
      const k = st[i];
      if (k === STATIONARY || k === POCKETED) continue;
      friction(i, dt);
      // Pocket capture: the centre can only leave the nose rectangle through a pocket gap.
      if (Math.abs(s.px[i]!) > hx || Math.abs(s.py[i]!) > hy) {
        pocketOf[i] = nearestPocket(s.px[i]!, s.py[i]!);
        pocketSpeed[i] = Math.hypot(s.vx[i]!, s.vy[i]!);
        pushEvent(time + dt, 'pocket', i, pocketOf[i]!);
        st[i] = POCKETED;
        s.vx[i] = 0;
        s.vy[i] = 0;
        continue;
      }
      if (record && (Math.abs(s.px[i]! - lastX[i]!) > spacing || Math.abs(s.py[i]! - lastY[i]!) > spacing)) mark(i, time + dt);
    }
    time += dt;
    steps++;
  }

  const trajectories: Trajectory[] = [];
  const final: Record<string, BallFinal> = {};
  for (let i = 0; i < n; i++) {
    const id = init[i]!.id;
    const pos = { x: s.px[i]!, y: s.py[i]! };
    const pts = points[i]!;
    const last = pts[pts.length - 1]!;
    if (record && (last.x !== pos.x || last.y !== pos.y)) {
      pts.push(pos);
      times[i]!.push(time);
      spins[i]!.push({ x: s.wx[i]!, y: s.wy[i]!, z: s.wz[i]! });
    }
    trajectories.push({
      ballId: id,
      points: pts,
      events: ballEvents[i]!,
      rest: pocketOf[i] ? null : pos,
      pocket: pocketOf[i] ?? null,
      ...(record ? { times: times[i]!, spins: spins[i]! } : {}),
    });
    final[id] = { pos, pocket: pocketOf[i] ?? null, pocketSpeed: pocketSpeed[i]! };
  }
  return { trajectories, events, final, firstHits, time, steps };
}

/** Total kinetic energy per unit mass (translational + rotational), for tests. */
export function kineticEnergy(v: Vec2, w: Vec3, R: number): number {
  return 0.5 * (v.x * v.x + v.y * v.y) + 0.5 * 0.4 * R * R * (w.x * w.x + w.y * w.y + w.z * w.z);
}
