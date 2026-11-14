/**
 * planShot(): the full, physics-grounded ShotPlan for a target ball + pocket (FR-009…FR-017).
 *
 * 1. Geometry: pocket window → OB aim direction → ghost ball → cut angle, fraction, tolerance.
 * 2. Obstructions on the CB → ghost and OB → mouth paths.
 * 3. Stroke: player override, recommended (from the planner worker) or a default.
 * 4. Throw compensation: probe-simulate the impact, measure the OB's actual departure angle and
 *    re-aim (secant-free fixed-point iteration converges in 2–3 steps because throw varies slowly).
 * 5. Full simulation on the real layout → paths, rest positions, scratch/kiss/miss warnings.
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
import { angleBetween, deg, dist, fromAngle, angleOf, norm, sub } from '../vec';
import { coachingTip, contactSpinOf, difficultyOf } from './coach';
import { cutAngle, cutSide, fractionOf, ghostBall, contactPoint } from './geometry';
import { pathBlockers } from './obstruction';
import { pocketWindow, type PocketWindow } from './pocket-window';
import { powerToSpeed } from './power';

export const MAX_CUT_DEG = 88;
export const THIN_CUT_DEG = 80;

export interface ShotGeometry {
  pocket: PocketSpec;
  window: PocketWindow;
  ghost: Vec2;
  aimDir: Vec2;
  cut: number;
  cbDistance: number;
  toleranceRad: number;
  ghostOnTable: boolean;
  blockersCue: Ball[];
  blockersObject: Ball[];
  makeable: boolean;
}

/** Pure geometry for one target/pocket pair (no simulation) — also used by suggestions. */
export function shotGeometry(table: TableSpec, balls: Ball[], cue: Ball, target: Ball, pocket: PocketSpec): ShotGeometry {
  const R = table.ballRadius;
  const window = pocketWindow(target.pos, pocket, R);
  const ghost = ghostBall(target.pos, window.dir, R);
  const cut = cutAngle(cue.pos, ghost, window.dir);
  const cbDistance = dist(cue.pos, ghost);
  const toleranceRad = window.ok ? (window.halfRad * 2 * R * Math.cos(cut)) / Math.max(cbDistance, 2 * R) : 0;
  const lim = { x: table.length / 2 - R + 1e-3, y: table.width / 2 - R + 1e-3 };
  const ghostOnTable = Math.abs(ghost.x) <= lim.x && Math.abs(ghost.y) <= lim.y;
  const clearance = 2 * R - 5e-4;
  const blockersCue = pathBlockers(cue.pos, ghost, balls, clearance, [cue.id, target.id]);
  // Balls overlapping the ghost-ball spot also block.
  for (const b of balls) {
    if (b.id === cue.id || b.id === target.id || blockersCue.includes(b)) continue;
    if (dist(b.pos, ghost) < clearance) blockersCue.push(b);
  }
  const blockersObject = pathBlockers(target.pos, window.mouthHit, balls, clearance, [cue.id, target.id]);
  const makeable = window.ok && ghostOnTable && deg(cut) < MAX_CUT_DEG;
  return {
    pocket,
    window,
    ghost,
    aimDir: norm(sub(ghost, cue.pos)),
    cut,
    cbDistance,
    toleranceRad,
    ghostOnTable,
    blockersCue,
    blockersObject,
    makeable,
  };
}

/** Lowest power whose OB still reaches the mouth at `pocketArrivalSpeed` (analytic chain). */
export function minimumPower(geo: ShotGeometry, stroke: Pick<Stroke, 'vert'>, params: PhysicsParams): number {
  const arrives = (power: number): boolean => {
    const v0 = powerToSpeed(power);
    const cb = straightLineState(v0, 2.5 * v0 * stroke.vert, Math.max(0, geo.cbDistance), params);
    if (cb.stopped) return false;
    const vob = cb.v * Math.cos(geo.cut) * ((1 + params.eBall) / 2);
    const ob = straightLineState(vob, 0, geo.window.distance, params);
    return !ob.stopped && ob.v >= params.pocketArrivalSpeed;
  };
  if (!arrives(10)) return 10.5; // can't make it even at full power
  if (arrives(1)) return 1;
  let lo = 1;
  let hi = 10;
  for (let k = 0; k < 20; k++) {
    const mid = (lo + hi) / 2;
    if (arrives(mid)) hi = mid;
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
  const ranked = [...geos].sort((a, b) => Number(usable(b)) - Number(usable(a)) || b.toleranceRad - a.toleranceRad);
  const geo = request.pocketId ? geos.find((g) => g.pocket.id === request.pocketId)! : ranked[0]!;
  const alternatives = ranked
    .filter((g) => g.pocket.id !== geo.pocket.id && usable(g))
    .map((g) => ({ pocketId: g.pocket.id as PocketId, toleranceDeg: deg(g.toleranceRad) }));

  const warnings: Warning[] = [];
  const cutDeg = deg(geo.cut);
  const fr = fractionOf(geo.cut);
  const minPower = minimumPower(geo, request.stroke ?? opts.recommended ?? { vert: 0 }, params);
  const strokeSource: ShotPlan['strokeSource'] = request.stroke ? 'player' : opts.recommended ? 'recommended' : 'default';
  const stroke = request.stroke ?? opts.recommended ?? defaultStroke(minPower);
  const speed = powerToSpeed(stroke.power);

  if (!geo.makeable) {
    const why = !geo.window.ok
      ? `the ${nameOf(geo.pocket.id)} isn't reachable from where the ball sits`
      : !geo.ghostOnTable
        ? 'the cue ball can\'t get to the contact spot (it would be inside the cushion)'
        : `the cut is too thin (${cutDeg.toFixed(0)}°)`;
    const alt = alternatives[0];
    warnings.push({
      code: 'not-makeable',
      message: `Not makeable: ${why}.${alt ? ` Try the ${nameOf(alt.pocketId)}.` : ''}`,
    });
  }
  for (const b of geo.blockersCue) warnings.push({ code: 'blocked-cue', message: `Cue-ball path blocked by ${b.label ?? b.id}.`, ballId: b.id });
  for (const b of geo.blockersObject)
    warnings.push({ code: 'blocked-object', message: `Object-ball path blocked by ${b.label ?? b.id}.`, ballId: b.id });
  if (geo.makeable && cutDeg > THIN_CUT_DEG) warnings.push({ code: 'thin-cut', message: `Very thin cut (${cutDeg.toFixed(0)}°): small aim errors miss.` });
  if (dist(cue.pos, target.pos) < 2 * R + 1e-3)
    warnings.push({ code: 'frozen', message: 'Cue ball is frozen to the object ball: expect extra throw; hit it softly with follow.' });
  if (Math.hypot(stroke.side, stroke.vert) > 0.45) warnings.push({ code: 'miscue-risk', message: 'Tip is near the miscue limit: chalk up and stroke smoothly.' });
  if (stroke.power < minPower - 1e-6)
    warnings.push({
      code: 'too-soft',
      message: minPower > 10 ? 'Too far: even full power may not reach the pocket.' : `Too soft — object ball stops short. Use power ${minPower.toFixed(1)}+.`,
    });

  // --- Throw-compensated aim ----------------------------------------------------------------------
  const desired = angleOf(geo.window.dir);
  let aimAngle = desired;
  let ghost = geo.ghost;
  let throwRad = 0;
  let squirtRad = 0;
  const probeBalls: Ball[] = [cue, target]; // isolated impact probe (throw doesn't depend on others)
  if (geo.makeable) {
    for (let k = 0; k < 3; k++) {
      ghost = ghostBall(target.pos, fromAngle(aimAngle), R);
      const dir = norm(sub(ghost, cue.pos));
      const st = strikeBall(dir, speed, stroke.side, stroke.vert, R, params.squirtMassRatio);
      const probe = simulate(table, toInit(probeBalls, cue.id, st.vel, st.omega), params, {
        record: false,
        stopOnFirstHitOf: target.id,
      });
      const hit = probe.firstHits[target.id];
      if (!hit || hit.other !== cue.id) break;
      const actual = angleOf(hit.vel);
      const err = angleBetween(fromAngle(desired), fromAngle(actual));
      if (k === 0) throwRad = err;
      if (Math.abs(err) < 1e-5) break;
      aimAngle -= err;
    }
    ghost = ghostBall(target.pos, fromAngle(aimAngle), R);
  }
  const aimDir = norm(sub(ghost, cue.pos));
  const strike = strikeBall(aimDir, speed, stroke.side, stroke.vert, R, params.squirtMassRatio);
  squirtRad = strike.squirtRad * Math.sign(stroke.side);

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

  if (scratch) warnings.push({ code: 'scratch', message: `Scratch: the cue ball goes in the ${nameOf(sim.final[cue.id]!.pocket!)}.` });
  if (geo.makeable && geo.blockersCue.length === 0 && cueFirst && cueFirst.other !== target.id) {
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
  const softWarned = warnings.some((w) => w.code === 'too-soft');
  if (geo.makeable && !obPocketed && !softWarned && geo.blockersObject.length === 0 && geo.blockersCue.length === 0) {
    warnings.push({
      code: 'ob-missed',
      message: obPocket ? `Simulated object ball drops in the ${nameOf(obPocket)} instead.` : 'Simulated object ball misses — adjust speed or spin.',
    });
  }

  // --- Contact state for coaching ----------------------------------------------------------------
  const contact = straightLineState(speed, 2.5 * speed * stroke.vert, geo.cbDistance, params);
  const tolDeg = deg(geo.toleranceRad);
  const throwShiftMm = dist(ghost, geo.ghost) * 1000;
  const blocked = geo.blockersCue.length > 0 || geo.blockersObject.length > 0;
  const plan: ShotPlan = {
    targetId: target.id,
    pocketId: geo.pocket.id,
    makeable: geo.makeable && !blocked,
    ghost,
    ghostUncorrected: geo.ghost,
    aimDir,
    contactPoint: contactPoint(target.pos, fromAngle(aimAngle), R),
    obDir: geo.window.dir,
    cutAngleDeg: cutDeg,
    cutSide: cutSide(cue.pos, geo.ghost, geo.window.dir),
    fraction: fr.fraction,
    fractionLabel: fr.label,
    throwDeg: deg(throwRad),
    throwShiftMm,
    squirtDeg: deg(squirtRad),
    stroke,
    strokeSource,
    minPower,
    cuePath,
    objectPath,
    otherPaths,
    cueRest: sim.final[cue.id]!.pocket ? null : sim.final[cue.id]!.pos,
    obPocketed,
    scratch,
    windowHalfDeg: deg(geo.window.halfRad),
    toleranceDeg: tolDeg,
    toleranceMm: geo.window.halfRad * 2 * R * Math.cos(geo.cut) * 1000,
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
  });
  return plan;
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
