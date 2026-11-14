import { describe, expect, it } from 'vitest';
import { makeTable } from '../../../src/core/table';
import type { TablePresetId } from '../../../src/core/types';
import type { Vec2 } from '../../../src/core/vec';
import { frameToHsv, hueDiff, type Frame } from '../../../src/vision/image';
import { cameraModel, fixtureBalls, renderSyntheticTable, type RGB, type SynthCamera } from '../../../src/vision/synth/render';
import { createTableScratch, detectTable, learnCloth, quadQuality, type TableScratch } from '../../../src/vision/table-detect';
import { POSES, scene } from '../../helpers/scenes';

const CLOTHS: Record<string, RGB> = { green: [40, 130, 70], blue: [30, 80, 160], red: [150, 30, 40] };
const GREYS: RGB[] = [
  [110, 116, 124],
  [80, 86, 92],
];

function trueCorners(pose: keyof typeof POSES) {
  const s = scene(pose);
  const cam = cameraModel(s.camera, s.width, s.height);
  const t = s.table;
  const X = t.length / 2 + t.cushionWidth;
  const Y = t.width / 2 + t.cushionWidth;
  return [
    [-X, -Y],
    [X, -Y],
    [X, Y],
    [-X, Y],
  ].map(([x, y]) => cam.project({ x: x!, y: y!, z: t.cushionHeight }));
}

/** Outer cloth-edge corners of any camera / preset / frame size. */
function cornersOf(camera: SynthCamera, width: number, height: number, preset: TablePresetId = 'pool9'): Vec2[] {
  const t = makeTable(preset);
  const cam = cameraModel(camera, width, height);
  const X = t.length / 2 + t.cushionWidth;
  const Y = t.width / 2 + t.cushionWidth;
  return [
    [-X, -Y],
    [X, -Y],
    [X, Y],
    [-X, Y],
  ].map(([x, y]) => cam.project({ x: x!, y: y!, z: t.cushionHeight }));
}

function renderOf(camera: SynthCamera, width: number, height: number, preset: TablePresetId = 'pool9', cloth?: RGB): Frame {
  const table = makeTable(preset);
  return renderSyntheticTable({ table, balls: fixtureBalls(table).balls, camera, width, height, ss: 1, ...(cloth ? { cloth } : {}) });
}

const cornerErrors = (truth: Vec2[], found: Vec2[]) => truth.map((t) => Math.min(...found.map((c) => Math.hypot(c.x - t.x, c.y - t.y))));

describe('table detection on synthetic renders', () => {
  const cases: [keyof typeof POSES, string][] = [
    ['end', 'green'],
    ['side', 'green'],
    ['corner', 'green'],
    ['overhead', 'green'],
    ['side', 'blue'],
    ['corner', 'red'],
  ];
  it.each(cases)('%s view, %s cloth: corners within 1.5%% of the diagonal', (pose, cloth) => {
    const frame = renderSyntheticTable({ ...scene(pose, { cloth: CLOTHS[cloth]! }), ss: 1 });
    const det = detectTable(frame);
    expect(det).not.toBeNull();
    const truth = trueCorners(pose);
    const diag = Math.hypot(frame.width, frame.height);
    const errs = truth.map((t) => Math.min(...det!.corners.map((c) => Math.hypot(c.x - t.x, c.y - t.y))));
    console.log(`${pose}/${cloth}: corner errors px ${errs.map((e) => e.toFixed(1)).join(', ')} (quality ${det!.quality.toFixed(2)})`);
    for (const e of errs) expect(e / diag).toBeLessThan(0.015);
    expect(det!.quality).toBeGreaterThan(0.7);
  });

  it('returns null when there is no table', () => {
    const frame = renderSyntheticTable({ ...scene('end'), camera: { pos: { x: 0, y: 0, z: 3 }, target: { x: 0, y: 0, z: 6 }, fovDeg: 60 }, ss: 1 });
    expect(detectTable(frame)).toBeNull();
  });
});

describe('table filling the frame (pocket cut-outs wider than a fixed refine band)', () => {
  const overhead = (z: number, fovDeg: number): SynthCamera => ({ pos: { x: 0, y: -0.35, z }, target: { x: 0, y: 0, z: 0 }, fovDeg });
  // [name, camera, preset, frame heights]. The high end view only fits a 640×480 frame: at 640×360 its
  // near corners leave the image (a truncation case, covered in pipeline-live.test.ts).
  const cams: [string, SynthCamera, TablePresetId, number[]][] = [
    ['overhead fov64 z2.4', overhead(2.4, 64), 'pool9', [480, 360]],
    ['overhead fov64 z2.5', overhead(2.5, 64), 'pool9', [480, 360]],
    ['overhead fov64 z2.6', overhead(2.6, 64), 'pool9', [480, 360]],
    ['overhead fov45 z3.4', overhead(3.4, 45), 'pool9', [480, 360]],
    ['overhead fov45 z4.0', overhead(4.0, 45), 'pool9', [480, 360]],
    ['end view from (−2.2, 0, 2.5) fov66', { pos: { x: -2.2, y: 0, z: 2.5 }, target: { x: 0, y: 0, z: 0 }, fovDeg: 66 }, 'pool9', [480]],
    ['pool8 overhead z2.4', overhead(2.4, 64), 'pool8', [480, 360]],
  ];
  const cases = cams.flatMap(([name, cam, preset, hs]) => hs.map((h) => [`${name} 640×${h}`, cam, preset, h] as const));
  it.each(cases)('%s: corners within 1.5%% of the diagonal, quality ≥ 0.9', (name, cam, preset, h) => {
    const truth = cornersOf(cam, 640, h, preset);
    // The scene keeps the whole cloth in view (else it would be a truncation case).
    for (const p of truth) expect(p.x > 0 && p.x < 640 && p.y > 0 && p.y < h, `${name}: corner in view`).toBe(true);
    const frame = renderOf(cam, 640, h, preset);
    const det = detectTable(frame);
    expect(det, name).not.toBeNull();
    const diag = Math.hypot(640, h);
    const errs = cornerErrors(truth, det!.corners);
    console.log(`${name}: corner errors ${errs.map((e) => ((100 * e) / diag).toFixed(2)).join(', ')} % of diag, quality ${det!.quality.toFixed(3)}`);
    for (const e of errs) expect(e / diag).toBeLessThan(0.015);
    expect(det!.quality).toBeGreaterThanOrEqual(0.9);
  });

  it('quality is an IoU: one side of a correct quad moved 25 px inward drops it below 0.9', () => {
    const cam = overhead(2.5, 64);
    const frame = renderOf(cam, 640, 360);
    const sc = createTableScratch(640, 360);
    const det = detectTable(frame, sc)!;
    expect(det).not.toBeNull();
    const truth = cornersOf(cam, 640, 360);
    expect(quadQuality(sc, truth)).toBeGreaterThanOrEqual(0.9);
    // Move the near long side (corners 0, 1: −y, the bottom of the image) 25 px inward (up).
    expect(truth[0]!.y).toBeGreaterThan(truth[3]!.y);
    const moved = truth.map((p, i) => (i < 2 ? { x: p.x, y: p.y - 25 } : p));
    expect(quadQuality(sc, moved)).toBeLessThan(0.9);
    // Mask pixels outside the quad count against it, so a quad inside the cloth no longer scores 1.
    const inset = truth.map((p) => ({ x: 320 + 0.85 * (p.x - 320), y: 180 + 0.85 * (p.y - 180) }));
    expect(quadQuality(sc, inset)).toBeLessThan(0.9);
  });
});

describe('a table cut off by the frame border: null or exact, never a wrong outline', () => {
  // Near-rail side views with one near corner just off-screen. A side running into the border is
  // supported by two separate clusters (its real edge and stray points near the border); a line
  // through both used to give a confident outline 2-3.4 % of the diagonal off.
  const cams: [string, SynthCamera][] = [
    ['(0.677, −1.910, 1.442) fov63.9', { pos: { x: 0.6768802, y: -1.9104572, z: 1.4420085 }, target: { x: 0.0023461, y: -0.2050598, z: 0 }, fovDeg: 63.948667 }],
    ['(0.527, −1.706, 1.594) fov65.5', { pos: { x: 0.5266352, y: -1.7057492, z: 1.594243 }, target: { x: -0.0144974, y: -0.162916, z: 0 }, fovDeg: 65.4704 }],
    ['(−0.409, −1.669, 1.887) fov64.0', { pos: { x: -0.4090023, y: -1.6685463, z: 1.8874973 }, target: { x: 0.1123408, y: -0.1221668, z: 0 }, fovDeg: 64.025444 }],
  ];
  it.each(cams)('side view from %s: detectTable is null or every corner is within 1.5 %% of the diagonal', (name, cam) => {
    const truth = cornersOf(cam, 640, 480);
    expect(truth.some((p) => p.x < 0 || p.y < 0 || p.x > 640 || p.y > 480), `${name}: a corner is off-screen`).toBe(true);
    const det = detectTable(renderOf(cam, 640, 480));
    const diag = Math.hypot(640, 480);
    if (det) {
      const errs = cornerErrors(truth, det.corners);
      console.log(`truncated ${name}: corner errors ${errs.map((e) => ((100 * e) / diag).toFixed(2)).join(', ')} % of diag, quality ${det.quality.toFixed(3)}`);
      for (const e of errs) expect(e / diag).toBeLessThan(0.015);
    } else console.log(`truncated ${name}: null`);
  });
});

describe('grey (low-saturation) cloth', () => {
  it.each(GREYS)('cloth rgb(%i, %i, %i): automatic detection finds the corners within 1.5%% of the diagonal', (r, g, b) => {
    for (const pose of ['corner', 'side'] as const) {
      const frame = renderSyntheticTable({ ...scene(pose, { cloth: [r, g, b] }), ss: 1 });
      const det = detectTable(frame);
      expect(det, pose).not.toBeNull();
      expect(det!.cloth.kind).toBe('neutral');
      const diag = Math.hypot(frame.width, frame.height);
      const errs = cornerErrors(trueCorners(pose), det!.corners);
      console.log(`grey ${r},${g},${b} ${pose}: corner errors px ${errs.map((e) => e.toFixed(1)).join(', ')} (quality ${det!.quality.toFixed(2)})`);
      for (const e of errs) expect(e / diag).toBeLessThan(0.015);
    }
  });

  // A pure grey (S < 0.08) on the default grey floor: the neutral model also matches the floor (a
  // larger component outside the rails); the table is the component the camera is aimed at.
  it.each([
    [120, 120, 120],
    [110, 112, 116],
    [150, 150, 150],
  ] as RGB[])('pure grey cloth rgb(%i, %i, %i) on a grey floor, side, corner and overhead views: corners within 1.5 %% of the diagonal', (r, g, b) => {
    for (const pose of ['side', 'corner', 'overhead'] as const) {
      const frame = renderSyntheticTable({ ...scene(pose, { cloth: [r, g, b] }), ss: 1 });
      const det = detectTable(frame);
      expect(det, pose).not.toBeNull();
      const diag = Math.hypot(frame.width, frame.height);
      const errs = cornerErrors(trueCorners(pose), det!.corners);
      console.log(`pure grey ${r},${g},${b} ${pose}: corner errors px ${errs.map((e) => e.toFixed(1)).join(', ')} (quality ${det!.quality.toFixed(2)})`);
      for (const e of errs) expect(e / diag).toBeLessThan(0.015);
      expect(det!.quality).toBeGreaterThanOrEqual(0.9);
    }
  });

  // End and corner views put the wooden rails and floor in the central window (≈ 30 % saturated):
  // the chromatic vote goes to the floor, and the grey cloth must still be found.
  it.each([
    [110, 116, 124],
    [80, 86, 92],
    [120, 120, 120],
  ] as RGB[])('cloth rgb(%i, %i, %i) on a wooden floor, end and corner views: found as neutral cloth, corners within 1.5 %% of the diagonal', (r, g, b) => {
    for (const pose of ['end', 'corner'] as const) {
      const frame = renderSyntheticTable({ ...scene(pose, { cloth: [r, g, b] }), floor: [150, 95, 45], ss: 1 });
      const det = detectTable(frame);
      expect(det, pose).not.toBeNull();
      expect(det!.cloth.kind).toBe('neutral');
      const diag = Math.hypot(frame.width, frame.height);
      const errs = cornerErrors(trueCorners(pose), det!.corners);
      console.log(`grey ${r},${g},${b} on wood ${pose}: corner errors px ${errs.map((e) => e.toFixed(1)).join(', ')} (quality ${det!.quality.toFixed(2)})`);
      for (const e of errs) expect(e / diag).toBeLessThan(0.015);
      expect(det!.quality).toBeGreaterThanOrEqual(0.9);
    }
  });
});

/** The pre-histogram learnCloth (sort-based medians), kept as the reference. */
function referenceLearnCloth(sc: TableScratch): { hue: number; sat: number; val: number } | null {
  const { w, h, hue, sat, val } = sc;
  const bins = new Float64Array(36);
  const x0 = Math.floor(w * 0.3);
  const x1 = Math.ceil(w * 0.7);
  const y0 = Math.floor(h * 0.3);
  const y1 = Math.ceil(h * 0.7);
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const i = y * w + x;
      if (sat[i]! > 0.2 && val[i]! > 0.12) bins[Math.min(35, Math.floor(hue[i]! / 10))]! += 1;
    }
  let mode = 0;
  for (let b = 1; b < 36; b++) if (bins[b]! > bins[mode]!) mode = b;
  const total = bins.reduce((a, b) => a + b, 0);
  if (total < (x1 - x0) * (y1 - y0) * 0.2) return null;
  const centre = mode * 10 + 5;
  let sx = 0;
  let sy = 0;
  const ss: number[] = [];
  const vs: number[] = [];
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const i = y * w + x;
      if (sat[i]! > 0.2 && val[i]! > 0.12 && hueDiff(hue[i]!, centre) < 20) {
        const a = (hue[i]! * Math.PI) / 180;
        sx += Math.cos(a);
        sy += Math.sin(a);
        ss.push(sat[i]!);
        vs.push(val[i]!);
      }
    }
  ss.sort((a, b) => a - b);
  vs.sort((a, b) => a - b);
  let mh = (Math.atan2(sy, sx) * 180) / Math.PI;
  if (mh < 0) mh += 360;
  return { hue: mh, sat: ss[ss.length >> 1] ?? 0.5, val: vs[vs.length >> 1] ?? 0.5 };
}

describe('learnCloth statistics (allocation-free histograms)', () => {
  const cases = (['end', 'side', 'corner', 'overhead'] as const).flatMap((pose) => Object.keys(CLOTHS).map((cloth) => [pose, cloth] as const));
  it.each(cases)('%s view, %s cloth: medians match the sort-based reference within 1/255', (pose, cloth) => {
    const frame = renderSyntheticTable({ ...scene(pose, { cloth: CLOTHS[cloth]! }), ss: 1 });
    const sc = createTableScratch(frame.width, frame.height);
    frameToHsv(frame, sc.hue, sc.sat, sc.val);
    const ref = referenceLearnCloth(sc)!;
    const got = learnCloth(sc)!;
    expect(ref).not.toBeNull();
    expect(got).not.toBeNull();
    expect(Math.abs(got.sat - ref.sat)).toBeLessThanOrEqual(1 / 255);
    expect(Math.abs(got.val - ref.val)).toBeLessThanOrEqual(1 / 255);
    expect(hueDiff(got.hue, ref.hue)).toBeLessThan(0.5);
  });

  it('learnCloth takes < 5 ms on a 640×480 frame (median of 9)', () => {
    const frame = renderSyntheticTable({ ...scene('corner'), ss: 1 });
    const sc = createTableScratch(frame.width, frame.height);
    frameToHsv(frame, sc.hue, sc.sat, sc.val);
    for (let i = 0; i < 3; i++) learnCloth(sc);
    const t: number[] = [];
    for (let i = 0; i < 9; i++) {
      const t0 = performance.now();
      learnCloth(sc);
      t.push(performance.now() - t0);
    }
    t.sort((a, b) => a - b);
    console.log(`learnCloth 640×480: median ${t[4]!.toFixed(2)} ms`);
    expect(t[4]!).toBeLessThan(5);
  });
});
