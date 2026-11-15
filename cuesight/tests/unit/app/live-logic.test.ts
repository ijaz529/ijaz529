import { describe, expect, it } from 'vitest';
import type { Ball, TableLayout, Vec2 } from '../../../src/core/types';
import type { SelectionMemory } from '../../../src/app/store';
import { makeTable } from '../../../src/core/table';
import { DEFAULT_SETTINGS } from '../../../src/app/settings';
import { applyH, homographyFrom4, invert3 } from '../../../src/vision/homography';
import { createPipeline, type VisionResult } from '../../../src/vision/pipeline';
import { BALL_COLORS, renderSyntheticTable, type SynthCamera } from '../../../src/vision/synth/render';
import {
  CALIBRATION_MESSAGES,
  LOCK_GRACE,
  REMAP_MESSAGES,
  REMAP_TTL,
  cornersOutOfView,
  landingThroughFrame,
  nextCornersOut,
  pocketThroughFrame,
  rememberInFrame,
  remapThroughFrame,
  restoreFromFrame,
  STATUS_TEXT,
  applyCueOverride,
  bedPointFromProjection,
  calibrationFeedback,
  cameraHint,
  cameraMessageTitle,
  clearSelection,
  cornersPlausible,
  dropLiveSelection,
  explicitMode,
  framesMatch,
  liveGate,
  nextSinceLocked,
  pickNextAllowed,
  pillMeta,
  pillText,
  probeCamera,
  rebindSelection,
  startMode,
  trackSelection,
  unfreezeSelection,
  visionConfigChanged,
  visionFailureMessage,
} from '../../../src/app/live-logic';

const R = 0.028575;
const ball = (id: string, x: number, y: number, kind: Ball['kind'] = 'object', label = id): Ball => ({ id, kind, pos: { x, y }, label });

describe('visionConfigChanged: only camera-relevant settings reconfigure (and so reset) the tracker', () => {
  const a = { ...DEFAULT_SETTINGS };
  it('is false for display, cloth, cushion and shaft changes', () => {
    expect(visionConfigChanged(a, { ...a })).toBe(false);
    expect(visionConfigChanged(a, { ...a, showDetails: !a.showDetails })).toBe(false);
    expect(visionConfigChanged(a, { ...a, table3d: !a.table3d })).toBe(false);
    expect(visionConfigChanged(a, { ...a, cloth: 'fast' })).toBe(false);
    expect(visionConfigChanged(a, { ...a, cushions: 'lively' })).toBe(false);
    expect(visionConfigChanged(a, { ...a, shaft: 'low-deflection' })).toBe(false);
  });
  it('is true for the table preset, the cushion width and the field of view', () => {
    expect(visionConfigChanged(a, { ...a, table: 'snooker12' })).toBe(true);
    expect(visionConfigChanged(a, { ...a, cushionWidthCm: a.cushionWidthCm + 1 })).toBe(true);
    expect(visionConfigChanged(a, { ...a, fovDeg: a.fovDeg + 5 })).toBe(true);
  });
});

describe('rebindSelection / trackSelection: a selection survives tracker id churn', () => {
  const last = { id: 'b3', pos: { x: 0.4, y: 0.1 }, label: 'red' };
  it('rebinds to a new track within 2R, preferring the same label', () => {
    const balls = [ball('b9', 0.4 + 0.5 * R, 0.1, 'object', 'yellow'), ball('b10', 0.4 + 0.8 * R, 0.1, 'object', 'red')];
    expect(rebindSelection(last, balls, R)).toBe('b10');
  });
  it('returns null when nothing new is close, and never takes an established neighbour or the cue', () => {
    expect(rebindSelection(last, [ball('b9', 1, 0.4)], R)).toBeNull();
    // b4 is touching (2R away) but was already being tracked: it is not the target re-appearing.
    expect(rebindSelection(last, [ball('b4', 0.4 + 1.9 * R, 0.1)], R, { known: new Set(['b4']) })).toBeNull();
    expect(rebindSelection(last, [ball('c', 0.4, 0.1, 'cue')], R)).toBeNull();
    expect(rebindSelection(last, [ball('c', 0.4, 0.1, 'cue')], R, { allowCue: true })).toBe('c');
    expect(rebindSelection(last, [ball('b7', 0.4, 0.1)], R, { exclude: ['b7'] })).toBeNull();
  });
  it('follows the ball while its id lives, rebinds after an occlusion, and keeps waiting meanwhile', () => {
    const f0 = [ball('b1', -0.5, 0), ball('b3', 0.4, 0.1, 'object', 'red'), ball('c', 0, 0, 'cue', 'cue')];
    // First result after the tap: the memory is seeded from the previous result.
    let t = trackSelection('b3', null, f0, [ball('b1', -0.5, 0), ball('b3', 0.41, 0.1, 'object', 'red')], R);
    expect(t.id).toBe('b3');
    expect(t.mem?.pos.x).toBeCloseTo(0.41);
    // Occluded: the id is missing and nothing new is near → keep the id, keep waiting.
    const occluded = [ball('b1', -0.5, 0)];
    t = trackSelection(t.id, t.mem, [ball('b1', -0.5, 0), ball('b3', 0.41, 0.1)], occluded, R);
    expect(t).toMatchObject({ id: 'b3', rebound: false });
    // Back with a new tracker id.
    t = trackSelection(t.id, t.mem, occluded, [ball('b1', -0.5, 0), ball('b12', 0.411, 0.101, 'object', 'red')], R);
    expect(t).toMatchObject({ id: 'b12', rebound: true });
  });
  it('clears nothing when there is no selection', () => {
    expect(trackSelection(null, null, [], [ball('b1', 0, 0)], R)).toEqual({ id: null, mem: null, rebound: false });
  });
});

describe('unfreezeSelection: the selection made on a frozen snapshot carries over to the live tracks', () => {
  const table = makeTable('pool9');
  const snapshot: TableLayout = { table, balls: [ball('b2', 0.3, 0.1), ball('b5', -0.4, 0.2, 'object', 'white'), ball('c', 0, 0, 'cue', 'cue')], source: 'camera', frozen: true };
  const vision = (balls: Ball[]) => ({ status: 'locked' as const, calibration: null, balls, quality: 1, ms: 1, frameW: 640, frameH: 480, sinceLocked: 0 });
  it('keeps ids that are still live, and re-binds an id re-issued while frozen to the ball at the same spot', () => {
    const s = { targetId: 'b2' as string | null, targetMem: null as SelectionMemory | null, cueOverrideId: 'b5' as string | null, cueMem: null as SelectionMemory | null, vision: vision([ball('b9', 0.3005, 0.1), ball('b5', -0.401, 0.2), ball('c', 0, 0, 'cue')]) };
    unfreezeSelection(s, snapshot, R);
    expect(s.targetId).toBe('b9');
    expect(s.targetMem).toMatchObject({ id: 'b9' });
    expect(s.cueOverrideId).toBe('b5');
    expect(s.cueMem?.pos.x).toBeCloseTo(-0.401);
  });
  it('waits (keeping the snapshot position) when the ball is not in view', () => {
    const s = { targetId: 'b2' as string | null, targetMem: null as SelectionMemory | null, cueOverrideId: null as string | null, cueMem: null as SelectionMemory | null, vision: vision([ball('b7', 0.3 + 1.5 * R, 0.1)]) };
    unfreezeSelection(s, snapshot, R);
    expect(s.targetId).toBe('b2');
    expect(s.targetMem).toEqual({ id: 'b2', pos: { x: 0.3, y: 0.1 }, label: 'b2' });
  });
});

describe('clearSelection (the table frame changed: ids and positions no longer mean the same balls)', () => {
  it('clears the target, pocket, landing, plans, zones, suggestions and the marked cue ball', () => {
    const s = {
      targetId: 'b2',
      pocketId: 'TR' as const,
      landing: { x: 0, y: 0 },
      recommended: { key: 'k', stroke: null, pending: true, reachable: true, evaluated: 0 },
      heatmap: null,
      suggestions: { items: [], pending: true },
      cueOverrideId: 'b5',
      targetMem: { id: 'b2', pos: { x: 0, y: 0 } },
      cueMem: { id: 'b5', pos: { x: 1, y: 0 } },
      plan: null,
      interaction: 'position' as const,
    };
    expect(clearSelection(s)).toBe(true);
    expect(s).toMatchObject({ targetId: null, pocketId: null, landing: null, recommended: null, suggestions: null, cueOverrideId: null, targetMem: null, cueMem: null, interaction: 'select' });
    expect(clearSelection(s)).toBe(false);
  });
});

describe('dropLiveSelection: the live tracker’s ids stop naming the same balls (new table frame, new tracker)', () => {
  const live = (over: Partial<{ mode: 'camera' | 'practice' | 'snap'; frozen: { layout: TableLayout; calibration: null; gen?: number } | null }> = {}) => ({
    mode: 'camera' as 'camera' | 'practice' | 'snap',
    frozen: null as { layout: TableLayout; calibration: null; gen?: number } | null,
    targetId: 'b6' as string | null,
    pocketId: 'TR' as 'TR' | null,
    landing: null,
    recommended: null,
    heatmap: null,
    suggestions: null,
    cueOverrideId: 'b2' as string | null,
    targetMem: { id: 'b6', pos: { x: 0.3, y: 0.1 } } as SelectionMemory | null,
    cueMem: { id: 'b2', pos: { x: -0.4, y: 0 } } as SelectionMemory | null,
    plan: null,
    interaction: 'select' as const,
    ...over,
  });
  it('clears a live selection (target, pocket and the marked cue ball held by tracker id)', () => {
    const s = live();
    expect(dropLiveSelection(s)).toBe(true);
    expect(s).toMatchObject({ targetId: null, pocketId: null, cueOverrideId: null, targetMem: null, cueMem: null });
    expect(dropLiveSelection(s)).toBe(false);
  });
  it('keeps a frozen snapshot’s selection (the snapshot has its own ids) and other modes’ selections', () => {
    const frozen = live({ frozen: { layout: { table: makeTable('pool9'), balls: [], source: 'camera', frozen: true }, calibration: null, gen: 1 } });
    expect(dropLiveSelection(frozen)).toBe(false);
    expect(frozen).toMatchObject({ targetId: 'b6', cueOverrideId: 'b2', pocketId: 'TR' });
    for (const mode of ['practice', 'snap'] as const) {
      const s = live({ mode });
      expect(dropLiveSelection(s)).toBe(false);
      expect(s.targetId).toBe('b6');
    }
  });
});

describe('visionFailureMessage: why table detection is off', () => {
  it('a worker that never answered could not start (its script may not be cached for offline use)', () => {
    const m = visionFailureMessage(false);
    expect(m).toContain('Table detection couldn’t start');
    expect(m).toContain('offline');
    expect(m).toContain('Try again');
  });
  it('a worker that had answered stopped working: no claim about being offline', () => {
    const m = visionFailureMessage(true);
    expect(m).toContain('Table detection stopped working');
    expect(m).not.toContain('offline');
    expect(m).toContain('Try again');
    expect(m).toContain('practice table');
  });
  it('titles the message after what failed: table detection, not the camera', () => {
    expect(cameraMessageTitle(visionFailureMessage(false))).toBe('Table detection is off');
    expect(cameraMessageTitle(visionFailureMessage(true))).toBe('Table detection is off');
    expect(cameraMessageTitle('No camera was found on this device.')).toBe('Camera unavailable');
    expect(cameraMessageTitle(null)).toBe('Camera unavailable');
  });
});

describe('framesMatch: the frozen plan is drawn only through the same table frame', () => {
  const c: Vec2[] = [
    { x: 100, y: 100 },
    { x: 500, y: 110 },
    { x: 520, y: 400 },
    { x: 90, y: 390 },
  ];
  const diag = Math.hypot(640, 480);
  it('is true for the same corners within 3 % of the diagonal', () => {
    expect(framesMatch(c, c.map((p) => ({ x: p.x + 8, y: p.y - 8 })), diag)).toBe(true);
  });
  it('is false for the same corners in a rotated order (Rotate, or a 180° flip of the frame)', () => {
    expect(framesMatch(c, [c[1]!, c[2]!, c[3]!, c[0]!], diag)).toBe(false);
    expect(framesMatch(c, [c[2]!, c[3]!, c[0]!, c[1]!], diag)).toBe(false);
  });
  it('is false when either side is missing or moved', () => {
    expect(framesMatch(undefined, c, diag)).toBe(false);
    expect(framesMatch(c, c.map((p) => ({ x: p.x + 40, y: p.y })), diag)).toBe(false);
  });
});

describe('applyCueOverride', () => {
  const table = makeTable('pool9');
  const layout: TableLayout = { table, balls: [ball('c', 0, 0, 'cue', 'cue'), ball('b1', 0.3, 0, 'object', 'white'), ball('b2', 0.5, 0.2, 'object', '2')], source: 'camera', frozen: true };
  it('makes exactly that ball the cue ball and relabels the old one', () => {
    const out = applyCueOverride(layout, 'b1');
    expect(out.balls.filter((b) => b.kind === 'cue').map((b) => b.id)).toEqual(['b1']);
    expect(out.balls.find((b) => b.id === 'b1')!.label).toBe('cue');
    expect(out.balls.find((b) => b.id === 'c')!.label).toBe('white?');
    expect(out.balls.find((b) => b.id === 'b2')!.label).toBe('2');
    expect(layout.balls[0]!.kind).toBe('cue'); // input untouched
  });
  it('leaves the layout as it is when the id is not in it', () => {
    expect(applyCueOverride(layout, 'zz').balls.map((b) => b.kind)).toEqual(['cue', 'object', 'object']);
  });
});

describe('liveGate: the live plan is computed and drawn only on a locked table', () => {
  it('truth table', () => {
    expect(liveGate('unstable', Infinity, true)).toBe(false); // before the first lock
    expect(liveGate('searching', 0, true)).toBe(false);
    expect(liveGate('locked', 0, true)).toBe(true);
    expect(liveGate('unstable', 1, true)).toBe(true); // a single missed quad after a lock
    expect(liveGate('unstable', LOCK_GRACE, true)).toBe(true);
    expect(liveGate('unstable', LOCK_GRACE + 1, true)).toBe(false);
    expect(liveGate('locked', 0, false)).toBe(false); // no calibration: nothing to draw through
  });
  it('nextSinceLocked counts results since the last lock', () => {
    let n = Infinity;
    n = nextSinceLocked(n, 'unstable');
    expect(n).toBe(Infinity);
    n = nextSinceLocked(n, 'locked');
    expect(n).toBe(0);
    n = nextSinceLocked(nextSinceLocked(n, 'unstable'), 'unstable');
    expect(n).toBe(2);
  });
});

describe('status pill and hints', () => {
  it('the live-region text has no per-frame counters', () => {
    for (const st of ['searching', 'unstable', 'locked'] as const) {
      expect(pillText(st, false)).toBe(STATUS_TEXT[st]);
      expect(pillText(st, false)).not.toMatch(/\d/);
    }
    expect(pillText('locked', true)).toBe('Frozen layout');
    expect(pillText(null, false)).toBe('Starting camera…');
  });
  it('the counters go to the separate (aria-hidden) meta text', () => {
    expect(pillMeta({ balls: [1, 2, 3], ms: 41.6 }, false)).toBe('· 3 balls · 42 ms');
    expect(pillMeta({ balls: [], ms: 1 }, true)).toBe('');
    expect(pillMeta(null, false)).toBe('');
  });
  it('cameraHint asks for the cue ball when the layout has none, and to hold steady while unlocked', () => {
    const base = { error: false, status: 'locked' as const, live: true, frozen: false, balls: 3, hasCue: false, interaction: 'select' as const };
    expect(cameraHint(base)).toBe('No cue ball found — tap “Cue ball”, then tap the cue ball.');
    expect(cameraHint({ ...base, interaction: 'mark-cue' })).toBe('Tap the cue ball.');
    expect(cameraHint({ ...base, hasCue: true })).toBeNull();
    expect(cameraHint({ ...base, status: 'unstable', live: false })).toBe('Hold steady — the table isn’t locked yet.');
    expect(cameraHint({ ...base, status: 'searching', live: false })).toBe('Point the camera at the table so the whole cloth is in view.');
    expect(cameraHint({ ...base, status: null, live: false })).toBe('Point the camera at the table so the whole cloth is in view.');
    expect(cameraHint({ ...base, error: true })).toMatch(/camera is off/);
    expect(cameraHint({ ...base, status: 'searching', live: false, interaction: 'calibrate' })).toBe('Tap the 4 corners where the cloth meets the rails.');
    // Frozen: the snapshot is what counts, not the live lock.
    expect(cameraHint({ ...base, status: 'searching', live: false, frozen: true, hasCue: true })).toBeNull();
  });
  it('cameraHint: two whites too close to call (no ball is the cue) asks the player to tap the one they play with', () => {
    const base = { error: false, status: 'locked' as const, live: true, frozen: false, balls: 4, hasCue: false, interaction: 'select' as const };
    expect(cameraHint({ ...base, unsureWhites: 2 })).toBe('Two white balls — tap “Cue ball”, then tap the one you play with.');
    expect(cameraHint({ ...base, unsureWhites: 1 })).toBe('No cue ball found — tap “Cue ball”, then tap the cue ball.');
    expect(cameraHint({ ...base, unsureWhites: 2, interaction: 'mark-cue' })).toBe('Tap the cue ball.');
    expect(cameraHint({ ...base, unsureWhites: 2, hasCue: true })).toBeNull();
  });
  it('the pill says when the locked table has corner pockets out of view, without a number', () => {
    expect(pillText('locked', false, 1)).toBe('Table locked — a corner pocket is out of view');
    expect(pillText('locked', false, 2)).toBe('Table locked — corner pockets are out of view');
    expect(pillText('locked', false, 0)).toBe('Table locked');
    expect(pillText('unstable', false, 2)).toBe(STATUS_TEXT.unstable);
    expect(pillText('locked', true, 2)).toBe('Frozen layout');
    for (const n of [1, 2]) expect(pillText('locked', false, n)).not.toMatch(/\d/);
  });
});

describe('manual calibration feedback', () => {
  const cal = (source: 'manual' | 'auto') => ({ source });
  const cloth = { hue: 120, sat: 0.6, val: 0.5 };
  it('confirms only a locked manual calibration', () => {
    expect(calibrationFeedback({ status: 'locked', calibration: cal('manual'), cloth })).toEqual({ ok: true, retry: false, message: 'Calibrated from your four corners.' });
  });
  it('rejects corners that give no table', () => {
    const bad = { ok: false, retry: true, message: 'Those four taps aren’t the cloth corners — tap them again.' };
    expect(calibrationFeedback({ status: 'locked', calibration: null, cloth })).toEqual(bad);
    expect(calibrationFeedback({ status: 'searching', calibration: null, cloth })).toEqual(bad);
    expect(calibrationFeedback({ status: 'searching', calibration: null, cloth, reason: 'bad-quad' })).toEqual(bad);
  });
  it('says when the cloth colour could not be learned', () => {
    expect(calibrationFeedback({ status: 'locked', calibration: null, cloth: null })).toMatchObject({ ok: false, retry: true, message: expect.stringContaining('Couldn’t tell the cloth from its surroundings') });
    expect(calibrationFeedback({ status: 'searching', calibration: null, cloth, reason: 'cloth-unknown' })).toMatchObject({ message: expect.stringContaining('Couldn’t tell the cloth from its surroundings') });
  });
  it("the first check's 'moved' means the taps are off the cloth corners (nothing has moved yet), and it waits while the lock settles", () => {
    // The pipeline anchors manual corners on the first frame computed with them, so there 'moved'
    // can only mean "under 80 % of the tapped quad is cloth" (see the real-pipeline test below). The
    // phone-moved message is for later frames (main.ts checkManualCorners).
    expect(calibrationFeedback({ status: 'unstable', calibration: cal('manual'), cloth, reason: 'moved' })).toEqual({
      ok: false,
      retry: true,
      message: 'Those four taps aren’t the cloth corners — tap them again.',
    });
    expect(calibrationFeedback({ status: 'unstable', calibration: cal('manual'), cloth })).toBeNull();
    expect(CALIBRATION_MESSAGES.moved).toBe('The phone moved — recalibrate, or tap Calibrate to go back to automatic detection.');
  });
  it('cornersPlausible rejects collinear, clustered, tiny or self-crossing taps', () => {
    const W = 640;
    const Hh = 480;
    const ok = [
      { x: 100, y: 120 },
      { x: 540, y: 110 },
      { x: 600, y: 420 },
      { x: 40, y: 430 },
    ];
    expect(cornersPlausible(ok, W, Hh)).toBe(true);
    expect(cornersPlausible([ok[2]!, ok[0]!, ok[3]!, ok[1]!], W, Hh)).toBe(true); // any tap order
    expect(cornersPlausible([0, 1, 2, 3].map((i) => ({ x: 100 + 120 * i, y: 240 })), W, Hh)).toBe(false);
    expect(cornersPlausible([ok[0]!, { x: 102, y: 121 }, ok[2]!, ok[3]!], W, Hh)).toBe(false);
    expect(cornersPlausible(ok.map((p) => ({ x: 300 + p.x / 40, y: 200 + p.y / 40 })), W, Hh)).toBe(false);
    // A concave "dart": one tap inside the triangle of the others.
    expect(cornersPlausible([ok[0]!, ok[1]!, ok[2]!, { x: 330, y: 200 }], W, Hh)).toBe(false);
    expect(cornersPlausible(ok.slice(0, 3), W, Hh)).toBe(false);
  });
});

describe('Zones: the next ball', () => {
  it('is neither the cue ball nor the ball being potted', () => {
    expect(pickNextAllowed({ id: 'cue', kind: 'cue' }, 'b1')).toBe(false);
    expect(pickNextAllowed({ id: 'b1', kind: 'object' }, 'b1')).toBe(false);
    expect(pickNextAllowed({ id: 'b2', kind: 'object' }, 'b1')).toBe(true);
    expect(pickNextAllowed({ id: 'b2', kind: 'object' }, null)).toBe(true);
  });
});

describe('start mode: Practice when the device has no camera (spec 002 T166)', () => {
  it('honours ?mode= overrides', () => {
    expect(explicitMode('camera')).toBe('camera');
    expect(explicitMode('snap')).toBe('snap');
    expect(explicitMode('practice')).toBe('practice');
    expect(explicitMode('bogus')).toBeNull();
    expect(explicitMode(null)).toBeNull();
  });
  it('touch devices start in Live unless no camera is known to exist', () => {
    expect(startMode(true, true)).toBe('camera');
    expect(startMode(true, null)).toBe('camera'); // unknown: Live, with the 001 fallback if it fails
    expect(startMode(true, false)).toBe('practice');
    expect(startMode(false, true)).toBe('practice');
  });
  it('probeCamera reads enumerateDevices (no getUserMedia) and tolerates its absence or failure', async () => {
    const md = (kinds: string[]) => ({ enumerateDevices: () => Promise.resolve(kinds.map((kind) => ({ kind }) as MediaDeviceInfo)) });
    expect(await probeCamera(md(['audioinput', 'videoinput']))).toBe(true);
    expect(await probeCamera(md(['audioinput', 'audiooutput']))).toBe(false);
    expect(await probeCamera(md([]))).toBe(false);
    expect(await probeCamera(undefined)).toBeNull();
    expect(await probeCamera({} as never)).toBeNull();
    expect(await probeCamera({ enumerateDevices: () => Promise.reject(new Error('x')) })).toBeNull();
    expect(await probeCamera({ enumerateDevices: () => new Promise<MediaDeviceInfo[]>(() => {}) }, 20)).toBeNull();
  });
});

describe('bedPointFromProjection: the cloth point under a tap on the 3D table', () => {
  it('inverts any perspective projection of the bed plane', () => {
    // A tilted pinhole camera looking at the bed.
    const project = (p: Vec2) => {
      const X = p.x;
      const Y = p.y * Math.cos(0.7) - 0 * Math.sin(0.7);
      const Z = 3 + p.y * Math.sin(0.7);
      return { x: 200 + (500 * X) / Z, y: 300 + (500 * Y) / Z };
    };
    const truth = { x: 0.37, y: -0.21 };
    const q = bedPointFromProjection(project, { x: 1.27, y: 0.635 }, project(truth))!;
    expect(q.x).toBeCloseTo(truth.x, 6);
    expect(q.y).toBeCloseTo(truth.y, 6);
  });
  it('is null when the bed is not projectable', () => {
    expect(bedPointFromProjection(() => null, { x: 1, y: 0.5 }, { x: 0, y: 0 })).toBeNull();
  });
});

// --- Against the merged vision (src/vision/pipeline.ts), with the synthetic renderer ----------------
const T9 = makeTable('pool9');
const R9 = T9.ballRadius;
const synth = [
  { pos: { x: -0.7, y: -0.1 }, color: BALL_COLORS.cue! },
  { pos: { x: 0.3, y: 0.15 }, color: BALL_COLORS.yellow! },
  { pos: { x: -0.25, y: 0.4 }, color: BALL_COLORS.red! },
  { pos: { x: 0.95, y: -0.05 }, color: BALL_COLORS.blue! },
];
const CORNER: SynthCamera = { pos: { x: -2.25, y: -1.5, z: 1.8 }, target: { x: 0.15, y: 0.05, z: 0 }, fovDeg: 66 };
/** Further back with a wider lens: all four corners well inside a 640×360 frame. */
const WHOLE: SynthCamera = { pos: { x: -2.6, y: -1.75, z: 2.1 }, target: { x: 0.15, y: 0.05, z: 0 }, fovDeg: 70 };
const frameOf = (camera: SynthCamera) => renderSyntheticTable({ table: T9, balls: synth, camera, width: 640, height: 360 });
const live = (r: VisionResult): Ball[] => r.balls.map((b) => ({ id: b.id, kind: b.isCue ? 'cue' : 'object', pos: b.pos, label: b.isCue ? 'cue' : b.label }));
const until = (p: ReturnType<typeof createPipeline>, f: ReturnType<typeof frameOf>, ok: (r: VisionResult) => boolean, n = 12): VisionResult => {
  let r = p.process(f);
  for (let k = 0; k < n && !ok(r); k++) r = p.process(f);
  return r;
};
const lockedWith = (n: number) => (r: VisionResult) => r.status === 'locked' && r.balls.length >= n;

describe('the lock gate and the frozen-frame check against the merged vision (wave-1 items 15, 16)', () => {
  it('a frame without a table gives no calibration: the gate closes at once, even within the grace after a lock', () => {
    const p = createPipeline({ table: T9, fovDeg: 66 });
    let since = Infinity;
    const step = (f: ReturnType<typeof frameOf>) => {
      const r = p.process(f);
      since = nextSinceLocked(since, r.status);
      return { r, open: liveGate(r.status, since, !!r.calibration) };
    };
    const table = frameOf(CORNER);
    let s = step(table);
    for (let k = 0; k < 10 && s.r.status !== 'locked'; k++) s = step(table);
    expect(s.open).toBe(true);
    // The camera swings to the floor: no quad, so no calibration and no balls (nothing stale drawn).
    const floor = step(frameOf({ ...CORNER, target: { x: -3.5, y: -2.5, z: 0 } }));
    expect(floor.r.calibration).toBeNull();
    expect(floor.r.balls).toEqual([]);
    expect(floor.r.status).not.toBe('locked');
    expect(since).toBeLessThanOrEqual(LOCK_GRACE); // inside the grace …
    expect(floor.open).toBe(false); // … but without a calibration the gate stays shut
  });

  it("an 'unstable' frame right after a lock still has a calibration: open within the grace only", () => {
    const p = createPipeline({ table: T9, fovDeg: 66 });
    const r0 = until(p, frameOf(CORNER), (r) => r.status === 'locked');
    expect(r0.status).toBe('locked');
    // A small shift of the phone: a new quad, the tracker settles again.
    const moved = frameOf({ ...CORNER, pos: { x: -2.15, y: -1.42, z: 1.8 } });
    let since = 0;
    const seen: { status: string; cal: boolean; open: boolean }[] = [];
    for (let k = 0; k < 4; k++) {
      const r = p.process(moved);
      since = nextSinceLocked(since, r.status);
      seen.push({ status: r.status, cal: !!r.calibration, open: liveGate(r.status, since, !!r.calibration) });
    }
    const unstable = seen.filter((x) => x.status === 'unstable');
    expect(unstable.length).toBeGreaterThan(0);
    expect(unstable.every((x) => x.cal)).toBe(true); // the merged pipeline keeps the calibration there
    seen.forEach((x, i) => expect(x.open, JSON.stringify(seen)).toBe(x.status === 'locked' || i + 1 <= LOCK_GRACE));
  });

  it('Rotate (swapAxes) gives the same corners in another order: framesMatch refuses the frozen frame', () => {
    const p = createPipeline({ table: T9, fovDeg: 66 });
    const f = frameOf(CORNER);
    const before = until(p, f, (r) => r.status === 'locked');
    p.configure({ swapAxes: true });
    const after = until(p, f, (r) => r.status === 'locked');
    const diag = Math.hypot(640, 360);
    expect(after.calibration).not.toBeNull();
    // The same four image points …
    for (const c of before.calibration!.corners) expect(Math.min(...after.calibration!.corners.map((q) => Math.hypot(q.x - c.x, q.y - c.y)))).toBeLessThan(0.01 * diag);
    // … in another order: not the frozen frame.
    expect(framesMatch(before.calibration!.corners, after.calibration!.corners, diag)).toBe(false);
    p.configure({ swapAxes: false });
    const back = until(p, f, (r) => r.status === 'locked');
    expect(framesMatch(before.calibration!.corners, back.calibration!.corners, diag)).toBe(true);
  });

  it("manual corners tapped too wide: the first result already says 'moved' though the camera never moved", () => {
    const p = createPipeline({ table: T9, fovDeg: 66 });
    const f = frameOf(CORNER);
    const auto = until(p, f, (r) => r.status === 'locked');
    const c = auto.calibration!.corners;
    const cx = c.reduce((a, q) => a + q.x, 0) / 4;
    const cy = c.reduce((a, q) => a + q.y, 0) / 4;
    p.configure({ manualCorners: c.map((q) => ({ x: cx + (q.x - cx) * 1.2, y: cy + (q.y - cy) * 1.2 })) });
    const first = p.process(f); // the same frame: nothing moved
    expect(first.reason).toBe('moved');
    // So the first check says the taps are off, not that the phone moved.
    expect(calibrationFeedback({ status: first.status, calibration: first.calibration, cloth: first.cloth, reason: first.reason })).toEqual({ ok: false, retry: true, message: CALIBRATION_MESSAGES.badQuad });
  });
});

describe('corner pockets out of view (wave-1 item 20: the merged vision locks tables with corners just off-screen)', () => {
  it('a locked table with a corner past the frame edge reports it; the whole table reports none', () => {
    const p = createPipeline({ table: T9, fovDeg: 56 });
    // 640×360 from the corner camera at a narrower lens: the near corner falls below the frame.
    const f = renderSyntheticTable({ table: T9, balls: synth, camera: { ...CORNER, target: { x: 0.1, y: 0.05, z: 0 }, fovDeg: 56 }, width: 640, height: 360 });
    const r = until(p, f, (x) => x.status === 'locked');
    expect(r.status).toBe('locked');
    expect(cornersOutOfView(r.calibration!.corners, 640, 360)).toBe(1);
    const whole = until(createPipeline({ table: T9, fovDeg: 70 }), frameOf(WHOLE), (x) => x.status === 'locked');
    expect(whole.status).toBe('locked');
    expect(cornersOutOfView(whole.calibration!.corners, 640, 360)).toBe(0);
  });
  it('a corner on the border does not flicker the message: it changes only past a few px either way', () => {
    const quad = (x: number): Vec2[] => [
      { x, y: 100 },
      { x: 500, y: 100 },
      { x: 500, y: 300 },
      { x: 100, y: 300 },
    ];
    expect(cornersOutOfView(quad(-1), 640, 360)).toBe(1);
    expect(nextCornersOut(0, quad(-1), 640, 360)).toBe(0); // 1 px out: not yet
    expect(nextCornersOut(0, quad(-6), 640, 360)).toBe(1);
    expect(nextCornersOut(1, quad(1), 640, 360)).toBe(1); // 1 px back in: still out
    expect(nextCornersOut(1, quad(6), 640, 360)).toBe(0);
    expect(nextCornersOut(1, null, 640, 360)).toBe(0);
  });
});

describe('Rotate / Calibrate keep the selection: found again by where the camera sees it (wave-2a item 17)', () => {
  // Two table frames of the same camera image, the way Rotate makes them: the four outline corners
  // are the same image points, assigned to the table corners one place round (long ↔ short rails).
  const hx = T9.length / 2;
  const hy = T9.width / 2;
  const tableCorners: Vec2[] = [
    { x: -hx, y: -hy },
    { x: hx, y: -hy },
    { x: hx, y: hy },
    { x: -hx, y: hy },
  ];
  const Q: Vec2[] = [
    { x: 120, y: 300 },
    { x: 520, y: 300 },
    { x: 460, y: 120 },
    { x: 180, y: 120 },
  ];
  const Hold = homographyFrom4(tableCorners, Q);
  const Hnew = homographyFrom4(tableCorners, [Q[1]!, Q[2]!, Q[3]!, Q[0]!]);
  const toNew = (p: Vec2): Vec2 => {
    const q = applyH(Hold, p.x, p.y);
    return applyH(invert3(Hnew), q.x, q.y);
  };
  const cal = (H: number[]) => ({ H0: H, HR: H });
  const before: Ball[] = [ball('cue', -0.7, -0.1, 'cue', 'cue'), ball('b3', 0.3, 0.15, 'object', 'yellow'), ball('b4', 0.38, 0.15, 'object', 'red'), ball('b5', -0.25, 0.4, 'object', 'red')];
  // After Rotate: a new tracker (new ids) and new table coordinates for the same balls.
  const after: Ball[] = before.map((b, i) => ({ ...b, id: b.kind === 'cue' ? 'cue' : `b${9 + i}`, pos: toNew(b.pos) }));
  const px = (H: number[], p: Vec2) => applyH(H, p.x, p.y);

  it('the frame stand-ins agree (a check of the test itself): same image point, other table coordinates', () => {
    for (const [i, b] of before.entries()) {
      const a = px(Hold, b.pos);
      const c = px(Hnew, after[i]!.pos);
      expect(Math.hypot(a.x - c.x, a.y - c.y)).toBeLessThan(1e-6);
      if (b.kind !== 'cue') expect(Math.hypot(after[i]!.pos.x - b.pos.x, after[i]!.pos.y - b.pos.y)).toBeGreaterThan(0.05);
    }
  });

  it('remapThroughFrame: the ball at the same spot in the frame, its label preferred; none when nothing is there', () => {
    const yellow = { px: px(Hold, before[1]!.pos), label: 'yellow' };
    expect(remapThroughFrame(yellow, after, Hnew, R9)).toBe('b10');
    // Two candidates within the tolerance of a spot: the same label wins over a nearer other colour.
    const b3 = px(Hold, before[1]!.pos);
    const b4 = px(Hold, before[2]!.pos);
    const between = { px: { x: b3.x + 0.4 * (b4.x - b3.x), y: b3.y + 0.4 * (b4.y - b3.y) }, label: 'red' };
    expect(remapThroughFrame(between, after, Hnew, R9, { tolPx: 40 })).toBe('b11');
    expect(remapThroughFrame({ ...between, label: 'yellow' }, after, Hnew, R9, { tolPx: 40 })).toBe('b10');
    // Nothing near: null; an excluded or a cue ball only when allowed.
    expect(remapThroughFrame({ px: { x: 5, y: 5 } }, after, Hnew, R9)).toBeNull();
    expect(remapThroughFrame(yellow, after, Hnew, R9, { exclude: ['b10'] })).toBeNull(); // the red one is out of range
    const cue = { px: px(Hold, before[0]!.pos) };
    expect(remapThroughFrame(cue, after, Hnew, R9)).toBeNull();
    expect(remapThroughFrame(cue, after, Hnew, R9, { allowCue: true })).toBe('cue');
  });

  it('pockets and the landing spot go through the cloth plane; a pocket with none at its spot is dropped', () => {
    const tr = T9.pockets.find((p) => p.id === 'TR')!;
    const at = px(Hold, tr.mouthCenter);
    const now = pocketThroughFrame(at, T9.pockets, Hnew)!;
    const pk = T9.pockets.find((p) => p.id === now)!;
    expect(pk.kind).toBe('corner'); // the same physical corner pocket, under its name in the new frame
    const q = px(Hnew, pk.mouthCenter);
    expect(Math.hypot(q.x - at.x, q.y - at.y)).toBeLessThan(40);
    // A side pocket of the old frame sits mid-way along what is now a short rail: no pocket there.
    expect(pocketThroughFrame(px(Hold, T9.pockets.find((p) => p.id === 'TM')!.mouthCenter), T9.pockets, Hnew)).toBeNull();
    const land = landingThroughFrame(px(Hold, { x: 0.5, y: -0.2 }), Hnew)!;
    const want = toNew({ x: 0.5, y: -0.2 });
    expect(land.x).toBeCloseTo(want.x, 9);
    expect(land.y).toBeCloseTo(want.y, 9);
  });

  it('rememberInFrame → restoreFromFrame keeps target, marked cue ball, pocket and landing', () => {
    const sel = { targetId: 'b3', targetMem: null, cueOverrideId: 'b5', cueMem: null, pocketId: 'TR' as const, landing: { x: 0.5, y: -0.2 } };
    const mem = rememberInFrame(sel, before, T9, cal(Hold))!;
    expect(mem).not.toBeNull();
    const r = restoreFromFrame(mem, after, T9, cal(Hnew));
    expect(r.found).toBe(true);
    expect(r.targetId).toBe('b10');
    expect(r.cueOverrideId).toBe('b12');
    expect(r.pocketId).toBe(pocketThroughFrame(px(Hold, T9.pockets.find((p) => p.id === 'TR')!.mouthCenter), T9.pockets, Hnew));
    expect(r.landing!.x).toBeCloseTo(toNew(sel.landing).x, 9);
    // A ball that is not in view yet: not found, keep waiting (the target is what matters).
    expect(restoreFromFrame(mem, after.filter((b) => b.id !== 'b10'), T9, cal(Hnew)).found).toBe(false);
    // Nothing selected: nothing to remember.
    expect(rememberInFrame({ targetId: null, targetMem: null, cueOverrideId: null, cueMem: null, pocketId: null, landing: null }, before, T9, cal(Hold))).toBeNull();
    // A target occluded at the moment of Rotate is remembered where it was last seen.
    const occluded = rememberInFrame({ ...sel, targetId: 'gone', targetMem: { id: 'gone', pos: { x: 0.3, y: 0.15 }, label: 'yellow' } }, before, T9, cal(Hold))!;
    expect(restoreFromFrame(occluded, after, T9, cal(Hnew)).targetId).toBe('b10');
    expect(REMAP_TTL).toBe(15);
    expect(REMAP_MESSAGES.kept).toBe('Kept your selection.');
  });

  it('through a real Calibrate of the merged pipeline (four tapped corners: a new tracker, new ids): the same ball and pocket', () => {
    const p = createPipeline({ table: T9, fovDeg: 70 });
    const f = renderSyntheticTable({ table: T9, balls: synth, camera: WHOLE, width: 640, height: 360 });
    const r0 = until(p, f, lockedWith(4));
    const b0 = live(r0);
    const yellow = b0.reduce((a, b) => (Math.hypot(b.pos.x - 0.3, b.pos.y - 0.15) < Math.hypot(a.pos.x - 0.3, a.pos.y - 0.15) ? b : a));
    expect(Math.hypot(yellow.pos.x - 0.3, yellow.pos.y - 0.15)).toBeLessThan(0.03);
    const mem = rememberInFrame({ targetId: yellow.id, targetMem: null, cueOverrideId: null, cueMem: null, pocketId: 'TR', landing: null }, b0, T9, r0.calibration!)!;
    // The player taps the four cloth corners (1–2 px off, in another order).
    const c = r0.calibration!.corners;
    p.configure({ manualCorners: [c[2]!, c[3]!, c[0]!, c[1]!].map((q, i) => ({ x: q.x + (i % 2 ? 1.5 : -1), y: q.y + (i < 2 ? 1 : -1.5) })) });
    const r1 = until(p, f, lockedWith(4));
    expect(r1.calibration?.source).toBe('manual');
    const b1 = live(r1);
    expect(b1.some((b) => b.id === yellow.id)).toBe(false); // the tracker restarted: other ids
    const back = restoreFromFrame(mem, b1, T9, r1.calibration!);
    expect(back.found).toBe(true);
    const now = b1.find((b) => b.id === back.targetId)!;
    expect(now.label).toBe(yellow.label);
    expect(Math.hypot(now.pos.x - yellow.pos.x, now.pos.y - yellow.pos.y)).toBeLessThan(0.03);
    expect(back.pocketId).toBe('TR');
  });

  it('a real Rotate of a correctly detected table finds no balls at those spots: the selection is not moved to another ball', () => {
    const p = createPipeline({ table: T9, fovDeg: 70 });
    const f = renderSyntheticTable({ table: T9, balls: synth, camera: WHOLE, width: 640, height: 360 });
    const r0 = until(p, f, lockedWith(4));
    const b0 = live(r0);
    const target = b0.find((b) => b.kind !== 'cue')!;
    const mem = rememberInFrame({ targetId: target.id, targetMem: null, cueOverrideId: null, cueMem: null, pocketId: null, landing: null }, b0, T9, r0.calibration!)!;
    p.configure({ swapAxes: true });
    const r1 = until(p, f, (r) => r.status === 'locked');
    const back = restoreFromFrame(mem, live(r1), T9, r1.calibration!);
    // Whatever the wrong frame detects, nothing is taken unless it is at the same spot.
    if (back.targetId) {
      const q = live(r1).find((b) => b.id === back.targetId)!;
      const a = applyH(r0.calibration!.HR, target.pos.x, target.pos.y);
      const c2 = applyH(r1.calibration!.HR, q.pos.x, q.pos.y);
      expect(Math.hypot(a.x - c2.x, a.y - c2.y)).toBeLessThan(12);
    }
    // Rotating back finds it again (main.ts keeps the selection waiting across both changes).
    p.configure({ swapAxes: false });
    const r2 = until(p, f, lockedWith(4));
    const again = restoreFromFrame(mem, live(r2), T9, r2.calibration!);
    expect(again.found).toBe(true);
    expect(live(r2).find((b) => b.id === again.targetId)!.label).toBe(target.label);
  });
});
