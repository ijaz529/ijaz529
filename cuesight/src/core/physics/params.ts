import type { PhysicsParams } from '../types';

/**
 * Default physical parameters. Each value is either sourced or flagged as an ASSUMPTION
 * (Constitution Principle I). All are user-tunable via settings (FR-028).
 *
 * Sources:
 *  [A] D. Alciatore, "The Illustrated Principles of Pool and Billiards" + Technical Proofs
 *      (TP A.4 ball–ball, TP A.14 throw, TP A.31 squirt), billiards.colostate.edu
 *  [M] W. Marlow, "The Physics of Pocket Billiards" (ball–ball friction data)
 *  [P] E. Kiefl, pooltool (default cloth/cushion constants)
 */
export const DEFAULT_PHYSICS: PhysicsParams = {
  g: 9.81,
  /** Ball–cloth sliding friction [A][P] ≈ 0.2. */
  muSlide: 0.2,
  /** Rolling resistance [A][P]: 0.005 (fast cloth) … 0.015 (slow cloth). */
  muRoll: 0.01,
  /** ASSUMPTION: sidespin (z) angular deceleration on the cloth, rad/s² (≈ 3 s of spin). */
  spinDecel: 10,
  /** Ball–ball coefficient of restitution for phenolic balls [A] 0.92–0.98. */
  eBall: 0.95,
  /** Ball–ball friction μ(v) = a + b·exp(−c·v) fitted to Marlow's data [A TP A.14][M]. */
  ballFriction: { a: 9.951e-3, b: 0.108, c: 1.088 },
  /** Cushion restitution e_c = max(min, e0 − slope·|vn|). ASSUMPTION fitted to typical 0.75–0.9 range. */
  cushionE0: 0.88,
  cushionESlope: 0.035,
  cushionEMin: 0.55,
  /** ASSUMPTION: ball–cushion contact friction. */
  muCushion: 0.2,
  /** Ball mass / effective cue-tip end mass: ≈23 standard shaft, ≈35 low-deflection [A TP A.31]. */
  squirtMassRatio: 23,
  dt: 0.001,
  maxTime: 12,
  /**
   * ASSUMPTION: object-ball speed at the mouth line regarded as "makes it with pace" (≈0.46 m of
   * extra roll at μr 0.01). A coaching margin (minimum power / "too soft"), not a physical minimum:
   * the planner's hard test is whether the simulated ball crosses the capture line (simulate.ts).
   */
  pocketArrivalSpeed: 0.3,
};

export function withPhysics(overrides: Partial<PhysicsParams> = {}): PhysicsParams {
  return { ...DEFAULT_PHYSICS, ...overrides, ballFriction: { ...DEFAULT_PHYSICS.ballFriction, ...overrides.ballFriction } };
}
