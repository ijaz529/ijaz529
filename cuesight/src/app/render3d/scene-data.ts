/**
 * Pure scene preparation: ball appearance, rest orientations, cue-stick placement from the stroke,
 * and the plan overlays (ribbons/markers) in table coordinates. No GL, no DOM.
 */
import type { Ball, PocketId, ShotPlan, Stroke, TableSpec, Vec2 } from '../../core/types';
import { BALL_NAMED, BALL_NEUTRAL, BALL_SNOOKER, PALETTE } from '../render/palette';
import { aimLine, stickDir } from '../render/plan-draw';
import type { TableGeom } from './geom';
import { circlePoints, simplifyPath } from './meshes';
import { quatFromAxes, quatFromAxisAngle, quatMultiply, type Quat, type V3 } from './math3d';
import { atlasSlot } from './textures';

export type RGBA = [number, number, number, number];

// ---------------------------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------------------------
const NAMED = BALL_NAMED;
const SNOOKER = BALL_SNOOKER;
const POOL_NUMBERS = ['#f2b705', '#1e4fb5', '#c81e1e', '#4b2a83', '#f06a12', '#0f7a3d', '#7a1e2b', '#121212'];

/** Parse '#rgb', '#rrggbb', 'rgb(r,g,b)' or a colour name → sRGB 0..1. */
export function parseColor(css: string | undefined): [number, number, number] | null {
  if (!css) return null;
  const s = css.trim().toLowerCase();
  let m = /^#([0-9a-f]{6})$/.exec(s);
  if (m) {
    const n = parseInt(m[1]!, 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  m = /^#([0-9a-f]{3})$/.exec(s);
  if (m) {
    const h = m[1]!;
    return [parseInt(h[0]! + h[0]!, 16) / 255, parseInt(h[1]! + h[1]!, 16) / 255, parseInt(h[2]! + h[2]!, 16) / 255];
  }
  m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/.exec(s);
  if (m) return [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255];
  const named = NAMED[s];
  return named ? parseColor(named) : null;
}

export const srgbToLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

export interface BallLook {
  /** Linear-light base colour. */
  color: [number, number, number];
  stripe: boolean;
  /** Number atlas slot (0–14) or −1. */
  slot: number;
  cueDots: boolean;
}

/** Appearance of a ball: numbered pool set, snooker colours, or the detected colour + stripe. */
export function ballLook(b: Ball, table: TableSpec): BallLook {
  const lin = (c: [number, number, number]): [number, number, number] => [srgbToLinear(c[0]), srgbToLinear(c[1]), srgbToLinear(c[2])];
  if (b.kind === 'cue') return { color: lin(parseColor(NAMED.white)!), stripe: false, slot: -1, cueDots: true };
  const snooker = table.id === 'snooker12';
  const label = (b.label ?? '').trim().toLowerCase();
  const word = label.split(/\s+/)[0] ?? '';
  const slot = snooker ? -1 : atlasSlot(label);
  let c: [number, number, number] | null = null;
  if (snooker) c = parseColor(SNOOKER[word]) ?? parseColor(b.color);
  else if (slot >= 0) c = parseColor(b.color) ?? parseColor(POOL_NUMBERS[slot % 8]);
  // A ball vision could not name ('ball') and that has no measured colour is drawn neutral grey.
  c ??= parseColor(b.color) ?? parseColor(NAMED[word]) ?? parseColor(BALL_NEUTRAL)!;
  const stripe = !snooker && (b.stripe === true || slot >= 8 || /stripe/.test(label));
  return { color: lin(c), stripe, slot, cueDots: false };
}

// ---------------------------------------------------------------------------------------------
// Orientation
// ---------------------------------------------------------------------------------------------
function idHash(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

/**
 * A resting orientation with the number circle (local +x) facing up and the number reading upright
 * for a viewer whose screen-up is `up` (table plane), plus a small deterministic tilt per ball.
 */
export function restOrientation(id: string, up: Vec2): Quat {
  const l = Math.hypot(up.x, up.y) || 1;
  const ux = up.x / l;
  const uy = up.y / l;
  const base = quatFromAxes([0, 0, 1], [uy, -ux, 0], [ux, uy, 0]);
  const h = idHash(id);
  const h2 = idHash(id + '#');
  const yaw = (h - 0.5) * 0.5; // ±14°
  const tiltAxis: V3 = [Math.cos(h2 * 6.283), Math.sin(h2 * 6.283), 0];
  const tilt = quatFromAxisAngle(tiltAxis, (idHash(id + '!') - 0.5) * 0.35); // ±10°
  return quatMultiply(tilt, quatMultiply(quatFromAxisAngle([0, 0, 1], yaw), base));
}

// ---------------------------------------------------------------------------------------------
// Cue stick
// ---------------------------------------------------------------------------------------------
export interface CuePose {
  /** Point on the cue ball the tip strikes (3D). */
  strike: V3;
  /** Tip position (pulled back from the strike point along the cue axis). */
  tip: V3;
  /** Unit vector from the tip toward the butt. */
  back: V3;
  /** Cue elevation above horizontal (rad). */
  elevation: number;
  /** Tip–ball gap (m). */
  gap: number;
}

/** Minimum cue elevation (real players rarely get below ~3–5° over a rail). ASSUMPTION. */
export const MIN_CUE_ELEVATION = (4 * Math.PI) / 180;

/**
 * Back-swing for a given power (1–10): the tip–ball gap at the top of the stroke, 0.05 + 0.03·power m.
 * At rest the cue sits at the ADDRESS_GAP (a player addressing the ball), and the power shows as the
 * length of the idle practice strokes and of the back-swing before a replay.
 */
export const cueGap = (power: number): number => 0.05 + 0.03 * Math.max(0, Math.min(10, power));
/** Tip–ball gap at address (cue resting just behind the strike point). */
export const ADDRESS_GAP = 0.015;
/** Length of an idle practice stroke for a given power (m): 0.03 + 0.02·power. */
export const practiceStroke = (power: number): number => 0.03 + 0.02 * Math.max(0, Math.min(10, power));

/**
 * 3D strike point on the cue ball: behind the ball (opposite the aim), offset side·R to the
 * player's right and vert·R up. Same convention as vision/player-view strikePoint().
 */
export function strikePoint3(c: Vec2, aim: Vec2, side: number, vert: number, R: number): V3 {
  const l = Math.hypot(aim.x, aim.y) || 1;
  const ax = aim.x / l;
  const ay = aim.y / l;
  const s = side * R;
  const v = vert * R;
  const back = Math.sqrt(Math.max(0, R * R - s * s - v * v));
  // Player's right when facing the aim direction.
  const rx = ay;
  const ry = -ax;
  return [c.x - ax * back + rx * s, c.y - ay * back + ry * s, R + v];
}

/** Distance from p along direction d to the cushion-nose rectangle. */
function distToNose(g: TableGeom, p: Vec2, d: Vec2): number {
  let t = Infinity;
  if (d.x > 1e-9) t = Math.min(t, (g.hx - p.x) / d.x);
  if (d.x < -1e-9) t = Math.min(t, (-g.hx - p.x) / d.x);
  if (d.y > 1e-9) t = Math.min(t, (g.hy - p.y) / d.y);
  if (d.y < -1e-9) t = Math.min(t, (-g.hy - p.y) / d.y);
  return Math.max(0, t);
}

export function cuePose(g: TableGeom, cue: Vec2, aim: Vec2, stroke: Stroke): CuePose {
  const R = g.R;
  const l = Math.hypot(aim.x, aim.y) || 1;
  const ax = aim.x / l;
  const ay = aim.y / l;
  const strike = strikePoint3(cue, { x: ax, y: ay }, stroke.side, stroke.vert, R);
  const gap = cueGap(stroke.power);
  // Raise the butt enough to clear the cushion/rail behind the cue ball.
  const dNose = distToNose(g, { x: strike[0], y: strike[1] }, { x: -ax, y: -ay });
  const clearance = g.railTop + 0.006 + 0.011 - strike[2];
  let e = MIN_CUE_ELEVATION;
  if (dNose < 1.2) e = Math.max(e, Math.atan2(clearance, Math.max(0.02, dNose)));
  e = Math.min(e, (60 * Math.PI) / 180);
  const back: V3 = [-ax * Math.cos(e), -ay * Math.cos(e), Math.sin(e)];
  const tip: V3 = [strike[0] + back[0] * gap, strike[1] + back[1] * gap, strike[2] + back[2] * gap];
  return { strike, tip, back, elevation: e, gap };
}

// ---------------------------------------------------------------------------------------------
// Plan overlays
// ---------------------------------------------------------------------------------------------
export interface RibbonSpec {
  key: string;
  pts: Vec2[];
  /** Height of the ribbon plane above the bed. */
  z: number;
  closed?: boolean;
  /** sRGB 0..1 + alpha. */
  color: RGBA;
  halo: RGBA;
  /** on, off, on2, off2 (m); omitted = solid. */
  dash?: [number, number, number, number];
  /** World width (m) and minimum on-screen width (CSS px), halo width (CSS px). */
  width: number;
  minPx: number;
  haloPx: number;
}

export const hexRGBA = (hex: string, a = 1): RGBA => {
  const c = parseColor(hex) ?? [1, 1, 1];
  return [c[0], c[1], c[2], a];
};

const DARK_HALO: RGBA = [0.02, 0.04, 0.06, 0.55];
const LIGHT_HALO: RGBA = [1, 1, 1, 0.42];
/** Ribbons are lifted 1 mm above the cloth. */
export const RIBBON_Z = 0.001;

export interface OverlayInput {
  table: TableSpec;
  balls: Ball[];
  plan: ShotPlan | null;
  targetId: string | null;
  pocketId: PocketId | null;
  landing: Vec2 | null;
  /** Pockets the cue ball could drop into with a small error (scratch risk), marked dashed. */
  riskPockets?: PocketId[];
}

/** Index of the first point at/after the cue ball's first ball contact (−1 if none). */
export function firstContactIndex(plan: ShotPlan): number {
  const hit = plan.cuePath.events.find((e) => e.kind === 'ball');
  if (!hit) return -1;
  return plan.cuePath.points.findIndex((p) => Math.abs(p.x - hit.pos.x) < 1e-6 && Math.abs(p.y - hit.pos.y) < 1e-6);
}

export interface RibbonOpts {
  /** Ring the target ball (off in Player view: the object-ball path and contact dot already say which). */
  targetRing?: boolean;
  /**
   * Small balls on screen (the top view): outline the ghost ball in solid sky instead of white dots,
   * so it cannot be mistaken for the white target ring a few pixels away.
   */
  ghostSolid?: boolean;
}

/** An ✕ of half-size s at q (two strokes). */
function crossMark(key: string, q: Vec2, s: number, z: number, color: RGBA): RibbonSpec[] {
  return [
    { key: `${key}-a`, pts: [{ x: q.x - s, y: q.y - s }, { x: q.x + s, y: q.y + s }], z, color, halo: DARK_HALO, width: 0.005, minPx: 2.6, haloPx: 1.2 },
    { key: `${key}-b`, pts: [{ x: q.x + s, y: q.y - s }, { x: q.x - s, y: q.y + s }], z, color, halo: DARK_HALO, width: 0.005, minPx: 2.6, haloPx: 1.2 },
  ];
}

export function planRibbons(inp: OverlayInput, g: TableGeom, opts: RibbonOpts = {}): RibbonSpec[] {
  const out: RibbonSpec[] = [];
  const R = g.R;
  const z = RIBBON_Z;
  const target = inp.targetId ? inp.balls.find((b) => b.id === inp.targetId) : undefined;
  const plan = inp.plan;
  const cue = inp.balls.find((b) => b.kind === 'cue');
  if (plan && cue) {
    for (const o of plan.otherPaths)
      if (o.points.length > 1)
        out.push({ key: `other:${o.ballId}`, pts: simplifyPath(o.points), z, color: hexRGBA(PALETTE.other, 0.85), halo: [0, 0, 0, 0.3], dash: [0.04, 0.02, 0.008, 0.02], width: 0.004, minPx: 1.6, haloPx: 0.8 });
    if (plan.objectPath.points.length > 1)
      out.push({ key: 'ob', pts: simplifyPath(plan.objectPath.points), z, color: hexRGBA(PALETTE.object), halo: DARK_HALO, width: 0.006, minPx: 3, haloPx: 1.2 });
    const k = firstContactIndex(plan);
    if (k >= 0) {
      const after = plan.cuePath.points.slice(k);
      if (after.length > 1) out.push({ key: 'cb', pts: simplifyPath(after), z, color: hexRGBA(PALETTE.cue), halo: DARK_HALO, dash: [0.045, 0.028, 0, 0], width: 0.006, minPx: 2.6, haloPx: 1.2 });
    }
    // Aim line: cue-ball centre → ghost-ball centre (a frozen cue ball: the stroke along aimDir from
    // the cue ball, and no ghost ball). Not makeable: vermillion AND dashed (never by colour alone),
    // with an ✕ on each ball in the way.
    const aim = aimLine(plan, cue.pos, R, { hx: g.hx, hy: g.hy });
    out.push({
      key: 'aim',
      pts: [aim.from, aim.to],
      z,
      color: hexRGBA(plan.makeable ? PALETTE.aim : PALETTE.warn),
      halo: LIGHT_HALO,
      ...(plan.makeable ? {} : { dash: [0.022, 0.016, 0, 0] as [number, number, number, number] }),
      width: 0.006,
      minPx: 3.2,
      haloPx: 1.1,
    });
    const blockers = new Set(plan.warnings.filter((w) => (w.code === 'blocked-cue' || w.code === 'blocked-object') && w.ballId).map((w) => w.ballId!));
    for (const id of blockers) {
      const b = inp.balls.find((x) => x.id === id);
      if (b) out.push(...crossMark(`block:${id}`, b.pos, R * 1.25, z, hexRGBA(PALETTE.warn)));
    }
    const gh = aim.ghost;
    if (gh && opts.ghostSolid) out.push({ key: 'ghost', pts: circlePoints(gh.x, gh.y, R, 40), z, closed: true, color: hexRGBA(PALETTE.cue, 0.95), halo: [0, 0, 0, 0.4], width: 0.0025, minPx: 1.5, haloPx: 0.8 });
    else if (gh) out.push({ key: 'ghost', pts: circlePoints(gh.x, gh.y, R, 40), z, closed: true, color: hexRGBA(PALETTE.ghost, 0.95), halo: [0, 0, 0, 0.35], dash: [0.0055, 0.0075, 0, 0], width: 0.003, minPx: 2, haloPx: 0.8 });
    if (plan.cueRest) {
      const q = plan.cueRest;
      const s = Math.max(0.018, R * 0.7);
      out.push({ key: 'rest-x1', pts: [{ x: q.x - s, y: q.y - s }, { x: q.x + s, y: q.y + s }], z, color: hexRGBA(PALETTE.cue), halo: DARK_HALO, width: 0.005, minPx: 2.4, haloPx: 1 });
      out.push({ key: 'rest-x2', pts: [{ x: q.x + s, y: q.y - s }, { x: q.x - s, y: q.y + s }], z, color: hexRGBA(PALETTE.cue), halo: DARK_HALO, width: 0.005, minPx: 2.4, haloPx: 1 });
      out.push({ key: 'rest-ring', pts: circlePoints(q.x, q.y, R, 36), z, closed: true, color: hexRGBA(PALETTE.cue, 0.95), halo: [0, 0, 0, 0.3], dash: [0.006, 0.007, 0, 0], width: 0.003, minPx: 2, haloPx: 0.8 });
    }
  }
  if (target && opts.targetRing !== false)
    out.push({ key: 'target', pts: circlePoints(target.pos.x, target.pos.y, R * 1.42, 48), z, closed: true, color: hexRGBA(PALETTE.target), halo: DARK_HALO, width: 0.004, minPx: 2.4, haloPx: 1.4 });
  const pocketId = plan?.pocketId ?? inp.pocketId;
  const hole = pocketId ? g.holes.find((h) => h.id === pocketId) : undefined;
  const spec = pocketId ? inp.table.pockets.find((p) => p.id === pocketId) : undefined;
  // The target pocket: a gold arc on the cloth across the mouth, jaw to jaw (at rail height a full
  // ring hovered over the pocket like a halo in the low Player view).
  if (hole && spec) out.push({ key: 'pocket', pts: mouthArc(spec, hole), z: 0.0015, color: hexRGBA(PALETTE.pocket), halo: [0.02, 0.04, 0.06, 0.7], width: 0.006, minPx: 3, haloPx: 3 });
  // Scratch: an ✕ ring on the pocket the cue ball would drop into.
  const scratchId = plan?.scratch ? plan.cuePath.pocket : null;
  const sh = scratchId ? g.holes.find((h) => h.id === scratchId) : undefined;
  if (sh) {
    out.push({ key: 'scratch', pts: circlePoints(sh.x, sh.y, sh.r + 0.004, 56), z: g.railTop + 0.0016, closed: true, color: hexRGBA(PALETTE.warn), halo: DARK_HALO, dash: [0.012, 0.008, 0, 0], width: 0.005, minPx: 2.6, haloPx: 1.2 });
    out.push(...crossMark('scratch-x', { x: sh.x, y: sh.y }, sh.r * 0.55, g.railTop + 0.0016, hexRGBA(PALETTE.warn)));
  }
  // Scratch risk (a small error drops the cue ball here): a dashed vermillion ring, no ✕ (not a scratch yet).
  for (const id of inp.riskPockets ?? []) {
    const rh = g.holes.find((h) => h.id === id);
    if (rh && rh !== sh) out.push({ key: `risk:${id}`, pts: circlePoints(rh.x, rh.y, rh.r + 0.004, 56), z: g.railTop + 0.0016, closed: true, color: hexRGBA(PALETTE.warn, 0.9), halo: DARK_HALO, dash: [0.008, 0.012, 0, 0], width: 0.004, minPx: 2.2, haloPx: 1.1 });
  }
  if (inp.landing) {
    const q = inp.landing;
    out.push({ key: 'landing', pts: circlePoints(q.x, q.y, 0.15, 64), z, closed: true, color: hexRGBA(PALETTE.landing), halo: DARK_HALO, dash: [0.03, 0.02, 0, 0], width: 0.004, minPx: 2.2, haloPx: 1 });
    out.push({ key: 'landing-h', pts: [{ x: q.x - 0.03, y: q.y }, { x: q.x + 0.03, y: q.y }], z, color: hexRGBA(PALETTE.landing), halo: DARK_HALO, width: 0.004, minPx: 2.2, haloPx: 1 });
    out.push({ key: 'landing-v', pts: [{ x: q.x, y: q.y - 0.03 }, { x: q.x, y: q.y + 0.03 }], z, color: hexRGBA(PALETTE.landing), halo: DARK_HALO, width: 0.004, minPx: 2.2, haloPx: 1 });
  }
  return out;
}

/**
 * Arc through the two jaw points of a pocket, bulging into the table (the side the ball comes from),
 * centred on the hole.
 */
export function mouthArc(p: { jawA: Vec2; jawB: Vec2; inward: Vec2 }, hole: { x: number; y: number }, n = 28): Vec2[] {
  const ra = Math.hypot(p.jawA.x - hole.x, p.jawA.y - hole.y);
  const rb = Math.hypot(p.jawB.x - hole.x, p.jawB.y - hole.y);
  const a0 = Math.atan2(p.jawA.y - hole.y, p.jawA.x - hole.x);
  let a1 = Math.atan2(p.jawB.y - hole.y, p.jawB.x - hole.x);
  // Sweep the way that passes the inward direction.
  const ai = Math.atan2(p.inward.y, p.inward.x);
  const norm = (a: number) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  let sweep = norm(a1 - a0);
  if (norm(ai - a0) > sweep) sweep -= 2 * Math.PI;
  a1 = a0 + sweep;
  const out: Vec2[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const a = a0 + (a1 - a0) * t;
    const r = ra + (rb - ra) * t;
    out.push({ x: hole.x + r * Math.cos(a), y: hole.y + r * Math.sin(a) });
  }
  return out;
}

/**
 * Cue ball, the cue-ball path direction (aim), the cue's own direction (stickDir: squirt-corrected)
 * and the ghost ball (null for a frozen cue ball, which has none). Without a plan: toward the target,
 * else toward the table centre. Null without a cue ball.
 */
export function cueAim(d: { balls: readonly Ball[]; plan: ShotPlan | null; targetId: string | null }): { cue: Vec2; aim: Vec2; cueDir: Vec2; ghost: Vec2 | null } | null {
  const cue = d.balls.find((b) => b.kind === 'cue');
  if (!cue) return null;
  if (d.plan) return { cue: cue.pos, aim: d.plan.aimDir, cueDir: stickDir(d.plan), ghost: aimLine(d.plan, cue.pos, 0).ghost };
  const t = d.targetId ? d.balls.find((b) => b.id === d.targetId) : undefined;
  if (t) {
    const v = { x: t.pos.x - cue.pos.x, y: t.pos.y - cue.pos.y };
    if (Math.hypot(v.x, v.y) > 1e-6) return { cue: cue.pos, aim: v, cueDir: v, ghost: t.pos };
  }
  const v = Math.hypot(cue.pos.x, cue.pos.y) > 0.05 ? { x: -cue.pos.x, y: -cue.pos.y } : { x: 1, y: 0 };
  return { cue: cue.pos, aim: v, cueDir: v, ghost: null };
}

/** Contact point on the object ball (3D, on its equator facing the ghost ball). */
export function contactPoint3(plan: ShotPlan, R: number): V3 {
  return [plan.contactPoint.x, plan.contactPoint.y, R];
}
