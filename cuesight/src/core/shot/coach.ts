/**
 * Difficulty labels (research.md R-10) and coaching tips in player language (Principle VI).
 */
import type { Difficulty } from '../types';

export const DIFFICULTY_THRESHOLDS = { easy: 0.2, medium: 0.08, hard: 0.04 } as const;

export function difficultyOf(toleranceDeg: number): Difficulty {
  if (toleranceDeg >= DIFFICULTY_THRESHOLDS.easy) return 'easy';
  if (toleranceDeg >= DIFFICULTY_THRESHOLDS.medium) return 'medium';
  if (toleranceDeg >= DIFFICULTY_THRESHOLDS.hard) return 'hard';
  return 'very hard';
}

export type ContactSpin = 'stun' | 'draw' | 'follow' | 'roll' | 'overspin';

/** Classify the cue ball's top/back spin at impact from w/v (w = R·ω, v = speed). */
export function contactSpinOf(v: number, w: number): ContactSpin {
  if (v <= 0) return 'stun';
  const r = w / v;
  if (r < -0.08) return 'draw';
  if (r <= 0.08) return 'stun';
  if (r < 0.9) return 'follow';
  if (r <= 1.1) return 'roll';
  return 'overspin';
}

export interface TipInput {
  cutDeg: number;
  contact: ContactSpin;
  throwDeg: number;
  throwShiftMm: number;
  squirtDeg: number;
  side: number;
  scratch: boolean;
  blocked: boolean;
  makeable: boolean;
}

/** One or two sentences, most important first. */
export function coachingTip(t: TipInput): string {
  if (!t.makeable) return 'No clean path to this pocket. Try another pocket, or play safe.';
  if (t.blocked) return 'Another ball is in the way. Pick a different pocket or ball, or play a safety.';
  const out: string[] = [];
  const straight = t.cutDeg < 3;
  if (straight) {
    if (t.contact === 'stun') out.push('Straight-in stun: hit it full and the cue ball stops dead — a stop shot.');
    else if (t.contact === 'draw') out.push('Straight-in draw: the backspin pulls the cue ball straight back toward you.');
    else out.push('Straight-in with follow: the cue ball rolls through along the same line.');
  } else {
    switch (t.contact) {
      case 'stun':
        out.push('Stun shot: the cue ball leaves along the tangent line, 90° to the object ball\'s path (the 90° rule).');
        break;
      case 'roll':
      case 'overspin':
        out.push(
          t.cutDeg >= 14 && t.cutDeg <= 49
            ? 'Rolling cue ball: it bends about 30° away from its original line (the 30° rule).'
            : 'Rolling cue ball: it curves forward off the tangent line toward its original direction.',
        );
        break;
      case 'follow':
        out.push('Follow: the cue ball leaves on the tangent line, then bends forward as the topspin takes.');
        break;
      case 'draw':
        out.push('Draw: the cue ball leaves on the tangent line, then bends back behind it as the backspin grips.');
        break;
    }
  }
  if (t.scratch) out.push('Careful: this stroke sends the cue ball into a pocket. Change speed or spin.');
  else if (Math.abs(t.squirtDeg) >= 0.3)
    out.push(
      `Side spin squirts the cue ball ${Math.abs(t.squirtDeg).toFixed(1)}° off-line: aim the cue that much to the ${t.side > 0 ? 'right' : 'left'} (already in the line shown).`,
    );
  else if (Math.abs(t.throwDeg) >= 1)
    out.push(`Throw ≈ ${Math.abs(t.throwDeg).toFixed(1)}° pushes the object ball thick, so the ghost ball is shifted ${t.throwShiftMm.toFixed(1)} mm thinner.`);
  return out.slice(0, 2).join(' ');
}
