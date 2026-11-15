/**
 * Shared scene, calibration and scoring helpers for the ball-detection robustness tests on ray-traced
 * scenes (ball-detect-clusters.test.ts, ball-detect-determinism.test.ts). The same definitions as in
 * ball-detect-edge.test.ts: exact ground truth, calibration-consistent references for jittered
 * calibrations, one-to-one matching within 6 cm.
 */
import { expect } from 'vitest';
import { makeTable } from '../../../src/core/table';
import type { TablePresetId } from '../../../src/core/types';
import type { Vec2 } from '../../../src/core/vec';
import { detectBalls, type DetectedBall } from '../../../src/vision/ball-detect';
import { calibrationFromCorners, type Calibration } from '../../../src/vision/calibration';
import { applyH, invert3 } from '../../../src/vision/homography';
import { frameToHsv, type Frame } from '../../../src/vision/image';
import { BALL_COLORS, cameraModel, renderSyntheticTable, type RGB, type SynthBall, type SynthCamera, type SynthScene } from '../../../src/vision/synth/render';
import { createTableScratch, detectTable, learnClothInQuad, type ClothModel } from '../../../src/vision/table-detect';
import { POSES } from '../../helpers/scenes';

export type Pose = 'end' | 'side' | 'corner' | 'overhead';
export const ALL_POSES: Pose[] = ['end', 'side', 'corner', 'overhead'];
export const C = BALL_COLORS;
export const pool9 = makeTable('pool9');
export const R9 = pool9.ballRadius;

/** Pulled-back poses so the whole 12-ft snooker table is in view (as in ball-detect-edge). */
export const SNOOKER_POSES: Record<Pose, SynthCamera> = {
  end: { pos: { x: -3.5, y: 0, z: 2.1 }, target: { x: 0.3, y: 0, z: 0 }, fovDeg: 66 },
  corner: { pos: { x: -3.0, y: -2.0, z: 2.2 }, target: { x: 0.2, y: 0.05, z: 0 }, fovDeg: 66 },
  side: { pos: { x: 0.2, y: -2.6, z: 2.3 }, target: { x: 0, y: 0.08, z: 0 }, fovDeg: 70 },
  overhead: { pos: { x: 0, y: -0.45, z: 3.7 }, target: { x: 0, y: 0, z: 0 }, fovDeg: 64 },
};

/** Simulate video chroma subsampling (YUV 4:2:0): full-res luma, 2×2-averaged chroma. */
export function chroma420(f: Frame): Frame {
  const { width: w, height: h, data } = f;
  const out = new Uint8ClampedArray(data.length);
  const ys = [0, 0, 0, 0];
  const off = [0, 0, 1, 0, 0, 1, 1, 1];
  for (let j = 0; j < h; j += 2)
    for (let i = 0; i < w; i += 2) {
      let cb = 0;
      let cr = 0;
      for (let q = 0; q < 4; q++) {
        const k = ((j + off[q * 2 + 1]!) * w + i + off[q * 2]!) * 4;
        const r = data[k]!;
        const g = data[k + 1]!;
        const b = data[k + 2]!;
        ys[q] = 0.299 * r + 0.587 * g + 0.114 * b;
        cb += -0.168736 * r - 0.331264 * g + 0.5 * b;
        cr += 0.5 * r - 0.418688 * g - 0.081312 * b;
      }
      cb /= 4;
      cr /= 4;
      for (let q = 0; q < 4; q++) {
        const k = ((j + off[q * 2 + 1]!) * w + i + off[q * 2]!) * 4;
        const y = ys[q]!;
        out[k] = y + 1.402 * cr;
        out[k + 1] = y - 0.344136 * cb - 0.714136 * cr;
        out[k + 2] = y + 1.772 * cb;
        out[k + 3] = 255;
      }
    }
  return { width: w, height: h, data: out };
}

/** The 8-bit YUV 4:2:0 round trip a video encoder and decoder make (scripts/make-fake-camera.ts). */
export function yuv420(f: Frame): Frame {
  const { width: w, height: h, data } = f;
  const out = new Uint8ClampedArray(data.length);
  for (let j = 0; j < h; j += 2)
    for (let i = 0; i < w; i += 2) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let q = 0; q < 4; q++) {
        const k = ((j + (q >> 1)) * w + i + (q & 1)) * 4;
        r += data[k]!;
        g += data[k + 1]!;
        b += data[k + 2]!;
      }
      r /= 4;
      g /= 4;
      b /= 4;
      const U = Math.max(0, Math.min(255, Math.round(128 - 0.168736 * r - 0.331264 * g + 0.5 * b))) - 128;
      const V = Math.max(0, Math.min(255, Math.round(128 + 0.5 * r - 0.418688 * g - 0.081312 * b))) - 128;
      for (let q = 0; q < 4; q++) {
        const k = ((j + (q >> 1)) * w + i + (q & 1)) * 4;
        const Y = Math.round(0.299 * data[k]! + 0.587 * data[k + 1]! + 0.114 * data[k + 2]!);
        out[k] = Y + 1.402 * V;
        out[k + 1] = Y - 0.344136 * U - 0.714136 * V;
        out[k + 2] = Y + 1.772 * U;
        out[k + 3] = 255;
      }
    }
  return { width: w, height: h, data: out };
}

/**
 * YUV 4:2:0 as a GPU (or a JPEG decoder's fancy upsampling) shows it: full-res 8-bit luma, chroma
 * averaged per 2×2 block to 8 bits and upsampled BILINEARLY from the block centres, (2i + ½, 2j + ½) in
 * pixel units, instead of replicated. The chroma transitions are then smooth over about 4 px.
 */
export function bilinear420(f: Frame): Frame {
  const { width: w, height: h, data } = f;
  const cw = w >> 1;
  const ch = h >> 1;
  const U = new Float64Array(cw * ch);
  const V = new Float64Array(cw * ch);
  for (let j = 0; j < ch; j++)
    for (let i = 0; i < cw; i++) {
      let u = 0;
      let v = 0;
      for (let q = 0; q < 4; q++) {
        const k = ((2 * j + (q >> 1)) * w + 2 * i + (q & 1)) * 4;
        u += -0.168736 * data[k]! - 0.331264 * data[k + 1]! + 0.5 * data[k + 2]!;
        v += 0.5 * data[k]! - 0.418688 * data[k + 1]! - 0.081312 * data[k + 2]!;
      }
      U[j * cw + i] = Math.round(u / 4);
      V[j * cw + i] = Math.round(v / 4);
    }
  const out = new Uint8ClampedArray(data.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const k = (y * w + x) * 4;
      const Y = Math.round(0.299 * data[k]! + 0.587 * data[k + 1]! + 0.114 * data[k + 2]!);
      const fx = Math.max(0, Math.min(cw - 1, (x + 0.5) / 2 - 0.5));
      const fy = Math.max(0, Math.min(ch - 1, (y + 0.5) / 2 - 0.5));
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const x1 = Math.min(cw - 1, x0 + 1);
      const y1 = Math.min(ch - 1, y0 + 1);
      const ax = fx - x0;
      const ay = fy - y0;
      const a = y0 * cw;
      const b = y1 * cw;
      const u = (U[a + x0]! * (1 - ax) + U[a + x1]! * ax) * (1 - ay) + (U[b + x0]! * (1 - ax) + U[b + x1]! * ax) * ay;
      const v = (V[a + x0]! * (1 - ax) + V[a + x1]! * ax) * (1 - ay) + (V[b + x0]! * (1 - ax) + V[b + x1]! * ax) * ay;
      out[k] = Y + 1.402 * v;
      out[k + 1] = Y - 0.344136 * u - 0.714136 * v;
      out[k + 2] = Y + 1.772 * u;
      out[k + 3] = 255;
    }
  return { width: w, height: h, data: out };
}

/** Exposure change: every channel scaled by `g`. */
export function gain(f: Frame, g: number): Frame {
  const d = new Uint8ClampedArray(f.data.length);
  for (let i = 0; i < d.length; i++) d[i] = (i & 3) === 3 ? 255 : f.data[i]! * g;
  return { width: f.width, height: f.height, data: d };
}

export function mk(preset: TablePresetId, camera: SynthCamera, balls: SynthBall[], extra: Partial<SynthScene> = {}): SynthScene {
  return { table: makeTable(preset), balls, camera, width: 640, height: 480, ss: 2, ...extra };
}

const frames = new Map<string, Frame>();
/** Render once per key. */
export function render(sc: SynthScene, key?: string): Frame {
  const hit = key ? frames.get(key) : undefined;
  if (hit) return hit;
  const f = renderSyntheticTable(sc);
  if (key) frames.set(key, f);
  return f;
}

/** Image corners of the outer cloth edge, projected by the synthetic camera. */
export function exactCorners(sc: SynthScene): Vec2[] {
  const cam = cameraModel(sc.camera, sc.width, sc.height);
  const t = sc.table;
  const X = t.length / 2 + t.cushionWidth;
  const Y = t.width / 2 + t.cushionWidth;
  return [
    [-X, -Y],
    [X, -Y],
    [X, Y],
    [-X, Y],
  ].map(([x, y]) => cam.project({ x: x!, y: y!, z: t.cushionHeight }));
}

/** Calibration straight from the synthetic camera. */
export function exactCalibration(sc: SynthScene): Calibration {
  const cam = cameraModel(sc.camera, sc.width, sc.height);
  const t = sc.table;
  return { corners: exactCorners(sc), H0: cam.planeH(0), HR: cam.planeH(t.ballRadius), focal: cam.f, focalSource: 'estimated', source: 'manual', camera: { ...cam.C }, width: sc.width, height: sc.height };
}

/** Deterministic uniform numbers in [−1, 1) (LCG). */
export function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return (s / 4294967296) * 2 - 1;
  };
}

/** A calibration to run the detector with; `refs`: each truth ball as a perfect detector places it under this calibration. */
export interface CalCase {
  name: string;
  cal: Calibration | null;
  refs: Vec2[] | null;
}

/** The 60 jittered calibrations of ball-detect-edge's cluster tests: [corner amplitude px, seeds, first seed]. */
export const JITTER: readonly (readonly [number, number, number])[] = [
  [0.3, 30, 1000],
  [0.15, 12, 3000],
  [0.5, 12, 4000],
  [1, 6, 2000],
];

/** auto, exact, then the jittered `sets` (exact corners moved uniformly by ±amp px). */
export function calibrationSet(sc: SynthScene, sets: readonly (readonly [number, number, number])[] = JITTER, withAuto = true): CalCase[] {
  const ex = exactCorners(sc);
  const cam = cameraModel(sc.camera, sc.width, sc.height);
  const out: CalCase[] = [];
  if (withAuto) out.push({ name: 'auto', cal: null, refs: null });
  out.push({ name: 'exact', cal: exactCalibration(sc), refs: null });
  for (const [amp, n, seed0] of sets)
    for (let s = 0; s < n; s++) {
      const rn = lcg(seed0 + s);
      const cal = calibrationFromCorners(
        ex.map((p) => ({ x: p.x + amp * rn(), y: p.y + amp * rn() })),
        sc.table,
        sc.width,
        sc.height,
      );
      expect(cal, `±${amp} px seed ${seed0 + s} calibrates`).not.toBeNull();
      const Hi = invert3(cal!.HR);
      const refs = sc.balls.map((b) => {
        const q = cam.project({ x: b.pos.x, y: b.pos.y, z: sc.table.ballRadius });
        return applyH(Hi, q.x, q.y);
      });
      out.push({ name: `±${amp} px seed ${seed0 + s}`, cal, refs });
    }
  return out;
}

/** Share of each ball's silhouette that no other ball covers (ray cast, 2×2 rays per pixel). */
export function exclusiveShare(sc: SynthScene): number[] {
  const cam = cameraModel(sc.camera, sc.width, sc.height);
  const [rt, dn, fw] = cam.R;
  const R = sc.table.ballRadius;
  const n = sc.balls.length;
  const own = new Float64Array(n);
  const tot = new Float64Array(n);
  for (let y = 0; y < sc.height * 2; y++)
    for (let x = 0; x < sc.width * 2; x++) {
      const u = ((x + 0.5) / 2 - sc.width / 2) / cam.f;
      const v = ((y + 0.5) / 2 - sc.height / 2) / cam.f;
      const dx = rt.x * u + dn.x * v + fw.x;
      const dy = rt.y * u + dn.y * v + fw.y;
      const dz = rt.z * u + dn.z * v + fw.z;
      const dl = Math.sqrt(dx * dx + dy * dy + dz * dz);
      let hits = 0;
      let who = -1;
      for (let i = 0; i < n; i++) {
        const ox = cam.C.x - sc.balls[i]!.pos.x;
        const oy = cam.C.y - sc.balls[i]!.pos.y;
        const oz = cam.C.z - R;
        const b = (ox * dx + oy * dy + oz * dz) / dl;
        if (b > 0 || b * b - (ox * ox + oy * oy + oz * oz - R * R) < 0) continue;
        hits++;
        who = i;
        tot[i]! += 1;
      }
      if (hits === 1) own[who]! += 1;
    }
  return [...own].map((o, i) => o / Math.max(1, tot[i]!));
}

function clothInQuad(frame: Frame, quad: Vec2[]): ClothModel | null {
  const sc = createTableScratch(frame.width, frame.height);
  frameToHsv(frame, sc.hue, sc.sat, sc.val);
  return learnClothInQuad(sc, quad);
}

export interface Run {
  balls: DetectedBall[];
  /** Per truth ball: index of the matched detection (−1 = missed) and its error in metres. */
  match: { det: number; err: number }[];
  /** Detections matched to no truth ball. */
  fp: number[];
}

const tables = new WeakMap<Frame, ReturnType<typeof detectTable>>();
/** detectTable is deterministic: one table fit per frame object. */
export function tableOf(frame: Frame): ReturnType<typeof detectTable> {
  if (!tables.has(frame)) tables.set(frame, detectTable(frame));
  return tables.get(frame)!;
}

/** Detect under calibration case `c`, then match one-to-one (greedy, within 6 cm) to the truth. */
export function detectWith(sc: SynthScene, frame: Frame, c: CalCase): Run {
  const det = tableOf(frame);
  if (!c.cal) expect(det, 'table detected').not.toBeNull();
  const cal = c.cal ?? calibrationFromCorners(det!.corners, sc.table, frame.width, frame.height);
  expect(cal, 'calibrated').not.toBeNull();
  const cloth = det?.cloth ?? clothInQuad(frame, cal!.corners);
  expect(cloth, 'cloth model').not.toBeNull();
  const balls = detectBalls(frame, cal!, sc.table, cloth!);
  const truth = c.refs ?? sc.balls.map((b) => b.pos);
  let best: (Run & { cost: number }) | null = null;
  // With auto calibration the table's 180° symmetry is resolved by whichever orientation fits better.
  for (const sign of c.cal ? [1] : [1, -1]) {
    const pairs: { t: number; d: number; dist: number }[] = [];
    truth.forEach((tb, ti) => balls.forEach((db, di) => pairs.push({ t: ti, d: di, dist: Math.hypot(db.pos.x - sign * tb.x, db.pos.y - sign * tb.y) })));
    pairs.sort((a, b) => a.dist - b.dist);
    const match = sc.balls.map(() => ({ det: -1, err: Infinity }));
    const used = new Set<number>();
    for (const p of pairs) {
      if (match[p.t]!.det >= 0 || used.has(p.d) || p.dist > 0.06) continue;
      match[p.t] = { det: p.d, err: p.dist };
      used.add(p.d);
    }
    const fp = balls.map((_, i) => i).filter((i) => !used.has(i));
    const cost = match.reduce((a, m) => a + Math.min(m.err, 0.1), 0) + 0.1 * fp.length;
    if (!best || cost < best.cost) best = { balls, match, fp, cost };
  }
  return best!;
}

/** Truth index of the ball flagged as the cue: −1 none, −2 a detection that is no real ball. */
export function cueIndex(r: Run): number {
  const di = r.balls.findIndex((b) => b.isCue);
  if (di < 0) return -1;
  const ti = r.match.findIndex((m) => m.det === di);
  return ti >= 0 ? ti : -2;
}

export function errStats(r: Run, idx = r.match.map((_, i) => i)) {
  const mm = idx.map((i) => r.match[i]!.err * 1000).sort((a, b) => a - b);
  return { median: mm[Math.floor(mm.length / 2)]!, p95: mm[Math.min(mm.length - 1, Math.ceil(mm.length * 0.95) - 1)]!, max: mm[mm.length - 1]!, mm };
}

export const fmt = (mm: number[]) => mm.map((e) => (Number.isFinite(e) ? e.toFixed(1) : 'MISS')).join(' ');

/** Distance (m) from a detection to the nearest truth ball under the run's orientation (both signs: auto). */
export function nearestTruth(sc: SynthScene, b: DetectedBall): number {
  let d = Infinity;
  for (const t of sc.balls) d = Math.min(d, Math.hypot(b.pos.x - t.pos.x, b.pos.y - t.pos.y), Math.hypot(b.pos.x + t.pos.x, b.pos.y + t.pos.y));
  return d;
}

const RACK_COLS: RGB[] = [C.yellow!, C.blue!, C.red!, C.purple!, C.orange!, C.green!, C.maroon!, C.black!];

/** Touching cluster at the foot spot (0.2 mm gaps): 3-ball row, 9-ball diamond or 15-ball triangle, plus the cue ball. */
export function rack(n: 3 | 9 | 15, camera: SynthCamera, extra: Partial<SynthScene> = {}): SynthScene {
  const balls: SynthBall[] = [{ pos: { x: -0.635, y: 0.1 }, color: C.cue! }];
  const g = R9 + 0.0001;
  const rows = n === 9 ? [1, 2, 3, 2, 1] : n === 15 ? [1, 2, 3, 4, 5] : [3];
  let idx = 0;
  rows.forEach((cnt, row) => {
    for (let k = 0; k < cnt; k++) {
      const x = n === 3 ? 0.4 + (k - 1) * 2 * g : 0.635 + row * Math.sqrt(3) * g;
      const y = n === 3 ? 0.15 : (k - (cnt - 1) / 2) * 2 * g;
      balls.push({ pos: { x, y }, color: RACK_COLS[idx % RACK_COLS.length]!, ...(idx >= 8 ? { stripe: true } : {}) });
      idx++;
    }
  });
  return mk('pool9', camera, balls, extra);
}

/** 15 touching reds behind the pink spot of a 12-ft snooker table, plus the cue ball. */
export function snookerPack(camera: SynthCamera, extra: Partial<SynthScene> = {}): SynthScene {
  const t = makeTable('snooker12');
  const R = t.ballRadius;
  const balls: SynthBall[] = [{ pos: { x: -1.2, y: 0.15 }, color: C.cue! }];
  const apex = t.length / 4 + 2 * R + 0.002;
  const g = R + 0.0001;
  for (let row = 0; row < 5; row++) for (let k = 0; k <= row; k++) balls.push({ pos: { x: apex + row * Math.sqrt(3) * g, y: (k - row / 2) * 2 * g }, color: C.red! });
  return mk('snooker12', camera, balls, extra);
}

/** Cue ball plus a touching yellow-blue-red row through (x, y) along the line of sight (`deg` off it). */
export function rowAt(camera: SynthCamera, x: number, y: number, deg = 0): SynthScene {
  const g = R9 + 0.0001;
  const a = Math.atan2(y - camera.pos.y, x - camera.pos.x) + (deg * Math.PI) / 180;
  const cols = [C.yellow!, C.blue!, C.red!];
  const balls: SynthBall[] = [{ pos: { x: -0.635, y: 0.1 }, color: C.cue! }];
  for (let k = 0; k < 3; k++) balls.push({ pos: { x: x + (k - 1) * 2 * g * Math.cos(a), y: y + (k - 1) * 2 * g * Math.sin(a) }, color: cols[k]! });
  return mk('pool9', camera, balls);
}

export { POSES };
