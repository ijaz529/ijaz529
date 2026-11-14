/**
 * Shot playback (pure): turns recorded simulator trajectories (polylines + timed events) into
 * time-parameterised tracks and samples position + orientation for any time.
 *
 * Timing: every recorded point that coincides with a simulator event gets that event's exact time.
 * Points in between are distributed by distance assuming a constant deceleration (the ball slows
 * between events; a span that ends the motion ends at zero speed, i.e. an ease-out). Spans with no
 * time information at all fall back to distance with an ease-out.
 *
 * Rotation: when the simulator recorded each point's time and angular velocity ω (planShot does),
 * the ball turns by ω·Δt over each recorded span, so a draw shot visibly slides with backspin and a
 * stun shot skids without turning, exactly as simulated. Without that record (hand-built tracks),
 * balls roll without slipping: a displacement d turns the ball by |d|/R about ẑ × d̂ (the contact
 * point is instantaneously at rest). Orientations are accumulated per point, so the result is
 * independent of the frame rate.
 */
import type { PocketId, SimEvent, Trajectory, Vec2 } from '../../core/types';
import { quatFromAxisAngle, quatMultiply, quatNormalize, type Quat } from './math3d';

/** ASSUMPTION: visual-only deceleration between events (rolling ≈ μr·g ≈ 0.1 m/s², sliding more). */
export const PLAYBACK_DECEL = 0.25;
/** Duration of the drop into a pocket after the ball crosses the mouth (s). */
export const POCKET_DROP_S = 0.42;
/** Gravity for the drop (m/s²). */
const G = 9.81;

export interface PlaybackTrack {
  ballId: string;
  t: Float64Array;
  x: Float64Array;
  y: Float64Array;
  /** Cumulative rolling rotation at each point (relative to the start), 4 per point. */
  q: Float64Array;
  /**
   * Rotation over the span from point i to i+1 as axis (x, y, z) + angle, 4 per span, when the
   * trajectory recorded ω; sampling inside a span applies a fraction of it. Null = rolling.
   */
  span: Float64Array | null;
  start: number;
  /** Time the ball stops or enters the pocket mouth. */
  end: number;
  pocket: { id: PocketId | null; x: number; y: number; depth: number } | null;
}

export interface BallPose {
  x: number;
  y: number;
  /** Height of the ball centre above the bed. */
  z: number;
  /** Rolling rotation relative to the start orientation (apply as q ⊗ q0). */
  q: Quat;
  visible: boolean;
}

/** Rotation that rolls a ball of radius R without slipping through displacement (dx, dy). */
export function rollingQuat(dx: number, dy: number, R: number): Quat {
  const d = Math.hypot(dx, dy);
  if (d < 1e-12) return [0, 0, 0, 1];
  // axis = ẑ × d̂ = (−dy, dx, 0)/|d|
  return quatFromAxisAngle([-dy / d, dx / d, 0], d / R);
}

/** Rotation by angular velocity ω (rad/s, world frame) held for dt seconds. */
export function spinQuat(wx: number, wy: number, wz: number, dt: number): Quat {
  const w = Math.hypot(wx, wy, wz);
  if (w < 1e-12 || dt <= 0) return [0, 0, 0, 1];
  return quatFromAxisAngle([wx / w, wy / w, wz / w], w * dt);
}

/** Apply a rolling displacement to an orientation (world-frame rotation, so it pre-multiplies). */
export function rollBall(q: Quat, dx: number, dy: number, R: number): Quat {
  return quatNormalize(quatMultiply(rollingQuat(dx, dy, R), q));
}

function samePoint(a: Vec2, b: Vec2): boolean {
  return Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9;
}

/**
 * Times for each recorded point. Event points get the event time; the first point is t = 0 unless
 * an event says otherwise; the rest are distributed by distance with constant deceleration.
 */
export function assignTimes(points: Vec2[], events: SimEvent[], decel = PLAYBACK_DECEL): Float64Array {
  const n = points.length;
  const t = new Float64Array(n).fill(NaN);
  if (n === 0) return t;
  // Match events to points in order (the simulator pushes the event position as a point).
  let k = 0;
  for (const e of events) {
    for (let i = k; i < n; i++)
      if (samePoint(points[i]!, e.pos)) {
        // Several events can share a point (e.g. a ball struck from rest): keep the latest time on
        // the later duplicate and let the earlier one hold the ball still.
        t[i] = Number.isNaN(t[i]!) ? e.t : Math.max(t[i]!, e.t);
        k = i;
        break;
      }
  }
  if (Number.isNaN(t[0]!)) t[0] = 0;
  // Cumulative distance.
  const s = new Float64Array(n);
  for (let i = 1; i < n; i++) s[i] = s[i - 1]! + Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
  const endsMotion = events.length > 0 && events[events.length - 1]!.kind === 'stop';
  // Unknown final time: decelerate to rest from the last known time.
  let lastKnown = 0;
  for (let i = 0; i < n; i++) if (!Number.isNaN(t[i]!)) lastKnown = i;
  if (lastKnown < n - 1) {
    const S = s[n - 1]! - s[lastKnown]!;
    // Speed estimate from the previous timed span, else from the deceleration alone.
    let v = Math.sqrt(2 * decel * S);
    for (let i = lastKnown - 1; i >= 0; i--)
      if (!Number.isNaN(t[i]!) && t[lastKnown]! - t[i]! > 1e-6) {
        v = Math.max(v, (s[lastKnown]! - s[i]!) / (t[lastKnown]! - t[i]!));
        break;
      }
    t[n - 1] = t[lastKnown]! + (v > 1e-9 ? (2 * S) / v : 0);
  }
  // Fill every span between consecutive known times.
  let i0 = 0;
  for (let i1 = 1; i1 < n; i1++) {
    if (Number.isNaN(t[i1]!)) continue;
    const T = Math.max(0, t[i1]! - t[i0]!);
    t[i1] = t[i0]! + T;
    const S = s[i1]! - s[i0]!;
    if (i1 - i0 > 1) {
      const last = i1 === n - 1;
      let a: number;
      if (S < 1e-12 || T < 1e-12) a = 0;
      else if (last && (endsMotion || lastKnown < n - 1)) a = (2 * S) / (T * T); // comes to rest
      else a = Math.min(decel, (2 * S) / (T * T));
      const v0 = T > 0 ? S / T + (a * T) / 2 : 0;
      for (let i = i0 + 1; i < i1; i++) {
        const ds = s[i]! - s[i0]!;
        let tau: number;
        if (S < 1e-12) tau = (T * (i - i0)) / (i1 - i0);
        else if (a < 1e-9) tau = v0 > 0 ? ds / v0 : 0;
        else tau = (v0 - Math.sqrt(Math.max(0, v0 * v0 - 2 * a * ds))) / a;
        t[i] = t[i0]! + Math.min(T, Math.max(0, tau));
      }
    }
    i0 = i1;
  }
  // Monotone guard.
  for (let i = 1; i < n; i++) if (t[i]! < t[i - 1]!) t[i] = t[i - 1]!;
  return t;
}

export interface TrackOpts {
  decel?: number;
  /** Pocket drop centres, used to animate pocketed balls falling in. */
  holes?: Partial<Record<PocketId, { x: number; y: number }>>;
  /** Depth below the bed a pocketed ball comes to rest at (m). */
  pocketDepth?: number;
}

export function buildTrack(tr: Trajectory, R: number, opts: TrackOpts = {}): PlaybackTrack {
  const pts = tr.points.length > 0 ? tr.points : tr.rest ? [tr.rest] : [];
  const n = pts.length;
  const t = assignTimes(pts, tr.events, opts.decel);
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const q = new Float64Array(4 * n);
  // Recorded spin: ω at the start of each span (the state after any event there) times its duration.
  const spins = tr.spins && tr.times && tr.spins.length === n && tr.times.length === n && tr.points.length === n ? tr.spins : null;
  const span = spins ? new Float64Array(4 * Math.max(0, n - 1)) : null;
  let cur: Quat = [0, 0, 0, 1];
  for (let i = 0; i < n; i++) {
    x[i] = pts[i]!.x;
    y[i] = pts[i]!.y;
    if (i > 0) {
      if (spins && span) {
        const w = spins[i - 1]!;
        const dt = Math.max(0, tr.times![i]! - tr.times![i - 1]!);
        const m = Math.hypot(w.x, w.y, w.z);
        if (m > 1e-12) span.set([w.x / m, w.y / m, w.z / m, m * dt], 4 * (i - 1));
        cur = quatNormalize(quatMultiply(spinQuat(w.x, w.y, w.z, dt), cur));
      } else cur = rollBall(cur, x[i]! - x[i - 1]!, y[i]! - y[i - 1]!, R);
    }
    q.set(cur, 4 * i);
  }
  let start = 0;
  for (let i = 1; i < n; i++)
    if (x[i] !== x[0] || y[i] !== y[0]) {
      start = t[i - 1]!;
      break;
    }
  const end = n > 0 ? t[n - 1]! : 0;
  let pocket: PlaybackTrack['pocket'] = null;
  if (tr.pocket || tr.events.some((e) => e.kind === 'pocket')) {
    const id = tr.pocket ?? (tr.events.find((e) => e.kind === 'pocket')?.otherId as PocketId | undefined) ?? null;
    const h = id ? opts.holes?.[id] : undefined;
    const lx = n > 0 ? x[n - 1]! : 0;
    const ly = n > 0 ? y[n - 1]! : 0;
    pocket = { id, x: h?.x ?? lx, y: h?.y ?? ly, depth: opts.pocketDepth ?? 0.09 };
  }
  return { ballId: tr.ballId, t, x, y, q, span, start, end, pocket };
}

/** Time at which the track's animation (including a pocket drop) is complete. */
export function trackFinish(tr: PlaybackTrack): number {
  return tr.end + (tr.pocket ? POCKET_DROP_S : 0);
}

/** Pose at time `time` (seconds of simulated time). Writes into `out` and returns it. */
export function sampleTrack(tr: PlaybackTrack, time: number, R: number, out: BallPose): BallPose {
  const n = tr.t.length;
  out.visible = true;
  out.z = R;
  if (n === 0) {
    out.x = 0;
    out.y = 0;
    out.q = [0, 0, 0, 1];
    return out;
  }
  if (time <= tr.t[0]!) return setPoint(tr, 0, out);
  if (time >= tr.end) {
    setPoint(tr, n - 1, out);
    if (tr.pocket) {
      const u = Math.min(1, (time - tr.end) / POCKET_DROP_S);
      const e = 1 - (1 - u) * (1 - u);
      const dx = (tr.pocket.x - out.x) * e;
      const dy = (tr.pocket.y - out.y) * e;
      out.q = rollBall(out.q, dx, dy, R);
      out.x += dx;
      out.y += dy;
      const fall = 0.5 * G * Math.pow(u * POCKET_DROP_S, 2);
      out.z = Math.max(R - tr.pocket.depth - R, R - fall);
    }
    return out;
  }
  // Binary search the segment [k, k+1] containing `time`.
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (tr.t[mid]! <= time) lo = mid;
    else hi = mid;
  }
  const t0 = tr.t[lo]!;
  const t1 = tr.t[hi]!;
  const f = t1 > t0 ? (time - t0) / (t1 - t0) : 1;
  setPoint(tr, lo, out);
  const dx = (tr.x[hi]! - tr.x[lo]!) * f;
  const dy = (tr.y[hi]! - tr.y[lo]!) * f;
  if (tr.span) {
    const k = 4 * lo;
    const ang = tr.span[k + 3]! * f;
    if (ang > 0) out.q = quatNormalize(quatMultiply(quatFromAxisAngle([tr.span[k]!, tr.span[k + 1]!, tr.span[k + 2]!], ang), out.q));
  } else out.q = rollBall(out.q, dx, dy, R);
  out.x += dx;
  out.y += dy;
  return out;
}

function setPoint(tr: PlaybackTrack, i: number, out: BallPose): BallPose {
  out.x = tr.x[i]!;
  out.y = tr.y[i]!;
  out.q = [tr.q[4 * i]!, tr.q[4 * i + 1]!, tr.q[4 * i + 2]!, tr.q[4 * i + 3]!];
  return out;
}

export interface Timeline {
  /** Simulated seconds until every ball has stopped (or dropped). */
  simEnd: number;
  /** Simulated seconds per real second (≥ 1; > 1 only when the shot would exceed the cap). */
  rate: number;
  /** Real seconds the ball motion takes. */
  duration: number;
}

/** Real-time (×1) playback, sped up uniformly only when it would take longer than `capS`. */
export function playbackTimeline(tracks: PlaybackTrack[], capS = 4): Timeline {
  let simEnd = 0;
  for (const tr of tracks) simEnd = Math.max(simEnd, trackFinish(tr));
  const rate = simEnd > capS ? simEnd / capS : 1;
  return { simEnd, rate, duration: simEnd / rate };
}
