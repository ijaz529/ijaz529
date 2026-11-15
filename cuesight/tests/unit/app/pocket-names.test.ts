/**
 * Pocket names through a camera (Live, Snap): unique in any perspective, in the player's words.
 * Regression: from the Snap fixture's corner viewpoint the old centre-relative rule named two corners
 * "far right corner", so a plan read "black → far right corner … Try the far right corner."
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { makeTable } from '../../../src/core/table';
import type { PocketId, TablePresetId, Vec2 } from '../../../src/core/types';
import { perspectivePocketNames } from '../../../src/app/pocket-names';

interface Pose {
  R: number[];
  t: { x: number; y: number; z: number };
  f: number;
  cx: number;
  cy: number;
}
const fx = JSON.parse(readFileSync('tests/fixtures/snap-layout.json', 'utf8')) as { table: TablePresetId; photos: Record<string, { pose: Pose }> };
const table = makeTable(fx.table);

/** X_cam = R·X + t; u = f·X/Z + cx, v = f·Y/Z + cy (snap-layout.json poseConvention), on the bed z = 0. */
function project(pose: Pose, p: Vec2): Vec2 {
  const R = pose.R;
  const X = R[0]! * p.x + R[1]! * p.y + pose.t.x;
  const Y = R[3]! * p.x + R[4]! * p.y + pose.t.y;
  const Z = R[6]! * p.x + R[7]! * p.y + pose.t.z;
  return { x: (pose.f * X) / Z + pose.cx, y: (pose.f * Y) / Z + pose.cy };
}
const namesFor = (screen: (id: PocketId) => Vec2) => perspectivePocketNames(table.pockets, screen);
const mouth = (id: PocketId) => table.pockets.find((p) => p.id === id)!.mouthCenter;

/** The pre-fix rule: each pocket's quadrant relative to the projected table centre. */
function centreRule(screen: (p: Vec2) => Vec2): string[] {
  const c = screen({ x: 0, y: 0 });
  return table.pockets.map((pk) => {
    const q = screen(pk.mouthCenter);
    const v = q.y - c.y < 0 ? 'far' : 'near';
    const h = q.x - c.x < 0 ? 'left' : 'right';
    return pk.kind === 'corner' ? `${v} ${h} corner` : Math.abs(q.x - c.x) > Math.abs(q.y - c.y) ? `${h} side` : `${v} side`;
  });
}

describe('perspective pocket names', () => {
  it('names all six pockets uniquely on every fixture photo (corner view, table-level views)', () => {
    for (const [key, photo] of Object.entries(fx.photos)) {
      const names = namesFor((id) => project(photo.pose, mouth(id)));
      const list = table.pockets.map((p) => names[p.id]);
      expect(list.every(Boolean), key).toBe(true);
      expect(new Set(list).size, `${key}: ${list.join(', ')}`).toBe(6);
    }
  });

  it('fixes the duplicate the centre-relative rule gave on the Snap table photo', () => {
    const pose = fx.photos.overview!.pose;
    const old = centreRule((p) => project(pose, p));
    expect(new Set(old).size).toBeLessThan(6); // the bug this module replaces
    const names = namesFor((id) => project(pose, mouth(id)));
    expect(new Set(Object.values(names)).size).toBe(6);
  });

  it('reads naturally from the end of the table (long axis going away from the player)', () => {
    // Screen: x to the right, y down; the far rail is at the top. Table x axis points away.
    const screen = (id: PocketId) => {
      const m = mouth(id);
      const depth = 3 + m.x; // farther pockets are smaller and higher
      return { x: 500 + (-m.y * 400) / depth, y: 400 - (300 * (m.x + 1.5)) / depth };
    };
    const n = namesFor(screen);
    const far = table.pockets.filter((p) => p.kind === 'corner' && p.mouthCenter.x > 0).map((p) => n[p.id]);
    const near = table.pockets.filter((p) => p.kind === 'corner' && p.mouthCenter.x < 0).map((p) => n[p.id]);
    expect(far.sort()).toEqual(['far left corner', 'far right corner']);
    expect(near.sort()).toEqual(['near left corner', 'near right corner']);
    expect(table.pockets.filter((p) => p.kind === 'side').map((p) => n[p.id]).sort()).toEqual(['left side', 'right side']);
  });

  it('from a low corner view with the nearest corner below the photo: still unique, and that corner is "near"', () => {
    // Camera 0.35 m beyond the BL corner, 0.45 m up, looking along the diagonal toward TR: the BL corner
    // is under the camera (below the bottom edge of a 960×720 photo), the others are in view.
    const bl = mouth('BL');
    const tr = mouth('TR');
    const d = { x: tr.x - bl.x, y: tr.y - bl.y };
    const L = Math.hypot(d.x, d.y);
    const fw = { x: d.x / L, y: d.y / L, z: -0.3 };
    const fl = Math.hypot(fw.x, fw.y, fw.z);
    const fwd = { x: fw.x / fl, y: fw.y / fl, z: fw.z / fl };
    const right = { x: fwd.y, y: -fwd.x, z: 0 };
    const rl = Math.hypot(right.x, right.y);
    const rx = { x: right.x / rl, y: right.y / rl, z: 0 };
    // down = fwd × right
    const down = { x: fwd.y * rx.z - fwd.z * rx.y, y: fwd.z * rx.x - fwd.x * rx.z, z: fwd.x * rx.y - fwd.y * rx.x };
    const C = { x: bl.x - (d.x / L) * 0.35, y: bl.y - (d.y / L) * 0.35, z: 0.45 };
    const R = [rx.x, rx.y, rx.z, down.x, down.y, down.z, fwd.x, fwd.y, fwd.z];
    const t = { x: -(R[0]! * C.x + R[1]! * C.y + R[2]! * C.z), y: -(R[3]! * C.x + R[4]! * C.y + R[5]! * C.z), z: -(R[6]! * C.x + R[7]! * C.y + R[8]! * C.z) };
    const pose: Pose = { R, t, f: 700, cx: 480, cy: 360 };
    const at = (id: PocketId) => project(pose, mouth(id));
    expect(at('BL').y, 'the near corner is below the photo').toBeGreaterThan(720);
    const n = namesFor(at);
    expect(new Set(table.pockets.map((p) => n[p.id])).size).toBe(6);
    expect(n.BL).toMatch(/^near /);
    expect(n.TR).toMatch(/^far /);
  });

  it('reads naturally from the side (long axis across the view): sides are far and near', () => {
    const screen = (id: PocketId) => {
      const m = mouth(id);
      return { x: 500 + m.x * 300, y: 400 - m.y * 200 };
    };
    const n = namesFor(screen);
    const sides = table.pockets.filter((p) => p.kind === 'side');
    const farSide = sides.find((p) => p.mouthCenter.y > 0)!;
    expect(n[farSide.id]).toBe('far side');
    expect(n[sides.find((p) => p !== farSide)!.id]).toBe('near side');
    const farLeft = table.pockets.find((p) => p.kind === 'corner' && p.mouthCenter.x < 0 && p.mouthCenter.y > 0)!;
    expect(n[farLeft.id]).toBe('far left corner');
  });
});
