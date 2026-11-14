/**
 * Ray picking (pure). Priority: a ball the ray actually hits (nearest first) → a ball within the
 * touch slop (closest to the ray) → a pocket → the cloth → nothing.
 */
import type { PocketId, Vec2 } from '../../core/types';
import { rayAt, rayPlaneZ, rayPointDistance, raySphere, type Ray } from './math3d';

export type Pick3D = { kind: 'ball'; id: string } | { kind: 'pocket'; id: PocketId } | { kind: 'cloth'; pos: Vec2 } | null;

export interface PickBall {
  id: string;
  x: number;
  y: number;
  z: number;
  r: number;
}

export interface PickPocket {
  id: PocketId;
  /** Point on the bed the pocket is picked around (its mouth / drop). */
  x: number;
  y: number;
  /** Pick radius in metres (before the pixel slop). */
  r: number;
}

export interface PickInput {
  ray: Ray;
  balls: PickBall[];
  pockets: PickPocket[];
  /** Half extents of the playing surface (cushion noses). */
  bedHalf: { x: number; y: number };
  /** World size of one CSS pixel at unit distance (2·tan(fov/2) / viewport height). */
  pxAtUnit: number;
  /** Extra touch slop around balls in CSS px (default 12, like the 2D table view). */
  ballSlopPx?: number;
  /** Minimum pocket pick radius in CSS px (default 22). */
  pocketSlopPx?: number;
  /** Ball pick radius multiplier (default 1.8 × R, like the 2D table view). */
  ballSlop?: number;
}

export function pickRay(inp: PickInput): Pick3D {
  const { ray } = inp;
  // 1. Exact hits, nearest along the ray.
  let best: PickBall | null = null;
  let bestT = Infinity;
  for (const b of inp.balls) {
    const t = raySphere(ray, [b.x, b.y, b.z], b.r);
    if (t !== null && t < bestT) {
      bestT = t;
      best = b;
    }
  }
  if (best) return { kind: 'ball', id: best.id };
  // 2. Touch slop: closest approach within k·R + slop px (measured at the ball's distance).
  const slopPx = inp.ballSlopPx ?? 12;
  const k = inp.ballSlop ?? 1.8;
  let bestD = Infinity;
  for (const b of inp.balls) {
    const { t, d } = rayPointDistance(ray, [b.x, b.y, b.z]);
    const lim = b.r * k + slopPx * inp.pxAtUnit * t;
    if (d < lim && d < bestD) {
      bestD = d;
      best = b;
    }
  }
  if (best) return { kind: 'ball', id: best.id };
  // 3. Pockets and cloth via the bed plane.
  const tb = rayPlaneZ(ray, 0);
  if (tb === null) return null;
  const hit = rayAt(ray, tb);
  const pSlop = inp.pocketSlopPx ?? 22;
  let pk: PickPocket | null = null;
  let pd = Infinity;
  for (const p of inp.pockets) {
    const d = Math.hypot(hit[0] - p.x, hit[1] - p.y);
    const lim = Math.max(p.r, pSlop * inp.pxAtUnit * tb);
    if (d < lim && d < pd) {
      pd = d;
      pk = p;
    }
  }
  if (pk) return { kind: 'pocket', id: pk.id };
  if (Math.abs(hit[0]) <= inp.bedHalf.x && Math.abs(hit[1]) <= inp.bedHalf.y) return { kind: 'cloth', pos: { x: hit[0], y: hit[1] } };
  return null;
}
