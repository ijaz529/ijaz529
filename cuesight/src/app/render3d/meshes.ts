/**
 * Mesh builders (pure: typed arrays only, no GL). Everything is built once per table; only the
 * plan ribbons are rebuilt when the plan changes, into a preallocated buffer.
 */
import type { PocketSpec, Segment, TableSpec, Vec2 } from '../../core/types';
import { underRail, type TableGeom } from './geom';
import type { V3 } from './math3d';

export interface MeshData {
  pos: Float32Array;
  nrm: Float32Array;
  uv: Float32Array;
  idx: Uint32Array;
}

export class MeshBuilder {
  private p: number[] = [];
  private n: number[] = [];
  private t: number[] = [];
  private i: number[] = [];

  get vertexCount(): number {
    return this.p.length / 3;
  }

  vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, u = 0, v = 0): number {
    const l = Math.hypot(nx, ny, nz) || 1;
    this.p.push(x, y, z);
    this.n.push(nx / l, ny / l, nz / l);
    this.t.push(u, v);
    return this.p.length / 3 - 1;
  }

  tri(a: number, b: number, c: number): void {
    this.i.push(a, b, c);
  }

  /** Quad a-b-c-d (counter-clockwise when seen from the front). */
  quad(a: number, b: number, c: number, d: number): void {
    this.i.push(a, b, c, a, c, d);
  }

  append(m: MeshData): void {
    const base = this.vertexCount;
    for (let k = 0; k < m.pos.length; k++) this.p.push(m.pos[k]!);
    for (let k = 0; k < m.nrm.length; k++) this.n.push(m.nrm[k]!);
    for (let k = 0; k < m.uv.length; k++) this.t.push(m.uv[k]!);
    for (let k = 0; k < m.idx.length; k++) this.i.push(m.idx[k]! + base);
  }

  build(): MeshData {
    return { pos: new Float32Array(this.p), nrm: new Float32Array(this.n), uv: new Float32Array(this.t), idx: new Uint32Array(this.i) };
  }
}

// ---------------------------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------------------------

/** Unit UV sphere (radius 1) with outward normals and CCW-from-outside winding. */
export function sphereMesh(segs = 64, rings = 40): MeshData {
  const b = new MeshBuilder();
  for (let i = 0; i <= rings; i++) {
    const th = (Math.PI * i) / rings;
    for (let j = 0; j <= segs; j++) {
      const ph = (2 * Math.PI * j) / segs;
      const x = Math.sin(th) * Math.cos(ph);
      const y = Math.sin(th) * Math.sin(ph);
      const z = Math.cos(th);
      b.vert(x, y, z, x, y, z, j / segs, i / rings);
    }
  }
  for (let i = 0; i < rings; i++)
    for (let j = 0; j < segs; j++) {
      const a = i * (segs + 1) + j;
      const c = a + segs + 1;
      b.tri(a, c, a + 1);
      b.tri(a + 1, c, c + 1);
    }
  return b.build();
}

/** Unit quad in the xy plane ([-1, 1]², normal +z). */
export function quadMesh(): MeshData {
  const b = new MeshBuilder();
  const a = b.vert(-1, -1, 0, 0, 0, 1, 0, 0);
  const c = b.vert(1, -1, 0, 0, 0, 1, 1, 0);
  const d = b.vert(1, 1, 0, 0, 0, 1, 1, 1);
  const e = b.vert(-1, 1, 0, 0, 0, 1, 0, 1);
  b.quad(a, c, d, e);
  return b.build();
}

function rectXY(b: MeshBuilder, x0: number, y0: number, x1: number, y1: number, z: number, nz = 1): void {
  const a = b.vert(x0, y0, z, 0, 0, nz, x0, y0);
  const c = b.vert(x1, y0, z, 0, 0, nz, x1, y0);
  const d = b.vert(x1, y1, z, 0, 0, nz, x1, y1);
  const e = b.vert(x0, y1, z, 0, 0, nz, x0, y1);
  if (nz > 0) b.quad(a, c, d, e);
  else b.quad(a, e, d, c);
}

/** Open box sides + optional bottom (for the cabinet). */
function boxSides(b: MeshBuilder, X: number, Y: number, z0: number, z1: number): void {
  const sides: [number, number, number, number, number, number][] = [
    [-X, -Y, X, -Y, 0, -1],
    [X, -Y, X, Y, 1, 0],
    [X, Y, -X, Y, 0, 1],
    [-X, Y, -X, -Y, -1, 0],
  ];
  for (const [ax, ay, bx, by, nx, ny] of sides) {
    const L = Math.hypot(bx - ax, by - ay);
    const a = b.vert(ax, ay, z0, nx, ny, 0, 0, z0);
    const c = b.vert(bx, by, z0, nx, ny, 0, L, z0);
    const d = b.vert(bx, by, z1, nx, ny, 0, L, z1);
    const e = b.vert(ax, ay, z1, nx, ny, 0, 0, z1);
    b.quad(a, c, d, e);
  }
}

// ---------------------------------------------------------------------------------------------
// Table parts
// ---------------------------------------------------------------------------------------------

/** Playing surface extended under the cushions (holes are cut in the shader). */
export function bedMesh(g: TableGeom): MeshData {
  const b = new MeshBuilder();
  rectXY(b, -(g.hx + g.cw + 0.002), -(g.hy + g.cw + 0.002), g.hx + g.cw + 0.002, g.hy + g.cw + 0.002, 0);
  return b.build();
}

interface ProfileVert {
  s: number;
  z: number;
  ns: number;
  nz: number;
}

/** Cushion cross-section: undercut face → sharp nose → rounded top → flat top to the rail. */
export function cushionProfile(g: TableGeom): ProfileVert[] {
  const h = g.noseZ;
  const out: ProfileVert[] = [];
  const face = { ns: -(h + 0.002), nz: -0.012 };
  out.push({ s: 0.012, z: -0.002, ...face }, { s: 0, z: h, ...face });
  const rr = 0.007;
  const steps = 7;
  for (let k = 0; k <= steps; k++) {
    const a = Math.PI - (k / steps) * (Math.PI / 2);
    out.push({ s: rr + rr * Math.cos(a), z: h + rr * Math.sin(a), ns: Math.cos(a), nz: Math.sin(a) });
  }
  const topSlope = (g.cushionTop - (h + rr)) / Math.max(1e-3, g.cw - rr);
  out.push({ s: g.cw + 0.002, z: g.cushionTop, ns: -topSlope, nz: 1 });
  return out;
}

function pocketAt(table: TableSpec, p: Vec2): PocketSpec | undefined {
  return table.pockets.find((q) => (Math.abs(q.jawA.x - p.x) < 1e-9 && Math.abs(q.jawA.y - p.y) < 1e-9) || (Math.abs(q.jawB.x - p.x) < 1e-9 && Math.abs(q.jawB.y - p.y) < 1e-9));
}

/**
 * Six cushions extruded along TableSpec.cushions between the jaw points. The jaw facings lean
 * toward the pocket (142° corner / 104° side facing angles), so the throat narrows behind the mouth.
 */
export function cushionMesh(table: TableSpec, g: TableGeom): MeshData {
  const b = new MeshBuilder();
  const prof = cushionProfile(g);
  for (const seg of table.cushions) addCushion(b, table, g, seg, prof);
  return b.build();
}

function addCushion(b: MeshBuilder, table: TableSpec, g: TableGeom, seg: Segment, prof: ProfileVert[]): void {
  const L = Math.hypot(seg.b.x - seg.a.x, seg.b.y - seg.a.y);
  const tx = (seg.b.x - seg.a.x) / L;
  const ty = (seg.b.y - seg.a.y) / L;
  const ox = -seg.n.x;
  const oy = -seg.n.y;
  const lean = (p: Vec2) => (pocketAt(table, p)?.kind === 'side' ? g.sideLean : g.cornerLean);
  const la = lean(seg.a);
  const lb = lean(seg.b);
  const P = (s: number, z: number, end: 0 | 1): V3 => {
    const base = end === 0 ? seg.a : seg.b;
    const along = end === 0 ? -la * s : lb * s;
    return [base.x + tx * along + ox * s, base.y + ty * along + oy * s, z];
  };
  // Profile strips (two vertices per profile point, one per end).
  const rows: [number, number][] = [];
  for (let k = 0; k < prof.length; k++) {
    const v = prof[k]!;
    const nx = ox * v.ns;
    const ny = oy * v.ns;
    const p0 = P(v.s, v.z, 0);
    const p1 = P(v.s, v.z, 1);
    // Duplicate the nose vertex so the undercut face keeps its own (flat) normal.
    rows.push([b.vert(p0[0], p0[1], p0[2], nx, ny, v.nz, 0, v.s + v.z), b.vert(p1[0], p1[1], p1[2], nx, ny, v.nz, L, v.s + v.z)]);
  }
  for (let k = 0; k + 1 < prof.length; k++) {
    if (k === 1) continue; // crease between the face and the nose arc (both vertices at the nose)
    const [a0, a1] = rows[k]!;
    const [c0, c1] = rows[k + 1]!;
    // Orientation: front faces toward the table (−o) / up.
    b.quad(a0, a1, c1, c0);
  }
  // End caps (jaw facings), fan-triangulated around the centroid.
  const capPts = [...prof.map((v) => [v.s, v.z] as [number, number]), [g.cw + 0.002, -0.002] as [number, number]];
  for (const end of [0, 1] as const) {
    const ln = end === 0 ? la : lb;
    // Facing direction (per unit depth s) and its outward normal (away from the cushion).
    const fx = (end === 0 ? -tx : tx) * ln + ox;
    const fy = (end === 0 ? -ty : ty) * ln + oy;
    let nx = -fy;
    let ny = fx;
    const sgn = (nx * tx + ny * ty) * (end === 0 ? -1 : 1);
    if (sgn < 0) {
      nx = -nx;
      ny = -ny;
    }
    let cs = 0;
    let cz = 0;
    for (const [s, z] of capPts) {
      cs += s;
      cz += z;
    }
    cs /= capPts.length;
    cz /= capPts.length;
    const c = P(cs, cz, end);
    const ci = b.vert(c[0], c[1], c[2], nx, ny, 0, 0, 0);
    const ids = capPts.map(([s, z]) => {
      const p = P(s, z, end);
      return b.vert(p[0], p[1], p[2], nx, ny, 0, s, z);
    });
    for (let k = 0; k < ids.length; k++) b.tri(ci, ids[k]!, ids[(k + 1) % ids.length]!);
  }
}

/** Rail cross-section (w outward from the cushion back, z): inner face, top, rounded edge, apron. */
export function railProfile(g: TableGeom): { w: number; z: number; nw: number; nz: number; crease?: boolean }[] {
  const out: { w: number; z: number; nw: number; nz: number; crease?: boolean }[] = [];
  const top = g.railTop;
  out.push({ w: 0, z: -0.03, nw: -1, nz: 0 }, { w: 0, z: top - 0.003, nw: -1, nz: 0 });
  const ri = 0.003;
  for (let k = 1; k <= 3; k++) {
    const a = Math.PI - (k / 3) * (Math.PI / 2);
    out.push({ w: ri + ri * Math.cos(a), z: top - ri + ri * Math.sin(a), nw: Math.cos(a), nz: Math.sin(a) });
  }
  const rr = 0.024;
  for (let k = 0; k <= 9; k++) {
    const a = Math.PI / 2 - (k / 9) * (Math.PI / 2);
    out.push({ w: g.rw - rr + rr * Math.cos(a), z: top - rr + rr * Math.sin(a), nw: Math.cos(a), nz: Math.sin(a) });
  }
  out.push({ w: g.rw, z: g.apronBottom + 0.012, nw: 1, nz: 0 });
  // Small bevel at the bottom of the apron.
  out.push({ w: g.rw, z: g.apronBottom + 0.012, nw: 0.7, nz: -0.7, crease: true }, { w: g.rw - 0.012, z: g.apronBottom, nw: 0.7, nz: -0.7 });
  out.push({ w: g.rw - 0.012, z: g.apronBottom, nw: 0, nz: -1, crease: true }, { w: g.rw - 0.09, z: g.apronBottom, nw: 0, nz: -1 });
  return out;
}

/** Four mitred rail sides (pocket holes are cut in the shader). */
export function railMesh(g: TableGeom): MeshData {
  const b = new MeshBuilder();
  const prof = railProfile(g);
  const sides = [
    { ox: 0, oy: -1, tx: 1, ty: 0, dIn: g.hy + g.cw, L: g.hx + g.cw },
    { ox: 1, oy: 0, tx: 0, ty: 1, dIn: g.hx + g.cw, L: g.hy + g.cw },
    { ox: 0, oy: 1, tx: -1, ty: 0, dIn: g.hy + g.cw, L: g.hx + g.cw },
    { ox: -1, oy: 0, tx: 0, ty: -1, dIn: g.hx + g.cw, L: g.hy + g.cw },
  ];
  for (const sd of sides) {
    const ids: [number, number][] = [];
    for (const v of prof) {
      const half = sd.L + v.w;
      const cx = sd.ox * (sd.dIn + v.w);
      const cy = sd.oy * (sd.dIn + v.w);
      const nx = sd.ox * v.nw;
      const ny = sd.oy * v.nw;
      const vv = v.w + Math.abs(v.z);
      ids.push([b.vert(cx - sd.tx * half, cy - sd.ty * half, v.z, nx, ny, v.nz, -half, vv), b.vert(cx + sd.tx * half, cy + sd.ty * half, v.z, nx, ny, v.nz, half, vv)]);
    }
    for (let k = 0; k + 1 < prof.length; k++) {
      if (prof[k + 1]!.crease) continue;
      const [a0, a1] = ids[k]!;
      const [c0, c1] = ids[k + 1]!;
      b.quad(a0, a1, c1, c0);
    }
  }
  return b.build();
}

/** Diamond sights: 6 per long rail (skipping the side pocket), 3 per short rail = 18. */
export function diamondPositions(g: TableGeom): { x: number; y: number; along: 'x' | 'y' }[] {
  const out: { x: number; y: number; along: 'x' | 'y' }[] = [];
  const inset = g.cw + g.rw * 0.42;
  for (let k = 1; k < 8; k++) {
    if (k === 4) continue;
    const x = -g.hx + (k * 2 * g.hx) / 8;
    out.push({ x, y: -(g.hy + inset), along: 'x' }, { x, y: g.hy + inset, along: 'x' });
  }
  for (let k = 1; k < 4; k++) {
    const y = -g.hy + (k * 2 * g.hy) / 4;
    out.push({ x: -(g.hx + inset), y, along: 'y' }, { x: g.hx + inset, y, along: 'y' });
  }
  return out;
}

export function diamondMesh(g: TableGeom): MeshData {
  const b = new MeshBuilder();
  const z = g.railTop + 0.0004;
  const la = 0.013;
  const lb = 0.0055;
  for (const d of diamondPositions(g)) {
    const ax = d.along === 'x' ? la : 0;
    const ay = d.along === 'x' ? 0 : la;
    const px = d.along === 'x' ? 0 : lb;
    const py = d.along === 'x' ? lb : 0;
    const c = b.vert(d.x, d.y, z, 0, 0, 1, 0.5, 0.5);
    const p0 = b.vert(d.x + ax, d.y + ay, z, 0, 0, 1, 1, 0.5);
    const p1 = b.vert(d.x + px, d.y + py, z, 0, 0, 1, 0.5, 1);
    const p2 = b.vert(d.x - ax, d.y - ay, z, 0, 0, 1, 0, 0.5);
    const p3 = b.vert(d.x - px, d.y - py, z, 0, 0, 1, 0.5, 0);
    b.tri(c, p0, p1);
    b.tri(c, p1, p2);
    b.tri(c, p2, p3);
    b.tri(c, p3, p0);
  }
  return b.build();
}

/** Pocket drops: an inward-facing leather wall and a bottom for each hole. */
export function pocketMesh(g: TableGeom, segs = 48): MeshData {
  const b = new MeshBuilder();
  for (const h of g.holes) {
    const top: number[] = [];
    const bot: number[] = [];
    for (let j = 0; j <= segs; j++) {
      const a = (2 * Math.PI * j) / segs;
      const c = Math.cos(a);
      const s = Math.sin(a);
      const x = h.x + h.r * c;
      const y = h.y + h.r * s;
      const zt = underRail(g, x, y) ? g.railTop : 0;
      top.push(b.vert(x, y, zt, -c, -s, 0, j / segs, zt));
      bot.push(b.vert(x, y, g.pocketBottom, -c, -s, 0, j / segs, g.pocketBottom));
    }
    for (let j = 0; j < segs; j++) b.quad(top[j]!, bot[j]!, bot[j + 1]!, top[j + 1]!);
    const cIdx = b.vert(h.x, h.y, g.pocketBottom, 0, 0, 1, 0.5, 0.5);
    const ring: number[] = [];
    for (let j = 0; j <= segs; j++) {
      const a = (2 * Math.PI * j) / segs;
      ring.push(b.vert(h.x + h.r * Math.cos(a), h.y + h.r * Math.sin(a), g.pocketBottom, 0, 0, 1, 0, 0));
    }
    for (let j = 0; j < segs; j++) b.tri(cIdx, ring[j]!, ring[j + 1]!);
  }
  return b.build();
}

/** Rubber pocket liners on the rail cap around each hole (hides the shader-cut edge). */
export function linerMesh(g: TableGeom, segs = 64): MeshData {
  const b = new MeshBuilder();
  const z = g.railTop + 0.0007;
  for (const h of g.holes) {
    const r0 = h.r - 0.0015;
    const r1 = h.r + 0.0075;
    for (let j = 0; j < segs; j++) {
      const a0 = (2 * Math.PI * j) / segs;
      const a1 = (2 * Math.PI * (j + 1)) / segs;
      const am = (a0 + a1) / 2;
      // Only where the hole cuts the wooden rail.
      if (!underRail(g, h.x + h.r * Math.cos(am), h.y + h.r * Math.sin(am))) continue;
      const v = (r: number, a: number, nIn: number) => b.vert(h.x + r * Math.cos(a), h.y + r * Math.sin(a), z, Math.cos(a) * nIn, Math.sin(a) * nIn, 1, r === r0 ? 0 : 1, a);
      const p0 = v(r0, a0, -0.6);
      const p1 = v(r1, a0, 0.3);
      const p2 = v(r1, a1, 0.3);
      const p3 = v(r0, a1, -0.6);
      b.quad(p0, p1, p2, p3);
    }
  }
  return b.build();
}

/** Cabinet below the rails and a plinth at the floor. */
export function cabinetMesh(g: TableGeom): MeshData {
  const b = new MeshBuilder();
  boxSides(b, g.outerX - 0.065, g.outerY - 0.065, g.floorZ + 0.07, g.apronBottom + 0.002);
  rectXY(b, -(g.outerX - 0.065), -(g.outerY - 0.065), g.outerX - 0.065, g.outerY - 0.065, g.apronBottom + 0.001, -1);
  boxSides(b, g.outerX - 0.05, g.outerY - 0.05, g.floorZ, g.floorZ + 0.07);
  rectXY(b, -(g.outerX - 0.05), -(g.outerY - 0.05), g.outerX - 0.05, g.outerY - 0.05, g.floorZ + 0.07, 1);
  return b.build();
}

export function floorMesh(g: TableGeom, half = 14): MeshData {
  const b = new MeshBuilder();
  rectXY(b, -half, -half, half, half, g.floorZ);
  return b.build();
}

// ---------------------------------------------------------------------------------------------
// Cue stick (lathe along +x from the tip at x = 0 to the butt at x = CUE_LENGTH)
// ---------------------------------------------------------------------------------------------
export const CUE_LENGTH = 1.47;

/** (x, radius) profile; sections match the cue texture (tip, ferrule, shaft, joint, forearm, wrap, sleeve, bumper). */
export const CUE_PROFILE: [number, number][] = [
  [0, 0],
  [0.0004, 0.0042],
  [0.0018, 0.006],
  [0.0045, 0.0064],
  [0.012, 0.0065],
  [0.037, 0.0066],
  [0.33, 0.0068],
  [0.74, 0.0106],
  [0.742, 0.0109],
  [0.768, 0.0109],
  [0.77, 0.0107],
  [1.02, 0.0128],
  [1.022, 0.0131],
  [1.27, 0.0137],
  [1.272, 0.0139],
  [1.45, 0.0147],
  [1.462, 0.0146],
  [1.469, 0.0128],
  [1.47, 0.008],
  [1.47, 0],
];

export function cueMesh(segs = 28): MeshData {
  const b = new MeshBuilder();
  const prof = CUE_PROFILE;
  const rows: number[][] = [];
  for (let k = 0; k < prof.length; k++) {
    const [x, r] = prof[k]!;
    const [xp, rp] = prof[Math.max(0, k - 1)]!;
    const [xn, rn] = prof[Math.min(prof.length - 1, k + 1)]!;
    // Profile normal from the neighbouring slope: (−dr, dx).
    let nx = -(rn - rp);
    let nr = xn - xp;
    const l = Math.hypot(nx, nr) || 1;
    nx /= l;
    nr /= l;
    const row: number[] = [];
    for (let j = 0; j <= segs; j++) {
      const a = (2 * Math.PI * j) / segs;
      row.push(b.vert(x, r * Math.cos(a), r * Math.sin(a), nx, nr * Math.cos(a), nr * Math.sin(a), x / CUE_LENGTH, j / segs));
    }
    rows.push(row);
  }
  for (let k = 0; k + 1 < rows.length; k++)
    for (let j = 0; j < segs; j++) {
      const a = rows[k]![j]!;
      const c = rows[k]![j + 1]!;
      const d = rows[k + 1]![j + 1]!;
      const e = rows[k + 1]![j]!;
      b.quad(a, e, d, c);
    }
  return b.build();
}

// ---------------------------------------------------------------------------------------------
// Ribbons (screen-space extruded polylines lying on a horizontal plane)
// ---------------------------------------------------------------------------------------------
/** Floats per ribbon vertex: pos(3) prev(3) next(3) side(1) u(1). */
export const RIBBON_FLOATS = 11;

/**
 * Write a polyline as a triangle strip (two vertices per point) into `out` starting at vertex
 * `first`. Returns the number of vertices written (0 if it does not fit or has < 2 points).
 */
export function writeRibbon(out: Float32Array, first: number, pts: ArrayLike<Vec2>, z: number, closed = false): number {
  const n = pts.length;
  if (n < 2) return 0;
  const count = (closed ? n + 1 : n) * 2;
  if ((first + count) * RIBBON_FLOATS > out.length) return 0;
  let o = first * RIBBON_FLOATS;
  let u = 0;
  const m = closed ? n + 1 : n;
  for (let i = 0; i < m; i++) {
    const c = pts[i % n]!;
    const p = closed ? pts[(i - 1 + n) % n]! : pts[Math.max(0, i - 1)]!;
    const q = closed ? pts[(i + 1) % n]! : pts[Math.min(n - 1, i + 1)]!;
    if (i > 0) {
      const prev = pts[(i - 1) % n]!;
      u += Math.hypot(c.x - prev.x, c.y - prev.y);
    }
    for (const side of [-1, 1]) {
      out[o++] = c.x;
      out[o++] = c.y;
      out[o++] = z;
      out[o++] = p.x;
      out[o++] = p.y;
      out[o++] = z;
      out[o++] = q.x;
      out[o++] = q.y;
      out[o++] = z;
      out[o++] = side;
      out[o++] = u;
    }
  }
  return count;
}

export function circlePoints(cx: number, cy: number, r: number, n = 48): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    out.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return out;
}

/** Drop consecutive points closer than `minStep` (keeps the first and last). */
export function simplifyPath(pts: Vec2[], minStep = 0.004): Vec2[] {
  if (pts.length <= 2) return pts.slice();
  const out: Vec2[] = [pts[0]!];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = out[out.length - 1]!;
    const p = pts[i]!;
    if (Math.hypot(p.x - a.x, p.y - a.y) >= minStep) out.push(p);
  }
  const last = pts[pts.length - 1]!;
  const a = out[out.length - 1]!;
  if (Math.hypot(last.x - a.x, last.y - a.y) > 1e-9 || out.length === 1) out.push(last);
  return out;
}
