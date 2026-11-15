/**
 * The Snap player-photo fit over the spec 002 envelope (SC-106, SC-107, edge cases "different zoom
 * between the two photos" and grey cloth), on ray-traced table-level photos with exact ground truth.
 *
 * Scenes: per resolution (960×720 and 1280×960), an L18 orthogonal array (2¹ × 3⁷, strength 2) over
 * table (pool9 / snooker12), HFOV 40/65/100°, camera height 8/20/40 cm, distance 0.3/0.75/1.2 m behind
 * the cue ball, yaw −15/0/+15° off the aim line, roll −10/0/+10° and occlusion (none / a ball partly in
 * front of the target / a ball partly behind the cue ball), so every pair of levels is covered. The
 * two resolutions use different column assignments. Each photo is fitted twice: without hints, and
 * with what the app passes (the overview's cloth and a 1× (65°) focal length — a lens change for the
 * 40° and 100° photos).
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

type Occlusion = 'none' | 'target' | 'behindCue';

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

/** Adds a ball partly in front of the target (on the camera's line of sight) or partly behind the cue ball. */
function occlude(balls: SynthBall[], occ: Occlusion, cam: { x: number; y: number }, targetIdx: number, table: TableSpec): SynthBall[] {
  if (occ === 'none') return balls;
  const R = table.ballRadius;
  const out = balls.slice();
  const anchor = occ === 'target' ? balls[targetIdx]!.pos : balls[0]!.pos;
  const L = Math.hypot(anchor.x - cam.x, anchor.y - cam.y);
  const ux = (anchor.x - cam.x) / L;
  const uy = (anchor.y - cam.y) / L;
  const along = occ === 'target' ? [-0.22, -0.3, -0.38, -0.16] : [0.14, 0.2, 0.26];
  const sides = occ === 'target' ? [1.3, -1.3, 1.6, -1.6] : [1.1, -1.1, 1.5, -1.5];
  for (const a of along)
    for (const s of sides) {
      const p = { x: anchor.x + ux * a - uy * s * R, y: anchor.y + uy * a + ux * s * R };
      if (isFree(out, p, table)) {
        out.push({ pos: p, color: occ === 'target' ? BALL_COLORS.orange! : BALL_COLORS.purple! });
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
}

function render(sc: Scene): Rendered {
  const area = new Float64Array(sc.balls.length);
  const frame = renderSyntheticTable({ table: sc.table, balls: sc.balls, camera: sc.cam, width: sc.W, height: sc.H, ss: 2, ballArea: area, ...(sc.cloth ? { cloth: sc.cloth } : {}), ...(sc.floor ? { floor: sc.floor } : {}) });
  const m = cameraModel(sc.cam, sc.W, sc.H);
  const R = sc.table.ballRadius;
  const cloth = sc.cloth ?? [40, 130, 70];
  let inView = 0;
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
    if (k === 0 && visible) cueInView = true;
  });
  return { frame, inView, cueInView };
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
const ENVELOPE: Scene[] = (
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

interface Run {
  sc: Scene;
  hints: boolean;
  enough: boolean;
  res: PlayerViewResult;
  err: Errors | null;
}

describe('SC-106 / SC-107: the player-photo fit over the spec envelope', () => {
  const runs: Run[] = [];

  beforeAll(async () => {
    for (const sc of ENVELOPE) {
      // Yield between photos: a minute of synchronous work would starve the test runner's RPC.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const r = render(sc);
      const enough = r.cueInView && r.inView >= 3;
      for (const hints of [false, true]) {
        const res = run(sc, r.frame, hints ? appHints(sc) : {});
        runs.push({ sc, hints, enough, res, err: res.pose ? errorsOf(sc, res.pose) : null });
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
      // These photos are lit, show the cloth, and nothing moved: never "too dark", "no cloth" or "moved".
      expect([PLAYER_VIEW_REASONS.dark, PLAYER_VIEW_REASONS.noCloth, PLAYER_VIEW_REASONS.moved], r.sc.name).not.toContain(r.res.reason);
      if (!r.enough) expect([PLAYER_VIEW_REASONS.tooFewBalls, PLAYER_VIEW_REASONS.noCue], r.sc.name).toContain(r.res.reason);
    }
  });

  // Timing is reported here; the guards are player-view.test.ts's (< 250 ms median per 960×720 photo,
  // SC-109's 0.5 s at 1280 px), measured on repeated runs of one photo rather than over a minute of
  // rendering that a loaded CI machine stretches.
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
function perturb(f: Frame, o: { gain?: number; noise?: number; chroma420?: boolean }): Frame {
  const { width: w, height: h } = f;
  const d = new Uint8ClampedArray(f.data.length);
  let s = 4242;
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
