/**
 * The Snap player-photo fit over the spec 002 envelope (SC-106, SC-107, edge cases "different zoom
 * between the two photos" and grey cloth), on ray-traced table-level photos with exact ground truth.
 *
 * Scenes: per resolution (960×720 and 1280×960), an L18 orthogonal array (2¹ × 3⁷, strength 2) over
 * table (pool9 / snooker12), HFOV 40/65/100°, camera height 8/20/40 cm, distance 0.3/0.75/1.2 m behind
 * the cue ball, yaw −15/0/+15° off the aim line, roll −10/0/+10° and occlusion (none / a ball partly in
 * front of the target / a ball partly behind the cue ball), so every pair of levels is covered. The
 * two resolutions use different column assignments; the 960 × 720 rows are repeated with a fourth
 * occlusion level, a ball partly in front of the cue ball. Each photo is fitted twice: without hints,
 * and with what the app passes (the overview's cloth and a 1× (65°) focal length — a lens change for
 * the 40° and 100° photos). The per-photo CPU time is guarded at the 95th percentile.
 *
 * Further suites: lens changes, grey cloths (tinted, low-tint and untinted), light chromatic cloths, a
 * stripe ball that shows only white, exposure / noise / 4:2:0, layout error, balls moved since the
 * table photo (FR-121), and reasons that name the true cause.
 *
 * "Enough evidence" is ground truth from the renderer: the cue ball and at least two more balls each
 * have ≥ 50 % of their disc visible (not hidden by nearer balls, rails or the frame edge), an image
 * radius ≥ 3 px and a colour distinct from the cloth. On those scenes the fit must succeed in ≥ 90 % of
 * runs within the SC-106 tolerance (ghost-ball centre ≤ 1.5 % of the diagonal, strike dot ≤ 0.1 R).
 * On every scene, no `ok` may be outside that tolerance, and every failure carries a canonical reason
 * that names the true cause.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { makeTable } from '../../src/core/table';
import type { TableSpec } from '../../src/core/types';
import { rgbToHsv, type Frame } from '../../src/vision/image';
import { estimatePlayerView, PLAYER_VIEW_REASONS, projectPoint, strikePoint, type CameraPose, type KnownBall, type PlayerViewInput, type PlayerViewResult } from '../../src/vision/player-view';
import { BALL_COLORS, cameraModel, fixtureBalls, playerViewCamera, renderSyntheticTable, type RGB, type SynthBall, type SynthCamera } from '../../src/vision/synth/render';
import type { ClothModel } from '../../src/vision/table-detect';

// --- ground truth -----------------------------------------------------------------------------------

function poseOf(cam: SynthCamera, width: number, height: number): CameraPose {
  const m = cameraModel(cam, width, height);
  const R = [m.R[0].x, m.R[0].y, m.R[0].z, m.R[1].x, m.R[1].y, m.R[1].z, m.R[2].x, m.R[2].y, m.R[2].z];
  const C = m.C;
  const t = { x: -(R[0]! * C.x + R[1]! * C.y + R[2]! * C.z), y: -(R[3]! * C.x + R[4]! * C.y + R[5]! * C.z), z: -(R[6]! * C.x + R[7]! * C.y + R[8]! * C.z) };
  return { R, t, f: m.f, cx: width / 2, cy: height / 2, width, height };
}

/** Ghost-ball centre for potting `target` into the pocket that suits a shot from `cue` best. */
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

interface Errors {
  /** Ghost-ball centre error / image diagonal. */
  ghost: number;
  /** Largest strike-dot error (centre ball and ±0.4 R offsets) on the ball's face, in units of R. */
  dot: number;
}

/**
 * Errors of what the app draws with `pose` (ghost ball and strike points from the layout it was given,
 * `layout`, by default the true positions) against the truth drawn with the true camera.
 */
function errorsOf(sc: Scene, pose: CameraPose, layout?: KnownBall[]): Errors {
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

// --- scenes -----------------------------------------------------------------------------------------

const tables: Record<'pool9' | 'snooker12', TableSpec> = { pool9: makeTable('pool9'), snooker12: makeTable('snooker12') };

function snookerBalls(table: TableSpec): SynthBall[] {
  const R = table.ballRadius;
  const C = BALL_COLORS;
  const out: SynthBall[] = [{ pos: { x: -1.25, y: 0.2 }, color: C.cue! }];
  for (let row = 0; row < 5; row++) for (let i = 0; i <= row; i++) out.push({ pos: { x: 0.95 + row * R * Math.sqrt(3) * 1.002, y: (i - row / 2) * 2 * R * 1.002 }, color: C.red! });
  out.push({ pos: { x: -1.05, y: -0.29 }, color: C.yellow! });
  out.push({ pos: { x: -1.05, y: 0.29 }, color: [20, 110, 50] }); // green: invisible on green cloth
  out.push({ pos: { x: -1.05, y: 0 }, color: C.brown! });
  out.push({ pos: { x: 0, y: 0 }, color: C.blue! });
  out.push({ pos: { x: 0.85, y: 0 }, color: C.pink! });
  out.push({ pos: { x: 1.47, y: 0 }, color: C.black! });
  return out;
}

type Occlusion = 'none' | 'target' | 'behindCue' | 'frontCue';

interface Scene {
  name: string;
  table: TableSpec;
  balls: SynthBall[];
  targetIdx: number;
  cam: SynthCamera;
  W: number;
  H: number;
  cloth?: RGB;
  floor?: RGB;
}

const isFree = (balls: SynthBall[], p: { x: number; y: number }, table: TableSpec) =>
  Math.abs(p.x) < table.length / 2 - table.ballRadius && Math.abs(p.y) < table.width / 2 - table.ballRadius && balls.every((b) => Math.hypot(b.pos.x - p.x, b.pos.y - p.y) > 2.05 * table.ballRadius);

/**
 * Adds a ball partly in front of the target (on the camera's line of sight), partly behind the cue ball,
 * or partly in front of the cue ball (between the camera and the cue ball: its outline cuts the cue
 * ball's, and the two touch in the image).
 */
function occlude(balls: SynthBall[], occ: Occlusion, cam: { x: number; y: number }, targetIdx: number, table: TableSpec): SynthBall[] {
  if (occ === 'none') return balls;
  const R = table.ballRadius;
  const out = balls.slice();
  const anchor = occ === 'target' ? balls[targetIdx]!.pos : balls[0]!.pos;
  const L = Math.hypot(anchor.x - cam.x, anchor.y - cam.y);
  const ux = (anchor.x - cam.x) / L;
  const uy = (anchor.y - cam.y) / L;
  const along = occ === 'target' ? [-0.22, -0.3, -0.38, -0.16] : occ === 'frontCue' ? [-0.1, -0.15, -0.2, -0.07] : [0.14, 0.2, 0.26];
  const sides = occ === 'target' ? [1.3, -1.3, 1.6, -1.6] : occ === 'frontCue' ? [1.3, -1.3, 1.7, -1.7] : [1.1, -1.1, 1.5, -1.5];
  const color = occ === 'target' ? BALL_COLORS.orange! : occ === 'frontCue' ? BALL_COLORS.red! : BALL_COLORS.purple!;
  for (const a of along)
    for (const s of sides) {
      const p = { x: anchor.x + ux * a - uy * s * R, y: anchor.y + uy * a + ux * s * R };
      if (isFree(out, p, table)) {
        out.push({ pos: p, color });
        return out;
      }
    }
  return out;
}

interface Params {
  preset: 'pool9' | 'snooker12';
  W: number;
  H: number;
  fov: number;
  h: number;
  d: number;
  yaw?: number;
  roll?: number;
  occ?: Occlusion;
  cloth?: RGB;
  floor?: RGB;
}

function scene(p: Params): Scene {
  const table = tables[p.preset];
  const base = p.preset === 'pool9' ? fixtureBalls(table).balls : snookerBalls(table);
  const targetIdx = p.preset === 'pool9' ? 1 : 19;
  const cam = playerViewCamera({
    cue: base[0]!.pos,
    aimAt: base[targetIdx]!.pos,
    distance: p.d,
    height: p.h,
    yawOffsetDeg: p.yaw ?? 0,
    cueRow: 0.72,
    fovDeg: p.fov,
    imageWidth: p.W,
    imageHeight: p.H,
    ballRadius: table.ballRadius,
    ...(p.roll ? { rollDeg: p.roll } : {}),
  });
  const balls = occlude(base, p.occ ?? 'none', cam.pos, targetIdx, table);
  const name = `${p.preset} ${p.W}×${p.H} HFOV ${p.fov}° h ${p.h} m d ${p.d} m yaw ${p.yaw ?? 0}° roll ${p.roll ?? 0}° ${p.occ ?? 'none'}${p.cloth ? ` cloth ${p.cloth.join(',')}` : ''}${p.floor ? ` floor ${p.floor.join(',')}` : ''}`;
  return { name, table, balls, targetIdx, cam, W: p.W, H: p.H, ...(p.cloth ? { cloth: p.cloth } : {}), ...(p.floor ? { floor: p.floor } : {}) };
}

interface Rendered {
  frame: Frame;
  /** Balls in view (ground truth), the cue ball included. */
  inView: number;
  cueInView: boolean;
  /** Balls with at least a quarter of their disc in view (partly hidden or cut by the frame edge). */
  partlyInView: number;
}

function render(sc: Scene): Rendered {
  const area = new Float64Array(sc.balls.length);
  const frame = renderSyntheticTable({ table: sc.table, balls: sc.balls, camera: sc.cam, width: sc.W, height: sc.H, ss: 2, ballArea: area, ...(sc.cloth ? { cloth: sc.cloth } : {}), ...(sc.floor ? { floor: sc.floor } : {}) });
  const m = cameraModel(sc.cam, sc.W, sc.H);
  const R = sc.table.ballRadius;
  const cloth = sc.cloth ?? [40, 130, 70];
  let inView = 0;
  let cueInView = false;
  let partlyInView = 0;
  sc.balls.forEach((b, k) => {
    const P = { x: b.pos.x - m.C.x, y: b.pos.y - m.C.y, z: R - m.C.z };
    const D = Math.hypot(P.x, P.y, P.z);
    const z = m.R[2].x * P.x + m.R[2].y * P.y + m.R[2].z * P.z;
    if (z <= 0) return;
    const rPx = ((m.f * R) / Math.sqrt(D * D - R * R)) * (D / z);
    const visible = area[k]! / (Math.PI * rPx * rPx) >= 0.5 && rPx >= 3;
    const camo = Math.abs(b.color[0] - cloth[0]) + Math.abs(b.color[1] - cloth[1]) + Math.abs(b.color[2] - cloth[2]) < 60;
    if (visible && !camo) inView++;
    if (k === 0 && visible) cueInView = true;
    if (area[k]! / (Math.PI * rPx * rPx) >= 0.25 && rPx >= 3 && !camo) partlyInView++;
  });
  return { frame, inView, cueInView, partlyInView };
}

const knownOf = (balls: SynthBall[]): KnownBall[] => balls.map((b, i) => ({ id: i === 0 ? 'cue' : `b${i}`, pos: b.pos, isCue: i === 0, rgb: b.color }));

function run(sc: Scene, frame: Frame, extra: Partial<PlayerViewInput> = {}): PlayerViewResult {
  return estimatePlayerView({ frame, table: sc.table, balls: knownOf(sc.balls), cueId: 'cue', targetId: `b${sc.targetIdx}`, ...extra });
}

/** What the app passes: the overview's cloth model (VisionResult.cloth) and the overview's focal length. */
function appHints(sc: Scene, overviewHfov = 65): Partial<PlayerViewInput> {
  const rgb = sc.cloth ?? [40, 130, 70];
  const hsv = [0, 0, 0];
  rgbToHsv(rgb[0], rgb[1], rgb[2], hsv);
  // A lit overview reads the cloth at ≈ 0.9 of its base value; a grey cloth is a neutral model.
  const clothHint: ClothModel = hsv[1]! < 0.2 ? { hue: 0, sat: hsv[1]!, val: 0.9 * hsv[2]!, kind: 'neutral' } : { hue: hsv[0]!, sat: hsv[1]!, val: 0.9 * hsv[2]!, kind: 'chromatic' };
  return { clothHint, focalPx: sc.W / 2 / Math.tan((overviewHfov * Math.PI) / 360) };
}

const REASONS = new Set<string>(Object.values(PLAYER_VIEW_REASONS));
const within = (e: Errors) => e.ghost <= 0.015 && e.dot <= 0.1;

// --- the envelope -----------------------------------------------------------------------------------

/** Taguchi L18 (2¹ × 3⁷): column 0 has 2 levels, columns 1–7 have 3 (0-based levels). */
const L18 = [
  [0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 1, 1, 1, 1, 1, 1],
  [0, 0, 2, 2, 2, 2, 2, 2],
  [0, 1, 0, 0, 1, 1, 2, 2],
  [0, 1, 1, 1, 2, 2, 0, 0],
  [0, 1, 2, 2, 0, 0, 1, 1],
  [0, 2, 0, 1, 0, 2, 1, 2],
  [0, 2, 1, 2, 1, 0, 2, 0],
  [0, 2, 2, 0, 2, 1, 0, 1],
  [1, 0, 0, 2, 2, 1, 1, 0],
  [1, 0, 1, 0, 0, 2, 2, 1],
  [1, 0, 2, 1, 1, 0, 0, 2],
  [1, 1, 0, 1, 2, 0, 2, 1],
  [1, 1, 1, 2, 0, 1, 0, 2],
  [1, 1, 2, 0, 1, 2, 1, 0],
  [1, 2, 0, 2, 1, 2, 0, 1],
  [1, 2, 1, 0, 2, 0, 1, 2],
  [1, 2, 2, 1, 0, 1, 2, 0],
];
const FOV = [40, 65, 100];
const HEIGHT = [0.08, 0.2, 0.4];
const DIST = [0.3, 0.75, 1.2];
const YAW = [-15, 0, 15];
const ROLL = [-10, 0, 10];
const OCC: Occlusion[] = ['none', 'target', 'behindCue'];

/** Column assignment (fov, height, distance, yaw, roll, occlusion) per resolution. */
const GRID: Scene[] = (
  [
    [960, 720, [1, 2, 3, 4, 5, 6]],
    [1280, 960, [3, 4, 5, 6, 7, 1]],
  ] as const
).flatMap(([W, H, cols]) =>
  L18.map((row) =>
    scene({
      preset: row[0] ? 'snooker12' : 'pool9',
      W,
      H,
      fov: FOV[row[cols[0]]!]!,
      h: HEIGHT[row[cols[1]]!]!,
      d: DIST[row[cols[2]]!]!,
      yaw: YAW[row[cols[3]]!]!,
      roll: ROLL[row[cols[4]]!]!,
      occ: OCC[row[cols[5]]!]!,
    }),
  ),
);
/**
 * A fourth occlusion level, a ball partly in front of the cue ball, over the 960 × 720 rows (only the
 * occlusion column changes, so every pair of the other levels is covered again with it).
 */
const FRONT: Scene[] = L18.map((row) =>
  scene({ preset: row[0] ? 'snooker12' : 'pool9', W: 960, H: 720, fov: FOV[row[1]!]!, h: HEIGHT[row[2]!]!, d: DIST[row[3]!]!, yaw: YAW[row[4]!]!, roll: ROLL[row[5]!]!, occ: 'frontCue' }),
);
const ENVELOPE: Scene[] = [...GRID, ...FRONT];

interface Run {
  sc: Scene;
  hints: boolean;
  enough: boolean;
  /** Three or more balls are at least partly in view (≥ ¼ of the disc), though fewer than enough. */
  partlyEnough: boolean;
  res: PlayerViewResult;
  err: Errors | null;
}

describe('SC-106 / SC-107: the player-photo fit over the spec envelope', () => {
  const runs: Run[] = [];
  /** The 960 × 720 photos, kept for the timing guard. */
  const frames960: { sc: Scene; frame: Frame }[] = [];

  beforeAll(async () => {
    for (const sc of ENVELOPE) {
      // Yield between photos: a minute of synchronous work would starve the test runner's RPC.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const r = render(sc);
      if (sc.W === 960) frames960.push({ sc, frame: r.frame });
      const enough = r.cueInView && r.inView >= 3;
      for (const hints of [false, true]) {
        const res = run(sc, r.frame, hints ? appHints(sc) : {});
        runs.push({ sc, hints, enough, partlyEnough: r.partlyInView >= 3, res, err: res.pose ? errorsOf(sc, res.pose) : null });
      }
    }
  }, 600_000);

  it('succeeds within the SC-106 tolerance on ≥ 90 % of the photos that show enough balls', () => {
    const enough = runs.filter((r) => r.enough);
    const good = enough.filter((r) => r.res.ok && r.err && within(r.err));
    const rows = enough.filter((r) => !good.includes(r)).map((r) => `  ${r.sc.name}${r.hints ? ' (app hints)' : ''}: ${r.res.ok ? `ok, ghost ${(100 * r.err!.ghost).toFixed(2)} %, dot ${r.err!.dot.toFixed(3)} R` : r.res.reason}`);
    console.log(`player-view envelope: ${good.length}/${enough.length} runs succeed within tolerance (${enough.length / 2} photos with enough evidence of ${ENVELOPE.length})${rows.length ? `\n${rows.join('\n')}` : ''}`);
    expect(enough.length).toBeGreaterThanOrEqual(0.75 * runs.length);
    expect(good.length / enough.length).toBeGreaterThanOrEqual(0.9);
  });

  it('never reports ok outside the SC-106 tolerance (and so never beyond SC-107’s 3 %), on any photo', () => {
    for (const r of runs) {
      if (!r.res.ok) continue;
      expect(r.err, r.sc.name).not.toBeNull();
      expect(r.err!.ghost, `${r.sc.name}${r.hints ? ' (app hints)' : ''}`).toBeLessThanOrEqual(0.015);
      expect(r.err!.dot, `${r.sc.name}${r.hints ? ' (app hints)' : ''}`).toBeLessThanOrEqual(0.1);
      expect(r.res.confidence).toBeGreaterThanOrEqual(0.5);
    }
  });

  it('gives a canonical reason on every failure, and "can\'t see enough balls" / "can\'t find the cue ball" when the photo truly lacks them', () => {
    for (const r of runs) {
      if (r.res.ok) continue;
      expect(r.res.reason, r.sc.name).toBeDefined();
      expect(REASONS.has(r.res.reason!), `${r.sc.name}: ${r.res.reason}`).toBe(true);
      // These photos are lit, clean, show the cloth, and nothing moved: never "too dark", "too grainy",
      // "no cloth" or "moved".
      expect([PLAYER_VIEW_REASONS.dark, PLAYER_VIEW_REASONS.noisy, PLAYER_VIEW_REASONS.noCloth, PLAYER_VIEW_REASONS.moved], r.sc.name).not.toContain(r.res.reason);
      // Without enough evidence: too few balls, or no cue ball — or, when three or more balls are in view
      // but some only in part (behind a nearer ball, cut by the frame edge), no fit: the photo does show
      // balls, too little of them to pin the pose.
      if (!r.enough) expect([PLAYER_VIEW_REASONS.tooFewBalls, PLAYER_VIEW_REASONS.noCue, ...(r.partlyEnough ? [PLAYER_VIEW_REASONS.noFit] : [])], r.sc.name).toContain(r.res.reason);
      // A photo that shows the cue ball and two more balls never says "I can't see enough balls".
      if (r.enough) expect(r.res.reason, r.sc.name).not.toBe(PLAYER_VIEW_REASONS.tooFewBalls);
    }
  });

  it('a ball in front of the cue ball (cutting its outline) still fits within tolerance on ≥ 85 % of those photos', () => {
    const front = runs.filter((r) => r.enough && r.sc.name.endsWith('frontCue'));
    const good = front.filter((r) => r.res.ok && r.err && within(r.err));
    console.log(`player-view, a ball in front of the cue ball: ${good.length}/${front.length} runs within tolerance`);
    expect(front.length).toBeGreaterThanOrEqual(20);
    expect(good.length / front.length).toBeGreaterThanOrEqual(0.85);
  });

  // The budget is per photo (< 250 ms at 960 × 720), so the tail counts: the 95th percentile over the
  // envelope's 960 × 720 photos, in CPU time of this process (wall time on a shared CI machine measures
  // its other jobs), once the code is warm (a process's first fits run in the interpreter), with what
  // the app passes.
  it('fits a 960×720 photo in < 250 ms CPU at the 95th percentile over the envelope', () => {
    for (const { sc, frame } of frames960.slice(0, 4)) run(sc, frame, appHints(sc));
    const t: number[] = [];
    for (const { sc, frame } of frames960) {
      const c0 = process.cpuUsage();
      run(sc, frame, appHints(sc));
      const c = process.cpuUsage(c0);
      t.push((c.user + c.system) / 1000);
    }
    t.sort((a, b) => a - b);
    const q = (p: number) => t[Math.min(t.length - 1, Math.floor(p * t.length))]!;
    console.log(`player-view 960×720 CPU over ${t.length} envelope photos: median ${q(0.5).toFixed(0)} ms, p95 ${q(0.95).toFixed(0)} ms, max ${t[t.length - 1]!.toFixed(0)} ms`);
    expect(q(0.95)).toBeLessThan(250);
  });

  // Wall time is reported here (it includes the first, cold fits).
  it('reports the per-photo time over the envelope (median, p95)', () => {
    for (const W of [960, 1280]) {
      const t = runs
        .filter((r) => r.sc.W === W)
        .map((r) => r.res.ms)
        .sort((a, b) => a - b);
      const q = (p: number) => t[Math.min(t.length - 1, Math.floor(p * t.length))]!;
      console.log(`player-view ${W} px envelope: median ${q(0.5).toFixed(0)} ms, p95 ${q(0.95).toFixed(0)} ms, max ${t[t.length - 1]!.toFixed(0)} ms (${t.length} runs)`);
      expect(t.every((x) => Number.isFinite(x) && x > 0)).toBe(true);
    }
  });
});

// --- lens change between the two photos -------------------------------------------------------------

describe('a different lens for the player photo than for the table photo (edge case: focal length is a soft hint)', () => {
  // Phone lenses 0.5× / 1× / 2× / 3× ≈ HFOV 100° / 65° / 40° / 28°.
  const pairs: [number, number][] = [
    [100, 65],
    [40, 65],
    [28, 65],
    [65, 100],
    [65, 28],
    [28, 100],
    [100, 28],
  ];
  for (const [truth, overview] of pairs)
    it(`player photo at HFOV ${truth}°, table photo at ${overview}°`, () => {
      const sc = scene({ preset: 'pool9', W: 960, H: 720, fov: truth, h: 0.2, d: 0.6, yaw: 10 });
      const { frame } = render(sc);
      const res = run(sc, frame, appHints(sc, overview));
      expect(res.ok, res.reason).toBe(true);
      const e = errorsOf(sc, res.pose!);
      expect(e.ghost).toBeLessThanOrEqual(0.015);
      expect(e.dot).toBeLessThanOrEqual(0.1);
      expect(res.pose!.f / cameraModel(sc.cam, sc.W, sc.H).f).toBeCloseTo(1, 1);
    });
});

// --- grey (neutral) cloth ---------------------------------------------------------------------------

describe('grey cloth (VisionResult.cloth.kind === "neutral")', () => {
  const poses: Omit<Params, 'cloth'>[] = [
    { preset: 'pool9', W: 960, H: 720, fov: 65, h: 0.2, d: 0.6, yaw: 10 },
    { preset: 'snooker12', W: 960, H: 720, fov: 65, h: 0.3, d: 0.5, roll: -8 },
    { preset: 'pool9', W: 960, H: 720, fov: 40, h: 0.15, d: 0.9, yaw: -12, occ: 'target' },
  ];
  // Blue-grey and charcoal: tinted greys, as grey cloths are (the overview's neutral model).
  for (const cloth of [
    [110, 116, 124],
    [80, 86, 92],
  ] as RGB[])
    it(`cloth ${cloth.join(',')}: fits within tolerance with and without the neutral overview hint`, () => {
      for (const p of poses) {
        const sc = scene({ ...p, cloth });
        const { frame } = render(sc);
        for (const extra of [{}, appHints(sc)]) {
          const res = run(sc, frame, extra);
          expect(res.ok, `${sc.name}: ${res.reason}`).toBe(true);
          const e = errorsOf(sc, res.pose!);
          expect(e.ghost, sc.name).toBeLessThanOrEqual(0.015);
          expect(e.dot, sc.name).toBeLessThanOrEqual(0.1);
        }
      }
    });

  it('untinted light grey (the shaded cue ball has the cloth\'s own grey): never "too dark"; when the cue ball is lost, it says so and two taps give the pose', () => {
    const diag = Math.hypot(960, 720);
    for (const p of poses) {
      const sc = scene({ ...p, cloth: [150, 152, 155] });
      const { frame } = render(sc);
      const res = run(sc, frame, appHints(sc));
      if (res.ok) {
        expect(errorsOf(sc, res.pose!).ghost, sc.name).toBeLessThanOrEqual(0.015);
        continue;
      }
      expect([PLAYER_VIEW_REASONS.noCue, PLAYER_VIEW_REASONS.tooFewBalls], sc.name).toContain(res.reason);
      // The manual fallback (taps ≈ 1 % of the diagonal off the true centres), SC-108.
      const m = cameraModel(sc.cam, sc.W, sc.H);
      const R = sc.table.ballRadius;
      const cue = m.project({ x: sc.balls[0]!.pos.x, y: sc.balls[0]!.pos.y, z: R });
      const tgt = m.project({ x: sc.balls[sc.targetIdx]!.pos.x, y: sc.balls[sc.targetIdx]!.pos.y, z: R });
      const off = 0.007 * diag;
      const manual = run(sc, frame, { ...appHints(sc), manualTaps: { cue: { x: cue.x + off, y: cue.y - off }, target: { x: tgt.x - off, y: tgt.y + off } } });
      expect(manual.ok, `${sc.name} (taps): ${manual.reason}`).toBe(true);
      expect((errorsOf(sc, manual.pose!).ghost * Math.hypot(sc.W, sc.H)) / diag).toBeLessThan(0.025);
    }
  });

  it('nothing moved on a grey cloth: an unseen cue ball or a loose pose is never reported as "moved"', () => {
    // From the grey-cloth sweep: on untinted light grey the cue ball's shaded side reads as cloth, so
    // the right pose predicted it "on bare cloth" and said "moved"; on charcoal from a few cm up, poses
    // 20–40 cm off (two or four balls lined up, the cue ball nowhere) said "moved" too.
    const cases: Params[] = [
      { preset: 'pool9', W: 960, H: 720, fov: 100, h: 0.4, d: 0.75, yaw: 15, occ: 'behindCue', cloth: [150, 152, 155] },
      { preset: 'snooker12', W: 960, H: 720, fov: 65, h: 0.08, d: 1.2, yaw: -15, roll: -10, cloth: [80, 86, 92] },
      { preset: 'snooker12', W: 960, H: 720, fov: 100, h: 0.2, d: 1.2, yaw: 15, roll: -10, cloth: [80, 86, 92] },
    ];
    for (const p of cases) {
      const sc = scene(p);
      const { frame } = render(sc);
      for (const extra of [{}, appHints(sc)]) {
        const res = run(sc, frame, extra);
        if (res.ok) {
          const e = errorsOf(sc, res.pose!);
          expect(e.ghost, sc.name).toBeLessThanOrEqual(0.015);
          expect(e.dot, sc.name).toBeLessThanOrEqual(0.1);
        } else expect([PLAYER_VIEW_REASONS.moved, PLAYER_VIEW_REASONS.dark], `${sc.name}: ${res.reason}`).not.toContain(res.reason);
      }
    }
  });

  it('grey cloth on a red floor: the floor is not taken for the cloth, with or without the hint', () => {
    const sc = scene({ preset: 'pool9', W: 960, H: 720, fov: 65, h: 0.3, d: 0.5, cloth: [110, 116, 124], floor: [170, 40, 35] });
    const { frame } = render(sc);
    for (const extra of [{}, appHints(sc)]) {
      const res = run(sc, frame, extra);
      expect(res.ok, res.reason).toBe(true);
      expect(errorsOf(sc, res.pose!).ghost).toBeLessThanOrEqual(0.015);
    }
  });
});

// --- a camera behind the end rail ---------------------------------------------------------------------

describe('a camera a few cm above the bed, behind the end rail', () => {
  it('the cushion top cutting off the bottom of the cue ball does not bias the strike dot (≤ 0.05 R)', () => {
    // From 8 cm up and 1.2 m back the near cushion hides the bottom of the cue ball; read as the ball's
    // silhouette, that occlusion edge moved the drawn strike dot by ≈ 0.09 R.
    for (const [W, H, yaw, roll, occ] of [
      [960, 720, 0, 0, 'target'],
      [1280, 960, 15, 10, 'none'],
    ] as const) {
      const sc = scene({ preset: 'pool9', W, H, fov: 40, h: 0.08, d: 1.2, yaw, roll, occ });
      const { frame } = render(sc);
      const res = run(sc, frame);
      expect(res.ok, `${sc.name}: ${res.reason}`).toBe(true);
      const e = errorsOf(sc, res.pose!);
      expect(e.ghost, sc.name).toBeLessThanOrEqual(0.005);
      expect(e.dot, sc.name).toBeLessThanOrEqual(0.05);
    }
  });
});

// --- exposure, sensor noise, 4:2:0 chroma --------------------------------------------------------------

/** Deterministic perturbations of a rendered photo: exposure gain, per-channel noise, 4:2:0 chroma. */
function perturb(f: Frame, o: { gain?: number; noise?: number; chroma420?: boolean; seed?: number }): Frame {
  const { width: w, height: h } = f;
  const d = new Uint8ClampedArray(f.data.length);
  let s = o.seed ?? 4242;
  const gauss = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const u = (s + 1) / 4294967297;
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return Math.sqrt(-2 * Math.log(u)) * Math.cos((2 * Math.PI * s) / 4294967296);
  };
  for (let i = 0; i < d.length; i += 4) {
    for (let c = 0; c < 3; c++) d[i + c] = f.data[i + c]! * (o.gain ?? 1) + (o.noise ? o.noise * gauss() : 0);
    d[i + 3] = 255;
  }
  if (o.chroma420)
    for (let y = 0; y + 1 < h; y += 2)
      for (let x = 0; x + 1 < w; x += 2) {
        let cb = 0;
        let cr = 0;
        const Y: number[] = [];
        for (const [dx, dy] of [
          [0, 0],
          [1, 0],
          [0, 1],
          [1, 1],
        ] as const) {
          const i = ((y + dy) * w + x + dx) * 4;
          const R = d[i]!;
          const G = d[i + 1]!;
          const B = d[i + 2]!;
          Y.push(0.299 * R + 0.587 * G + 0.114 * B);
          cb += (-0.168736 * R - 0.331264 * G + 0.5 * B) / 4;
          cr += (0.5 * R - 0.418688 * G - 0.081312 * B) / 4;
        }
        ([
          [0, 0],
          [1, 0],
          [0, 1],
          [1, 1],
        ] as const).forEach(([dx, dy], k) => {
          const i = ((y + dy) * w + x + dx) * 4;
          d[i] = Y[k]! + 1.402 * cr;
          d[i + 1] = Y[k]! - 0.344136 * cb - 0.714136 * cr;
          d[i + 2] = Y[k]! + 1.772 * cb;
        });
      }
  return { width: w, height: h, data: d };
}

describe('robust to exposure, sensor noise and 4:2:0 chroma', () => {
  const scenes: Params[] = [
    { preset: 'pool9', W: 960, H: 720, fov: 65, h: 0.2, d: 0.75, roll: 10 },
    { preset: 'snooker12', W: 960, H: 720, fov: 40, h: 0.4, d: 1.2, yaw: -15, occ: 'target' },
    { preset: 'pool9', W: 1280, H: 960, fov: 100, h: 0.08, d: 0.3, yaw: 15 },
  ];
  // Under-exposed by 30–40 % the shaded side of the cue ball fell below the fixed "white" threshold and
  // the cue ball was lost; colour thresholds now follow the photo's exposure (read off the cloth).
  const variants: [string, { gain?: number; noise?: number; chroma420?: boolean }][] = [
    ['exposure ×0.6', { gain: 0.6 }],
    ['exposure ×1.3', { gain: 1.3 }],
    ['sensor noise σ 4', { noise: 4 }],
    ['4:2:0 chroma', { chroma420: true }],
    ['×0.7, noise and 4:2:0', { gain: 0.7, noise: 4, chroma420: true }],
  ];
  for (const p of scenes)
    it(`${p.preset} ${p.W}×${p.H} HFOV ${p.fov}° h ${p.h} m d ${p.d} m`, () => {
      const sc = scene(p);
      const { frame } = render(sc);
      for (const [name, o] of variants) {
        const res = run(sc, perturb(frame, o), appHints(sc));
        expect(res.ok, `${name}: ${res.reason}`).toBe(true);
        const e = errorsOf(sc, res.pose!);
        expect(e.ghost, name).toBeLessThanOrEqual(0.015);
        expect(e.dot, name).toBeLessThanOrEqual(0.1);
      }
    });
});

describe('robust to layout error (the overview places balls within ≈ 1 cm, 001 SC-003)', () => {
  // Each ball of the layout moved by up to 5 mm (deterministic): the pose stays honest (SC-107) and the
  // guide, drawn from that layout as the app draws it, stays within the SC-106 tolerance when ok. The
  // cue ball weighs more in the fit, so the strike dot lands on the photo's cue ball; a fit that leans
  // on a few balls reports its sensitivity to their positions in the confidence.
  const scenes: Params[] = [
    { preset: 'pool9', W: 960, H: 720, fov: 65, h: 0.4, d: 0.3, yaw: 15, roll: -10, occ: 'behindCue' },
    { preset: 'snooker12', W: 960, H: 720, fov: 65, h: 0.2, d: 1.2, yaw: -15, roll: -10, occ: 'target' },
    { preset: 'snooker12', W: 960, H: 720, fov: 40, h: 0.4, d: 0.3, yaw: -15, roll: -10, occ: 'behindCue' },
    { preset: 'pool9', W: 1280, H: 960, fov: 40, h: 0.4, d: 0.75, yaw: 15, roll: -10, occ: 'behindCue' },
  ];
  for (const p of scenes)
    it(`${p.preset} ${p.W}×${p.H} HFOV ${p.fov}° h ${p.h} m d ${p.d} m ${p.occ}`, () => {
      const sc = scene(p);
      const { frame } = render(sc);
      for (let trial = 0; trial < 3; trial++) {
        const layout = knownOf(sc.balls).map((b, i) => {
          const a = 2.399963 * (i + 7 * trial); // golden-angle directions, |offset| 3–5 mm
          const m = 0.003 + 0.002 * (((i * 7 + trial * 3) % 5) / 4);
          return { ...b, pos: { x: b.pos.x + m * Math.cos(a), y: b.pos.y + m * Math.sin(a) } };
        });
        const res = estimatePlayerView({ frame, table: sc.table, balls: layout, cueId: 'cue', targetId: `b${sc.targetIdx}` });
        if (!res.ok) continue;
        const e = errorsOf(sc, res.pose!, layout);
        expect(e.ghost, `trial ${trial}`).toBeLessThanOrEqual(0.015);
        expect(e.dot, `trial ${trial}`).toBeLessThanOrEqual(0.1);
      }
    });
});

// --- reasons name the true cause --------------------------------------------------------------------

describe('failure reasons name the true cause (Principle II)', () => {
  const base: Params = { preset: 'pool9', W: 960, H: 720, fov: 65, h: 0.3, d: 0.5 };

  it('a lit photo with no table in it → "can\'t find the table cloth", not "too dark"', () => {
    // A plain lit wall (beige, slight texture).
    const W = 960;
    const H = 720;
    const data = new Uint8ClampedArray(W * H * 4);
    let s = 7;
    for (let i = 0; i < data.length; i += 4) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      const n = ((s >>> 24) % 9) - 4;
      data[i] = 196 + n;
      data[i + 1] = 182 + n;
      data[i + 2] = 160 + n;
      data[i + 3] = 255;
    }
    const sc = scene(base);
    const res = run(sc, { width: W, height: H, data });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe(PLAYER_VIEW_REASONS.noCloth);
  });

  it('a camera tilted ±20° (the spec\'s limit) still fits; beyond it the reason is never "moved" or "too dark"', () => {
    for (const roll of [-20, 20]) {
      const sc = scene({ ...base, roll });
      const { frame } = render(sc);
      const res = run(sc, frame);
      expect(res.ok, `roll ${roll}: ${res.reason}`).toBe(true);
      expect(errorsOf(sc, res.pose!).ghost).toBeLessThanOrEqual(0.015);
    }
    for (const roll of [-45, 45]) {
      const sc = scene({ ...base, roll });
      const { frame } = render(sc);
      const res = run(sc, frame);
      if (res.ok) expect(errorsOf(sc, res.pose!).ghost).toBeLessThanOrEqual(0.015);
      else expect([PLAYER_VIEW_REASONS.moved, PLAYER_VIEW_REASONS.dark, PLAYER_VIEW_REASONS.noCloth]).not.toContain(res.reason);
    }
  });

  it('a camera 8 cm above the bed, well lit → never "too dark"', () => {
    for (const d of [0.75, 1.2]) {
      const sc = scene({ ...base, h: 0.08, d, fov: 65 });
      const { frame } = render(sc);
      const res = run(sc, frame);
      if (res.ok) expect(errorsOf(sc, res.pose!).ghost).toBeLessThanOrEqual(0.015);
      else expect(res.reason).not.toBe(PLAYER_VIEW_REASONS.dark);
    }
  });

  it('the cue ball moved 10 cm since the table photo (still in view) → "moved"', () => {
    // A cue ball not where the layout puts it, with a circle of its colour elsewhere, is a moved ball.
    const sc = scene(base);
    const cue = sc.balls[0]!.pos;
    const tgt = sc.balls[sc.targetIdx]!.pos;
    const L = Math.hypot(tgt.x - cue.x, tgt.y - cue.y);
    // 10 cm sideways of the aim line.
    const moved = { ...sc, balls: sc.balls.map((b, i) => (i === 0 ? { ...b, pos: { x: cue.x - (0.1 * (tgt.y - cue.y)) / L, y: cue.y + (0.1 * (tgt.x - cue.x)) / L } } : b)) };
    const res = run(sc, render(moved).frame);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe(PLAYER_VIEW_REASONS.moved);
  });

  it('only the cue ball in view → "can\'t see enough balls"', () => {
    const sc = scene({ preset: 'pool9', W: 1280, H: 960, fov: 40, h: 0.4, d: 0.3 });
    const r = render(sc);
    expect(r.inView).toBe(1);
    const res = run(sc, r.frame);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe(PLAYER_VIEW_REASONS.tooFewBalls);
  });
});

// --- light chromatic cloths -----------------------------------------------------------------------

describe('light chromatic cloths: a light cloth is not an over-exposed photo', () => {
  // The colour thresholds once followed the cloth's brightness (read as exposure), so on a light-blue or
  // pale-green cloth the white cue ball's shaded side counted as "dark" and the cue ball was lost.
  const poses: Omit<Params, 'cloth'>[] = [
    { preset: 'pool9', W: 960, H: 720, fov: 65, h: 0.2, d: 0.6, yaw: 10 },
    { preset: 'snooker12', W: 960, H: 720, fov: 65, h: 0.3, d: 0.5, roll: -8 },
    { preset: 'pool9', W: 960, H: 720, fov: 40, h: 0.15, d: 0.9, yaw: -12, occ: 'target' },
    { preset: 'snooker12', W: 1280, H: 960, fov: 100, h: 0.12, d: 0.75, yaw: 8, roll: 6 },
  ];
  for (const cloth of [
    [70, 140, 200],
    [110, 190, 130],
    [90, 150, 210],
  ] as RGB[])
    it(`cloth ${cloth.join(',')}: fits within tolerance, with and without the overview's cloth`, () => {
      for (const p of poses) {
        const sc = scene({ ...p, cloth });
        const { frame } = render(sc);
        for (const extra of [{}, appHints(sc)]) {
          const res = run(sc, frame, extra);
          expect(res.ok, `${sc.name}: ${res.reason}`).toBe(true);
          const e = errorsOf(sc, res.pose!);
          expect(e.ghost, sc.name).toBeLessThanOrEqual(0.015);
          expect(e.dot, sc.name).toBeLessThanOrEqual(0.1);
        }
      }
    });
});

// --- a stripe ball that shows only its white band --------------------------------------------------

describe('a stripe ball whose band is lost in the cloth is not taken for the cue ball', () => {
  it('green stripe on green cloth, a red ball in front of the cue ball (random-layout sweep scene s60050)', () => {
    // The green stripe's band disappears into the green cloth, so the ball shows as a white circle —
    // larger and whiter than the real cue ball, half hidden behind a red ball. Taken for the cue ball, it
    // gave an "ok" fit with the camera 1.2 m off (ghost 4.5 % of the diagonal: an SC-107 violation).
    const table = tables.pool9;
    const C = BALL_COLORS;
    const balls: SynthBall[] = [
      { pos: { x: -0.37207, y: -0.11162 }, color: C.cue! },
      { pos: { x: -0.95397, y: -0.35577 }, color: C.green! },
      { pos: { x: 0.28195, y: 0.58899 }, color: C.red!, stripe: true },
      { pos: { x: 1.14685, y: -0.0563 }, color: C.maroon!, stripe: true },
      { pos: { x: 0.69283, y: -0.04149 }, color: C.blue!, stripe: true },
      { pos: { x: -1.16791, y: 0.062 }, color: C.black! },
      { pos: { x: -0.51087, y: -0.36864 }, color: C.green!, stripe: true },
      { pos: { x: -0.20723, y: -0.06023 }, color: C.red! },
    ];
    const cam: SynthCamera = { pos: { x: 0.084392, y: 0.144281, z: 0.082051 }, target: { x: -0.812266, y: -0.288501, z: 0.175349 }, fovDeg: 54.8675, rollDeg: 0.62639 };
    const sc: Scene = { name: 's60050', table, balls, targetIdx: 1, cam, W: 1280, H: 960 };
    const { frame } = render(sc);
    for (const extra of [{}, appHints(sc)]) {
      const res = run(sc, frame, extra);
      if (!res.ok) continue;
      const e = errorsOf(sc, res.pose!);
      expect(e.ghost).toBeLessThanOrEqual(0.015);
      expect(e.dot).toBeLessThanOrEqual(0.1);
    }
    // The true cue ball explains the photo cleanly: the fit finds it.
    expect(run(sc, frame).ok).toBe(true);
  });
});

// --- balls moved since the table photo (FR-121) ------------------------------------------------------

describe('FR-121: balls moved since the table photo → "The balls seem to have moved"', () => {
  /** A photo of `moved` (the table now), fitted with the overview's layout `layout`, camera placed from the layout. */
  function movedRun(preset: 'pool9' | 'snooker12', moved: (layout: SynthBall[], targetIdx: number) => SynthBall[], pose: { d: number; h: number; yaw?: number; fov?: number; roll?: number }) {
    const base = scene({ preset, W: 960, H: 720, fov: pose.fov ?? 65, h: pose.h, d: pose.d, ...(pose.yaw ? { yaw: pose.yaw } : {}), ...(pose.roll ? { roll: pose.roll } : {}) });
    const now: Scene = { ...base, balls: moved(base.balls, base.targetIdx) };
    const res = run(base, render(now).frame);
    // The guide the app would draw: from the overview's layout, on the fitted pose, against the table now.
    const err = res.pose ? errorsOf(now, res.pose, knownOf(base.balls)) : null;
    return { res, err, name: base.name };
  }
  /** Moved: "moved", or an ok fit whose guide (from the old layout) is still right. Never an ok with a wrong guide. */
  const verdict = (r: ReturnType<typeof movedRun>) => (r.res.ok ? (r.err && within(r.err) ? 'okRight' : 'okWrong') : r.res.reason === PLAYER_VIEW_REASONS.moved ? 'moved' : `other: ${r.res.reason}`);
  const sideways = (off: number) => (layout: SynthBall[], ti: number) => {
    const cue = layout[0]!.pos;
    const tg = layout[ti]!.pos;
    const L = Math.hypot(tg.x - cue.x, tg.y - cue.y);
    return layout.map((b, i) => (i === 0 ? { ...b, pos: { x: cue.x - (off * (tg.y - cue.y)) / L, y: cue.y + (off * (tg.x - cue.x)) / L } } : b));
  };

  for (const preset of ['pool9', 'snooker12'] as const)
    it(`${preset}: the cue ball moved 8–20 cm to either side`, () => {
      // A moved cue ball pulls every hypothesis anchored on it (the layout's cue ball is put on the
      // photo's), so the pose comes from another ball; there the cue ball is on bare cloth and a white
      // circle of its size rests elsewhere on the bed.
      const rows: string[] = [];
      for (const side of [1, -1])
        for (const off of [0.08, 0.1, 0.12, 0.15, 0.2]) {
          const r = movedRun(preset, sideways(side * off), { d: 0.5, h: 0.3 });
          rows.push(`${side * off}: ${verdict(r)}`);
        }
      console.log(`${preset} cue ball moved: ${rows.join(', ')}`);
      expect(rows.filter((x) => x.endsWith('moved') || x.endsWith('okRight')).length).toBe(rows.length);
    });

  it('the whole layout moved 10–12 cm (the cue ball stayed): "moved" on ≥ 75 % and never an ok with a wrong guide', () => {
    const shift = (layout: SynthBall[]) => layout.map((b, i) => (i === 0 ? b : { ...b, pos: { x: b.pos.x + (i % 2 ? 0.12 : -0.1), y: Math.max(-0.6, Math.min(0.6, b.pos.y + (i % 3 === 0 ? 0.1 : -0.08))) } }));
    const poses = [{ d: 0.5, h: 0.3 }, { d: 0.3, h: 0.15 }, { d: 0.8, h: 0.4, yaw: 10 }, { d: 0.6, h: 0.2, roll: 10, yaw: 5 }];
    const out: string[] = [];
    for (const preset of ['pool9', 'snooker12'] as const) for (const p of poses) out.push(verdict(movedRun(preset, shift, p)));
    console.log(`whole layout moved: ${out.join(', ')}`);
    expect(out).not.toContain('okWrong');
    expect(out.filter((x) => x === 'moved').length / out.length).toBeGreaterThanOrEqual(0.75);
  });

  it('the target ball moved 12–25 cm: "moved", not an ok fit that draws the guide from where it was', () => {
    // The pose is right (the cue ball and the other balls did not move), so the fit was ok; but the
    // target is on bare cloth and a circle of its colour rests elsewhere: drawing from the layout would
    // aim at an empty spot.
    const poses = [{ d: 0.5, h: 0.3 }, { d: 0.3, h: 0.15 }, { d: 0.8, h: 0.4, yaw: 10 }, { d: 0.6, h: 0.2, roll: 10, yaw: 5 }];
    const out: string[] = [];
    for (const preset of ['pool9', 'snooker12'] as const)
      poses.forEach((p, k) => {
        const off = (k % 2 ? 1 : -1) * (0.12 + 0.04 * k);
        const moveTarget = (layout: SynthBall[], ti: number) => {
          const cue = layout[0]!.pos;
          const tg = layout[ti]!.pos;
          const L = Math.hypot(tg.x - cue.x, tg.y - cue.y);
          return layout.map((b, i) => (i === ti ? { ...b, pos: { x: tg.x - (off * (tg.y - cue.y)) / L, y: tg.y + (off * (tg.x - cue.x)) / L } } : b));
        };
        out.push(verdict(movedRun(preset, moveTarget, p)));
      });
    console.log(`target moved: ${out.join(', ')}`);
    expect(out.every((x) => x === 'moved')).toBe(true);
  });

  it('the target ball is gone (pocketed since the table photo): "moved", not a guide to an empty spot', () => {
    // No circle of its colour anywhere: the evidence is the bare cloth where the layout puts it.
    const out: string[] = [];
    for (const preset of ['pool9', 'snooker12'] as const)
      for (const p of [{ d: 0.5, h: 0.3 }, { d: 0.8, h: 0.4, yaw: 10 }]) {
        const r = movedRun(preset, (layout, ti) => layout.filter((_, i) => i !== ti), p);
        out.push(r.res.ok ? 'ok' : r.res.reason === PLAYER_VIEW_REASONS.moved ? 'moved' : `other: ${r.res.reason}`);
      }
    console.log(`target gone: ${out.join(', ')}`);
    expect(out.every((x) => x === 'moved')).toBe(true);
  });
});

// --- grainy photos -----------------------------------------------------------------------------------

describe('grainy photos (sensor noise)', () => {
  it('σ 6 and σ 8 (independent noise) on three envelope photos: fits within tolerance', () => {
    const scenes: Params[] = [
      { preset: 'pool9', W: 960, H: 720, fov: 65, h: 0.2, d: 0.75, roll: 10 },
      { preset: 'snooker12', W: 960, H: 720, fov: 40, h: 0.4, d: 1.2, yaw: -15, occ: 'target' },
      { preset: 'pool9', W: 1280, H: 960, fov: 100, h: 0.08, d: 0.3, yaw: 15 },
    ];
    for (const p of scenes) {
      const sc = scene(p);
      const { frame } = render(sc);
      for (const [noise, seed] of [
        [6, 17],
        [8, 29],
      ] as const) {
        const res = run(sc, perturb(frame, { noise, seed }), appHints(sc));
        expect(res.ok, `${sc.name} σ ${noise}: ${res.reason}`).toBe(true);
        const e = errorsOf(sc, res.pose!);
        expect(e.ghost, `${sc.name} σ ${noise}`).toBeLessThanOrEqual(0.015);
        expect(e.dot, `${sc.name} σ ${noise}`).toBeLessThanOrEqual(0.1);
      }
    }
  });

  it('a photo too grainy to line up says so ("too grainy"), never "no cloth", "can\'t see enough balls" or "moved"', () => {
    // The table is in view and lit; the noise (σ 28) is what defeats the fit, and the reason says so.
    const sc = scene({ preset: 'snooker12', W: 960, H: 720, fov: 65, h: 0.2, d: 0.75, yaw: 5 });
    const { frame } = render(sc);
    for (const extra of [{}, appHints(sc)]) {
      const res = run(sc, perturb(frame, { noise: 28, seed: 5 }), extra);
      if (res.ok) {
        expect(errorsOf(sc, res.pose!).ghost).toBeLessThanOrEqual(0.015);
        continue;
      }
      expect(res.reason).toBe(PLAYER_VIEW_REASONS.noisy);
    }
  });
});

// --- reasons follow the stated rules ---------------------------------------------------------------------

describe('"I can\'t see enough balls" means fewer than three ball circles in the photo', () => {
  it('a full 15-ball rack in view never gives "can\'t see enough balls"', () => {
    const table = tables.pool9;
    const R = table.ballRadius;
    const cols = ['yellow', 'blue', 'red', 'purple', 'orange', 'green', 'maroon', 'black', 'yellow', 'blue', 'red', 'purple', 'orange', 'green', 'maroon'];
    const balls: SynthBall[] = [{ pos: { x: -0.7, y: 0.05 }, color: BALL_COLORS.cue! }];
    let k = 0;
    for (let row = 0; row < 5; row++)
      for (let i = 0; i <= row; i++) {
        balls.push({ pos: { x: 0.6 + row * R * Math.sqrt(3) * 1.002, y: (i - row / 2) * 2 * R * 1.002 }, color: BALL_COLORS[cols[k]!]!, ...(k >= 8 ? { stripe: true } : {}) });
        k++;
      }
    for (const [h, d] of [
      [0.3, 0.5],
      [0.12, 0.8],
    ] as const) {
      const cam = playerViewCamera({ cue: balls[0]!.pos, aimAt: balls[1]!.pos, distance: d, height: h, cueRow: 0.72, fovDeg: 65, imageWidth: 960, imageHeight: 720, ballRadius: R });
      const sc: Scene = { name: `rack h ${h} d ${d}`, table, balls, targetIdx: 1, cam, W: 960, H: 720 };
      const res = run(sc, render(sc).frame);
      if (res.ok) expect(errorsOf(sc, res.pose!).ghost, sc.name).toBeLessThanOrEqual(0.015);
      else expect(res.reason, sc.name).not.toBe(PLAYER_VIEW_REASONS.tooFewBalls);
    }
  });
});

// --- low-tint and untinted grey cloths ---------------------------------------------------------------------

describe('low-tint and untinted grey cloths (S 0–0.06): honest when the cloth hides the cue ball', () => {
  // On an untinted grey cloth a white ball's side-lit face, the cushion faces and ball shadows all have
  // the cloth's own grey, so the cue ball can be lost (R-24 limitation). The fit must then fail with the
  // true reason — never "ok" off tolerance, never "moved", "too dark" or "no cloth" — and the two taps fit.
  const poses: Omit<Params, 'cloth'>[] = [
    { preset: 'pool9', W: 960, H: 720, fov: 65, h: 0.2, d: 0.6, yaw: 10 },
    { preset: 'snooker12', W: 960, H: 720, fov: 65, h: 0.3, d: 0.5, roll: -8 },
  ];
  for (const cloth of [
    [128, 128, 128],
    [100, 104, 108],
    [120, 118, 112],
    [95, 95, 98],
  ] as RGB[])
    it(`cloth ${cloth.join(',')}`, () => {
      const diag = Math.hypot(960, 720);
      for (const p of poses) {
        const sc = scene({ ...p, cloth });
        const { frame } = render(sc);
        const res = run(sc, frame, appHints(sc));
        if (res.ok) {
          const e = errorsOf(sc, res.pose!);
          expect(e.ghost, sc.name).toBeLessThanOrEqual(0.015);
          expect(e.dot, sc.name).toBeLessThanOrEqual(0.1);
          continue;
        }
        expect([PLAYER_VIEW_REASONS.noCue, PLAYER_VIEW_REASONS.noFit, PLAYER_VIEW_REASONS.tooFewBalls], `${sc.name}: ${res.reason}`).toContain(res.reason);
        const m = cameraModel(sc.cam, sc.W, sc.H);
        const R = sc.table.ballRadius;
        const cue = m.project({ x: sc.balls[0]!.pos.x, y: sc.balls[0]!.pos.y, z: R });
        const tgt = m.project({ x: sc.balls[sc.targetIdx]!.pos.x, y: sc.balls[sc.targetIdx]!.pos.y, z: R });
        const off = 0.007 * diag;
        const manual = run(sc, frame, { ...appHints(sc), manualTaps: { cue: { x: cue.x + off, y: cue.y - off }, target: { x: tgt.x - off, y: tgt.y + off } } });
        expect(manual.ok, `${sc.name} (taps): ${manual.reason}`).toBe(true);
        expect(errorsOf(sc, manual.pose!).ghost).toBeLessThan(0.025);
      }
    });
});
