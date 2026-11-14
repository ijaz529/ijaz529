/**
 * Per-frame vision pipeline: table detection (or manual corners) → tracker-smoothed corners →
 * calibration → ball detection → tracked layout.
 */
import type { TableSpec } from '../core/types';
import type { Vec2 } from '../core/vec';
import { detectBalls } from './ball-detect';
import { calibrationFromCorners, type Calibration } from './calibration';
import type { Frame } from './image';
import { createTableScratch, detectTable, learnClothInQuad, type ClothModel, type TableScratch } from './table-detect';
import { createTracker, type LockStatus, type TrackedBall } from './tracker';

export interface VisionResult {
  status: LockStatus;
  calibration: Calibration | null;
  balls: TrackedBall[];
  quality: number;
  cloth: ClothModel | null;
  ms: number;
}

export interface PipelineConfig {
  table: TableSpec;
  fovDeg?: number;
  manualCorners?: Vec2[] | null;
  swapAxes?: boolean;
}

export function createPipeline(config: PipelineConfig) {
  let cfg: PipelineConfig = { ...config };
  let tracker = createTracker({ ballRadius: cfg.table.ballRadius });
  let scratch: TableScratch | null = null;
  let cloth: ClothModel | null = null;

  return {
    configure(next: Partial<PipelineConfig>): void {
      const tableChanged = next.table && next.table !== cfg.table;
      cfg = { ...cfg, ...next };
      if (tableChanged || 'manualCorners' in next || 'swapAxes' in next) tracker = createTracker({ ballRadius: cfg.table.ballRadius });
    },
    reset(): void {
      tracker.reset();
      cloth = null;
    },
    process(frame: Frame): VisionResult {
      const t0 = performance.now();
      if (!scratch || scratch.w !== frame.width || scratch.h !== frame.height) scratch = createTableScratch(frame.width, frame.height);
      const det = detectTable(frame, scratch, cloth);
      if (det) cloth = det.cloth;
      const manual = cfg.manualCorners && cfg.manualCorners.length === 4 ? cfg.manualCorners : null;
      // Manual corners where the automatic search found no cloth: learn the cloth inside the tapped quad
      // (detectTable has already filled the scratch HSV planes for this frame).
      if (!cloth && manual) cloth = learnClothInQuad(scratch, manual);
      const rawCorners = manual ?? det?.corners ?? null;
      const diag = Math.hypot(frame.width, frame.height);
      // Corners first, so calibration uses the smoothed quad.
      const pre = tracker.updateCorners(rawCorners, diag);
      let calibration: Calibration | null = null;
      let balls: TrackedBall[] = [];
      if (pre.corners && cloth) {
        calibration = calibrationFromCorners(pre.corners, cfg.table, frame.width, frame.height, {
          fovDeg: cfg.fovDeg ?? 65,
          swapAxes: cfg.swapAxes ?? false,
          source: manual ? 'manual' : 'auto',
        });
        if (calibration) {
          const dets = detectBalls(frame, calibration, cfg.table, cloth);
          balls = tracker.updateBalls(dets);
        }
      }
      return {
        status: manual ? 'locked' : pre.status,
        calibration,
        balls,
        quality: manual ? 1 : (det?.quality ?? 0),
        cloth,
        ms: performance.now() - t0,
      };
    },
  };
}
