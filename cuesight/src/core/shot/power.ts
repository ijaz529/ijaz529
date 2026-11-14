/**
 * Power scale ↔ cue-ball speed, and coaching language for speed and spin (research.md R-12).
 */
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

function tips(frac: number): string {
  const t = Math.abs(frac) / TIP_FRACTION;
  let best = TIP_WORDS[0]!;
  for (const w of TIP_WORDS) if (Math.abs(w[0] - t) < Math.abs(best[0] - t)) best = w;
  return `${best[1]} tip`;
}

/** "½ tip low, ¼ tip right" / "centre ball". */
export function describeSpin(s: Pick<Stroke, 'side' | 'vert'>): string {
  const parts: string[] = [];
  if (Math.abs(s.vert) >= 0.04) parts.push(`${tips(s.vert)} ${s.vert > 0 ? 'high' : 'low'}`);
  if (Math.abs(s.side) >= 0.04) parts.push(`${tips(s.side)} ${s.side > 0 ? 'right' : 'left'}`);
  return parts.length ? parts.join(', ') : 'centre ball';
}
