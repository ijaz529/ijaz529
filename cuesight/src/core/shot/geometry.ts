/**
 * Aiming geometry: ghost ball, cut angle, fractional aim, contact point.
 */
import { cross, dot, norm, sub, type Vec2 } from '../vec';

/** Ghost-ball centre: where the cue ball must be at impact to send the OB along `obDir`. */
export function ghostBall(ob: Vec2, obDir: Vec2, R: number): Vec2 {
  return { x: ob.x - 2 * R * obDir.x, y: ob.y - 2 * R * obDir.y };
}

/** Point on the object ball's surface touched at impact. */
export function contactPoint(ob: Vec2, obDir: Vec2, R: number): Vec2 {
  return { x: ob.x - R * obDir.x, y: ob.y - R * obDir.y };
}

/** Cut angle (radians, 0..π) between the cue-ball travel line and the object-ball line. */
export function cutAngle(cue: Vec2, ghost: Vec2, obDir: Vec2): number {
  const a = norm(sub(ghost, cue));
  return Math.acos(Math.max(-1, Math.min(1, dot(a, obDir))));
}

/** +1 when the OB departs counter-clockwise (to the left) of the cue-ball line, −1 clockwise. */
export function cutSide(cue: Vec2, ghost: Vec2, obDir: Vec2): 1 | -1 | 0 {
  const c = cross(norm(sub(ghost, cue)), obDir);
  return Math.abs(c) < 1e-9 ? 0 : c > 0 ? 1 : -1;
}

const FRACTIONS: [number, string][] = [
  [1, 'full'],
  [0.75, '¾'],
  [0.5, '½'],
  [0.25, '¼'],
  [0.125, '⅛'],
  [0.03, 'thin'],
];

/** Ball-overlap fraction (1 = full, 0.5 = half-ball at 30°) and the nearest coaching label. */
export function fractionOf(cut: number): { fraction: number; label: string } {
  const fraction = Math.max(0, 1 - Math.sin(Math.min(cut, Math.PI / 2)));
  let best = FRACTIONS[0]!;
  for (const f of FRACTIONS) if (Math.abs(f[0] - fraction) < Math.abs(best[0] - fraction)) best = f;
  return { fraction, label: best[1] };
}
