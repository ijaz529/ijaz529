import { describe, expect, it } from 'vitest';
import type { Ball, TableLayout, Vec2 } from '../../../src/core/types';
import type { SelectionMemory } from '../../../src/app/store';
import { makeTable } from '../../../src/core/table';
import { DEFAULT_SETTINGS } from '../../../src/app/settings';
import {
  LOCK_GRACE,
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
});

describe('manual calibration feedback', () => {
  const cal = (source: 'manual' | 'auto') => ({ source });
  const cloth = { hue: 120, sat: 0.6, val: 0.5 };
  it('confirms only a locked manual calibration', () => {
    expect(calibrationFeedback({ status: 'locked', calibration: cal('manual'), cloth })).toEqual({ ok: true, retry: false, message: 'Calibrated from your four corners.' });
  });
  it('rejects corners that give no table', () => {
    const bad = { ok: false, retry: true, message: 'Those corners don’t make a table — tap the 4 cloth corners again.' };
    expect(calibrationFeedback({ status: 'locked', calibration: null, cloth })).toEqual(bad);
    expect(calibrationFeedback({ status: 'searching', calibration: null, cloth })).toEqual(bad);
    expect(calibrationFeedback({ status: 'searching', calibration: null, cloth, reason: 'bad-quad' })).toEqual(bad);
  });
  it('says when the cloth colour could not be learned', () => {
    expect(calibrationFeedback({ status: 'locked', calibration: null, cloth: null })).toMatchObject({ ok: false, retry: true, message: expect.stringContaining('cloth colour') });
    expect(calibrationFeedback({ status: 'searching', calibration: null, cloth, reason: 'cloth-unknown' })).toMatchObject({ message: expect.stringContaining('cloth colour') });
  });
  it('says when the phone moved, and waits while the lock is still settling', () => {
    expect(calibrationFeedback({ status: 'unstable', calibration: cal('manual'), cloth, reason: 'moved' })).toEqual({
      ok: false,
      retry: false,
      message: 'The phone moved — tap Calibrate again or return to automatic detection.',
    });
    expect(calibrationFeedback({ status: 'unstable', calibration: cal('manual'), cloth })).toBeNull();
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
