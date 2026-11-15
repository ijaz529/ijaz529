/**
 * Versioned worker message contracts (specs/002-3d-visual-ios/contracts/worker-protocol-v2.md, which
 * supersedes specs/001-realtime-shot-guide/contracts/worker-protocol.md).
 *
 * v2: every v1 message keeps its fields and meaning (only `v` changes); new vision messages `still`
 * (one-shot full pipeline on a photo) and `player-view` (pose of a table-level photo against a known
 * layout). The app and both workers ship in one bundle, so the bump is atomic.
 */
import type { PhysicsParams, Recommendation, ShotRequest, ShotSuggestion, TableLayout, TableSpec, Vec2 } from '../core/types';
import type { Frame } from '../vision/image';
import type { VisionResult } from '../vision/pipeline';
import type { PlayerViewInput, PlayerViewResult } from '../vision/player-view';

export const PROTOCOL_VERSION = 2 as const;
type V = { v: typeof PROTOCOL_VERSION };

/** Optional per-still overrides of the latest `config` (non-breaking extension of v2). */
export interface StillOptions {
  manualCorners?: Vec2[] | null;
  swapAxes?: boolean;
  /** Pipeline passes over the same frame (default 6: the tracker locks after 5 calm frames). */
  iterations?: number;
}

// --- Vision worker -------------------------------------------------------------------------------
export type VisionIn =
  | (V & { type: 'config'; table: TableSpec; fovDeg: number; manualCorners: Vec2[] | null; swapAxes: boolean })
  | (V & { type: 'frame'; id: number; width: number; height: number; buffer: ArrayBuffer })
  | (V & { type: 'reset' })
  /** One-shot full pipeline on a still photo (separate pipeline: live tracking is untouched). `frame.data.buffer` is transferred. */
  | (V & { type: 'still'; id: number; frame: Frame; opts?: StillOptions })
  /** Player-photo pose against the known layout. `input.frame.data.buffer` is transferred. */
  | (V & { type: 'player-view'; id: number; input: PlayerViewInput });

export type VisionOut =
  | (V & { type: 'result'; id: number; result: VisionResult; buffer: ArrayBuffer })
  | (V & { type: 'still'; id: number; result: VisionResult })
  | (V & { type: 'player-view'; id: number; result: PlayerViewResult })
  | (V & { type: 'error'; id?: number; message: string; buffer?: ArrayBuffer });

// --- Planner worker ------------------------------------------------------------------------------
/**
 * Optional (non-breaking v2 extension): the planner worker's per-evaluation cost in ms by ball count
 * (keys are counts, e.g. { "4": 1.2 }), returned with every recommendation and sent back with the
 * next request, so a restarted worker keeps the evaluation budget of the one it replaced.
 */
export type PlannerPerEvalMs = Record<string, number>;

export type PlannerIn =
  | (V & { type: 'recommend'; id: number; layout: TableLayout; request: ShotRequest; params: PhysicsParams; perEvalMs?: PlannerPerEvalMs })
  | (V & { type: 'suggest'; id: number; layout: TableLayout; params: PhysicsParams; max: number })
  | (V & { type: 'heatmap'; id: number; layout: TableLayout; nextBallId: string; excludeIds: string[]; params: PhysicsParams; cols: number; rows: number });

export type PlannerOut =
  | (V & { type: 'recommendation'; id: number; perEvalMs?: PlannerPerEvalMs } & Recommendation)
  | (V & { type: 'suggestions'; id: number; items: ShotSuggestion[] })
  | (V & { type: 'heatmap'; id: number; cols: number; rows: number; values: Float32Array })
  | (V & { type: 'error'; id?: number; message: string });

export function isSupported(msg: { v?: unknown }): boolean {
  return msg.v === PROTOCOL_VERSION;
}
