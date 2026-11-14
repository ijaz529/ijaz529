/**
 * Per-frame vision pipeline: table detection (or manual corners) → tracker-smoothed corners →
 * calibration → ball detection → tracked layout.
 *
 * Honesty rules (Constitution II):
 *  - a frame without a usable quad reports no calibration and no balls (the tracker keeps its state
 *    for re-association, but nothing stale is drawn);
 *  - an automatic quad must reach MIN_TABLE_QUALITY to count;
 *  - manual corners are 'locked' only while the tapped quad is still mostly cloth and the automatic
 *    detector does not see the table elsewhere; otherwise 'unstable' / 'searching' with a reason;
 *  - a new cloth colour must persist for several frames before it replaces the established one, and
 *    then the lock starts over.
 */
import type { TableSpec } from '../core/types';
import type { Vec2 } from '../core/vec';
import { detectBalls } from './ball-detect';
import { calibrationFromCorners, usableFovDeg, type Calibration } from './calibration';
import { hueDiff, type Frame } from './image';
import { clothCoverageInQuad, createTableScratch, detectTable, HUE_TOL, learnClothInQuad, MIN_TABLE_QUALITY, type ClothModel, type TableDetection, type TableScratch } from './table-detect';
import { createTracker, type LockStatus, type TrackedBall } from './tracker';

export interface VisionResult {
  status: LockStatus;
  calibration: Calibration | null;
  balls: TrackedBall[];
  quality: number;
  cloth: ClothModel | null;
  ms: number;
  /**
   * Manual corners only: why the status is not 'locked'. 'cloth-unknown': no cloth colour could be
   * learned for the quad; 'bad-quad': the four taps cannot be a table outline; 'moved': the quad no
   * longer matches the cloth (the phone moved, or the automatic detector sees the table elsewhere).
   */
  reason?: 'cloth-unknown' | 'moved' | 'bad-quad';
}

export interface PipelineConfig {
  table: TableSpec;
  fovDeg?: number;
  manualCorners?: Vec2[] | null;
  swapAxes?: boolean;
}

/**
 * Frames a different cloth colour must persist before it replaces the established model.
 * ASSUMPTION: ≈ 0.5 s at the 10 Hz budget — longer than a hand or a shirt passing over the table,
 * short enough to follow a real change of table (the same count the tracker needs to lock).
 */
const CLOTH_CHANGE_FRAMES = 5;
/** Manual quad: minimum quality for 'locked' (share of cloth inside it, and corner agreement below). */
const MANUAL_LOCK_QUALITY = 0.8;
/**
 * Manual quad vs a confident automatic detection (quality ≥ 0.85): a corner gap of 3 % of the diagonal
 * (2 × the SC-003 outline tolerance) means the phone moved. The agreement score falls linearly from 1
 * at no gap to MANUAL_LOCK_QUALITY at that gap, so 'not locked' and 'quality < 0.8' coincide.
 */
const MANUAL_DISAGREE_QUALITY = 0.85;
const MANUAL_DISAGREE_GAP = 0.03;

/** Same table geometry (the worker always receives a structured clone, so identity says nothing). */
function sameTable(a: TableSpec, b: TableSpec): boolean {
  return (
    a === b ||
    (a.name === b.name &&
      a.length === b.length &&
      a.width === b.width &&
      a.ballRadius === b.ballRadius &&
      a.cushionWidth === b.cushionWidth &&
      a.cushionHeight === b.cushionHeight &&
      a.cornerMouth === b.cornerMouth &&
      a.sideMouth === b.sideMouth)
  );
}

const manualOf = (c: Vec2[] | null | undefined): Vec2[] | null => (c && c.length === 4 ? c : null);

/** Same manual corners by value (each within 0.5 px), or both absent. */
function sameCorners(a: Vec2[] | null | undefined, b: Vec2[] | null | undefined): boolean {
  const p = manualOf(a);
  const q = manualOf(b);
  if (!p || !q) return !p && !q;
  return p.every((v, i) => Math.hypot(v.x - q[i]!.x, v.y - q[i]!.y) < 0.5);
}

const sameCloth = (a: ClothModel, b: ClothModel) => (a.kind === 'neutral') === (b.kind === 'neutral') && (a.kind === 'neutral' || hueDiff(a.hue, b.hue) < HUE_TOL);

/** Largest distance from a manual corner to the nearest detected corner (px). */
function cornerGap(manual: Vec2[], det: Vec2[]): number {
  return Math.max(...manual.map((m) => Math.min(...det.map((d) => Math.hypot(d.x - m.x, d.y - m.y)))));
}

/**
 * Enforce the 2R separation and the cushion limits promised by data-model.md on the reported balls
 * (copies; track state is untouched): overlapping pairs are pushed apart symmetrically along the line
 * of centres to exactly 2R, three relaxation passes, then clamped to |x| ≤ L/2 − R, |y| ≤ W/2 − R.
 * Detections of frozen balls are biased toward each other; the planner must never see overlap.
 */
export function separateBalls(balls: TrackedBall[], table: TableSpec): TrackedBall[] {
  const R = table.ballRadius;
  const xMax = table.length / 2 - R;
  const yMax = table.width / 2 - R;
  const clamp = (v: number, m: number) => (v > m ? m : v < -m ? -m : v);
  const out = balls.map((b) => ({ ...b, pos: { x: clamp(b.pos.x, xMax), y: clamp(b.pos.y, yMax) } }));
  for (let pass = 0; pass < 3; pass++) {
    let moved = false;
    for (let i = 0; i < out.length; i++)
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i]!.pos;
        const b = out[j]!.pos;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d = Math.hypot(dx, dy);
        if (d >= 2 * R) continue;
        if (d < 1e-9) {
          // Coincident: separate along x (any direction is as good as another).
          dx = 1;
          dy = 0;
          d = 1;
        }
        const push = (2 * R - Math.hypot(b.x - a.x, b.y - a.y)) / 2;
        const ux = dx / d;
        const uy = dy / d;
        a.x -= ux * push;
        a.y -= uy * push;
        b.x += ux * push;
        b.y += uy * push;
        moved = true;
      }
    for (const o of out) {
      o.pos.x = clamp(o.pos.x, xMax);
      o.pos.y = clamp(o.pos.y, yMax);
    }
    if (!moved) break;
  }
  return out;
}

export function createPipeline(config: PipelineConfig) {
  let cfg: PipelineConfig = { ...config };
  let tracker = createTracker({ ballRadius: cfg.table.ballRadius });
  let scratch: TableScratch | null = null;
  let cloth: ClothModel | null = null;
  let candidate: ClothModel | null = null;
  let candidateFrames = 0;
  /** The previous calibration (for a stable table frame); cleared whenever the lock starts over. */
  let lastCal: Calibration | null = null;

  /** Cloth hysteresis: a detection made with a new cloth colour counts only once that colour persists. */
  function accept(det: TableDetection | null): TableDetection | null {
    if (!det) {
      candidate = null;
      candidateFrames = 0;
      return null;
    }
    if (!cloth || sameCloth(det.cloth, cloth)) {
      cloth = det.cloth;
      candidate = null;
      candidateFrames = 0;
      return det;
    }
    if (candidate && sameCloth(det.cloth, candidate)) candidateFrames++;
    else {
      candidate = det.cloth;
      candidateFrames = 1;
    }
    if (candidateFrames < CLOTH_CHANGE_FRAMES) return null;
    // The scene really changed colour: adopt it, and make the new table hypothesis earn its lock.
    cloth = det.cloth;
    candidate = null;
    candidateFrames = 0;
    tracker.resetLock();
    lastCal = null;
    return det;
  }

  return {
    configure(next: Partial<PipelineConfig>): void {
      const old = cfg;
      cfg = { ...cfg, ...next };
      // Only a real geometry change restarts tracking; ids stay globally unique across it.
      const geometry = !sameTable(old.table, cfg.table) || !sameCorners(old.manualCorners, cfg.manualCorners) || !!old.swapAxes !== !!cfg.swapAxes;
      if (geometry) {
        tracker = createTracker({ ballRadius: cfg.table.ballRadius, firstId: tracker.nextId() });
        lastCal = null;
      }
    },
    reset(): void {
      tracker.reset();
      cloth = null;
      candidate = null;
      candidateFrames = 0;
      lastCal = null;
    },
    process(frame: Frame): VisionResult {
      const t0 = performance.now();
      if (!scratch || scratch.w !== frame.width || scratch.h !== frame.height) scratch = createTableScratch(frame.width, frame.height);
      const diag = Math.hypot(frame.width, frame.height);
      const det = accept(detectTable(frame, scratch, cloth));
      const manual = manualOf(cfg.manualCorners);
      // Manual corners where the automatic search found no cloth: learn the cloth inside the tapped quad
      // (detectTable has already filled the scratch HSV planes for this frame).
      if (!cloth && manual) cloth = learnClothInQuad(scratch, manual);
      const autoQuad = det && det.quality >= MIN_TABLE_QUALITY ? det.corners : null;
      const rawCorners = manual ?? autoQuad;
      // Corners first, so calibration uses the smoothed quad.
      const pre = tracker.updateCorners(rawCorners, diag);
      if (pre.status === 'searching') lastCal = null;
      let calibration: Calibration | null = null;
      let balls: TrackedBall[] = [];
      if (rawCorners && pre.corners && cloth) {
        calibration = calibrationFromCorners(pre.corners, cfg.table, frame.width, frame.height, {
          fovDeg: usableFovDeg(cfg.fovDeg),
          swapAxes: cfg.swapAxes ?? false,
          source: manual ? 'manual' : 'auto',
          ...(lastCal ? { prev: lastCal.corners } : {}),
        });
        if (calibration) {
          lastCal = calibration;
          const dets = detectBalls(frame, calibration, cfg.table, cloth);
          balls = separateBalls(tracker.updateBalls(dets), cfg.table);
        }
      }
      let status: LockStatus = pre.status;
      let quality = det?.quality ?? 0;
      let reason: VisionResult['reason'];
      if (manual) {
        if (!cloth || !calibration) {
          status = 'searching';
          quality = 0;
          reason = cloth ? 'bad-quad' : 'cloth-unknown';
        } else {
          // How much of the tapped quad is cloth, and — when the automatic detector confidently sees
          // the table this frame — how close its corners are to the taps. A quad that slid along the
          // cloth keeps a high coverage; the corner agreement catches it.
          const coverage = clothCoverageInQuad(scratch, manual, cloth);
          const agreement =
            det && det.quality >= MANUAL_DISAGREE_QUALITY ? Math.max(0, 1 - ((1 - MANUAL_LOCK_QUALITY) * cornerGap(manual, det.corners)) / (MANUAL_DISAGREE_GAP * diag)) : 1;
          quality = Math.min(coverage, agreement);
          status = quality >= MANUAL_LOCK_QUALITY ? 'locked' : 'unstable';
          if (status !== 'locked') reason = 'moved';
        }
      }
      return {
        status,
        calibration,
        balls,
        quality,
        cloth,
        ms: performance.now() - t0,
        ...(reason ? { reason } : {}),
      };
    },
  };
}
