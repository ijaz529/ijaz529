/**
 * Angular acceptance window of a pocket seen from a ball centre (research.md R-09).
 * The ball centre's path must clear each jaw point by R: the window spans the directions to the two
 * jaws, each rotated inward by asin(R/d). Empty ⇒ the pocket can't be reached directly.
 *
 * The window is the arc between the jaw directions that faces the pocket. For a ball in front of
 * the mouth line that is the short arc; for a corner hanger whose centre is on or past the mouth
 * line (up to the clamp corner, R from both rails) the jaws lie behind or beside it and the arc
 * through the pocket is the long one. Such a ball is already at the mouth: distance 0, mouthHit at
 * the ball.
 */
import type { PocketSpec, Vec2 } from '../types';
import { angleBetween, cross, fromAngle, angleOf, sub, len } from '../vec';

export interface PocketWindow {
  ok: boolean;
  /** Aim direction for the object ball (window bisector). */
  dir: Vec2;
  /** Half-width of the window (rad). */
  halfRad: number;
  /** Where the bisector crosses the mouth line. */
  mouthHit: Vec2;
  /** Distance from the ball to mouthHit. */
  distance: number;
}

/**
 * Where the ray from `from` along unit `dir` crosses the pocket's mouth line (jawA–jawB), and how
 * far along the ray that is (t ≤ 0: the line is behind the ball or parallel to the ray).
 */
export function mouthIntersect(from: Vec2, dir: Vec2, pocket: PocketSpec): { mouthHit: Vec2; t: number } {
  const dAx = pocket.jawA.x - from.x;
  const dAy = pocket.jawA.y - from.y;
  const ex = pocket.jawB.x - pocket.jawA.x;
  const ey = pocket.jawB.y - pocket.jawA.y;
  const den = dir.x * ey - dir.y * ex;
  let t = 0;
  if (Math.abs(den) > 1e-12) t = (dAx * ey - dAy * ex) / den;
  return { mouthHit: { x: from.x + dir.x * t, y: from.y + dir.y * t }, t };
}

export function pocketWindow(from: Vec2, pocket: PocketSpec, R: number): PocketWindow {
  const dA = sub(pocket.jawA, from);
  const dB = sub(pocket.jawB, from);
  const la = len(dA);
  const lb = len(dB);
  let span = angleBetween(dA, dB); // signed, A → B, the short way round
  // Use the arc that faces the pocket: for a ball past the mouth line the short arc points into the table.
  const midShort = angleOf(dA) + span / 2;
  if (Math.cos(midShort) * -pocket.inward.x + Math.sin(midShort) * -pocket.inward.y < 0) span -= Math.sign(span || 1) * 2 * Math.PI;
  const sgn = span >= 0 ? 1 : -1;
  const cA = Math.asin(Math.min(1, R / Math.max(la, 1e-9)));
  const cB = Math.asin(Math.min(1, R / Math.max(lb, 1e-9)));
  const width = Math.abs(span) - cA - cB;
  const mid = angleOf(dA) + sgn * (cA + width / 2);
  const dir = fromAngle(mid);
  const halfRad = Math.max(0, width / 2);
  // Which side of the mouth line is the ball on? (> 0: in front of it, on the table side.)
  const e = sub(pocket.jawB, pocket.jawA);
  const side = cross(e, sub(from, pocket.jawA)) * Math.sign(cross(e, pocket.inward));
  if (side <= 0) return { ok: width > 0, dir, halfRad, mouthHit: { x: from.x, y: from.y }, distance: 0 };
  const { mouthHit, t } = mouthIntersect(from, dir, pocket);
  return { ok: width > 0 && t > 0, dir, halfRad, mouthHit, distance: Math.max(0, t) };
}
