/**
 * Temporal smoothing + association of detections, and the table lock state machine
 * (data-model.md): searching → unstable → locked (5 calm frames) ; big jump → unstable ;
 * 10 frames without a quad → searching.
 */
import type { Vec2 } from '../core/vec';
import type { DetectedBall } from './ball-detect';

export type LockStatus = 'searching' | 'unstable' | 'locked';

export interface TrackedBall {
  id: string;
  pos: Vec2;
  image: Vec2;
  isCue: boolean;
  label: string;
  rgb: [number, number, number];
  confidence: number;
}

export interface TrackerOptions {
  ballRadius: number;
  alpha?: number;
  confirmHits?: number;
  maxMisses?: number;
  lockFrames?: number;
  lockMotion?: number;
  lostFrames?: number;
}

interface Track {
  id: number;
  pos: Vec2;
  image: Vec2;
  hits: number;
  misses: number;
  cueVote: number;
  label: string;
  rgb: [number, number, number];
}

export interface TrackerUpdate {
  corners: Vec2[] | null;
  balls: DetectedBall[] | null;
  diag: number;
}

export interface TrackerState {
  status: LockStatus;
  corners: Vec2[] | null;
  balls: TrackedBall[];
}

export function createTracker(opts: TrackerOptions) {
  const alpha = opts.alpha ?? 0.5;
  const confirmHits = opts.confirmHits ?? 2;
  const maxMisses = opts.maxMisses ?? 4;
  const lockFrames = opts.lockFrames ?? 5;
  const lockMotion = opts.lockMotion ?? 0.015;
  const lostFrames = opts.lostFrames ?? 10;
  const matchDist = 3 * opts.ballRadius;

  let status: LockStatus = 'searching';
  let corners: Vec2[] | null = null;
  let calm = 0;
  let missing = 0;
  let tracks: Track[] = [];
  let nextId = 1;

  function updateCorners(c: Vec2[] | null, diag: number): void {
    if (!c) {
      missing++;
      calm = 0;
      if (missing >= lostFrames) {
        status = 'searching';
        corners = null;
      } else if (status === 'locked') status = 'unstable';
      return;
    }
    missing = 0;
    if (!corners) {
      corners = c.map((p) => ({ ...p }));
      calm = 0;
      status = 'unstable';
      return;
    }
    // Match by nearest (the detector's corner order may rotate between frames).
    const matched = corners.map((p) => c.reduce((a, b) => (Math.hypot(b.x - p.x, b.y - p.y) < Math.hypot(a.x - p.x, a.y - p.y) ? b : a)));
    const motion = Math.max(...corners.map((p, i) => Math.hypot(matched[i]!.x - p.x, matched[i]!.y - p.y))) / diag;
    if (motion > lockMotion * 4) {
      corners = c.map((p) => ({ ...p }));
      calm = 0;
      status = 'unstable';
      return;
    }
    corners = corners.map((p, i) => ({ x: p.x + alpha * (matched[i]!.x - p.x), y: p.y + alpha * (matched[i]!.y - p.y) }));
    calm = motion < lockMotion ? calm + 1 : 0;
    status = calm >= lockFrames ? 'locked' : 'unstable';
  }

  function updateBalls(dets: DetectedBall[]): void {
    const pairs: { t: number; d: number; dist: number }[] = [];
    tracks.forEach((tr, ti) =>
      dets.forEach((dt, di) => {
        const dist = Math.hypot(tr.pos.x - dt.pos.x, tr.pos.y - dt.pos.y);
        if (dist < matchDist) pairs.push({ t: ti, d: di, dist });
      }),
    );
    pairs.sort((a, b) => a.dist - b.dist);
    const usedT = new Set<number>();
    const usedD = new Set<number>();
    for (const p of pairs) {
      if (usedT.has(p.t) || usedD.has(p.d)) continue;
      usedT.add(p.t);
      usedD.add(p.d);
      const tr = tracks[p.t]!;
      const dt = dets[p.d]!;
      tr.pos = { x: tr.pos.x + alpha * (dt.pos.x - tr.pos.x), y: tr.pos.y + alpha * (dt.pos.y - tr.pos.y) };
      tr.image = dt.image;
      tr.hits++;
      tr.misses = 0;
      tr.cueVote += 0.4 * ((dt.isCue ? 1 : 0) - tr.cueVote);
      tr.label = dt.label;
      tr.rgb = dt.rgb;
    }
    tracks.forEach((tr, i) => {
      if (!usedT.has(i)) tr.misses++;
    });
    tracks = tracks.filter((t) => t.misses <= maxMisses);
    dets.forEach((dt, i) => {
      if (usedD.has(i)) return;
      tracks.push({ id: nextId++, pos: dt.pos, image: dt.image, hits: 1, misses: 0, cueVote: dt.isCue ? 1 : 0, label: dt.label, rgb: dt.rgb });
    });
  }

  function output(): TrackedBall[] {
    const live = tracks.filter((t) => t.hits >= confirmHits && t.misses === 0);
    let cue: Track | null = null;
    for (const t of live) if (t.cueVote > 0.5 && (!cue || t.cueVote > cue.cueVote)) cue = t;
    return live.map((t) => ({
      id: t === cue ? 'cue' : `b${t.id}`,
      pos: t.pos,
      image: t.image,
      isCue: t === cue,
      label: t === cue ? 'cue' : t.label,
      rgb: t.rgb,
      confidence: Math.min(1, t.hits / 5),
    }));
  }

  return {
    /** Feed this frame's quad (or null). */
    updateCorners(c: Vec2[] | null, diag: number): { status: LockStatus; corners: Vec2[] | null } {
      updateCorners(c, diag);
      return { status, corners };
    },
    /** Feed this frame's ball detections. */
    updateBalls(dets: DetectedBall[]): TrackedBall[] {
      updateBalls(dets);
      return output();
    },
    /** Convenience: corners then balls for one frame. */
    update(u: TrackerUpdate): TrackerState {
      updateCorners(u.corners, u.diag);
      if (u.balls) updateBalls(u.balls);
      return { status, corners, balls: output() };
    },
    reset(): void {
      status = 'searching';
      corners = null;
      calm = 0;
      missing = 0;
      tracks = [];
    },
  };
}
