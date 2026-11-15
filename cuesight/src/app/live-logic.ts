/**
 * Pure decisions of the Live camera session (no DOM, no workers), unit-tested in
 * tests/unit/app/live-logic.test.ts: when the live plan may be drawn, how a selection survives
 * tracker id churn, what the status pill and hints say, manual-calibration feedback, and the start mode.
 */
import type { Ball, PocketId, TableLayout, TableSpec, Vec2 } from '../core/types';
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

/**
 * The live tracker's ids stopped naming the same balls: a new table frame (Rotate, corners set or
 * cleared, another table or field of view) or a new tracker (the vision worker failed or was
 * recreated: its ids start again at b1). The live selection, held by those ids, is cleared. A frozen
 * snapshot keeps its own ids (unfreezing compares the frame generation), and Practice / Snap never
 * hold live ids. Returns whether anything the player had chosen was cleared.
 */
export function dropLiveSelection(s: SelectionState & Pick<AppState, 'mode' | 'frozen'>): boolean {
  if (s.mode !== 'camera' || s.frozen) return false;
  return clearSelection(s);
}

// --- Table detection failures --------------------------------------------------------------------

export const VISION_FAILED = {
  /** The worker never answered: its script did not load (often: not cached yet for offline use). */
  load: 'Table detection couldn’t start — it may not be available offline yet. Reconnect and tap “Try again”, or use the practice table.',
  /** The worker had been answering, then crashed or kept failing on frames. */
  stopped: 'Table detection stopped working. Tap “Try again” to restart it, or use the practice table.',
} as const;

/** The camera message when table detection is off; `answered`: the failed worker had replied at least once. */
export function visionFailureMessage(answered: boolean): string {
  return answered ? VISION_FAILED.stopped : VISION_FAILED.load;
}

/** The camera message's title: the camera itself works when only table detection failed. */
export function cameraMessageTitle(error: string | null): string {
  return error === VISION_FAILED.load || error === VISION_FAILED.stopped ? 'Table detection is off' : 'Camera unavailable';
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

/**
 * Results since the last lock. `newFrame`: the first result computed in a new table frame (Rotate,
 * corners set or cleared, another table or field of view): the old frame's lock gives it no grace,
 * so the gate stays shut until the new frame locks.
 */
export function nextSinceLocked(prev: number, status: LockStatus, newFrame = false): number {
  if (status === 'locked') return 0;
  return newFrame ? Infinity : prev + 1;
}

/** The live layout may be planned on and drawn: locked, or locked a result or two ago, with a calibration. */
export function liveGate(status: LockStatus, sinceLocked: number, hasCalibration: boolean): boolean {
  if (!hasCalibration) return false;
  return status === 'locked' || (status === 'unstable' && sinceLocked <= LOCK_GRACE);
}

// --- Status pill and hints -----------------------------------------------------------------------

export const STATUS_TEXT = { searching: 'Looking for the table…', unstable: 'Table found — hold steady', locked: 'Table locked' } as const;

/**
 * The pill's live-region text: the lock state only (no per-frame counters). `cornersOut`: corner
 * pockets of the locked table outside the frame (nextCornersOut): balls in them may be missed.
 */
export function pillText(status: LockStatus | null, frozen: boolean, cornersOut = 0): string {
  if (frozen) return 'Frozen layout';
  if (status === 'locked' && cornersOut > 0) return cornersOut === 1 ? 'Table locked — a corner pocket is out of view' : 'Table locked — corner pockets are out of view';
  return status ? STATUS_TEXT[status] : 'Starting camera…';
}

/** Corners of the table outline (calibration corners, frame px) outside the w×h frame by more than `margin` px. */
export function cornersOutOfView(corners: readonly Vec2[] | null | undefined, w: number, h: number, margin = 0): number {
  if (!corners) return 0;
  return corners.filter((c) => c.x < -margin || c.y < -margin || c.x > w + margin || c.y > h + margin).length;
}

/** Px a corner must pass the frame edge by (either way) before the "out of view" count changes. */
export const CORNER_OUT_HYSTERESIS_PX = 4;

/**
 * The merged vision locks a table whose corners are just off-screen (table-detect extrapolates them),
 * but balls in those corner pockets are not seen. The count of such corners, with hysteresis so a
 * corner sitting on the border does not flicker the status text: a corner counts once it is more than
 * CORNER_OUT_HYSTERESIS_PX outside, and stops once it is that far inside. No corners (no calibration): 0.
 */
export function nextCornersOut(prev: number, corners: readonly Vec2[] | null | undefined, w: number, h: number): number {
  if (!corners) return 0;
  const surely = cornersOutOfView(corners, w, h, CORNER_OUT_HYSTERESIS_PX);
  const maybe = cornersOutOfView(corners, w, h, -CORNER_OUT_HYSTERESIS_PX);
  // Between the two bands the previous count stands (clamped to what is possible now).
  return Math.max(surely, Math.min(prev, maybe));
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
  /** Balls the vision calls 'white?' (whites that are not the cue ball; two when too close to call). */
  unsureWhites?: number;
}

/** The Live-specific shot-card hint, or null to fall through to the shared hints. */
export function cameraHint(o: CameraHintInput): string | null {
  if (o.error) return 'The camera is off. Use photos (Snap) or the practice table instead.';
  if (o.interaction === 'calibrate') return 'Tap the 4 corners where the cloth meets the rails.';
  if (!o.frozen) {
    if (!o.status || o.status === 'searching') return 'Point the camera at the table so the whole cloth is in view.';
    if (!o.live) return 'Hold steady — the table isn’t locked yet.';
  }
  // "Cue ball" on: the next tap marks the cue ball, also when vision found one (the toast says the same).
  if (o.interaction === 'mark-cue') return 'Tap the cue ball.';
  if (o.balls > 0 && !o.hasCue) {
    // Two whites too close to call (ball-detect: no cue unless clearly whiter than the runner-up).
    return (o.unsureWhites ?? 0) >= 2 ? 'Two white balls — tap “Cue ball”, then tap the one you play with.' : 'No cue ball found — tap “Cue ball”, then tap the cue ball.';
  }
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

/** VisionResult.reason in player words (the same wording as Snap's tapped corners, snap/session.ts). */
export const CALIBRATION_MESSAGES = {
  ok: 'Calibrated from your four corners.',
  /** reason 'bad-quad', a quad refused here before sending, or (first result) under 80 % of it is cloth. */
  badQuad: 'Those four taps aren’t the cloth corners — tap them again.',
  /** reason 'cloth-unknown'. */
  cloth: 'Couldn’t tell the cloth from its surroundings — tap the 4 cloth corners again, or use Snap.',
  /** reason 'moved' on a later result: the cloth edges left the tapped sides. */
  moved: 'The phone moved — recalibrate, or tap Calibrate to go back to automatic detection.',
} as const;

/**
 * What to tell the player about their four corners from the first result computed with them; null =
 * not decided yet. The pipeline anchors manual corners on that very frame, so a 'moved' there cannot
 * be a phone that moved: it says under 80 % of the tapped quad is cloth (taps off the corners).
 */
export function calibrationFeedback(r: CalibrationResultLike): CalibrationVerdict | null {
  const reason = typeof r.reason === 'string' ? r.reason : undefined;
  if (reason === 'bad-quad' || reason === 'moved') return { ok: false, retry: true, message: CALIBRATION_MESSAGES.badQuad };
  if (reason === 'cloth-unknown' || (!r.cloth && !r.calibration)) return { ok: false, retry: true, message: CALIBRATION_MESSAGES.cloth };
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

// --- Rotate / Calibrate keep the selection (wave-2a item 17) ---------------------------------------

/** A ball as the camera sees it: its centre in frame px (through HR) and its label. */
export interface FrameSpot {
  px: Vec2;
  label?: string;
}

/**
 * The live selection remembered in frame px, where the camera sees it. Rotate and Calibrate change
 * the table frame (new ball ids, new table coordinates) but not the camera, so each part is found
 * again at the same spot of the image once the new frame is locked.
 */
export interface FrameMemory {
  target: FrameSpot | null;
  /** The marked cue ball (cueOverrideId). */
  cue: FrameSpot | null;
  /** The chosen pocket's mouth centre (cloth plane, H0). */
  pocketPx: Vec2 | null;
  /** The landing spot (cloth plane, H0). */
  landingPx: Vec2 | null;
}

/** The two homographies of a calibration (table metres → frame px): H0 the cloth plane, HR ball centres. */
export interface FrameCalibration {
  H0: readonly number[];
  HR: readonly number[];
}

/** Results in the new frame the selection waits for before it is given up as cleared. */
export const REMAP_TTL = 15;

export const REMAP_MESSAGES = {
  kept: 'Kept your selection.',
  cleared: 'The selection was cleared: the table frame changed.',
} as const;

const proj = (H: readonly number[], p: Vec2): Vec2 => applyH(H as number[], p.x, p.y);

/** Remembers the live selection in frame px (null when nothing is selected). A ball not in `balls` is remembered where it was last seen. */
export function rememberInFrame(
  s: Pick<AppState, 'targetId' | 'targetMem' | 'cueOverrideId' | 'cueMem' | 'pocketId' | 'landing'>,
  balls: readonly Ball[],
  table: Pick<TableSpec, 'pockets'>,
  cal: FrameCalibration,
): FrameMemory | null {
  const spot = (id: string | null, mem: SelectionMemory | null): FrameSpot | null => {
    if (!id) return null;
    const b = balls.find((x) => x.id === id);
    const pos = b?.pos ?? (mem && mem.id === id ? mem.pos : null);
    if (!pos) return null;
    const label = b?.label ?? (mem && mem.id === id ? mem.label : undefined);
    return { px: proj(cal.HR, pos), ...(label ? { label } : {}) };
  };
  const target = spot(s.targetId, s.targetMem);
  const cue = spot(s.cueOverrideId, s.cueMem);
  const pocket = s.pocketId ? table.pockets.find((p) => p.id === s.pocketId) : undefined;
  const mem: FrameMemory = {
    target,
    cue,
    pocketPx: target && pocket ? proj(cal.H0, pocket.mouthCenter) : null,
    landingPx: target && s.landing ? proj(cal.H0, s.landing) : null,
  };
  return mem.target || mem.cue ? mem : null;
}

/**
 * The ball of `balls` (new table frame, through `HR`) the camera sees where `mem` was: the nearest
 * within the tolerance, the same label preferred. Tolerance: max(12 px, 2 ball radii in px there)
 * for a ball with the remembered label; max(6 px, 1 radius) for any other (the same ball whose colour
 * name changed sits on the spot, while a touching neighbour is 2 radii away). `tolPx` sets both.
 * Null when none is close enough.
 */
export function remapThroughFrame(
  mem: FrameSpot,
  balls: readonly Ball[],
  HR: readonly number[],
  R: number,
  opts: { exclude?: readonly (string | null | undefined)[]; allowCue?: boolean; tolPx?: number } = {},
): string | null {
  let best: { id: string; d: number; same: boolean } | null = null;
  for (const b of balls) {
    if (opts.exclude?.includes(b.id) || (b.kind === 'cue' && !opts.allowCue)) continue;
    const c = proj(HR, b.pos);
    const e = proj(HR, { x: b.pos.x + R, y: b.pos.y });
    const rPx = Math.hypot(e.x - c.x, e.y - c.y);
    const same = !!mem.label && b.label === mem.label;
    const tol = opts.tolPx ?? (same || !mem.label ? Math.max(12, 2 * rPx) : Math.max(6, rPx));
    const d = Math.hypot(c.x - mem.px.x, c.y - mem.px.y);
    if (!(d <= tol)) continue;
    if (!best || (same && !best.same) || (same === best.same && d < best.d)) best = { id: b.id, d, same };
  }
  return best?.id ?? null;
}

/** The pocket whose mouth (through the new frame's H0) is where `px` was, within tolPx; else null. */
export function pocketThroughFrame(px: Vec2, pockets: TableSpec['pockets'], H0: readonly number[], tolPx = 40): PocketId | null {
  let best: { id: PocketId; d: number } | null = null;
  for (const p of pockets) {
    const q = proj(H0, p.mouthCenter);
    const d = Math.hypot(q.x - px.x, q.y - px.y);
    if (d <= tolPx && (!best || d < best.d)) best = { id: p.id, d };
  }
  return best?.id ?? null;
}

/** The cloth point (new table frame) the camera sees at `px`, or null when H0 cannot be inverted. */
export function landingThroughFrame(px: Vec2, H0: readonly number[]): Vec2 | null {
  try {
    const p = applyH(invert3(H0 as number[]), px.x, px.y);
    return Number.isFinite(p.x) && Number.isFinite(p.y) ? p : null;
  } catch {
    return null;
  }
}

/**
 * The remembered selection in the new frame. `found`: every remembered ball was found (the target and
 * the marked cue ball); until then the caller keeps waiting (a ball may be hidden for a moment).
 */
export function restoreFromFrame(
  mem: FrameMemory,
  balls: readonly Ball[],
  table: Pick<TableSpec, 'pockets' | 'ballRadius'>,
  cal: FrameCalibration,
): { targetId: string | null; cueOverrideId: string | null; pocketId: PocketId | null; landing: Vec2 | null; found: boolean } {
  const R = table.ballRadius;
  const cueOverrideId = mem.cue ? remapThroughFrame(mem.cue, balls, cal.HR, R, { allowCue: true }) : null;
  const targetId = mem.target ? remapThroughFrame(mem.target, balls, cal.HR, R, { exclude: [cueOverrideId] }) : null;
  const pocketId = mem.pocketPx ? pocketThroughFrame(mem.pocketPx, table.pockets, cal.H0) : null;
  const landing = mem.landingPx ? landingThroughFrame(mem.landingPx, cal.H0) : null;
  const found = (!mem.target || !!targetId) && (!mem.cue || !!cueOverrideId);
  return { targetId, cueOverrideId, pocketId, landing, found };
}
