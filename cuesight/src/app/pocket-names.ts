/**
 * Pocket names for a table seen through a camera (Live, and Snap's table photo), in the player's
 * words: "far left corner", "near side"... (Principle VI).
 *
 * Names come from where each pocket appears in the image, ranked rather than compared with the
 * table's centre: the two corners highest in the image are "far", the other two "near", and each
 * pair splits into left and right. The two side pockets are left/right when they sit side by side in
 * the image, far/near when one is above the other. Ranking keeps every name unique in any
 * perspective. Comparing each pocket with the centre does not: from a corner of the table two corners
 * can both land "far right", and a plan would read "black → far right corner … Try the far right
 * corner."
 */
import type { PocketId, Vec2 } from '../core/types';

export interface NamedPocket {
  id: PocketId;
  kind: 'corner' | 'side';
}

export function perspectivePocketNames(pockets: readonly NamedPocket[], onScreen: (id: PocketId) => Vec2): Partial<Record<PocketId, string>> {
  const out: Partial<Record<PocketId, string>> = {};
  const at = (kind: NamedPocket['kind']) => pockets.filter((p) => p.kind === kind).map((p) => ({ id: p.id, q: onScreen(p.id) }));
  const corners = at('corner');
  if (corners.length === 4) {
    const byY = [...corners].sort((a, b) => a.q.y - b.q.y || a.q.x - b.q.x);
    for (const [pair, v] of [
      [byY.slice(0, 2), 'far'],
      [byY.slice(2), 'near'],
    ] as const) {
      const [l, r] = [...pair].sort((a, b) => a.q.x - b.q.x);
      out[l!.id] = `${v} left corner`;
      out[r!.id] = `${v} right corner`;
    }
  }
  const sides = at('side');
  if (sides.length === 2) {
    const [a, b] = sides as [(typeof sides)[number], (typeof sides)[number]];
    const dx = b.q.x - a.q.x;
    const dy = b.q.y - a.q.y;
    if (Math.abs(dx) >= Math.abs(dy)) {
      const [l, r] = dx >= 0 ? [a, b] : [b, a];
      out[l.id] = 'left side';
      out[r.id] = 'right side';
    } else {
      const [f, n] = dy >= 0 ? [a, b] : [b, a];
      out[f.id] = 'far side';
      out[n.id] = 'near side';
    }
  }
  return out;
}

/** Bearing (deg) under which a corner reads "straight ahead" (or "behind you"). */
export const AHEAD_DEG = 10;
/** Corners between these bearings (deg) are beside the player: "corner on your right". */
export const BESIDE_DEG: readonly [number, number] = [62, 110];

/**
 * Pocket names from where the player stands: at `from` (the cue ball, or the camera), facing
 * `facing` (toward the target ball, or the camera's view direction), on the table plane. Each pocket
 * is named by its bearing, not by a rank, because pockets can be beside and behind the player (the
 * rank rule above assumes every pocket is in front, as in a photo, and in the straight-in drill named
 * the pocket dead ahead "far left corner").
 *
 * - Corners: "corner straight ahead" (within AHEAD_DEG), "corner behind you", "corner on your
 *   right/left" (BESIDE_DEG), else far/near (ahead/behind) and left/right: "far right corner".
 * - Sides: "left side"/"right side" when the pocket is more to the side than ahead or behind, else
 *   "far side"/"near side".
 *
 * Names are adjusted only when two would collide, and the result is always unique.
 */
export function shooterPocketNames(pockets: readonly (NamedPocket & { mouthCenter: Vec2 })[], from: Vec2, facing: Vec2): Partial<Record<PocketId, string>> {
  const L = Math.hypot(facing.x, facing.y);
  const f = L > 1e-9 ? { x: facing.x / L, y: facing.y / L } : { x: 1, y: 0 };
  // Player's right when facing f with z up: f × ẑ.
  const r = { x: f.y, y: -f.x };
  const rel = pockets.map((p) => {
    const dx = p.mouthCenter.x - from.x;
    const dy = p.mouthCenter.y - from.y;
    const ahead = dx * f.x + dy * f.y;
    const right = dx * r.x + dy * r.y;
    return { p, ahead, right, bearing: (Math.atan2(right, ahead) * 180) / Math.PI };
  });
  type Rel = (typeof rel)[number];
  const out: Partial<Record<PocketId, string>> = {};
  const sideOf = (q: Rel) => (q.right >= 0 ? 'right' : 'left');
  const quadrant = (q: Rel) => `${q.ahead >= 0 ? 'far' : 'near'} ${sideOf(q)} corner`;
  const corners = rel.filter((q) => q.p.kind === 'corner');
  for (const q of corners) {
    const b = Math.abs(q.bearing);
    out[q.p.id] =
      b <= AHEAD_DEG ? 'corner straight ahead' : b >= 180 - AHEAD_DEG ? 'corner behind you' : b >= BESIDE_DEG[0] && b <= BESIDE_DEG[1] ? `corner on your ${sideOf(q)}` : quadrant(q);
  }
  const groups = () => {
    const by = new Map<string, Rel[]>();
    for (const q of corners) by.set(out[q.p.id]!, [...(by.get(out[q.p.id]!) ?? []), q]);
    return [...by.values()].filter((g) => g.length > 1);
  };
  for (const g of groups()) {
    if (g.length === 2 && sideOf(g[0]!) === sideOf(g[1]!)) {
      // Same side: tell them apart by how far ahead each one is.
      const [a, b] = [...g].sort((x, y) => Math.abs(x.bearing) - Math.abs(y.bearing)) as [Rel, Rel];
      const s = sideOf(a);
      const [na, nb] =
        Math.abs(b.bearing) < 90 ? [`far ${s} corner`, `corner on your ${s}`] : Math.abs(a.bearing) >= 90 ? [`corner on your ${s}`, `near ${s} corner`] : [`far ${s} corner`, `near ${s} corner`];
      out[a.p.id] = na;
      out[b.p.id] = nb;
    } else for (const q of g) out[q.p.id] = quadrant(q);
  }
  // Still a clash (rare): the rank rule, which is always unique.
  if (groups().length && corners.length === 4) {
    const byRank = perspectivePocketNames(
      corners.map((q) => q.p),
      (id) => {
        const q = corners.find((c) => c.p.id === id)!;
        return { x: q.right, y: -q.ahead };
      },
    );
    for (const q of corners) out[q.p.id] = byRank[q.p.id]!;
  }
  const sides = rel.filter((q) => q.p.kind === 'side');
  const sideName = (q: Rel) => (Math.abs(q.right) > Math.abs(q.ahead) ? `${sideOf(q)} side` : `${q.ahead >= 0 ? 'far' : 'near'} side`);
  for (const q of sides) out[q.p.id] = sideName(q);
  if (sides.length === 2 && out[sides[0]!.p.id] === out[sides[1]!.p.id]) {
    const [a, b] = sides as [Rel, Rel];
    if (Math.sign(a.right) !== Math.sign(b.right)) for (const q of [a, b]) out[q.p.id] = `${sideOf(q)} side`;
    else {
      const [far, near] = a.ahead >= b.ahead ? [a, b] : [b, a];
      out[far.p.id] = 'far side';
      out[near.p.id] = 'near side';
    }
  }
  return out;
}
