/**
 * Tiny observable store: a single mutable state object; `update()` mutates and schedules one
 * render per animation frame for all subscribers.
 */
import type { Ball, PocketId, ShotPlan, ShotSuggestion, Stroke, TableLayout, TableSpec, PhysicsParams, Vec2 } from '../core/types';
import type { Calibration } from '../vision/calibration';
import type { LockStatus } from '../vision/tracker';
import type { Settings } from './settings';
import type { SnapSession } from './snap/session';

export type Mode = 'camera' | 'practice' | 'snap';
export type Interaction = 'select' | 'position' | 'calibrate' | 'mark-cue' | 'pick-next';

export interface LiveVision {
  status: LockStatus;
  calibration: Calibration | null;
  balls: Ball[];
  quality: number;
  ms: number;
  frameW: number;
  frameH: number;
}

export interface AppState {
  mode: Mode;
  settings: Settings;
  table: TableSpec;
  params: PhysicsParams;
  practice: TableLayout;
  vision: LiveVision | null;
  frozen: { layout: TableLayout; calibration: Calibration | null } | null;
  targetId: string | null;
  pocketId: PocketId | null;
  strokeMode: 'recommended' | 'mine';
  myStroke: Stroke;
  recommended: { key: string; stroke: Stroke | null; pending: boolean; reachable: boolean; evaluated: number } | null;
  landing: Vec2 | null;
  interaction: Interaction;
  calibTaps: Vec2[];
  manualCorners: Vec2[] | null;
  swapAxes: boolean;
  heatmap: { nextBallId: string; cols: number; rows: number; values: Float32Array; pending: boolean } | null;
  suggestions: { items: ShotSuggestion[]; pending: boolean } | null;
  plan: ShotPlan | null;
  cameraError: string | null;
  cueOverrideId: string | null;
  toast: string | null;
  /** Snap mode (two-photo guide) session; photos themselves live in the Snap controller. */
  snap: SnapSession;
}

type Listener = (s: AppState) => void;

export function createStore(initial: AppState) {
  const state = initial;
  const listeners = new Set<Listener>();
  let scheduled = false;
  const flush = () => {
    scheduled = false;
    for (const l of listeners) l(state);
  };
  return {
    state,
    update(fn: (s: AppState) => void): void {
      fn(state);
      if (!scheduled) {
        scheduled = true;
        (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (cb: () => void) => setTimeout(cb, 16))(flush);
      }
    },
    subscribe(l: Listener): () => void {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

export type Store = ReturnType<typeof createStore>;
