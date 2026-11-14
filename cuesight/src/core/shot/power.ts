/**
 * Power scale ↔ cue-ball speed, and coaching language for speed and spin (research.md R-12).
 */
import { rollingDistance } from '../physics/analytic';
import type { Stroke } from '../types';

/** Cue-ball speed (m/s) for power levels 1..10. */
export const POWER_SPEEDS = [0.6, 0.9, 1.2, 1.6, 2.1, 2.7, 3.4, 4.3, 5.5, 7.0] as const;

export function powerToSpeed(power: number): number {
  const p = Math.max(1, Math.min(10, power));
  const i = Math.min(8, Math.floor(p - 1));
  const f = p - 1 - i;
  return POWER_SPEEDS[i]! + (POWER_SPEEDS[i + 1]! - POWER_SPEEDS[i]!) * f;
}

export function speedToPower(v: number): number {
  if (v <= POWER_SPEEDS[0]) return 1;
  for (let i = 0; i < 9; i++) {
    const a = POWER_SPEEDS[i]!;
    const b = POWER_SPEEDS[i + 1]!;
    if (v <= b) return i + 1 + (v - a) / (b - a);
  }
  return 10;
}

export function speedWord(power: number): string {
  const p = Math.round(power);
  if (p <= 2) return 'soft';
  if (p === 3) return 'medium-soft';
  if (p <= 5) return 'medium';
  if (p === 6) return 'medium-firm';
  if (p === 7) return 'firm';
  if (p === 8) return 'hard';
  return 'power';
}

/** One cue tip ≈ ¼ of the ball radius of offset. */
export const TIP_FRACTION = 0.25;

const TIP_WORDS: [number, string][] = [
  [0.25, '¼'],
  [0.5, '½'],
  [0.75, '¾'],
  [1, '1'],
  [1.25, '1¼'],
  [1.5, '1½'],
  [1.75, '1¾'],
  [2, '2'],
];

/** Tips of offset in words: "¼ tip", "½ tip", "1 tip", "1½ tips" (plural above one). */
export function tipsText(frac: number): string {
  const t = Math.abs(frac) / TIP_FRACTION;
  let best = TIP_WORDS[0]!;
  for (const w of TIP_WORDS) if (Math.abs(w[0] - t) < Math.abs(best[0] - t)) best = w;
  return `${best[1]} ${best[0] > 1 ? 'tips' : 'tip'}`;
}

/**
 * Where to strike the cue ball, in the one vocabulary the whole app uses (card, 3D label, coaching
 * tip, Snap, screen reader): "½ tip below centre", "1½ tips above centre, 1 tip right",
 * "centre ball".
 */
export function describeSpin(s: Pick<Stroke, 'side' | 'vert'>): string {
  const parts: string[] = [];
  if (Math.abs(s.vert) >= 0.04) parts.push(`${tipsText(s.vert)} ${s.vert > 0 ? 'above' : 'below'} centre`);
  if (Math.abs(s.side) >= 0.04) parts.push(`${tipsText(s.side)} ${s.side > 0 ? 'right' : 'left'}`);
  return parts.length ? parts.join(', ') : 'centre ball';
}

/** ASSUMPTION: a diamond is ⅛ of the playing length (standard pool and snooker diamond spacing). */
export const DIAMONDS_PER_LENGTH = 8;

/** Above this many diamonds past pocket speed the reference stops counting (see speedReference). */
export const PACE_CAP_DIAMONDS = 12;

/** How far (diamonds) the object ball would roll past the pocket on an endless cloth, from its mouth speed. */
export function paceDiamonds(obMouthSpeed: number, tableLength: number, params: { muRoll: number; g: number }): number {
  if (!(obMouthSpeed > 0) || !(tableLength > 0)) return 0;
  return rollingDistance(obMouthSpeed, params) / (tableLength / DIAMONDS_PER_LENGTH);
}

/**
 * Speed in a reference players can calibrate to: how far past the pocket the object ball would
 * roll if the pocket were not there, from its speed at the mouth (rolling distance v²/(2μr·g),
 * research.md R-12), in diamonds or a table length. Null when the ball does not drop.
 *
 * The rolling distance ignores the cushions a real ball would hit (each takes ~20–45 % of its speed,
 * params.ts cushion restitution), so beyond about a table length the count stops meaning anything a
 * player can feel ("+ 28 table lengths"): past PACE_CAP_DIAMONDS it says "well past pocket speed".
 */
export function speedReference(obMouthSpeed: number, tableLength: number, params: { muRoll: number; g: number }): string | null {
  if (!(obMouthSpeed > 0) || !(tableLength > 0)) return null;
  const diamonds = paceDiamonds(obMouthSpeed, tableLength, params);
  if (diamonds < 0.5) return 'pocket speed: it just drops';
  if (diamonds < 7.5) {
    const n = Math.round(diamonds);
    return `pocket speed + ${n} diamond${n === 1 ? '' : 's'}`;
  }
  if (diamonds < PACE_CAP_DIAMONDS) return 'pocket speed + a table length';
  return 'well past pocket speed: over a table length';
}
