/**
 * Ray-traced synthetic pool table (research.md R-13): exact ground truth for vision tests and the
 * fake-camera video for end-to-end tests. Models the bed, cushion blocks (cloth-covered, with a
 * visible nose face), wooden rails, pocket holes, shaded balls (solid/stripe, specular highlight)
 * and ball shadows, seen by a pinhole camera.
 */
import type { TableSpec } from '../../core/types';
import type { Vec2, Vec3 } from '../../core/vec';
import { createFrame, type Frame } from '../image';
import type { Mat3 } from '../homography';

export type RGB = [number, number, number];

export interface SynthBall {
  pos: Vec2;
  color: RGB;
  stripe?: boolean;
}

export interface SynthCamera {
  pos: Vec3;
  target: Vec3;
  /** Horizontal field of view in degrees. */
  fovDeg: number;
}

export interface SynthScene {
  table: TableSpec;
  balls: SynthBall[];
  camera: SynthCamera;
  width: number;
  height: number;
  cloth?: RGB;
  rail?: RGB;
  floor?: RGB;
  /** Supersampling factor per axis (1 = none). */
  ss?: number;
  /** Light position (default: lamp 1.1 m above the centre). */
  light?: Vec3;
  /** Amplitude of deterministic cloth noise (0..1). */
  noise?: number;
}

export const BALL_COLORS: Record<string, RGB> = {
  cue: [245, 245, 238],
  yellow: [236, 190, 20],
  blue: [20, 60, 170],
  red: [200, 25, 30],
  purple: [90, 30, 130],
  orange: [240, 110, 20],
  green: [20, 110, 50],
  maroon: [120, 20, 30],
  black: [18, 18, 20],
};

export interface CameraModel {
  K: Mat3;
  /** World → camera rotation rows (right, down, forward). */
  R: [Vec3, Vec3, Vec3];
  C: Vec3;
  f: number;
  project(p: Vec3): Vec2;
  /** Homography of the horizontal plane at height z (table metres → pixels). */
  planeH(z: number): Mat3;
}

const sub3 = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const cross3 = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const dot3 = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const norm3 = (a: Vec3): Vec3 => {
  const l = Math.hypot(a.x, a.y, a.z);
  return { x: a.x / l, y: a.y / l, z: a.z / l };
};

export function cameraModel(cam: SynthCamera, width: number, height: number): CameraModel {
  const fwd = norm3(sub3(cam.target, cam.pos));
  const right = norm3(cross3(fwd, { x: 0, y: 0, z: 1 }));
  const down = cross3(fwd, right);
  const f = width / 2 / Math.tan((cam.fovDeg * Math.PI) / 360);
  const cx = width / 2;
  const cy = height / 2;
  const R: [Vec3, Vec3, Vec3] = [right, down, fwd];
  const C = cam.pos;
  return {
    K: [f, 0, cx, 0, f, cy, 0, 0, 1],
    R,
    C,
    f,
    project(p: Vec3): Vec2 {
      const d = sub3(p, C);
      const x = dot3(right, d);
      const y = dot3(down, d);
      const z = dot3(fwd, d);
      return { x: (f * x) / z + cx, y: (f * y) / z + cy };
    },
    planeH(z: number): Mat3 {
      // p_cam = X·Rc0 + Y·Rc1 + R·((0,0,z) − C); columns of R are the world axes in camera coords.
      const c0 = { x: right.x, y: down.x, z: fwd.x };
      const c1 = { x: right.y, y: down.y, z: fwd.y };
      const o = sub3({ x: 0, y: 0, z }, C);
      const c2 = { x: dot3(right, o), y: dot3(down, o), z: dot3(fwd, o) };
      const col = (c: Vec3) => [f * c.x + cx * c.z, f * c.y + cy * c.z, c.z];
      const a = col(c0);
      const b = col(c1);
      const t = col(c2);
      const H = [a[0]!, b[0]!, t[0]!, a[1]!, b[1]!, t[1]!, a[2]!, b[2]!, t[2]!];
      const s = 1 / H[8]!;
      return H.map((v) => v * s);
    },
  };
}

function hash(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

interface Box {
  min: Vec3;
  max: Vec3;
  kind: 'cushion' | 'rail';
}

export function renderSyntheticTable(scene: SynthScene): Frame {
  const { table, width, height } = scene;
  const cam = cameraModel(scene.camera, width, height);
  const ss = scene.ss ?? 2;
  const cloth = scene.cloth ?? [40, 130, 70];
  const rail = scene.rail ?? [92, 52, 28];
  const floor = scene.floor ?? [70, 70, 75];
  const light = scene.light ?? { x: 0, y: 0, z: 1.1 };
  const noise = scene.noise ?? 0.04;
  const R = table.ballRadius;
  const hx = table.length / 2;
  const hy = table.width / 2;
  const c = table.cushionWidth;
  const hc = table.cushionHeight;
  const rw = 0.11; // rail width
  const rh = hc + 0.004;

  const boxes: Box[] = [
    { min: { x: -hx - c, y: -hy - c, z: 0 }, max: { x: hx + c, y: -hy, z: hc }, kind: 'cushion' },
    { min: { x: -hx - c, y: hy, z: 0 }, max: { x: hx + c, y: hy + c, z: hc }, kind: 'cushion' },
    { min: { x: -hx - c, y: -hy, z: 0 }, max: { x: -hx, y: hy, z: hc }, kind: 'cushion' },
    { min: { x: hx, y: -hy, z: 0 }, max: { x: hx + c, y: hy, z: hc }, kind: 'cushion' },
    { min: { x: -hx - c - rw, y: -hy - c - rw, z: 0 }, max: { x: hx + c + rw, y: -hy - c, z: rh }, kind: 'rail' },
    { min: { x: -hx - c - rw, y: hy + c, z: 0 }, max: { x: hx + c + rw, y: hy + c + rw, z: rh }, kind: 'rail' },
    { min: { x: -hx - c - rw, y: -hy - c, z: 0 }, max: { x: -hx - c, y: hy + c, z: rh }, kind: 'rail' },
    { min: { x: hx + c, y: -hy - c, z: 0 }, max: { x: hx + c + rw, y: hy + c, z: rh }, kind: 'rail' },
  ];
  // Pocket holes: circles in plan view that cut bed, cushions and inner rail.
  const g = table.cornerMouth / Math.SQRT2;
  const holes: { x: number; y: number; r: number }[] = [];
  for (const sx of [-1, 1])
    for (const sy of [-1, 1]) {
      const off = 0.25 * g;
      holes.push({ x: sx * (hx + off), y: sy * (hy + off), r: g * 1.02 + off * 0.9 });
    }
  for (const sy of [-1, 1]) holes.push({ x: 0, y: sy * (hy + table.sideMouth * 0.45), r: table.sideMouth * 0.56 });
  const inHole = (x: number, y: number) => holes.some((h) => (x - h.x) ** 2 + (y - h.y) ** 2 < h.r * h.r);

  // Ball stripe axes (deterministic per index).
  const axes = scene.balls.map((_, i) => norm3({ x: Math.sin(i * 1.7), y: Math.cos(i * 2.3), z: 0.6 + 0.3 * Math.sin(i) }));

  const frame = createFrame(width, height);
  const Rm = cam.R;
  const col: [number, number, number] = [0, 0, 0];

  const shade = (o: Vec3, d: Vec3): void => {
    // Nearest sphere.
    let tBest = Infinity;
    let hitKind = 0; // 0 none, 1 ball, 2 bed, 3 box face, 4 floor
    let ballIdx = -1;
    for (let i = 0; i < scene.balls.length; i++) {
      const b = scene.balls[i]!;
      const oc = { x: o.x - b.pos.x, y: o.y - b.pos.y, z: o.z - R };
      const bb = dot3(oc, d);
      const cc = dot3(oc, oc) - R * R;
      const disc = bb * bb - cc;
      if (disc < 0) continue;
      const t = -bb - Math.sqrt(disc);
      if (t > 1e-6 && t < tBest) {
        tBest = t;
        hitKind = 1;
        ballIdx = i;
      }
    }
    // Boxes (slab method), record the face normal.
    let boxN: Vec3 = { x: 0, y: 0, z: 1 };
    let boxKind: Box['kind'] = 'rail';
    for (const bx of boxes) {
      let t0 = -Infinity;
      let t1 = Infinity;
      let nEnter: Vec3 = { x: 0, y: 0, z: 0 };
      let ok = true;
      for (const ax of ['x', 'y', 'z'] as const) {
        const inv = 1 / d[ax];
        let ta = (bx.min[ax] - o[ax]) * inv;
        let tb = (bx.max[ax] - o[ax]) * inv;
        let sign = -1;
        if (ta > tb) {
          [ta, tb] = [tb, ta];
          sign = 1;
        }
        if (ta > t0) {
          t0 = ta;
          nEnter = { x: 0, y: 0, z: 0, [ax]: sign } as Vec3;
        }
        if (tb < t1) t1 = tb;
        if (t0 > t1) {
          ok = false;
          break;
        }
      }
      if (!ok || t0 <= 1e-6 || t0 >= tBest) continue;
      const p = { x: o.x + d.x * t0, y: o.y + d.y * t0, z: o.z + d.z * t0 };
      if (inHole(p.x, p.y)) continue;
      tBest = t0;
      hitKind = 3;
      boxN = nEnter;
      boxKind = bx.kind;
    }
    // Bed plane z = 0.
    if (d.z < 0) {
      const t = -o.z / d.z;
      if (t > 0 && t < tBest) {
        const x = o.x + d.x * t;
        const y = o.y + d.y * t;
        if (Math.abs(x) <= hx && Math.abs(y) <= hy) {
          tBest = t;
          hitKind = inHole(x, y) ? 5 : 2;
        } else if (Math.abs(x) <= hx + c + rw && Math.abs(y) <= hy + c + rw) {
          if (inHole(x, y)) {
            tBest = t;
            hitKind = 5;
          }
        }
      }
      const tf = (-0.78 - o.z) / d.z;
      if (hitKind === 0 && tf > 0) {
        tBest = tf;
        hitKind = 4;
      }
    }
    if (hitKind === 0) {
      col[0] = 30;
      col[1] = 30;
      col[2] = 34;
      return;
    }
    const p = { x: o.x + d.x * tBest, y: o.y + d.y * tBest, z: o.z + d.z * tBest };
    const toL = norm3(sub3(light, p));
    if (hitKind === 1) {
      const b = scene.balls[ballIdx]!;
      const n = norm3({ x: p.x - b.pos.x, y: p.y - b.pos.y, z: p.z - R });
      let base = b.color;
      if (b.stripe && Math.abs(dot3(n, axes[ballIdx]!)) > 0.45) base = BALL_COLORS.cue!;
      const lam = Math.max(0, dot3(n, toL));
      const refl = sub3({ x: 2 * dot3(n, toL) * n.x, y: 2 * dot3(n, toL) * n.y, z: 2 * dot3(n, toL) * n.z }, toL);
      const spec = Math.pow(Math.max(0, -dot3(refl, d)), 40) * 0.6;
      const k = 0.35 + 0.7 * lam;
      col[0] = base[0] * k + 255 * spec;
      col[1] = base[1] * k + 255 * spec;
      col[2] = base[2] * k + 255 * spec;
      return;
    }
    if (hitKind === 5) {
      col[0] = 10;
      col[1] = 10;
      col[2] = 12;
      return;
    }
    if (hitKind === 4) {
      col[0] = floor[0];
      col[1] = floor[1];
      col[2] = floor[2];
      return;
    }
    // Shadow ray toward the light (balls only).
    let shadow = 1;
    for (const b of scene.balls) {
      const oc = { x: p.x - b.pos.x, y: p.y - b.pos.y, z: p.z - R };
      const bb = dot3(oc, toL);
      const cc = dot3(oc, oc) - R * R;
      if (bb < 0 && bb * bb - cc > 0) {
        shadow = 0.55;
        break;
      }
    }
    const nz = hitKind === 2 ? { x: 0, y: 0, z: 1 } : boxN;
    const lam = Math.max(0, dot3(nz, toL));
    let base: RGB = cloth;
    let k = (0.45 + 0.6 * lam) * shadow;
    if (hitKind === 3) {
      if (boxKind === 'rail') base = rail;
      else if (nz.z < 0.5) k *= 0.7; // cushion nose face
      else k *= 0.92; // cushion top
    }
    const nn = 1 + noise * (hash(Math.round(p.x * 2000), Math.round(p.y * 2000)) - 0.5) * 2;
    col[0] = base[0] * k * nn;
    col[1] = base[1] * k * nn;
    col[2] = base[2] * k * nn;
  };

  const cx = width / 2;
  const cy = height / 2;
  const data = frame.data;
  for (let v = 0; v < height; v++) {
    for (let u = 0; u < width; u++) {
      let r = 0;
      let gg = 0;
      let bl = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const px = u + (sx + 0.5) / ss;
          const py = v + (sy + 0.5) / ss;
          const xc = (px - cx) / cam.f;
          const yc = (py - cy) / cam.f;
          const d = norm3({
            x: Rm[0].x * xc + Rm[1].x * yc + Rm[2].x,
            y: Rm[0].y * xc + Rm[1].y * yc + Rm[2].y,
            z: Rm[0].z * xc + Rm[1].z * yc + Rm[2].z,
          });
          shade(cam.C, d);
          r += col[0];
          gg += col[1];
          bl += col[2];
        }
      }
      const i = (v * width + u) * 4;
      const n = ss * ss;
      data[i] = r / n;
      data[i + 1] = gg / n;
      data[i + 2] = bl / n;
      data[i + 3] = 255;
    }
  }
  return frame;
}

/** A standard 9-ball-ish layout used by fixtures (positions in table metres). */
export function fixtureBalls(table: TableSpec): { balls: SynthBall[]; cueIndex: number } {
  const R = table.ballRadius;
  const pos: [number, number, keyof typeof BALL_COLORS, boolean?][] = [
    [-0.75, -0.12, 'cue'],
    [0.35, 0.18, 'yellow'],
    [0.55, -0.3, 'blue'],
    [-0.2, 0.42, 'red'],
    [0.9, 0.05, 'purple', true],
    [0.9 + 2 * R + 0.0005, 0.05, 'orange'],
    [-0.5, -0.45, 'black'],
    [0.1, -0.05, 'maroon', true],
    [1.1, 0.6 - R, 'yellow', true],
  ];
  return {
    balls: pos.map(([x, y, c, stripe]) => ({ pos: { x, y }, color: BALL_COLORS[c]!, ...(stripe ? { stripe: true } : {}) })),
    cueIndex: 0,
  };
}
