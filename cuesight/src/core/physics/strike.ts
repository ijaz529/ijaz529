/**
 * Cue strike model: tip contact point + cue-ball speed → initial linear/angular velocity.
 *
 * For an impulse J = m·v delivered along the cue direction ĉ at lateral offset (side·R) and vertical
 * offset (vert·R) from the ball centre, the angular velocity is
 *   ω = (5/2)·(v/R)·[ vert·(ẑ × ĉ) + side·ẑ ]        (I = 2/5·m·R²)
 * so vert = 0.4 gives natural roll immediately [Alciatore]. A level cue is assumed (no swerve/massé).
 * Side english makes the cue ball squirt away from the english side; we return the cue direction
 * that compensates so the ball travels along `travelDir`.
 */
import type { Vec2, Vec3 } from '../vec';
import { rotate } from '../vec';
import { MISCUE_LIMIT, squirtAngle } from './analytic';

export interface StrikeResult {
  vel: Vec2;
  omega: Vec3;
  /** Squirt angle (rad, ≥0) — magnitude of cue-direction compensation. */
  squirtRad: number;
  /** Direction the cue must be aimed for the ball to travel along travelDir. */
  cueDir: Vec2;
  side: number;
  vert: number;
}

/** Clamp a tip offset radially to the miscue limit. */
export function clampTip(side: number, vert: number, limit = MISCUE_LIMIT): { side: number; vert: number } {
  const r = Math.hypot(side, vert);
  if (r <= limit) return { side, vert };
  const k = limit / r;
  return { side: side * k, vert: vert * k };
}

export function strikeBall(
  travelDir: Vec2,
  speed: number,
  sideIn: number,
  vertIn: number,
  ballRadius: number,
  squirtMassRatio: number,
): StrikeResult {
  const { side, vert } = clampTip(sideIn, vertIn);
  const k = (2.5 * speed) / ballRadius;
  const c = travelDir;
  const omega: Vec3 = { x: k * vert * -c.y, y: k * vert * c.x, z: k * side };
  const squirtRad = side === 0 ? 0 : squirtAngle(side, squirtMassRatio);
  // Right english (side>0) squirts the ball left of the cue line → aim the cue to the right
  // (clockwise) by the squirt angle.
  const cueDir = rotate(c, -Math.sign(side) * squirtRad);
  return { vel: { x: c.x * speed, y: c.y * speed }, omega, squirtRad, cueDir, side, vert };
}
