/**
 * Ray picking (pure). Priority: a ball the ray actually hits (nearest first) → a ball within the
 * touch slop (closest to the ray; at least 22 CSS px from its centre) → a pocket → the cloth → nothing.
 * A ball reached only through the 22 px floor (beyond its natural slop) yields to a pocket mouth that
 * is nearer the tap on screen, the same rule as the 2D table view and the camera overlay.
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
  /** Minimum ball pick radius in CSS px (default 22: a 44 px touch target however small the ball is drawn). */
  ballMinPx?: number;
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
  // 2. Touch slop: closest approach within k·R + slop px, and never less than ballMinPx (measured at
  // the ball's distance); the nearest ball wins where two slops overlap.
  const slopPx = inp.ballSlopPx ?? 12;
  const minPx = inp.ballMinPx ?? 22;
  const k = inp.ballSlop ?? 1.8;
  let bestD = Infinity;
  /** The chosen ball's distance from the ray in CSS px, and whether it is inside its natural slop. */
  let bestPx = Infinity;
  let natural = false;
  for (const b of inp.balls) {
    const { t, d } = rayPointDistance(ray, [b.x, b.y, b.z]);
    const nat = b.r * k + slopPx * inp.pxAtUnit * t;
    const lim = Math.max(nat, minPx * inp.pxAtUnit * t);
    if (d < lim && d < bestD) {
      bestD = d;
      best = b;
      bestPx = d / Math.max(1e-12, inp.pxAtUnit * t);
      natural = d < nat;
    }
  }
  if (best && natural) return { kind: 'ball', id: best.id };
  // 3. Pockets and cloth via the bed plane.
  const tb = rayPlaneZ(ray, 0);
  if (tb === null) return best ? { kind: 'ball', id: best.id } : null;
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
  if (best) {
    // Only the 22 px floor reaches this ball: a pocket mouth nearer the tap on screen wins.
    if (pk) {
      const q = rayPointDistance(ray, [pk.x, pk.y, 0]);
      if (q.d / Math.max(1e-12, inp.pxAtUnit * q.t) < bestPx) return { kind: 'pocket', id: pk.id };
    }
    return { kind: 'ball', id: best.id };
  }
  if (pk) return { kind: 'pocket', id: pk.id };
  if (Math.abs(hit[0]) <= inp.bedHalf.x && Math.abs(hit[1]) <= inp.bedHalf.y) return { kind: 'cloth', pos: { x: hit[0], y: hit[1] } };
  return null;
}
