/**
 * Continuous-collision, time-stepped rigid-ball simulator (research.md R-06).
 *
 * Per step: positions drift linearly; inside the step the earliest ball–ball / ball–cushion /
 * ball–jaw contact is solved exactly (quadratic) and resolved, then drifting continues. Cloth friction
 * then updates velocities analytically (sliding → rolling → stop transitions are clamped exactly).
 *
 * Contacts count only when the normal closing speed exceeds APPROACH_EPS (1e-9 m/s), so resting
 * contacts cannot loop at t = 0. Up to 64·n contacts are resolved exactly per step (a frozen rack
 * needs ≈40). If that budget is spent, every touching contact is resolved in sequential-impulse
 * sweeps and exact detection resumes; if it is spent again, the rest of the step is drifted in
 * sub-steps of ≤ R/8 with overlaps and cushion penetrations pushed out and resolved. No contact is
 * skipped on any path.
 *
 * Allocation (Constitution IV): the step loop allocates nothing except output records — SimEvent
 * objects (one per event), trajectory points when `record` is on, and FirstHit records (≤ n).
 *
 * Ball motion states:
 *  SLIDING  – contact-point slip u = v + ω×(−R ẑ) ≠ 0 → friction μs·g opposite û, slip decays at 7/2·μs·g
 *  ROLLING  – u = 0 → decelerates at μr·g, ω_xy locked to v
 *  SPINNING – at rest with sidespin only (ωz decays)
 *  STATIONARY, POCKETED
 */
import type { PocketId, PhysicsParams, SimEvent, SimEventKind, TableSpec, Trajectory, Vec2, Vec3 } from '../types';
import { APPROACH_EPS, resolveBallBall, resolveCushion, type BallArrays } from './collide';

const STATIONARY = 0;
const SPINNING = 1;
const SLIDING = 2;
const ROLLING = 3;
const POCKETED = 4;

const EPS_V = 1e-3; // m/s
const EPS_U = 1e-4; // m/s slip
const EPS_W = 0.05; // rad/s
/** Gap (m) at which the budget fallback treats a pair / cushion as touching. */
const TOUCH = 1e-9;

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
  /**
   * Debug/test hook, called after every step with the simulator's own position arrays and a
   * pocketed flag per ball (1 = pocketed). Read-only: do not keep or modify the arrays.
   */
  onStep?: (t: number, px: Float64Array, py: Float64Array, pocketed: Uint8Array) => void;
  /**
   * Debug/test: contacts resolved exactly per step before the fallback (relax all touching contacts,
   * then a guarded drift) takes over. Default 64·n.
   */
  maxContactsPerStep?: number;
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
  const ballEvents: SimEvent[][] = [];
  const events: SimEvent[] = [];
  const firstHits: Record<string, FirstHit> = {};
  const stopId = opts.stopOnFirstHitOf;
  let stopNow = false;
  // Contacts resolved exactly per step before the fallback; worst measured need: ≈40 for a frozen
  // 15-ball rack, ≈120 for a frozen line of 15.
  const maxContacts = Math.max(1, opts.maxContactsPerStep ?? 64 * n);
  const onStep = opts.onStep;
  const pocketedFlag = new Uint8Array(n);

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
    const vx = s.vx[i]!;
    const vy = s.vy[i]!;
    const ux = vx - R * s.wy[i]!;
    const uy = vy + R * s.wx[i]!;
    const speed = Math.sqrt(vx * vx + vy * vy);
    if (Math.sqrt(ux * ux + uy * uy) > EPS_U) {
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
    if (record) {
      points[i]!.push({ x: s.px[i]!, y: s.py[i]! });
      lastX[i] = s.px[i]!;
      lastY[i] = s.py[i]!;
    }
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
      const spi = Math.sqrt(vxi * vxi + vyi * vyi);
      // Ball–ball
      for (let j = 0; j < n; j++) {
        if (j === i || st[j] === POCKETED) continue;
        const jMoving = moving(j);
        if (jMoving && j < i) continue; // pair already handled from j
        const dx = s.px[j]! - pxi;
        const dy = s.py[j]! - pyi;
        const vxj = s.vx[j]!;
        const vyj = s.vy[j]!;
        const wx = vxj - vxi;
        const wy = vyj - vyi;
        const reach = (spi + Math.sqrt(vxj * vxj + vyj * vyj)) * horizon;
        const dd = Math.sqrt(dx * dx + dy * dy);
        if (dd - 2 * R > reach + 1e-9) continue;
        const b = dx * wx + dy * wy;
        if (-b <= APPROACH_EPS * dd) continue; // not approaching (closing speed −b/dd)
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
        if (vn >= -APPROACH_EPS) continue;
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
        const d2 = dx * dx + dy * dy;
        if (b * b <= APPROACH_EPS * APPROACH_EPS * d2) continue; // closing speed −b/|d| too small
        const c = d2 - R * R;
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
      const U = Math.sqrt(ux * ux + uy * uy);
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
        const v = Math.sqrt(s.vx[i]! * s.vx[i]! + s.vy[i]! * s.vy[i]!);
        st[i] = v > EPS_V ? ROLLING : STATIONARY;
        if (st[i] === STATIONARY) classify(i);
        else if (record) pushEvent(time + dt - rem, 'roll', i);
      }
    }
    if (st[i] === ROLLING && rem > 0) {
      const sp = Math.sqrt(s.vx[i]! * s.vx[i]! + s.vy[i]! * s.vy[i]!);
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
    for (let k = 0; k < table.pockets.length; k++) {
      const p = table.pockets[k]!;
      const dx = p.mouthCenter.x - x;
      const dy = p.mouthCenter.y - y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    return best.id;
  }

  function noteHit(a: number, b: number, t: number): void {
    const id = init[a]!.id;
    if (firstHits[id]) return;
    firstHits[id] = { other: init[b]!.id, t, pos: { x: s.px[a]!, y: s.py[a]! }, vel: { x: s.vx[a]!, y: s.vy[a]! } };
    if (id === stopId) stopNow = true;
  }

  /** Resolve one contact (kind 0 ball j, 1 cushion j, 2 jaw j), record it and re-classify. */
  function resolveContact(kind: number, i: number, j: number, t: number): void {
    if (kind === 0) {
      resolveBallBall(s, i, j, R, params);
      noteHit(i, j, t);
      noteHit(j, i, t);
      pushEvent(t, 'ball', i, init[j]!.id);
      pushEvent(t, 'ball', j, init[i]!.id);
      classify(i);
      classify(j);
    } else if (kind === 1) {
      const cu = table.cushions[j]!;
      resolveCushion(s, i, cu.n.x, cu.n.y, R, params);
      pushEvent(t, 'cushion', i);
      classify(i);
    } else {
      let nx = s.px[i]! - jawX[j]!;
      let ny = s.py[i]! - jawY[j]!;
      const d = Math.sqrt(nx * nx + ny * ny) || 1;
      nx /= d;
      ny /= d;
      resolveCushion(s, i, nx, ny, R, params);
      pushEvent(t, 'jaw', i);
      classify(i);
    }
  }

  /** Normal approach speed of the pair (i, j) along i→j, or −1 if they are not touching (gap > TOUCH). */
  function pairApproach(i: number, j: number): number {
    const dx = s.px[j]! - s.px[i]!;
    const dy = s.py[j]! - s.py[i]!;
    const dd = Math.sqrt(dx * dx + dy * dy);
    if (dd > 2 * R + TOUCH || dd === 0) return -1;
    return ((s.vx[i]! - s.vx[j]!) * dx + (s.vy[i]! - s.vy[j]!) * dy) / dd;
  }

  /**
   * Resolve ball i against every cushion segment and jaw point it touches (gap ≤ TOUCH) and is
   * still approaching. With `pushOut`, a ball found inside a cushion or jaw is first moved back to
   * the nose. Returns true if anything was resolved or moved.
   */
  function railContacts(i: number, t: number, pushOut: boolean): boolean {
    let any = false;
    for (let k = 0; k < table.cushions.length; k++) {
      const cu = table.cushions[k]!;
      const dn = (s.px[i]! - cu.a.x) * cu.n.x + (s.py[i]! - cu.a.y) * cu.n.y - R;
      if (dn > TOUCH || dn < -R) continue; // clear of it, or already past it (pocket throat)
      const ex = cu.b.x - cu.a.x;
      const ey = cu.b.y - cu.a.y;
      const u = ((s.px[i]! - cu.a.x) * ex + (s.py[i]! - cu.a.y) * ey) / (ex * ex + ey * ey);
      if (u <= 0 || u >= 1) continue; // ends are jaws
      if (pushOut && dn < 0) {
        s.px[i] = s.px[i]! - dn * cu.n.x;
        s.py[i] = s.py[i]! - dn * cu.n.y;
        any = true;
      }
      if (s.vx[i]! * cu.n.x + s.vy[i]! * cu.n.y < -APPROACH_EPS) {
        resolveContact(1, i, k, t);
        any = true;
      }
    }
    for (let k = 0; k < jawX.length; k++) {
      const dx = s.px[i]! - jawX[k]!;
      const dy = s.py[i]! - jawY[k]!;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > R + TOUCH || d === 0) continue;
      if (pushOut && d < R) {
        s.px[i] = jawX[k]! + (dx / d) * R;
        s.py[i] = jawY[k]! + (dy / d) * R;
        any = true;
      }
      if ((dx * s.vx[i]! + dy * s.vy[i]!) / d < -APPROACH_EPS) {
        resolveContact(2, i, k, t);
        any = true;
      }
    }
    return any;
  }

  /**
   * Budget fallback, part 1: resolve every touching, approaching contact in sequential-impulse
   * (Gauss–Seidel) sweeps until none is left (or n + 1 sweeps). Each impulse is the ordinary,
   * dissipative pairwise one, so no energy is created.
   */
  function relaxContacts(t: number): void {
    for (let sweep = 0; sweep <= n && !stopNow; sweep++) {
      let any = false;
      for (let i = 0; i < n; i++) {
        if (st[i] === POCKETED) continue;
        for (let j = i + 1; j < n; j++) {
          if (st[j] === POCKETED) continue;
          if (pairApproach(i, j) > APPROACH_EPS) {
            resolveContact(0, i, j, t);
            any = true;
          }
        }
        if (moving(i) && railContacts(i, t, false)) any = true;
      }
      if (!any) break;
    }
  }

  /**
   * Budget fallback, part 2: drift the rest of the step in sub-steps of at most R/8 of relative
   * travel; after each, push apart overlapping pairs and push balls out of cushions and jaws
   * (equal and opposite position corrections), resolving every contact that is still approaching.
   * Contacts are never skipped, only resolved up to R/8 late.
   */
  function guardedDrift(dt: number, t: number): void {
    let vmax = 0;
    for (let i = 0; i < n; i++) {
      if (!moving(i)) continue;
      const v = Math.sqrt(s.vx[i]! * s.vx[i]! + s.vy[i]! * s.vy[i]!);
      if (v > vmax) vmax = v;
    }
    const nsub = Math.max(1, Math.ceil((2 * vmax * dt) / (R / 8)));
    const h = dt / nsub;
    for (let k = 1; k <= nsub && !stopNow; k++) {
      drift(h);
      const tk = t + k * h;
      // Position projection, sweeping in alternating index order so a correction travels the
      // whole length of a chain pressed against a rail in one pass.
      for (let pass = 0; pass < 4 * n + 32; pass++) {
        let any = false;
        const fwd = (pass & 1) === 0;
        for (let a = 0; a < n; a++) {
          const i = fwd ? a : n - 1 - a;
          if (st[i] === POCKETED) continue;
          if (railContacts(i, tk, true)) any = true;
          for (let b = a + 1; b < n; b++) {
            const j = fwd ? b : n - 1 - b;
            if (st[j] !== POCKETED && separatePair(i, j, tk)) any = true;
          }
        }
        if (!any) break;
      }
    }
  }

  /** Push an overlapping pair apart (equal and opposite) and resolve it if still approaching. */
  function separatePair(i: number, j: number, t: number): boolean {
    const dx = s.px[j]! - s.px[i]!;
    const dy = s.py[j]! - s.py[i]!;
    const dd = Math.sqrt(dx * dx + dy * dy);
    const pen = 2 * R - dd;
    if (pen <= 1e-12 || dd === 0) return false;
    const half = (0.5 * pen) / dd;
    s.px[i] = s.px[i]! - dx * half;
    s.py[i] = s.py[i]! - dy * half;
    s.px[j] = s.px[j]! + dx * half;
    s.py[j] = s.py[j]! + dy * half;
    if (pairApproach(i, j) > APPROACH_EPS) resolveContact(0, i, j, t);
    return true;
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
    let budget = maxContacts;
    let relaxes = 0;
    while (rem > 0 && !stopNow) {
      if (budget === 0) {
        // Contact budget spent (a dense cluster of t = 0 contacts, or a forced test budget):
        // resolve every touching contact together, then go back to exact detection. If the budget
        // runs out again, finish the step with a drift that still detects every contact.
        const tNow = time + (dt - rem);
        if (relaxes < 2) {
          relaxes++;
          relaxContacts(tNow);
          budget = maxContacts;
          continue;
        }
        guardedDrift(rem, tNow);
        rem = 0;
        break;
      }
      budget--;
      earliest(rem);
      if (contact.i < 0) {
        drift(rem);
        rem = 0;
        break;
      }
      drift(contact.t);
      rem -= contact.t;
      resolveContact(contact.kind, contact.i, contact.j, time + (dt - rem));
    }
    if (stopNow) break;

    for (let i = 0; i < n; i++) {
      const k = st[i];
      if (k === STATIONARY || k === POCKETED) continue;
      friction(i, dt);
      // Pocket capture: the centre can only leave the nose rectangle through a pocket gap.
      if (Math.abs(s.px[i]!) > hx || Math.abs(s.py[i]!) > hy) {
        pocketOf[i] = nearestPocket(s.px[i]!, s.py[i]!);
        pocketSpeed[i] = Math.sqrt(s.vx[i]! * s.vx[i]! + s.vy[i]! * s.vy[i]!);
        pushEvent(time + dt, 'pocket', i, pocketOf[i]!);
        st[i] = POCKETED;
        pocketedFlag[i] = 1;
        s.vx[i] = 0;
        s.vy[i] = 0;
        continue;
      }
      if (record && (Math.abs(s.px[i]! - lastX[i]!) > spacing || Math.abs(s.py[i]! - lastY[i]!) > spacing)) {
        points[i]!.push({ x: s.px[i]!, y: s.py[i]! });
        lastX[i] = s.px[i]!;
        lastY[i] = s.py[i]!;
      }
    }
    time += dt;
    steps++;
    if (onStep) onStep(time, s.px, s.py, pocketedFlag);
  }

  const trajectories: Trajectory[] = [];
  const final: Record<string, BallFinal> = {};
  for (let i = 0; i < n; i++) {
    const id = init[i]!.id;
    const pos = { x: s.px[i]!, y: s.py[i]! };
    const pts = points[i]!;
    const last = pts[pts.length - 1]!;
    if (record && (last.x !== pos.x || last.y !== pos.y)) pts.push(pos);
    trajectories.push({
      ballId: id,
      points: pts,
      events: ballEvents[i]!,
      rest: pocketOf[i] ? null : pos,
      pocket: pocketOf[i] ?? null,
    });
    final[id] = { pos, pocket: pocketOf[i] ?? null, pocketSpeed: pocketSpeed[i]! };
  }
  return { trajectories, events, final, firstHits, time, steps };
}

/** Total kinetic energy per unit mass (translational + rotational), for tests. */
export function kineticEnergy(v: Vec2, w: Vec3, R: number): number {
  return 0.5 * (v.x * v.x + v.y * v.y) + 0.5 * 0.4 * R * R * (w.x * w.x + w.y * w.y + w.z * w.z);
}
