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

/** Top/back spin of the cue ball at impact; 'none' = it never gets there (speed 0). */
export type ContactSpin = 'none' | 'stun' | 'draw' | 'follow' | 'roll' | 'overspin';

/** Classify the cue ball's top/back spin at impact from w/v (w = R·ω, v = speed). */
export function contactSpinOf(v: number, w: number): ContactSpin {
  if (v <= 0) return 'none';
  const r = w / v;
  if (r < -0.08) return 'draw';
  if (r <= 0.08) return 'stun';
  if (r < 0.9) return 'follow';
  if (r <= 1.1) return 'roll';
  return 'overspin';
}

/** Which way the throw correction moved the ghost ball (see planShot). */
export type ThrowShiftDir = 'thinner' | 'thicker' | 'left' | 'right';

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
  /** False when the cue ball stops before it reaches the object ball (default true). */
  cbReachesOb?: boolean;
  /** Power to advise in the "too soft" tip (planShot passes ShotPlan.minPower; > 10: full power won't do). */
  minPower?: number;
  /** Cue ball → ghost distance (m), to give the squirt offset in mm at the ghost ball. */
  cbDistance?: number;
  /** Direction the throw correction moved the ghost (default 'thinner', the usual cut-induced case). */
  shiftDir?: ThrowShiftDir;
  /** Name of the best clear pocket for this ball when the chosen one is blocked. */
  altPocketName?: string;
  /** The cue ball touches the object ball: the object ball leaves along the line of centres. */
  frozen?: boolean;
}

/** Thresholds for mentioning a correction (below them the sentence would be noise). */
const SQUIRT_MENTION_DEG = 0.3;
const THROW_MENTION_DEG = 1;
const THROW_MENTION_MM = 0.1;

/**
 * Up to three short sentences, most important first: what the cue ball does at contact, then the
 * aim corrections (squirt, throw) the player has to make or should know about.
 *
 * The lines the app draws are the cue ball's path (cue ball → ghost ball), so the squirt sentence
 * tells the player to aim the cue off that line; it never claims the correction is in the line.
 */
export function coachingTip(t: TipInput): string {
  if (!t.makeable) return 'No clean path to this pocket. Try another pocket, or play safe.';
  if (t.blocked)
    return t.altPocketName
      ? `Another ball is in the way. Try the ${t.altPocketName} instead, or play a safety.`
      : 'Another ball is in the way. No other pocket is clear for this ball: pick another ball or play a safety.';
  if (t.cbReachesOb === false || t.contact === 'none') {
    const p = t.minPower;
    if (p !== undefined && p > 10) return 'Too far: the cue ball stops before it reaches the object ball, even at full power.';
    return `Too soft: the cue ball stops before it reaches the object ball.${p !== undefined ? ` Use power ${p.toFixed(1)}+; draw needs more pace still.` : ' Hit it harder.'}`;
  }
  const out: string[] = [];
  const straight = t.cutDeg < 3;
  if (t.frozen) out.push('Frozen balls: the object ball leaves along the line of centres, so aim the stroke, not a ghost ball.');
  else if (straight) {
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
  if (t.scratch) {
    out.push('Careful: this stroke sends the cue ball into a pocket. Change speed or spin.');
    return out.join(' ');
  }
  if (Math.abs(t.squirtDeg) >= SQUIRT_MENTION_DEG) {
    const a = Math.abs(t.squirtDeg);
    const mm = t.cbDistance !== undefined && t.cbDistance > 0 ? ` (≈${(t.cbDistance * Math.tan((a * Math.PI) / 180) * 1000).toFixed(1)} mm at the ghost ball)` : '';
    out.push(
      `Side spin squirts the cue ball ${a.toFixed(1)}° off-line: aim the cue ${a.toFixed(1)}° to the ${t.side > 0 ? 'right' : 'left'} of the line shown — the line is where the cue ball travels${mm}.`,
    );
  }
  if (!t.frozen && Math.abs(t.throwDeg) >= THROW_MENTION_DEG && t.throwShiftMm >= THROW_MENTION_MM) {
    const mm = t.throwShiftMm.toFixed(1);
    switch (t.shiftDir ?? 'thinner') {
      case 'thinner':
        out.push(`Throw ≈ ${Math.abs(t.throwDeg).toFixed(1)}° pushes the object ball thick, so the ghost ball is shifted ${mm} mm thinner.`);
        break;
      case 'thicker':
        out.push(
          t.side !== 0
            ? `Outside english throws the object ball thin here, so the ghost ball is shifted ${mm} mm thicker.`
            : `Throw pushes the object ball thin here, so the ghost ball is shifted ${mm} mm thicker.`,
        );
        break;
      default:
        out.push(`Side-spin throw: the ghost ball is shifted ${mm} mm to the ${t.shiftDir}.`);
    }
  }
  return out.slice(0, 3).join(' ');
}
