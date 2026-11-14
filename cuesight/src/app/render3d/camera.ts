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
export function overviewOrbit(g: TableGeom, aspect: number, ins: Insets = NO_INSETS): Orbit {
  const effAspect = (aspect * (1 - ins.left - ins.right)) / Math.max(0.05, 1 - ins.top - ins.bottom);
  const yaw = effAspect >= 1 ? -Math.PI / 2 : Math.PI;
  const base = { target: [0, 0, 0] as V3, yaw, pitch: Math.PI / 2, fovY: 30 * DEG };
  return { ...base, dist: fitDistance(base, tableFramePoints(g), aspect, ins, 0.035) };
}

/** Elevated three-quarter view from a corner side (TV broadcast style). */
export function broadcastOrbit(g: TableGeom, aspect: number, ins: Insets = NO_INSETS): Orbit {
  const effAspect = (aspect * (1 - ins.left - ins.right)) / Math.max(0.05, 1 - ins.top - ins.bottom);
  const landscape = effAspect >= 1;
  // Landscape: from the bottom long rail, turned toward the bottom-left corner. Portrait: from
  // behind the left short rail, slightly off-axis, so the long axis recedes into the screen.
  const yaw = landscape ? -112 * DEG : 196 * DEG;
  const pitch = landscape ? 34 * DEG : 40 * DEG;
  const base = { target: [0, 0, 0] as V3, yaw, pitch, fovY: 38 * DEG };
  return { ...base, dist: fitDistance(base, tableFramePoints(g), aspect, ins, 0.04) };
}

export interface PlayerViewOpts {
  /** Eye height above the bed (m). */
  eyeHeight?: number;
  /** Eye distance behind the cue ball (m). */
  back?: number;
}

/**
 * The player's eye: low behind the cue ball, opposite the aim direction, looking down the aim
 * line toward the ghost ball. The look point is lowered toward the cue ball when needed so the cue
 * ball stays in the lower part of the frame.
 */
export function playerOrbit(g: TableGeom, cue: Vec2, aimDir: Vec2, ghost: Vec2 | null, aspect: number, opts: PlayerViewOpts = {}): Orbit {
  const h = opts.eyeHeight ?? 0.3;
  const back = opts.back ?? 0.55;
  const al = Math.hypot(aimDir.x, aimDir.y) || 1;
  const ax = aimDir.x / al;
  const ay = aimDir.y / al;
  const fovY = (aspect >= 1 ? 50 : 58) * DEG;
  const eye: V3 = [cue.x - ax * back, cue.y - ay * back, h];
  const dGhost = ghost ? Math.max(0.15, (ghost.x - cue.x) * ax + (ghost.y - cue.y) * ay) : 0.9;
  // Angles below the horizon to the cue ball's centre and to the ghost ball's centre.
  const toCue = Math.atan2(h - g.R, back);
  const toGhost = Math.atan2(h - g.R, back + dGhost);
  const half = fovY / 2;
  const look = Math.max(toGhost, toCue - 0.62 * half);
  // Look point on the plane z = R along the aim line at depression `look`.
  const run = (h - g.R) / Math.tan(Math.max(look, 1e-3));
  const target: V3 = [eye[0] + ax * run, eye[1] + ay * run, g.R];
  const dist = Math.hypot(run, h - g.R);
  return { target, yaw: Math.atan2(-ay, -ax), pitch: Math.atan2(h - g.R, run), dist, fovY };
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
