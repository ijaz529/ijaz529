/**
 * Snap session state machine (feature 002 US2, data-model.md § SnapSession). Pure: the DOM controller
 * dispatches events and renders whatever state comes back. Photos themselves (pixels) live outside the
 * state, in the controller, and are dropped whenever the session returns to `intro` (FR-122).
 */
import type { Ball, ShotPlan, Stroke, Vec2 } from '../../core/types';
import type { VisionResult } from '../../vision/pipeline';
import type { PlayerViewResult } from '../../vision/player-view';
import { cornersPlausible } from '../live-logic';

export type PhotoSource = 'camera' | 'library' | 'sample';

export type SnapStep =
  /** Nothing yet: the two-photo explainer with Take / Choose / Try samples. */
  | 'intro'
  /** Table photo decoded and sent to the vision worker. */
  | 'overview-processing'
  /** Detection failed: offer Tap corners / Retake. */
  | 'overview-error'
  /** Tapping the four cloth corners on the table photo. */
  | 'corners'
  /** Layout detected: fix it, pick the target (+ pocket); then the player photo. */
  | 'review'
  /** Player photo sent to the vision worker. */
  | 'player-processing'
  /** The guide drawn on the player photo. */
  | 'guide'
  /** The pose fit failed: tap the cue ball, then the target ball. */
  | 'manual-taps';

export interface PhotoInfo {
  width: number;
  height: number;
  source: PhotoSource;
}

export interface SnapSession {
  step: SnapStep;
  overview: (PhotoInfo & { vision: VisionResult | null }) | null;
  /** The confirmed (and possibly edited) layout. */
  layout: Ball[] | null;
  /** Manual cloth corners in table-photo px (for a re-run), and taps in progress. */
  corners: Vec2[] | null;
  cornerTaps: Vec2[];
  /**
   * The player photo and its fit. `fitTargetId` is the target ball the fit (and so its confidence) was
   * computed for; `manual` marks a fit from the two taps; `refitting` a quiet re-fit for a new target.
   */
  player: (PhotoInfo & { result: PlayerViewResult | null; fitTargetId?: string | null; manual?: boolean; refitting?: boolean }) | null;
  /** Manual-fallback taps on the player photo (image px). */
  taps: { cue?: Vec2; target?: Vec2 };
  error: string | null;
}

export type SnapEvent =
  | { type: 'reset' }
  | { type: 'overview-photo'; photo: PhotoInfo }
  | { type: 'overview-result'; vision: VisionResult; balls: Ball[] }
  | { type: 'overview-failed'; message: string }
  | { type: 'start-corners' }
  | { type: 'corner-tap'; p: Vec2 }
  | { type: 'cancel-corners' }
  | { type: 'layout'; balls: Ball[] }
  | { type: 'player-photo'; photo: PhotoInfo }
  | { type: 'player-result'; result: PlayerViewResult; targetId?: string | null; manual?: boolean }
  /** The target changed after an automatic fit: the same photo is fitted again, the guide stays up. */
  | { type: 'refit' }
  | { type: 'player-failed'; message: string }
  | { type: 'manual-tap'; p: Vec2 }
  | { type: 'start-manual' }
  | { type: 'edit-layout' }
  | { type: 'back-to-guide' };

export const SNAP_MESSAGES = {
  /**
   * No table in the table photo. The merged vision refuses a table cut off by the photo's border (no
   * border-hugging quad), the usual cause, so this says what the photo needs; tapping the corners only
   * helps when all four are in it.
   */
  noTable: 'The whole table must be in the photo — step back or turn the phone and retake it. All four corners already in view? Tap them.',
  /** Four tapped corners that cannot be a table outline (refused locally, or VisionResult.reason 'bad-quad'); Live's words. */
  badCorners: 'Those four taps aren’t the cloth corners — tap them again.',
  /** No cloth colour could be learned inside the tapped corners (reason 'cloth-unknown'). */
  clothUnknown: 'Couldn’t tell the cloth from its surroundings — tap the four cloth corners again, or retake the photo.',
  /** Tapped corners whose quad is not mostly cloth (reason 'moved' on a still: one photo, nothing moved). */
  cornersLoose: 'Your four corners don’t quite match the cloth — check the layout, or tap the corners again.',
  noBalls: "I found the table but no balls. Retake the photo a little closer, or add the balls by hand.",
  noCue: "I couldn't tell which ball is the cue ball. Tap “Cue ball”, then tap it on the table.",
  decode: "That photo couldn't be opened. Try another one.",
  /** The vision worker never answered before it failed (its script may not be cached for offline use yet). */
  detectionLoad: 'Table detection couldn’t start — it may not be available offline yet. Reconnect, then retake the photo or choose it again.',
  /** The vision worker had been answering, then failed on this table photo. */
  detectionStopped: 'Table detection stopped working on this photo. Retake it or choose it again to try once more.',
  /** The vision worker failed while lining up the player photo; the two taps run it again. */
  detectionStoppedPlayer: 'Table detection stopped working on this photo. Tap the cue ball, then your target, to try again.',
} as const;

/**
 * The event that ends a Snap request when the vision worker itself failed (it will never reply):
 * `loaded` = the worker had answered at least once, so this is not a script that failed to load.
 */
/**
 * What a failed player-photo fit asks the player to do next. The reason strings are
 * PLAYER_VIEW_REASONS (src/vision/player-view.ts); they are matched by text so the app bundle does not
 * pull in the vision module (tests/unit/app/snap-session.test.ts checks every reason).
 * - 'retake-table': the balls moved since the table photo, so a guide from the old layout would be
 *   wrong (FR-121); two taps cannot help.
 * - 'retake-light': too dark, too grainy, or no cloth in view: a better photo is the fix; the two taps
 *   are still offered.
 * - 'taps': no cue ball, too few balls or no fit: the two taps fit the photo.
 */
export type PlayerFailAction = 'retake-table' | 'retake-light' | 'taps';
export function playerFailAction(reason: string | null | undefined): PlayerFailAction {
  if (!reason) return 'taps';
  if (/^The balls seem to have moved/.test(reason)) return 'retake-table';
  if (/too dark|too grainy|find the table cloth/.test(reason)) return 'retake-light';
  return 'taps';
}

export function visionFailedEvent(kind: 'still' | 'player-view', loaded: boolean): SnapEvent {
  if (kind === 'player-view') return { type: 'player-failed', message: loaded ? SNAP_MESSAGES.detectionStoppedPlayer : SNAP_MESSAGES.detectionLoad };
  return { type: 'overview-failed', message: loaded ? SNAP_MESSAGES.detectionStopped : SNAP_MESSAGES.detectionLoad };
}

export function initialSnap(): SnapSession {
  return { step: 'intro', overview: null, layout: null, corners: null, cornerTaps: [], player: null, taps: {}, error: null };
}

/**
 * The table photo gives a layout to check: the whole table was found (a calibration). A table found
 * without balls still does (the player adds them by hand). No calibration: no table, which is also what
 * the merged vision returns for a table cut off by the photo's border.
 */
export function detectionUsable(v: VisionResult): boolean {
  return !!v.calibration;
}

/** Why a table photo gave no layout, in the player's words (VisionResult.reason for tapped corners). */
function noLayoutMessage(v: VisionResult): string {
  const reason = 'reason' in v && typeof v.reason === 'string' ? v.reason : undefined;
  if (reason === 'bad-quad') return SNAP_MESSAGES.badCorners;
  if (reason === 'cloth-unknown') return SNAP_MESSAGES.clothUnknown;
  return SNAP_MESSAGES.noTable;
}

export function snapReducer(s: SnapSession, e: SnapEvent): SnapSession {
  switch (e.type) {
    case 'reset':
      return initialSnap();
    case 'overview-photo':
      return { ...initialSnap(), step: 'overview-processing', overview: { ...e.photo, vision: null } };
    case 'overview-result': {
      if (!s.overview) return s;
      const overview = { ...s.overview, vision: e.vision };
      if (!detectionUsable(e.vision)) return { ...s, step: 'overview-error', overview, layout: null, cornerTaps: [], error: noLayoutMessage(e.vision) };
      // Tapped corners that give a table but whose quad is not mostly cloth ('moved' on one photo).
      const loose = 'reason' in e.vision && e.vision.reason === 'moved';
      // A table without balls is still useful: the player can add balls by hand. (With loose corners,
      // the corners are the first thing to check: they may be why no ball was found.)
      return { ...s, step: 'review', overview, layout: e.balls, cornerTaps: [], player: null, taps: {}, error: loose ? SNAP_MESSAGES.cornersLoose : e.balls.length ? null : SNAP_MESSAGES.noBalls };
    }
    case 'overview-failed':
      return s.overview ? { ...s, step: 'overview-error', error: e.message } : { ...initialSnap(), error: e.message };
    case 'start-corners':
      return s.overview ? { ...s, step: 'corners', cornerTaps: [], error: null } : s;
    case 'corner-tap': {
      if (s.step !== 'corners') return s;
      const cornerTaps = [...s.cornerTaps, e.p];
      if (cornerTaps.length < 4) return { ...s, cornerTaps };
      // Taps that cannot be a table outline (three on one rail, two on one spot, a sliver) are refused
      // here, with Live's check and words (live-logic cornersPlausible): the still pipeline would only
      // say it could not tell the cloth. Nothing is sent; "Tap the 4 corners" starts again.
      if (s.overview && !cornersPlausible(cornerTaps, s.overview.width, s.overview.height)) return { ...s, step: 'overview-error', corners: null, cornerTaps: [], error: SNAP_MESSAGES.badCorners };
      return { ...s, step: 'overview-processing', corners: cornerTaps, cornerTaps: [] };
    }
    case 'cancel-corners':
      return s.step === 'corners' ? { ...s, step: s.layout ? 'review' : 'overview-error', cornerTaps: [] } : s;
    case 'layout':
      return s.layout ? { ...s, layout: e.balls } : s;
    case 'player-photo':
      return s.layout ? { ...s, step: 'player-processing', player: { ...e.photo, result: null }, taps: {}, error: null } : s;
    case 'player-result': {
      if (!s.player) return s;
      const player = { ...s.player, result: e.result, fitTargetId: e.targetId ?? null, manual: !!e.manual, refitting: false };
      return { ...s, player, step: e.result.ok ? 'guide' : 'manual-taps', taps: {}, error: e.result.ok ? null : (e.result.reason ?? null) };
    }
    case 'refit':
      return s.player?.result ? { ...s, player: { ...s.player, refitting: true } } : s;
    case 'player-failed':
      return s.player ? { ...s, step: 'manual-taps', taps: {}, error: e.message } : s;
    case 'start-manual':
      return s.player ? { ...s, step: 'manual-taps', taps: {} } : s;
    case 'manual-tap': {
      if (s.step !== 'manual-taps' || playerFailAction(s.error) === 'retake-table') return s;
      if (!s.taps.cue) return { ...s, taps: { cue: e.p } };
      return { ...s, step: 'player-processing', taps: { cue: s.taps.cue, target: e.p } };
    }
    case 'edit-layout':
      return s.layout ? { ...s, step: 'review' } : s;
    case 'back-to-guide':
      return s.player?.result?.ok ? { ...s, step: 'guide' } : s.player ? { ...s, step: 'manual-taps', taps: {} } : s;
  }
}

/**
 * Whether the guide's fit (and its confidence chip) is about the target being shown:
 * - `current`: yes; `checking`: a re-fit for it is running; `none`: no fit to show (not in the guide,
 *   or no target picked);
 * - `refit`: an automatic fit made for another target, so fit the same photo again;
 * - `taps`: a fit from two taps that named another target ball, so the player taps again.
 * The pocket and the stroke never matter: the confidence is about the target ball's position.
 */
export function fitCheck(s: SnapSession, targetId: string | null): 'current' | 'checking' | 'refit' | 'taps' | 'none' {
  const p = s.player;
  if (s.step !== 'guide' || !p?.result?.ok || !targetId) return 'none';
  if (p.refitting) return 'checking';
  if (p.fitTargetId === targetId) return 'current';
  return p.manual ? 'taps' : 'refit';
}

/** The step the progress indicator highlights: 1 (table) or 2 (your view). */
export function snapStage(step: SnapStep): 1 | 2 {
  return step === 'player-processing' || step === 'guide' || step === 'manual-taps' ? 2 : 1;
}

// --- Guide words -----------------------------------------------------------------------------------

/** A frozen cue ball (touching the object ball): no ghost ball and no cut; the stroke angle is aimed. */
export function frozenPlan(plan: Pick<ShotPlan, 'warnings'>): boolean {
  return plan.warnings.some((w) => w.code === 'frozen');
}

/**
 * The guide's aim line (the HUD under the photo): the ghost ball and the cut, or, for a frozen cue
 * ball, the stroke's angle off the line of centres, in the frozen warning's words (planner.ts: CCW =
 * left, under half a degree = straight through). `cue` / `target`: table positions of the two balls.
 */
export function snapAimText(plan: Pick<ShotPlan, 'warnings' | 'aimDir' | 'cutAngleDeg' | 'fractionPhrase'>, cue: Vec2 | null, target: Vec2 | null): string {
  if (frozenPlan(plan) && cue && target) {
    const lx = target.x - cue.x;
    const ly = target.y - cue.y;
    const off = (Math.atan2(lx * plan.aimDir.y - ly * plan.aimDir.x, lx * plan.aimDir.x + ly * plan.aimDir.y) * 180) / Math.PI;
    return Math.abs(off) >= 0.5 ? `Frozen: stroke ${Math.abs(off).toFixed(0)}° to the ${off > 0 ? 'left' : 'right'} of the line of centres` : 'Frozen: stroke straight through the line of centres';
  }
  return `Aim at the ghost ball · ${plan.cutAngleDeg.toFixed(0)}° cut, ${plan.fractionPhrase.replace(/-/g, '‑')}`;
}

/** The guide step's top instruction for a playable plan (`spin` words the strike point: guide.ts strikeWords). */
export function snapGuideInstruction(plan: Pick<ShotPlan, 'warnings' | 'stroke'>, spin: (s: Stroke) => string): string {
  const strike = `Strike ${spin(plan.stroke)} (the blue dot on the ball's face).`;
  return frozenPlan(plan) ? `Frozen balls: aim the stroke, not a ghost ball. ${strike}` : `Aim at the ghost ball. ${strike}`;
}
