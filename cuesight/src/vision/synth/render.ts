/**
 * Ray-traced synthetic pool table (research.md R-13): exact ground truth for vision tests and the
 * fake-camera video for end-to-end tests. Models the bed, cushion blocks (cloth-covered, with a
 * visible nose face), wooden rails, pocket holes, shaded balls (solid/stripe, specular highlight),
 * ball shadows and optional cue sticks, seen by a pinhole camera.
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
  /** Stripe axis (the band is the great circle around it). Default: a fixed pseudo-random axis per index. */
  axis?: Vec3;
}

/**
 * A cue stick: a tapered round shaft (cone frustum) from the tip to the butt, both in table metres
 * with z = height above the bed. The first `ferrule` metres from the tip are drawn in ferrule white.
 */
export interface SynthStick {
  tip: Vec3;
  butt: Vec3;
  /** Shaft radius at the tip and at the butt (m). ASSUMPTION: a typical cue is ~13 mm at the tip, ~30 mm at the butt. */
  tipRadius: number;
  buttRadius: number;
  color?: RGB;
  ferrule?: number;
}

export interface SynthCamera {
  pos: Vec3;
  target: Vec3;
  /** Horizontal field of view in degrees. */
  fovDeg: number;
  /** Optional roll about the viewing axis in degrees (+ = image content turns clockwise). Default 0. */
  rollDeg?: number;
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
  /** Optional cue sticks (vision robustness fixtures). They occlude, but cast no shadow. */
  sticks?: SynthStick[];
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
  // Snooker colours. ASSUMPTION: sRGB approximations of typical ball pigments (no colorimetric source).
  pink: [235, 120, 150],
  brown: [120, 70, 30],
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
  let right = norm3(cross3(fwd, { x: 0, y: 0, z: 1 }));
  let down = cross3(fwd, right);
  if (cam.rollDeg) {
    const a = (cam.rollDeg * Math.PI) / 180;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const r0 = right;
    const d0 = down;
    right = { x: ca * r0.x + sa * d0.x, y: ca * r0.y + sa * d0.y, z: ca * r0.z + sa * d0.z };
    down = { x: ca * d0.x - sa * r0.x, y: ca * d0.y - sa * r0.y, z: ca * d0.z - sa * r0.z };
  }
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

export interface PlayerCameraOptions {
  /** Cue-ball centre (table metres). */
  cue: Vec2;
  /** Point the player aims at (usually the target ball). Sets the shooting direction. */
  aimAt: Vec2;
  /** Horizontal distance from the cue-ball centre back to the camera (m). */
  distance: number;
  /** Camera height above the bed (m). */
  height: number;
  /** Rotate the camera position about the cue ball, off the aim line (deg, + = counter-clockwise). */
  yawOffsetDeg?: number;
  /** Extra heading change of the view direction (deg, + = turn left). */
  headingOffsetDeg?: number;
  /** Image row of the cue-ball centre as a fraction of the height (0.5 = centre). Default 0.72. */
  cueRow?: number;
  fovDeg: number;
  /** Image size the camera will render (px). */
  imageWidth: number;
  imageHeight: number;
  ballRadius: number;
  rollDeg?: number;
}

/**
 * A table-level "player view" camera (spec 002 R-24 test scenes): crouched behind the cue ball,
 * facing the aim point horizontally and pitched so the cue ball sits at `cueRow` of the image.
 */
export function playerViewCamera(o: PlayerCameraOptions): SynthCamera {
  const aim = Math.atan2(o.aimAt.y - o.cue.y, o.aimAt.x - o.cue.x);
  const back = aim + ((o.yawOffsetDeg ?? 0) * Math.PI) / 180;
  const pos = { x: o.cue.x - Math.cos(back) * o.distance, y: o.cue.y - Math.sin(back) * o.distance, z: o.height };
  const psi = Math.atan2(o.aimAt.y - pos.y, o.aimAt.x - pos.x) + ((o.headingOffsetDeg ?? 0) * Math.PI) / 180;
  const f = o.imageWidth / 2 / Math.tan((o.fovDeg * Math.PI) / 360);
  const tau = ((o.cueRow ?? 0.72) * o.imageHeight - o.imageHeight / 2) / f;
  // Cue-ball centre relative to the camera: along the heading (hh) and vertically (vz).
  const vx = o.cue.x - pos.x;
  const vy = o.cue.y - pos.y;
  const hh = Math.cos(psi) * vx + Math.sin(psi) * vy;
  const vz = o.ballRadius - pos.z;
  // Pitch φ (down) with (down·v)/(fwd·v) = τ for a level (roll-free) camera.
  const phi = Math.atan2(-vz - tau * hh, hh - tau * vz);
  const fwd = { x: Math.cos(phi) * Math.cos(psi), y: Math.cos(phi) * Math.sin(psi), z: -Math.sin(phi) };
  return {
    pos,
    target: { x: pos.x + fwd.x, y: pos.y + fwd.y, z: pos.z + fwd.z },
    fovDeg: o.fovDeg,
    ...(o.rollDeg ? { rollDeg: o.rollDeg } : {}),
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
  const nHoles = holes.length;
  const holeX = new Float64Array(holes.map((h) => h.x));
  const holeY = new Float64Array(holes.map((h) => h.y));
  const holeR = new Float64Array(holes.map((h) => h.r));
  const inHole = (x: number, y: number): boolean => {
    for (let k = 0; k < nHoles; k++) if ((x - holeX[k]!) ** 2 + (y - holeY[k]!) ** 2 < holeR[k]! * holeR[k]!) return true;
    return false;
  };

  // Ball stripe axes (deterministic per index).
  const axes = scene.balls.map((b, i) => norm3(b.axis ?? { x: Math.sin(i * 1.7), y: Math.cos(i * 2.3), z: 0.6 + 0.3 * Math.sin(i) }));

  // Flat, allocation-free scene data for the per-ray loops. Every expression below reproduces the
  // arithmetic of the original object-based tracer term by term, so frames are bit-identical.
  const nBalls = scene.balls.length;
  const ballX = new Float64Array(nBalls);
  const ballY = new Float64Array(nBalls);
  const axX = new Float64Array(nBalls);
  const axY = new Float64Array(nBalls);
  const axZ = new Float64Array(nBalls);
  const ocX = new Float64Array(nBalls);
  const ocY = new Float64Array(nBalls);
  const ocZ = new Float64Array(nBalls);
  const ocC = new Float64Array(nBalls);
  const C = cam.C;
  for (let i = 0; i < nBalls; i++) {
    const b = scene.balls[i]!;
    ballX[i] = b.pos.x;
    ballY[i] = b.pos.y;
    axX[i] = axes[i]!.x;
    axY[i] = axes[i]!.y;
    axZ[i] = axes[i]!.z;
    // Primary rays all start at the camera centre.
    ocX[i] = C.x - b.pos.x;
    ocY[i] = C.y - b.pos.y;
    ocZ[i] = C.z - R;
    ocC[i] = ocX[i]! * ocX[i]! + ocY[i]! * ocY[i]! + ocZ[i]! * ocZ[i]! - R * R;
  }
  const nBoxes = boxes.length;
  const bMin = new Float64Array(nBoxes * 3);
  const bMax = new Float64Array(nBoxes * 3);
  const bRail = new Uint8Array(nBoxes);
  for (let k = 0; k < nBoxes; k++) {
    const bx = boxes[k]!;
    bMin[k * 3] = bx.min.x;
    bMin[k * 3 + 1] = bx.min.y;
    bMin[k * 3 + 2] = bx.min.z;
    bMax[k * 3] = bx.max.x;
    bMax[k * 3 + 1] = bx.max.y;
    bMax[k * 3 + 2] = bx.max.z;
    bRail[k] = bx.kind === 'rail' ? 1 : 0;
  }
  const oArr = [C.x, C.y, C.z];
  // Sticks: cone frustums, flattened like the balls. Per stick: tip (3), unit axis (3), length,
  // tip radius, taper (radius change per metre), ferrule length, RGB.
  const sticks = scene.sticks ?? [];
  const nSticks = sticks.length;
  const stk = new Float64Array(nSticks * 14);
  for (let s = 0; s < nSticks; s++) {
    const st = sticks[s]!;
    const ax = st.butt.x - st.tip.x;
    const ay = st.butt.y - st.tip.y;
    const az = st.butt.z - st.tip.z;
    const L = Math.hypot(ax, ay, az);
    const col = st.color ?? [196, 160, 110];
    stk.set([st.tip.x, st.tip.y, st.tip.z, ax / L, ay / L, az / L, L, st.tipRadius, (st.buttRadius - st.tipRadius) / L, st.ferrule ?? 0.012, col[0], col[1], col[2], 0], s * 14);
  }

  const frame = createFrame(width, height);
  const Rm = cam.R;
  const col: [number, number, number] = [0, 0, 0];
  const dArr = [0, 0, 0];

  const shade = (dx: number, dy: number, dz: number): void => {
    const ox = C.x;
    const oy = C.y;
    const oz = C.z;
    // Nearest sphere.
    let tBest = Infinity;
    let hitKind = 0; // 0 none, 1 ball, 2 bed, 3 box face, 4 floor, 5 pocket hole
    let ballIdx = -1;
    for (let i = 0; i < nBalls; i++) {
      const bb = ocX[i]! * dx + ocY[i]! * dy + ocZ[i]! * dz;
      const disc = bb * bb - ocC[i]!;
      if (disc < 0) continue;
      const t = -bb - Math.sqrt(disc);
      if (t > 1e-6 && t < tBest) {
        tBest = t;
        hitKind = 1;
        ballIdx = i;
      }
    }
    // Sticks: |p|² − (p·w)² = (r0 + k·(p·w))², p = o + t·d − tip, 0 ≤ p·w ≤ L (end caps ignored).
    let stickIdx = -1;
    let stickAlong = 0;
    for (let s = 0; s < nSticks; s++) {
      const o = s * 14;
      const px0 = ox - stk[o]!;
      const py0 = oy - stk[o + 1]!;
      const pz0 = oz - stk[o + 2]!;
      const wx = stk[o + 3]!;
      const wy = stk[o + 4]!;
      const wz = stk[o + 5]!;
      const L = stk[o + 6]!;
      const r0 = stk[o + 7]!;
      const kk = stk[o + 8]!;
      const dw = dx * wx + dy * wy + dz * wz;
      const pw = px0 * wx + py0 * wy + pz0 * wz;
      const dd = dx * dx + dy * dy + dz * dz;
      const pd = px0 * dx + py0 * dy + pz0 * dz;
      const pp = px0 * px0 + py0 * py0 + pz0 * pz0;
      // (pp + 2t·pd + t²dd) − (pw + t·dw)² − (r0 + k(pw + t·dw))² = 0
      const qa = dd - dw * dw - kk * kk * dw * dw;
      const qb = 2 * (pd - pw * dw - (r0 + kk * pw) * kk * dw);
      const qc = pp - pw * pw - (r0 + kk * pw) * (r0 + kk * pw);
      const disc = qb * qb - 4 * qa * qc;
      if (disc < 0 || Math.abs(qa) < 1e-12) continue;
      const sq = Math.sqrt(disc);
      const t1 = Math.min((-qb - sq) / (2 * qa), (-qb + sq) / (2 * qa));
      const t2 = Math.max((-qb - sq) / (2 * qa), (-qb + sq) / (2 * qa));
      for (let root = 0; root < 2; root++) {
        const t = root === 0 ? t1 : t2;
        const along = pw + t * dw;
        if (t > 1e-6 && t < tBest && along >= 0 && along <= L) {
          tBest = t;
          hitKind = 6;
          stickIdx = s;
          stickAlong = along;
          break;
        }
      }
    }
    // Boxes (slab method), record the entering face: axis index and sign.
    let boxAxis = 2;
    let boxSign = 1;
    let boxIsRail = 1;
    dArr[0] = dx;
    dArr[1] = dy;
    dArr[2] = dz;
    for (let k = 0; k < nBoxes; k++) {
      let t0 = -Infinity;
      let t1 = Infinity;
      let enterAxis = -1;
      let enterSign = 0;
      let ok = true;
      for (let ax = 0; ax < 3; ax++) {
        const inv = 1 / dArr[ax]!;
        let ta = (bMin[k * 3 + ax]! - oArr[ax]!) * inv;
        let tb = (bMax[k * 3 + ax]! - oArr[ax]!) * inv;
        let sign = -1;
        if (ta > tb) {
          const tmp = ta;
          ta = tb;
          tb = tmp;
          sign = 1;
        }
        if (ta > t0) {
          t0 = ta;
          enterAxis = ax;
          enterSign = sign;
        }
        if (tb < t1) t1 = tb;
        if (t0 > t1) {
          ok = false;
          break;
        }
      }
      if (!ok || t0 <= 1e-6 || t0 >= tBest) continue;
      if (inHole(ox + dx * t0, oy + dy * t0)) continue;
      tBest = t0;
      hitKind = 3;
      boxAxis = enterAxis;
      boxSign = enterSign;
      boxIsRail = bRail[k]!;
    }
    // Bed plane z = 0.
    if (dz < 0) {
      const t = -oz / dz;
      if (t > 0 && t < tBest) {
        const x = ox + dx * t;
        const y = oy + dy * t;
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
      const tf = (-0.78 - oz) / dz;
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
    const px = ox + dx * tBest;
    const py = oy + dy * tBest;
    const pz = oz + dz * tBest;
    const lx0 = light.x - px;
    const ly0 = light.y - py;
    const lz0 = light.z - pz;
    const ll = Math.hypot(lx0, ly0, lz0);
    const lx = lx0 / ll;
    const ly = ly0 / ll;
    const lz = lz0 / ll;
    if (hitKind === 1) {
      const b = scene.balls[ballIdx]!;
      const nx0 = px - ballX[ballIdx]!;
      const ny0 = py - ballY[ballIdx]!;
      const nz0 = pz - R;
      const nl = Math.hypot(nx0, ny0, nz0);
      const nx = nx0 / nl;
      const ny = ny0 / nl;
      const nz = nz0 / nl;
      let base = b.color;
      if (b.stripe && Math.abs(nx * axX[ballIdx]! + ny * axY[ballIdx]! + nz * axZ[ballIdx]!) > 0.45) base = BALL_COLORS.cue!;
      const dn = nx * lx + ny * ly + nz * lz;
      const lam = Math.max(0, dn);
      const rx = 2 * dn * nx - lx;
      const ry = 2 * dn * ny - ly;
      const rz = 2 * dn * nz - lz;
      const spec = Math.pow(Math.max(0, -(rx * dx + ry * dy + rz * dz)), 40) * 0.6;
      const k = 0.35 + 0.7 * lam;
      col[0] = base[0] * k + 255 * spec;
      col[1] = base[1] * k + 255 * spec;
      col[2] = base[2] * k + 255 * spec;
      return;
    }
    if (hitKind === 6) {
      // Stick: Lambert shading only. Outward normal ∝ p − (a + r(a)·k)·w.
      const o = stickIdx * 14;
      const kk = stk[o + 8]!;
      const rr = stk[o + 7]! + kk * stickAlong;
      const qx = px - stk[o]! - (stickAlong + rr * kk) * stk[o + 3]!;
      const qy = py - stk[o + 1]! - (stickAlong + rr * kk) * stk[o + 4]!;
      const qz = pz - stk[o + 2]! - (stickAlong + rr * kk) * stk[o + 5]!;
      const nl = Math.hypot(qx, qy, qz) || 1;
      const dn = (qx * lx + qy * ly + qz * lz) / nl;
      const k = 0.35 + 0.7 * Math.max(0, dn);
      const ferrule = stickAlong < stk[o + 9]!;
      col[0] = (ferrule ? 235 : stk[o + 10]!) * k;
      col[1] = (ferrule ? 232 : stk[o + 11]!) * k;
      col[2] = (ferrule ? 220 : stk[o + 12]!) * k;
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
    for (let i = 0; i < nBalls; i++) {
      const sx = px - ballX[i]!;
      const sy = py - ballY[i]!;
      const sz = pz - R;
      const bb = sx * lx + sy * ly + sz * lz;
      const cc = sx * sx + sy * sy + sz * sz - R * R;
      if (bb < 0 && bb * bb - cc > 0) {
        shadow = 0.55;
        break;
      }
    }
    // Lambert term against the bed normal (0,0,1) or the entered box face (an axis vector).
    const nzc = hitKind === 2 ? 1 : boxAxis === 2 ? boxSign : 0;
    const dotL = hitKind === 2 ? lz : boxSign * (boxAxis === 0 ? lx : boxAxis === 1 ? ly : lz);
    const lam = Math.max(0, dotL);
    let base: RGB = cloth;
    let k = (0.45 + 0.6 * lam) * shadow;
    if (hitKind === 3) {
      if (boxIsRail) base = rail;
      else if (nzc < 0.5) k *= 0.7; // cushion nose face
      else k *= 0.92; // cushion top
    }
    const nn = 1 + noise * (hash(Math.round(px * 2000), Math.round(py * 2000)) - 0.5) * 2;
    col[0] = base[0] * k * nn;
    col[1] = base[1] * k * nn;
    col[2] = base[2] * k * nn;
  };

  const cx = width / 2;
  const cy = height / 2;
  const data = frame.data;
  const r0x = Rm[0].x;
  const r0y = Rm[0].y;
  const r0z = Rm[0].z;
  const r1x = Rm[1].x;
  const r1y = Rm[1].y;
  const r1z = Rm[1].z;
  const r2x = Rm[2].x;
  const r2y = Rm[2].y;
  const r2z = Rm[2].z;
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
          const ex = r0x * xc + r1x * yc + r2x;
          const ey = r0y * xc + r1y * yc + r2y;
          const ez = r0z * xc + r1z * yc + r2z;
          const el = Math.hypot(ex, ey, ez);
          shade(ex / el, ey / el, ez / el);
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
