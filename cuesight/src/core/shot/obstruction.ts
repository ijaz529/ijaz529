/**
 * Swept-circle path checks: which balls lie within `clearance` of the moving centre's path.
 */
import type { Ball, Vec2 } from '../types';

export function pathBlockers(from: Vec2, to: Vec2, balls: Ball[], clearance: number, ignore: string[]): Ball[] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const L = Math.hypot(dx, dy);
  if (L < 1e-9) return [];
  const ux = dx / L;
  const uy = dy / L;
  const hits: { b: Ball; s: number }[] = [];
  for (const b of balls) {
    if (ignore.includes(b.id)) continue;
    const px = b.pos.x - from.x;
    const py = b.pos.y - from.y;
    const s = px * ux + py * uy;
    if (s <= 0) continue; // behind the start: moving away from it
    const d = s >= L ? Math.hypot(b.pos.x - to.x, b.pos.y - to.y) : Math.abs(px * uy - py * ux);
    if (d < clearance) hits.push({ b, s });
  }
  return hits.sort((a, c) => a.s - c.s).map((h) => h.b);
}
