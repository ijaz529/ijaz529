/**
 * Label placement (pure): put a label next to an anchor (a ball on screen) where it covers the
 * fewest plan lines and balls and stays inside the free part of the screen. Used by the in-scene
 * power/strike label on the 3D table and by the labels drawn on the Snap photo.
 */

export interface Pt {
  x: number;
  y: number;
  /** Weight of an avoid point (default 1): e.g. 3 for the cue stick, which a label must not hide. */
  w?: number;
}

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export type LabelSide = 'right' | 'left' | 'above-right' | 'above-left' | 'below-right' | 'below-left' | 'above' | 'below';

export interface Placement {
  /** Top-left corner of the label. */
  x: number;
  y: number;
  side: LabelSide;
  /** Point on the label's edge nearest the anchor (start of a leader line). */
  lead: Pt;
  /** Avoid points the label covers (0 = clear). */
  covered: number;
}

const SIDES: LabelSide[] = ['right', 'left', 'above-right', 'above-left', 'below-right', 'below-left', 'above', 'below'];

/** Top-left corner for a label of size w × h on `side` of a circle (c, r) with a gap. */
export function candidate(side: LabelSide, c: Pt, r: number, w: number, h: number, gap: number): Pt {
  const d = r + gap;
  const k = 0.72; // diagonal offset factor (≈ cos 44°)
  switch (side) {
    case 'right':
      return { x: c.x + d, y: c.y - h / 2 };
    case 'left':
      return { x: c.x - d - w, y: c.y - h / 2 };
    case 'above-right':
      return { x: c.x + d * k, y: c.y - d * k - h };
    case 'above-left':
      return { x: c.x - d * k - w, y: c.y - d * k - h };
    case 'below-right':
      return { x: c.x + d * k, y: c.y + d * k };
    case 'below-left':
      return { x: c.x - d * k - w, y: c.y + d * k };
    case 'above':
      return { x: c.x - w / 2, y: c.y - d - h };
    case 'below':
      return { x: c.x - w / 2, y: c.y + d };
  }
}

/**
 * Best placement: fewest covered avoid points (within `pad` px of the label), then least overflow
 * of the free box, then the order of `prefer`. The result is clamped into the free box.
 */
export function placeLabel(
  anchor: Pt & { r: number },
  size: { w: number; h: number },
  avoid: readonly Pt[],
  free: Box,
  opts: { gap?: number; pad?: number; prefer?: readonly LabelSide[] } = {},
): Placement {
  const gap = opts.gap ?? 14;
  const pad = opts.pad ?? 6;
  const order = opts.prefer ?? SIDES;
  let best: Placement | null = null;
  let bestScore = Infinity;
  order.forEach((side, rank) => {
    const p = candidate(side, anchor, anchor.r, size.w, size.h, gap);
    const over =
      Math.max(0, free.left - p.x) + Math.max(0, p.x + size.w - free.right) + Math.max(0, free.top - p.y) + Math.max(0, p.y + size.h - free.bottom);
    // Clamp, then count what the clamped label would cover.
    const x = Math.max(free.left, Math.min(free.right - size.w, p.x));
    const y = Math.max(free.top, Math.min(free.bottom - size.h, p.y));
    let covered = 0;
    for (const q of avoid) if (q.x >= x - pad && q.x <= x + size.w + pad && q.y >= y - pad && q.y <= y + size.h + pad) covered += q.w ?? 1;
    // The clamped label must not sit on the anchor itself.
    const onAnchor = anchor.x + anchor.r > x && anchor.x - anchor.r < x + size.w && anchor.y + anchor.r > y && anchor.y - anchor.r < y + size.h;
    const score = covered * 40 + over * 2 + rank * 3 + (onAnchor ? 400 : 0);
    if (score < bestScore) {
      bestScore = score;
      const lead = { x: Math.max(x, Math.min(x + size.w, anchor.x)), y: Math.max(y, Math.min(y + size.h, anchor.y)) };
      best = { x, y, side, lead, covered };
    }
  });
  return best!;
}
