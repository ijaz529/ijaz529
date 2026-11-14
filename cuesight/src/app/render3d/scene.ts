/**
 * The WebGL2 renderer: owns GPU resources and draws one frame from a FrameState. It knows nothing
 * about gestures, playback or the app; createTable3D (index.ts) drives it.
 *
 * Draw order: background → floor/cabinet → rails, diamonds, liners, pockets → cloth → cushions →
 * contact shadows (decals) → plan ribbons (plane-depth decals) → balls → cue → ghost ball, glow,
 * dots (translucent). Only opaque passes write depth.
 */
import type { TableSpec, Vec2 } from '../../core/types';
import type { CameraMatrices } from './camera';
import { tableGeom, type TableGeom } from './geom';
import { ATTR, Program, createTexture, disposeMesh, drawMesh, uploadMesh, uploadR8, type GpuMesh } from './gl';
import { mat3FromQuat, mat4, type Mat4, type Quat, type V3 } from './math3d';
import {
  RIBBON_FLOATS,
  bedMesh,
  cabinetMesh,
  cueMesh,
  cushionMesh,
  diamondMesh,
  floorMesh,
  linerMesh,
  pocketMesh,
  quadMesh,
  railMesh,
  sphereMesh,
  writeRibbon,
} from './meshes';
import type { RGBA, RibbonSpec } from './scene-data';
import * as SH from './shaders';
import { clothVariationImage, clothWeaveImage, cueImage, numberAtlas, woodImage } from './textures';

export interface BallDraw {
  id: string;
  x: number;
  y: number;
  z: number;
  q: Quat;
  color: [number, number, number];
  stripe: boolean;
  slot: number;
  cueDots: boolean;
  highlight: boolean;
  visible: boolean;
}

export interface DotDraw {
  p: V3;
  /** CSS px. */
  size: number;
  color: RGBA;
  ring: RGBA;
  /** Pull toward the camera (m) so a dot on a ball surface is not hidden by the ball. */
  pull: number;
}

export interface FrameState {
  cam: CameraMatrices;
  /** Drawing-buffer size in device px and the CSS→device ratio. */
  width: number;
  height: number;
  dpr: number;
  balls: BallDraw[];
  ghost: Vec2 | null;
  dots: DotDraw[];
  cue: Mat4 | null;
  glow: { x: number; y: number; r: number; color: RGBA } | null;
  ribbons: boolean;
  heat: boolean;
}

const MAX_RIBBON_VERTS = 24_000;
/** ASSUMPTION: visual tuning (lamp radiance and exposure chosen by eye against the design). */
const LAMP_RADIANCE = 9.5;
const EXPOSURE = 1.3;

interface RibbonDraw {
  spec: RibbonSpec;
  first: number;
  count: number;
}

export class Renderer {
  private progs!: {
    bg: Program;
    lit: Program;
    cloth: Program;
    ball: Program;
    ghost: Program;
    decal: Program;
    line: Program;
    dot: Program;
  };
  private unit!: { sphere: GpuMesh; quad: GpuMesh; cue: GpuMesh; point: GpuMesh; empty: WebGLVertexArrayObject };
  private tex!: { weave: WebGLTexture; variation: WebGLTexture; wood: WebGLTexture; cue: WebGLTexture; numbers: WebGLTexture; heat: WebGLTexture };
  private table: TableSpec | null = null;
  private g: TableGeom | null = null;
  private meshes: Record<'bed' | 'cushion' | 'rail' | 'diamond' | 'pocket' | 'liner' | 'cabinet' | 'floor', GpuMesh> | null = null;
  private holes = new Float32Array(24);
  private spots = new Float32Array(32);
  private spotCount = 0;
  private baulk: [number, number, number, number] = [0, 0, 0, 0];
  private clothLin: [number, number, number] = [0.006, 0.12, 0.06];
  private ribbonBuf = new Float32Array(MAX_RIBBON_VERTS * RIBBON_FLOATS);
  private ribbonVbo!: WebGLBuffer;
  private ribbonVao!: WebGLVertexArrayObject;
  private ribbons: RibbonDraw[] = [];
  private heatRect: [number, number, number, number] = [0, 0, 1, 1];
  private heatOn = false;
  private identity = mat4();
  private rot3 = new Float32Array(9);
  readonly maxPointSize: number;

  constructor(private gl: WebGL2RenderingContext) {
    this.init();
    const r = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE) as Float32Array | null;
    this.maxPointSize = r ? r[1]! : 64;
  }

  /** (Re)create every GPU resource; also used after a context restore. */
  init(): void {
    const gl = this.gl;
    this.progs = {
      bg: new Program(gl, SH.BG_VS, SH.BG_FS, 'bg'),
      lit: new Program(gl, SH.LIT_VS, SH.LIT_FS, 'lit'),
      cloth: new Program(gl, SH.CLOTH_VS, SH.CLOTH_FS, 'cloth'),
      ball: new Program(gl, SH.BALL_VS, SH.BALL_FS, 'ball'),
      ghost: new Program(gl, SH.BALL_VS, SH.GHOST_FS, 'ghost'),
      decal: new Program(gl, SH.DECAL_VS, SH.DECAL_FS, 'decal'),
      line: new Program(gl, SH.LINE_VS, SH.LINE_FS, 'line'),
      dot: new Program(gl, SH.DOT_VS, SH.DOT_FS, 'dot'),
    };
    const pointVao = gl.createVertexArray()!;
    gl.bindVertexArray(pointVao);
    const pb = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, pb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 0]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(ATTR.aPos);
    gl.vertexAttribPointer(ATTR.aPos, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.unit = {
      sphere: uploadMesh(gl, sphereMesh(64, 40)),
      quad: uploadMesh(gl, quadMesh()),
      cue: uploadMesh(gl, cueMesh(28)),
      point: { vao: pointVao, count: 1, buffers: [pb] },
      empty: gl.createVertexArray()!,
    };
    const atlas = numberAtlas(256);
    this.tex = {
      weave: createTexture(gl, clothWeaveImage(256), { repeat: true, mipmap: true, aniso: 8 }),
      variation: createTexture(gl, clothVariationImage(256, 128), { repeat: false, mipmap: true }),
      wood: createTexture(gl, woodImage(1024, 256), { repeat: true, mipmap: true, aniso: 8 }),
      cue: createTexture(gl, cueImage(2048, 64), { repeat: true, mipmap: true, aniso: 4 }),
      numbers: createTexture(gl, atlas, { mipmap: true, aniso: 4 }),
      heat: createTexture(gl, null),
    };
    // Ribbon stream buffer.
    this.ribbonVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.ribbonVao);
    this.ribbonVbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ribbonVbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.ribbonBuf.byteLength, gl.DYNAMIC_DRAW);
    const stride = RIBBON_FLOATS * 4;
    const attr = (loc: number, size: number, off: number) => {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, off * 4);
    };
    attr(ATTR.aPos, 3, 0);
    attr(ATTR.aPrev, 3, 3);
    attr(ATTR.aNext, 3, 6);
    attr(ATTR.aSide, 1, 9);
    attr(ATTR.aU, 1, 10);
    gl.bindVertexArray(null);
    this.meshes = null;
    if (this.table) {
      const t = this.table;
      this.table = null;
      this.setTable(t);
    }
    // Re-upload stream data after a restore.
    this.uploadRibbons();
  }

  get geom(): TableGeom | null {
    return this.g;
  }

  setTable(table: TableSpec): void {
    if (this.table === table) return;
    const gl = this.gl;
    this.disposeTableMeshes();
    this.table = table;
    const g = tableGeom(table);
    this.g = g;
    this.meshes = {
      bed: uploadMesh(gl, bedMesh(g)),
      cushion: uploadMesh(gl, cushionMesh(table, g)),
      rail: uploadMesh(gl, railMesh(g)),
      diamond: uploadMesh(gl, g.snooker ? { pos: new Float32Array(0), nrm: new Float32Array(0), uv: new Float32Array(0), idx: new Uint32Array(0) } : diamondMesh(g)),
      pocket: uploadMesh(gl, pocketMesh(g)),
      liner: uploadMesh(gl, linerMesh(g)),
      cabinet: uploadMesh(gl, cabinetMesh(g)),
      floor: uploadMesh(gl, floorMesh(g)),
    };
    this.holes.fill(0);
    g.holes.forEach((h, i) => this.holes.set([h.x, h.y, h.r, 0], i * 4));
    // Markings: pool head/foot spots; snooker baulk line, D and the six colour spots.
    this.spots.fill(0);
    const spots: [number, number, number, number][] = [];
    if (g.snooker) {
      const k = table.length / 3.569;
      const baulkX = -g.hx + 0.737 * k;
      const dR = 0.292 * k;
      this.baulk = [1, baulkX, dR, 0.0012];
      spots.push([baulkX, 0, 0.004, 0], [baulkX, dR, 0.004, 0], [baulkX, -dR, 0.004, 0], [0, 0, 0.004, 0], [g.hx / 2, 0, 0.004, 0], [g.hx - 0.324 * k, 0, 0.004, 0]);
    } else {
      this.baulk = [0, 0, 0, 0];
      spots.push([table.length / 4, 0, 0.011, 1], [-table.length / 4, 0, 0.0035, 0]);
    }
    spots.forEach((s, i) => this.spots.set(s, i * 4));
    this.spotCount = spots.length;
    this.heatRect = [-g.hx + g.R, -g.hy + g.R, g.hx - g.R, g.hy - g.R];
  }

  /** Cloth colour as sRGB 0–255 (or 0–1). */
  setCloth(rgb: [number, number, number] | undefined): void {
    const c = rgb ?? [24, 104, 70];
    const s = Math.max(c[0], c[1], c[2]) > 1.001 ? 255 : 1;
    const lin = (v: number) => {
      const x = Math.max(0, Math.min(1, v / s));
      return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    };
    this.clothLin = [lin(c[0]), lin(c[1]), lin(c[2])];
  }

  setHeatmap(h: { cols: number; rows: number; values: Float32Array } | null): void {
    this.heatOn = !!h && h.cols > 0 && h.rows > 0;
    if (h && this.heatOn) uploadR8(this.gl, this.tex.heat, h.cols, h.rows, h.values);
  }

  private pendingRibbons: RibbonSpec[] = [];
  setRibbons(specs: RibbonSpec[]): void {
    this.pendingRibbons = specs;
    this.uploadRibbons();
  }

  private uploadRibbons(): void {
    this.ribbons = [];
    let v = 0;
    for (const spec of this.pendingRibbons) {
      const n = writeRibbon(this.ribbonBuf, v, spec.pts, spec.z, spec.closed);
      if (n === 0) continue;
      this.ribbons.push({ spec, first: v, count: n });
      v += n;
    }
    if (v > 0) {
      const gl = this.gl;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.ribbonVbo);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.ribbonBuf, 0, v * RIBBON_FLOATS);
    }
  }

  private common(p: Program, f: FrameState): void {
    const g = this.g!;
    p.m4('uVP', f.cam.vp);
    p.f3('uEye', f.cam.eye[0], f.cam.eye[1], f.cam.eye[2]);
    p.f4('uViewport', f.width, f.height, 1 / f.width, 1 / f.height);
    p.f4('uLamp', g.lampZ, g.lampHalfX, g.lampHalfY, LAMP_RADIANCE);
    p.f3('uBed', g.hx, g.hy, g.R);
    p.f3('uClothLin', this.clothLin[0], this.clothLin[1], this.clothLin[2]);
    p.f1('uExposure', EXPOSURE);
  }

  draw(f: FrameState): void {
    const gl = this.gl;
    const g = this.g;
    if (!g || !this.meshes) return;
    const P = this.progs;
    const M = this.meshes;
    gl.viewport(0, 0, f.width, f.height);
    gl.clearColor(0.027, 0.043, 0.078, 1);
    gl.clearDepth(1);
    gl.depthMask(true);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);

    // Background.
    gl.depthMask(false);
    P.bg.use();
    this.common(P.bg, f);
    gl.bindVertexArray(this.unit.empty);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.depthMask(true);

    // Lit opaque table parts.
    const lit = P.lit.use();
    this.common(lit, f);
    lit.m4('uModel', this.identity);
    lit.v4a('uHoles', this.holes);
    lit.f1('uRailTop', g.railTop);
    lit.f1('uPocketBottom', g.pocketBottom);
    lit.f3('uOuter', g.outerX, g.outerY, g.floorZ);
    lit.i1('uTex', 0);
    lit.i1('uTex2', 1);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex.wood);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.tex.weave);
    const mat = (m: number) => lit.i1('uMat', m);
    mat(SH.MAT.floor);
    drawMesh(gl, M.floor);
    mat(SH.MAT.cabinet);
    drawMesh(gl, M.cabinet);
    mat(SH.MAT.wood);
    drawMesh(gl, M.rail);
    mat(SH.MAT.pocket);
    drawMesh(gl, M.pocket);
    mat(SH.MAT.liner);
    drawMesh(gl, M.liner);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(-1, -2);
    mat(SH.MAT.diamond);
    drawMesh(gl, M.diamond);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    mat(SH.MAT.cushion);
    drawMesh(gl, M.cushion);

    // Cloth.
    const cl = P.cloth.use();
    this.common(cl, f);
    cl.v4a('uHoles', this.holes);
    cl.v4a('uSpots', this.spots);
    cl.i1('uSpotCount', this.spotCount);
    cl.f4('uBaulk', ...this.baulk);
    cl.f4('uHeatRect', ...this.heatRect);
    cl.f1('uHeatOn', f.heat && this.heatOn ? 1 : 0);
    cl.i1('uWeave', 0);
    cl.i1('uVariation', 1);
    cl.i1('uHeat', 2);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex.weave);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.tex.variation);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.tex.heat);
    drawMesh(gl, M.bed);

    // Contact shadows (darkening decals, elongated along the lamp axis and pushed away from it).
    gl.enable(gl.BLEND);
    gl.depthMask(false);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(-2, -4);
    const dc = P.decal.use();
    dc.m4('uVP', f.cam.vp);
    dc.i1('uMode', 0);
    gl.blendFunc(gl.ZERO, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(this.unit.quad.vao);
    const R = g.R;
    for (const b of f.balls) {
      if (!b.visible) continue;
      const lift = b.z - R;
      if (lift < -R * 0.6) continue; // inside a pocket
      const fade = Math.max(0, 1 - Math.max(0, lift) / (R * 4));
      // Offset away from the lamp centre line, longer along the lamp.
      const ox = Math.max(-1, Math.min(1, b.x / Math.max(0.1, g.lampHalfX))) * R * 0.25;
      const oy = (b.y / Math.max(0.2, g.hy)) * R * 0.35;
      dc.f3('uCenter', b.x + ox, b.y + oy, 0.0004);
      dc.f2('uAxisX', R * 2.15, 0);
      dc.f2('uAxisY', 0, R * 1.55);
      dc.f4('uColor', 0, 0, 0, 0.62 * fade);
      dc.f1('uCore', 0.38);
      gl.drawElements(gl.TRIANGLES, this.unit.quad.count, gl.UNSIGNED_INT, 0);
    }
    gl.disable(gl.POLYGON_OFFSET_FILL);

    // Plan ribbons.
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    if (f.ribbons && this.ribbons.length) {
      const ln = P.line.use();
      ln.m4('uVP', f.cam.vp);
      ln.m4('uInvVP', f.cam.invVP);
      ln.f4('uViewport', f.width, f.height, 1 / f.width, 1 / f.height);
      ln.f1('uFocal', 0.5 * f.height * f.cam.proj[5]!);
      ln.f1('uNear', f.cam.near * 1.01);
      gl.bindVertexArray(this.ribbonVao);
      for (const r of this.ribbons) {
        const s = r.spec;
        ln.f3('uWidth', s.width, s.minPx * f.dpr, s.haloPx * f.dpr);
        ln.f4('uColor', ...s.color);
        ln.f4('uHalo', ...s.halo);
        const d = s.dash ?? [0, 0, 0, 0];
        ln.f4('uDash', d[0], d[1], d[2], d[3]);
        ln.f1('uPlaneZ', s.z);
        gl.drawArrays(gl.TRIANGLE_STRIP, r.first, r.count);
      }
    }
    gl.disable(gl.BLEND);
    gl.depthMask(true);

    // Balls.
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    const bp = P.ball.use();
    this.common(bp, f);
    bp.i1('uNumbers', 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex.numbers);
    gl.bindVertexArray(this.unit.sphere.vao);
    for (const b of f.balls) {
      if (!b.visible) continue;
      bp.m3('uRot', mat3FromQuat(this.rot3, b.q));
      bp.f3('uCenter', b.x, b.y, b.z);
      bp.f1('uRadius', R);
      bp.f3('uBallColor', b.color[0], b.color[1], b.color[2]);
      bp.f4('uBallKind', b.stripe ? 1 : 0, b.slot, b.cueDots ? 1 : 0, b.highlight ? 1 : 0);
      gl.drawElements(gl.TRIANGLES, this.unit.sphere.count, gl.UNSIGNED_INT, 0);
    }
    gl.disable(gl.CULL_FACE);

    // Cue stick.
    if (f.cue) {
      const lc = P.lit.use();
      lc.m4('uModel', f.cue);
      lc.i1('uMat', SH.MAT.cue);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.tex.cue);
      drawMesh(gl, this.unit.cue);
      lc.m4('uModel', this.identity);
    }

    // Translucent: ghost ball, pocket glow, dots.
    gl.enable(gl.BLEND);
    gl.depthMask(false);
    if (f.ghost && f.ribbons) {
      gl.enable(gl.CULL_FACE);
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      const gp = P.ghost.use();
      this.common(gp, f);
      gp.m3('uRot', mat3FromQuat(this.rot3, [0, 0, 0, 1]));
      gp.f3('uCenter', f.ghost.x, f.ghost.y, R);
      gp.f1('uRadius', R * 0.995);
      gp.f4('uColor', 0.93, 0.96, 1.0, 0.55);
      gl.bindVertexArray(this.unit.sphere.vao);
      gl.drawElements(gl.TRIANGLES, this.unit.sphere.count, gl.UNSIGNED_INT, 0);
      gl.disable(gl.CULL_FACE);
    }
    if (f.glow) {
      const dg = P.decal.use();
      dg.m4('uVP', f.cam.vp);
      dg.i1('uMode', 1);
      gl.blendFunc(gl.ONE, gl.ONE);
      dg.f3('uCenter', f.glow.x, f.glow.y, 0.002);
      dg.f2('uAxisX', f.glow.r, 0);
      dg.f2('uAxisY', 0, f.glow.r);
      dg.f4('uColor', ...f.glow.color);
      gl.bindVertexArray(this.unit.quad.vao);
      gl.drawElements(gl.TRIANGLES, this.unit.quad.count, gl.UNSIGNED_INT, 0);
    }
    if (f.dots.length) {
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      const dp = P.dot.use();
      dp.m4('uVP', f.cam.vp);
      dp.f3('uEye', f.cam.eye[0], f.cam.eye[1], f.cam.eye[2]);
      gl.bindVertexArray(this.unit.point.vao);
      for (const d of f.dots) {
        const size = Math.min(this.maxPointSize, d.size * f.dpr);
        dp.f3('uPoint', d.p[0], d.p[1], d.p[2]);
        dp.f1('uSize', size);
        dp.f1('uPull', d.pull);
        dp.f4('uColor', ...d.color);
        dp.f4('uRing', ...d.ring);
        gl.drawArrays(gl.POINTS, 0, 1);
      }
    }
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    gl.bindVertexArray(null);
  }

  private disposeTableMeshes(): void {
    if (!this.meshes) return;
    for (const m of Object.values(this.meshes)) disposeMesh(this.gl, m);
    this.meshes = null;
  }

  dispose(): void {
    const gl = this.gl;
    if (gl.isContextLost()) return;
    this.disposeTableMeshes();
    for (const p of Object.values(this.progs)) p.dispose();
    disposeMesh(gl, this.unit.sphere);
    disposeMesh(gl, this.unit.quad);
    disposeMesh(gl, this.unit.cue);
    disposeMesh(gl, this.unit.point);
    gl.deleteVertexArray(this.unit.empty);
    for (const t of Object.values(this.tex)) gl.deleteTexture(t);
    gl.deleteBuffer(this.ribbonVbo);
    gl.deleteVertexArray(this.ribbonVao);
  }
}
