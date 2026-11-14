import { describe, expect, it } from 'vitest';
import { DRILLS } from '../../../src/app/drills';
import { PALETTE } from '../../../src/app/render/palette';
import { DEFAULT_PHYSICS } from '../../../src/core/physics/params';
import { planShot } from '../../../src/core/shot/planner';
import { makeTable } from '../../../src/core/table';
import type { Ball } from '../../../src/core/types';
import { tableGeom, underRail } from '../../../src/app/render3d/geom';
import { quatRotate } from '../../../src/app/render3d/math3d';
import { RIBBON_FLOATS, circlePoints, cushionMesh, cushionProfile, diamondPositions, railMesh, sphereMesh, writeRibbon } from '../../../src/app/render3d/meshes';
import { MIN_CUE_ELEVATION, ballLook, cueGap, cuePose, hexRGBA, parseColor, planRibbons, restOrientation, strikePoint3 } from '../../../src/app/render3d/scene-data';

const table = makeTable('pool9');
const g = tableGeom(table);
const R = table.ballRadius;

describe('render3d meshes', () => {
  it('builds a closed unit sphere with outward normals and outward winding', () => {
    const m = sphereMesh(24, 16);
    for (let i = 0; i < m.nrm.length; i += 3) expect(Math.hypot(m.nrm[i]!, m.nrm[i + 1]!, m.nrm[i + 2]!)).toBeCloseTo(1, 5);
    let checked = 0;
    for (let t = 0; t < m.idx.length; t += 3) {
      const [a, b, c] = [m.idx[t]!, m.idx[t + 1]!, m.idx[t + 2]!].map((k) => [m.pos[3 * k]!, m.pos[3 * k + 1]!, m.pos[3 * k + 2]!]) as [number[], number[], number[]];
      const u = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!];
      const v = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
      const n = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
      const area = Math.hypot(n[0]!, n[1]!, n[2]!);
      if (area < 1e-9) continue; // degenerate pole triangles
      const cen = [(a[0]! + b[0]! + c[0]!) / 3, (a[1]! + b[1]! + c[1]!) / 3, (a[2]! + b[2]! + c[2]!) / 3];
      expect(n[0]! * cen[0]! + n[1]! * cen[1]! + n[2]! * cen[2]!).toBeGreaterThan(0);
      checked++;
    }
    expect(checked).toBeGreaterThan(500);
  });

  it('extrudes cushions so the nose runs exactly along each cushion segment', () => {
    const m = cushionMesh(table, g);
    const prof = cushionProfile(g);
    expect(prof[1]!.s).toBe(0);
    expect(prof[1]!.z).toBeCloseTo(table.cushionHeight, 12);
    // Every nose-height vertex at s = 0 lies on one of the cushion segments.
    let noseVerts = 0;
    for (let i = 0; i < m.pos.length; i += 3) {
      const x = m.pos[i]!;
      const y = m.pos[i + 1]!;
      const z = m.pos[i + 2]!;
      if (Math.abs(z - table.cushionHeight) > 1e-7) continue;
      const onSeg = table.cushions.some((c) => {
        const ab = { x: c.b.x - c.a.x, y: c.b.y - c.a.y };
        const t = ((x - c.a.x) * ab.x + (y - c.a.y) * ab.y) / (ab.x * ab.x + ab.y * ab.y);
        const px = c.a.x + ab.x * t - x;
        const py = c.a.y + ab.y * t - y;
        return t >= -1e-6 && t <= 1 + 1e-6 && Math.hypot(px, py) < 1e-6;
      });
      if (onSeg) noseVerts++;
    }
    expect(noseVerts).toBeGreaterThanOrEqual(table.cushions.length * 2);
    expect(railMesh(g).idx.length).toBeGreaterThan(0);
  });

  it('places 18 diamond sights on the rail caps and cuts the pocket drops into the rails', () => {
    const d = diamondPositions(g);
    expect(d).toHaveLength(18);
    for (const p of d) expect(underRail(g, p.x, p.y)).toBe(true);
    for (const h of g.holes) {
      // Each drop starts behind the mouth line and reaches under the wooden rail.
      const toMouth = (h.mx - h.x) * h.ix + (h.my - h.y) * h.iy;
      expect(toMouth).toBeGreaterThan(h.r);
      expect(underRail(g, h.x - h.ix * h.r * 0.95, h.y - h.iy * h.r * 0.95)).toBe(true);
    }
  });

  it('writes ribbons as triangle strips with cumulative distance', () => {
    const buf = new Float32Array(200 * RIBBON_FLOATS);
    const n = writeRibbon(
      buf,
      0,
      [
        { x: 0, y: 0 },
        { x: 0.3, y: 0 },
        { x: 0.3, y: 0.4 },
      ],
      0.001,
    );
    expect(n).toBe(6);
    expect(buf[5 * RIBBON_FLOATS + 10]).toBeCloseTo(0.7, 6); // u at the last vertex
    expect(buf[0 * RIBBON_FLOATS + 9]).toBe(-1);
    expect(buf[1 * RIBBON_FLOATS + 9]).toBe(1);
    const closed = writeRibbon(buf, 6, circlePoints(0, 0, 0.1, 12), 0.001, true);
    expect(closed).toBe(26);
    expect(writeRibbon(new Float32Array(10), 0, circlePoints(0, 0, 1, 12), 0)).toBe(0);
  });
});

describe('render3d scene data', () => {
  it('derives ball looks: numbers, stripes, snooker colours, detected colours', () => {
    const nine = ballLook({ id: 'b9', kind: 'object', pos: { x: 0, y: 0 }, label: '9', color: '#e8b90f', stripe: true }, table);
    expect(nine.slot).toBe(8);
    expect(nine.stripe).toBe(true);
    const eight = ballLook({ id: 'b8', kind: 'object', pos: { x: 0, y: 0 }, label: '8' }, table);
    expect(eight.stripe).toBe(false);
    expect(eight.color[0]).toBeLessThan(0.01);
    expect(ballLook({ id: 'c', kind: 'cue', pos: { x: 0, y: 0 } }, table).cueDots).toBe(true);
    const snooker = makeTable('snooker12');
    const pink = ballLook({ id: 'p', kind: 'object', pos: { x: 0, y: 0 }, label: 'pink' }, snooker);
    expect(pink.slot).toBe(-1);
    expect(pink.stripe).toBe(false);
    const detected = ballLook({ id: 'x', kind: 'object', pos: { x: 0, y: 0 }, label: 'blue stripe', color: 'rgb(30,60,200)' }, table);
    expect(detected.stripe).toBe(true);
    expect(detected.slot).toBe(-1);
    expect(parseColor('#fff')).toEqual([1, 1, 1]);
    expect(parseColor('rgb(255, 0, 0)')).toEqual([1, 0, 0]);
    expect(parseColor('nope')).toBeNull();
  });

  it('rests balls with the number circle facing up and reading upright', () => {
    const q = restOrientation('b5', { x: 0, y: 1 });
    const circle = quatRotate(q, [1, 0, 0]);
    expect(circle[2]).toBeGreaterThan(0.97);
    const textUp = quatRotate(q, [0, 0, 1]);
    expect(textUp[1]).toBeGreaterThan(0.85);
  });

  it('places the cue tip on the cue axis behind the strike point, pulled back with power', () => {
    const c = { x: -0.3, y: 0.1 };
    const aim = { x: 1, y: 0 };
    const stroke = { power: 6, side: 0.3, vert: -0.25 };
    const p = cuePose(g, c, aim, stroke);
    // Strike point is on the ball surface, behind it, right of centre, below centre.
    expect(Math.hypot(p.strike[0] - c.x, p.strike[1] - c.y, p.strike[2] - R)).toBeCloseTo(R, 9);
    expect(p.strike[0]).toBeLessThan(c.x);
    expect(p.strike[1]).toBeCloseTo(c.y - 0.3 * R, 9); // player's right of +x is −y
    expect(p.strike[2]).toBeCloseTo(R - 0.25 * R, 9);
    expect(strikePoint3(c, aim, 0.3, -0.25, R)).toEqual(p.strike);
    // Tip is behind the strike point along the cue axis by the power gap.
    const d = Math.hypot(p.tip[0] - p.strike[0], p.tip[1] - p.strike[1], p.tip[2] - p.strike[2]);
    expect(d).toBeCloseTo(cueGap(6), 9);
    expect(cueGap(6)).toBeCloseTo(0.05 + 0.03 * 6, 12);
    expect(p.back[0]).toBeLessThan(0);
    expect(p.elevation).toBeGreaterThanOrEqual(MIN_CUE_ELEVATION - 1e-12);
    // A cue ball frozen to the rail forces the butt up over the rail.
    const onRail = cuePose(g, { x: -g.hx + R, y: 0 }, aim, stroke);
    expect(onRail.elevation).toBeGreaterThan(p.elevation + 0.1);
  });

  it('builds the plan overlays with the Okabe–Ito palette', () => {
    const balls: Ball[] = DRILLS[0]!.build(table);
    const plan = planShot({ table, balls, source: 'virtual', frozen: false }, { targetId: 'b1', pocketId: 'TR' }, DEFAULT_PHYSICS);
    const rib = planRibbons({ table, balls, plan, targetId: 'b1', pocketId: 'TR', landing: { x: 0.2, y: 0.1 } }, g);
    const keys = rib.map((r) => r.key);
    for (const k of ['aim', 'ob', 'ghost', 'target', 'pocket', 'landing']) expect(keys).toContain(k);
    const aim = rib.find((r) => r.key === 'aim')!;
    expect(aim.color).toEqual(hexRGBA(plan.makeable ? PALETTE.aim : PALETTE.warn));
    expect(aim.dash).toBeUndefined(); // solid
    expect(rib.find((r) => r.key === 'ob')!.color).toEqual(hexRGBA(PALETTE.object));
    const cb = rib.find((r) => r.key === 'cb');
    if (cb) {
      expect(cb.dash![0]).toBeGreaterThan(0); // dashed
      expect(cb.color).toEqual(hexRGBA(PALETTE.cue));
    }
    for (const r of rib) expect(r.z).toBeGreaterThan(0); // lifted above the cloth
  });
});
