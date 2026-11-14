/**
 * Pure decisions of the Live camera session (no DOM, no workers), unit-tested in
 * tests/unit/app/live-logic.test.ts: when the live plan may be drawn, how a selection survives
 * tracker id churn, what the status pill and hints say, manual-calibration feedback, and the start mode.
 */
import type { Ball, TableLayout, Vec2 } from '../core/types';
import { applyH, homographyFrom4, invert3 } from '../vision/homography';
import type { LockStatus } from '../vision/tracker';
import type { Settings } from './settings';
import type { AppState, Interaction, Mode, SelectionMemory } from './store';

// --- Settings ------------------------------------------------------------------------------------

/** The table preset or cushion width changed: the table geometry (and the practice layout) changes. */
export function tableSettingsChanged(a: Settings, b: Settings): boolean {
  return a.table !== b.table || a.cushionWidthCm !== b.cushionWidthCm;
}

/**
 * Whether saving `b` over `a` must reconfigure the vision worker. Every `config` message rebuilds the
 * tracker (new ball ids), so it is sent only for the settings vision actually uses.
 */
export function visionConfigChanged(a: Settings, b: Settings): boolean {
  return tableSettingsChanged(a, b) || a.fovDeg !== b.fovDeg;
}

// --- Selection that survives tracker id churn ----------------------------------------------------

export interface RebindOptions {
  /** Ids that were already being tracked: an established neighbour is not the lost ball coming back. */
  known?: ReadonlySet<string>;
  /** Ids that may not be taken (e.g. the other selection). */
  exclude?: readonly (string | null | undefined)[];
  /** The marked cue ball may re-bind to a ball the detector calls the cue; a target may not. */
  allowCue?: boolean;
  /** Search radius (default 2R). */
  maxDist?: number;
}

/** The new id of a lost selection: the nearest new track within 2R of where it was, preferring its label. */
export function rebindSelection(last: SelectionMemory, balls: readonly Ball[], R: number, opts: RebindOptions = {}): string | null {
  let best: { id: string; d: number; same: boolean } | null = null;
  const maxDist = opts.maxDist ?? 2 * R;
  for (const b of balls) {
    if (b.id === last.id || opts.known?.has(b.id) || opts.exclude?.includes(b.id)) continue;
    if (b.kind === 'cue' && !opts.allowCue) continue;
    const d = Math.hypot(b.pos.x - last.pos.x, b.pos.y - last.pos.y);
    if (d >= maxDist) continue;
    const same = !!last.label && b.label === last.label;
    if (!best || (same && !best.same) || (same === best.same && d < best.d)) best = { id: b.id, d, same };
  }
  return best?.id ?? null;
}

/**
 * One vision result for one selection: follows the id while it lives (refreshing where it is), and
 * re-binds it when the id disappears and a new track shows up at the same spot. Otherwise the id is
 * kept (the ball may be occluded for a moment) together with the last known position.
 */
export function trackSelection(
  id: string | null,
  mem: SelectionMemory | null,
  prev: readonly Ball[] | undefined,
  next: readonly Ball[],
  R: number,
  opts: Omit<RebindOptions, 'known'> = {},
): { id: string | null; mem: SelectionMemory | null; rebound: boolean } {
  if (!id) return { id: null, mem: null, rebound: false };
  let m = mem && mem.id === id ? mem : null;
  if (!m) {
    const p = prev?.find((b) => b.id === id);
    if (p) m = { id, pos: p.pos, ...(p.label ? { label: p.label } : {}) };
  }
  const now = next.find((b) => b.id === id);
  if (now) return { id, mem: { id, pos: now.pos, ...(now.label ? { label: now.label } : (m?.label ? { label: m.label } : {})) }, rebound: false };
  if (!m) return { id, mem: null, rebound: false };
  const nid = rebindSelection(m, next, R, { ...opts, known: new Set((prev ?? []).map((b) => b.id)) });
  if (!nid) return { id, mem: m, rebound: false };
  const b = next.find((x) => x.id === nid)!;
  return { id: nid, mem: { id: nid, pos: b.pos, ...(b.label ? { label: b.label } : {}) }, rebound: true };
}

/**
 * Going live again in the same table frame: the selection made on the snapshot is carried over to
 * the live tracks. A ball whose id is gone (re-issued while frozen) is matched to the live ball within
 * one radius of where the snapshot had it; otherwise the id waits with that position.
 */
export function unfreezeSelection(s: Pick<AppState, 'targetId' | 'targetMem' | 'cueOverrideId' | 'cueMem' | 'vision'>, snapshot: TableLayout, R: number): void {
  const live = s.vision?.balls ?? [];
  const carry = (id: string | null, other: string | null, allowCue: boolean): { id: string | null; mem: SelectionMemory | null } => {
    if (!id) return { id: null, mem: null };
    const now = live.find((b) => b.id === id);
    if (now) return { id, mem: { id, pos: now.pos, ...(now.label ? { label: now.label } : {}) } };
    const was = snapshot.balls.find((b) => b.id === id);
    if (!was) return { id, mem: null };
    const mem: SelectionMemory = { id, pos: was.pos, ...(was.label ? { label: was.label } : {}) };
    const nid = rebindSelection(mem, live, R, { allowCue, exclude: [other], maxDist: R });
    const b = nid ? live.find((x) => x.id === nid) : undefined;
    return b ? { id: b.id, mem: { id: b.id, pos: b.pos, ...(b.label ? { label: b.label } : {}) } } : { id, mem };
  };
  const c = carry(s.cueOverrideId, s.targetId, true);
  s.cueOverrideId = c.id;
  s.cueMem = c.mem;
  const t = carry(s.targetId, c.id, false);
  s.targetId = t.id;
  s.targetMem = t.mem;
}

type SelectionState = Pick<AppState, 'targetId' | 'pocketId' | 'landing' | 'recommended' | 'heatmap' | 'suggestions' | 'cueOverrideId' | 'targetMem' | 'cueMem' | 'interaction' | 'plan'>;

/**
 * The table frame changed (Rotate, new or cleared corners, another table): ball ids restart and
 * positions mean something else, so everything that points at a ball or a spot is dropped.
 * Returns whether anything the player had chosen was cleared.
 */
export function clearSelection(s: SelectionState): boolean {
  const had = !!(s.targetId || s.pocketId || s.landing || s.cueOverrideId || s.heatmap || s.suggestions);
  s.targetId = null;
  s.pocketId = null;
  s.landing = null;
  s.recommended = null;
  s.heatmap = null;
  s.suggestions = null;
  s.cueOverrideId = null;
  s.targetMem = null;
  s.cueMem = null;
  s.plan = null;
  if (s.interaction === 'position' || s.interaction === 'pick-next') s.interaction = 'select';
  return had;
}

// --- Frozen layout -------------------------------------------------------------------------------

/**
 * The live calibration is the frozen one's table frame: the ordered corners (table order (−x,−y),
 * (+x,−y), (+x,+y), (−x,+y)) agree one by one within `tol` of the frame diagonal. The same corners
 * in another order (Rotate, a 180° flip of the frame) do not match.
 */
export function framesMatch(a: readonly Vec2[] | null | undefined, b: readonly Vec2[] | null | undefined, diag: number, tol = 0.03): boolean {
  if (!a || !b || a.length !== 4 || b.length !== 4) return false;
  return a.every((p, i) => Math.hypot(p.x - b[i]!.x, p.y - b[i]!.y) < tol * diag);
}

/** Marks ball `id` as the cue ball (the old cue becomes an object ball, labelled "white?"). */
export function applyCueOverride(layout: TableLayout, id: string): TableLayout {
  if (!layout.balls.some((b) => b.id === id)) return { ...layout, balls: layout.balls.map((b) => ({ ...b })) };
  return {
    ...layout,
    balls: layout.balls.map((b) =>
      b.id === id ? { ...b, kind: 'cue', label: 'cue' } : b.kind === 'cue' || b.label === 'cue' ? { ...b, kind: 'object', label: b.label === 'cue' || !b.label ? 'white?' : b.label } : { ...b },
    ),
  };
}

// --- Lock gate (Constitution II: no plan on a table that is not locked) ---------------------------

/** Results after a lock during which a single missed quad does not hide the plan. */
export const LOCK_GRACE = 2;

export function nextSinceLocked(prev: number, status: LockStatus): number {
  return status === 'locked' ? 0 : prev + 1;
}

/** The live layout may be planned on and drawn: locked, or locked a result or two ago, with a calibration. */
export function liveGate(status: LockStatus, sinceLocked: number, hasCalibration: boolean): boolean {
  if (!hasCalibration) return false;
  return status === 'locked' || (status === 'unstable' && sinceLocked <= LOCK_GRACE);
}

// --- Status pill and hints -----------------------------------------------------------------------

export const STATUS_TEXT = { searching: 'Looking for the table…', unstable: 'Table found — hold steady', locked: 'Table locked' } as const;

/** The status pill's live-region text: the lock state only (no per-frame counters). */
export function pillText(status: LockStatus | null, frozen: boolean): string {
  if (frozen) return 'Frozen layout';
  return status ? STATUS_TEXT[status] : 'Starting camera…';
}

/** The pill's counters, shown next to the live region but hidden from assistive tech. */
export function pillMeta(v: { balls: readonly unknown[]; ms: number } | null, frozen: boolean): string {
  return v && !frozen ? `· ${v.balls.length} balls · ${Math.round(v.ms)} ms` : '';
}

export interface CameraHintInput {
  error: boolean;
  status: LockStatus | null;
  /** The live gate is open (or a frozen layout is shown). */
  live: boolean;
  frozen: boolean;
  /** Balls in the layout being planned on. */
  balls: number;
  hasCue: boolean;
  interaction: Interaction;
}

/** The Live-specific shot-card hint, or null to fall through to the shared hints. */
export function cameraHint(o: CameraHintInput): string | null {
  if (o.error) return 'The camera is off. Use photos (Snap) or the practice table instead.';
  if (o.interaction === 'calibrate') return 'Tap the 4 corners where the cloth meets the rails.';
  if (!o.frozen) {
    if (!o.status || o.status === 'searching') return 'Point the camera at the table so the whole cloth is in view.';
    if (!o.live) return 'Hold steady — the table isn’t locked yet.';
  }
  if (o.balls > 0 && !o.hasCue) return o.interaction === 'mark-cue' ? 'Tap the cue ball.' : 'No cue ball found — tap “Cue ball”, then tap the cue ball.';
  return null;
}

// --- Manual calibration --------------------------------------------------------------------------

export interface CalibrationVerdict {
  ok: boolean;
  /** The corners should be tapped again (manual corners dropped, calibrate mode re-entered). */
  retry: boolean;
  message: string;
}

/** A vision result, as far as the calibration feedback needs it (`reason` is optional: newer pipelines). */
export interface CalibrationResultLike {
  status: LockStatus;
  calibration: { source: 'auto' | 'manual' } | null;
  cloth: unknown;
  reason?: string;
}

export const CALIBRATION_MESSAGES = {
  ok: 'Calibrated from your four corners.',
  badQuad: 'Those corners don’t make a table — tap the 4 cloth corners again.',
  cloth: 'I couldn’t learn the cloth colour inside those corners — tap the 4 cloth corners again, or use Snap.',
  moved: 'The phone moved — tap Calibrate again or return to automatic detection.',
} as const;

/** What to tell the player about their four corners from a result computed with them; null = not decided yet. */
export function calibrationFeedback(r: CalibrationResultLike): CalibrationVerdict | null {
  const reason = typeof r.reason === 'string' ? r.reason : undefined;
  if (reason === 'bad-quad') return { ok: false, retry: true, message: CALIBRATION_MESSAGES.badQuad };
  if (reason === 'cloth-unknown' || (!r.cloth && !r.calibration)) return { ok: false, retry: true, message: CALIBRATION_MESSAGES.cloth };
  if (reason === 'moved') return { ok: false, retry: false, message: CALIBRATION_MESSAGES.moved };
  if (!r.calibration || r.status === 'searching') return { ok: false, retry: true, message: CALIBRATION_MESSAGES.badQuad };
  if (r.calibration.source === 'manual' && r.status === 'locked') return { ok: true, retry: false, message: CALIBRATION_MESSAGES.ok };
  return null;
}

/**
 * Four taps that can be the cloth corners seen by a camera: distinct (> 3 % of the frame diagonal
 * apart), a strictly convex quad in some order, covering at least 2 % of the frame.
 */
export function cornersPlausible(taps: readonly Vec2[], width: number, height: number): boolean {
  if (taps.length !== 4) return false;
  const diag = Math.hypot(width, height);
  for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) if (Math.hypot(taps[i]!.x - taps[j]!.x, taps[i]!.y - taps[j]!.y) <= 0.03 * diag) return false;
  const cx = taps.reduce((a, p) => a + p.x, 0) / 4;
  const cy = taps.reduce((a, p) => a + p.y, 0) / 4;
  const q = [...taps].sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  let area = 0;
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i]!;
    const b = q[(i + 1) % 4]!;
    const c = q[(i + 2) % 4]!;
    area += a.x * b.y - b.x * a.y;
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    // Each turn must be clearly one way: a near-straight corner is three taps on one rail.
    if (Math.abs(cross) < 1e-3 * diag * diag) return false;
    const s = Math.sign(cross);
    if (sign && s !== sign) return false;
    sign = s;
  }
  return Math.abs(area) / 2 >= 0.02 * width * height;
}

// --- Zones ---------------------------------------------------------------------------------------

/** The ball played after this shot: an object ball other than the one being potted. */
export function pickNextAllowed(ball: Pick<Ball, 'id' | 'kind'>, targetId: string | null): boolean {
  return ball.kind !== 'cue' && ball.id !== targetId;
}

// --- Start mode (spec 002 T166) ------------------------------------------------------------------

/** A `?mode=` override, if valid. */
export function explicitMode(param: string | null): Mode | null {
  return param === 'practice' || param === 'camera' || param === 'snap' ? param : null;
}

/** Touch devices start in Live unless the device is known to have no camera (desktop: Practice). */
export function startMode(coarsePointer: boolean, hasCamera: boolean | null): Mode {
  return coarsePointer && hasCamera !== false ? 'camera' : 'practice';
}

/**
 * Whether a camera exists, from `enumerateDevices()` (which needs no permission and never opens one):
 * true / false, or null when it cannot be told (no API, an error, or no answer within `timeoutMs`).
 */
export async function probeCamera(md: Pick<MediaDevices, 'enumerateDevices'> | undefined, timeoutMs = 1500): Promise<boolean | null> {
  if (!md || typeof md.enumerateDevices !== 'function') return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const list = await Promise.race([md.enumerateDevices(), new Promise<null>((r) => (timer = setTimeout(() => r(null), timeoutMs)))]);
    return list ? list.some((d) => d.kind === 'videoinput') : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// --- 3D table taps -------------------------------------------------------------------------------

/**
 * The bed point (table metres, z = 0) under client point `q`, given the renderer's projection of bed
 * points to client px. A perspective view of a plane is a homography, so four projected points fix it
 * exactly. Null when the bed cannot be projected (camera transition, degenerate view).
 */
export function bedPointFromProjection(project: (p: Vec2) => Vec2 | null, half: Vec2, q: Vec2): Vec2 | null {
  const src: Vec2[] = [
    { x: -half.x, y: -half.y },
    { x: half.x, y: -half.y },
    { x: half.x, y: half.y },
    { x: -half.x, y: half.y },
  ];
  const dst = src.map(project);
  if (dst.some((p) => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y))) return null;
  try {
    const p = applyH(invert3(homographyFrom4(src, dst as Vec2[])), q.x, q.y);
    return Number.isFinite(p.x) && Number.isFinite(p.y) ? p : null;
  } catch {
    return null;
  }
}
