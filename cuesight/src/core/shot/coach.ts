/**
 * Difficulty labels (research.md R-10) and coaching tips in player language (Principle VI).
 */
import type { Difficulty } from '../types';
import { describeSpin } from './power';

export const DIFFICULTY_THRESHOLDS = { easy: 0.2, medium: 0.08, hard: 0.04 } as const;

export function difficultyOf(toleranceDeg: number): Difficulty {
  if (toleranceDeg >= DIFFICULTY_THRESHOLDS.easy) return 'easy';
  if (toleranceDeg >= DIFFICULTY_THRESHOLDS.medium) return 'medium';
  if (toleranceDeg >= DIFFICULTY_THRESHOLDS.hard) return 'hard';
  return 'very hard';
}

/** Top/back spin of the cue ball at impact; 'short' = it never gets there (stops on the way). */
export type ContactSpin = 'stun' | 'draw' | 'follow' | 'roll' | 'overspin' | 'short';

/** Classify the cue ball's top/back spin at impact from w/v (w = R·ω, v = speed). */
export function contactSpinOf(v: number, w: number): ContactSpin {
  // A cue ball that stops on the way has no spin at impact because there is no impact: never "stun".
  if (!(v > 0)) return 'short';
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
  /** Direction of the throw compensation as the player aims it (see ShotPlan.throwAim). */
  throwAim?: 'thinner' | 'thicker' | 'left' | 'right' | null;
  squirtDeg: number;
  side: number;
  /** Tip height of the stroke (fraction of R): a low hit that arrives with follow is explained. */
  vert?: number;
  scratch: boolean;
  blocked: boolean;
  makeable: boolean;
  /** Cue ball → ghost-ball distance (m): turns the squirt angle into an aim offset at the ghost ball. */
  cbDistance?: number;
  /** Ball radius (m), for the offset in balls. */
  ballRadius?: number;
  /** Target ball's name ("1", "yellow") for sentences about it. */
  targetLabel?: string;
  /** Power the stroke needs so the shot can happen at all (when the cue ball stops short). */
  needPower?: number;
  /** The cue ball meets a cushion within a few ms of the object ball (a "rail and ball together" shot). */
  railFirst?: boolean;
}

/** "the 1" / "the yellow" / "the object ball". */
function theBall(label?: string): string {
  return label ? `the ${label}` : 'the object ball';
}

/**
 * Squirt compensation as something a player can execute: where the cue points at the ghost ball's
 * distance (tan(squirt) × distance), in mm and in balls, e.g. "about 17 mm (⅓ of a ball) right of the
 * ghost ball". Null when it is too small to aim (< 2 mm).
 */
export function squirtOffsetText(squirtDeg: number, side: number, cbDistance: number, R: number): string | null {
  const mm = Math.tan((Math.abs(squirtDeg) * Math.PI) / 180) * cbDistance * 1000;
  if (!(mm >= 2)) return null;
  const balls = mm / (2 * R * 1000);
  const amount = balls < 0.19 ? `about ${mm.toFixed(0)} mm` : `about ${balls < 0.29 ? '¼ of a ball' : balls < 0.42 ? '⅓ of a ball' : balls < 0.62 ? '½ a ball' : balls < 0.87 ? '¾ of a ball' : 'a ball or more'} (${mm.toFixed(0)} mm)`;
  return `${amount} ${side > 0 ? 'right' : 'left'} of the ghost ball`;
}

/**
 * The stroke's name as coaches say it, from the cue ball's spin at impact (and the tip height):
 * stop shot, stun, stun-run-through, drag, draw, follow, plus the english side. Null when the cue
 * ball never reaches the object ball.
 */
export function strokeName(p: { contact: ContactSpin; contactRatio: number; cutDeg: number; vert: number; side: number }): string | null {
  if (p.contact === 'short') return null;
  const straight = p.cutDeg < 3;
  let base: string;
  if (p.contact === 'draw') base = 'Draw';
  else if (p.contact === 'stun') base = straight ? 'Stop shot' : 'Stun';
  else if (p.vert <= -0.04) base = 'Drag'; // struck low, the backspin wears off: arrives rolling forward
  else if (p.contact === 'follow' && p.contactRatio < 0.5) base = 'Stun-run-through';
  else base = 'Follow';
  if (Math.abs(p.side) >= 0.04) base += `, ${p.side > 0 ? 'right' : 'left'} english`;
  return base;
}

/** One or two sentences, most important first. */
export function coachingTip(t: TipInput): string {
  if (!t.makeable) return 'No clean path to this pocket. Try another pocket, or play safe.';
  if (t.blocked) return 'Another ball is in the way. Pick a different pocket or ball, or play a safety.';
  if (t.contact === 'short') {
    const need = t.needPower && t.needPower <= 10 ? ` Use power ${(Math.ceil(t.needPower * 2) / 2).toString()} or more.` : ' Even full power may not get there.';
    return `This stroke is too soft: the cue ball stops before it reaches ${theBall(t.targetLabel)}.${need}`;
  }
  const out: string[] = [];
  const straight = t.cutDeg < 3;
  if (t.railFirst) out.push(`Rail and ball together: the cue ball meets the cushion as it hits ${theBall(t.targetLabel)}, so aim at the contact point on the ball and trust the line.`);
  // A below-centre hit that still arrives rolling forward: say why, or the words contradict the dot.
  const lowButForward = (t.vert ?? 0) <= -0.04 && (t.contact === 'follow' || t.contact === 'roll' || t.contact === 'overspin');
  if (lowButForward) out.push(`Hit ${describeSpin({ side: 0, vert: t.vert! })}: the backspin wears off on the way, so the cue ball arrives with a little follow.`);
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
  else if (Math.abs(t.squirtDeg) >= 0.3) {
    // The blue line is the cue ball's path. Right english squirts the ball left of the cue, so the cue
    // points right of the line (and vice versa); the cue stick drawn on the table already does. Said as
    // an offset at the ghost ball (degrees are in the details): the amount depends on the cue (the
    // shaft setting), and on long shots swerve gives some of it back.
    const off = t.cbDistance && t.ballRadius ? squirtOffsetText(t.squirtDeg, t.side, t.cbDistance, t.ballRadius) : null;
    const dir = t.side > 0 ? 'right' : 'left';
    out.push(
      off
        ? `Aim the cue ${off}, so it points ${dir} of the blue line; the cue ball squirts back onto it.`
        : `Aim the cue ${Math.abs(t.squirtDeg).toFixed(1)}° ${dir} of the blue line; the cue ball squirts back onto it.`,
    );
  }
  else if (Math.abs(t.throwDeg) >= 1) out.push(throwSentence(t));
  return out.slice(0, 2).join(' ');
}

/** Throw compensation in the player's terms: which way to move the aim, by how much. */
export function throwSentence(t: Pick<TipInput, 'throwDeg' | 'throwShiftMm' | 'throwAim'>): string {
  const mm = t.throwShiftMm.toFixed(1);
  const deg = Math.abs(t.throwDeg).toFixed(1);
  switch (t.throwAim) {
    case 'thinner':
      return `Throw ≈ ${deg}° pushes the object ball off line: aim ${mm} mm thinner (the ghost ball shown is already moved).`;
    case 'thicker':
      return `Throw ≈ ${deg}° pushes the object ball off line: aim ${mm} mm thicker (the ghost ball shown is already moved).`;
    case 'left':
    case 'right':
      return `Side spin throws the object ball ≈ ${deg}°: aim ${mm} mm ${t.throwAim} of full ball (the ghost ball shown is already moved).`;
    default:
      return `Throw ≈ ${deg}° is already allowed for in the ghost ball shown.`;
  }
}
