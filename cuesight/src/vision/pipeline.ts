/**
 * Per-frame vision pipeline: table detection (or manual corners) → tracker-smoothed corners →
 * calibration → ball detection → tracked layout.
 *
 * Honesty rules (Constitution II):
 *  - a frame without a usable quad reports no calibration and no balls (the tracker keeps its state
 *    for re-association, but nothing stale is drawn);
 *  - an automatic quad must reach MIN_TABLE_QUALITY to count;
 *  - once a table is locked, its outline is the anchor: while the cloth still ends where it did along
 *    the anchor's sides (the camera has not moved), a quad elsewhere — a fragment of the table left by
 *    an arm or a person, or an object of another colour — is an occlusion, not a new table: that
 *    frame has no quad, and no new cloth colour is adopted;
 *  - manual corners are 'locked' only while the tapped quad is still mostly cloth and the cloth edges
 *    near its sides are where they were when the corners were set (the phone has not moved);
 *    otherwise 'unstable' / 'searching' with a reason;
 *  - a new cloth colour must persist for several frames before it replaces the established one, and
 *    then the lock starts over.
 */
import type { TableSpec } from '../core/types';
import type { Vec2 } from '../core/vec';
import { detectBalls } from './ball-detect';
import { calibrationFromCorners, usableFovDeg, type Calibration } from './calibration';
import { hueDiff, type Frame } from './image';
import {
  clothCoverageInQuad,
  compareEdgeProfiles,
  createTableScratch,
  detectTable,
  EDGE_PROFILE_SAMPLES,
  HUE_TOL,
  learnClothInQuad,
  MIN_TABLE_QUALITY,
  quadEdgeProfile,
  type ClothModel,
  type EdgeMatch,
  type TableDetection,
  type TableScratch,
} from './table-detect';
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
   * longer matches the cloth (the phone moved since the corners were set).
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
/** Manual quad: minimum quality for 'locked' (share of cloth inside it, and edge alignment below). */
const MANUAL_LOCK_QUALITY = 0.8;
/**
 * Edge profiles (table-detect quadEdgeProfile): search band and match tolerance, as fractions of the
 * image diagonal. ASSUMPTIONS: the band covers a tapped side up to 5 % of the diagonal off the real
 * edge (finger error σ ≈ 12 px on a 640 px frame stays inside it); an edge within 0.6 % (≈ 5 px) of
 * where it was has not moved — sensor noise and hand tremor move a cloth edge 1-2 px, while a 4 cm
 * shift or a 1° turn of the phone moves it ≈ 7-10 px at a 2.5 m viewing distance.
 */
const EDGE_BAND = 0.05;
const EDGE_TOL = 0.006;
/**
 * Corner gap (fraction of the diagonal) beyond which an automatic quad is not the anchored table seen
 * again (2 × the SC-003 outline tolerance); smaller gaps are ordinary tracking.
 */
const ANCHOR_GAP = 0.03;

/**
 * The anchored table is still where it was (the camera has not moved): enough of its sides still end
 * at the same place (≥ 20 % of the samples with an edge, at least 6), and almost none end somewhere
 * else (≤ 10 %, at most 3 when fewer are known). An occluder hides cloth edges (lost samples) but does
 * not move them; a camera move moves them — inward, or outward where it shows cloth past the old
 * outline — even along the sides it does not cross.
 * ASSUMPTION (synthetic side, corner and end views; see pipeline-live.test.ts): a torso, an arm or a
 * block over half the table leaves 48-81 % of the 64 samples matched and at most 1 moved; camera moves
 * of 0.1-0.3 m, raising the phone 0.3 m or rolling it 4° move 16-49 samples.
 */
function inPlace(m: EdgeMatch): boolean {
  return m.matched >= Math.max(6, 0.2 * m.known) && m.inward + m.outward <= Math.max(3, 0.1 * m.known);
}

/**
 * Share of a manual quad's edge samples that still match. Lost samples (an arm over a rail) count
 * against it only when they are more than half.
 */
function alignment(m: EdgeMatch): number {
  return m.matched / Math.max(1, m.matched + m.inward + m.outward, 0.5 * m.known);
}

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

/** Largest distance from a corner of `a` to the nearest corner of `b` (px). */
function cornerGap(a: Vec2[], b: Vec2[]): number {
  return Math.max(...a.map((m) => Math.min(...b.map((d) => Math.hypot(d.x - m.x, d.y - m.y)))));
}

/** A table outline with the cloth-edge profile it had when it was set (see inPlace). */
interface Anchor {
  quad: Vec2[];
  cloth: ClothModel;
  ref: Float64Array;
}

/** Pairs closer than 2R − SEPARATION_TOL (m) still count as overlapping (the planner already fails at 0.3 mm of overlap). */
const SEPARATION_TOL = 1e-8;
/** Relaxation passes before giving up (n ≤ 22 balls: at most ≈ 23 000 pair checks, well under 1 ms). */
const SEPARATION_MAX_PASSES = 100;

/**
 * Enforce the 2R separation and the cushion limits promised by data-model.md on the reported balls
 * (copies; track state is untouched). Detections of frozen balls are biased toward each other, and the
 * planner fails on overlaps as small as 0.3 mm, so this runs to convergence (Gauss-Seidel relaxation):
 * each overlapping pair is set to exactly 2R along its line of centres, half the correction to each
 * ball; a ball held by a cushion (positions are clamped to |x| ≤ L/2 − R, |y| ≤ W/2 − R after every
 * move) passes what it cannot take to the other. Coincident detections separate along the line from
 * the table centre, the inner one moving inward. Passes repeat until no pair overlaps by more than
 * SEPARATION_TOL, at most SEPARATION_MAX_PASSES times (a 15-ball rack needs ≈ 20, a row of six
 * frozen balls ≈ 30).
 */
export function separateBalls(balls: TrackedBall[], table: TableSpec): TrackedBall[] {
  const R = table.ballRadius;
  const D = 2 * R;
  const xMax = table.length / 2 - R;
  const yMax = table.width / 2 - R;
  const clamp = (v: number, m: number) => (v > m ? m : v < -m ? -m : v);
  const out = balls.map((b) => ({ ...b, pos: { x: clamp(b.pos.x, xMax), y: clamp(b.pos.y, yMax) } }));
  /** Move p by (dx, dy), clamped to the cushion limits. */
  const move = (p: Vec2, dx: number, dy: number) => {
    p.x = clamp(p.x + dx, xMax);
    p.y = clamp(p.y + dy, yMax);
  };
  for (let pass = 0; pass < SEPARATION_MAX_PASSES; pass++) {
    let worst = 0;
    for (let i = 0; i < out.length; i++)
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i]!.pos;
        const b = out[j]!.pos;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d = Math.hypot(dx, dy);
        if (d >= D - SEPARATION_TOL) continue;
        worst = Math.max(worst, D - d);
        if (d < 1e-9) {
          // Coincident: b outward from the table centre, a inward (any line would do; this one keeps
          // balls in a corner or on a cushion off the rail).
          const r = Math.hypot(a.x, a.y);
          dx = r > 1e-9 ? a.x / r : 1;
          dy = r > 1e-9 ? a.y / r : 0;
          d = 1;
        }
        const ux = dx / d;
        const uy = dy / d;
        const gap0 = D - Math.hypot(b.x - a.x, b.y - a.y);
        move(a, (-ux * gap0) / 2, (-uy * gap0) / 2);
        // What a could not take (a cushion), b takes; and what b cannot take goes back to a.
        let gap = D - ((b.x - a.x) * ux + (b.y - a.y) * uy);
        if (gap > 0) move(b, ux * gap, uy * gap);
        gap = D - ((b.x - a.x) * ux + (b.y - a.y) * uy);
        if (gap > 0) move(a, -ux * gap, -uy * gap);
      }
    if (worst <= SEPARATION_TOL) break;
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
  /**
   * Automatic mode: the last locked outline, refreshed on every locked frame. Manual mode: the tapped
   * quad with the cloth edges it had on its first calibrated frame (never refreshed: the taps belong
   * to that view). Cleared when the lock starts over for a new table or new corners.
   */
  let anchor: Anchor | null = null;
  const nowProfile = new Float64Array(4 * EDGE_PROFILE_SAMPLES);
  /** This frame's anchor evidence (computed at most once per frame). */
  let evidence: EdgeMatch | null = null;

  function newAnchor(sc: TableScratch, quad: Vec2[], c: ClothModel, diag: number): Anchor {
    const ref = new Float64Array(4 * EDGE_PROFILE_SAMPLES);
    quadEdgeProfile(sc, quad, c, EDGE_BAND * diag, ref);
    return { quad: quad.map((p) => ({ x: p.x, y: p.y })), cloth: c, ref };
  }

  /** Where the anchor's cloth edges are this frame, compared with where they were. */
  function anchorEvidence(sc: TableScratch, diag: number): EdgeMatch | null {
    if (!anchor) return null;
    if (!evidence) {
      quadEdgeProfile(sc, anchor.quad, anchor.cloth, EDGE_BAND * diag, nowProfile);
      evidence = compareEdgeProfiles(anchor.ref, nowProfile, Math.max(2, EDGE_TOL * diag));
    }
    return evidence;
  }

  /**
   * Cloth hysteresis: a detection made with a new cloth colour counts only once that colour persists,
   * and only once the anchored table has left its place (an object of another colour lying on the
   * table, or held in front of it, is not a new table).
   */
  function accept(det: TableDetection | null, sc: TableScratch, diag: number, manual: boolean): TableDetection | null {
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
    const ev = anchorEvidence(sc, diag);
    if (ev && inPlace(ev)) return null;
    // The scene really changed colour: adopt it, and make the new table hypothesis earn its lock.
    cloth = det.cloth;
    candidate = null;
    candidateFrames = 0;
    tracker.resetLock();
    lastCal = null;
    // A manual anchor stays: its edges were measured with the old cloth, so the taps now read 'moved'.
    if (!manual) anchor = null;
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
        anchor = null;
      }
    },
    reset(): void {
      tracker.reset();
      cloth = null;
      candidate = null;
      candidateFrames = 0;
      lastCal = null;
      anchor = null;
    },
    process(frame: Frame): VisionResult {
      const t0 = performance.now();
      if (!scratch || scratch.w !== frame.width || scratch.h !== frame.height) scratch = createTableScratch(frame.width, frame.height);
      const sc = scratch;
      const diag = Math.hypot(frame.width, frame.height);
      const manual = manualOf(cfg.manualCorners);
      evidence = null;
      let found = detectTable(frame, sc, cloth);
      // Automatic mode: a quad away from the anchored table (or in another colour) while that table's
      // cloth still ends where it did is an occlusion, not a new table; otherwise the table has moved
      // and the anchor no longer applies.
      if (!manual && anchor && found && (!sameCloth(found.cloth, anchor.cloth) || cornerGap(anchor.quad, found.corners) > ANCHOR_GAP * diag)) {
        if (inPlace(anchorEvidence(sc, diag)!)) found = null;
        else anchor = null;
      }
      const det = accept(found, sc, diag, !!manual);
      // Manual corners where the automatic search found no cloth: learn the cloth inside the tapped quad
      // (detectTable has already filled the scratch HSV planes for this frame).
      if (!cloth && manual) cloth = learnClothInQuad(sc, manual);
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
      if (!manual) {
        // The locked outline (and where its cloth ends now) is the anchor for the next frames.
        if (status === 'locked' && calibration && pre.corners && cloth) {
          if (anchor && anchor.cloth === cloth) {
            for (let k = 0; k < 4; k++) anchor.quad[k] = { x: pre.corners[k]!.x, y: pre.corners[k]!.y };
            quadEdgeProfile(sc, anchor.quad, cloth, EDGE_BAND * diag, anchor.ref);
          } else anchor = newAnchor(sc, pre.corners, cloth, diag);
        }
      } else if (!cloth || !calibration) {
        status = 'searching';
        quality = 0;
        reason = cloth ? 'bad-quad' : 'cloth-unknown';
      } else {
        // How much of the tapped quad is cloth, and whether the cloth still ends where it did along the
        // tapped sides when the corners were set (relative, so finger error in the taps does not count;
        // a phone that moved shifts the edges, whether or not the automatic detector sees the table).
        if (!anchor) anchor = newAnchor(sc, manual, cloth, diag);
        const coverage = clothCoverageInQuad(sc, manual, cloth);
        quality = Math.min(coverage, alignment(anchorEvidence(sc, diag)!));
        status = quality >= MANUAL_LOCK_QUALITY ? 'locked' : 'unstable';
        if (status !== 'locked') reason = 'moved';
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
