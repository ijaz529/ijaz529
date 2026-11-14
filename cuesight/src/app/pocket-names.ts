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
