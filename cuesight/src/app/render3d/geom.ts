/**
 * Derived 3D table geometry shared by the mesh builders, camera presets, picking and shaders.
 * Pure (no DOM). Heights are above the bed (z = 0); the cushion nose height comes from TableSpec.
 *
 * ASSUMPTION: rail widths, rail-cap height, pocket throat/shelf and cabinet sizes are visual-only
 * approximations of a typical commercial table; they never feed the physics.
 */
import type { PocketId, PocketSpec, TableSpec } from '../../core/types';

export interface PocketHole {
  id: PocketId;
  kind: 'corner' | 'side';
  /** Centre of the pocket drop (behind the mouth). */
  x: number;
  y: number;
  /** Radius of the drop. */
  r: number;
  /** Mouth centre on the nose line, and the inward unit vector. */
  mx: number;
  my: number;
  ix: number;
  iy: number;
}

export interface TableGeom {
  hx: number;
  hy: number;
  R: number;
  /** Cushion depth (nose → back) and nose height. */
  cw: number;
  noseZ: number;
  cushionTop: number;
  /** Wooden rail cap width and top height. */
  rw: number;
  railTop: number;
  /** Bottom of the rail apron and the cabinet / floor heights. */
  apronBottom: number;
  floorZ: number;
  pocketBottom: number;
  /** Half extents of the rail outer edge. */
  outerX: number;
  outerY: number;
  holes: PocketHole[];
  /** Overhead lamp: height above the bed, half-length (x) and half-width (y). */
  lampZ: number;
  lampHalfX: number;
  lampHalfY: number;
  /** Corner pocket jaw facing lean (tan of the angle away from perpendicular); side likewise. */
  cornerLean: number;
  sideLean: number;
  snooker: boolean;
}

/** Facing angles: corner 142°, side 104° (WPA spec) → lean from the perpendicular. */
const CORNER_FACING_DEG = 142;
const SIDE_FACING_DEG = 104;

export function tableGeom(table: TableSpec): TableGeom {
  const hx = table.length / 2;
  const hy = table.width / 2;
  const R = table.ballRadius;
  const cw = table.cushionWidth;
  const noseZ = table.cushionHeight;
  const cushionTop = noseZ + 0.0095;
  const snooker = table.id === 'snooker12';
  const rw = snooker ? 0.12 : 0.115;
  const railTop = cushionTop + 0.0035;
  const cornerLean = Math.tan(((CORNER_FACING_DEG - 90) * Math.PI) / 180);
  const sideLean = Math.tan(((SIDE_FACING_DEG - 90) * Math.PI) / 180);
  const holes = table.pockets.map((p) => pocketHole(p, cw, cornerLean, sideLean, table));
  return {
    hx,
    hy,
    R,
    cw,
    noseZ,
    cushionTop,
    rw,
    railTop,
    apronBottom: -0.2,
    floorZ: -0.79,
    pocketBottom: -0.13,
    outerX: hx + cw + rw,
    outerY: hy + cw + rw,
    holes,
    lampZ: 0.85,
    lampHalfX: Math.min(0.85, table.length * 0.27),
    lampHalfY: 0.17,
    cornerLean,
    sideLean,
    snooker,
  };
}

function pocketHole(p: PocketSpec, cw: number, cornerLean: number, sideLean: number, table: TableSpec): PocketHole {
  const mouth = Math.hypot(p.jawB.x - p.jawA.x, p.jawB.y - p.jawA.y);
  // Throat at the back of the cushion = mouth narrowed by both facings.
  let r: number;
  let shelf: number;
  if (p.kind === 'corner') {
    // Each facing moves its jaw by (−lean·cw along the rail, −cw outward); projected on the mouth
    // line (45°) that closes the gap by cw·(lean − 1)/√2 per side.
    // WPA corner shelf (mouth line → drop) is 1"–2.25": the drop sits in the rail corner.
    const throat = mouth - Math.SQRT2 * cw * (cornerLean - 1);
    r = Math.max(table.ballRadius * 1.7, throat / 2 + 0.004);
    shelf = 0.032;
  } else {
    // Side shelf is 0–0.375".
    const throat = mouth - 2 * sideLean * cw;
    r = Math.max(table.ballRadius * 1.7, throat / 2 + 0.003);
    shelf = 0.005;
  }
  const back = shelf + r;
  return {
    id: p.id,
    kind: p.kind,
    x: p.mouthCenter.x - p.inward.x * back,
    y: p.mouthCenter.y - p.inward.y * back,
    r,
    mx: p.mouthCenter.x,
    my: p.mouthCenter.y,
    ix: p.inward.x,
    iy: p.inward.y,
  };
}

/** Is a plan-view point outside the cushion-back rectangle (i.e. under the wooden rail)? */
export function underRail(g: TableGeom, x: number, y: number): boolean {
  return Math.abs(x) > g.hx + g.cw || Math.abs(y) > g.hy + g.cw;
}
