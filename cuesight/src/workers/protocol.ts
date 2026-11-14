/**
 * Versioned worker message contracts (specs/001-realtime-shot-guide/contracts/worker-protocol.md).
 */
import type { PhysicsParams, Recommendation, ShotRequest, ShotSuggestion, TableLayout, TableSpec, Vec2 } from '../core/types';
import type { VisionResult } from '../vision/pipeline';

export const PROTOCOL_VERSION = 1 as const;
type V = { v: typeof PROTOCOL_VERSION };

// --- Vision worker -------------------------------------------------------------------------------
export type VisionIn =
  | (V & { type: 'config'; table: TableSpec; fovDeg: number; manualCorners: Vec2[] | null; swapAxes: boolean })
  | (V & { type: 'frame'; id: number; width: number; height: number; buffer: ArrayBuffer })
  | (V & { type: 'reset' });

export type VisionOut =
  | (V & { type: 'result'; id: number; result: VisionResult; buffer: ArrayBuffer })
  | (V & { type: 'error'; id?: number; message: string; buffer?: ArrayBuffer });

// --- Planner worker ------------------------------------------------------------------------------
export type PlannerIn =
  | (V & { type: 'recommend'; id: number; layout: TableLayout; request: ShotRequest; params: PhysicsParams })
  | (V & { type: 'suggest'; id: number; layout: TableLayout; params: PhysicsParams; max: number })
  | (V & { type: 'heatmap'; id: number; layout: TableLayout; nextBallId: string; excludeIds: string[]; params: PhysicsParams; cols: number; rows: number });

export type PlannerOut =
  | (V & { type: 'recommendation'; id: number } & Recommendation)
  | (V & { type: 'suggestions'; id: number; items: ShotSuggestion[] })
  | (V & { type: 'heatmap'; id: number; cols: number; rows: number; values: Float32Array })
  | (V & { type: 'error'; id?: number; message: string });

export function isSupported(msg: { v?: unknown }): boolean {
  return msg.v === PROTOCOL_VERSION;
}
