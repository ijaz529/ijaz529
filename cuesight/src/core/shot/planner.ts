/**
 * planShot(): the full, physics-grounded ShotPlan for a target ball + pocket (FR-009…FR-017).
 *
 * 1. Geometry: pocket window → object-ball (OB) aim direction → ghost ball → cut angle, fraction,
 *    tolerance. When the window bisector would put the ghost ball inside the cushion (a ball frozen
 *    to a rail) the aim moves to the centre of the part of the window whose ghost is on the table.
 *    A cue ball (CB) touching the OB is its own case: the OB leaves along the line of centres, turned
 *    only by throw, so there is no ghost ball to aim at.
 * 2. Obstructions on the CB → ghost and OB → mouth paths.
 * 3. Stroke: player override, recommended (from the planner worker) or a default.
 * 4. Throw compensation: probe-simulate the impact (CB + OB only), measure the OB's actual departure
 *    angle and re-aim with a bracketed secant search (≤ 4 probes) that keeps the ghost on the table.
 *    A probe counts only when the CB reaches the OB before any cushion or jaw; if none does, the
 *    geometric aim is kept. When the search cannot bring the departure inside the window and the
 *    simulated ball then misses, the miss is put down to throw ('throw-uncompensable'), not speed.
 *    Frozen CB: the same kind of search over the stroke angle (≤ 5 probes).
 * 5. Full simulation on the real layout → paths, rest positions, scratch/kiss/miss/too-soft warnings.
 */
import { straightLineState } from '../physics/analytic';
import { simulate, type SimBallInit } from '../physics/simulate';
import { strikeBall } from '../physics/strike';
import { POCKET_NAMES } from '../table';
import type {
  Ball,
  PhysicsParams,
  PocketId,
  PocketSpec,
  ShotPlan,
  ShotRequest,
  Stroke,
  TableLayout,
  TableSpec,
  Trajectory,
  Vec2,
  Warning,
} from '../types';
import { angleBetween, cross, deg, dist, fromAngle, angleOf, norm, rad, sub } from '../vec';
import { coachingTip, contactSpinOf, difficultyOf, type ThrowShiftDir } from './coach';
import { cutAngle, cutSide, fractionOf, ghostBall, contactPoint } from './geometry';
import { pathBlockers } from './obstruction';
import { mouthIntersect, pocketWindow, type PocketWindow } from './pocket-window';
import { powerToSpeed } from './power';

export const MAX_CUT_DEG = 88;
export const THIN_CUT_DEG = 80;
/** A CB closer than 2R + this (m) to the OB is frozen to it (touching, or overlapping by detection noise). */
export const FROZEN_EPS = 1e-3;
/**
 * ASSUMPTION: the largest angle (rad) throw can turn the OB off the line of centres when the CB is
 * frozen to it. Throw is bounded by atan(μ) [A TP A.14], μ ≈ 0.06–0.07 at the slow contact speeds
 * of a frozen shot (params.ballFriction), so ≈ 3.5–4°; 4° is used.
 */
export const FROZEN_MAX_THROW = rad(4);
/** How far (m) the ghost-ball centre may sit past a cushion line and still count as on the table. */
export const GHOST_RAIL_SLACK = 1e-3;
/** Margin (m) inside the cushion lines that the throw search keeps the ghost, so the CB meets the OB first. */
const GHOST_CLEAR = 1e-5;
/**
 * ASSUMPTION: speed (m/s) the analytic chain must still give the OB at the capture line (where its
 * centre leaves the cushion-nose rectangle, simulate.ts) for minPower. A small margin for the
 * analytic model's straight-line simplifications, not a physical constant.
 */
export const CAPTURE_MIN_SPEED = 0.02;
/**
 * How far past the window edges (rad) the throw search may aim the OB: the model's throw is at most
 * atan(μmax) = atan(a + b) ≈ 6.7° (TP A.14 with params.ballFriction), so 8° covers it.
 */
const THROW_SEARCH_RAD = rad(8);
const THROW_PROBES = 4;
const FROZEN_PROBES = 5;
const FROZEN_FIRST_STEP = rad(20);
const FROZEN_MAX_STROKE = rad(60);

/** Why a pocket can't be played directly (player text is built in planShot). */
export type NotMakeableReason = 'no-window' | 'wrong-side' | 'ghost-off-table' | 'too-thin' | 'frozen-line';

export interface ShotGeometry {
  pocket: PocketSpec;
  /** Pocket window; for a rail-frozen OB, the part of it whose ghost ball is on the table. */
  window: PocketWindow;
  ghost: Vec2;
  /** CB travel direction (frozen: the line of centres). */
  aimDir: Vec2;
  cut: number;
  cbDistance: number;
  /**
   * CB aim tolerance (rad) that keeps the OB in the window; 0 when not makeable. Frozen CB: the
   * margin of the line of centres (± throw) inside the window instead.
   */
  toleranceRad: number;
  /** Ghost-ball tolerance (mm, lateral) for the same margin; 0 when not makeable. */
  toleranceMm: number;
  ghostOnTable: boolean;
  blockersCue: Ball[];
  blockersObject: Ball[];
  makeable: boolean;
  /** Set when not makeable. */
  reason?: NotMakeableReason;
  /** OB aim angles (rad, absolute) the throw search may use: ghost on the table, near the window. */
  aimLo: number;
  aimHi: number;
  /** OB travel along window.dir until its centre crosses the capture line (≥ window.distance). */
  captureDistance: number;
  /** The CB touches (or overlaps) the OB. */
  frozen: boolean;
}

/** Distance along `dir` from `p` (inside the nose rectangle) to where it leaves the rectangle. */
function exitDistance(p: Vec2, dir: Vec2, hx: number, hy: number): number {
  let d = Infinity;
  if (Math.abs(dir.x) > 1e-12) d = Math.min(d, (hx - Math.sign(dir.x) * p.x) / Math.abs(dir.x));
  if (Math.abs(dir.y) > 1e-12) d = Math.min(d, (hy - Math.sign(dir.y) * p.y) / Math.abs(dir.y));
  return Number.isFinite(d) ? Math.max(0, d) : 0;
}

/**
 * Is the ghost ball for OB aim angle `a` inside |x| ≤ lx, |y| ≤ ly? Used with the rail slack for
 * makeability, and strictly inside the cushion lines (ghost reached before any cushion) for the
 * throw search.
 */
function ghostWithin(ob: Vec2, a: number, R: number, lx: number, ly: number): boolean {
  return Math.abs(ob.x - 2 * R * Math.cos(a)) <= lx && Math.abs(ob.y - 2 * R * Math.sin(a)) <= ly;
}

/** Boundary of ghostWithin between `inA` (inside) and `outA` (bisection), or `outA` if it is inside too. */
function ghostEdge(ob: Vec2, R: number, lx: number, ly: number, inA: number, outA: number): number {
  if (ghostWithin(ob, outA, R, lx, ly)) return outA;
  let a = inA;
  let b = outA;
  for (let k = 0; k < 20; k++) {
    const m = (a + b) / 2;
    if (ghostWithin(ob, m, R, lx, ly)) a = m;
    else b = m;
  }
  return a;
}

/**
 * For an OB whose window bisector puts the ghost inside the cushion: the longest run of the window
 * whose ghost is on the table (within the slack), as [lo, hi] angles, or null if there is none.
 */
function feasibleRun(ob: Vec2, w: PocketWindow, R: number, lx: number, ly: number): [number, number] | null {
  const a0 = angleOf(w.dir) - w.halfRad;
  const step = (2 * w.halfRad) / 64;
  let bestI = -1;
  let bestN = 0;
  let runI = -1;
  for (let i = 0; i <= 64; i++) {
    if (ghostWithin(ob, a0 + i * step, R, lx, ly)) {
      if (runI < 0) runI = i;
      if (i - runI + 1 > bestN) {
        bestN = i - runI + 1;
        bestI = runI;
      }
    } else runI = -1;
  }
  if (bestN === 0) return null;
  const iHi = bestI + bestN - 1;
  const lo = bestI > 0 ? ghostEdge(ob, R, lx, ly, a0 + bestI * step, a0 + (bestI - 1) * step) : a0;
  const hi = iHi < 64 ? ghostEdge(ob, R, lx, ly, a0 + iHi * step, a0 + (iHi + 1) * step) : a0 + 64 * step;
  return [lo, hi];
}

/** Throw-search range: the run of strictly clear aims nearest the window centre `mid`, within ±reach. */
function throwAimRange(ob: Vec2, mid: number, reach: number, R: number, lx: number, ly: number): [number, number] {
  let seed = ghostWithin(ob, mid, R, lx, ly) ? mid : NaN;
  for (let i = 1; i <= 32 && Number.isNaN(seed); i++)
    for (const s of [1, -1]) {
      const a = mid + (s * i * reach) / 32;
      if (ghostWithin(ob, a, R, lx, ly)) {
        seed = ghostEdge(ob, R, lx, ly, a, mid);
        break;
      }
    }
  if (Number.isNaN(seed)) return [mid, mid];
  return [seed > mid ? seed : ghostEdge(ob, R, lx, ly, seed, mid - reach), seed < mid ? seed : ghostEdge(ob, R, lx, ly, seed, mid + reach)];
}

/** Pure geometry for one target/pocket pair (no simulation) — also used by suggestions. */
export function shotGeometry(table: TableSpec, balls: Ball[], cue: Ball, target: Ball, pocket: PocketSpec): ShotGeometry {
  const R = table.ballRadius;
  const hx = table.length / 2;
  const hy = table.width / 2;
  const limX = hx - R + GHOST_RAIL_SLACK;
  const limY = hy - R + GHOST_RAIL_SLACK;
  const ob = target.pos;

  const frozen = dist(cue.pos, ob) <= 2 * R + FROZEN_EPS;
  let window = pocketWindow(ob, pocket, R);
  if (!frozen && window.ok && !ghostWithin(ob, angleOf(window.dir), R, limX, limY)) {
    // The bisector's ghost is inside the cushion (OB on or near a rail): aim at the centre of the
    // longest part of the window whose ghost is on the table.
    const run = feasibleRun(ob, window, R, limX, limY);
    if (run) {
      const dir = fromAngle((run[0] + run[1]) / 2);
      const halfRad = Math.max(0, (run[1] - run[0]) / 2);
      if (window.distance > 0) {
        const m = mouthIntersect(ob, dir, pocket);
        window = { ok: window.ok, dir, halfRad, mouthHit: m.mouthHit, distance: Math.max(0, m.t) };
      } else window = { ok: window.ok, dir, halfRad, mouthHit: window.mouthHit, distance: window.distance };
    }
  }
  const mid = angleOf(window.dir);
  const captureDistance = window.distance + exitDistance(window.mouthHit, window.dir, hx, hy);
  const clearance = 2 * R - 5e-4;
  const blockersObject = pathBlockers(target.pos, window.mouthHit, balls, clearance, [cue.id, target.id]);

  if (frozen) {
    // The OB can only leave along the line of centres, turned by at most FROZEN_MAX_THROW of throw.
    const lc = sub(target.pos, cue.pos);
    const u = Math.hypot(lc.x, lc.y) > 1e-9 ? norm(lc) : window.dir;
    const alpha = Math.abs(angleBetween(u, window.dir));
    const makeable = window.ok && alpha <= window.halfRad + FROZEN_MAX_THROW;
    // Margin (rad of OB direction): any throw in [α − half, α + half] pots it and at most
    // FROZEN_MAX_THROW is available, so the throw margin is half the width of
    // [α − half, min(α + half, max)]: the full half-width while little throw is needed, falling to 0
    // at α = half + max. A straight push already has margin half − α. Continuous in α.
    const tol = makeable
      ? Math.max(0, window.halfRad - alpha, 0.5 * (Math.min(alpha + window.halfRad, FROZEN_MAX_THROW) - (alpha - window.halfRad)))
      : 0;
    const reason: NotMakeableReason | undefined = makeable ? undefined : !window.ok ? 'no-window' : 'frozen-line';
    return {
      pocket,
      window,
      ghost: { x: cue.pos.x, y: cue.pos.y },
      aimDir: u,
      cut: 0,
      cbDistance: 0,
      toleranceRad: tol,
      toleranceMm: tol * 2 * R * 1000,
      ghostOnTable: true,
      blockersCue: [],
      blockersObject,
      makeable,
      reason,
      aimLo: mid, // no ghost to move: the frozen search turns the stroke instead
      aimHi: mid,
      captureDistance,
      frozen,
    };
  }

  const ghost = ghostBall(target.pos, window.dir, R);
  const cut = cutAngle(cue.pos, ghost, window.dir);
  const cbDistance = dist(cue.pos, ghost);
  const ghostOnTable = Math.abs(ghost.x) <= limX && Math.abs(ghost.y) <= limY;
  const blockersCue = pathBlockers(cue.pos, ghost, balls, clearance, [cue.id, target.id]);
  // Balls overlapping the ghost-ball spot also block.
  for (const b of balls) {
    if (b.id === cue.id || b.id === target.id || blockersCue.includes(b)) continue;
    if (dist(b.pos, ghost) < clearance) blockersCue.push(b);
  }
  const cutDeg = deg(cut);
  const reason: NotMakeableReason | undefined = !window.ok
    ? 'no-window'
    : cutDeg >= 90
      ? 'wrong-side'
      : !ghostOnTable
        ? 'ghost-off-table'
        : cutDeg >= MAX_CUT_DEG
          ? 'too-thin'
          : undefined;
  const makeable = reason === undefined;
  const cosCut = Math.max(0, Math.cos(cut));
  // Throw-search range (only planShot uses it): strictly clear ghosts, up to 8° past the window.
  const range = makeable ? throwAimRange(ob, mid, window.halfRad + THROW_SEARCH_RAD, R, hx - R - GHOST_CLEAR, hy - R - GHOST_CLEAR) : null;
  return {
    pocket,
    window,
    ghost,
    aimDir: norm(sub(ghost, cue.pos)),
    cut,
    cbDistance,
    toleranceRad: makeable ? (window.halfRad * 2 * R * cosCut) / Math.max(cbDistance, 2 * R) : 0,
    toleranceMm: makeable ? window.halfRad * 2 * R * cosCut * 1000 : 0,
    ghostOnTable,
    blockersCue,
    blockersObject,
    makeable,
    reason,
    aimLo: range ? range[0] : mid,
    aimHi: range ? range[1] : mid,
    captureDistance,
    frozen,
  };
}

export interface Arrival {
  /** The CB stops before it reaches the OB. */
  cbStopped: boolean;
  /** CB speed at contact (0 if it stops). */
  cbSpeed: number;
  /** OB speed at the mouth line (0 if it stops short of it). */
  obMouthSpeed: number;
  /** OB speed at the capture line (0 if it stops short of it). */
  obCaptureSpeed: number;
  /** The OB crosses the capture line faster than CAPTURE_MIN_SPEED. */
  obReachesCapture: boolean;
}

type ArrivalGeo = Pick<ShotGeometry, 'cbDistance' | 'cut' | 'window' | 'captureDistance'>;

/** Analytic chain at `power`: CB slides/rolls to the ghost, OB leaves at v·cos(cut)·(1+e)/2 without spin. */
export function arrivalAt(power: number, geo: ArrivalGeo, vert: number, params: PhysicsParams): Arrival {
  const v0 = powerToSpeed(power);
  const cb = straightLineState(v0, 2.5 * v0 * vert, Math.max(0, geo.cbDistance), params);
  if (cb.stopped) return { cbStopped: true, cbSpeed: 0, obMouthSpeed: 0, obCaptureSpeed: 0, obReachesCapture: false };
  const vob = cb.v * Math.cos(geo.cut) * ((1 + params.eBall) / 2);
  if (!(vob > 0)) return { cbStopped: false, cbSpeed: cb.v, obMouthSpeed: 0, obCaptureSpeed: 0, obReachesCapture: false };
  const mouth = straightLineState(vob, 0, geo.window.distance, params);
  const cap = straightLineState(vob, 0, geo.captureDistance, params);
  const obCaptureSpeed = cap.stopped ? 0 : cap.v;
  return {
    cbStopped: false,
    cbSpeed: cb.v,
    obMouthSpeed: mouth.stopped ? 0 : mouth.v,
    obCaptureSpeed,
    obReachesCapture: obCaptureSpeed > CAPTURE_MIN_SPEED,
  };
}

/**
 * Lowest power (analytic chain, 1..10; 10.5 = not even at full power) at which
 * - 'capture' (default): the CB reaches the OB and the OB just crosses the capture line — below it
 *   the ball stops short;
 * - 'pace': the OB reaches the mouth at ≥ pocketArrivalSpeed — a coaching margin for some pace.
 */
export function minimumPower(geo: ArrivalGeo, stroke: Pick<Stroke, 'vert'>, params: PhysicsParams, criterion: 'capture' | 'pace' = 'capture'): number {
  const ok = (power: number): boolean => {
    const a = arrivalAt(power, geo, stroke.vert, params);
    return !a.cbStopped && (criterion === 'capture' ? a.obReachesCapture : a.obMouthSpeed >= params.pocketArrivalSpeed);
  };
  if (!ok(10)) return 10.5; // can't make it even at full power
  if (ok(1)) return 1;
  let lo = 1;
  let hi = 10;
  for (let k = 0; k < 20; k++) {
    const mid = (lo + hi) / 2;
    if (ok(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

/** Default stroke when the player hasn't chosen one and no recommendation is available yet. */
export function defaultStroke(minPower: number): Stroke {
  return { power: Math.min(10, Math.max(2, Math.ceil((minPower + 1) * 2) / 2)), side: 0, vert: 0 };
}

function toInit(balls: Ball[], cueId: string, vel: Vec2, omega: { x: number; y: number; z: number }): SimBallInit[] {
  return balls.map((b) => (b.id === cueId ? { id: b.id, pos: b.pos, vel, omega } : { id: b.id, pos: b.pos }));
}

export interface PlanOptions {
  /** Stroke recommended by the planner worker (used when the request has no player stroke). */
  recommended?: Stroke;
  /** Skip recording trajectories (searches). */
  record?: boolean;
  /** View-relative pocket names for messages (e.g. "far-left corner"). */
  names?: Partial<Record<PocketId, string>>;
}

export function planShot(layout: TableLayout, request: ShotRequest, params: PhysicsParams, opts: PlanOptions = {}): ShotPlan {
  const { table, balls } = layout;
  const R = table.ballRadius;
  const nameOf = (id: PocketId) => opts.names?.[id] ?? POCKET_NAMES[id];
  const cue = balls.find((b) => b.kind === 'cue');
  const target = balls.find((b) => b.id === request.targetId);
  if (!cue) throw new Error('No cue ball on the table');
  if (!target || target.kind === 'cue') throw new Error(`Unknown target ball ${request.targetId}`);

  // --- Pocket selection -------------------------------------------------------------------------
  const geos = table.pockets.map((p) => shotGeometry(table, balls, cue, target, p));
  const usable = (g: ShotGeometry) => g.makeable && g.blockersCue.length === 0 && g.blockersObject.length === 0;
  const ranked = [...geos].sort(
    (a, b) =>
      Number(usable(b)) - Number(usable(a)) ||
      b.toleranceRad - a.toleranceRad ||
      Number(b.window.ok) - Number(a.window.ok) ||
      b.window.halfRad - a.window.halfRad,
  );
  const geo = request.pocketId ? geos.find((g) => g.pocket.id === request.pocketId)! : ranked[0]!;
  const alternatives = ranked
    .filter((g) => g.pocket.id !== geo.pocket.id && usable(g))
    .map((g) => ({ pocketId: g.pocket.id as PocketId, toleranceDeg: deg(g.toleranceRad) }));

  const warnings: Warning[] = [];
  const cutDeg = deg(geo.cut);
  const fr = fractionOf(geo.cut);
  const powerVert = (request.stroke ?? opts.recommended ?? { vert: 0 }).vert;
  let minPower = minimumPower(geo, { vert: powerVert }, params);
  let minPowerSafe = minimumPower(geo, { vert: powerVert }, params, 'pace');
  const strokeSource: ShotPlan['strokeSource'] = request.stroke ? 'player' : opts.recommended ? 'recommended' : 'default';
  let stroke = request.stroke ?? opts.recommended ?? defaultStroke(minPowerSafe);
  let speed = powerToSpeed(stroke.power);

  if (!geo.makeable) {
    const alt = alternatives[0];
    warnings.push({ code: 'not-makeable', message: `Not makeable: ${notMakeableText(geo, cutDeg, nameOf)}.${alt ? ` Try the ${nameOf(alt.pocketId)}.` : ''}` });
  }
  const anyBlocker = geo.blockersCue.length > 0 || geo.blockersObject.length > 0;
  let blockNote = '';
  if (geo.makeable && anyBlocker)
    blockNote = alternatives[0] ? ` Try the ${nameOf(alternatives[0].pocketId)}.` : ' No other pocket is clear for this ball: pick another ball or play a safety.';
  for (const b of geo.blockersCue) {
    warnings.push({ code: 'blocked-cue', message: `Cue-ball path blocked by ${b.label ?? b.id}.${blockNote}`, ballId: b.id });
    blockNote = '';
  }
  for (const b of geo.blockersObject) {
    warnings.push({ code: 'blocked-object', message: `Object-ball path blocked by ${b.label ?? b.id}.${blockNote}`, ballId: b.id });
    blockNote = '';
  }
  if (geo.makeable && cutDeg > THIN_CUT_DEG) warnings.push({ code: 'thin-cut', message: `Very thin cut (${cutDeg.toFixed(0)}°): small aim errors miss.` });
  const frozenAt = warnings.length; // the frozen advice needs the stroke search; it goes here
  if (Math.hypot(stroke.side, stroke.vert) > 0.45) warnings.push({ code: 'miscue-risk', message: 'Tip is near the miscue limit: chalk up and stroke smoothly.' });
  const softAt = warnings.length; // the too-soft advice needs the full simulation; it goes here

  // --- Impact probes (CB + OB only: throw doesn't depend on the other balls) ---------------------
  const probeBalls: Ball[] = [cue, target];
  /** OB departure error (rad) vs `want` with the CB launched along `dir`; NaN unless the CB hits the OB first, directly. */
  const probe = (dir: Vec2, want: Vec2): number => {
    const st = strikeBall(dir, speed, stroke.side, stroke.vert, R, params.squirtMassRatio);
    const sim = simulate(table, toInit(probeBalls, cue.id, st.vel, st.omega), params, { record: false, stopOnFirstHitOf: target.id });
    const hit = sim.firstHits[target.id];
    if (!hit || hit.other !== cue.id) return NaN;
    const cueTr = sim.trajectories.find((t) => t.ballId === cue.id)!;
    for (const e of cueTr.events) {
      if (e.kind === 'ball') break;
      if (e.kind === 'cushion' || e.kind === 'jaw' || e.kind === 'pocket') return NaN;
    }
    return angleBetween(want, fromAngle(angleOf(hit.vel)));
  };

  // --- Throw-compensated aim ----------------------------------------------------------------------
  const desired = angleOf(geo.window.dir);
  let aimAngle = desired;
  let ghost = geo.ghost;
  let aimDir = geo.aimDir;
  let throwRad = 0;
  let strokeOffset = 0; // frozen: stroke angle relative to the line of centres (rad, CCW +)
  let uncompensable = false; // no clean aim cancels the throw inside the window
  if (geo.makeable && !geo.frozen) {
    const r = throwSearch(geo, (a) => probe(norm(sub(ghostBall(target.pos, fromAngle(a), R), cue.pos)), geo.window.dir));
    aimAngle = r.aim;
    throwRad = r.throwRad;
    ghost = ghostBall(target.pos, fromAngle(aimAngle), R);
    aimDir = norm(sub(ghost, cue.pos));
    uncompensable = r.residual !== null && Math.abs(r.residual) > geo.window.halfRad;
  } else if (geo.makeable && geo.frozen) {
    const au = angleOf(geo.aimDir);
    let r = frozenSearch(au, (a) => probe(fromAngle(a), geo.window.dir));
    // The stroke angle sets the OB's share of the CB's speed (cos of the offset), so the minimum
    // power changes, and with it the default stroke: re-search once at that power.
    const minFor = (offset: number, criterion: 'capture' | 'pace') => minimumPower({ ...geo, cut: Math.abs(offset) }, { vert: powerVert }, params, criterion);
    if (strokeSource === 'default') {
      const again = defaultStroke(minFor(r.aim - au, 'pace'));
      if (again.power !== stroke.power) {
        stroke = again;
        speed = powerToSpeed(stroke.power);
        r = frozenSearch(au, (a) => probe(fromAngle(a), geo.window.dir));
      }
    }
    minPower = minFor(r.aim - au, 'capture');
    minPowerSafe = minFor(r.aim - au, 'pace');
    strokeOffset = r.aim - au;
    // Same meaning as for any shot: OB departure − aim line (here the line of centres), signed CCW.
    throwRad = r.residual === null ? 0 : r.throwRad - angleBetween(geo.window.dir, geo.aimDir);
    aimDir = fromAngle(r.aim);
    const offDeg = Math.abs(deg(strokeOffset));
    warnings.splice(frozenAt, 0, {
      code: 'frozen',
      message:
        offDeg >= 0.5
          ? `Frozen: the object ball goes along the line of centres; stroke ${offDeg.toFixed(0)}° to the ${strokeOffset > 0 ? 'left' : 'right'} of it to throw it toward the pocket. Soft centre ball gives the most throw; follow or pace reduces it.`
          : 'Frozen: the object ball goes along the line of centres, which points at the pocket; stroke straight through it.',
    });
  } else if (geo.frozen) {
    warnings.splice(frozenAt, 0, { code: 'frozen', message: 'Frozen: the object ball can only go along the line of centres (plus a little throw).' });
  }
  // The corrected ghost can move into a ball the geometric one cleared.
  const clearance = 2 * R - 5e-4;
  const blockersCue = [...geo.blockersCue];
  if (geo.makeable && !geo.frozen && ghost !== geo.ghost) {
    const extra = pathBlockers(cue.pos, ghost, balls, clearance, [cue.id, target.id]);
    for (const b of balls) if (b.id !== cue.id && b.id !== target.id && dist(b.pos, ghost) < clearance && !extra.includes(b)) extra.push(b);
    for (const b of extra)
      if (!blockersCue.includes(b)) {
        blockersCue.push(b);
        warnings.push({ code: 'blocked-cue', message: `Cue-ball path blocked by ${b.label ?? b.id} once the aim is corrected for throw.`, ballId: b.id });
      }
  }
  const strike = strikeBall(aimDir, speed, stroke.side, stroke.vert, R, params.squirtMassRatio);
  const squirtRad = strike.squirtRad * Math.sign(stroke.side);

  // --- Full simulation ---------------------------------------------------------------------------
  const sim = simulate(table, toInit(balls, cue.id, strike.vel, strike.omega), params, { record: opts.record ?? true });
  const byId = (id: string): Trajectory => sim.trajectories.find((t) => t.ballId === id)!;
  const cuePath = byId(cue.id);
  const objectPath = byId(target.id);
  const otherPaths = sim.trajectories.filter((t) => t.ballId !== cue.id && t.ballId !== target.id && t.events.length > 0);
  const scratch = sim.final[cue.id]!.pocket !== null;
  const obPocket = sim.final[target.id]!.pocket;
  const obPocketed = obPocket === geo.pocket.id;
  const cueFirst = sim.firstHits[cue.id];
  const obHit = sim.firstHits[target.id];
  const blocked = blockersCue.length > 0 || geo.blockersObject.length > 0;

  if (scratch) warnings.push({ code: 'scratch', message: `Scratch: the cue ball goes in the ${nameOf(sim.final[cue.id]!.pocket!)}.` });
  if (geo.makeable && blockersCue.length === 0 && cueFirst && cueFirst.other !== target.id) {
    const b = balls.find((x) => x.id === cueFirst.other);
    warnings.push({ code: 'kiss', message: `Cue ball contacts ${b?.label ?? cueFirst.other} first.`, ballId: cueFirst.other });
  }
  if (geo.makeable && obHit) {
    const kissIdx = objectPath.events.findIndex((e) => e.kind === 'ball' && e.otherId !== cue.id);
    const pocketIdx = objectPath.events.findIndex((e) => e.kind === 'pocket');
    if (kissIdx >= 0 && (pocketIdx < 0 || kissIdx < pocketIdx) && geo.blockersObject.length === 0) {
      const id = objectPath.events[kissIdx]!.otherId!;
      warnings.push({ code: 'kiss', message: `Object ball kisses ${balls.find((x) => x.id === id)?.label ?? id}.`, ballId: id });
    }
  }

  // --- Too soft? (after the simulation, so it never contradicts it) -----------------------------
  const contact = straightLineState(speed, 2.5 * speed * stroke.vert, geo.cbDistance, params);
  const geoP = geo.frozen ? { ...geo, cut: Math.abs(strokeOffset) } : geo;
  const arrival = arrivalAt(stroke.power, geoP, stroke.vert, params);
  // Power to advise: minPowerSafe, because the analytic minPower is optimistic (see ShotPlan.minPower).
  const advise = minPowerSafe > 10 ? 'Use full power.' : `Use power ${minPowerSafe.toFixed(1)}+.`;
  if (geo.makeable) {
    let soft: string | null = null;
    const slow = stroke.power < Math.max(minPower, minPowerSafe) - 1e-6;
    if (!obPocketed) {
      const cbWontReach = contact.stopped && !cuePath.events.some((e) => e.kind === 'ball' && e.otherId === target.id);
      // The simulated OB was hit and rolled to a stop on its line: no rail, jaw or ball on the way.
      let obStoppedShort = false;
      if (obHit && obPocket === null) {
        const k = objectPath.events.findIndex((e) => e.kind === 'ball');
        obStoppedShort = !objectPath.events.some((e, i) => i > k && (e.kind === 'cushion' || e.kind === 'jaw' || e.kind === 'ball'));
      }
      if (minPower > 10) soft = 'Too far: even full power may not reach the pocket.';
      else if (cbWontReach && slow) soft = `Too soft — the cue ball won't reach the object ball. ${advise}`;
      else if (obStoppedShort && slow) soft = `Too soft — object ball stops short. ${advise}`;
    } else if (arrival.obMouthSpeed < params.pocketArrivalSpeed && stroke.power < minPowerSafe - 1e-6 && minPowerSafe <= 10)
      soft = `Very soft — the object ball only just drops; any roll-off will miss. Power ${minPowerSafe.toFixed(1)}+ gives some pace.`;
    if (soft) warnings.splice(softAt + (geo.frozen ? 1 : 0), 0, { code: 'too-soft', message: soft });
  }
  const softWarned = warnings.some((w) => w.code === 'too-soft');
  if (geo.makeable && !obPocketed && !softWarned && geo.blockersObject.length === 0 && blockersCue.length === 0) {
    // The probes found no clean aim that cancels the throw: that, not speed, is why it misses.
    if (uncompensable)
      warnings.push({ code: 'throw-uncompensable', message: 'Throw pushes the ball into the rail at this speed and spin — use more pace or different spin.' });
    else
      warnings.push({
        code: 'ob-missed',
        message: obPocket ? `Simulated object ball drops in the ${nameOf(obPocket)} instead.` : 'Simulated object ball misses — adjust speed or spin.',
      });
  }

  // --- Coaching -----------------------------------------------------------------------------------
  const tolDeg = deg(geo.toleranceRad);
  const throwShiftMm = dist(ghost, geo.ghost) * 1000;
  let throwShiftDir: ThrowShiftDir | undefined;
  if (!geo.frozen && throwShiftMm >= 0.05) {
    if (cutDeg < 2) throwShiftDir = cross(norm(sub(geo.ghost, cue.pos)), sub(ghost, geo.ghost)) > 0 ? 'left' : 'right';
    else throwShiftDir = angleBetween(geo.window.dir, fromAngle(aimAngle)) * cutSide(cue.pos, geo.ghost, geo.window.dir) > 0 ? 'thinner' : 'thicker';
  }
  const lineOfCentres = geo.frozen ? geo.aimDir : fromAngle(aimAngle);
  const plan: ShotPlan = {
    targetId: target.id,
    pocketId: geo.pocket.id,
    makeable: geo.makeable && !blocked,
    ghost,
    ghostUncorrected: geo.ghost,
    aimDir,
    cueAimDir: strike.cueDir,
    contactPoint: contactPoint(target.pos, lineOfCentres, R),
    obDir: geo.window.dir,
    cutAngleDeg: cutDeg,
    cutSide: geo.frozen ? 0 : cutSide(cue.pos, geo.ghost, geo.window.dir),
    fraction: fr.fraction,
    fractionLabel: fr.label,
    throwDeg: deg(throwRad),
    throwShiftMm,
    ...(throwShiftDir ? { throwShiftDir } : {}),
    squirtDeg: deg(squirtRad),
    stroke,
    strokeSource,
    minPower,
    minPowerSafe,
    cuePath,
    objectPath,
    otherPaths,
    cueRest: sim.final[cue.id]!.pocket ? null : sim.final[cue.id]!.pos,
    obPocketed,
    scratch,
    windowHalfDeg: deg(geo.window.halfRad),
    toleranceDeg: tolDeg,
    toleranceMm: geo.toleranceMm,
    difficulty: difficultyOf(tolDeg),
    warnings,
    tip: '',
    cbSpeedAtContact: contact.v,
    obSpeed: obHit ? Math.hypot(obHit.vel.x, obHit.vel.y) : 0,
    alternatives,
  };
  plan.tip = coachingTip({
    cutDeg,
    contact: contactSpinOf(contact.v, contact.w),
    throwDeg: plan.throwDeg,
    throwShiftMm,
    squirtDeg: plan.squirtDeg,
    side: stroke.side,
    scratch,
    blocked,
    makeable: geo.makeable,
    cbReachesOb: !contact.stopped,
    minPower: minPowerSafe, // the power to advise (minPower itself is optimistic)
    cbDistance: geo.cbDistance,
    ...(throwShiftDir ? { shiftDir: throwShiftDir } : {}),
    ...(alternatives[0] ? { altPocketName: nameOf(alternatives[0].pocketId) } : {}),
    frozen: geo.frozen,
  });
  return plan;
}

function notMakeableText(geo: ShotGeometry, cutDeg: number, nameOf: (id: PocketId) => string): string {
  switch (geo.reason) {
    case 'no-window':
      return `the ${nameOf(geo.pocket.id)} isn't reachable from where the ball sits`;
    case 'wrong-side':
      return 'the cue ball is on the wrong side of the object ball for this pocket';
    case 'ghost-off-table':
      return "the cue ball can't get to the contact spot (it would be inside the cushion)";
    case 'frozen-line': {
      const off = Math.abs(angleBetween(geo.aimDir, geo.window.dir));
      return `the balls are frozen together, so the object ball can only go along the line of centres (±${deg(FROZEN_MAX_THROW).toFixed(0)}° of throw), and that line is ${deg(off).toFixed(0)}° off the ${nameOf(geo.pocket.id)}`;
    }
    default:
      return `the cut is too thin (${cutDeg.toFixed(0)}°)`;
  }
}

interface SearchResult {
  /** Chosen angle (rad, absolute). */
  aim: number;
  /**
   * throwSearch: OB departure minus aim at the first valid probe (the geometric aim, or the nearest
   * aim whose ghost is clear of the cushion). frozenSearch: OB departure minus the window direction
   * for a stroke along the line of centres. 0 if no probe was valid.
   */
  throwRad: number;
  /** Error left at the chosen angle; null when no probe was valid. */
  residual: number | null;
}

/**
 * OB aim that cancels throw: err(a) = OB departure − window direction, which grows with the aim
 * angle (slope ≈ 1). Bracketed secant inside [geo.aimLo, geo.aimHi] (ghost on the table), at most
 * THROW_PROBES probes; invalid probes (cushion/jaw before the ball) shrink the range toward the best
 * valid aim. Keeps the aim with the smallest valid |err|; the geometric aim if none is valid.
 */
function throwSearch(geo: ShotGeometry, errAt: (a: number) => number): SearchResult {
  const desired = angleOf(geo.window.dir);
  let lo = geo.aimLo;
  let hi = geo.aimHi;
  let loP = false; // bound set by a probe (sign known / invalid), not the feasibility edge
  let hiP = false;
  let a = Math.min(hi, Math.max(lo, desired));
  let best: { a: number; e: number } | null = null;
  let prev: { a: number; e: number } | null = null;
  let throwRad = 0;
  for (let k = 0; k < THROW_PROBES; k++) {
    const e = errAt(a);
    if (Number.isNaN(e)) {
      if (!best) break; // the geometric aim itself isn't a clean ball-first hit: no correction
      if (a > best.a) {
        hi = a;
        hiP = true;
      } else {
        lo = a;
        loP = true;
      }
      a = (a + best.a) / 2;
      continue;
    }
    if (!best) throwRad = e - (a - desired); // departure − aim at the first clean probe
    if (!best || Math.abs(e) < Math.abs(best.e)) best = { a, e };
    if (Math.abs(e) < 1e-5) break;
    if (e > 0) {
      hi = a;
      hiP = true;
    } else {
      lo = a;
      loP = true;
    }
    let slope = 1;
    if (prev) {
      const s = (e - prev.e) / (a - prev.a);
      if (Number.isFinite(s) && s > 0.2 && s < 5) slope = s;
    }
    prev = { a, e };
    let next = a - e / slope;
    if (next <= lo) next = loP ? (lo + hi) / 2 : lo;
    else if (next >= hi) next = hiP ? (lo + hi) / 2 : hi;
    if (Math.abs(next - a) < 1e-9) break;
    a = next;
  }
  if (!best) return { aim: Math.min(geo.aimHi, Math.max(geo.aimLo, desired)), throwRad: 0, residual: null };
  return { aim: best.a, throwRad, residual: best.e };
}

/**
 * Frozen CB: stroke angle that throws the OB into the window. err(a) = OB departure − window
 * direction; stroking to one side of the line of centres throws the OB toward that side. Secant from
 * the line of centres and ±20° toward the pocket side, within ±60° of it, at most FROZEN_PROBES.
 */
function frozenSearch(au: number, errAt: (a: number) => number): SearchResult {
  const lo = au - FROZEN_MAX_STROKE;
  const hi = au + FROZEN_MAX_STROKE;
  const e0 = errAt(au);
  if (Number.isNaN(e0)) return { aim: au, throwRad: 0, residual: null };
  let best = { a: au, e: e0 };
  if (Math.abs(e0) < 1e-5) return { aim: au, throwRad: e0, residual: e0 };
  let prev = { a: au, e: e0 };
  let a = au + (e0 < 0 ? FROZEN_FIRST_STEP : -FROZEN_FIRST_STEP);
  for (let k = 1; k < FROZEN_PROBES; k++) {
    const e = errAt(a);
    if (Number.isNaN(e)) {
      a = (a + best.a) / 2;
      continue;
    }
    if (Math.abs(e) < Math.abs(best.e)) best = { a, e };
    if (Math.abs(e) < 1e-5) break;
    const s = (e - prev.e) / (a - prev.a);
    const next = Number.isFinite(s) && Math.abs(s) > 1e-6 ? a - e / s : a + (e < 0 ? FROZEN_FIRST_STEP : -FROZEN_FIRST_STEP) / 2;
    prev = { a, e };
    const clamped = Math.min(hi, Math.max(lo, next));
    if (Math.abs(clamped - a) < 1e-9) break;
    a = clamped;
  }
  return { aim: best.a, throwRad: e0, residual: best.e };
}

/**
 * Tip height that makes the cue ball arrive "stunned" (no top/back spin) after `distance` m at
 * initial speed v0: the backspin w0 = −2.5·μs·g·t wears off exactly at impact. Clamped to the
 * miscue limit (long slow stuns are impossible — the ball starts rolling first).
 */
export function stunVert(distance: number, v0: number, params: PhysicsParams): number {
  const a = params.muSlide * params.g;
  const disc = v0 * v0 - 2 * a * distance;
  if (disc <= 0) return -0.5;
  const t = (v0 - Math.sqrt(disc)) / a;
  return Math.max(-0.5, -(a * t) / v0);
}
