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

/** Reference overlaps in eighths of a ball (cut = asin(1 − fraction): ⅞ 7.2°, ¾ 14.5°, … ⅛ 61.0°). */
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
const FULL_FRACTION = 0.97;
/** Below 1/16 overlap (cut > 69.6°) the hit is just "thin": no eighth describes it. */
const THIN_FRACTION = 1 / 16;
/** A label more than this far (deg of cut) from its reference says "thick"/"thin" so it never misleads. */
const LABEL_SLACK_DEG = 2;

/**
 * Ball-overlap fraction (1 = full, 0.5 = half-ball at 30°) and a coaching label: the nearest eighth,
 * prefixed "thin " or "thick " when the real cut is more than 2° thinner or thicker than that
 * eighth's cut (e.g. a 40° cut is "⅜", 44° is "thin ⅜"; the ¼-ball cut is 48.6°).
 */
export function fractionOf(cut: number): { fraction: number; label: string } {
  const fraction = Math.max(0, 1 - Math.sin(Math.min(cut, Math.PI / 2)));
  if (fraction >= FULL_FRACTION) return { fraction, label: 'full' };
  if (fraction < THIN_FRACTION) return { fraction, label: 'thin' };
  let best = FRACTIONS[0]!;
  for (const f of FRACTIONS) if (Math.abs(f[0] - fraction) < Math.abs(best[0] - fraction)) best = f;
  const refCutDeg = (Math.asin(1 - best[0]) * 180) / Math.PI;
  const cutDeg = (Math.min(cut, Math.PI / 2) * 180) / Math.PI;
  const off = cutDeg - refCutDeg;
  const label = Math.abs(off) > LABEL_SLACK_DEG ? `${off > 0 ? 'thin' : 'thick'} ${best[1]}` : best[1];
  return { fraction, label };
}
