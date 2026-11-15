import { describe, expect, it } from 'vitest';
import { DRILLS } from '../../../src/app/drills';
import { DEFAULT_PHYSICS } from '../../../src/core/physics/params';
import { planShot } from '../../../src/core/shot/planner';
import { makeTable } from '../../../src/core/table';
import type { SimEvent, Trajectory } from '../../../src/core/types';
import { quatRotate, type Quat, type V3 } from '../../../src/app/render3d/math3d';
import { POCKET_DROP_S, assignTimes, buildTrack, playbackTimeline, rollBall, rollingQuat, sampleTrack, type BallPose } from '../../../src/app/render3d/playback';

const R = 0.028575;
const pose = (): BallPose => ({ x: 0, y: 0, z: 0, q: [0, 0, 0, 1], visible: true });
const sameRotation = (a: Quat, b: Quat, eps = 1e-6) => {
  // q and −q are the same rotation.
  const d = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
  expect(1 - d).toBeLessThan(eps);
};

describe('render3d rolling rotation', () => {
  it('rolls without slipping: the contact point does not move', () => {
    const d = 1e-4;
    const dir = { x: 0.6, y: -0.8 };
    const q = rollingQuat(dir.x * d, dir.y * d, R);
    const bottom: V3 = [0, 0, -R];
    const moved = quatRotate(q, bottom);
    // Contact point displacement from rotation must cancel the translation.
    expect(moved[0] - bottom[0] + dir.x * d).toBeCloseTo(0, 9);
    expect(moved[1] - bottom[1] + dir.y * d).toBeCloseTo(0, 9);
    // The top of the ball moves forward at twice the centre speed.
    const top = quatRotate(q, [0, 0, R]);
    expect(top[0] / (dir.x * d)).toBeCloseTo(1, 3);
  });

  it('one circumference of travel is one full turn', () => {
    let q: Quat = [0, 0, 0, 1];
    const steps = 400;
    const L = 2 * Math.PI * R;
    for (let i = 0; i < steps; i++) q = rollBall(q, L / steps, 0, R);
    sameRotation(q, [0, 0, 0, 1], 1e-9);
    // Half a circumference flips the ball: the top point ends at the bottom.
    let h: Quat = [0, 0, 0, 1];
    for (let i = 0; i < steps; i++) h = rollBall(h, 0, L / 2 / steps, R);
    expect(quatRotate(h, [0, 0, 1])[2]).toBeCloseTo(-1, 9);
  });
});

describe('render3d trajectory timing', () => {
  const ev = (t: number, kind: SimEvent['kind'], x: number, y: number): SimEvent => ({ t, kind, ballId: 'b', pos: { x, y } });

  it('pins event points to their simulator times and decelerates in between', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 0.1, y: 0 },
      { x: 0.2, y: 0 },
      { x: 0.3, y: 0 },
      { x: 0.4, y: 0 },
      { x: 0.5, y: 0 },
    ];
    const t = assignTimes(pts, [ev(0.4, 'cushion', 0.3, 0), ev(2.0, 'stop', 0.5, 0)]);
    expect(t[0]).toBe(0);
    expect(t[3]).toBeCloseTo(0.4, 12);
    expect(t[5]).toBeCloseTo(2.0, 12);
    for (let i = 1; i < t.length; i++) expect(t[i]!).toBeGreaterThanOrEqual(t[i - 1]!);
    // Final span ends at rest: the second 10 cm takes longer than the first.
    expect(t[5]! - t[4]!).toBeGreaterThan(t[4]! - t[3]!);
  });

  it('falls back to an ease-out over distance without events', () => {
    const pts = Array.from({ length: 11 }, (_, i) => ({ x: i * 0.05, y: 0 }));
    const t = assignTimes(pts, []);
    expect(t[0]).toBe(0);
    expect(t[10]!).toBeGreaterThan(0);
    const first = t[1]! - t[0]!;
    const last = t[10]! - t[9]!;
    expect(last).toBeGreaterThan(first * 2);
  });

  it('samples positions and rotation consistently along a track', () => {
    const tr: Trajectory = {
      ballId: 'b',
      points: [
        { x: 0, y: 0 },
        { x: 0.2, y: 0 },
        { x: 0.2, y: 0.2 },
      ],
      events: [ev(0.5, 'cushion', 0.2, 0), ev(1.5, 'stop', 0.2, 0.2)],
      rest: { x: 0.2, y: 0.2 },
      pocket: null,
    };
    const track = buildTrack(tr, R);
    const p = sampleTrack(track, 0.5, R, pose());
    expect(p.x).toBeCloseTo(0.2, 9);
    expect(p.y).toBeCloseTo(0, 9);
    const end = sampleTrack(track, 99, R, pose());
    expect(end.x).toBeCloseTo(0.2, 9);
    expect(end.y).toBeCloseTo(0.2, 9);
    expect(end.z).toBeCloseTo(R, 9);
    // Orientation equals rolling 0.2 m along +x then 0.2 m along +y.
    const expected = rollBall(rollBall([0, 0, 0, 1], 0.2, 0, R), 0, 0.2, R);
    sameRotation(end.q, expected, 1e-9);
  });

  it('drops a pocketed ball into its pocket', () => {
    const tr: Trajectory = {
      ballId: 'b',
      points: [
        { x: 1.0, y: 0.5 },
        { x: 1.26, y: 0.62 },
      ],
      events: [ev(0.3, 'pocket', 1.26, 0.62)],
      rest: null,
      pocket: 'TR',
    };
    const track = buildTrack(tr, R, { holes: { TR: { x: 1.29, y: 0.65 } }, pocketDepth: 0.09 });
    expect(track.pocket).not.toBeNull();
    const fin = sampleTrack(track, track.end + POCKET_DROP_S, R, pose());
    expect(fin.x).toBeCloseTo(1.29, 9);
    expect(fin.y).toBeCloseTo(0.65, 9);
    expect(fin.z).toBeLessThan(0);
  });

  it('pins an event to its point even when the stored position differs by float noise (no exact-equality match)', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 0.1, y: 0 },
      { x: 0.2, y: 0 },
      { x: 0.3, y: 0 },
    ];
    // The event position went through arithmetic of its own: 0.4 µm off the recorded point.
    const t = assignTimes(pts, [ev(0.4, 'cushion', 0.2 + 4e-7, -3e-7), ev(1.2, 'stop', 0.3, 0)]);
    expect(t[2]).toBeCloseTo(0.4, 12);
    expect(t[3]).toBeCloseTo(1.2, 12);
  });

  it('SC-103: a recorded trajectory replays every recorded point (and so every event) at its simulated time, within 1 mm', () => {
    const table = makeTable('pool9');
    const balls = DRILLS[0]!.build(table);
    for (const stroke of [
      { power: 4, side: 0, vert: 0 },
      { power: 6, side: 0.2, vert: -0.4 },
      { power: 3, side: -0.25, vert: 0.4 },
    ]) {
      const plan = planShot({ table, balls, source: 'virtual', frozen: false }, { targetId: 'b1', pocketId: 'TR', stroke }, DEFAULT_PHYSICS);
      const R9 = table.ballRadius;
      for (const tr of [plan.cuePath, plan.objectPath, ...plan.otherPaths]) {
        expect(tr.times?.length, `${tr.ballId} recorded times`).toBe(tr.points.length);
        const track = buildTrack(tr, R9);
        let worst = 0;
        tr.points.forEach((p, i) => {
          const at = sampleTrack(track, tr.times![i]!, R9, pose());
          // A ball resting at its start until struck holds still; compare where it is at that time.
          worst = Math.max(worst, Math.hypot(at.x - p.x, at.y - p.y));
        });
        expect(worst, `${tr.ballId} ${JSON.stringify(stroke)}`).toBeLessThan(1e-3);
        for (const e of tr.events) {
          if (e.kind === 'pocket') continue;
          const at = sampleTrack(track, e.t, R9, pose());
          expect(Math.hypot(at.x - e.pos.x, at.y - e.pos.y), `${tr.ballId} ${e.kind} @ ${e.t}`).toBeLessThan(1e-3);
        }
      }
    }
  });

  it('FR-108: a draw shot slides with backspin before it rolls (not pure rolling from the strike)', () => {
    const table = makeTable('pool9');
    const balls = DRILLS[0]!.build(table);
    const plan = planShot({ table, balls, source: 'virtual', frozen: false }, { targetId: 'b1', pocketId: 'TR', stroke: { power: 6, side: 0, vert: -0.5 } }, DEFAULT_PHYSICS);
    const R9 = table.ballRadius;
    const track = buildTrack(plan.cuePath, R9);
    expect(track.span, 'the recorded spin is used').not.toBeNull();
    // Shortly after the strike the cue ball is sliding with backspin: its top turns backward
    // (against the travel), whereas a rolling ball's top moves forward. (4 ms: well under a turn.)
    const t1 = 0.004;
    const a = sampleTrack(track, 0, R9, pose());
    const b = sampleTrack(track, t1, R9, pose());
    const travel = { x: b.x - a.x, y: b.y - a.y };
    expect(Math.hypot(travel.x, travel.y)).toBeGreaterThan(0.005);
    const top0 = quatRotate(a.q, [0, 0, R9]);
    const top1 = quatRotate(b.q, [0, 0, R9]);
    const topMove = (top1[0] - top0[0]) * travel.x + (top1[1] - top0[1]) * travel.y;
    expect(topMove, 'top of the ball moves against the travel (backspin)').toBeLessThan(0);
  });

  it('replays a real plan: the object ball starts at the cue ball contact time', () => {
    const table = makeTable('pool9');
    const balls = DRILLS[0]!.build(table);
    const plan = planShot({ table, balls, source: 'virtual', frozen: false }, { targetId: 'b1', pocketId: 'TR' }, DEFAULT_PHYSICS);
    const R9 = table.ballRadius;
    const cue = buildTrack(plan.cuePath, R9);
    const ob = buildTrack(plan.objectPath, R9);
    const hit = plan.cuePath.events.find((e) => e.kind === 'ball')!;
    expect(hit).toBeDefined();
    const at = sampleTrack(cue, hit.t, R9, pose());
    expect(at.x).toBeCloseTo(hit.pos.x, 9);
    expect(at.y).toBeCloseTo(hit.pos.y, 9);
    expect(ob.start).toBeCloseTo(hit.t, 9);
    const before = sampleTrack(ob, hit.t * 0.5, R9, pose());
    expect(before.x).toBeCloseTo(plan.objectPath.points[0]!.x, 12);
    // Timeline: real time unless the shot runs longer than the 4 s cap.
    const tl = playbackTimeline([cue, ob], 4);
    expect(tl.duration).toBeLessThanOrEqual(4 + 1e-9);
    expect(tl.rate).toBeGreaterThanOrEqual(1);
    if (tl.simEnd <= 4) expect(tl.rate).toBe(1);
    else expect(tl.duration).toBeCloseTo(4, 9);
  });
});
