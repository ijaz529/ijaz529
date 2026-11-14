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

/**
 * Coaching aim labels, every ⅛ of overlap. The ⅞, ⅝ and ⅜ steps matter: without them a 38° cut reads
 * "½-ball" (30°), which undercuts it by 8° and misses.
 */
const FRACTIONS: [number, string][] = [
  [1, 'full'],
  [0.875, '⅞'],
  [0.75, '¾'],
  [0.625, '⅝'],
  [0.5, '½'],
  [0.375, '⅜'],
  [0.25, '¼'],
  [0.125, '⅛'],
  [0.03, 'thin'],
];

/** Cut angle (rad) at which a hit has overlap `fraction` (inverse of fraction = 1 − sin cut). */
export function cutOfFraction(fraction: number): number {
  return Math.asin(Math.max(0, Math.min(1, 1 - fraction)));
}

/** Within this many degrees of a label's own angle the label is said plainly; further away it is qualified. */
export const FRACTION_EXACT_DEG = 1.5;

/**
 * Ball-overlap fraction (1 = full, 0.5 = half-ball at 30°), the nearest coaching label, and a phrase
 * that says which way the cut differs from that label when it is more than 1.5° away
 * ("a touch thinner than ½-ball"), so a player aiming by the label does not over- or undercut.
 */
export function fractionOf(cut: number): { fraction: number; label: string; phrase: string } {
  const fraction = Math.max(0, 1 - Math.sin(Math.min(cut, Math.PI / 2)));
  let best = FRACTIONS[0]!;
  for (const f of FRACTIONS) if (Math.abs(f[0] - fraction) < Math.abs(best[0] - fraction)) best = f;
  const label = best[1];
  const name = label === 'thin' ? 'a thin hit' : `${label}-ball`;
  const offDeg = ((cut - cutOfFraction(best[0])) * 180) / Math.PI;
  let phrase = name;
  if (label !== 'thin' && Math.abs(offDeg) > FRACTION_EXACT_DEG) phrase = `a touch ${offDeg > 0 ? 'thinner' : 'thicker'} than ${name}`;
  return { fraction, label, phrase };
}
