/**
 * Difficulty labels (research.md R-10) and coaching tips in player language (Principle VI).
 */
import type { Difficulty } from '../types';
import { describeSpin, powerFigure } from './power';

export const DIFFICULTY_THRESHOLDS = { easy: 0.2, medium: 0.08, hard: 0.04 } as const;

export function difficultyOf(toleranceDeg: number): Difficulty {
  if (toleranceDeg >= DIFFICULTY_THRESHOLDS.easy) return 'easy';
  if (toleranceDeg >= DIFFICULTY_THRESHOLDS.medium) return 'medium';
  if (toleranceDeg >= DIFFICULTY_THRESHOLDS.hard) return 'hard';
  return 'very hard';
}

/**
 * Top/back spin of the cue ball at impact; 'short' = it never gets there (it stops on the way, so
 * there is no impact and no spin to name).
 */
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

/** Which way the throw correction moved the ghost ball (see ShotPlan.throwAim). */
export type ThrowShiftDir = 'thinner' | 'thicker' | 'left' | 'right';

export interface TipInput {
  cutDeg: number;
  contact: ContactSpin;
  throwDeg: number;
  throwShiftMm: number;
  /** Direction of the throw compensation as the player aims it (see ShotPlan.throwAim). */
  throwAim?: ThrowShiftDir | null;
  /**
   * Same as throwAim (the wave-1 name); throwAim wins when both are set. With neither, the throw
   * sentence only says the shift is already allowed for in the ghost ball shown.
   */
  shiftDir?: ThrowShiftDir;
  squirtDeg: number;
  side: number;
  /** Tip height of the stroke (fraction of R): a low hit that arrives with follow is explained. */
  vert?: number;
  scratch: boolean;
  blocked: boolean;
  makeable: boolean;
  /** False when the cue ball stops before it reaches the object ball (default true). */
  cbReachesOb?: boolean;
  /**
   * Power to advise in the "too soft" tip, quoted as given (one decimal at most). planShot passes
   * advisePower(ShotPlan.minPower), the figure its warnings quote; > 10: full power won't do.
   */
  minPower?: number;
  /** Same as minPower (an earlier name); minPower wins when both are set. */
  needPower?: number;
  /** Cue ball → ghost-ball distance (m): turns the squirt angle into an aim offset at the ghost ball. */
  cbDistance?: number;
  /** Ball radius (m), for the offset in balls. */
  ballRadius?: number;
  /** Target ball's name ("1", "yellow") for sentences about it. */
  targetLabel?: string;
  /** The cue ball meets a cushion within a few ms of the object ball (a "rail and ball together" shot). */
  railFirst?: boolean;
  /** Name of the best clear pocket for this ball when the chosen one is blocked. */
  altPocketName?: string;
  /** The cue ball touches the object ball: the object ball leaves along the line of centres. */
  frozen?: boolean;
  /** A one-cushion bank (ShotPlan.bank). */
  bank?: boolean;
}

/** "the 1" / "the yellow" / "the object ball". */
function theBall(label?: string): string {
  return label ? `the ${label}` : 'the object ball';
}

/**
 * Squirt compensation as something a player can execute: where the cue points at the ghost ball's
 * distance (tan(squirt) × distance), in mm and, given the ball radius R, in balls, e.g. "about ⅓ of
 * a ball (17 mm) right of the ghost ball". Null when it is too small to aim (< 2 mm).
 */
export function squirtOffsetText(squirtDeg: number, side: number, cbDistance: number, R?: number): string | null {
  const mm = Math.tan((Math.abs(squirtDeg) * Math.PI) / 180) * cbDistance * 1000;
  if (!(mm >= 2)) return null;
  const balls = R !== undefined && R > 0 ? mm / (2 * R * 1000) : 0;
  const amount =
    balls < 0.19
      ? `about ${mm.toFixed(0)} mm`
      : `about ${balls < 0.29 ? '¼ of a ball' : balls < 0.42 ? '⅓ of a ball' : balls < 0.62 ? '½ a ball' : balls < 0.87 ? '¾ of a ball' : 'a ball or more'} (${mm.toFixed(0)} mm)`;
  return `${amount} ${side > 0 ? 'right' : 'left'} of the ghost ball`;
}

/**
 * The stroke's name as coaches say it, from the cue ball's spin at impact (and the tip height):
 * stop shot, stun, stun-run-through, drag, draw, follow, plus the english side. Null when the cue
 * ball never reaches the object ball. For a frozen cue ball planShot passes the stroke's angle off
 * the line of centres as `cutDeg` (there is no ghost ball to cut).
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

/** Thresholds for mentioning a correction (below them the sentence would be noise). */
const SQUIRT_MENTION_DEG = 0.3;
const THROW_MENTION_DEG = 1;
const THROW_MENTION_MM = 0.1;

/**
 * Up to three short sentences, most important first: how to approach the shot (frozen balls, rail
 * and ball together, a low hit that still arrives with follow), what the cue ball does at contact,
 * then the aim corrections (squirt, throw) the player has to make or should know about. A scratch
 * replaces the corrections: the stroke itself has to change.
 *
 * The blue line the app draws is the cue ball's path (cue ball → ghost ball, ShotPlan.aimDir), so the
 * squirt sentence tells the player to aim the cue off that line, once, in degrees and as the offset
 * at the ghost ball; it never claims the correction is already in the line.
 */
export function coachingTip(t: TipInput): string {
  if (!t.makeable) return 'No clean path to this pocket. Try another pocket, or play safe.';
  if (t.blocked)
    return t.altPocketName
      ? `Another ball is in the way. Try the ${t.altPocketName} instead, or play a safety.`
      : 'Another ball is in the way. No other pocket is clear for this ball: pick another ball or play a safety.';
  if (t.cbReachesOb === false || t.contact === 'short') {
    const p = t.minPower ?? t.needPower;
    const ball = theBall(t.targetLabel);
    if (p !== undefined && p > 10) return `Too far: the cue ball stops before it reaches ${ball}, even at full power.`;
    // minPower is for this stroke's tip height: only a stroke without draw is told draw needs more.
    const more = (t.vert ?? 0) > -0.04 ? '; draw needs more pace still' : '';
    return `Too soft: the cue ball stops before it reaches ${ball}.${p !== undefined ? ` Use power ${powerFigure(p)}+${more}.` : ' Hit it harder.'}`;
  }
  const out: string[] = [];
  const straight = t.cutDeg < 3;
  // The model's cushion paths are good to a few degrees (collide.ts) and a bank's window is under one: say so.
  if (t.bank) out.push('Bank shot: pace changes the angle off the cushion and cushions vary, so use the line as a starting point.');
  if (t.frozen) out.push('Frozen balls: the object ball leaves along the line of centres, so aim the stroke, not a ghost ball.');
  else if (t.railFirst)
    out.push(`Rail and ball together: the cue ball meets the cushion as it hits ${theBall(t.targetLabel)}, so aim at the contact point on the ball and trust the line.`);
  // A below-centre hit that still arrives rolling forward: say why, or the words contradict the dot.
  const lowButForward = (t.vert ?? 0) <= -0.04 && (t.contact === 'follow' || t.contact === 'roll' || t.contact === 'overspin');
  if (lowButForward) out.push(`Hit ${describeSpin({ side: 0, vert: t.vert! })}: the backspin wears off on the way, so the cue ball arrives with a little follow.`);
  if (t.frozen) {
    // No ghost ball and no cut to describe: the line-of-centres sentence above is the aim.
  } else if (straight) {
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
  if (t.scratch) return [...out.slice(0, 2), 'Careful: this stroke sends the cue ball into a pocket. Change speed or spin.'].join(' ');
  if (Math.abs(t.squirtDeg) >= SQUIRT_MENTION_DEG) {
    // Right english squirts the ball left of the cue, so the cue points right of the line (and vice
    // versa). The amount depends on the cue (the shaft setting), and on long shots swerve gives some
    // of it back: the figure is a starting point for the player's own cue.
    const a = Math.abs(t.squirtDeg).toFixed(1);
    const off = t.cbDistance !== undefined && t.cbDistance > 0 ? squirtOffsetText(t.squirtDeg, t.side, t.cbDistance, t.ballRadius) : null;
    out.push(
      `Side spin squirts the cue ball ${a}° off-line: aim the cue ${a}° to the ${t.side > 0 ? 'right' : 'left'} of the blue line${off ? `, ${off}` : ''} — the line is where the cue ball travels.`,
    );
  }
  if (!t.frozen && Math.abs(t.throwDeg) >= THROW_MENTION_DEG && t.throwShiftMm >= THROW_MENTION_MM) out.push(throwSentence(t));
  return out.slice(0, 3).join(' ');
}

/**
 * Throw compensation in the player's terms: which way the ghost ball shown was moved for it, and by
 * how much. `side` (the stroke's english) names outside english as the cause of a thicker shift.
 */
export function throwSentence(t: Pick<TipInput, 'throwDeg' | 'throwShiftMm' | 'throwAim' | 'shiftDir'> & { side?: number }): string {
  const mm = t.throwShiftMm.toFixed(1);
  const deg = Math.abs(t.throwDeg).toFixed(1);
  const dir = t.throwAim ?? t.shiftDir;
  switch (dir) {
    case 'thinner':
      return `Throw ≈ ${deg}° pushes the object ball thick, so the ghost ball is shifted ${mm} mm thinner.`;
    case 'thicker':
      return t.side !== undefined && t.side !== 0
        ? `Outside english throws the object ball thin here, so the ghost ball is shifted ${mm} mm thicker.`
        : `Throw pushes the object ball thin here, so the ghost ball is shifted ${mm} mm thicker.`;
    case 'left':
    case 'right':
      // A centre-ball stroke has no side to blame: the shift is the cut's own throw.
      return t.side === 0
        ? `Throw: the ghost ball is shifted ${mm} mm to the ${dir} of full ball.`
        : `Side-spin throw: the ghost ball is shifted ${mm} mm to the ${dir} of full ball.`;
    default:
      return `Throw ≈ ${deg}° is already allowed for in the ghost ball shown.`;
  }
}
