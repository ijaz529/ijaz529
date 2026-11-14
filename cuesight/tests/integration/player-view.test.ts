/**
 * Player-view pose estimation on synthetic, ray-traced table-level photos with exact ground truth
 * (spec 002 US2, contracts/player-view-api.md; Constitution II honest uncertainty, III test-first,
 * IV performance). Also the Snap chain through the v2 vision-worker handler on the committed fixtures.
 */
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { beforeAll, describe, expect, it } from 'vitest';
import { makeTable } from '../../src/core/table';
import type { TablePresetId, TableSpec } from '../../src/core/types';
import type { Frame } from '../../src/vision/image';
import { estimatePlayerView, projectPoint, type CameraPose, type KnownBall, type PlayerViewInput, type PlayerViewResult } from '../../src/vision/player-view';
import { BALL_COLORS, cameraModel, fixtureBalls, playerViewCamera, renderSyntheticTable, type SynthBall, type SynthCamera } from '../../src/vision/synth/render';
import { PROTOCOL_VERSION, isSupported, type VisionIn, type VisionOut } from '../../src/workers/protocol';
import { createVisionHandler } from '../../src/workers/vision.worker';

const W = 960;
const H = 720;

// --- ground truth helpers ---------------------------------------------------------------------------

function poseOf(cam: SynthCamera, width: number, height: number): CameraPose {
  const m = cameraModel(cam, width, height);
  const R = [m.R[0].x, m.R[0].y, m.R[0].z, m.R[1].x, m.R[1].y, m.R[1].z, m.R[2].x, m.R[2].y, m.R[2].z];
  const C = m.C;
  const t = { x: -(R[0]! * C.x + R[1]! * C.y + R[2]! * C.z), y: -(R[3]! * C.x + R[4]! * C.y + R[5]! * C.z), z: -(R[6]! * C.x + R[7]! * C.y + R[8]! * C.z) };
  return { R, t, f: m.f, cx: width / 2, cy: height / 2, width, height };
}

const centreOf = (p: CameraPose) => ({
  x: -(p.R[0]! * p.t.x + p.R[3]! * p.t.y + p.R[6]! * p.t.z),
  y: -(p.R[1]! * p.t.x + p.R[4]! * p.t.y + p.R[7]! * p.t.z),
  z: -(p.R[2]! * p.t.x + p.R[5]! * p.t.y + p.R[8]! * p.t.z),
});

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
  posM: number;
  rotDeg: number;
  /** Ghost-ball centre reprojection error / image width. */
  ghostW: number;
}

function poseErrors(gt: CameraPose, est: CameraPose, table: TableSpec, cue: { x: number; y: number }, target: { x: number; y: number }): Errors {
  const a = centreOf(gt);
  const b = centreOf(est);
  let tr = 0;
  for (let i = 0; i < 3; i++) for (let k = 0; k < 3; k++) tr += gt.R[k * 3 + i]! * est.R[k * 3 + i]!;
  const ghost = ghostFor(table, cue, target);
  const g1 = projectPoint(gt, ghost)!;
  const g2 = projectPoint(est, ghost);
  return {
    posM: Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z),
    rotDeg: (Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2))) * 180) / Math.PI,
    ghostW: g2 ? Math.hypot(g1.x - g2.x, g1.y - g2.y) / gt.width : Infinity,
  };
}

// --- scenes -----------------------------------------------------------------------------------------

function snookerBalls(table: TableSpec): SynthBall[] {
  const R = table.ballRadius;
  const C = BALL_COLORS;
  const out: SynthBall[] = [{ pos: { x: -1.25, y: 0.2 }, color: C.cue! }];
  let n = 0;
  for (let row = 0; row < 5; row++) for (let i = 0; i <= row; i++, n++) out.push({ pos: { x: 0.95 + row * R * Math.sqrt(3) * 1.002, y: (i - row / 2) * 2 * R * 1.002 }, color: C.red! });
  out.push({ pos: { x: -1.05, y: -0.29 }, color: C.yellow! });
  out.push({ pos: { x: -1.05, y: 0.29 }, color: [20, 110, 50] }); // green: invisible on green cloth
  out.push({ pos: { x: -1.05, y: 0 }, color: [120, 70, 30] });
  out.push({ pos: { x: 0, y: 0 }, color: C.blue! });
  out.push({ pos: { x: 0.85, y: 0 }, color: [235, 120, 150] });
  out.push({ pos: { x: 1.47, y: 0 }, color: C.black! });
  return out;
}

interface Scene {
  name: string;
  table: TableSpec;
  balls: SynthBall[];
  targetIdx: number;
  cam: SynthCamera;
}

const tables: Record<string, TableSpec> = { pool9: makeTable('pool9'), snooker12: makeTable('snooker12') };
const pool = fixtureBalls(tables.pool9!).balls;
const snooker = snookerBalls(tables.snooker12!);
const hfovFor = (focalScale: number) => (2 * Math.atan(Math.tan((32.5 * Math.PI) / 180) / focalScale) * 180) / Math.PI;

function scene(name: string, preset: TablePresetId, targetIdx: number, o: { d: number; h: number; yaw?: number; fov?: number; cueRow?: number }): Scene {
  const table = tables[preset]!;
  const balls = preset === 'pool9' ? pool : snooker;
  const cam = playerViewCamera({
    cue: balls[0]!.pos,
    aimAt: balls[targetIdx]!.pos,
    distance: o.d,
    height: o.h,
    yawOffsetDeg: o.yaw ?? 0,
    cueRow: o.cueRow ?? 0.72,
    fovDeg: o.fov ?? 65,
    imageWidth: W,
    imageHeight: H,
    ballRadius: table.ballRadius,
  });
  return { name, table, balls, targetIdx, cam };
}

/** The accuracy grid (heights 0.15/0.3/0.45 m, distances 0.3–0.8 m, yaw off the aim line 10–20°,
 * 9-ball and snooker, cue ball cut by the bottom edge, true focal ±15 % off the 65° prior). */
const GRID: Scene[] = [
  scene('9-ball straight, 0.5 m back, 0.30 m up', 'pool9', 1, { d: 0.5, h: 0.3 }),
  scene('9-ball straight, 0.3 m back, 0.15 m up', 'pool9', 1, { d: 0.3, h: 0.15 }),
  scene('9-ball straight, 0.8 m back, 0.45 m up', 'pool9', 1, { d: 0.8, h: 0.45 }),
  scene('9-ball 15° off the line, 0.6 m, 0.30 m', 'pool9', 1, { d: 0.6, h: 0.3, yaw: 15 }),
  scene('9-ball 20° off the line, 0.4 m, 0.15 m', 'pool9', 1, { d: 0.4, h: 0.15, yaw: -20 }),
  scene('9-ball 10° off, other target, 0.7 m, 0.25 m', 'pool9', 2, { d: 0.7, h: 0.25, yaw: 10 }),
  scene('9-ball cue ball cut by the bottom edge', 'pool9', 1, { d: 0.5, h: 0.3, cueRow: 0.97 }),
  scene('9-ball true focal +15 %', 'pool9', 1, { d: 0.6, h: 0.3, fov: hfovFor(1.15) }),
  scene('9-ball true focal −15 %', 'pool9', 1, { d: 0.6, h: 0.3, fov: hfovFor(0.85) }),
  scene('snooker straight, 0.6 m, 0.30 m', 'snooker12', 19, { d: 0.6, h: 0.3 }),
  scene('snooker 10° off, 0.5 m, 0.15 m', 'snooker12', 20, { d: 0.5, h: 0.15, yaw: 10 }),
  scene('snooker 12° off, cue ball cut, 0.45 m', 'snooker12', 19, { d: 0.4, h: 0.45, yaw: -12, cueRow: 0.96 }),
];

const frames = new Map<string, Frame>();
function render(sc: Scene, balls: SynthBall[] = sc.balls, key = sc.name): Frame {
  let f = frames.get(key);
  if (!f) {
    f = renderSyntheticTable({ table: sc.table, balls, camera: sc.cam, width: W, height: H, ss: 2 });
    frames.set(key, f);
  }
  return f;
}

const knownOf = (balls: SynthBall[], withRgb = true): KnownBall[] =>
  balls.map((b, i) => ({ id: i === 0 ? 'cue' : `b${i}`, pos: b.pos, isCue: i === 0, ...(withRgb ? { rgb: b.color } : {}) }));

function run(sc: Scene, extra: Partial<PlayerViewInput> = {}, frame = render(sc)): PlayerViewResult {
  return estimatePlayerView({ frame, table: sc.table, balls: knownOf(sc.balls), cueId: 'cue', targetId: `b${sc.targetIdx}`, ...extra });
}

const fmt = (e: Errors) => `pos ${(e.posM * 100).toFixed(2)} cm, rot ${e.rotDeg.toFixed(3)}°, ghost ${(e.ghostW * 100).toFixed(3)} % of width`;

// --- tests ------------------------------------------------------------------------------------------

describe('player-view pose on synthetic table-level photos', () => {
  beforeAll(() => {
    for (const sc of GRID) render(sc);
  }, 120_000);

  it('recovers the camera within 3 cm and 1°, ghost ball within 1.5 % of the width, on every grid scene', () => {
    const rows: string[] = [];
    for (const sc of GRID) {
      const r = run(sc);
      expect(r.ok, `${sc.name}: ${r.reason}`).toBe(true);
      expect(r.pose).not.toBeNull();
      const e = poseErrors(poseOf(sc.cam, W, H), r.pose!, sc.table, sc.balls[0]!.pos, sc.balls[sc.targetIdx]!.pos);
      rows.push(`  ${sc.name.padEnd(46)} ${fmt(e)}, conf ${r.confidence.toFixed(2)}, residual ${r.residualPx.toFixed(2)} px, ${r.matched.length} balls, ${r.ms.toFixed(0)} ms`);
      expect(e.posM, sc.name).toBeLessThan(0.03);
      expect(e.rotDeg, sc.name).toBeLessThan(1);
      expect(e.ghostW, sc.name).toBeLessThan(0.015);
      expect(r.confidence).toBeGreaterThanOrEqual(0.5);
      expect(r.matched.some((m) => m.id === 'cue')).toBe(true);
    }
    console.log(`player-view accuracy (${W}×${H}):\n${rows.join('\n')}`);
  });

  it('works without ball colours and with a (slightly wrong) focal prior from the overview', () => {
    const sc = GRID[0]!;
    const noRgb = estimatePlayerView({ frame: render(sc), table: sc.table, balls: knownOf(sc.balls, false), cueId: 'cue', targetId: `b${sc.targetIdx}` });
    const focal = run(sc, { focalPx: cameraModel(sc.cam, W, H).f * 1.08 });
    for (const r of [noRgb, focal]) {
      expect(r.ok).toBe(true);
      const e = poseErrors(poseOf(sc.cam, W, H), r.pose!, sc.table, sc.balls[0]!.pos, sc.balls[sc.targetIdx]!.pos);
      expect(e.posM).toBeLessThan(0.03);
      expect(e.ghostW).toBeLessThan(0.015);
    }
  });

  it('manual fallback: two taps (each ~1 % of the diagonal off) give the pose, ghost within 2.5 % of the diagonal', () => {
    const diag = Math.hypot(W, H);
    for (const sc of [GRID[0]!, GRID[4]!, GRID[6]!, GRID[10]!]) {
      const m = cameraModel(sc.cam, W, H);
      const R = sc.table.ballRadius;
      const cue = m.project({ x: sc.balls[0]!.pos.x, y: sc.balls[0]!.pos.y, z: R });
      const tgt = m.project({ x: sc.balls[sc.targetIdx]!.pos.x, y: sc.balls[sc.targetIdx]!.pos.y, z: R });
      const off = 0.01 * diag;
      const r = run(sc, { manualTaps: { cue: { x: cue.x + 0.7 * off, y: cue.y - 0.7 * off }, target: { x: tgt.x - 0.7 * off, y: tgt.y + 0.7 * off } } });
      expect(r.ok, `${sc.name}: ${r.reason}`).toBe(true);
      const e = poseErrors(poseOf(sc.cam, W, H), r.pose!, sc.table, sc.balls[0]!.pos, sc.balls[sc.targetIdx]!.pos);
      expect((e.ghostW * W) / diag, sc.name).toBeLessThan(0.025);
    }
  });

  it('manual taps need a target id', () => {
    const r = run(GRID[0]!, { targetId: undefined, manualTaps: { cue: { x: 480, y: 500 }, target: { x: 480, y: 300 } } });
    expect(r.ok).toBe(false);
    expect(r.reason).toBeTruthy();
  });

  it('is deterministic: the same input gives a bit-identical result apart from ms', () => {
    const sc = GRID[3]!;
    const a = run(sc);
    const b = run(sc);
    expect({ ...a, ms: 0 }).toEqual({ ...b, ms: 0 });
  });

  it(`runs in < 250 ms per ${W}×${H} photo (median, Node)`, () => {
    const sc = GRID[0]!;
    run(sc); // warm-up (JIT)
    const t: number[] = [];
    for (let i = 0; i < 5; i++) t.push(run(sc).ms);
    t.sort((x, y) => x - y);
    console.log(`player-view ${W}×${H}: median ${t[2]!.toFixed(0)} ms (min ${t[0]!.toFixed(0)}, max ${t[4]!.toFixed(0)})`);
    expect(t[2]!).toBeLessThan(250);
  });
});

describe('player-view honesty: no guide from a photo it cannot read (Principle II)', () => {
  const base = GRID[0]!;

  it('no cue ball in view → ok: false with a reason', () => {
    const cam = playerViewCamera({ cue: pool[0]!.pos, aimAt: pool[1]!.pos, distance: 0.5, height: 0.3, cueRow: 1.35, fovDeg: 65, imageWidth: W, imageHeight: H, ballRadius: tables.pool9!.ballRadius });
    const sc = { ...base, name: 'no cue in view', cam };
    const r = run(sc, {}, render(sc));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/cue ball|enough balls|line up/);
  });

  it('cue ball missing from the photo (layout still has it) → ok: false', () => {
    const balls = pool.map((b, i) => (i === 0 ? { ...b, pos: { x: -9, y: -9 } } : b));
    const r = run(base, {}, render(base, balls, 'cue removed'));
    expect(r.ok).toBe(false);
    expect(r.reason).toBeTruthy();
  });

  it('balls moved ≥ 10 cm since the table photo → ok: false, "moved"', () => {
    const moved = pool.map((b, i) => (i === 0 ? b : { ...b, pos: { x: b.pos.x + (i % 2 ? 0.12 : -0.1), y: b.pos.y + (i % 3 === 0 ? 0.1 : -0.08) } }));
    const r = run(base, {}, render(base, moved, 'moved'));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/moved/);
  });

  it('only the cue ball on the table → ok: false', () => {
    const r = run(base, {}, render(base, [pool[0]!], 'only cue'));
    expect(r.ok).toBe(false);
    expect(r.confidence).toBeLessThan(0.5);
    expect(r.reason).toBeTruthy();
  });

  it('too dark (×0.15 + noise) → ok: false, "too dark"', () => {
    const src = render(base);
    const data = new Uint8ClampedArray(src.data.length);
    let s = 12345;
    for (let i = 0; i < data.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        data[i + c] = src.data[i + c]! * 0.15 + ((s >>> 24) % 9) - 4;
      }
      data[i + 3] = 255;
    }
    const r = run(base, {}, { width: W, height: H, data });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/too dark/);
  });

  it('a layout that does not match the photo (mirrored) → ok: false', () => {
    const r = estimatePlayerView({ frame: render(base), table: base.table, balls: knownOf(pool).map((b) => (b.isCue ? b : { ...b, pos: { x: b.pos.x, y: -b.pos.y } })), cueId: 'cue', targetId: 'b1' });
    expect(r.ok).toBe(false);
  });
});

// --- Snap chain on the committed fixtures, through the v2 worker protocol ----------------------------

/** Minimal PNG decoder (8-bit RGBA, non-interlaced: what scripts/png.ts writes). */
function decodePng(buf: Buffer): Frame {
  let p = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const body = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      if (body[8] !== 8 || body[9] !== 6 || body[12] !== 0) throw new Error('unsupported PNG');
    } else if (type === 'IDAT') idat.push(body);
    p += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)]!;
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x]!;
      const a = x >= 4 ? out[y * stride + x - 4]! : 0;
      const b = y > 0 ? out[(y - 1) * stride + x]! : 0;
      const c = x >= 4 && y > 0 ? out[(y - 1) * stride + x - 4]! : 0;
      const pa = Math.abs(b - c);
      const pb = Math.abs(a - c);
      const pc = Math.abs(a + b - 2 * c);
      const pred = ft === 0 ? 0 : ft === 1 ? a : ft === 2 ? b : ft === 3 ? (a + b) >> 1 : pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      out[y * stride + x] = (v + pred) & 255;
    }
  }
  return { width, height, data: out };
}

interface SnapPhoto {
  file: string;
  width: number;
  height: number;
  targetId?: string;
  pose: CameraPose;
  ballsInView: { id: string; outlineCenter: { x: number; y: number } }[];
  expect?: { ok: boolean; manualTaps?: { cue: { x: number; y: number }; target: { x: number; y: number } } };
}

describe('Snap fixtures through the vision worker (protocol v2)', () => {
  const dir = 'tests/fixtures/';
  const gt = JSON.parse(readFileSync(`${dir}snap-layout.json`, 'utf8')) as {
    table: TablePresetId;
    balls: { id: string; pos: { x: number; y: number }; isCue: boolean }[];
    photos: Record<'overview' | 'player' | 'playerHard' | 'playerCut', SnapPhoto>;
  };
  const table = makeTable(gt.table);
  const handle = createVisionHandler();
  const send = (msg: VisionIn): VisionOut => {
    const reply = handle(structuredClone(msg));
    expect(reply).not.toBeNull();
    return structuredClone(reply!.msg);
  };
  let layout: KnownBall[] = [];

  it('protocol v2: version, v1 rejection, unchanged v1 messages', () => {
    expect(PROTOCOL_VERSION).toBe(2);
    expect(isSupported({ v: 2 })).toBe(true);
    expect(isSupported({ v: 1 })).toBe(false);
    const err = handle({ v: 1, type: 'reset' } as unknown as VisionIn);
    expect(err?.msg.type).toBe('error');
    expect(handle({ v: PROTOCOL_VERSION, type: 'config', table, fovDeg: 65, manualCorners: null, swapAxes: false })).toBeNull();
    const buf = new Uint8ClampedArray(64 * 48 * 4).buffer;
    const live = handle({ v: PROTOCOL_VERSION, type: 'frame', id: 7, width: 64, height: 48, buffer: buf });
    expect(live?.msg).toMatchObject({ v: 2, type: 'result', id: 7 });
    expect(live?.transfer).toEqual([buf]);
  });

  it('still: the overview photo locks and gives the whole layout (separate from live tracking)', () => {
    const frame = decodePng(readFileSync(dir + gt.photos.overview.file));
    const out = send({ v: PROTOCOL_VERSION, type: 'still', id: 1, frame });
    expect(out.type).toBe('still');
    if (out.type !== 'still') return;
    expect(out.id).toBe(1);
    expect(out.result.status).toBe('locked');
    expect(out.result.balls).toHaveLength(gt.balls.length);
    expect(out.result.balls.filter((b) => b.isCue)).toHaveLength(1);
    // Detected positions within 2 cm of the truth (001 SC-003 territory).
    for (const b of gt.balls) {
      const d = Math.min(...out.result.balls.map((q) => Math.hypot(q.pos.x - b.pos.x, q.pos.y - b.pos.y)));
      expect(d, b.id).toBeLessThan(0.02);
    }
    layout = out.result.balls.map((b) => ({ id: b.id, pos: b.pos, isCue: b.isCue, rgb: b.rgb }));
    console.log(`still 1280×720: ${out.result.balls.length} balls, ${out.result.ms.toFixed(0)} ms for ${6} passes`);
  });

  const idNear = (pos: { x: number; y: number }) => layout.reduce((a, b) => (Math.hypot(b.pos.x - pos.x, b.pos.y - pos.y) < Math.hypot(a.pos.x - pos.x, a.pos.y - pos.y) ? b : a)).id;
  const truth = (id: string) => gt.balls.find((b) => b.id === id)!.pos;

  for (const key of ['player', 'playerCut'] as const) {
    it(`player-view: ${key} lines up with the detected layout`, () => {
      expect(layout.length).toBeGreaterThan(0);
      const ph = gt.photos[key];
      const frame = decodePng(readFileSync(dir + ph.file));
      const cueId = layout.find((b) => b.isCue)!.id;
      const targetId = idNear(truth(ph.targetId!));
      const out = send({ v: PROTOCOL_VERSION, type: 'player-view', id: 2, input: { frame, table, balls: layout, cueId, targetId } });
      expect(out.type).toBe('player-view');
      if (out.type !== 'player-view') return;
      expect(out.result.ok, out.result.reason).toBe(true);
      const e = poseErrors(ph.pose, out.result.pose!, table, truth('cue'), truth(ph.targetId!));
      console.log(`${ph.file} (detected layout): ${fmt(e)}, conf ${out.result.confidence.toFixed(2)}, ${out.result.ms.toFixed(0)} ms`);
      expect(e.posM).toBeLessThan(0.03);
      expect(e.rotDeg).toBeLessThan(1);
      expect(e.ghostW).toBeLessThan(0.015);
    });
  }

  it('player-view: the hard photo refuses automatically, then two taps give the pose', () => {
    const ph = gt.photos.playerHard;
    const frame = decodePng(readFileSync(dir + ph.file));
    const cueId = layout.find((b) => b.isCue)!.id;
    const targetId = idNear(truth(ph.targetId!));
    const auto = send({ v: PROTOCOL_VERSION, type: 'player-view', id: 3, input: { frame, table, balls: layout, cueId, targetId } });
    if (auto.type !== 'player-view') throw new Error(auto.type);
    expect(auto.result.ok).toBe(false);
    expect(auto.result.reason).toMatch(/Tap the cue ball/);
    const taps = ph.expect!.manualTaps!;
    const manual = send({ v: PROTOCOL_VERSION, type: 'player-view', id: 4, input: { frame, table, balls: layout, cueId, targetId, manualTaps: taps } });
    if (manual.type !== 'player-view') throw new Error(manual.type);
    expect(manual.result.ok, manual.result.reason).toBe(true);
    expect(manual.result.confidence).toBeLessThanOrEqual(0.7);
    const e = poseErrors(ph.pose, manual.result.pose!, table, truth('cue'), truth(ph.targetId!));
    expect((e.ghostW * ph.width) / Math.hypot(ph.width, ph.height)).toBeLessThan(0.025);
  });

  it(`player-view on a 1280×960 photo stays within the 500 ms budget (SC-109)`, () => {
    const ph = gt.photos.player;
    const frame = decodePng(readFileSync(dir + ph.file));
    const input = { frame, table, balls: layout, cueId: layout.find((b) => b.isCue)!.id, targetId: idNear(truth(ph.targetId!)) };
    estimatePlayerView(input);
    const t: number[] = [];
    for (let i = 0; i < 3; i++) t.push(estimatePlayerView(input).ms);
    t.sort((a, b) => a - b);
    console.log(`player-view 1280×960: median ${t[1]!.toFixed(0)} ms`);
    expect(t[1]!).toBeLessThan(500);
  });

  it('a failing estimator reply is an ok: false result, not an error', () => {
    const out = send({ v: PROTOCOL_VERSION, type: 'player-view', id: 5, input: { frame: { width: 0, height: 0, data: new Uint8ClampedArray(0) }, table, balls: layout, cueId: 'nope' } });
    expect(out).toMatchObject({ type: 'player-view', id: 5, result: { ok: false } });
  });
});
