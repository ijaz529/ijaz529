/**
 * Orbit camera + presets (pure). An orbit is a look-at target, yaw (around +z, 0 = eye on +x),
 * pitch (elevation above the bed plane), distance and vertical FOV. Presets are expressed as orbits
 * so that transitions interpolate smoothly between any two of them.
 */
import type { Vec2 } from '../../core/types';
import type { TableGeom } from './geom';
import {
  angleDelta,
  mat4,
  mat4Invert,
  mat4Multiply,
  mat4Perspective,
  mat4View,
  project,
  v3cross,
  v3norm,
  type Mat4,
  type V3,
} from './math3d';

export interface Orbit {
  target: V3;
  yaw: number;
  /** Radians above the horizon: π/2 looks straight down. */
  pitch: number;
  dist: number;
  fovY: number;
}

/** Screen insets (fractions of the viewport) that presets keep the table clear of. */
export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export const NO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

export interface CameraMatrices {
  view: Mat4;
  proj: Mat4;
  vp: Mat4;
  invVP: Mat4;
  eye: V3;
  right: V3;
  up: V3;
  forward: V3;
  near: number;
  far: number;
  fovY: number;
  aspect: number;
}

const DEG = Math.PI / 180;
export const USER_PITCH_MIN = 8 * DEG;
export const USER_PITCH_MAX = 89 * DEG;
export const DIST_MIN = 0.18;
export const DIST_MAX = 14;

export function orbitBasis(o: Orbit): { eye: V3; right: V3; up: V3; forward: V3 } {
  const cp = Math.cos(o.pitch);
  const sp = Math.sin(o.pitch);
  const cy = Math.cos(o.yaw);
  const sy = Math.sin(o.yaw);
  const d: V3 = [cp * cy, cp * sy, sp];
  const eye: V3 = [o.target[0] + d[0] * o.dist, o.target[1] + d[1] * o.dist, o.target[2] + d[2] * o.dist];
  const forward: V3 = [-d[0], -d[1], -d[2]];
  const right: V3 = [-sy, cy, 0];
  const up = v3norm(v3cross(right, forward));
  return { eye, right, up, forward };
}

/**
 * View/projection matrices. `shift` moves the principal point (NDC units) so that a preset framed
 * inside an inset rectangle appears centred in it.
 */
export function cameraMatrices(o: Orbit, aspect: number, shift: [number, number] = [0, 0]): CameraMatrices {
  const b = orbitBasis(o);
  // Near/far from the distance to the scene (table ≈ 3.6 m max + floor).
  const near = Math.max(0.012, Math.min(0.08, o.dist * 0.02));
  const far = o.dist + 12;
  const view = mat4View(mat4(), b.eye, b.right, b.up, b.forward);
  const proj = mat4Perspective(mat4(), o.fovY, aspect, near, far);
  // Principal-point shift: x_ndc += sx·w ⇒ add to the third column (which multiplies view-space z = −w).
  proj[8] = -shift[0];
  proj[9] = -shift[1];
  const vp = mat4Multiply(mat4(), proj, view);
  const invVP = mat4Invert(mat4(), vp) ?? mat4();
  return { view, proj, vp, invVP, eye: b.eye, right: b.right, up: b.up, forward: b.forward, near, far, fovY: o.fovY, aspect };
}

/** NDC principal-point shift that centres the frame in the inset rectangle. */
export function insetShift(ins: Insets): [number, number] {
  return [ins.left - ins.right, ins.bottom - ins.top];
}

/** Corners of the table's outer box (rail tops + bed) used for framing. */
export function tableFramePoints(g: TableGeom, pad = 0): V3[] {
  const X = g.outerX + pad;
  const Y = g.outerY + pad;
  const pts: V3[] = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const z of [g.railTop, g.apronBottom * 0.35]) pts.push([sx * X, sy * Y, z]);
  return pts;
}

/**
 * Smallest distance at which every point fits inside the (inset) viewport with `margin` (fraction
 * of the half-extent kept free). Bisection on the projected extent (monotone in distance).
 */
export function fitDistance(base: Omit<Orbit, 'dist'>, pts: V3[], aspect: number, ins: Insets = NO_INSETS, margin = 0.04): number {
  const shift = insetShift(ins);
  const x0 = -1 + 2 * ins.left + margin;
  const x1 = 1 - 2 * ins.right - margin;
  const y0 = -1 + 2 * ins.bottom + margin;
  const y1 = 1 - 2 * ins.top - margin;
  const fits = (dist: number): boolean => {
    const m = cameraMatrices({ ...base, dist }, aspect, shift);
    for (const p of pts) {
      const q = project(m.vp, p, 2, 2);
      if (!q) return false;
      const nx = q.x - 1;
      const ny = 1 - q.y;
      if (nx < x0 || nx > x1 || ny < y0 || ny > y1) return false;
    }
    return true;
  };
  let lo = 0.2;
  let hi = 40;
  if (!fits(hi)) return hi;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

/**
 * Top-down view with the table's long axis along the viewport's long axis. Landscape: +x to the
 * right, +y up (like the 2D TableView). Portrait: +x up, +y to the left.
 */
/**
 * Whether presets lay the table's long axis across the screen. The free area's shape decides, with
 * a bias toward the screen's own orientation, so a sheet or a bar appearing on a portrait phone does
 * not turn the table sideways (it used to flip and shrink when the shot card appeared).
 */
export function landscapeFrame(aspect: number, ins: Insets = NO_INSETS): boolean {
  const effAspect = (aspect * (1 - ins.left - ins.right)) / Math.max(0.05, 1 - ins.top - ins.bottom);
  return aspect >= 1 ? effAspect >= 0.77 : effAspect >= 1.3;
}

export function overviewOrbit(g: TableGeom, aspect: number, ins: Insets = NO_INSETS): Orbit {
  const yaw = landscapeFrame(aspect, ins) ? -Math.PI / 2 : Math.PI;
  const base = { target: [0, 0, 0] as V3, yaw, pitch: Math.PI / 2, fovY: 30 * DEG };
  return { ...base, dist: fitDistance(base, tableFramePoints(g), aspect, ins, 0.035) };
}

/** Elevated three-quarter view from a corner side (TV broadcast style). */
export function broadcastOrbit(g: TableGeom, aspect: number, ins: Insets = NO_INSETS): Orbit {
  const landscape = landscapeFrame(aspect, ins);
  // Landscape: from the bottom long rail, turned toward the bottom-left corner. Portrait: from
  // behind the left short rail, slightly off-axis, so the long axis recedes into the screen.
  const yaw = landscape ? -112 * DEG : 186 * DEG;
  const pitch = landscape ? 34 * DEG : 58 * DEG;
  const base = { target: [0, 0, 0] as V3, yaw, pitch, fovY: (landscape ? 38 : 46) * DEG };
  return centreFrame(base, tableFramePoints(g), aspect, ins, 0.04);
}

/**
 * Fits the points (fitDistance) and then moves the look-at target so their projection is centred
 * in the free rectangle: an oblique view otherwise sits low (the near end is bigger), leaving a void
 * above the table on tall screens.
 */
export function centreFrame(base: Omit<Orbit, 'dist'>, pts: V3[], aspect: number, ins: Insets = NO_INSETS, margin = 0.04): Orbit {
  let o: Orbit = { ...base, dist: fitDistance(base, pts, aspect, ins, margin) };
  const shift = insetShift(ins);
  const cxFree = ins.left - ins.right;
  const cyFree = ins.bottom - ins.top;
  for (let k = 0; k < 4; k++) {
    const m = cameraMatrices(o, aspect, shift);
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (const p of pts) {
      const q = project(m.vp, p, 2, 2);
      if (!q) return o;
      x0 = Math.min(x0, q.x - 1);
      x1 = Math.max(x1, q.x - 1);
      y0 = Math.min(y0, 1 - q.y);
      y1 = Math.max(y1, 1 - q.y);
    }
    const dx = (x0 + x1) / 2 - cxFree;
    const dy = (y0 + y1) / 2 - cyFree;
    if (Math.abs(dx) < 0.004 && Math.abs(dy) < 0.004) break;
    const b = orbitBasis(o);
    const t = Math.tan(o.fovY / 2) * o.dist;
    const sx = dx * t * aspect;
    const sy = dy * t;
    const target: V3 = [o.target[0] + b.right[0] * sx + b.up[0] * sy, o.target[1] + b.right[1] * sx + b.up[1] * sy, o.target[2] + b.right[2] * sx + b.up[2] * sy];
    const nb = { ...base, target };
    o = { ...nb, dist: fitDistance(nb, pts, aspect, ins, margin) };
  }
  return o;
}

export interface PlayerViewOpts {
  /** Eye height above the bed (m). */
  eyeHeight?: number;
  /** Eye distance behind the cue ball (m). */
  back?: number;
  /**
   * World points that must stay in frame (the pocket mouth, the end of the object-ball path): the
   * eye backs off, then the view widens, then it turns a little toward them until they fit inside
   * the inset rectangle (the part of the canvas no floating control covers).
   */
  keep?: V3[];
  insets?: Insets;
  /** Free margin kept around the keep points (fraction of the half-extent). */
  margin?: number;
  /** Elevation of the cue (rad): the eye stays above the cue's line, as a player's chin does. */
  cueElevation?: number;
}

/** Eye low over the cue, as a player down on the shot sees it. ASSUMPTION (chin ~15–20 cm over the cue). */
export const PLAYER_EYE_HEIGHT = 0.21;
export const PLAYER_BACK = 0.5;
/** Fit search (m, rad): backing off, widening, and turning toward the pocket are traded off by cost. */
const FIT_BACKS = [0, 0.1, 0.22, 0.38];
const FIT_FOVS = [0, 8 * DEG, 17 * DEG];
const FIT_TURN_STEP = 0.035;
const FIT_TURN_MAX = 0.55;

/**
 * The player's eye: low behind the cue ball, opposite the aim direction, looking down the aim
 * line toward the ghost ball. The look point is lowered toward the cue ball when needed so the cue
 * ball stays in the lower part of the frame. With `keep` points, the framing is widened just
 * enough to keep them (and the cue ball) inside the free part of the screen.
 */
export function playerOrbit(g: TableGeom, cue: Vec2, aimDir: Vec2, ghost: Vec2 | null, aspect: number, opts: PlayerViewOpts = {}): Orbit {
  const h0 = opts.eyeHeight ?? PLAYER_EYE_HEIGHT;
  const back0 = opts.back ?? PLAYER_BACK;
  const al = Math.hypot(aimDir.x, aimDir.y) || 1;
  const ax = aimDir.x / al;
  const ay = aimDir.y / al;
  const fov0 = (aspect >= 1 ? 50 : 58) * DEG;
  const dGhost = ghost ? Math.max(0.15, (ghost.x - cue.x) * ax + (ghost.y - cue.y) * ay) : 0.9;

  /** Orbit for an eye `back` behind the cue ball at height `h`, turned by `turn` rad from the aim. */
  const minEye = (back: number) => g.R + Math.tan(opts.cueElevation ?? 0) * back + 0.07;
  const build = (back: number, fovY: number, h0: number, turn: number): Orbit => {
    const h = Math.max(h0, minEye(back));
    const eye: V3 = [cue.x - ax * back, cue.y - ay * back, h];
    // Angles below the horizon to the cue ball's centre and to the ghost ball's centre.
    const toCue = Math.atan2(h - g.R, back);
    const toGhost = Math.atan2(h - g.R, back + dGhost);
    const half = fovY / 2;
    // Use the frame for the table, not the room: put the horizon near the top edge, but keep the
    // cue ball no higher than just above the centre and the ghost ball inside the frame.
    let look = 0.78 * half;
    look = Math.min(look, toCue + 0.1 * half);
    look = Math.max(look, toCue - 0.8 * half, toGhost - 0.85 * half);
    const c = Math.cos(turn);
    const sn = Math.sin(turn);
    const lx = ax * c - ay * sn;
    const ly = ax * sn + ay * c;
    // Look point on the plane z = R along the (turned) aim line at depression `look`.
    const run = (h - g.R) / Math.tan(Math.max(look, 1e-3));
    const target: V3 = [eye[0] + lx * run, eye[1] + ly * run, g.R];
    const dist = Math.hypot(run, h - g.R);
    return { target, yaw: Math.atan2(-ly, -lx), pitch: Math.atan2(h - g.R, run), dist, fovY };
  };
  const base = build(back0, fov0, h0, 0);
  const keep = opts.keep ?? [];
  if (!keep.length) return base;

  const ins = opts.insets ?? NO_INSETS;
  const margin = opts.margin ?? 0.06;
  const shift = insetShift(ins);
  const x0 = -1 + 2 * ins.left + margin;
  const x1 = 1 - 2 * ins.right - margin;
  const y0 = -1 + 2 * ins.bottom + margin;
  const y1 = 1 - 2 * ins.top - margin;
  const must: V3[] = [[cue.x, cue.y, g.R], ...keep];
  /** How far outside the free rectangle the worst point is (≤ 0 = everything fits). */
  const overflow = (o: Orbit): number => {
    const m = cameraMatrices(o, aspect, shift);
    let worst = -Infinity;
    for (const p of must) {
      const q = project(m.vp, p, 2, 2);
      if (!q) return Infinity;
      const nx = q.x - 1;
      const ny = 1 - q.y;
      worst = Math.max(worst, x0 - nx, nx - x1, y0 - ny, ny - y1);
    }
    return worst;
  };
  if (overflow(base) <= 0) return base;
  // Turn toward the side the keep points are on (the pocket of a cut): look between the aim line
  // and the pocket, as a player's eyes do; widen and back off only as much as still needed.
  let side = 0;
  for (const p of keep) side += Math.sign(ax * (p[1] - cue.y) - ay * (p[0] - cue.x));
  const turnDir = side >= 0 ? 1 : -1;
  let best = base;
  let bestCost = Infinity;
  // When nothing frames everything (a long shot in the strip over a raised sheet), stay straight down
  // the aim line, which keeps the cue ball and the ghost ball in the middle, and back off and widen as
  // far as it helps: the far pocket is what gets cut off. A turned view that loses least would push
  // the cue ball to the edge of the screen instead.
  let straight = base;
  let straightOver = overflow(base);
  for (const db of FIT_BACKS)
    for (const df of FIT_FOVS)
      for (let t = 0; t <= FIT_TURN_MAX + 1e-9; t += FIT_TURN_STEP) {
        const cost = t * 1.0 + df * 2.2 + db * 1.6;
        if (cost >= bestCost) continue;
        const o = build(back0 + db, fov0 + df, h0 + db * 0.3, turnDir * t);
        const v = overflow(o);
        if (v <= 0) {
          best = o;
          bestCost = cost;
        } else if (t === 0 && v < straightOver) {
          straight = o;
          straightOver = v;
        }
      }
  return bestCost < Infinity ? best : straight;
}

export function lerpOrbit(a: Orbit, b: Orbit, t: number): Orbit {
  return {
    target: [a.target[0] + (b.target[0] - a.target[0]) * t, a.target[1] + (b.target[1] - a.target[1]) * t, a.target[2] + (b.target[2] - a.target[2]) * t],
    yaw: a.yaw + angleDelta(a.yaw, b.yaw) * t,
    pitch: a.pitch + (b.pitch - a.pitch) * t,
    dist: Math.exp(Math.log(a.dist) + (Math.log(b.dist) - Math.log(a.dist)) * t),
    fovY: a.fovY + (b.fovY - a.fovY) * t,
  };
}

/** Limits for user-driven orbit/zoom/pan: pitch 8–89°, distance range, target on the table. */
export function clampUserOrbit(o: Orbit, g: TableGeom): Orbit {
  return {
    target: [Math.max(-g.outerX, Math.min(g.outerX, o.target[0])), Math.max(-g.outerY, Math.min(g.outerY, o.target[1])), Math.max(0, Math.min(0.2, o.target[2]))],
    yaw: o.yaw,
    pitch: Math.max(USER_PITCH_MIN, Math.min(USER_PITCH_MAX, o.pitch)),
    dist: Math.max(DIST_MIN, Math.min(DIST_MAX, o.dist)),
    fovY: o.fovY,
  };
}

/** World size of one viewport pixel at unit distance along the view axis. */
export function pixelAtUnit(fovY: number, viewportHeightPx: number): number {
  return (2 * Math.tan(fovY / 2)) / Math.max(1, viewportHeightPx);
}
