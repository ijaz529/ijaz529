/**
 * Closed-form billiards results used for explanation, aim compensation hints and as test oracles
 * for the simulator. All angles in radians.
 */
import type { BallFrictionModel, PhysicsParams } from '../types';

/** Ball–ball friction coefficient as a function of relative surface speed [Alciatore TP A.14]. */
export function ballFriction(vRel: number, m: BallFrictionModel): number {
  return m.a + m.b * Math.exp(-m.c * vRel);
}

/**
 * Object-ball throw angle [Alciatore TP A.14].
 *
 * @param cut   cut angle φ (0 = full ball), radians, ≥ 0
 * @param v     cue-ball speed at impact, m/s
 * @param wzR   R·ωz: sidespin surface speed, signed so that a positive value is OUTSIDE english
 *              (reduces cut-induced throw; equal to v·sinφ is "gearing" english → zero throw)
 * @param wxR   R·ωx: top/bottom spin surface speed (magnitude matters; follow/draw reduce throw)
 * @returns throw angle (positive = thrown in the cut-induced direction, i.e. OB goes thicker)
 */
export function throwAngle(cut: number, v: number, wzR: number, wxR: number, params: Pick<PhysicsParams, 'ballFriction'>): number {
  if (v <= 0) return 0;
  const tangential = v * Math.sin(cut) - wzR;
  const vRel = Math.hypot(tangential, wxR * Math.cos(cut));
  if (vRel < 1e-9) return 0;
  const mu = ballFriction(vRel, params.ballFriction);
  const k = Math.min((mu * v * Math.cos(cut)) / vRel, 1 / 7);
  return Math.atan((k * tangential) / (v * Math.cos(cut)));
}

/**
 * Cue-ball squirt (deflection) angle for a level cue [Alciatore TP A.31].
 * @param sideFrac tip offset b/R (sign ignored; squirt is away from the english side)
 * @param massRatio m_ball / m_endmass
 */
export function squirtAngle(sideFrac: number, massRatio: number): number {
  const b = Math.min(Math.abs(sideFrac), 0.99);
  const c = Math.sqrt(1 - b * b);
  return Math.atan((2.5 * b * c) / (1 + massRatio + 2.5 * (1 - b * b)));
}

/** "30° rule": deflection of a naturally rolling cue ball from its original line [Alciatore]. */
export function rollingDeflection(cut: number): number {
  const s = Math.sin(cut);
  return Math.atan((s * Math.cos(cut)) / (s * s + 0.4));
}

/** Distance a rolling ball travels before stopping. */
export function rollingDistance(v: number, params: Pick<PhysicsParams, 'muRoll' | 'g'>): number {
  return (v * v) / (2 * params.muRoll * params.g);
}

/** Speed after a sliding ball (no spin) reaches natural roll: 5/7 of the initial speed. */
export const NATURAL_ROLL_SPEED_RATIO = 5 / 7;

/** Tip height above centre (fraction of R) giving immediate natural roll. */
export const NATURAL_ROLL_OFFSET = 0.4;

/** Practical miscue limit for tip offset (fraction of R). */
export const MISCUE_LIMIT = 0.5;

export interface StraightState {
  /** Speed after travelling the distance (0 if it stopped short). */
  v: number;
  /** Topspin surface speed R·ω (= v when rolling; negative = backspin). */
  w: number;
  /** Elapsed time. */
  t: number;
  stopped: boolean;
}

/**
 * Closed-form state of a ball after travelling `d` metres in a straight line from speed v0 with
 * initial topspin surface speed w0 (top/back spin only). Sliding: slip u = v − w decays at
 * 7/2·μs·g with v changing at ∓μs·g; then rolling decelerates at μr·g.
 */
export function straightLineState(v0: number, w0: number, d: number, p: Pick<PhysicsParams, 'muSlide' | 'muRoll' | 'g'>): StraightState {
  const u0 = v0 - w0;
  const sg = Math.sign(u0);
  const a1 = -sg * p.muSlide * p.g;
  const tr = Math.abs(u0) / (3.5 * p.muSlide * p.g);
  const d1 = v0 * tr + 0.5 * a1 * tr * tr;
  if (d <= d1) {
    // Solve d = v0 t + ½ a1 t² for the first positive root.
    const t = a1 === 0 ? d / v0 : (-v0 + Math.sqrt(Math.max(0, v0 * v0 + 2 * a1 * d))) / a1;
    return { v: v0 + a1 * t, w: w0 - 2.5 * a1 * t, t, stopped: false };
  }
  const v1 = v0 + a1 * tr;
  const rem = d - d1;
  const ar = p.muRoll * p.g;
  const v2sq = v1 * v1 - 2 * ar * rem;
  if (v2sq <= 0) return { v: 0, w: 0, t: tr + v1 / ar, stopped: true };
  const v = Math.sqrt(v2sq);
  return { v, w: v, t: tr + (v1 - v) / ar, stopped: false };
}
