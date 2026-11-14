/**
 * The live vision pipeline over frame sequences (ray-traced ground truth): honest lock status
 * (Constitution II), stable ids and table frame across frames and config messages, no stale geometry,
 * and the 2R separation promised in data-model.md.
 */
import { describe, expect, it } from 'vitest';
import { makeTable } from '../../src/core/table';
import type { TablePresetId } from '../../src/core/types';
import type { Vec2 } from '../../src/core/vec';
import { hueDiff, type Frame } from '../../src/vision/image';
import { createPipeline, type PipelineConfig, type VisionResult } from '../../src/vision/pipeline';
import { BALL_COLORS, cameraModel, fixtureBalls, renderSyntheticTable, type RGB, type SynthBall, type SynthCamera } from '../../src/vision/synth/render';
import { detectTable } from '../../src/vision/table-detect';
import { PROTOCOL_VERSION, type VisionIn, type VisionOut } from '../../src/workers/protocol';
import { createVisionHandler } from '../../src/workers/vision.worker';
import { POSES } from '../helpers/scenes';

const table = makeTable('pool9');
const FIX = fixtureBalls(table).balls;

interface RenderOpts {
  width?: number;
  height?: number;
  ss?: number;
  cloth?: RGB;
  floor?: RGB;
  balls?: SynthBall[];
  preset?: TablePresetId;
}
function render(camera: SynthCamera, o: RenderOpts = {}): Frame {
  const t = o.preset ? makeTable(o.preset) : table;
  return renderSyntheticTable({
    table: t,
    balls: o.balls ?? FIX,
    camera,
    width: o.width ?? 640,
    height: o.height ?? 480,
    ss: o.ss ?? 1,
    ...(o.cloth ? { cloth: o.cloth } : {}),
    ...(o.floor ? { floor: o.floor } : {}),
  });
}

function outerCorners(camera: SynthCamera, w = 640, h = 480): Vec2[] {
  const cam = cameraModel(camera, w, h);
  const X = table.length / 2 + table.cushionWidth;
  const Y = table.width / 2 + table.cushionWidth;
  return [
    [-X, -Y],
    [X, -Y],
    [X, Y],
    [-X, Y],
  ].map(([x, y]) => cam.project({ x: x!, y: y!, z: table.cushionHeight }));
}

function run(cfg: PipelineConfig, frames: Frame[]): VisionResult[] {
  const p = createPipeline(cfg);
  return frames.map((f) => p.process(f));
}

/** Errors (m) from each truth ball to the nearest reported ball, no 180° allowance. */
function ballErrors(r: VisionResult, truth: SynthBall[]): number[] {
  return truth.map((t) => Math.min(...r.balls.map((b) => Math.hypot(b.pos.x - t.pos.x, b.pos.y - t.pos.y))));
}
const median = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1]!;

const blackFrame = (w = 640, h = 480): Frame => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  return { width: w, height: h, data };
};
const uniformFrame = (rgb: RGB, w = 640, h = 480): Frame => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = rgb[0];
    data[i * 4 + 1] = rgb[1];
    data[i * 4 + 2] = rgb[2];
    data[i * 4 + 3] = 255;
  }
  return { width: w, height: h, data };
};

describe('a table cut off by the frame border, or no table, never locks on a wrong quad', () => {
  // A side has too little real edge support (it runs along the border): no quad at all.
  const unrecoverable: [string, SynthCamera, number, number][] = [
    ['end fov50', { ...POSES.end!, fovDeg: 50 }, 640, 480],
    ['side z = 0.5', { pos: { x: 0, y: -1.9, z: 0.5 }, target: { x: 0, y: 0.1, z: 0 }, fovDeg: 70 }, 640, 480],
    ['side fov50', { ...POSES.side!, fovDeg: 50 }, 640, 480],
    ['corner fov40', { ...POSES.corner!, fovDeg: 40 }, 640, 480],
    ['portrait side view at the rail, fov40', { pos: { x: 0.1, y: -1.85, z: 1.6 }, target: { x: 0, y: 0.1, z: 0 }, fovDeg: 40 }, 360, 640],
    ['landscape end view up close', { pos: { x: -1.9, y: 0, z: 1.5 }, target: { x: 0.3, y: 0, z: 0 }, fovDeg: 66 }, 640, 360],
    ['cloth filling the frame', { pos: { x: 0.3, y: -0.1, z: 0.9 }, target: { x: 0.3, y: 0, z: 0 }, fovDeg: 66 }, 640, 360],
  ];
  it.each(unrecoverable)('%s: never locked, no calibration on any of 9 frames', (_name, cam, w, h) => {
    const truth = outerCorners(cam, w, h);
    expect(truth.some((p) => p.x < 0 || p.y < 0 || p.x > w || p.y > h)).toBe(true);
    const f = render(cam, { width: w, height: h });
    const rs = run({ table, fovDeg: 65 }, Array.from({ length: 9 }, () => f));
    for (const r of rs) {
      expect(r.status).not.toBe('locked');
      expect(r.calibration).toBeNull();
    }
  });

  // Corners just off-screen while every rail is visible along most of its length: both sides at each
  // missing corner are well supported, so the extrapolated corners are exact and locking is honest.
  const recoverable: [string, SynthCamera][] = [
    ['side camera (0.2, −1.7, 1.6) fov68', { pos: { x: 0.2, y: -1.7, z: 1.6 }, target: POSES.side!.target, fovDeg: 68 }],
    ['side fov55', { ...POSES.side!, fovDeg: 55 }],
    ['corner fov45', { ...POSES.corner!, fovDeg: 45 }],
  ];
  it.each(recoverable)('%s, near corners off-screen: locks with all 4 corners within 1.5 %% of the diagonal and the balls in place', (_name, cam) => {
    const truth = outerCorners(cam);
    expect(truth.filter((p) => p.x < 0 || p.y < 0 || p.x > 640 || p.y > 480).length).toBeGreaterThan(0);
    const f = render(cam);
    const rs = run({ table, fovDeg: 65 }, Array.from({ length: 9 }, () => f));
    const last = rs[rs.length - 1]!;
    expect(last.status).toBe('locked');
    const diag = Math.hypot(640, 480);
    for (let k = 0; k < 4; k++) expect(Math.hypot(last.calibration!.corners[k]!.x - truth[k]!.x, last.calibration!.corners[k]!.y - truth[k]!.y) / diag).toBeLessThan(0.015);
    // Every reported ball is a real one: median ≤ 1 cm; at most 4 cm, because the frozen purple/orange
    // pair (0.5 mm apart) can be read as one blob between the two (a ball-detection limit).
    const errs = last.balls.map((b) => Math.min(...FIX.map((t) => Math.hypot(b.pos.x - t.pos.x, b.pos.y - t.pos.y))));
    expect(median(errs)).toBeLessThanOrEqual(0.01);
    for (const e of errs) expect(e).toBeLessThan(0.04);
  });

  it('a saturated wood floor and a uniform blue frame are not tables', () => {
    const floor = render({ pos: { x: -3.5, y: 0, z: 1.5 }, target: { x: -5.5, y: 0, z: 0 }, fovDeg: 66 }, { floor: [150, 95, 45] });
    expect(detectTable(floor)).toBeNull();
    expect(detectTable(uniformFrame([40, 60, 170]))).toBeNull();
    const rs = run({ table }, [floor, floor, floor, floor, floor, floor, floor]);
    for (const r of rs) expect(r.status).not.toBe('locked');
  });
});

describe('accuracy when the table fills the frame', () => {
  it('overhead at z = 2.5: median ball error ≤ 10 mm', () => {
    const cam: SynthCamera = { pos: { x: 0, y: -0.35, z: 2.5 }, target: { x: 0, y: 0, z: 0 }, fovDeg: 64 };
    const f = render(cam, { ss: 2 });
    const rs = run({ table, fovDeg: 64 }, Array.from({ length: 8 }, () => f));
    const last = rs[rs.length - 1]!;
    expect(last.status).toBe('locked');
    const errs = ballErrors(last, FIX);
    console.log(`overhead z2.5: median ball error ${(1000 * median(errs)).toFixed(1)} mm, quality ${last.quality.toFixed(3)}`);
    expect(median(errs)).toBeLessThanOrEqual(0.01);
  });

  it('fovDeg 0 from settings: overhead still finds all 9 balls', () => {
    const f = render(POSES.overhead!);
    const rs = run({ table, fovDeg: 0 }, Array.from({ length: 8 }, () => f));
    const last = rs[rs.length - 1]!;
    expect(Number.isFinite(last.calibration!.focal)).toBe(true);
    expect(last.balls).toHaveLength(9);
  });
});

describe('stable table frame in end views (0°/180°)', () => {
  const sway = (dy: number, roll = 0): SynthCamera => ({
    pos: { ...POSES.end!.pos, y: dy },
    target: { ...POSES.end!.target, y: dy },
    fovDeg: POSES.end!.fovDeg,
    ...(roll ? { rollDeg: roll } : {}),
  });
  // The camera sways ±6 mm sideways every frame (hand tremor), level or held with a 3° roll. The old
  // image-x sign rule flipped the frame 180° on exactly this kind of sway.
  const variants: [string, Frame, Frame][] = [
    ['camera y ±6 mm', render(sway(0.006)), render(sway(-0.006))],
    ['camera y ±6 mm, +3° roll', render(sway(0.006, 3)), render(sway(-0.006, 3))],
    ['camera y ±6 mm, −3° roll', render(sway(0.006, -3)), render(sway(-0.006, -3))],
  ];
  it.each(variants)('%s, 20 alternating frames: ids and the cue stay put, positions match the truth with sign +1', (_name, a, b) => {
    const p = createPipeline({ table, fovDeg: 66 });
    const ids = new Map<string, Vec2>();
    let locked = false;
    let cue0: Vec2 | null = null;
    for (let i = 0; i < 20; i++) {
      const r = p.process(i % 2 ? b : a);
      if (r.status === 'locked') locked = true;
      if (!locked) continue;
      expect(r.status, `frame ${i}`).toBe('locked');
      const cue = r.balls.find((x) => x.isCue);
      expect(cue, `frame ${i}`).toBeDefined();
      // Sign +1: the cue ball is where it really is (a 180° turn would put it 1.5 m away).
      expect(Math.hypot(cue!.pos.x - FIX[0]!.pos.x, cue!.pos.y - FIX[0]!.pos.y), `cue frame ${i}`).toBeLessThan(0.01);
      cue0 ??= cue!.pos;
      expect(Math.hypot(cue!.pos.x - cue0.x, cue!.pos.y - cue0.y), `cue frame ${i}`).toBeLessThan(0.01);
      for (const ball of r.balls) {
        const prev = ids.get(ball.id);
        if (prev) expect(Math.hypot(prev.x - ball.pos.x, prev.y - ball.pos.y), `${ball.id} frame ${i}`).toBeLessThan(0.03);
        ids.set(ball.id, ball.pos);
      }
      expect(ids.size, `ids issued after lock by frame ${i}`).toBeLessThanOrEqual(FIX.length);
      // Every truth ball has a reported ball nearby. Tolerance 5 cm: the frozen purple/orange pair
      // (0.5 mm apart, 3.7 m from the camera) is sometimes read as one blob between the two.
      const errs = ballErrors(r, FIX);
      expect(median(errs)).toBeLessThan(0.01);
      for (const e of errs) expect(e).toBeLessThan(0.05);
    }
    expect(locked).toBe(true);
  });
});

describe('manual corners are honest', () => {
  const corner = POSES.corner!;
  const exact = outerCorners(corner);

  it.each([0.1, 0.2, 0.4])('camera shifted %s m along +x after a manual lock: not locked, quality < 0.8 within 2 frames', (dx) => {
    const p = createPipeline({ table, fovDeg: 66, manualCorners: exact });
    const f0 = render(corner);
    let r: VisionResult = p.process(f0);
    for (let i = 0; i < 3; i++) r = p.process(f0);
    expect(r.status).toBe('locked');
    const moved = render({ ...corner, pos: { ...corner.pos, x: corner.pos.x + dx }, target: { ...corner.target, x: corner.target.x + dx } });
    p.process(moved);
    r = p.process(moved);
    console.log(`manual, camera moved ${dx} m: status ${r.status}, quality ${r.quality.toFixed(2)}, reason ${r.reason}`);
    expect(r.status).not.toBe('locked');
    expect(r.quality).toBeLessThan(0.8);
  });

  it('camera pointed away from the table: never locked', () => {
    const away = render({ pos: { x: -3.5, y: 0, z: 1.5 }, target: { x: -5.5, y: 0, z: 0 }, fovDeg: 66 }, { floor: [150, 95, 45] });
    const rs = run({ table, fovDeg: 66, manualCorners: exact }, [away, away, away, away, away, away]);
    for (const r of rs) expect(r.status).not.toBe('locked');
  });

  it('bad manual quads (double tap, collinear, concave, a ball instead of a corner) never lock', () => {
    const f = render(corner);
    const m = cameraModel(corner, 640, 480);
    const c = exact;
    const centre = m.project({ x: 0, y: 0, z: 0 });
    const mid = { x: (c[0]!.x + c[1]!.x) / 2, y: (c[0]!.y + c[1]!.y) / 2 };
    const cue = m.project({ x: FIX[0]!.pos.x, y: FIX[0]!.pos.y, z: table.ballRadius });
    for (const quad of [
      [c[0]!, c[1]!, c[1]!, c[3]!],
      [c[0]!, mid, c[1]!, c[3]!],
      [c[0]!, c[1]!, c[2]!, centre],
      [c[0]!, c[1]!, cue, c[3]!],
    ]) {
      const rs = run({ table, fovDeg: 66, manualCorners: quad }, [f, f, f, f, f, f]);
      for (const r of rs) {
        expect(r.status).not.toBe('locked');
        expect(r.calibration).toBeNull();
        expect(r.reason).toBe('bad-quad');
      }
    }
  });
});

/** Paint a shaded red ellipse (an arm or a shirt over the table) onto a copy of the frame. */
function withEllipse(f: Frame, cx: number, cy: number, rx = 84, ry = 70): Frame {
  const data = new Uint8ClampedArray(f.data);
  for (let y = Math.floor(cy - ry); y <= cy + ry; y++)
    for (let x = Math.floor(cx - rx); x <= cx + rx; x++) {
      if (x < 0 || y < 0 || x >= f.width || y >= f.height) continue;
      const u = ((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2;
      if (u > 1) continue;
      const k = 0.55 + 0.45 * (1 - u);
      const i = (y * f.width + x) * 4;
      data[i] = 200 * k;
      data[i + 1] = 30 * k;
      data[i + 2] = 40 * k;
    }
  return { width: f.width, height: f.height, data };
}

describe('an object over the table does not become the cloth', () => {
  it.each([
    ['static', 0],
    ['drifting 3 px/frame', 3],
  ])('side view, %s red ellipse over the centre', (_name, drift) => {
    const cam = POSES.side!;
    const clean = render(cam);
    const p = createPipeline({ table, fovDeg: 68 });
    let r: VisionResult = p.process(clean);
    for (let i = 0; i < 7; i++) r = p.process(clean);
    expect(r.status).toBe('locked');
    const lockedCorners = r.calibration!.corners;
    const diag = Math.hypot(640, 480);
    for (let i = 0; i < 10; i++) {
      r = p.process(withEllipse(clean, 320 + i * drift, 240));
      expect(hueDiff(r.cloth!.hue, 140)).toBeLessThan(10);
      if (r.status === 'locked') {
        const moved = Math.max(...lockedCorners.map((q) => Math.min(...r.calibration!.corners.map((c) => Math.hypot(c.x - q.x, c.y - q.y)))));
        expect(moved / diag).toBeLessThan(0.03);
      }
    }
    let back = 0;
    for (let i = 1; i <= 3; i++) {
      r = p.process(clean);
      if (r.balls.length === FIX.length) {
        back = i;
        break;
      }
    }
    expect(back).toBeGreaterThan(0);
  });
});
describe('a new cloth colour must persist before it replaces the established one', () => {
  it('a red board over most of the view: 4 frames change nothing; from the 5th it is the cloth, and the lock starts over', () => {
    const clean = render(POSES.side!);
    const board = withRect(clean, 70, 60, 570, 420, [190, 35, 45]);
    const p = createPipeline({ table, fovDeg: 68 });
    let r: VisionResult = p.process(clean);
    for (let i = 0; i < 7; i++) r = p.process(clean);
    expect(r.status).toBe('locked');
    for (let i = 0; i < 4; i++) {
      r = p.process(board);
      expect(hueDiff(r.cloth!.hue, 140), `frame ${i}`).toBeLessThan(10);
      expect(r.status).not.toBe('locked');
      expect(r.calibration).toBeNull();
    }
    r = p.process(board);
    expect(hueDiff(r.cloth!.hue, 140)).toBeGreaterThan(90);
    // The new hypothesis earns its own lock (5 calm frames), it does not inherit 'locked'.
    for (let i = 0; i < 4; i++) {
      expect(r.status).not.toBe('locked');
      r = p.process(board);
    }
  });
});

/** Paint a flat-colour rectangle onto a copy of the frame. */
function withRect(f: Frame, x0: number, y0: number, x1: number, y1: number, rgb: RGB): Frame {
  const data = new Uint8ClampedArray(f.data);
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const i = (y * f.width + x) * 4;
      data[i] = rgb[0];
      data[i + 1] = rgb[1];
      data[i + 2] = rgb[2];
    }
  return { width: f.width, height: f.height, data };
}

describe('no stale geometry', () => {
  it('after a lock, black frames give no calibration and no balls; the table re-locks with the same ids', () => {
    const f = render(POSES.side!);
    const p = createPipeline({ table, fovDeg: 68 });
    let r: VisionResult = p.process(f);
    for (let i = 0; i < 7; i++) r = p.process(f);
    expect(r.status).toBe('locked');
    const ids = r.balls.map((b) => b.id).sort();
    const black = blackFrame();
    for (let i = 0; i < 5; i++) {
      const rb = p.process(black);
      expect(rb.calibration).toBeNull();
      expect(rb.balls).toHaveLength(0);
      expect(rb.status).not.toBe('locked');
    }
    for (let i = 0; i < 8; i++) r = p.process(f);
    expect(r.status).toBe('locked');
    expect(r.balls.map((b) => b.id).sort()).toEqual(ids);
  });
});

describe('ball ids survive config messages (vision worker)', () => {
  it('identical config keeps ids; a swapAxes change never reuses an old id', () => {
    const handle = createVisionHandler();
    const send = (msg: VisionIn): VisionOut | null => {
      const reply = handle(structuredClone(msg));
      return reply ? structuredClone(reply.msg) : null;
    };
    const config = { v: PROTOCOL_VERSION, type: 'config', table, fovDeg: 68, manualCorners: null, swapAxes: false } as const;
    let id = 0;
    const frame = (f: Frame): VisionResult => {
      const out = send({ v: PROTOCOL_VERSION, type: 'frame', id: ++id, width: f.width, height: f.height, buffer: f.data.slice().buffer });
      if (!out || out.type !== 'result') throw new Error(`unexpected reply ${out?.type}`);
      return out.result;
    };
    const a = render(POSES.side!);
    // The yellow ball at (0.35, 0.18) rolls 20 cm: a new track and a new id.
    const balls = FIX.map((b, i) => (i === 1 ? { ...b, pos: { x: 0.55, y: 0.18 } } : b));
    const b = render(POSES.side!, { balls });
    expect(send(config)).toBeNull();
    let r = frame(a);
    for (let i = 0; i < 7; i++) r = frame(a);
    expect(r.status).toBe('locked');
    for (let i = 0; i < 6; i++) r = frame(b);
    const before = new Map(r.balls.map((x) => [x.id, x.pos]));
    expect(before.size).toBe(FIX.length);
    const issued = new Set<string>();
    for (const x of r.balls) issued.add(x.id);

    expect(send(structuredClone(config))).toBeNull();
    r = frame(b);
    expect(r.balls.length).toBe(FIX.length);
    for (const x of r.balls) {
      const p = before.get(x.id);
      expect(p, x.id).toBeDefined();
      expect(Math.hypot(p!.x - x.pos.x, p!.y - x.pos.y)).toBeLessThan(0.02);
    }
    // A fovDeg-only change is not a geometry change either.
    expect(send({ ...config, fovDeg: 70 })).toBeNull();
    r = frame(b);
    expect(r.balls.length).toBe(FIX.length);
    for (const x of r.balls) expect(before.has(x.id), x.id).toBe(true);

    expect(send({ ...config, swapAxes: true })).toBeNull();
    for (let i = 0; i < 6; i++) {
      r = frame(b);
      for (const x of r.balls) if (x.id !== 'cue') expect(issued.has(x.id), x.id).toBe(false);
    }
  });
});

describe('2R separation of reported balls', () => {
  const R = table.ballRadius;
  const ob = { x: 0.6, y: 0.2 };
  const tr = { x: table.length / 2, y: table.width / 2 };
  const u = { x: (tr.x - ob.x) / Math.hypot(tr.x - ob.x, tr.y - ob.y), y: (tr.y - ob.y) / Math.hypot(tr.x - ob.x, tr.y - ob.y) };
  const gap = 0.0002;
  const cue = { x: ob.x - u.x * (2 * R + gap), y: ob.y - u.y * (2 * R + gap) };
  const balls: SynthBall[] = [{ pos: cue, color: BALL_COLORS.cue! }, { pos: ob, color: BALL_COLORS.red! }, ...FIX.slice(1)];
  it.each(['corner', 'side', 'overhead'] as const)('%s view: a cue ball frozen behind an object ball (0.2 mm gap): every pair ≥ 2R apart', (pose) => {
    const f = render(POSES[pose]!, { balls });
    const rs = run({ table, fovDeg: POSES[pose]!.fovDeg }, Array.from({ length: 8 }, () => f));
    let pairs = 0;
    for (const r of rs)
      for (let i = 0; i < r.balls.length; i++)
        for (let j = i + 1; j < r.balls.length; j++) {
          const a = r.balls[i]!.pos;
          const b = r.balls[j]!.pos;
          expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(2 * R - 1e-6);
          pairs++;
        }
    expect(pairs).toBeGreaterThan(0);
    for (const b of rs[rs.length - 1]!.balls) {
      expect(Math.abs(b.pos.x)).toBeLessThanOrEqual(table.length / 2 - R + 1e-9);
      expect(Math.abs(b.pos.y)).toBeLessThanOrEqual(table.width / 2 - R + 1e-9);
    }
  });
});
