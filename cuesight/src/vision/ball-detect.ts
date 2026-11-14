/**
 * Ball detection (research.md R-04):
 *  1. Rectify the image through H_R, the homography of the plane at ball-centre height. A ball's
 *     silhouette then projects to a blob centred on its true (X, Y), elongated by ≈1/sin(elevation)
 *     toward the camera (parallax corrected to first order).
 *  2. Mark non-cloth pixels, find connected blobs, estimate how many balls each blob holds from its
 *     area vs the expected single-ball area at that spot, split multi-ball blobs with k-means.
 *  3. Classify colour (cue ball = most white, least saturated).
 */
import type { TableSpec } from '../core/types';
import type { Vec2 } from '../core/vec';
import type { Calibration } from './calibration';
import { applyH } from './homography';
import { rgbToHsv, sampleRgb, type Frame } from './image';
import { isCloth, type ClothModel } from './table-detect';

export interface DetectedBall {
  /** Table coordinates (m) of the ball centre. */
  pos: Vec2;
  /** Image position (px) of the ball centre. */
  image: Vec2;
  isCue: boolean;
  score: number;
  rgb: [number, number, number];
  label: string;
  /** Cue-ball likelihood score (diagnostic). */
  white: number;
  /** Pixel count of the ball's blob in the rectified image. */
  px: number;
}

function meanSat(r: number, g: number, b: number): number {
  const mx = Math.max(r, g, b);
  return mx > 0 ? (mx - Math.min(r, g, b)) / mx : 0;
}

export interface BallDetectOptions {
  /** Rectified pixels per metre (auto when omitted). */
  scale?: number;
}

export interface Rectified {
  w: number;
  h: number;
  scale: number;
  x0: number;
  y0: number;
  rgb: Float32Array;
  nonCloth: Uint8Array;
}

const HUE_NAMES: [number, string][] = [
  [8, 'red'],
  [38, 'orange'],
  [70, 'yellow'],
  [170, 'green'],
  [255, 'blue'],
  [320, 'purple'],
  [360, 'red'],
];

function colourName(h: number, s: number, v: number): string {
  if (v < 0.22) return 'black';
  if (s < 0.25) return 'white';
  if (h < 20 && v < 0.6) return 'maroon';
  for (const [lim, name] of HUE_NAMES) if (h < lim) return name;
  return 'red';
}

export function rectify(frame: Frame, calib: Calibration, table: TableSpec, cloth: ClothModel, opts: BallDetectOptions = {}): Rectified {
  const R = table.ballRadius;
  const margin = R;
  const hx = table.length / 2 + margin;
  const hy = table.width / 2 + margin;
  let scale = opts.scale ?? 0;
  if (!scale) {
    // Match the densest image sampling of any table side (near rails are the densest).
    const a = applyH(calib.HR, -hx, -hy);
    const b = applyH(calib.HR, hx, -hy);
    const c = applyH(calib.HR, hx, hy);
    const d = applyH(calib.HR, -hx, hy);
    const dd = (p: Vec2, q: Vec2) => Math.hypot(p.x - q.x, p.y - q.y);
    const px = Math.max(dd(a, b) / (2 * hx), dd(d, c) / (2 * hx), dd(b, c) / (2 * hy), dd(a, d) / (2 * hy));
    scale = Math.max(150, Math.min(320, px));
  }
  const w = Math.round(2 * hx * scale);
  const h = Math.round(2 * hy * scale);
  const rgb = new Float32Array(w * h * 3);
  const nonCloth = new Uint8Array(w * h);
  const H = calib.HR;
  const tmp = [0, 0, 0];
  const hsv = [0, 0, 0];
  // Pocket throats: ignore dark pixels at or beyond each pocket's mouth line. Bed features seen through
  // the z = R plane appear shifted toward the camera by R·cot(elevation), so far pockets intrude
  // further into the rectified table; extend the mask by that shift where it points inward.
  const cam = calib.camera;
  const throats = table.pockets.map((p) => {
    const dx = cam.x - p.mouthCenter.x;
    const dy = cam.y - p.mouthCenter.y;
    const dh = Math.hypot(dx, dy) || 1;
    const shift = (R * dh) / Math.max(0.2, cam.z - R);
    const toward = Math.max(0, (dx / dh) * p.inward.x + (dy / dh) * p.inward.y);
    return {
      cx: p.mouthCenter.x,
      cy: p.mouthCenter.y,
      nx: p.inward.x,
      ny: p.inward.y,
      depth: 0.5 * R + shift * toward,
      half: (p.kind === 'corner' ? table.cornerMouth : table.sideMouth) / 2 + R,
    };
  });
  const inThroat = (X: number, Y: number) => {
    for (const q of throats) {
      const s = (X - q.cx) * q.nx + (Y - q.cy) * q.ny;
      const t = Math.abs(-(X - q.cx) * q.ny + (Y - q.cy) * q.nx);
      if (s < q.depth && t < q.half + 0.5 * (q.depth - s)) return true;
    }
    return false;
  };
  for (let j = 0; j < h; j++) {
    const Y = hy - (j + 0.5) / scale; // row 0 = +y (far side when viewed from the −y rail)
    for (let i = 0; i < w; i++) {
      const X = -hx + (i + 0.5) / scale;
      const ww = H[6]! * X + H[7]! * Y + H[8]!;
      const u = (H[0]! * X + H[1]! * Y + H[2]!) / ww;
      const v = (H[3]! * X + H[4]! * Y + H[5]!) / ww;
      const k = j * w + i;
      // Pixel (x, y) covers [x, x+1): its value sits at the pixel centre (x + ½, y + ½).
      if (!sampleRgb(frame, u - 0.5, v - 0.5, tmp)) continue;
      rgb[k * 3] = tmp[0]!;
      rgb[k * 3 + 1] = tmp[1]!;
      rgb[k * 3 + 2] = tmp[2]!;
      rgbToHsv(tmp[0]!, tmp[1]!, tmp[2]!, hsv);
      let nc = isCloth(hsv[0]!, hsv[1]!, hsv[2]!, cloth) ? 0 : 1;
      if (nc && inThroat(X, Y)) nc = 0;
      nonCloth[k] = nc;
    }
  }
  return { w, h, scale, x0: -hx, y0: hy, rgb, nonCloth };
}

export function detectBalls(frame: Frame, calib: Calibration, table: TableSpec, cloth: ClothModel, opts: BallDetectOptions = {}): DetectedBall[] {
  const R = table.ballRadius;
  const rect = rectify(frame, calib, table, cloth, opts);
  const { w, h, scale, nonCloth, rgb } = rect;
  const rp = R * scale;
  const toTable = (i: number, j: number): Vec2 => ({ x: rect.x0 + (i + 0.5) / scale, y: rect.y0 - (j + 0.5) / scale });

  // Light morphological opening (3×3 erosion then dilation) to drop specks.
  const er = new Uint8Array(w * h);
  for (let j = 1; j < h - 1; j++)
    for (let i = 1; i < w - 1; i++) {
      const k = j * w + i;
      er[k] = nonCloth[k]! & nonCloth[k - 1]! & nonCloth[k + 1]! & nonCloth[k - w]! & nonCloth[k + w]!;
    }
  const mask = new Uint8Array(w * h);
  for (let j = 1; j < h - 1; j++)
    for (let i = 1; i < w - 1; i++) {
      const k = j * w + i;
      mask[k] = er[k]! | er[k - 1]! | er[k + 1]! | er[k - w]! | er[k + w]!;
    }

  // Connected components.
  const label = new Int32Array(w * h);
  const queue = new Int32Array(w * h);
  const balls: DetectedBall[] = [];
  const cam = calib.camera;
  let next = 1;
  for (let s = 0; s < w * h; s++) {
    if (!mask[s] || label[s]) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = s;
    label[s] = next;
    let minI = w;
    let maxI = 0;
    let minJ = h;
    let maxJ = 0;
    while (head < tail) {
      const k = queue[head++]!;
      const i = k % w;
      const j = (k - i) / w;
      if (i < minI) minI = i;
      if (i > maxI) maxI = i;
      if (j < minJ) minJ = j;
      if (j > maxJ) maxJ = j;
      for (const nb of [k - 1, k + 1, k - w, k + w]) {
        if (nb < 0 || nb >= w * h) continue;
        if ((nb === k - 1 && i === 0) || (nb === k + 1 && i === w - 1)) continue;
        if (mask[nb] && !label[nb]) {
          label[nb] = next;
          queue[tail++] = nb;
        }
      }
    }
    const area = tail;
    const comp = next++;
    if (area < Math.PI * rp * rp * 0.3) continue;
    // Expected single-ball blob area at this spot: πR² / sin(elevation).
    let ci = 0;
    let cj = 0;
    for (let q = 0; q < tail; q++) {
      const k = queue[q]!;
      ci += k % w;
      cj += Math.floor(k / w);
    }
    ci /= tail;
    cj /= tail;
    const c = toTable(ci, cj);
    const dh = Math.hypot(cam.x - c.x, cam.y - c.y);
    const hz = Math.max(0.2, cam.z - R);
    const sinEl = hz / Math.hypot(dh, hz);
    const a1 = (Math.PI * rp * rp) / sinEl;
    const bw = maxI - minI + 1;
    const bh = maxJ - minJ + 1;
    const elong = Math.max(bw, bh) / Math.max(1, Math.min(bw, bh));
    let k = Math.max(1, Math.round(area / a1 + 0.1));
    if (k > 16) continue;
    if (k >= 3 && elong > 6) continue; // a rail band / cue stick, not balls
    if (k === 1 && area > a1 * 1.9) k = 2;

    // Pixels of this component.
    const px = new Float64Array(tail * 2);
    for (let q = 0; q < tail; q++) {
      const kk = queue[q]!;
      px[q * 2] = kk % w;
      px[q * 2 + 1] = Math.floor(kk / w);
    }
    let centres = kmeans(px, tail, k);
    // Two real balls can't be closer than 2R: merge over-splits (e.g. chroma bleed in 4:2:0 video).
    while (k >= 2) {
      let close = false;
      for (let a = 0; a < k && !close; a++)
        for (let b = a + 1; b < k; b++)
          if (Math.hypot(centres[a * 2]! - centres[b * 2]!, centres[a * 2 + 1]! - centres[b * 2 + 1]!) < 1.7 * rp) {
            close = true;
            break;
          }
      if (!close) break;
      k--;
      centres = kmeans(px, tail, k);
    }
    const assign = new Int32Array(tail);
    for (let q = 0; q < tail; q++) {
      let best = 0;
      let bd = Infinity;
      for (let m = 0; m < k; m++) {
        const d = (px[q * 2]! - centres[m * 2]!) ** 2 + (px[q * 2 + 1]! - centres[m * 2 + 1]!) ** 2;
        if (d < bd) {
          bd = d;
          best = m;
        }
      }
      assign[q] = best;
    }
    // Occlusion-aware centres for multi-ball blobs: along the viewing direction, the nearest ball's
    // near edge and the farthest ball's far edge are true silhouette boundaries; centre = edge ∓ the
    // expected semi-major axis R/sin(elevation).
    if (k >= 2) {
      let ax = c.x - cam.x;
      let ay = c.y - cam.y;
      const al = Math.hypot(ax, ay) || 1;
      ax /= al;
      ay = -ay / al; // rectified j axis points to −y
      const semi = rp / sinEl;
      const along = (m: number) => centres[m * 2]! * ax + centres[m * 2 + 1]! * ay;
      let nearest = 0;
      let farthest = 0;
      for (let m = 1; m < k; m++) {
        if (along(m) < along(nearest)) nearest = m;
        if (along(m) > along(farthest)) farthest = m;
      }
      for (const [m, useFar] of [
        [nearest, false],
        [farthest, true],
      ] as const) {
        const proj: number[] = [];
        for (let q = 0; q < tail; q++) {
          if (assign[q] !== m) continue;
          proj.push((px[q * 2]! + 0.5) * ax + (px[q * 2 + 1]! + 0.5) * ay);
        }
        if (proj.length < 8) continue;
        proj.sort((a, b) => a - b);
        const edge = useFar ? proj[Math.floor(proj.length * 0.985)]! : proj[Math.floor(proj.length * 0.015)]!;
        const target = useFar ? edge - semi : edge + semi;
        const shift = target - (along(m) + 0.5 * (ax + ay));
        centres[m * 2] = centres[m * 2]! + shift * ax;
        centres[m * 2 + 1] = centres[m * 2 + 1]! + shift * ay;
      }
    }
    for (let m = 0; m < k; m++) {
      let n = 0;
      let satSum = 0;
      let r = 0;
      let g = 0;
      let b = 0;
      let white = 0;
      let colored = 0;
      let hsx = 0;
      let hsy = 0;
      let vSum = 0;
      const hsv = [0, 0, 0];
      for (let q = 0; q < tail; q++) {
        if (assign[q] !== m) continue;
        const kk = queue[q]!;
        const R0 = rgb[kk * 3]!;
        const G0 = rgb[kk * 3 + 1]!;
        const B0 = rgb[kk * 3 + 2]!;
        r += R0;
        g += G0;
        b += B0;
        rgbToHsv(R0, G0, B0, hsv);
        vSum += hsv[2]!;
        satSum += hsv[1]!;
        if (hsv[1]! < 0.25 && hsv[2]! > 0.55) white++;
        if (hsv[1]! > 0.4 && hsv[2]! > 0.12) {
          colored++;
          const a = (hsv[0]! * Math.PI) / 180;
          hsx += Math.cos(a);
          hsy += Math.sin(a);
        }
        n++;
      }
      if (n < Math.PI * rp * rp * 0.25) continue;
      const pos = toTable(centres[m * 2]!, centres[m * 2 + 1]!);
      if (Math.abs(pos.x) > table.length / 2 || Math.abs(pos.y) > table.width / 2) continue;
      pos.x = Math.max(-(table.length / 2 - R), Math.min(table.length / 2 - R, pos.x));
      pos.y = Math.max(-(table.width / 2 - R), Math.min(table.width / 2 - R, pos.y));
      void hsx;
      void hsy;
      // Name from the MEAN colour (robust to chroma subsampling); stripes show lots of white too.
      const mr = r / n;
      const mg = g / n;
      const mb = b / n;
      const mhsv = [0, 0, 0];
      rgbToHsv(mr, mg, mb, mhsv);
      const whiteFrac = white / n;
      const colFrac = colored / n;
      const ms = mhsv[1]!;
      const base = vSum / n < 0.25 ? 'black' : ms < 0.12 ? 'white' : colourName(mhsv[0]!, 0.6, Math.max(0.3, mhsv[2]!));
      const label = base !== 'white' && base !== 'black' && whiteFrac > 0.25 ? `${base} stripe` : base;
      balls.push({
        pos,
        image: applyH(calib.HR, pos.x, pos.y),
        isCue: false,
        score: Math.min(1, n / a1),
        rgb: [r / n, g / n, b / n],
        label,
        // Cue-ball likelihood: lots of white, almost no saturated pixels, and a neutral MEAN colour
        // (the saturation of the mean RGB survives video chroma subsampling, unlike per-pixel S).
        white: whiteFrac - 2.5 * colFrac - 2 * meanSat(r / n, g / n, b / n) - 0.25 * (satSum / n),
        px: n,
      });
    }
    void comp;
  }
  // De-duplicate: two real balls can't be closer than ~2R (a blob cut in two by the opening, or
  // chroma bleed). Keep the larger piece, nudged toward the pixel-weighted mean.
  balls.sort((a, b) => b.px - a.px);
  for (let i = 0; i < balls.length; i++)
    for (let j = balls.length - 1; j > i; j--) {
      const a = balls[i]!;
      const b = balls[j]!;
      if (Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y) < 1.7 * R) {
        const w = a.px + b.px;
        a.pos = { x: (a.pos.x * a.px + b.pos.x * b.px) / w, y: (a.pos.y * a.px + b.pos.y * b.px) / w };
        a.image = applyH(calib.HR, a.pos.x, a.pos.y);
        a.px = w;
        balls.splice(j, 1);
      }
    }
  // Cue ball: the whitest, least coloured ball.
  let cue = -1;
  for (let i = 0; i < balls.length; i++) if (balls[i]!.white > 0.0 && (cue < 0 || balls[i]!.white > balls[cue]!.white)) cue = i;
  if (cue >= 0) {
    balls[cue]!.isCue = true;
    balls[cue]!.label = 'cue';
  }
  for (const b of balls) if (!b.isCue && b.label === 'white') b.label = 'white?';
  return balls;
}

/** Plain k-means on 2D points with farthest-point initialisation (deterministic). */
function kmeans(px: Float64Array, n: number, k: number): Float64Array {
  const c = new Float64Array(k * 2);
  // Init: first = point farthest from the mean; then farthest from chosen.
  let mx = 0;
  let my = 0;
  for (let q = 0; q < n; q++) {
    mx += px[q * 2]!;
    my += px[q * 2 + 1]!;
  }
  mx /= n;
  my /= n;
  if (k === 1) {
    c[0] = mx;
    c[1] = my;
    return c;
  }
  const dmin = new Float64Array(n).fill(Infinity);
  let pick = 0;
  let far = -1;
  for (let q = 0; q < n; q++) {
    const d = (px[q * 2]! - mx) ** 2 + (px[q * 2 + 1]! - my) ** 2;
    if (d > far) {
      far = d;
      pick = q;
    }
  }
  for (let m = 0; m < k; m++) {
    c[m * 2] = px[pick * 2]!;
    c[m * 2 + 1] = px[pick * 2 + 1]!;
    far = -1;
    for (let q = 0; q < n; q++) {
      const d = (px[q * 2]! - c[m * 2]!) ** 2 + (px[q * 2 + 1]! - c[m * 2 + 1]!) ** 2;
      if (d < dmin[q]!) dmin[q] = d;
      if (dmin[q]! > far) {
        far = dmin[q]!;
        pick = q;
      }
    }
  }
  const sx = new Float64Array(k);
  const sy = new Float64Array(k);
  const cnt = new Float64Array(k);
  for (let it = 0; it < 12; it++) {
    sx.fill(0);
    sy.fill(0);
    cnt.fill(0);
    for (let q = 0; q < n; q++) {
      let best = 0;
      let bd = Infinity;
      for (let m = 0; m < k; m++) {
        const d = (px[q * 2]! - c[m * 2]!) ** 2 + (px[q * 2 + 1]! - c[m * 2 + 1]!) ** 2;
        if (d < bd) {
          bd = d;
          best = m;
        }
      }
      sx[best]! += px[q * 2]!;
      sy[best]! += px[q * 2 + 1]!;
      cnt[best]! += 1;
    }
    for (let m = 0; m < k; m++)
      if (cnt[m]! > 0) {
        c[m * 2] = sx[m]! / cnt[m]!;
        c[m * 2 + 1] = sy[m]! / cnt[m]!;
      }
  }
  return c;
}
