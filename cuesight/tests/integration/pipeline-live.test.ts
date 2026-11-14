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
import { createPipeline, separateBalls, type PipelineConfig, type VisionResult } from '../../src/vision/pipeline';
import { BALL_COLORS, cameraModel, fixtureBalls, renderSyntheticTable, type RGB, type SynthBall, type SynthCamera } from '../../src/vision/synth/render';
import { detectTable } from '../../src/vision/table-detect';
import type { TrackedBall } from '../../src/vision/tracker';
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

/** mulberry32: small deterministic PRNG, so every run sees the same trials. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());

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

  // Side and end views too (the camera move slides the quad along the cloth there), and a grey cloth on
  // a wooden floor, where the move must be seen without any help from the automatic detector.
  const shifted = (c: SynthCamera, dx: number): SynthCamera => ({ ...c, pos: { ...c.pos, x: c.pos.x + dx }, target: { ...c.target, x: c.target.x + dx } });
  const moves: [string, SynthCamera, number, RenderOpts][] = [
    ['side view, 0.1 m', POSES.side!, 0.1, {}],
    ['end view, 0.1 m', POSES.end!, 0.1, {}],
    ['side view, 4 cm', POSES.side!, 0.04, {}],
    ['end view, grey cloth on a wooden floor, 0.4 m', POSES.end!, 0.4, { cloth: [110, 116, 124], floor: [150, 95, 45] }],
    ['end view, grey cloth on a wooden floor, 0.1 m', POSES.end!, 0.1, { cloth: [110, 116, 124], floor: [150, 95, 45] }],
  ];
  it.each(moves)('%s camera move after a manual lock: not locked, quality < 0.8 within 2 frames', (_name, cam, dx, o) => {
    const p = createPipeline({ table, fovDeg: cam.fovDeg, manualCorners: outerCorners(cam) });
    const f0 = render(cam, o);
    let r: VisionResult = p.process(f0);
    for (let i = 0; i < 3; i++) r = p.process(f0);
    expect(r.status).toBe('locked');
    const moved = render(shifted(cam, dx), o);
    p.process(moved);
    r = p.process(moved);
    console.log(`manual ${_name}: status ${r.status}, quality ${r.quality.toFixed(2)}, reason ${r.reason}`);
    expect(r.status).not.toBe('locked');
    expect(r.quality).toBeLessThan(0.8);
    expect(r.reason).toBe('moved');
  });

  it.each(['corner', 'side', 'end'] as const)('%s view, taps with finger error (σ = 12 px), 12 trials: every one locks within 4 frames', (pose) => {
    const cam = POSES[pose]!;
    const exactTaps = outerCorners(cam);
    const f = render(cam);
    const r0 = rng(1000 + pose.length);
    for (let trial = 0; trial < 12; trial++) {
      const taps = exactTaps.map((q) => ({ x: q.x + 12 * gauss(r0), y: q.y + 12 * gauss(r0) }));
      const rs = run({ table, fovDeg: cam.fovDeg, manualCorners: taps }, [f, f, f, f]);
      const last = rs[rs.length - 1]!;
      expect(last.status, `trial ${trial}: quality ${last.quality.toFixed(2)}, reason ${last.reason}`).toBe('locked');
    }
  });

  it('a red block held over the table for 8 frames does not become the cloth; the taps lock again as soon as it is gone', () => {
    const cam = POSES.side!;
    const clean = render(cam);
    const p = createPipeline({ table, fovDeg: cam.fovDeg, manualCorners: outerCorners(cam) });
    let r: VisionResult = p.process(clean);
    expect(r.status).toBe('locked');
    const blocked = withRect(clean, 200, 150, 440, 400, [180, 30, 40]);
    for (let i = 0; i < 8; i++) {
      r = p.process(blocked);
      expect(hueDiff(r.cloth!.hue, 140), `frame ${i}`).toBeLessThan(10);
    }
    r = p.process(clean);
    expect(r.status).toBe('locked');
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
/** Paint a flat colour wherever `inside(x, y)` holds, on a copy of the frame. */
function paint(f: Frame, inside: (x: number, y: number) => boolean, rgb: RGB): Frame {
  const data = new Uint8ClampedArray(f.data);
  for (let y = 0; y < f.height; y++)
    for (let x = 0; x < f.width; x++) {
      if (!inside(x + 0.5, y + 0.5)) continue;
      const i = (y * f.width + x) * 4;
      data[i] = rgb[0];
      data[i + 1] = rgb[1];
      data[i + 2] = rgb[2];
    }
  return { width: f.width, height: f.height, data };
}

describe('a person or an arm over a locked table: no lock on a fragment or on the occluder', () => {
  const rect = (x0: number, y0: number, x1: number, y1: number) => (x: number, y: number) => x >= x0 && x < x1 && y >= y0 && y < y1;
  const ellipse = (cx: number, cy: number, rx: number, ry: number) => (x: number, y: number) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
  const red: RGB = [180, 30, 40];
  const cases: [string, keyof typeof POSES, (x: number, y: number) => boolean, RGB][] = [
    ['side view, red block 240×250 over the middle', 'side', rect(200, 150, 440, 400), red],
    ['side view, a torso 140 px wide, full height', 'side', rect(250, 0, 390, 480), red],
    ['side view, a red ellipse 260×220', 'side', ellipse(320, 250, 130, 110), red],
    ['side view, red block over the left half', 'side', rect(0, 150, 320, 400), red],
    ['side view, a grey shirt 240×250 over the middle', 'side', rect(200, 150, 440, 400), [150, 150, 155]],
    ['corner view, red block 240×250 over the middle', 'corner', rect(200, 150, 440, 400), red],
  ];
  it.each(cases)('%s: 12 frames never locked more than 3 %% of the diagonal off, no balls off the table; the same ids come back', (_name, pose, inside, rgb) => {
    const cam = POSES[pose]!;
    const clean = render(cam);
    const truth = outerCorners(cam);
    const diag = Math.hypot(640, 480);
    const p = createPipeline({ table, fovDeg: cam.fovDeg });
    let r: VisionResult = p.process(clean);
    for (let i = 0; i < 7; i++) r = p.process(clean);
    expect(r.status).toBe('locked');
    const ids = r.balls.map((b) => b.id).sort();
    const occluded = paint(clean, inside, rgb);
    for (let i = 0; i < 12; i++) {
      r = p.process(occluded);
      const off = r.calibration ? Math.max(...truth.map((q) => Math.min(...r.calibration!.corners.map((c) => Math.hypot(c.x - q.x, c.y - q.y))))) / diag : 0;
      if (r.status === 'locked') expect(off, `frame ${i}: locked ${(100 * off).toFixed(1)} % off`).toBeLessThan(0.03);
      // Any ball reported comes from a calibration of the real table.
      if (r.balls.length) expect(off, `frame ${i}: ${r.balls.length} balls from a quad ${(100 * off).toFixed(1)} % off`).toBeLessThan(0.03);
      expect(hueDiff(r.cloth!.hue, 140), `frame ${i}: cloth hue`).toBeLessThan(10);
    }
    // The table is the same table when the occluder leaves: the old ids come back.
    let back = false;
    for (let i = 0; i < 3 && !back; i++) {
      r = p.process(clean);
      back = r.balls.length === FIX.length && r.balls.map((b) => b.id).sort().join() === ids.join();
    }
    expect(back).toBe(true);
  });
});

describe('a real camera move is not mistaken for an occlusion', () => {
  const shift = (c: SynthCamera, dx: number, dy: number, dz = 0): SynthCamera => ({
    ...c,
    pos: { x: c.pos.x + dx, y: c.pos.y + dy, z: c.pos.z + dz },
    target: { x: c.target.x + dx, y: c.target.y + dy, z: c.target.z },
  });
  const jumps: [string, SynthCamera, SynthCamera][] = [
    ['side view, camera 0.3 m along the table', POSES.side!, shift(POSES.side!, 0.3, 0)],
    ['side view, camera 0.3 m back (the table shrinks inside the old outline)', POSES.side!, { ...POSES.side!, pos: { ...POSES.side!.pos, y: POSES.side!.pos.y - 0.3 } }],
    ['side view to the corner view', POSES.side!, POSES.corner!],
    ['corner view, camera 0.3 m higher', POSES.corner!, shift(POSES.corner!, 0, 0, 0.3)],
    // Raising the phone moves the near rail up while the far rail stays put: no cloth shows outside
    // the old outline, yet the camera moved.
    ['side view, camera 0.3 m higher', POSES.side!, shift(POSES.side!, 0, 0, 0.3)],
    ['end view, camera 0.2 m closer', POSES.end!, shift(POSES.end!, 0.2, 0)],
    ['side view, phone rolled 4°', POSES.side!, { ...POSES.side!, rollDeg: 4 }],
  ];
  it.each(jumps)('%s: re-locks on the new outline (within 1.5 %% of the diagonal) within 7 frames', (_name, a, b) => {
    const p = createPipeline({ table, fovDeg: 66 });
    const fa = render(a);
    let r: VisionResult = p.process(fa);
    for (let i = 0; i < 7; i++) r = p.process(fa);
    expect(r.status).toBe('locked');
    const fb = render(b);
    const truth = outerCorners(b);
    const diag = Math.hypot(640, 480);
    for (let i = 0; i < 7; i++) r = p.process(fb);
    expect(r.status).toBe('locked');
    for (let k = 0; k < 4; k++) expect(Math.min(...r.calibration!.corners.map((c) => Math.hypot(c.x - truth[k]!.x, c.y - truth[k]!.y))) / diag).toBeLessThan(0.015);
    expect(r.balls.length).toBeGreaterThanOrEqual(8);
  });

  it('side view, camera panning 2.5 cm per frame for 30 frames: stays locked and follows the table', () => {
    const p = createPipeline({ table, fovDeg: 68 });
    const f0 = render(POSES.side!);
    let r: VisionResult = p.process(f0);
    for (let i = 0; i < 7; i++) r = p.process(f0);
    const diag = Math.hypot(640, 480);
    for (let i = 1; i <= 30; i++) {
      const cam = shift(POSES.side!, 0.025 * i, 0);
      r = p.process(render(cam));
      expect(r.status, `frame ${i}`).toBe('locked');
      const truth = outerCorners(cam);
      for (let k = 0; k < 4; k++) expect(Math.min(...r.calibration!.corners.map((c) => Math.hypot(c.x - truth[k]!.x, c.y - truth[k]!.y))) / diag).toBeLessThan(0.015);
    }
  });
});

describe('a coloured rectangle seen first does not keep the cloth once the camera is aimed at the table', () => {
  it('3 frames of a red poster, then the side view with the poster in the background: locks on the table, never on the poster', () => {
    const red: RGB = [190, 35, 45];
    const wall = paint(uniformFrame([120, 120, 120]), (x, y) => x >= 220 && x < 420 && y >= 165 && y < 315, red);
    const scene = paint(render(POSES.side!), (x, y) => x >= 30 && x < 200 && y >= 15 && y < 135, red);
    const truth = outerCorners(POSES.side!);
    const diag = Math.hypot(640, 480);
    const p = createPipeline({ table, fovDeg: 68 });
    for (let i = 0; i < 3; i++) p.process(wall);
    let r: VisionResult = p.process(scene);
    for (let i = 0; i < 25; i++) {
      r = p.process(scene);
      if (r.status === 'locked') {
        const off = Math.max(...truth.map((q) => Math.min(...r.calibration!.corners.map((c) => Math.hypot(c.x - q.x, c.y - q.y))))) / diag;
        expect(off, `frame ${i}`).toBeLessThan(0.03);
      }
    }
    expect(r.status).toBe('locked');
    expect(hueDiff(r.cloth!.hue, 140)).toBeLessThan(10);
    for (let k = 0; k < 4; k++) expect(Math.hypot(r.calibration!.corners[k]!.x - truth[k]!.x, r.calibration!.corners[k]!.y - truth[k]!.y) / diag).toBeLessThan(0.015);
    expect(r.balls.length).toBeGreaterThanOrEqual(8);
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

describe('a lock that starts over forgets the old table frame and lock, but not the ball ids', () => {
  it('the same table re-covered in blue: adopted after 5 frames, then a fresh 5-frame lock; the balls keep their ids', () => {
    const green = render(POSES.side!);
    const blue = render(POSES.side!, { cloth: [30, 80, 160] });
    const p = createPipeline({ table, fovDeg: 68 });
    let r: VisionResult = p.process(green);
    for (let i = 0; i < 7; i++) r = p.process(green);
    expect(r.status).toBe('locked');
    const ids = r.balls.map((b) => b.id).sort();
    for (let i = 0; i < 4; i++) {
      r = p.process(blue);
      expect(hueDiff(r.cloth!.hue, 140), `frame ${i}`).toBeLessThan(10);
      expect(r.calibration).toBeNull();
    }
    // Adoption frame and the 4 after it: the new hypothesis needs 5 calm frames of its own.
    for (let i = 0; i < 5; i++) {
      r = p.process(blue);
      expect(hueDiff(r.cloth!.hue, 140), `frame ${i}`).toBeGreaterThan(60);
      expect(r.status, `frame ${i} after adoption`).not.toBe('locked');
    }
    for (let i = 0; i < 3; i++) r = p.process(blue);
    expect(r.status).toBe('locked');
    // Same table, same balls: the old ids (the blue ball is camouflaged on blue cloth, so ≥ 8 of 9).
    expect(r.balls.length).toBeGreaterThanOrEqual(8);
    for (const b of r.balls) expect(ids, b.id).toContain(b.id);
  });

  it('after the tracker gives up (searching), a new view gets the first-lock frame, not one inherited from the old view', () => {
    const p = createPipeline({ table, fovDeg: 66 });
    const side = render(POSES.side!);
    for (let i = 0; i < 8; i++) p.process(side);
    for (let i = 0; i < 10; i++) expect(p.process(blackFrame()).calibration).toBeNull();
    const end = render(POSES.end!);
    let r: VisionResult = p.process(end);
    for (let i = 0; i < 7; i++) r = p.process(end);
    expect(r.status).toBe('locked');
    // The first-lock rule puts the camera at the −x end in an end view, where it really is.
    const cue = r.balls.find((b) => b.isCue)!;
    expect(cue).toBeDefined();
    expect(Math.hypot(cue.pos.x - FIX[0]!.pos.x, cue.pos.y - FIX[0]!.pos.y)).toBeLessThan(0.02);
    expect(r.calibration!.camera.x).toBeLessThan(-1.5);
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

describe('a poor table outline never counts', () => {
  it('corner view with a forearm (skin-coloured bar) across the table: detection quality < 0.6, never locked, no calibration', () => {
    // The skin hue also matches the wooden rails, so the "table" found is arm + rails (quality 0.47);
    // only the quality gate keeps it from locking.
    const f = withRect(render(POSES.corner!), 243, 216, 333, 440, [205, 150, 120]);
    const det = detectTable(f);
    expect(det).not.toBeNull();
    expect(det!.quality).toBeLessThan(0.6);
    const rs = run({ table, fovDeg: 66 }, Array.from({ length: 10 }, () => f));
    for (const r of rs) {
      expect(r.status).not.toBe('locked');
      expect(r.calibration).toBeNull();
      expect(r.balls).toHaveLength(0);
    }
  });
});

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

  // Clusters (racks, frozen rows, balls on a cushion) need more than a few relaxation passes: the
  // planner already fails at 0.3 mm of overlap, so every pair must reach 2R.
  const xMax = table.length / 2 - R;
  const yMax = table.width / 2 - R;
  const tracked = (pos: Vec2[]): TrackedBall[] => pos.map((p, i) => ({ id: `b${i + 1}`, pos: p, image: { x: 0, y: 0 }, isCue: false, label: 'ball', rgb: [0, 0, 0], confidence: 1 }));
  /** A frozen 15-ball rack (apex at apexX, rows toward +x), scaled toward its centroid (detections biased inward). */
  const rack = (apexX: number, scale: number): Vec2[] => {
    const pts: Vec2[] = [];
    for (let row = 0; row < 5; row++) for (let k = 0; k <= row; k++) pts.push({ x: apexX + row * Math.sqrt(3) * R, y: (k - row / 2) * 2 * R });
    const cx = pts.reduce((a, p) => a + p.x, 0) / pts.length;
    const cy = pts.reduce((a, p) => a + p.y, 0) / pts.length;
    return pts.map((p) => ({ x: cx + (p.x - cx) * scale, y: cy + (p.y - cy) * scale }));
  };
  // [name, detections, largest allowed move]: a small correction, not a rearrangement (three
  // detections at one point have to spread over 4R).
  const clusters: [string, Vec2[], number][] = [
    ['rack biased 1 % inward', rack(0.6, 0.99), R],
    ['rack biased 3 % inward', rack(0.6, 0.97), R],
    ['rack frozen against the foot cushion, biased 2 %', rack(xMax - 4 * Math.sqrt(3) * R, 0.98), R],
    ['6 balls frozen along a cushion, biased 1.5 %', Array.from({ length: 6 }, (_, i) => ({ x: -0.5 + i * 2 * R * 0.985, y: -yMax })), R],
    ['a pair pushed into the side cushion', [{ x: 0.3, y: -yMax + 0.002 }, { x: 0.3, y: -yMax + 2 * R - 0.004 }], R],
    ['three coincident detections', [{ x: 0.1, y: 0.1 }, { x: 0.1, y: 0.1 }, { x: 0.1, y: 0.1 }], 4 * R],
    ['three coincident detections in a corner', [{ x: xMax, y: yMax }, { x: xMax, y: yMax }, { x: xMax, y: yMax }], 4 * R],
  ];
  it.each(clusters)('separateBalls, %s: every pair ≥ 2R − 1e-6 and inside the cushions; inputs untouched', (_name, pos, maxMove) => {
    const input = tracked(pos.map((p) => ({ ...p })));
    const out = separateBalls(input, table);
    expect(out).toHaveLength(pos.length);
    for (let i = 0; i < out.length; i++) {
      expect(input[i]!.pos).toEqual(pos[i]); // track state is not mutated
      expect(Math.abs(out[i]!.pos.x)).toBeLessThanOrEqual(xMax + 1e-12);
      expect(Math.abs(out[i]!.pos.y)).toBeLessThanOrEqual(yMax + 1e-12);
      for (let j = i + 1; j < out.length; j++) expect(Math.hypot(out[i]!.pos.x - out[j]!.pos.x, out[i]!.pos.y - out[j]!.pos.y), `${i}-${j}`).toBeGreaterThanOrEqual(2 * R - 1e-6);
    }
    for (let i = 0; i < out.length; i++) expect(Math.hypot(out[i]!.pos.x - pos[i]!.x, out[i]!.pos.y - pos[i]!.y)).toBeLessThanOrEqual(maxMove + 1e-9);
  });
  it('separateBalls leaves separated balls exactly where they are', () => {
    const pos = [
      { x: 0, y: 0 },
      { x: 2 * R + 1e-4, y: 0 },
      { x: -0.8, y: 0.3 },
    ];
    expect(separateBalls(tracked(pos), table).map((b) => b.pos)).toEqual(pos);
  });
});
