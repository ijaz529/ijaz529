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
  /** Radius (px) of what the point stands for, e.g. a ball's disc: covered when the disc reaches the label (+ pad). */
  r?: number;
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
 * Slides tried around each side's spot with `slide` (px, along one axis at a time): a label that
 * would cover the edge of a ball (or a few line points) usually clears it a few pixels along. Each
 * pixel slid costs SLIDE_COST, so a slide wins only when it covers less; among equals the side's own
 * spot wins. (The 3D table's label uses it; the Snap photo's labels keep to their spots.)
 */
const SLIDES = [-8, 8, -16, 16, -24, 24];
const SLIDE_COST = 0.25;
const NO_SHIFT: readonly [number, number][] = [[0, 0]];
const SHIFTS: readonly [number, number][] = [[0, 0], ...SLIDES.flatMap((d): [number, number][] => [[d, 0], [0, d]])];

/**
 * Best placement: fewest covered avoid points (within `pad` px of the label, plus the point's own
 * radius: a ball counts as covered when its disc reaches the label, not only its centre), then least
 * overflow of the free box, then the order of `prefer`; with `slide`, each side's spot may slide a
 * little (SLIDES) to clear what it would cover. The result is clamped into the free box.
 */
export function placeLabel(
  anchor: Pt & { r: number },
  size: { w: number; h: number },
  avoid: readonly Pt[],
  free: Box,
  opts: { gap?: number; pad?: number; prefer?: readonly LabelSide[]; slide?: boolean } = {},
): Placement {
  const gap = opts.gap ?? 14;
  const pad = opts.pad ?? 6;
  const order = opts.prefer ?? SIDES;
  let best: Placement | null = null;
  let bestScore = Infinity;
  order.forEach((side, rank) => {
    const p0 = candidate(side, anchor, anchor.r, size.w, size.h, gap);
    for (const [sx, sy] of opts.slide ? SHIFTS : NO_SHIFT) {
      const p = { x: p0.x + sx, y: p0.y + sy };
      const over =
        Math.max(0, free.left - p.x) + Math.max(0, p.x + size.w - free.right) + Math.max(0, free.top - p.y) + Math.max(0, p.y + size.h - free.bottom);
      // Clamp, then count what the clamped label would cover.
      const x = Math.max(free.left, Math.min(free.right - size.w, p.x));
      const y = Math.max(free.top, Math.min(free.bottom - size.h, p.y));
      let covered = 0;
      for (const q of avoid) {
        const m = pad + (q.r ?? 0);
        if (q.x >= x - m && q.x <= x + size.w + m && q.y >= y - m && q.y <= y + size.h + m) covered += q.w ?? 1;
      }
      // The clamped label must not sit on the anchor itself.
      const onAnchor = anchor.x + anchor.r > x && anchor.x - anchor.r < x + size.w && anchor.y + anchor.r > y && anchor.y - anchor.r < y + size.h;
      const score = covered * 40 + over * 2 + rank * 3 + (onAnchor ? 400 : 0) + (Math.abs(sx) + Math.abs(sy)) * SLIDE_COST;
      if (score < bestScore) {
        bestScore = score;
        const lead = { x: Math.max(x, Math.min(x + size.w, anchor.x)), y: Math.max(y, Math.min(y + size.h, anchor.y)) };
        best = { x, y, side, lead, covered };
      }
    }
  });
  return best!;
}
