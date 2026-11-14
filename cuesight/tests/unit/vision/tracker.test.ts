import { describe, expect, it } from 'vitest';
import type { DetectedBall } from '../../../src/vision/ball-detect';
import { createTracker } from '../../../src/vision/tracker';

const R = 0.028575;
const quad = (d = 0) => [
  { x: 100 + d, y: 100 },
  { x: 500 + d, y: 100 },
  { x: 560 + d, y: 400 },
  { x: 40 + d, y: 400 },
];
const det = (x: number, y: number, isCue = false): DetectedBall => ({
  pos: { x, y },
  image: { x: 0, y: 0 },
  isCue,
  score: 1,
  rgb: [255, 255, 255],
  label: isCue ? 'cue' : 'red',
  white: isCue ? 0.8 : -1,
  px: 100,
});

describe('tracker', () => {
  it('locks after 5 calm frames, unlocks on a jump, searches after 10 misses', () => {
    const t = createTracker({ ballRadius: R });
    const diag = 800;
    expect(t.update({ corners: quad(), balls: [], diag }).status).toBe('unstable');
    for (let i = 0; i < 4; i++) expect(t.update({ corners: quad(0.5), balls: [], diag }).status).toBe('unstable');
    expect(t.update({ corners: quad(0.5), balls: [], diag }).status).toBe('locked');
    expect(t.update({ corners: quad(120), balls: [], diag }).status).toBe('unstable');
    for (let i = 0; i < 9; i++) t.update({ corners: null, balls: [], diag });
    expect(t.update({ corners: null, balls: [], diag }).status).toBe('searching');
  });

  it('confirms tracks after 2 hits, smooths positions, keeps stable ids, drops lost balls', () => {
    const t = createTracker({ ballRadius: R });
    const diag = 800;
    expect(t.update({ corners: quad(), balls: [det(0, 0, true), det(0.5, 0.2)], diag }).balls).toHaveLength(0);
    const s2 = t.update({ corners: quad(), balls: [det(0.004, 0, true), det(0.5, 0.21)], diag });
    expect(s2.balls).toHaveLength(2);
    const cue = s2.balls.find((b) => b.isCue)!;
    expect(cue.id).toBe('cue');
    expect(cue.pos.x).toBeCloseTo(0.002, 6); // EMA α = 0.5
    const other = s2.balls.find((b) => !b.isCue)!.id;
    const s3 = t.update({ corners: quad(), balls: [det(0.004, 0, true), det(0.5, 0.21)], diag });
    expect(s3.balls.find((b) => !b.isCue)!.id).toBe(other);
    let s = s3;
    for (let i = 0; i < 6; i++) s = t.update({ corners: quad(), balls: [det(0.004, 0, true)], diag });
    expect(s.balls).toHaveLength(1);
  });

  it('ids are never reused: not after reset(), not by a tracker created with firstId = nextId()', () => {
    const t = createTracker({ ballRadius: R });
    const diag = 800;
    const balls = [det(0.1, 0), det(0.5, 0.2), det(-0.4, 0.3)];
    t.update({ corners: quad(), balls, diag });
    const before = new Set(t.update({ corners: quad(), balls, diag }).balls.map((b) => b.id));
    expect(before.size).toBe(3);
    t.reset();
    t.update({ corners: quad(), balls, diag });
    const after = t.update({ corners: quad(), balls, diag }).balls.map((b) => b.id);
    expect(after).toHaveLength(3);
    for (const id of after) expect(before.has(id), id).toBe(false);
    const u = createTracker({ ballRadius: R, firstId: t.nextId() });
    u.update({ corners: quad(), balls, diag });
    const third = u.update({ corners: quad(), balls, diag }).balls.map((b) => b.id);
    for (const id of third) {
      expect(before.has(id), id).toBe(false);
      expect(after.includes(id), id).toBe(false);
    }
  });

  it('resetLock() drops the lock but keeps the ball tracks and their ids', () => {
    const t = createTracker({ ballRadius: R });
    const diag = 800;
    const balls = [det(0.1, 0), det(0.5, 0.2)];
    let s = t.update({ corners: quad(), balls, diag });
    for (let i = 0; i < 6; i++) s = t.update({ corners: quad(), balls, diag });
    expect(s.status).toBe('locked');
    const ids = s.balls.map((b) => b.id);
    t.resetLock();
    expect(t.update({ corners: quad(), balls, diag }).status).toBe('unstable');
    expect(t.update({ corners: quad(), balls, diag }).balls.map((b) => b.id)).toEqual(ids);
  });
});
