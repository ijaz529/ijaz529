/**
 * Honesty of the Snap player-photo fit beyond the envelope grid (SC-107, FR-121, the "low light or a
 * noisy photo" edge case, the per-photo budget), on random layouts and continuous poses — the grid's
 * fixture layout hides ambiguities that random layouts expose (repeated colours, a stripe whose band
 * vanishes into the cloth, balls moved by a shot).
 *
 * - Grey cloths over tint S 0–0.12, value 100–155, cool and warm tint, from 8–14 cm above the bed: no
 *   `ok` outside the SC-106 tolerance (an `ok` there would be drawn as if right), plus three literal
 *   scenes from an independent sweep that once returned `ok` with the guide 6–49 % of the diagonal off.
 * - After a shot (the cue ball moved 10–40 cm and one or two more balls 5–30 cm): "moved", or an `ok`
 *   whose guide from the old layout is still right; never an `ok` with a wrong guide.
 * - "Too grainy" only when the noise is what defeats the fit: a photo without the cue ball says so under
 *   moderate noise, and cloth texture on a clean sensor is not sensor noise.
 * - Photos that fail (untinted grey, a moved cue ball, the cue ball out of frame) stay inside the
 *   per-photo budget (< 250 ms CPU at 960 × 720, 95th percentile).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { makeTable } from '../../src/core/table';
import type { TableSpec } from '../../src/core/types';
import { rgbToHsv, type Frame } from '../../src/vision/image';
import { estimatePlayerView, PLAYER_VIEW_REASONS, projectPoint, strikePoint, type CameraPose, type KnownBall, type PlayerViewInput, type PlayerViewResult } from '../../src/vision/player-view';
import { BALL_COLORS, cameraModel, playerViewCamera, renderSyntheticTable, type RGB, type SynthBall, type SynthCamera } from '../../src/vision/synth/render';
import type { ClothModel } from '../../src/vision/table-detect';

// --- ground truth (as in player-view-envelope.test.ts) -------------------------------------------------

function poseOf(cam: SynthCamera, width: number, height: number): CameraPose {
  const m = cameraModel(cam, width, height);
  const R = [m.R[0].x, m.R[0].y, m.R[0].z, m.R[1].x, m.R[1].y, m.R[1].z, m.R[2].x, m.R[2].y, m.R[2].z];
  const C = m.C;
  const t = { x: -(R[0]! * C.x + R[1]! * C.y + R[2]! * C.z), y: -(R[3]! * C.x + R[4]! * C.y + R[5]! * C.z), z: -(R[6]! * C.x + R[7]! * C.y + R[8]! * C.z) };
  return { R, t, f: m.f, cx: width / 2, cy: height / 2, width, height };
}

function ghostFor(table: TableSpec, cue: { x: number; y: number }, target: { x: number; y: number }) {
  const R = table.ballRadius;
  let best = table.pockets[0]!;
  let bestCos = -Infinity;
  for (const p of table.pockets) {
    const dx = p.mouthCenter.x - target.x;
    const dy = p.mouthCenter.y - target.y;
    const c = ((target.x - cue.x) * dx + (target.y - cue.y) * dy) / (Math.hypot(dx, dy) * Math.hypot(target.x - cue.x, target.y - cue.y));
    if (c > bestCos) {
      bestCos = c;
      best = p;
    }
  }
  const dx = best.mouthCenter.x - target.x;
  const dy = best.mouthCenter.y - target.y;
  const L = Math.hypot(dx, dy);
  return { x: target.x - (2 * R * dx) / L, y: target.y - (2 * R * dy) / L, z: R };
}

interface Scene {
  name: string;
  table: TableSpec;
  balls: SynthBall[];
  targetIdx: number;
  cam: SynthCamera;
  W: number;
  H: number;
  cloth?: RGB;
  /** Renderer cloth texture amplitude (default 0.04). */
  texture?: number;
}

interface Errors {
  ghost: number;
  dot: number;
}

/** Errors of the guide the app draws with `pose` from `layout` (default: the photographed balls) against the truth. */
function errorsOf(sc: Scene, pose: CameraPose, layout?: { pos: { x: number; y: number } }[]): Errors {
  const R = sc.table.ballRadius;
  const gt = poseOf(sc.cam, sc.W, sc.H);
  const cue = sc.balls[0]!.pos;
  const g = ghostFor(sc.table, cue, sc.balls[sc.targetIdx]!.pos);
  const lcue = layout ? layout[0]!.pos : cue;
  const lg = layout ? ghostFor(sc.table, lcue, layout[sc.targetIdx]!.pos) : g;
  const a = projectPoint(gt, g);
  const b = projectPoint(pose, lg);
  const ghost = a && b ? Math.hypot(a.x - b.x, a.y - b.y) / Math.hypot(sc.W, sc.H) : Infinity;
  const c = { x: cue.x, y: cue.y, z: R };
  const ca = projectPoint(gt, c)!;
  const top = projectPoint(gt, { x: cue.x, y: cue.y, z: 2 * R })!;
  const rPx = Math.hypot(top.x - ca.x, top.y - ca.y);
  let dot = 0;
  for (const [s, v] of [
    [0, 0],
    [0.4, 0],
    [-0.4, 0],
    [0, 0.4],
    [0, -0.4],
  ] as const) {
    const P = strikePoint(c, { x: g.x - cue.x, y: g.y - cue.y }, s, v, R);
    const LP = strikePoint({ x: lcue.x, y: lcue.y, z: R }, { x: lg.x - lcue.x, y: lg.y - lcue.y }, s, v, R);
    const p1 = projectPoint(gt, P);
    const p2 = projectPoint(pose, LP);
    dot = Math.max(dot, p1 && p2 ? Math.hypot(p1.x - p2.x, p1.y - p2.y) / rPx : Infinity);
  }
  return { ghost, dot };
}

const within = (e: Errors) => e.ghost <= 0.015 && e.dot <= 0.1;

interface Rendered {
  frame: Frame;
  /** The cue ball and the balls in view (≥ 50 % of the disc, ≥ 3 px, not the cloth's colour). */
  inView: number;
  cueInView: boolean;
  /** Balls other than the cue ball with ≥ 50 % of their disc in view. */
  othersInView: number;
}

function render(sc: Scene): Rendered {
  const area = new Float64Array(sc.balls.length);
  const frame = renderSyntheticTable({ table: sc.table, balls: sc.balls, camera: sc.cam, width: sc.W, height: sc.H, ss: 2, ballArea: area, ...(sc.cloth ? { cloth: sc.cloth } : {}), ...(sc.texture !== undefined ? { noise: sc.texture } : {}) });
  const m = cameraModel(sc.cam, sc.W, sc.H);
  const R = sc.table.ballRadius;
  const cloth = sc.cloth ?? [40, 130, 70];
  let inView = 0;
  let othersInView = 0;
  let cueInView = false;
  sc.balls.forEach((b, k) => {
    const P = { x: b.pos.x - m.C.x, y: b.pos.y - m.C.y, z: R - m.C.z };
    const D = Math.hypot(P.x, P.y, P.z);
    const z = m.R[2].x * P.x + m.R[2].y * P.y + m.R[2].z * P.z;
    if (z <= 0) return;
    const rPx = ((m.f * R) / Math.sqrt(D * D - R * R)) * (D / z);
    const visible = area[k]! / (Math.PI * rPx * rPx) >= 0.5 && rPx >= 3;
    const camo = Math.abs(b.color[0] - cloth[0]) + Math.abs(b.color[1] - cloth[1]) + Math.abs(b.color[2] - cloth[2]) < 60;
    if (visible && !camo) inView++;
    if (visible && !camo && k > 0) othersInView++;
    if (k === 0 && visible) cueInView = true;
  });
  return { frame, inView, cueInView, othersInView };
}

const knownOf = (balls: SynthBall[]): KnownBall[] => balls.map((b, i) => ({ id: i === 0 ? 'cue' : `b${i}`, pos: b.pos, isCue: i === 0, rgb: b.color }));

/** The fit as the app runs it: the overview's layout `layout` (default: the photographed balls). */
function run(sc: Scene, frame: Frame, extra: Partial<PlayerViewInput> = {}, layout: SynthBall[] = sc.balls): PlayerViewResult {
  return estimatePlayerView({ frame, table: sc.table, balls: knownOf(layout), cueId: 'cue', targetId: `b${sc.targetIdx}`, ...extra });
}

/** What the app passes: the overview's cloth model and the overview's (1×, 65°) focal length. */
function appHints(sc: Scene): Partial<PlayerViewInput> {
  const rgb = sc.cloth ?? [40, 130, 70];
  const hsv = [0, 0, 0];
  rgbToHsv(rgb[0], rgb[1], rgb[2], hsv);
  const clothHint: ClothModel = hsv[1]! < 0.2 ? { hue: 0, sat: hsv[1]!, val: 0.9 * hsv[2]!, kind: 'neutral' } : { hue: hsv[0]!, sat: hsv[1]!, val: 0.9 * hsv[2]!, kind: 'chromatic' };
  return { clothHint, focalPx: sc.W / 2 / Math.tan((65 * Math.PI) / 360) };
}

/** Independent per-channel Gaussian sensor noise (deterministic). */
function noisy(f: Frame, sigma: number, seed: number): Frame {
  const d = new Uint8ClampedArray(f.data.length);
  let s = seed >>> 0;
  const gauss = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const u = (s + 1) / 4294967297;
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return Math.sqrt(-2 * Math.log(u)) * Math.cos((2 * Math.PI * s) / 4294967296);
  };
  for (let i = 0; i < d.length; i += 4) {
    for (let c = 0; c < 3; c++) d[i + c] = f.data[i + c]! + sigma * gauss();
    d[i + 3] = 255;
  }
  return { width: f.width, height: f.height, data: d };
}

// --- random layouts and poses (deterministic) ----------------------------------------------------------

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const U = (r: () => number, a: number, b: number) => a + (b - a) * r();
const tables: Record<'pool9' | 'snooker12', TableSpec> = { pool9: makeTable('pool9'), snooker12: makeTable('snooker12') };
const POOL_COLOURS = ['yellow', 'blue', 'red', 'purple', 'orange', 'green', 'maroon', 'black'];

/** Free spot for a ball: on the bed and clear of `balls` (except index `skip`). */
const free = (table: TableSpec, balls: SynthBall[], p: { x: number; y: number }, skip = -1, gap = 2.1) =>
  Math.abs(p.x) < table.length / 2 - 1.5 * table.ballRadius && Math.abs(p.y) < table.width / 2 - 1.5 * table.ballRadius && balls.every((b, j) => j === skip || Math.hypot(b.pos.x - p.x, b.pos.y - p.y) > gap * table.ballRadius);

/** A random layout: the cue ball, then 5–14 pool balls (repeated colours, 40 % stripes) or 3–15 reds and the colours; a quarter touch a previous ball. */
function randomLayout(r: () => number, preset: 'pool9' | 'snooker12'): SynthBall[] {
  const table = tables[preset];
  const R = table.ballRadius;
  const balls: SynthBall[] = [];
  const place = (color: RGB, stripe = false) => {
    for (let k = 0; k < 400; k++) {
      let p = { x: U(r, -table.length / 2 + 1.5 * R, table.length / 2 - 1.5 * R), y: U(r, -table.width / 2 + 1.5 * R, table.width / 2 - 1.5 * R) };
      if (balls.length > 1 && r() < 0.25) {
        const b = balls[1 + Math.floor(r() * (balls.length - 1))]!;
        const a = r() * 2 * Math.PI;
        p = { x: b.pos.x + (2 * R + 0.0006) * Math.cos(a), y: b.pos.y + (2 * R + 0.0006) * Math.sin(a) };
      }
      if (free(table, balls, p, -1, 2.05)) {
        balls.push({ pos: p, color, ...(stripe ? { stripe: true } : {}) });
        return;
      }
    }
  };
  place(BALL_COLORS.cue!);
  if (preset === 'snooker12') {
    const nRed = 3 + Math.floor(r() * 13);
    for (let i = 0; i < nRed; i++) place(BALL_COLORS.red!);
    for (const c of ['yellow', 'brown', 'blue', 'pink', 'black']) if (r() < 0.85) place(BALL_COLORS[c]!);
    if (r() < 0.85) place(BALL_COLORS.green!);
  } else {
    const n = 5 + Math.floor(r() * 10);
    for (let i = 0; i < n; i++) {
      const c = POOL_COLOURS[Math.floor(r() * POOL_COLOURS.length)]!;
      place(BALL_COLORS[c]!, c !== 'black' && r() < 0.4);
    }
  }
  return balls;
}

interface PoseRange {
  h: [number, number];
  d: [number, number];
}

/** A random scene in the SC-106 envelope (yaw ±15°, HFOV 40–100°, roll ±10°), height and distance from `range`. */
function randomScene(seed: number, preset: 'pool9' | 'snooker12', range: PoseRange, extra: { cloth?: RGB; cueRow?: number } = {}): Scene {
  const r = rng(seed);
  const table = tables[preset];
  const balls = randomLayout(r, preset);
  const cue = balls[0]!.pos;
  const cands = balls.map((b, i) => ({ i, d: Math.hypot(b.pos.x - cue.x, b.pos.y - cue.y) })).filter((c) => c.i > 0 && c.d > 0.35 && c.d < 1.8);
  const targetIdx = cands.length ? cands[Math.floor(r() * cands.length)]!.i : 1;
  const p = { h: U(r, ...range.h), d: U(r, ...range.d), yaw: U(r, -15, 15), fov: U(r, 40, 100), roll: U(r, -10, 10), cueRow: U(r, 0.62, 0.82), heading: U(r, -4, 4) };
  const cam = playerViewCamera({
    cue,
    aimAt: balls[targetIdx]!.pos,
    distance: p.d,
    height: p.h,
    yawOffsetDeg: p.yaw,
    headingOffsetDeg: p.heading,
    cueRow: extra.cueRow ?? p.cueRow,
    fovDeg: p.fov,
    imageWidth: 960,
    imageHeight: 720,
    ballRadius: table.ballRadius,
    rollDeg: p.roll,
  });
  const name = `s${seed} ${preset} HFOV ${p.fov.toFixed(0)}° h ${p.h.toFixed(2)} d ${p.d.toFixed(2)} yaw ${p.yaw.toFixed(0)} roll ${p.roll.toFixed(0)}${extra.cloth ? ` cloth ${extra.cloth.join(',')}` : ''}`;
  return { name, table, balls, targetIdx, cam, W: 960, H: 720, ...(extra.cloth ? { cloth: extra.cloth } : {}) };
}

const ENVELOPE: PoseRange = { h: [0.08, 0.4], d: [0.3, 1.2] };
const fmt = (res: PlayerViewResult, e: Errors | null) => (res.ok ? `ok, ghost ${(100 * e!.ghost).toFixed(2)} %, dot ${e!.dot.toFixed(2)} R, confidence ${res.confidence.toFixed(2)}` : res.reason);

// --- SC-107 on grey cloth ------------------------------------------------------------------------------

describe('SC-107 on grey cloth: never an ok fit off tolerance', () => {
  /** Grey cloths: tint saturation S × value V × cool (bluish) or warm (brownish) tint. */
  const greys: RGB[] = [];
  for (const s of [0, 0.04, 0.08, 0.1, 0.12])
    for (const v of [100, 128, 155])
      for (const warm of [false, true]) {
        if (s === 0 && warm) continue;
        greys.push(warm ? [v, Math.round(v * (1 - s / 2)), Math.round(v * (1 - s))] : [Math.round(v * (1 - s)), Math.round(v * (1 - s / 2)), v]);
      }

  it('three scenes that once returned ok far off (a stripe taken for the cue ball, a red that is not in view, a wrong lens on a floor-grey candidate)', () => {
    const scenes: Scene[] = [
      {
        // A mostly white green stripe was matched as the cue ball, and two orange balls swapped with a
        // third orange out of view (pool repeats colours): ghost 6.0 %, camera 95 cm off.
        name: 's99049 pool9 HFOV 89° h 0.08 d 1.02 cloth 128,125,123',
        table: tables.pool9,
        balls: [
          { pos: { x: 0.369826, y: -0.040009 }, color: [245, 245, 238] },
          { pos: { x: -1.203028, y: 0.190204 }, color: [240, 110, 20] },
          { pos: { x: 1.167456, y: 0.359353 }, color: [240, 110, 20] },
          { pos: { x: 0.806373, y: -0.541078 }, color: [20, 110, 50], stripe: true },
          { pos: { x: 0.889634, y: 0.576712 }, color: [236, 190, 20], stripe: true },
          { pos: { x: 0.645065, y: 0.53498 }, color: [240, 110, 20], stripe: true },
          { pos: { x: -0.23158, y: 0.089169 }, color: [120, 20, 30], stripe: true },
        ],
        cam: { pos: { x: -0.609321, y: -0.310625, z: 0.081069 }, target: { x: 0.301592, y: 0.016211, z: 0.332894 }, fovDeg: 89.040777, rollDeg: 1.553132 },
        targetIdx: 2,
        W: 960,
        H: 720,
        cloth: [128, 125, 123],
      },
      {
        // The cue ball and "a red" with crossing cushion lines: the red matched was one of six, out of
        // view (snooker has up to 15): ghost 49 %, the camera turned 77°.
        name: 's99132 snooker12 HFOV 81° h 0.08 d 0.49 cloth 128,122,115',
        table: tables.snooker12,
        balls: [
          { pos: { x: -1.340537, y: -0.275542 }, color: [245, 245, 238] },
          { pos: { x: 1.521836, y: 0.250851 }, color: [200, 25, 30] },
          { pos: { x: 1.040815, y: -0.159321 }, color: [200, 25, 30] },
          { pos: { x: -1.722306, y: 0.363542 }, color: [200, 25, 30] },
          { pos: { x: 0.848916, y: -0.794356 }, color: [200, 25, 30] },
          { pos: { x: -0.787713, y: 0.264146 }, color: [200, 25, 30] },
          { pos: { x: 0.402875, y: -0.74423 }, color: [200, 25, 30] },
          { pos: { x: -1.617098, y: 0.398361 }, color: [236, 190, 20] },
          { pos: { x: 1.60352, y: 0.315818 }, color: [120, 70, 30] },
          { pos: { x: 1.29181, y: -0.287702 }, color: [20, 60, 170] },
          { pos: { x: 1.742319, y: 0.789596 }, color: [235, 120, 150] },
          { pos: { x: 0.815444, y: -0.683792 }, color: [18, 18, 20] },
          { pos: { x: -0.317606, y: 0.328221 }, color: [20, 110, 50] },
        ],
        cam: { pos: { x: -1.13792, y: -0.72647, z: 0.083412 }, target: { x: -1.598708, y: 0.122516, z: 0.342056 }, fovDeg: 81.21802, rollDeg: -4.542107 },
        targetIdx: 3,
        W: 960,
        H: 720,
        cloth: [128, 122, 115],
      },
      {
        // From 7 cm up with a 96° lens (the app's hint says 65°): the floor's grey (70, 70, 75) taken as
        // a cloth swallowed the shaded cloth, and three balls fitted a camera 35 cm off at twice the
        // focal length: ghost 7.1 %.
        name: 's101053 snooker12 HFOV 96° h 0.07 d 0.44 cloth 100,104,108',
        table: tables.snooker12,
        balls: [
          { pos: { x: -1.209581, y: 0.46613 }, color: [245, 245, 238] },
          { pos: { x: -1.67488, y: 0.805607 }, color: [200, 25, 30] },
          { pos: { x: -0.683599, y: 0.322482 }, color: [200, 25, 30] },
          { pos: { x: -0.360855, y: 0.252146 }, color: [200, 25, 30] },
          { pos: { x: -0.630159, y: -0.452907 }, color: [200, 25, 30] },
          { pos: { x: 1.481049, y: 0.13861 }, color: [200, 25, 30] },
          { pos: { x: -1.635213, y: 0.091197 }, color: [236, 190, 20] },
          { pos: { x: 0.548802, y: -0.062332 }, color: [120, 70, 30] },
          { pos: { x: -1.6807, y: 0.275315 }, color: [20, 60, 170] },
          { pos: { x: 1.709595, y: -0.497982 }, color: [20, 110, 50] },
        ],
        cam: { pos: { x: -0.866981, y: 0.184963, z: 0.066162 }, target: { x: -1.619421, y: 0.722539, z: 0.446746 }, fovDeg: 96.014586, rollDeg: -8.869027 },
        targetIdx: 1,
        W: 960,
        H: 720,
        cloth: [100, 104, 108],
      },
    ];
    for (const sc of scenes) {
      const { frame } = render(sc);
      for (const extra of [{}, appHints(sc)]) {
        const res = run(sc, frame, extra);
        const e = res.pose ? errorsOf(sc, res.pose) : null;
        const label = `${sc.name}${'clothHint' in extra ? ' (app hints)' : ''}: ${fmt(res, e)}`;
        if (res.ok) expect(within(e!), label).toBe(true);
        else expect([PLAYER_VIEW_REASONS.dark, PLAYER_VIEW_REASONS.moved, PLAYER_VIEW_REASONS.noCloth], label).not.toContain(res.reason);
      }
    }
  }, 120_000);

  it('random layouts on 27 greys from 8–14 cm up: no ok fit off tolerance, never "moved" or "too dark"', async () => {
    const rows: string[] = [];
    let good = 0;
    let n = 0;
    for (let i = 0; i < greys.length; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      const sc = randomScene(310_000 + i, i % 2 ? 'snooker12' : 'pool9', { h: [0.08, 0.14], d: [0.3, 1.2] }, { cloth: greys[i]! });
      const r = render(sc);
      for (const extra of [{}, appHints(sc)]) {
        const res = run(sc, r.frame, extra);
        const e = res.pose ? errorsOf(sc, res.pose) : null;
        if (r.cueInView && r.inView >= 3) {
          n++;
          if (res.ok && within(e!)) good++;
        }
        rows.push(`  ${sc.name}${'clothHint' in extra ? ' (hints)' : ''}: ${fmt(res, e)}`);
        if (res.ok) expect(within(e!), rows[rows.length - 1]).toBe(true);
        else expect([PLAYER_VIEW_REASONS.dark, PLAYER_VIEW_REASONS.moved], rows[rows.length - 1]).not.toContain(res.reason);
      }
    }
    console.log(`grey cloths, random layouts from 8–14 cm: ${good}/${n} runs with enough evidence fit within tolerance\n${rows.join('\n')}`);
  }, 600_000);
});

// --- FR-121 after a shot -------------------------------------------------------------------------------

/** The table after a shot: the cue ball moved 10–40 cm, the target (or another ball) 5–30 cm, and half the time one more ball. */
function afterShot(sc: Scene, seed: number, withTarget: boolean): SynthBall[] {
  const g = rng(seed);
  const now = sc.balls.map((b) => ({ ...b }));
  const moveOne = (j: number, a0: number, a1: number) => {
    for (let t = 0; t < 30; t++) {
      const a = g() * 2 * Math.PI;
      const d = U(g, a0, a1);
      const p = { x: sc.balls[j]!.pos.x + d * Math.cos(a), y: sc.balls[j]!.pos.y + d * Math.sin(a) };
      if (free(sc.table, now, p, j)) {
        now[j] = { ...now[j]!, pos: p };
        return;
      }
    }
  };
  moveOne(0, 0.1, 0.4);
  const others = sc.balls.map((_, j) => j).filter((j) => j > 0 && j !== sc.targetIdx);
  if (withTarget) moveOne(sc.targetIdx, 0.05, 0.3);
  else moveOne(others[Math.floor(g() * others.length)]!, 0.05, 0.3);
  if (g() < 0.5 && others.length > 1) moveOne(others[Math.floor(g() * others.length)]!, 0.05, 0.3);
  return now;
}

describe('FR-121 after a shot: "moved", or an ok whose guide is still right — never an ok with a wrong guide', () => {
  /** Verdict of a photo of `now` fitted with the overview's layout `sc.balls`. */
  function verdict(sc: Scene, now: SynthBall[], extra: Partial<PlayerViewInput>): string {
    const shot: Scene = { ...sc, balls: now };
    const res = run(sc, render(shot).frame, extra);
    if (!res.ok) return res.reason === PLAYER_VIEW_REASONS.moved ? 'moved' : `other (${res.reason})`;
    const e = errorsOf(shot, res.pose!, sc.balls);
    return within(e) ? 'okRight' : `okWrong (ghost ${(100 * e.ghost).toFixed(2)} %, dot ${e.dot.toFixed(2)} R, confidence ${res.confidence.toFixed(2)})`;
  }

  it('three shots that once gave ok with the guide 2.3–3.7 % off (pose lined up on the moved balls)', () => {
    // From an independent random-layout sweep (seeds 82004, 82019, 82030): the cue ball and 1–2 balls
    // moved; a wrong pose put the layout's moved balls on their new circles and left a ball predicted on
    // bare cloth with a circle of its colour resting elsewhere.
    const cases: { sc: Scene; now: SynthBall[] }[] = SHOTS.map((s) => ({
      sc: { name: s.name, table: tables[s.preset], balls: s.base, targetIdx: s.targetIdx, cam: s.cam, W: 960, H: 720 },
      now: s.now,
    }));
    for (const { sc, now } of cases)
      for (const extra of [{}, appHints(sc)]) {
        const v = verdict(sc, now, extra);
        expect(v.startsWith('okWrong'), `${sc.name}${'clothHint' in extra ? ' (hints)' : ''}: ${v}`).toBe(false);
      }
  }, 120_000);

  it('random layouts and poses, a shot played since the table photo (cue ball + target, cue ball + another ball)', async () => {
    const rows: string[] = [];
    let used = 0;
    for (let i = 0; used < 10 && i < 30; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      const sc = randomScene(320_000 + i, i % 2 ? 'snooker12' : 'pool9', ENVELOPE);
      const r0 = render(sc);
      if (!(r0.cueInView && r0.inView >= 3)) continue;
      used++;
      // The static table is no "moved" either.
      const st = run(sc, r0.frame);
      expect(st.reason, `${sc.name} static`).not.toBe(PLAYER_VIEW_REASONS.moved);
      for (const withTarget of [true, false]) {
        const now = afterShot(sc, 7 * (320_000 + i) + (withTarget ? 1 : 2), withTarget);
        const v = verdict(sc, now, {});
        rows.push(`  ${sc.name} ${withTarget ? 'cue + target' : 'cue + other'}: ${v}`);
        expect(v.startsWith('okWrong'), rows[rows.length - 1]).toBe(false);
      }
    }
    console.log(`after a shot (${used} random scenes):\n${rows.join('\n')}`);
    expect(used).toBe(10);
  }, 600_000);
});

// --- "too grainy" only when noise is the cause --------------------------------------------------------------

describe('"too grainy" names the cause only when the noise is what defeats the fit', () => {
  it('the cue ball out of frame, three or more other balls in view, σ 5–7 noise: the reason is still the missing cue ball, not the grain', async () => {
    const rows: string[] = [];
    let used = 0;
    for (let i = 0; used < 4 && i < 30; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      const sc = randomScene(330_000 + i, i % 2 ? 'snooker12' : 'pool9', { h: [0.15, 0.4], d: [0.4, 1.0] }, { cueRow: 1.3 });
      const r = render(sc);
      if (r.cueInView || r.othersInView < 3) continue;
      used++;
      for (const sigma of [5, 6, 7]) {
        const res = run(sc, noisy(r.frame, sigma, 1000 * i + sigma), appHints(sc));
        rows.push(`  ${sc.name} σ ${sigma}: ${res.ok ? 'ok' : res.reason}`);
        expect(res.ok, rows[rows.length - 1]).toBe(false);
        expect([PLAYER_VIEW_REASONS.noCue, PLAYER_VIEW_REASONS.noFit], rows[rows.length - 1]).toContain(res.reason);
      }
    }
    console.log(`cue ball out of frame under noise:\n${rows.join('\n')}`);
    expect(used).toBe(4);
  }, 300_000);

  it('cloth texture on a clean sensor (renderer texture 0.12 and 0.2) is not sensor noise: never "too grainy"', async () => {
    for (let i = 0; i < 3; i++)
      for (const texture of [0.12, 0.2]) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        const base = randomScene(340_000 + i, i % 2 ? 'snooker12' : 'pool9', ENVELOPE);
        // The full layout, and only the cue ball and the target (a photo that may well fail, for other reasons).
        for (const sc of [base, { ...base, balls: [base.balls[0]!, base.balls[base.targetIdx]!], targetIdx: 1 }]) {
          const textured: Scene = { ...sc, texture };
          const r = render(textured);
          for (const extra of [{}, appHints(textured)]) {
            const res = run(textured, r.frame, extra);
            expect(res.reason, `${sc.name} texture ${texture}, ${sc.balls.length} balls`).not.toBe(PLAYER_VIEW_REASONS.noisy);
          }
        }
      }
  }, 300_000);
});

// --- photos that fail stay inside the budget --------------------------------------------------------------

describe('photos that fail stay inside the per-photo budget', () => {
  const photos: { sc: Scene; frame: Frame; layout: SynthBall[]; cat: string }[] = [];
  beforeAll(async () => {
    for (let i = 0; i < 10; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      const preset = i % 2 ? 'snooker12' : 'pool9';
      // Untinted and low-tint grey (S ≤ 0.08): where the cue ball is often lost and every candidate is tried.
      const grey = randomScene(350_000 + i, preset, ENVELOPE, { cloth: ([[128, 128, 128], [120, 118, 112], [100, 104, 108], [118, 123, 128], [155, 152, 149]] as RGB[])[i % 5]! });
      photos.push({ sc: grey, frame: render(grey).frame, layout: grey.balls, cat: 'grey' });
      // The cue ball moved 12–15 cm sideways since the table photo.
      const sc = randomScene(360_000 + i, preset, ENVELOPE);
      const cue = sc.balls[0]!.pos;
      const tg = sc.balls[sc.targetIdx]!.pos;
      const L = Math.hypot(tg.x - cue.x, tg.y - cue.y);
      const off = i % 2 ? 0.12 : -0.15;
      const now = sc.balls.map((b, j) => (j === 0 ? { ...b, pos: { x: cue.x - (off * (tg.y - cue.y)) / L, y: cue.y + (off * (tg.x - cue.x)) / L } } : b));
      photos.push({ sc, frame: render({ ...sc, balls: now }).frame, layout: sc.balls, cat: 'cueMoved' });
      // The cue ball below the frame.
      const out = randomScene(370_000 + i, preset, ENVELOPE, { cueRow: 1.3 });
      photos.push({ sc: out, frame: render(out).frame, layout: out.balls, cat: 'cueOut' });
    }
  }, 600_000);

  it('< 250 ms CPU at the 95th percentile over untinted grey, moved-cue-ball and cue-out-of-frame photos (960 × 720)', () => {
    for (const p of photos.slice(0, 4)) run(p.sc, p.frame, appHints(p.sc), p.layout);
    const t: number[] = [];
    const by: Record<string, number[]> = {};
    let failed = 0;
    for (const p of photos)
      for (const extra of [appHints(p.sc), {}]) {
        const c0 = process.cpuUsage();
        const res = run(p.sc, p.frame, extra, p.layout);
        const c = process.cpuUsage(c0);
        const ms = (c.user + c.system) / 1000;
        t.push(ms);
        (by[p.cat] ??= []).push(ms);
        if (!res.ok) failed++;
      }
    const q = (xs: number[], p: number) => xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))]!;
    console.log(
      `player-view 960×720 CPU on photos that mostly fail (${failed}/${t.length} runs fail): median ${q(t, 0.5).toFixed(0)} ms, p95 ${q(t, 0.95).toFixed(0)} ms, max ${Math.max(...t).toFixed(0)} ms; ${Object.entries(by)
        .map(([k, xs]) => `${k} p95 ${q(xs, 0.95).toFixed(0)}`)
        .join(', ')}`,
    );
    expect(failed).toBeGreaterThanOrEqual(0.4 * t.length);
    expect(q(t, 0.95)).toBeLessThan(250);
  });
});

/** Three shots from an independent random-layout sweep (seeds 82004, 82019, 82030), as literals. */
const SHOTS: { name: string; preset: 'pool9' | 'snooker12'; cam: SynthCamera; targetIdx: number; base: SynthBall[]; now: SynthBall[] }[] = [
  {
    name: 's82004 pool9 cue + other (the cue ball and b2, b3 moved)',
    preset: 'pool9',
    cam: { pos: { x: 1.343881, y: 0.268404, z: 0.090479 }, target: { x: 0.393587, y: -0.029692, z: 0.180368 }, fovDeg: 85.641312, rollDeg: 7.121602 },
    targetIdx: 6,
    base: [
      { pos: { x: 0.762618, y: 0.145147 }, color: [245, 245, 238] },
      { pos: { x: -0.964939, y: 0.128775 }, color: [20, 110, 50] },
      { pos: { x: -1.203367, y: 0.538624 }, color: [240, 110, 20], stripe: true },
      { pos: { x: -0.816721, y: 0.533066 }, color: [240, 110, 20] },
      { pos: { x: -0.149445, y: 0.044817 }, color: [240, 110, 20], stripe: true },
      { pos: { x: 1.025039, y: -0.189452 }, color: [20, 110, 50] },
      { pos: { x: 0.367721, y: 0.019148 }, color: [236, 190, 20] },
    ],
    now: [
      { pos: { x: 0.500032, y: 0.242203 }, color: [245, 245, 238] },
      { pos: { x: -0.964939, y: 0.128775 }, color: [20, 110, 50] },
      { pos: { x: -1.152894, y: 0.376394 }, color: [240, 110, 20], stripe: true },
      { pos: { x: -0.519535, y: 0.517156 }, color: [240, 110, 20] },
      { pos: { x: -0.149445, y: 0.044817 }, color: [240, 110, 20], stripe: true },
      { pos: { x: 1.025039, y: -0.189452 }, color: [20, 110, 50] },
      { pos: { x: 0.367721, y: 0.019148 }, color: [236, 190, 20] },
    ],
  },
  {
    name: 's82019 snooker12 cue + target (the cue ball and b10 moved)',
    preset: 'snooker12',
    cam: { pos: { x: -0.457229, y: 0.69779, z: 0.081837 }, target: { x: -1.093159, y: -0.03662, z: 0.318978 }, fovDeg: 75.264146, rollDeg: 0.693656 },
    targetIdx: 10,
    base: [
      { pos: { x: -1.120155, y: 0.041539 }, color: [245, 245, 238] },
      { pos: { x: 1.117184, y: -0.450427 }, color: [200, 25, 30] },
      { pos: { x: 1.560446, y: 0.611068 }, color: [200, 25, 30] },
      { pos: { x: -1.145962, y: 0.389249 }, color: [200, 25, 30] },
      { pos: { x: 1.432382, y: 0.436335 }, color: [200, 25, 30] },
      { pos: { x: 0.099859, y: -0.356023 }, color: [200, 25, 30] },
      { pos: { x: -1.153445, y: -0.756425 }, color: [200, 25, 30] },
      { pos: { x: 1.284749, y: -0.100774 }, color: [200, 25, 30] },
      { pos: { x: -1.127365, y: -0.27013 }, color: [200, 25, 30] },
      { pos: { x: 0.072215, y: -0.161981 }, color: [200, 25, 30] },
      { pos: { x: -1.624181, y: -0.483697 }, color: [200, 25, 30] },
      { pos: { x: -1.709876, y: -0.496458 }, color: [200, 25, 30] },
      { pos: { x: 0.506946, y: 0.706187 }, color: [236, 190, 20] },
      { pos: { x: 1.719905, y: -0.475819 }, color: [120, 70, 30] },
      { pos: { x: -0.975157, y: -0.133406 }, color: [20, 60, 170] },
      { pos: { x: -1.401523, y: -0.300949 }, color: [18, 18, 20] },
      { pos: { x: -0.415972, y: 0.527033 }, color: [20, 110, 50] },
    ],
    now: [
      { pos: { x: -1.497313, y: -0.05811 }, color: [245, 245, 238] },
      { pos: { x: 1.117184, y: -0.450427 }, color: [200, 25, 30] },
      { pos: { x: 1.560446, y: 0.611068 }, color: [200, 25, 30] },
      { pos: { x: -1.145962, y: 0.389249 }, color: [200, 25, 30] },
      { pos: { x: 1.432382, y: 0.436335 }, color: [200, 25, 30] },
      { pos: { x: 0.099859, y: -0.356023 }, color: [200, 25, 30] },
      { pos: { x: -1.153445, y: -0.756425 }, color: [200, 25, 30] },
      { pos: { x: 1.284749, y: -0.100774 }, color: [200, 25, 30] },
      { pos: { x: -1.127365, y: -0.27013 }, color: [200, 25, 30] },
      { pos: { x: 0.072215, y: -0.161981 }, color: [200, 25, 30] },
      { pos: { x: -1.390131, y: -0.376706 }, color: [200, 25, 30] },
      { pos: { x: -1.709876, y: -0.496458 }, color: [200, 25, 30] },
      { pos: { x: 0.506946, y: 0.706187 }, color: [236, 190, 20] },
      { pos: { x: 1.719905, y: -0.475819 }, color: [120, 70, 30] },
      { pos: { x: -0.975157, y: -0.133406 }, color: [20, 60, 170] },
      { pos: { x: -1.401523, y: -0.300949 }, color: [18, 18, 20] },
      { pos: { x: -0.415972, y: 0.527033 }, color: [20, 110, 50] },
    ],
  },
  {
    name: 's82030 pool9 cue + other (the cue ball and b1 moved)',
    preset: 'pool9',
    cam: { pos: { x: -1.144772, y: 0.949864, z: 0.331842 }, target: { x: -0.982913, y: -0.036392, z: 0.365023 }, fovDeg: 96.310758, rollDeg: -1.751349 },
    targetIdx: 5,
    base: [
      { pos: { x: -1.124735, y: 0.160718 }, color: [245, 245, 238] },
      { pos: { x: -0.031821, y: -0.179741 }, color: [236, 190, 20] },
      { pos: { x: 0.475369, y: -0.414518 }, color: [240, 110, 20], stripe: true },
      { pos: { x: -0.510811, y: -0.577256 }, color: [240, 110, 20] },
      { pos: { x: 0.795513, y: 0.460715 }, color: [90, 30, 130] },
      { pos: { x: -0.991524, y: -0.408063 }, color: [240, 110, 20] },
      { pos: { x: 1.028111, y: -0.52227 }, color: [18, 18, 20] },
      { pos: { x: 0.684646, y: 0.346762 }, color: [200, 25, 30], stripe: true },
    ],
    now: [
      { pos: { x: -0.990757, y: 0.179954 }, color: [245, 245, 238] },
      { pos: { x: -0.017551, y: 0.04785 }, color: [236, 190, 20] },
      { pos: { x: 0.475369, y: -0.414518 }, color: [240, 110, 20], stripe: true },
      { pos: { x: -0.510811, y: -0.577256 }, color: [240, 110, 20] },
      { pos: { x: 0.795513, y: 0.460715 }, color: [90, 30, 130] },
      { pos: { x: -0.991524, y: -0.408063 }, color: [240, 110, 20] },
      { pos: { x: 1.028111, y: -0.52227 }, color: [18, 18, 20] },
      { pos: { x: 0.684646, y: 0.346762 }, color: [200, 25, 30], stripe: true },
    ],
  },
];
