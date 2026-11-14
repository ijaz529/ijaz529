/**
 * Angular acceptance window of a pocket seen from a ball centre (research.md R-09).
 * The ball centre's path must clear each jaw point by R: the window spans the directions to the two
 * jaws, each rotated inward by asin(R/d). Empty ⇒ the pocket can't be reached directly.
 */
import type { PocketSpec, Vec2 } from '../types';
import { angleBetween, fromAngle, angleOf, sub, len } from '../vec';

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

export function pocketWindow(from: Vec2, pocket: PocketSpec, R: number): PocketWindow {
  const dA = sub(pocket.jawA, from);
  const dB = sub(pocket.jawB, from);
  const la = len(dA);
  const lb = len(dB);
  const span = angleBetween(dA, dB); // signed, A → B
  const sgn = span >= 0 ? 1 : -1;
  const cA = Math.asin(Math.min(1, R / Math.max(la, 1e-9)));
  const cB = Math.asin(Math.min(1, R / Math.max(lb, 1e-9)));
  const width = Math.abs(span) - cA - cB;
  const mid = angleOf(dA) + sgn * (cA + width / 2);
  const dir = fromAngle(mid);
  // Intersect the bisector ray with the mouth line A–B.
  const ex = pocket.jawB.x - pocket.jawA.x;
  const ey = pocket.jawB.y - pocket.jawA.y;
  const den = dir.x * ey - dir.y * ex;
  let t = 0;
  if (Math.abs(den) > 1e-12) t = (dA.x * ey - dA.y * ex) / den;
  const mouthHit = { x: from.x + dir.x * t, y: from.y + dir.y * t };
  return { ok: width > 0 && t > 0, dir, halfRad: Math.max(0, width / 2), mouthHit, distance: Math.max(0, t) };
}
