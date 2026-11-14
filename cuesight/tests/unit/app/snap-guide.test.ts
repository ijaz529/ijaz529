/**
 * Snap step 2 geometry (feature 002 US2, FR-117…FR-121): the guide drawn on the player's photo, from the
 * ground-truth camera pose of the committed synthetic fixture (tests/fixtures/snap-layout.json), and the
 * Snap session state machine (data-model.md § SnapSession).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { planShot } from '../../../src/core/shot/planner';
import { makeTable } from '../../../src/core/table';
import type { Ball, TablePresetId, TableLayout, Vec2 } from '../../../src/core/types';
import { DEFAULT_SETTINGS, physicsFor } from '../../../src/app/settings';
import { buildPlayerGuide, cameraCenter, confidenceLabel, occluded, projectPolyline, scaleFocal, strikeHeadline } from '../../../src/app/snap/guide';
import { initialSnap, snapReducer, snapStage, SNAP_MESSAGES, type SnapEvent, type SnapSession } from '../../../src/app/snap/session';
import { describeSpin } from '../../../src/core/shot/power';
import type { CameraPose, PlayerViewResult } from '../../../src/vision/player-view';
import type { VisionResult } from '../../../src/vision/pipeline';

interface Fixture {
  table: TablePresetId;
  balls: { id: string; label: string; pos: Vec2; isCue: boolean }[];
  photos: Record<string, { width: number; height: number; targetId?: string; pocketId?: string; pose: CameraPose; ballsInView: { id: string; center: Vec2; radiusPx: number }[] }>;
}
const fx = JSON.parse(readFileSync('tests/fixtures/snap-layout.json', 'utf8')) as Fixture;
const table = makeTable(fx.table);
const R = table.ballRadius;
const balls: Ball[] = fx.balls.map((b) => ({ id: b.id, kind: b.isCue ? 'cue' : 'object', pos: b.pos, label: b.label }));
const layout: TableLayout = { table, balls, source: 'camera', frozen: true };
const params = physicsFor(DEFAULT_SETTINGS);
const ph = fx.photos.player!;
const pose = ph.pose;
const cue = balls.find((b) => b.kind === 'cue')!;
const target = balls.find((b) => b.id === ph.targetId)!;

function plan(side = 0, vert = 0, power = 4) {
  return planShot(layout, { targetId: target.id, pocketId: 'TR', stroke: { power, side, vert } }, params);
}
function guide(side = 0, vert = 0) {
  const p = plan(side, vert);
  return buildPlayerGuide({ pose, table, plan: p, cue: cue.pos, target: target.pos, stroke: p.stroke });
}
function inside(poly: Vec2[], q: Vec2): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > q.y !== b.y > q.y && q.x < ((b.x - a.x) * (q.y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}
const centroid = (pts: Vec2[]) => ({ x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length });

describe('player guide geometry on the fixture pose', () => {
  it('puts the cue ball and the target ball where the photo shows them', () => {
    const g = guide();
    const truthCue = ph.ballsInView.find((b) => b.id === 'cue')!;
    const truthTarget = ph.ballsInView.find((b) => b.id === target.id)!;
    const cc = centroid(g.cueBall);
    expect(Math.hypot(cc.x - truthCue.center.x, cc.y - truthCue.center.y)).toBeLessThan(2);
    expect(Math.abs(g.cueRadiusPx - truthCue.radiusPx) / truthCue.radiusPx).toBeLessThan(0.04);
    const tc = centroid(g.target);
    expect(Math.hypot(tc.x - truthTarget.center.x, tc.y - truthTarget.center.y)).toBeLessThan(2);
    expect(g.inFrame).toEqual({ cue: true, ghost: true, target: true, pocket: true });
    expect(g.messages).toEqual([]);
  });

  it('draws the aim line on the cloth from the cue ball to the ghost ball, hidden where the cue ball covers it', () => {
    const g = guide();
    expect(g.aim.length).toBeGreaterThan(0);
    const first = g.aim[0]![0]!;
    const last = g.aim[g.aim.length - 1]!.at(-1)!;
    // It emerges at the cue ball's silhouette (not drawn across the ball's face)…
    expect(inside(g.cueBall, { x: first.x, y: first.y + 1 })).toBe(false);
    expect(Math.hypot(first.x - g.cueCenter!.x, first.y - g.cueCenter!.y)).toBeLessThan(g.cueRadiusPx * 1.3);
    // …and ends under the ghost ball.
    expect(inside(g.ghost, last) || Math.hypot(last.x - g.ghostCenter!.x, last.y - g.ghostCenter!.y) < 2 * g.cueRadiusPx).toBe(true);
    // The object-ball path runs toward the pocket ring.
    expect(g.objectPath.length).toBeGreaterThan(0);
    expect(g.pocket.length).toBeGreaterThan(0);
  });

  it('puts the strike dot on the visible face of the cue ball and moves it with the tip offset', () => {
    const centre = guide(0, 0);
    expect(centre.strike?.visible).toBe(true);
    expect(centre.strike?.inFrame).toBe(true);
    expect(inside(centre.cueBall, centre.strike!.p)).toBe(true);
    // A 13 mm tip is about a quarter of the ball's radius on the photo.
    expect(centre.strike!.r / centre.cueRadiusPx).toBeGreaterThan(0.15);
    expect(centre.strike!.r / centre.cueRadiusPx).toBeLessThan(0.35);
    const high = guide(0, 0.3).strike!.p;
    const low = guide(0, -0.3).strike!.p;
    const right = guide(0.3, 0).strike!.p;
    const left = guide(-0.3, 0).strike!.p;
    expect(high.y).toBeLessThan(centre.strike!.p.y - 3); // top spin: higher on the photo
    expect(low.y).toBeGreaterThan(centre.strike!.p.y + 3);
    expect(right.x).toBeGreaterThan(centre.strike!.p.x + 3); // shooter's right = photo right from behind
    expect(left.x).toBeLessThan(centre.strike!.p.x - 3);
    // Miscue ring and centre cross are drawn on the face.
    expect(centre.miscue.length).toBeGreaterThan(0);
    expect(centre.cross.length).toBeGreaterThan(0);
  });

  it('says what is missing when the cue ball is outside the photo (FR-119)', () => {
    // Turn the camera 60° to the left about its vertical axis: the cue ball leaves the frame.
    const a = (60 * Math.PI) / 180;
    const Ry = [Math.cos(a), 0, Math.sin(a), 0, 1, 0, -Math.sin(a), 0, Math.cos(a)];
    const mul = (A: number[], B: number[]) => [0, 1, 2].flatMap((r) => [0, 1, 2].map((c) => A[r * 3]! * B[c]! + A[r * 3 + 1]! * B[3 + c]! + A[r * 3 + 2]! * B[6 + c]!));
    const C = cameraCenter(pose);
    const R2 = mul(Ry, pose.R);
    const t = { x: -(R2[0]! * C.x + R2[1]! * C.y + R2[2]! * C.z), y: -(R2[3]! * C.x + R2[4]! * C.y + R2[5]! * C.z), z: -(R2[6]! * C.x + R2[7]! * C.y + R2[8]! * C.z) };
    const p = plan();
    const g = buildPlayerGuide({ pose: { ...pose, R: R2, t }, table, plan: p, cue: cue.pos, target: target.pos, stroke: p.stroke });
    expect(g.inFrame.cue).toBe(false);
    expect(g.messages.join(' ')).toMatch(/cue ball is outside the photo/);
  });

  it('clips lines at the camera instead of mirroring what is behind it', () => {
    const C = cameraCenter(pose);
    // A line on the cloth from far in front of the camera to well behind it.
    const fwd = { x: pose.R[6]!, y: pose.R[7]! };
    const runs = projectPolyline(pose, [
      { x: C.x + fwd.x * 2, y: C.y + fwd.y * 2, z: 0 },
      { x: C.x - fwd.x * 2, y: C.y - fwd.y * 2, z: 0 },
    ]);
    expect(runs.length).toBe(1);
    const run = runs[0]!;
    for (const p of run) expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
    // Walking toward the camera, cloth points only move down the photo (no wrap-around from behind).
    for (let i = 1; i < run.length; i++) expect(run[i]!.y).toBeGreaterThan(run[i - 1]!.y);
    expect(run.at(-1)!.y).toBeGreaterThan(pose.height);
  });

  it('occlusion: cloth behind a ball is hidden, cloth in front of it is not', () => {
    const C = { x: 0, y: -1, z: 0.3 };
    const ball = { x: 0, y: 0, z: R };
    expect(occluded(C, { x: 0, y: 0.05, z: 0 }, [ball], R)).toBe(true);
    expect(occluded(C, { x: 0, y: -0.1, z: 0 }, [ball], R)).toBe(false);
    expect(occluded(C, { x: 0.2, y: 0.05, z: 0 }, [ball], R)).toBe(false);
  });
});

describe('guide wording and helpers', () => {
  it('confidence chip: good / fair / low with a percentage', () => {
    expect(confidenceLabel(0.99)).toMatchObject({ word: 'good', pct: 99, text: 'Fit: good · 99%' });
    expect(confidenceLabel(0.7).word).toBe('fair');
    expect(confidenceLabel(0.3).word).toBe('low');
  });
  it('focal length follows the long side of the photo', () => {
    expect(scaleFocal(985, { width: 1280, height: 720 }, { width: 960, height: 720 })).toBeCloseTo(738.75, 2);
    expect(scaleFocal(985, { width: 1280, height: 720 }, { width: 720, height: 960 })).toBeCloseTo(738.75, 2);
  });
  it('strike headline speaks like a coach', () => {
    expect(strikeHeadline({ side: 0, vert: 0 }, describeSpin)).toBe('Strike dead centre');
    expect(strikeHeadline({ side: 0, vert: -0.125 }, describeSpin)).toBe('Strike ½ tip low');
  });
});

describe('Snap session state machine', () => {
  const vision = (withTable: boolean, n = 3): VisionResult =>
    ({ status: withTable ? 'locked' : 'searching', calibration: withTable ? ({ focal: 900, focalSource: 'estimated' } as unknown as VisionResult['calibration']) : null, balls: new Array(n).fill(null), quality: 0.9, cloth: null, ms: 10 }) as VisionResult;
  const run = (events: SnapEvent[], s: SnapSession = initialSnap()) => events.reduce(snapReducer, s);
  const photo = { width: 960, height: 540, source: 'library' as const };
  const pv = (ok: boolean): PlayerViewResult => ({ ok, pose: null, confidence: ok ? 0.95 : 0.1, residualPx: 1, matched: [], ...(ok ? {} : { reason: 'nope' }), ms: 5 });

  it('table photo → review → player photo → guide', () => {
    let s = run([{ type: 'overview-photo', photo }]);
    expect(s.step).toBe('overview-processing');
    expect(snapStage(s.step)).toBe(1);
    s = snapReducer(s, { type: 'overview-result', vision: vision(true), balls });
    expect(s.step).toBe('review');
    expect(s.layout).toBe(balls);
    s = snapReducer(s, { type: 'player-photo', photo });
    expect(s.step).toBe('player-processing');
    expect(snapStage(s.step)).toBe(2);
    s = snapReducer(s, { type: 'player-result', result: pv(true) });
    expect(s.step).toBe('guide');
    expect(s.error).toBeNull();
    // Edit the layout and come back to the same photo.
    s = snapReducer(s, { type: 'edit-layout' });
    expect(s.step).toBe('review');
    expect(s.player?.result?.ok).toBe(true);
    s = snapReducer(s, { type: 'back-to-guide' });
    expect(s.step).toBe('guide');
  });

  it('no table → error → four corner taps → processing again', () => {
    let s = run([{ type: 'overview-photo', photo }, { type: 'overview-result', vision: vision(false, 0), balls: [] }]);
    expect(s.step).toBe('overview-error');
    expect(s.error).toBe(SNAP_MESSAGES.noTable);
    s = snapReducer(s, { type: 'start-corners' });
    for (let i = 0; i < 3; i++) s = snapReducer(s, { type: 'corner-tap', p: { x: i, y: i } });
    expect(s.step).toBe('corners');
    expect(s.cornerTaps).toHaveLength(3);
    s = snapReducer(s, { type: 'corner-tap', p: { x: 9, y: 9 } });
    expect(s.step).toBe('overview-processing');
    expect(s.corners).toHaveLength(4);
    expect(s.cornerTaps).toHaveLength(0);
  });

  it('failed fit → manual taps (cue, then target) → processing with both taps', () => {
    let s = run([{ type: 'overview-photo', photo }, { type: 'overview-result', vision: vision(true), balls }, { type: 'player-photo', photo }, { type: 'player-result', result: pv(false) }]);
    expect(s.step).toBe('manual-taps');
    expect(s.error).toBe('nope');
    s = snapReducer(s, { type: 'manual-tap', p: { x: 1, y: 2 } });
    expect(s.step).toBe('manual-taps');
    expect(s.taps.cue).toEqual({ x: 1, y: 2 });
    s = snapReducer(s, { type: 'manual-tap', p: { x: 3, y: 4 } });
    expect(s.step).toBe('player-processing');
    expect(s.taps).toEqual({ cue: { x: 1, y: 2 }, target: { x: 3, y: 4 } });
  });

  it('a player photo needs a layout; reset drops everything (FR-122)', () => {
    expect(snapReducer(initialSnap(), { type: 'player-photo', photo }).step).toBe('intro');
    const s = run([{ type: 'overview-photo', photo }, { type: 'overview-result', vision: vision(true), balls }, { type: 'reset' }]);
    expect(s).toEqual(initialSnap());
  });

  it('a table with no balls still opens the layout step, with a hint', () => {
    const s = run([{ type: 'overview-photo', photo }, { type: 'overview-result', vision: vision(true, 0), balls: [] }]);
    expect(s.step).toBe('review');
    expect(s.error).toBe(SNAP_MESSAGES.noBalls);
  });
});
