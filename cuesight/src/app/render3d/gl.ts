/**
 * Thin WebGL2 helpers: programs with fixed attribute locations (so VAOs are program-agnostic),
 * cached uniform lookups, mesh/texture upload.
 */
import type { MeshData } from './meshes';
import type { PixelImage } from './textures';

export const ATTR = { aPos: 0, aNormal: 1, aUV: 2, aPrev: 3, aNext: 4, aSide: 5, aU: 6 } as const;

export class Program {
  readonly prog: WebGLProgram;
  private cache = new Map<string, WebGLUniformLocation | null>();

  constructor(
    private gl: WebGL2RenderingContext,
    vs: string,
    fs: string,
    readonly name: string,
  ) {
    const v = compile(gl, gl.VERTEX_SHADER, vs, name);
    const f = compile(gl, gl.FRAGMENT_SHADER, fs, name);
    const p = gl.createProgram();
    if (!p) throw new Error(`createProgram failed (${name})`);
    gl.attachShader(p, v);
    gl.attachShader(p, f);
    for (const [k, loc] of Object.entries(ATTR)) gl.bindAttribLocation(p, loc, k);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost()) {
      const log = gl.getProgramInfoLog(p);
      throw new Error(`link ${name}: ${log}`);
    }
    gl.deleteShader(v);
    gl.deleteShader(f);
    this.prog = p;
  }

  use(): this {
    this.gl.useProgram(this.prog);
    return this;
  }

  loc(name: string): WebGLUniformLocation | null {
    let l = this.cache.get(name);
    if (l === undefined) {
      l = this.gl.getUniformLocation(this.prog, name);
      this.cache.set(name, l);
    }
    return l;
  }

  f1(n: string, v: number): void {
    this.gl.uniform1f(this.loc(n), v);
  }
  i1(n: string, v: number): void {
    this.gl.uniform1i(this.loc(n), v);
  }
  f2(n: string, a: number, b: number): void {
    this.gl.uniform2f(this.loc(n), a, b);
  }
  f3(n: string, a: number, b: number, c: number): void {
    this.gl.uniform3f(this.loc(n), a, b, c);
  }
  f4(n: string, a: number, b: number, c: number, d: number): void {
    this.gl.uniform4f(this.loc(n), a, b, c, d);
  }
  v4a(n: string, v: Float32Array): void {
    this.gl.uniform4fv(this.loc(n), v);
  }
  m3(n: string, m: Float32Array): void {
    this.gl.uniformMatrix3fv(this.loc(n), false, m);
  }
  m4(n: string, m: Float32Array): void {
    this.gl.uniformMatrix4fv(this.loc(n), false, m);
  }

  dispose(): void {
    this.gl.deleteProgram(this.prog);
  }
}

function compile(gl: WebGL2RenderingContext, type: number, src: string, name: string): WebGLShader {
  const s = gl.createShader(type);
  if (!s) throw new Error(`createShader failed (${name})`);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) {
    const log = gl.getShaderInfoLog(s);
    const kind = type === gl.VERTEX_SHADER ? 'vertex' : 'fragment';
    throw new Error(`${name} ${kind} shader: ${log}`);
  }
  return s;
}

export interface GpuMesh {
  vao: WebGLVertexArrayObject;
  count: number;
  buffers: WebGLBuffer[];
}

export function uploadMesh(gl: WebGL2RenderingContext, m: MeshData): GpuMesh {
  const vao = gl.createVertexArray()!;
  gl.bindVertexArray(vao);
  const buffers: WebGLBuffer[] = [];
  const attrib = (data: Float32Array, loc: number, size: number) => {
    const b = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
    buffers.push(b);
  };
  attrib(m.pos, ATTR.aPos, 3);
  attrib(m.nrm, ATTR.aNormal, 3);
  attrib(m.uv, ATTR.aUV, 2);
  const ib = gl.createBuffer()!;
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, m.idx, gl.STATIC_DRAW);
  buffers.push(ib);
  gl.bindVertexArray(null);
  return { vao, count: m.idx.length, buffers };
}

export function drawMesh(gl: WebGL2RenderingContext, m: GpuMesh): void {
  if (m.count === 0) return;
  gl.bindVertexArray(m.vao);
  gl.drawElements(gl.TRIANGLES, m.count, gl.UNSIGNED_INT, 0);
}

export function disposeMesh(gl: WebGL2RenderingContext, m: GpuMesh | null): void {
  if (!m) return;
  for (const b of m.buffers) gl.deleteBuffer(b);
  gl.deleteVertexArray(m.vao);
}

export interface TexOpts {
  repeat?: boolean;
  mipmap?: boolean;
  nearest?: boolean;
  aniso?: number;
  /** Single-channel upload (heatmaps). */
  r8?: boolean;
}

export function createTexture(gl: WebGL2RenderingContext, src: PixelImage | TexImageSource | null, opts: TexOpts = {}): WebGLTexture {
  const t = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  if (!src) {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([128, 128, 128, 0]));
  } else if ('data' in src && 'width' in src && src.data instanceof Uint8Array) {
    const im = src as PixelImage;
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, im.width, im.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, im.data);
  } else {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src as TexImageSource);
  }
  const wrap = opts.repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  if (opts.mipmap && src) {
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  } else {
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, opts.nearest ? gl.NEAREST : gl.LINEAR);
  }
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, opts.nearest ? gl.NEAREST : gl.LINEAR);
  if (opts.aniso && opts.aniso > 1) {
    const ext = gl.getExtension('EXT_texture_filter_anisotropic');
    if (ext) {
      const max = gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number;
      gl.texParameterf(gl.TEXTURE_2D, ext.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(max, opts.aniso));
    }
  }
  return t;
}

/** Upload a single-channel float grid (0..1) as an R8 texture. */
export function uploadR8(gl: WebGL2RenderingContext, tex: WebGLTexture, cols: number, rows: number, values: Float32Array): void {
  const bytes = new Uint8Array(cols * rows);
  for (let i = 0; i < bytes.length; i++) {
    const v = values[i] ?? 0;
    bytes[i] = v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255);
  }
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, cols, rows, 0, gl.RED, gl.UNSIGNED_BYTE, bytes);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}
