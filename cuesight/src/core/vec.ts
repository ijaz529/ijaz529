/**
 * Minimal immutable 2D/3D vector helpers. Hot loops (simulator, vision) use typed arrays and inline
 * math instead of these, so allocation here is fine.
 */
export interface Vec2 {
  x: number;
  y: number;
}
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const v2 = (x: number, y: number): Vec2 => ({ x, y });
export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, y: a.y * s });
export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
/** z-component of the 3D cross product (a × b). Positive when b is counter-clockwise of a. */
export const cross = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x;
export const len = (a: Vec2): number => Math.hypot(a.x, a.y);
export const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);
export const norm = (a: Vec2): Vec2 => {
  const l = Math.hypot(a.x, a.y);
  return l > 0 ? { x: a.x / l, y: a.y / l } : { x: 0, y: 0 };
};
/** Rotate counter-clockwise by `rad`. */
export const rotate = (a: Vec2, rad: number): Vec2 => {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return { x: a.x * c - a.y * s, y: a.x * s + a.y * c };
};
/** Left-hand perpendicular (90° counter-clockwise). */
export const perp = (a: Vec2): Vec2 => ({ x: -a.y, y: a.x });
export const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
});
export const angleOf = (a: Vec2): number => Math.atan2(a.y, a.x);
export const fromAngle = (rad: number): Vec2 => ({ x: Math.cos(rad), y: Math.sin(rad) });
/** Signed angle from a to b in (−π, π]. */
export const angleBetween = (a: Vec2, b: Vec2): number => Math.atan2(cross(a, b), dot(a, b));

/** Distance from point p to segment ab, and the clamped parameter t of the closest point. */
export function pointSegment(p: Vec2, a: Vec2, b: Vec2): { d: number; t: number } {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const l2 = abx * abx + aby * aby;
  let t = l2 > 0 ? ((p.x - a.x) * abx + (p.y - a.y) * aby) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = a.x + abx * t - p.x;
  const cy = a.y + aby * t - p.y;
  return { d: Math.hypot(cx, cy), t };
}

export const deg = (rad: number): number => (rad * 180) / Math.PI;
export const rad = (degrees: number): number => (degrees * Math.PI) / 180;
export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
