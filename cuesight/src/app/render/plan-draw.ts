/**
 * Plan geometry shared by every view that draws a ShotPlan — the 2D table and mini-map, the camera
 * overlay, the 3D table and the Snap photo guide — so they all read the core's data the same way:
 *
 * - The drawn ball path is `aimDir` (cue ball → ghost ball). The cue stick points along `cueDir`
 *   (aimDir turned by the squirt correction; `cueAimDir` is the same vector): stickDir().
 * - A frozen cue ball (warning 'frozen') has no ghost ball: the core puts `ghost` on the cue ball
 *   with cut 0 and the label 'full'. The views draw the stroke line along aimDir from the cue ball,
 *   past the object ball, and no ghost ring (aimLine()).
 * - With side spin (|squirt| ≥ 0.1°) the 2D views add a faint, dashed, labelled cue-stick line behind
 *   the cue ball (stickLine()), so the "aim the cue N° off the blue line" tip can be seen.
 */
import type { ShotPlan, Vec2 } from '../../core/types';

/** The stick line is drawn from this squirt angle (the coaching tip mentions squirt from 0.1° too). */
export const STICK_MIN_SQUIRT_DEG = 0.1;
/** Length of the stick line behind the cue ball (m), before clipping to the table. */
export const STICK_LEN = 0.5;
/** The stick line starts this many ball radii behind the cue-ball centre (clear of the ball). */
export const STICK_GAP_R = 1.6;
/** A frozen cue ball's stroke line runs this far past the object ball's far side (m). */
export const FROZEN_AIM_PAST = 0.1;

/** A frozen cue ball (touching the object ball): no ghost ball, the stroke itself is the aim. */
export function isFrozenPlan(plan: Pick<ShotPlan, 'warnings'>): boolean {
  return plan.warnings.some((w) => w.code === 'frozen');
}

/** A plan with a stroke to play (makeable, and the cue ball gets to the object ball). */
export function hasStroke(plan: Pick<ShotPlan, 'makeable' | 'warnings'>): boolean {
  return plan.makeable && !plan.warnings.some((w) => w.code === 'cb-short');
}

const unit = (v: Vec2, fallback: Vec2 = { x: 1, y: 0 }): Vec2 => {
  const l = Math.hypot(v.x, v.y);
  return l > 1e-12 ? { x: v.x / l, y: v.y / l } : fallback;
};

/** Unit direction of the cue stick (ShotPlan.cueDir; cueAimDir is the same vector). */
export function stickDir(plan: Pick<ShotPlan, 'cueDir' | 'aimDir'>): Vec2 {
  const aim = unit(plan.aimDir);
  return plan.cueDir ? unit(plan.cueDir, aim) : aim;
}

/** Half-extents of a rectangle centred on the table centre that a drawn line must stay inside (m). */
export interface DrawBounds {
  hx: number;
  hy: number;
}

/** Distance from p along unit d to the edge of the bounds (Infinity without bounds; 0 if outside). */
function reach(p: Vec2, d: Vec2, b?: DrawBounds): number {
  if (!b) return Infinity;
  let t = Infinity;
  if (d.x > 1e-12) t = Math.min(t, (b.hx - p.x) / d.x);
  if (d.x < -1e-12) t = Math.min(t, (-b.hx - p.x) / d.x);
  if (d.y > 1e-12) t = Math.min(t, (b.hy - p.y) / d.y);
  if (d.y < -1e-12) t = Math.min(t, (-b.hy - p.y) / d.y);
  return Math.max(0, t);
}

/**
 * The aim line every view draws, in table metres: cue ball → ghost ball, with the ghost ball to ring;
 * for a frozen cue ball the stroke along aimDir from the cue ball to FROZEN_AIM_PAST beyond the far
 * side of the object ball (clipped to `bounds`), and no ghost ball.
 */
export function aimLine(plan: Pick<ShotPlan, 'aimDir' | 'ghost' | 'warnings'>, cue: Vec2, R: number, bounds?: DrawBounds): { from: Vec2; to: Vec2; ghost: Vec2 | null } {
  if (!isFrozenPlan(plan)) return { from: cue, to: plan.ghost, ghost: plan.ghost };
  const d = unit(plan.aimDir);
  const L = Math.min(3 * R + FROZEN_AIM_PAST, reach(cue, d, bounds));
  return { from: cue, to: { x: cue.x + d.x * L, y: cue.y + d.y * L }, ghost: null };
}

/**
 * The faint cue-stick line behind the cue ball along stickDir (table metres), or null when the
 * squirt is under STICK_MIN_SQUIRT_DEG, the shot has no stroke, or there is no room for it.
 */
export function stickLine(plan: Pick<ShotPlan, 'squirtDeg' | 'cueDir' | 'aimDir' | 'makeable' | 'warnings'>, cue: Vec2, R: number, bounds?: DrawBounds): { from: Vec2; to: Vec2 } | null {
  if (!(Math.abs(plan.squirtDeg) >= STICK_MIN_SQUIRT_DEG) || !hasStroke(plan)) return null;
  const s = stickDir(plan);
  const back = { x: -s.x, y: -s.y };
  const gap = STICK_GAP_R * R;
  const L = Math.min(gap + STICK_LEN, reach(cue, back, bounds));
  if (L - gap < 2 * R) return null;
  return { from: { x: cue.x + back.x * gap, y: cue.y + back.y * gap }, to: { x: cue.x + back.x * L, y: cue.y + back.y * L } };
}

/**
 * A frozen stroke relative to the line of centres, as the core's 'frozen' warning words it: degrees
 * (rounded) and the side, or 'straight' under half a degree. The line of centres runs from the cue
 * ball through the contact point (the core puts it on the object ball, R along that line).
 */
export function frozenStroke(plan: Pick<ShotPlan, 'aimDir' | 'contactPoint'>, cue: Vec2): { deg: number; side: 'left' | 'right' | 'straight' } {
  const lc = unit({ x: plan.contactPoint.x - cue.x, y: plan.contactPoint.y - cue.y }, plan.aimDir);
  const a = unit(plan.aimDir);
  const off = (Math.atan2(lc.x * a.y - lc.y * a.x, lc.x * a.x + lc.y * a.y) * 180) / Math.PI;
  if (Math.abs(off) < 0.5) return { deg: 0, side: 'straight' };
  return { deg: Math.round(Math.abs(off)), side: off > 0 ? 'left' : 'right' };
}

/** Short label next to the ghost ball (2D table, overlay): "30° · ½-ball hit", "36° · ⅜+ ball", "Frozen · stroke 12° left". */
export function planLabel(plan: Pick<ShotPlan, 'makeable' | 'cutAngleDeg' | 'fractionLabel' | 'fractionPhrase' | 'warnings' | 'aimDir' | 'contactPoint'>, cue: Vec2): string {
  if (!plan.makeable) return 'Not makeable';
  if (isFrozenPlan(plan)) {
    const f = frozenStroke(plan, cue);
    return f.side === 'straight' ? 'Frozen · straight through' : `Frozen · stroke ${f.deg}° ${f.side}`;
  }
  return `${plan.cutAngleDeg.toFixed(0)}° · ${fractionTile(plan)}`;
}

/** Short hero line for the fractional aim: "½-ball hit", or "thicker than ⅜-ball" when qualified. */
export function fractionShort(plan: Pick<ShotPlan, 'fractionLabel' | 'fractionPhrase'>): string {
  const phrase = plan.fractionPhrase ?? `${plan.fractionLabel}-ball`;
  // A non-breaking hyphen keeps "⅜-ball" together in the narrow hero column.
  if (phrase.startsWith('a touch ')) return phrase.slice('a touch '.length).replace('-ball', '\u2011ball');
  return phrase === 'a thin hit' ? 'thin hit' : `${phrase} hit`;
}

/**
 * The fractional aim in a hero tile or a table label (one short line): "½-ball hit" on the label,
 * "⅜+ ball" when a touch thicker, "⅝− ball" when a touch thinner, "thin hit". The full phrase is in
 * the card's title/details.
 */
export function fractionTile(plan: Pick<ShotPlan, 'fractionLabel' | 'fractionPhrase'>): string {
  const phrase = plan.fractionPhrase ?? `${plan.fractionLabel}-ball`;
  const m = /^a touch (thicker|thinner) than (.+)-ball$/.exec(phrase);
  if (m) return `${m[2]}${m[1] === 'thicker' ? '+' : '\u2212'} ball`;
  return phrase === 'a thin hit' ? 'thin hit' : `${phrase} hit`;
}
