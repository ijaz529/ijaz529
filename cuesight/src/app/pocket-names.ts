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
 * Names are adjusted only when two would collide, and the result is always unique. A name never
 * puts a pocket on the wrong side ("left" is always on the player's left), and "far" is never used for
 * a corner behind the player: each side of the player is a ladder (far → on your side → near), and the
 * corners on that side take distinct rungs in the order they come round from ahead to behind.
 */
export function shooterPocketNames(pockets: readonly (NamedPocket & { mouthCenter: Vec2 })[], from: Vec2, facing: Vec2): Partial<Record<PocketId, string>> {
  const L = Math.hypot(facing.x, facing.y);
  const f = L > 1e-9 && Number.isFinite(L) ? { x: facing.x / L, y: facing.y / L } : { x: 1, y: 0 };
  // Player's right when facing f with z up: f × ẑ.
  const r = { x: f.y, y: -f.x };
  const rel = pockets.map((p) => {
    const dx = p.mouthCenter.x - from.x;
    const dy = p.mouthCenter.y - from.y;
    const ahead = dx * f.x + dy * f.y;
    const right = dx * r.x + dy * r.y;
    return { p, ahead, right, bearing: Math.abs((Math.atan2(right, ahead) * 180) / Math.PI) };
  });
  type Rel = (typeof rel)[number];
  const out: Partial<Record<PocketId, string>> = {};
  const sideOf = (q: Rel) => (q.right >= 0 ? 'right' : 'left');
  const corners = rel.filter((q) => q.p.kind === 'corner');
  if (!corners.length || corners.some((q) => !Number.isFinite(q.bearing))) {
    // Not a usable position (a degenerate pose): the rank rule, which is unique for any input.
    const pts = new Map(rel.map((q) => [q.p.id, Number.isFinite(q.bearing) ? { x: q.right, y: -q.ahead } : { x: 0, y: 0 }]));
    return perspectivePocketNames(pockets, (id) => pts.get(id)!);
  }
  // Straight ahead and behind you: one corner each at most (the one closest to that bearing).
  const byBearing = [...corners].sort((a, b) => a.bearing - b.bearing);
  const ahead = byBearing[0]!.bearing <= AHEAD_DEG ? byBearing[0]! : null;
  const last = byBearing[byBearing.length - 1]!;
  const behind = last !== ahead && last.bearing >= 180 - AHEAD_DEG ? last : null;
  if (ahead) out[ahead.p.id] = 'corner straight ahead';
  if (behind) out[behind.p.id] = 'corner behind you';
  // Each side: rungs far (0), beside (1), near (2). A corner's own rung comes from its bearing; corners
  // sharing a rung move to the nearest free ones, keeping their order from ahead to behind, and "far"
  // is never given to a corner behind the player nor "near" to one ahead of them unless nothing else is left.
  const rung = (b: number) => (b < BESIDE_DEG[0] ? 0 : b <= BESIDE_DEG[1] ? 1 : 2);
  const cost = (slot: number, b: number) => Math.abs(slot - rung(b)) + (slot === 0 && b >= 90 ? 3 : 0) + (slot === 2 && b < 90 ? 3 : 0);
  for (const side of ['left', 'right'] as const) {
    const list = byBearing.filter((q) => q !== ahead && q !== behind && sideOf(q) === side);
    if (list.length > 3) return shooterRankFallback(pockets, rel, out);
    let best: number[] = [];
    let bestCost = Infinity;
    const choose = (k: number, from0: number, acc: number[], c: number) => {
      if (c >= bestCost) return;
      if (k === list.length) {
        best = acc.slice();
        bestCost = c;
        return;
      }
      for (let s = from0; s <= 3 - (list.length - k); s++) choose(k + 1, s + 1, [...acc, s], c + cost(s, list[k]!.bearing));
    };
    choose(0, 0, [], 0);
    list.forEach((q, i) => (out[q.p.id] = best[i] === 0 ? `far ${side} corner` : best[i] === 1 ? `corner on your ${side}` : `near ${side} corner`));
  }
  const sides = rel.filter((q) => q.p.kind === 'side');
  const sideName = (q: Rel) => (Math.abs(q.right) > Math.abs(q.ahead) ? `${sideOf(q)} side` : `${q.ahead >= 0 ? 'far' : 'near'} side`);
  for (const q of sides) out[q.p.id] = sideName(q);
  if (sides.length === 2 && out[sides[0]!.p.id] === out[sides[1]!.p.id]) {
    const [a, b] = sides as [Rel, Rel];
    if (sideOf(a) !== sideOf(b)) for (const q of [a, b]) out[q.p.id] = `${sideOf(q)} side`;
    else {
      const [far, near] = a.ahead >= b.ahead ? [a, b] : [b, a];
      out[far.p.id] = 'far side';
      out[near.p.id] = 'near side';
    }
  }
  return out;
}

/**
 * More than three corners on one side of the player (only possible from outside the table, e.g. a
 * camera well off to one side): there is no truthful left/right split, so the corners are ranked as
 * a picture would be (depth, then left to right), which is unique.
 */
function shooterRankFallback(
  pockets: readonly NamedPocket[],
  rel: { p: NamedPocket; ahead: number; right: number }[],
  out: Partial<Record<PocketId, string>>,
): Partial<Record<PocketId, string>> {
  const pts = new Map(rel.map((q) => [q.p.id, { x: q.right, y: -q.ahead }]));
  return { ...out, ...perspectivePocketNames(pockets, (id) => pts.get(id)!) };
}
