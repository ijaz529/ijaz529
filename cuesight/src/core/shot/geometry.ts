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
 * Coaching aim labels, every ⅛ of overlap (cut = asin(1 − fraction): ⅞ 7.2°, ¾ 14.5°, … ⅛ 61.0°).
 * The ⅞, ⅝ and ⅜ steps matter: without them a 38° cut reads "½-ball" (30°), which undercuts it by
 * 8° and misses.
 */
const FRACTIONS: [number, string][] = [
  [0.875, '⅞'],
  [0.75, '¾'],
  [0.625, '⅝'],
  [0.5, '½'],
  [0.375, '⅜'],
  [0.25, '¼'],
  [0.125, '⅛'],
];
/** "full" only from 97 % overlap (cut ≤ 1.7°), the same rule as the fraction glyph. */
export const FULL_FRACTION = 0.97;
/** Below 1/16 overlap (cut > 69.6°) the hit is just "thin": no eighth describes it. */
const THIN_FRACTION = 1 / 16;

/** Cut angle (rad) at which a hit has overlap `fraction` (inverse of fraction = 1 − sin cut). */
export function cutOfFraction(fraction: number): number {
  return Math.asin(Math.max(0, Math.min(1, 1 - fraction)));
}

/**
 * Within this many degrees of an eighth's own cut the label is said plainly; further away both the
 * label ("thin ⅜") and the phrase ("a touch thinner than ⅜-ball") say which way, so a player aiming
 * by the label does not over- or undercut. ASSUMPTION (coaching choice, not measured): a plain label
 * is never more than 1.5° off the real cut; label and phrase share the rule so they never disagree.
 */
export const FRACTION_EXACT_DEG = 1.5;

/**
 * Ball-overlap fraction (1 = full, 0.5 = half-ball at 30°), a coaching label and the same label in
 * words: "full" from 97 % overlap, otherwise the nearest eighth, prefixed "thin " or "thick " when the
 * real cut is more than FRACTION_EXACT_DEG thinner or thicker than that eighth's cut (a 38.7° cut is
 * "⅜", 35.7° is "thick ⅜" / "a touch thicker than ⅜-ball"), and "thin" ("a thin hit") below 1/16.
 */
export function fractionOf(cut: number): { fraction: number; label: string; phrase: string } {
  const fraction = Math.max(0, 1 - Math.sin(Math.min(cut, Math.PI / 2)));
  if (fraction >= FULL_FRACTION) return { fraction, label: 'full', phrase: 'full-ball' };
  if (fraction < THIN_FRACTION) return { fraction, label: 'thin', phrase: 'a thin hit' };
  let best = FRACTIONS[0]!;
  for (const f of FRACTIONS) if (Math.abs(f[0] - fraction) < Math.abs(best[0] - fraction)) best = f;
  const offDeg = ((Math.min(cut, Math.PI / 2) - cutOfFraction(best[0])) * 180) / Math.PI;
  const name = `${best[1]}-ball`;
  if (Math.abs(offDeg) <= FRACTION_EXACT_DEG) return { fraction, label: best[1], phrase: name };
  return {
    fraction,
    label: `${offDeg > 0 ? 'thin' : 'thick'} ${best[1]}`,
    phrase: `a touch ${offDeg > 0 ? 'thinner' : 'thicker'} than ${name}`,
  };
}
