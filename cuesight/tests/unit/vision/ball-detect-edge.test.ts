/**
 * Ball-detection robustness on ray-traced scenes with exact ground truth (spec 001 edge cases,
 * SC-003; Constitution II, III, IV): cue-ball identification (none, ambiguous, dim video), touching
 * clusters, side-by-side pairs, cloth-coloured balls, glare and cue-stick shapes, balls hanging in
 * the pocket jaws, colour names, and per-frame allocation.
 */
import { describe, expect, it } from 'vitest';
import { makeTable } from '../../../src/core/table';
import type { TablePresetId } from '../../../src/core/types';
import { detectBalls, type DetectedBall } from '../../../src/vision/ball-detect';
import { calibrationFromCorners, type Calibration } from '../../../src/vision/calibration';
import type { Frame } from '../../../src/vision/image';
import { BALL_COLORS, cameraModel, fixtureBalls, renderSyntheticTable, type RGB, type SynthBall, type SynthCamera, type SynthScene } from '../../../src/vision/synth/render';
import { detectTable, type ClothModel } from '../../../src/vision/table-detect';
import { POSES } from '../../helpers/scenes';

type Pose = 'end' | 'side' | 'corner' | 'overhead';
const ALL_POSES: Pose[] = ['end', 'side', 'corner', 'overhead'];
const C = BALL_COLORS;
const pool9 = makeTable('pool9');
const R9 = pool9.ballRadius;

/** Pulled-back poses so the whole 12-ft snooker table is in view. */
const SNOOKER_POSES: Record<Pose, SynthCamera> = {
  end: { pos: { x: -3.5, y: 0, z: 2.1 }, target: { x: 0.3, y: 0, z: 0 }, fovDeg: 66 },
  corner: { pos: { x: -3.0, y: -2.0, z: 2.2 }, target: { x: 0.2, y: 0.05, z: 0 }, fovDeg: 66 },
  side: { pos: { x: 0.2, y: -2.6, z: 2.3 }, target: { x: 0, y: 0.08, z: 0 }, fovDeg: 70 },
  overhead: { pos: { x: 0, y: -0.45, z: 3.7 }, target: { x: 0, y: 0, z: 0 }, fovDeg: 64 },
};

// --- helpers ------------------------------------------------------------------------------------------

/** Simulate video chroma subsampling (YUV 4:2:0): full-res luma, 2×2-averaged chroma. */
function chroma420(f: Frame): Frame {
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

/** Exposure change: every channel scaled by `g`. */
function gain(f: Frame, g: number): Frame {
  const d = new Uint8ClampedArray(f.data.length);
  for (let i = 0; i < d.length; i++) d[i] = (i & 3) === 3 ? 255 : f.data[i]! * g;
  return { width: f.width, height: f.height, data: d };
}

function mk(preset: TablePresetId, camera: SynthCamera, balls: SynthBall[], extra: Partial<SynthScene> = {}): SynthScene {
  return { table: makeTable(preset), balls, camera, width: 640, height: 480, ss: 2, ...extra };
}

const frames = new Map<string, Frame>();
/** Render once per key (the fixture renders are shared by several groups). */
function render(sc: SynthScene, key?: string): Frame {
  const hit = key ? frames.get(key) : undefined;
  if (hit) return hit;
  const f = renderSyntheticTable(sc);
  if (key) frames.set(key, f);
  return f;
}

/** Calibration straight from the synthetic camera (tests detection alone, not table detection). */
function exactCalibration(sc: SynthScene): Calibration {
  const cam = cameraModel(sc.camera, sc.width, sc.height);
  const t = sc.table;
  const X = t.length / 2 + t.cushionWidth;
  const Y = t.width / 2 + t.cushionWidth;
  const corners = [
    [-X, -Y],
    [X, -Y],
    [X, Y],
    [-X, Y],
  ].map(([x, y]) => cam.project({ x: x!, y: y!, z: t.cushionHeight }));
  return { corners, H0: cam.planeH(0), HR: cam.planeH(t.ballRadius), focal: cam.f, focalSource: 'estimated', source: 'manual', camera: { ...cam.C }, width: sc.width, height: sc.height };
}

interface Run {
  balls: DetectedBall[];
  cloth: ClothModel;
  /** Per truth ball: index of the matched detection (−1 = missed) and its error in metres. */
  match: { det: number; err: number }[];
  /** Detections matched to no truth ball. */
  fp: number[];
}

/**
 * Detect, then match one-to-one (greedy, within 6 cm) to the truth. With auto calibration the
 * table's 180° symmetry is resolved by whichever orientation fits better.
 */
function detect(sc: SynthScene, frame: Frame, o: { exact?: boolean } = {}): Run {
  const det = detectTable(frame);
  expect(det, 'table detected').not.toBeNull();
  const cal = o.exact ? exactCalibration(sc) : calibrationFromCorners(det!.corners, sc.table, frame.width, frame.height);
  expect(cal, 'calibrated').not.toBeNull();
  const balls = detectBalls(frame, cal!, sc.table, det!.cloth);
  let best: (Run & { cost: number }) | null = null;
  for (const sign of o.exact ? [1] : [1, -1]) {
    const pairs: { t: number; d: number; dist: number }[] = [];
    sc.balls.forEach((tb, ti) => balls.forEach((db, di) => pairs.push({ t: ti, d: di, dist: Math.hypot(db.pos.x - sign * tb.pos.x, db.pos.y - sign * tb.pos.y) })));
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
    if (!best || cost < best.cost) best = { balls, cloth: det!.cloth, match, fp, cost };
  }
  return best!;
}

/** Truth index of the ball flagged as the cue: −1 none, −2 a detection that is no real ball. */
function cueIndex(r: Run): number {
  const di = r.balls.findIndex((b) => b.isCue);
  if (di < 0) return -1;
  const ti = r.match.findIndex((m) => m.det === di);
  return ti >= 0 ? ti : -2;
}

function errStats(r: Run, idx = r.match.map((_, i) => i)) {
  const mm = idx.map((i) => r.match[i]!.err * 1000).sort((a, b) => a - b);
  return { median: mm[Math.floor(mm.length / 2)]!, p95: mm[Math.min(mm.length - 1, Math.ceil(mm.length * 0.95) - 1)]!, max: mm[mm.length - 1]!, mm };
}

const fmt = (mm: number[]) => mm.map((e) => (Number.isFinite(e) ? e.toFixed(1) : 'MISS')).join(' ');
const labelOf = (r: Run, ti: number) => (r.match[ti]!.det >= 0 ? r.balls[r.match[ti]!.det]!.label : 'MISSED');

// --- scenes -------------------------------------------------------------------------------------------

function fixture(pose: Pose, extra: SynthBall[] = [], o: Partial<SynthScene> = {}): SynthScene {
  return mk('pool9', POSES[pose]!, [...fixtureBalls(pool9).balls, ...extra], o);
}
const fixtureFrame = (pose: Pose) => render(fixture(pose), `fixture-${pose}`);

const STRIPE_COLOURS: RGB[] = [C.yellow!, C.blue!, C.red!, C.purple!, C.orange!, C.green!, C.maroon!];
const SPREAD = [
  [-0.75, -0.12],
  [0.35, 0.18],
  [0.55, -0.3],
  [-0.2, 0.42],
  [0.9, 0.05],
  [-0.5, -0.45],
  [0.1, -0.05],
  [1.1, 0.25],
];
/**
 * Stripe axis horizontal and square to the line of sight, so the band faces the camera. (A stripe
 * whose band is edge-on to the camera shows only white and is physically indistinguishable from the
 * cue ball at these resolutions; the detector cannot be asked to tell them apart.)
 */
function bandFacing(pose: Pose, x: number, y: number) {
  const c = POSES[pose]!.pos;
  const l = Math.hypot(x - c.x, y - c.y) || 1;
  return { x: -(y - c.y) / l, y: (x - c.x) / l, z: 0 };
}

/** Ball in hand after a scratch: eight stripes (bands in view), no cue ball. */
function stripesOnly(pose: Pose, rot: number): SynthScene {
  return mk(
    'pool9',
    POSES[pose]!,
    SPREAD.map(([x, y], i) => ({ pos: { x: x!, y: y! }, color: STRIPE_COLOURS[(i + rot) % STRIPE_COLOURS.length]!, stripe: true, axis: bandFacing(pose, x!, y!) })),
  );
}

/** Touching cluster at the foot spot (0.2 mm gaps): 3-ball row, 9-ball diamond or 15-ball triangle. */
function rack(n: 3 | 9 | 15, pose: Pose): SynthScene {
  const cols: RGB[] = [C.yellow!, C.blue!, C.red!, C.purple!, C.orange!, C.green!, C.maroon!, C.black!];
  const balls: SynthBall[] = [{ pos: { x: -0.635, y: 0.1 }, color: C.cue! }];
  const g = R9 + 0.0001;
  const rows = n === 9 ? [1, 2, 3, 2, 1] : n === 15 ? [1, 2, 3, 4, 5] : [3];
  let idx = 0;
  rows.forEach((cnt, row) => {
    for (let k = 0; k < cnt; k++) {
      const x = n === 3 ? 0.4 + (k - 1) * 2 * g : 0.635 + row * Math.sqrt(3) * g;
      const y = n === 3 ? 0.15 : (k - (cnt - 1) / 2) * 2 * g;
      balls.push({ pos: { x, y }, color: cols[idx % cols.length]!, ...(idx >= 8 ? { stripe: true } : {}) });
      idx++;
    }
  });
  return mk('pool9', POSES[pose]!, balls);
}

/** 15 touching reds behind the pink spot of a 12-ft snooker table, plus the cue ball. */
function snookerPack(pose: Pose): SynthScene {
  const t = makeTable('snooker12');
  const R = t.ballRadius;
  const balls: SynthBall[] = [{ pos: { x: -1.2, y: 0.15 }, color: C.cue! }];
  const apex = t.length / 4 + 2 * R + 0.002;
  const g = R + 0.0001;
  for (let row = 0; row < 5; row++) for (let k = 0; k <= row; k++) balls.push({ pos: { x: apex + row * Math.sqrt(3) * g, y: (k - row / 2) * 2 * g }, color: C.red! });
  return mk('snooker12', SNOOKER_POSES[pose], balls);
}

const SNOOKER_NAMES = ['cue', 'yellow', 'green', 'brown', 'blue', 'pink', 'black', 'red', 'red'];
/** The snooker colours on their spots (WPBSA: baulk line 737 mm from the baulk cushion). */
function snookerColours(pose: Pose): SynthScene {
  const t = makeTable('snooker12');
  const baulkX = -t.length / 2 + 0.737;
  return mk('snooker12', SNOOKER_POSES[pose], [
    { pos: { x: -1.2, y: 0.15 }, color: C.cue! },
    { pos: { x: baulkX, y: -0.292 }, color: C.yellow! },
    { pos: { x: baulkX, y: 0.292 }, color: C.green! },
    { pos: { x: baulkX, y: 0 }, color: C.brown! },
    { pos: { x: 0, y: 0 }, color: C.blue! },
    { pos: { x: t.length / 4, y: 0 }, color: C.pink! },
    { pos: { x: t.length / 2 - 0.324, y: 0 }, color: C.black! },
    { pos: { x: 0.5, y: -0.4 }, color: C.red! },
    { pos: { x: -0.4, y: 0.5 }, color: C.red! },
  ]);
}

/** Cue ball plus two touching red/blue pairs whose axis is `deg` off the viewing direction. */
function pairs(pose: Pose, deg: number, width = 640, height = 480): SynthScene {
  const cam = POSES[pose]!;
  const balls: SynthBall[] = [{ pos: { x: -0.75, y: -0.12 }, color: C.cue! }];
  for (const [cx, cy] of [
    [0.3, 0.1],
    [0.8, 0.35],
  ]) {
    const a = Math.atan2(cy! - cam.pos.y, cx! - cam.pos.x) + (deg * Math.PI) / 180;
    const g = R9 + 0.0002;
    balls.push({ pos: { x: cx! - g * Math.cos(a), y: cy! - g * Math.sin(a) }, color: C.red! });
    balls.push({ pos: { x: cx! + g * Math.cos(a), y: cy! + g * Math.sin(a) }, color: C.blue! });
  }
  return mk('pool9', cam, balls, { width, height });
}

/** Cue ball plus one ball `d`·R inside the mouth of each listed pocket. */
function hangers(pose: Pose, d: number, color: RGB, ids?: string[]): SynthScene {
  const ps = pool9.pockets.filter((p) => !ids || ids.includes(p.id));
  return mk('pool9', POSES[pose]!, [
    { pos: { x: -0.3, y: -0.1 }, color: C.cue! },
    ...ps.map((p) => ({ pos: { x: p.mouthCenter.x + d * R9 * p.inward.x, y: p.mouthCenter.y + d * R9 * p.inward.y }, color })),
  ]);
}

/** Soft white lamp glare (Gaussian, σ = half the given size) blended onto the frame at a table point. */
function withGlare(sc: SynthScene, f: Frame, rx: number, ry: number, at = { x: 0.2, y: -0.3 }): Frame {
  const c = cameraModel(sc.camera, sc.width, sc.height).project({ x: at.x, y: at.y, z: 0 });
  const d = new Uint8ClampedArray(f.data);
  for (let y = 0; y < sc.height; y++)
    for (let x = 0; x < sc.width; x++) {
      const a = 0.85 * Math.exp(-2 * (((x + 0.5 - c.x) / rx) ** 2 + ((y + 0.5 - c.y) / ry) ** 2));
      if (a < 0.01) continue;
      const k = (y * sc.width + x) * 4;
      for (let ch = 0; ch < 3; ch++) d[k + ch] = d[k + ch]! * (1 - a) + 250 * a;
    }
  return { width: f.width, height: f.height, data: d };
}

/** Fixture plus a cue stick lined up behind the cue ball, 20° to the long rail, 10 mm tip gap. */
function withStick(pose: Pose): SynthScene {
  const sc = fixture(pose);
  const cb = sc.balls[0]!.pos;
  const a = (20 * Math.PI) / 180;
  const el = (4 * Math.PI) / 180; // butt raised over the rail
  const L = 1.45;
  const tip = { x: cb.x - Math.cos(a) * (R9 + 0.01), y: cb.y - Math.sin(a) * (R9 + 0.01), z: R9 };
  const butt = { x: tip.x - Math.cos(a) * L * Math.cos(el), y: tip.y - Math.sin(a) * L * Math.cos(el), z: R9 + L * Math.sin(el) };
  return { ...sc, sticks: [{ tip, butt, tipRadius: 0.0065, buttRadius: 0.015 }] };
}

// --- tests --------------------------------------------------------------------------------------------

describe('cue-ball identification', () => {
  it.each(ALL_POSES)('%s: with no cue ball on the table no stripe is called the cue', (pose) => {
    for (const rot of [0, 3, 5]) {
      const f = render(stripesOnly(pose, rot));
      for (const frame of [f, chroma420(f)]) {
        const r = detect(stripesOnly(pose, rot), frame);
        const cue = r.balls.find((b) => b.isCue);
        expect(cue, `rot ${rot}: ${cue?.label} white ${cue?.white.toFixed(2)}`).toBeUndefined();
      }
    }
  });

  it.each(ALL_POSES)('%s: with a green-band stripe in view the real cue ball is still the cue', (pose) => {
    for (const spot of [
      [0.3, 0.3],
      [-0.9, 0.35],
    ]) {
      const sc = fixture(pose, [{ pos: { x: spot[0]!, y: spot[1]! }, color: C.green!, stripe: true, axis: bandFacing(pose, spot[0]!, spot[1]!) }]);
      const f = render(sc);
      for (const frame of [f, chroma420(f)]) {
        const r = detect(sc, frame);
        expect(cueIndex(r), `spot ${spot}: ${r.balls.map((b) => `${b.label}:${b.white.toFixed(2)}`).join(' ')}`).toBe(0);
      }
    }
  });

  it('green-band stripe in any orientation: almost never taken for the cue (was 14 of 16 frames)', () => {
    // With its band edge-on and in shadow, a green stripe is a white cap over a dark rim, as the cue
    // ball is; then no ball (ambiguous) or, rarely, the stripe is flagged. Count those over 16 frames.
    let wrong = 0;
    let real = 0;
    const seen: string[] = [];
    for (const pose of ALL_POSES)
      for (const spot of [
        [0.3, 0.3],
        [-0.9, 0.35],
      ]) {
        const sc = fixture(pose, [{ pos: { x: spot[0]!, y: spot[1]! }, color: C.green!, stripe: true }]);
        const f = render(sc);
        for (const frame of [f, chroma420(f)]) {
          const ci = cueIndex(detect(sc, frame));
          if (ci === 0) real++;
          else if (ci !== -1) {
            wrong++;
            seen.push(`${pose} ${spot}: ${ci}`);
          }
        }
      }
    expect(wrong, seen.join('; ')).toBeLessThanOrEqual(1);
    expect(real).toBeGreaterThanOrEqual(12);
  });

  it('dim 4:2:0 corner view: a stripe is never chosen as the cue ball', () => {
    const sc = fixture('corner');
    const f = chroma420(fixtureFrame('corner'));
    for (const g of [0.8, 0.65]) {
      const r = detect(sc, gain(f, g));
      // Either the real cue ball or no cue at all (the player is then asked to tap it), never another ball.
      expect([0, -1], `gain ${g}: ${r.balls.map((b) => `${b.label}:${b.white.toFixed(2)}`).join(' ')}`).toContain(cueIndex(r));
    }
  });
});

describe('touching clusters', () => {
  // Seen from low down, a pack's interior balls can sit wholly inside their neighbours' silhouettes:
  // nothing in the outline says they are there, so the detector does not invent them (Constitution II).
  // Those few are the only misses allowed (the 0.2.x detector missed 3–7 per pack and placed the rest
  // 25–35 mm off); where every silhouette shows, every ball must be found. Never a phantom ball.
  const cases: [string, (p: Pose) => SynthScene, Partial<Record<Pose, number>>][] = [
    ['3-ball row', (p) => rack(3, p), {}],
    ['9-ball diamond', (p) => rack(9, p), { end: 1, corner: 1 }],
    ['15-ball triangle', (p) => rack(15, p), { end: 3, side: 1, corner: 2 }],
    ['snooker 15-red pack', snookerPack, { end: 2, corner: 3 }],
  ];
  for (const [name, build, hidden] of cases)
    it.each(ALL_POSES)(`${name}, %s view: every visible ball, median ≤ 10 mm, p95 ≤ 25 mm`, (pose) => {
      const sc = build(pose);
      const r = detect(sc, render(sc));
      const found = r.match.map((_, i) => i).filter((i) => r.match[i]!.det >= 0);
      const s = errStats(r, found);
      const missed = sc.balls.length - found.length;
      console.log(`${name} ${pose}: ${r.balls.length}/${sc.balls.length}, errors mm ${fmt(errStats(r).mm)}`);
      expect(r.fp, 'phantom balls').toHaveLength(0);
      expect(missed).toBeLessThanOrEqual(hidden[pose] ?? 0);
      expect(s.median).toBeLessThanOrEqual(10);
      // Next to an uncounted ball the neighbours' fits absorb a little of its silhouette.
      expect(s.p95).toBeLessThanOrEqual(missed ? 30 : 25);
    });
});

describe('touching pairs side by side across the view', () => {
  it.each(['end', 'corner'] as Pose[])('%s view: both balls of each pair at every angle to the view', (pose) => {
    for (const deg of [0, 30, 45, 60, 75, 90]) {
      const sc = pairs(pose, deg);
      const r = detect(sc, render(sc));
      const msg = `${deg}°: errors mm ${fmt(r.match.map((m) => m.err * 1000))}, labels ${r.balls.map((b) => b.label).join(',')}`;
      expect(r.balls.length, msg).toBe(5);
      for (const m of r.match) expect(m.err * 1000, msg).toBeLessThanOrEqual(12);
      for (const ti of [1, 3]) expect(labelOf(r, ti), msg).toBe('red');
      for (const ti of [2, 4]) expect(labelOf(r, ti), msg).toBe('blue');
    }
  });

  it('640×360 end view, pairs square to the view (exact calibration)', () => {
    // At 640×360 the automatic table fit is ~10 cm off (the table fills the frame edge to edge), which
    // is table-detect's business; with the camera's own calibration this tests the detector alone.
    const sc = pairs('end', 90, 640, 360);
    const r = detect(sc, render(sc), { exact: true });
    const msg = `errors mm ${fmt(r.match.map((m) => m.err * 1000))}, labels ${r.balls.map((b) => b.label).join(',')}`;
    expect(r.balls.length, msg).toBe(5);
    for (const m of r.match) expect(m.err * 1000, msg).toBeLessThanOrEqual(12);
    expect([labelOf(r, 1), labelOf(r, 2), labelOf(r, 3), labelOf(r, 4)], msg).toEqual(['red', 'blue', 'red', 'blue']);
  });
});

describe('green balls on green cloth', () => {
  it.each(['end', 'side', 'corner'] as Pose[])('snooker %s view: the green on its spot is found', (pose) => {
    const sc = snookerColours(pose);
    const r = detect(sc, render(sc, `snooker-colours-${pose}`));
    expect(r.match[2]!.err * 1000, `labels ${SNOOKER_NAMES.map((n, i) => `${n}->${labelOf(r, i)}`).join(' ')}`).toBeLessThanOrEqual(10);
    expect(r.fp).toHaveLength(0);
  });

  const spots = [
    [-0.95, 0.3],
    [0.25, -0.3],
    [0.7, 0.4],
    [-0.3, 0.1],
    [1.05, -0.35],
  ];
  it.each(ALL_POSES)('pool %s view: a solid green 6 is found at five spots (RGB and 4:2:0)', (pose) => {
    // Green (S 0.82) on green cloth (S 0.69) is the hardest contrast there is: only the saturation
    // separates them, and video chroma subsampling blurs that across the rim. RGB frames: all five
    // within 12 mm. 4:2:0: at least four of five (one is lost in the corner view). Never a phantom.
    const sc = fixture(
      pose,
      spots.map(([x, y]) => ({ pos: { x: x!, y: y! }, color: C.green! })),
    );
    const f = render(sc);
    for (const [frame, need] of [
      [f, 5],
      [chroma420(f), 4],
    ] as const) {
      const r = detect(sc, frame);
      const s = errStats(r, [9, 10, 11, 12, 13]);
      expect(s.mm.filter((e) => e <= 12).length, `green errors mm ${fmt(s.mm)}`).toBeGreaterThanOrEqual(need);
      expect(r.fp).toHaveLength(0);
      expect(cueIndex(r)).toBe(0);
    }
  });
});

describe('shape gate: glare and a cue stick are not balls', () => {
  it.each(ALL_POSES)('%s view: lamp glare on the cloth adds no ball and never becomes the cue', (pose) => {
    const sc = fixture(pose);
    for (const [rx, ry] of [
      [8, 5],
      [14, 8],
      [24, 12],
    ]) {
      const r = detect(sc, withGlare(sc, fixtureFrame(pose), rx!, ry!));
      const msg = `glare ${rx}×${ry}: ${r.balls.map((b) => `${b.label}:${b.white.toFixed(2)}`).join(' ')}`;
      expect(r.balls.length, msg).toBe(sc.balls.length);
      expect(cueIndex(r), msg).toBe(0);
    }
  });

  it.each(ALL_POSES)('%s view: a cue stick behind the cue ball adds no phantom ball', (pose) => {
    const sc = withStick(pose);
    const r = detect(sc, render(sc));
    const msg = `${r.balls.map((b) => `${b.label}:${b.white.toFixed(2)}`).join(' ')}`;
    expect(r.balls.length, msg).toBe(sc.balls.length);
    expect(r.fp, msg).toHaveLength(0);
    expect(cueIndex(r), msg).toBe(0);
  });
});

describe('balls hanging in the pocket jaws (exact calibration)', () => {
  it.each(ALL_POSES)('%s view: a ball 1R or 2R inside any pocket mouth is found within 10 mm', (pose) => {
    for (const d of [1, 2]) {
      const sc = hangers(pose, d, C.yellow!);
      const r = detect(sc, render(sc), { exact: true });
      const mm = r.match.map((m) => m.err * 1000);
      expect(Math.max(...mm), `d=${d}: cue BL BM BR TR TM TL errors mm ${fmt(mm)}`).toBeLessThanOrEqual(10);
      expect(r.fp, `d=${d}`).toHaveLength(0);
    }
  });

  it.each(ALL_POSES)('%s view: the black 2R inside a corner pocket is found within 15 mm', (pose) => {
    const sc = hangers(pose, 2, C.black!, ['BL', 'BR', 'TR', 'TL']);
    const r = detect(sc, render(sc), { exact: true });
    const mm = r.match.map((m) => m.err * 1000);
    expect(Math.max(...mm), `cue BL BR TR TL errors mm ${fmt(mm)}`).toBeLessThanOrEqual(15);
    expect(r.fp).toHaveLength(0);
  });
});

describe('colour names', () => {
  it.each([
    ['green', undefined],
    ['blue', [30, 70, 150] as RGB],
  ] as const)('pool fixture on %s cloth: the red is "red" and the maroon stripe "maroon stripe"', (_name, cloth) => {
    // The fixture's maroon stripe turns its band away from the side and corner cameras (it looks white
    // there, and 'white?' is the honest name); from the end and overhead its band is in view.
    let red = 0;
    let maroon = 0;
    const seen: string[] = [];
    for (const pose of ALL_POSES) {
      const sc = fixture(pose, [], cloth ? { cloth } : {});
      const f = cloth ? render(sc) : fixtureFrame(pose);
      for (const frame of [f, chroma420(f)]) {
        const r = detect(sc, frame);
        if (labelOf(r, 3) === 'red') red++;
        if ((pose === 'end' || pose === 'overhead') && labelOf(r, 7) === 'maroon stripe') maroon++;
        seen.push(`${pose}: ${labelOf(r, 3)} / ${labelOf(r, 7)}`);
        // Never another ball's colour (the old detector called the red 'maroon' and vice versa).
        expect(['maroon stripe', 'maroon', 'white?', 'ball'], seen.join('; ')).toContain(labelOf(r, 7));
      }
    }
    expect(red, seen.join('; ')).toBeGreaterThanOrEqual(7);
    expect(maroon, seen.join('; ')).toBe(4);
  });

  it.each(['end', 'side', 'corner'] as Pose[])('snooker %s view: pink, brown and black have their own names', (pose) => {
    const sc = snookerColours(pose);
    const r = detect(sc, render(sc, `snooker-colours-${pose}`));
    const names = SNOOKER_NAMES.map((_, i) => labelOf(r, i));
    expect(names[5], names.join(',')).toBe('pink');
    expect(names[3], names.join(',')).toBe('brown');
    expect(
      names.filter((n) => n === 'black'),
      names.join(','),
    ).toEqual(['black']);
    expect(names[6]).toBe('black');
  });
});

describe('per-frame scratch (Constitution IV)', () => {
  const sc = fixture('end');
  const frame = () => fixtureFrame('end');
  const setup = () => {
    const det = detectTable(frame())!;
    return { det, cal: calibrationFromCorners(det.corners, sc.table, sc.width, sc.height)! };
  };

  it('reusing the scratch buffers gives identical results on the same frame', () => {
    const { det, cal } = setup();
    const a = detectBalls(frame(), cal, sc.table, det.cloth);
    // A different frame in between must not leak into the next result.
    detectBalls(fixtureFrame('corner'), calibrationFromCorners(detectTable(fixtureFrame('corner'))!.corners, sc.table, sc.width, sc.height)!, sc.table, det.cloth);
    const b = detectBalls(frame(), cal, sc.table, det.cloth);
    expect(b).toEqual(a);
  });

  it('allocates no typed arrays and < 2 MB of JS heap per call once warm', () => {
    const { det, cal } = setup();
    for (let i = 0; i < 5; i++) detectBalls(frame(), cal, sc.table, det.cloth);
    let maxBuf = -Infinity;
    let maxHeap = -Infinity;
    for (let i = 0; i < 20; i++) {
      const m0 = process.memoryUsage();
      detectBalls(frame(), cal, sc.table, det.cloth);
      const m1 = process.memoryUsage();
      // A GC during the call can only lower these deltas, so the maximum is the allocation.
      maxBuf = Math.max(maxBuf, m1.arrayBuffers - m0.arrayBuffers);
      maxHeap = Math.max(maxHeap, m1.heapUsed - m0.heapUsed);
    }
    console.log(`detectBalls per call: ArrayBuffers +${(maxBuf / 1024).toFixed(0)} KB, heap +${(maxHeap / 1024).toFixed(0)} KB (max of 20)`);
    expect(maxBuf).toBeLessThan(64 * 1024);
    expect(maxHeap).toBeLessThan(2 * 1024 * 1024);
  });
});
