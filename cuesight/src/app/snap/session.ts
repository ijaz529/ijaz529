/**
 * Snap session state machine (feature 002 US2, data-model.md § SnapSession). Pure: the DOM controller
 * dispatches events and renders whatever state comes back. Photos themselves (pixels) live outside the
 * state, in the controller, and are dropped whenever the session returns to `intro` (FR-122).
 */
import type { Ball, Vec2 } from '../../core/types';
import type { VisionResult } from '../../vision/pipeline';
import type { PlayerViewResult } from '../../vision/player-view';

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
  noTable: "I couldn't find the table in this photo. Tap its four corners, or retake it with the whole cloth in view.",
  noBalls: "I found the table but no balls. Retake the photo a little closer, or add the balls by hand.",
  noCue: "I couldn't tell which ball is the cue ball. Tap “Cue ball”, then tap it on the table.",
  decode: "That photo couldn't be opened. Try another one.",
} as const;

export function initialSnap(): SnapSession {
  return { step: 'intro', overview: null, layout: null, corners: null, cornerTaps: [], player: null, taps: {}, error: null };
}

/** True when the table photo detection is usable (table found and at least one ball). */
export function detectionUsable(v: VisionResult): boolean {
  return !!v.calibration && v.balls.length > 0;
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
      if (!e.vision.calibration) return { ...s, step: 'overview-error', overview, layout: null, cornerTaps: [], error: SNAP_MESSAGES.noTable };
      // A table without balls is still useful: the player can add balls by hand.
      return { ...s, step: 'review', overview, layout: e.balls, cornerTaps: [], player: null, taps: {}, error: e.balls.length ? null : SNAP_MESSAGES.noBalls };
    }
    case 'overview-failed':
      return s.overview ? { ...s, step: 'overview-error', error: e.message } : { ...initialSnap(), error: e.message };
    case 'start-corners':
      return s.overview ? { ...s, step: 'corners', cornerTaps: [], error: null } : s;
    case 'corner-tap': {
      if (s.step !== 'corners') return s;
      const cornerTaps = [...s.cornerTaps, e.p];
      if (cornerTaps.length < 4) return { ...s, cornerTaps };
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
      if (s.step !== 'manual-taps') return s;
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
