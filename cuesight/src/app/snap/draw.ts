/**
 * Canvas drawing for Snap: the photo itself (object-fit: contain), the player guide in perspective
 * (FR-117), the magnified cue-ball inset and the manual-tap markers. Plan colours and line styles are
 * the 001 Okabe–Ito encoding (aim solid blue, object-ball path solid orange, cue-ball path dashed sky,
 * ghost ball dotted white), each with a dark halo so it reads on any cloth, and every mark has a label.
 */
import type { Vec2 } from '../../core/types';
import { DASH, PALETTE, UI } from '../render/palette';
import { containMapping, type FrameMapping } from '../render/overlay';
import type { PlayerGuide } from './guide';
import type { Photo } from './photo';

const FONT = `-apple-system, 'SF Pro Text', system-ui, 'Segoe UI', Roboto, sans-serif`;

/** A canvas that shows one photo scaled to fit its CSS box, plus an overlay drawn in photo px. */
export class PhotoCanvas {
  readonly ctx: CanvasRenderingContext2D;
  photo: Photo | null = null;
  map: FrameMapping = containMapping(1, 1, 1, 1);
  private w = 1;
  private h = 1;
  constructor(readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
  }

  /** Redraws the photo (dimmed if asked) and then `overlay` in CSS px via `this.map`. */
  draw(overlay?: (ctx: CanvasRenderingContext2D, map: FrameMapping, cssW: number, cssH: number) => void, dim = 0): void {
    const r = this.canvas.getBoundingClientRect();
    const dpr = Math.min(3, globalThis.devicePixelRatio || 1);
    this.w = Math.max(1, Math.round(r.width));
    this.h = Math.max(1, Math.round(r.height));
    const bw = Math.round(this.w * dpr);
    const bh = Math.round(this.h * dpr);
    if (this.canvas.width !== bw) this.canvas.width = bw;
    if (this.canvas.height !== bh) this.canvas.height = bh;
    const c = this.ctx;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, this.w, this.h);
    const p = this.photo;
    if (!p) return;
    this.map = containMapping(p.width, p.height, this.w, this.h);
    const o = this.map.toScreen({ x: 0, y: 0 });
    const e = this.map.toScreen({ x: p.width, y: p.height });
    c.save();
    c.imageSmoothingQuality = 'high';
    roundRect(c, o.x, o.y, e.x - o.x, e.y - o.y, 14);
    c.clip();
    c.drawImage(p.canvas, o.x, o.y, e.x - o.x, e.y - o.y);
    if (dim > 0) {
      c.fillStyle = `rgba(7,11,20,${dim})`;
      c.fillRect(o.x, o.y, e.x - o.x, e.y - o.y);
    }
    c.restore();
    if (overlay) {
      c.save();
      overlay(c, this.map, this.w, this.h);
      c.restore();
    }
  }

  /** Client px → photo px (null outside the photo). */
  toPhoto(clientX: number, clientY: number): Vec2 | null {
    if (!this.photo) return null;
    const r = this.canvas.getBoundingClientRect();
    const q = this.map.toFrame({ x: clientX - r.left, y: clientY - r.top });
    if (q.x < 0 || q.y < 0 || q.x > this.photo.width || q.y > this.photo.height) return null;
    return q;
  }

  /** Photo px → client px (page coordinates, for tests and pointers). */
  toClient(p: Vec2): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    const q = this.map.toScreen(p);
    return { x: r.left + q.x, y: r.top + q.y };
  }

  /** The photo's rectangle inside the canvas (CSS px, canvas-relative). */
  photoRect(): { x: number; y: number; w: number; h: number } | null {
    if (!this.photo) return null;
    const o = this.map.toScreen({ x: 0, y: 0 });
    const e = this.map.toScreen({ x: this.photo.width, y: this.photo.height });
    return { x: o.x, y: o.y, w: e.x - o.x, h: e.y - o.y };
  }
}

function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  c.beginPath();
  c.moveTo(x + rr, y);
  c.arcTo(x + w, y, x + w, y + h, rr);
  c.arcTo(x + w, y + h, x, y + h, rr);
  c.arcTo(x, y + h, x, y, rr);
  c.arcTo(x, y, x + w, y, rr);
  c.closePath();
}

// -------------------------------------------------------------------------------------------------
// Primitives
// -------------------------------------------------------------------------------------------------
function path(c: CanvasRenderingContext2D, pts: Vec2[], close = false): void {
  c.beginPath();
  pts.forEach((q, i) => (i ? c.lineTo(q.x, q.y) : c.moveTo(q.x, q.y)));
  if (close) c.closePath();
}

/** A polyline with a dark halo underneath and a soft glow in its colour (the 001 overlay look). */
export function glowLine(c: CanvasRenderingContext2D, pts: Vec2[], color: string, width: number, dash: number[] = [], glow = 8, close = false): void {
  if (pts.length < 2) return;
  c.save();
  c.lineCap = 'round';
  c.lineJoin = 'round';
  path(c, pts, close);
  c.strokeStyle = UI.haloStrong;
  c.lineWidth = width + 4;
  c.globalAlpha = 0.75;
  c.stroke();
  c.globalAlpha = 1;
  c.setLineDash(dash);
  if (glow) {
    c.shadowColor = color;
    c.shadowBlur = glow;
  }
  c.strokeStyle = color;
  c.lineWidth = width;
  c.stroke();
  c.restore();
}

export function label(c: CanvasRenderingContext2D, text: string, q: Vec2, color: string = UI.text, size = 13, align: CanvasTextAlign = 'left'): void {
  c.save();
  c.font = `650 ${size}px ${FONT}`;
  c.textBaseline = 'middle';
  c.textAlign = align;
  // Keep the label inside the canvas (CSS px; the context is scaled by the device pixel ratio).
  const t = c.getTransform();
  const W = c.canvas.width / (t.a || 1);
  const Hh = c.canvas.height / (t.d || 1);
  const w = c.measureText(text).width;
  const x0 = align === 'center' ? q.x - w / 2 : align === 'right' || align === 'end' ? q.x - w : q.x;
  const dx = Math.min(0, W - 6 - (x0 + w)) + Math.max(0, 6 - x0);
  q = { x: q.x + dx, y: Math.max(size, Math.min(Hh - size, q.y)) };
  c.lineJoin = 'round';
  c.strokeStyle = UI.haloStrong;
  c.lineWidth = 4.5;
  c.strokeText(text, q.x, q.y);
  c.fillStyle = color;
  c.fillText(text, q.x, q.y);
  c.restore();
}

/** Arrow head at the end of a polyline (screen px). */
function chevron(c: CanvasRenderingContext2D, pts: Vec2[], color: string, size = 11): void {
  if (pts.length < 2) return;
  const b = pts[pts.length - 1]!;
  let a = pts[pts.length - 2]!;
  for (let i = pts.length - 2; i >= 0 && Math.hypot(b.x - a.x, b.y - a.y) < size; i--) a = pts[i]!;
  const L = Math.hypot(b.x - a.x, b.y - a.y);
  if (L < 1) return;
  const ux = (b.x - a.x) / L;
  const uy = (b.y - a.y) / L;
  const p1 = { x: b.x - ux * size - uy * size * 0.6, y: b.y - uy * size + ux * size * 0.6 };
  const p2 = { x: b.x - ux * size + uy * size * 0.6, y: b.y - uy * size - ux * size * 0.6 };
  glowLine(c, [p1, b, p2], color, 3, [], 6);
}

const mapRuns = (runs: Vec2[][], m: FrameMapping) => runs.map((r) => r.map((p) => m.toScreen(p)));
const mapPts = (pts: Vec2[], m: FrameMapping) => pts.map((p) => m.toScreen(p));

function centre(pts: Vec2[]): Vec2 {
  let x = 0;
  let y = 0;
  for (const p of pts) {
    x += p.x;
    y += p.y;
  }
  return { x: x / pts.length, y: y / pts.length };
}

function meanRadius(pts: Vec2[], c: Vec2): number {
  return pts.reduce((a, p) => a + Math.hypot(p.x - c.x, p.y - c.y), 0) / Math.max(1, pts.length);
}

// -------------------------------------------------------------------------------------------------
// The guide on the player photo
// -------------------------------------------------------------------------------------------------
export interface GuideStyle {
  showCuePath: boolean;
  /** Scale for line widths (the inset draws bolder). */
  weight?: number;
  labels?: boolean;
  makeable?: boolean;
  /**
   * The photo's rectangle on the canvas (CSS px). Line work is clipped to it so lines that run out
   * of the photo (the cue's line toward the player, paths off the edge) stop at the photo's edge
   * instead of continuing over the letterbox; labels stay unclipped so they remain readable.
   */
  clip?: { x: number; y: number; w: number; h: number } | null;
}

export function drawGuide(c: CanvasRenderingContext2D, m: FrameMapping, g: PlayerGuide, st: GuideStyle): void {
  const k = st.weight ?? 1;
  const labels = st.labels ?? true;
  c.save();
  if (st.clip) {
    roundRect(c, st.clip.x, st.clip.y, st.clip.w, st.clip.h, 14);
    c.clip();
  }
  let ghostLabel: Vec2 | null = null;
  // Pocket ring (target yellow) + object-ball path into it.
  for (const run of mapRuns(g.pocket, m)) glowLine(c, run, PALETTE.target, 3 * k, [], 14);
  const ob = mapRuns(g.objectPath, m);
  for (const run of ob) glowLine(c, run, PALETTE.object, 4 * k, DASH.object, 8);
  if (ob.length) chevron(c, ob[ob.length - 1]!, PALETTE.object, 12 * k);
  if (st.showCuePath) for (const run of mapRuns(g.cuePath, m)) glowLine(c, run, PALETTE.cue, 2.5 * k, DASH.cue, 6);
  // The cue's line toward the player (faint), then the aim line on the cloth.
  for (const run of mapRuns(g.cueAxis, m)) glowLine(c, run, 'rgba(244,246,251,0.55)', 2 * k, [2, 7], 0);
  const aimColor = st.makeable === false ? PALETTE.warn : PALETTE.aim;
  for (const run of mapRuns(g.aim, m)) glowLine(c, run, aimColor, 5 * k, DASH.aim, 12);
  // Target ball ring.
  if (g.target.length) glowLine(c, mapPts(g.target, m), PALETTE.target, 2.5 * k, [], 10, true);
  // Ghost ball: translucent sphere + dotted white ring.
  if (g.ghost.length) {
    const pts = mapPts(g.ghost, m);
    const q = centre(pts);
    const r = meanRadius(pts, q);
    c.save();
    const fill = c.createRadialGradient(q.x - r * 0.35, q.y - r * 0.4, r * 0.05, q.x, q.y, r * 1.05);
    fill.addColorStop(0, 'rgba(255,255,255,0.55)');
    fill.addColorStop(0.7, 'rgba(255,255,255,0.16)');
    fill.addColorStop(1, 'rgba(255,255,255,0.04)');
    c.fillStyle = fill;
    path(c, pts, true);
    c.fill();
    c.restore();
    glowLine(c, pts, PALETTE.ghost, 2.5 * k, DASH.ghost, 6, true);
    ghostLabel = { x: q.x, y: q.y - r - 14 };
  }
  if (g.contact) {
    const q = m.toScreen(g.contact);
    c.save();
    c.fillStyle = PALETTE.warn;
    c.strokeStyle = '#FFFFFF';
    c.lineWidth = 1.5;
    c.beginPath();
    c.arc(q.x, q.y, 4 * Math.max(1, k * 0.8), 0, Math.PI * 2);
    c.fill();
    c.stroke();
    c.restore();
  }
  c.restore();
  if (labels && ghostLabel) label(c, 'Aim here', ghostLabel, UI.text, 13, 'center');
  drawStrike(c, m, g, k, labels);
}

/**
 * Cue-ball face: the miscue-limit ring, the strike dot (the tip's footprint, in perspective) with a
 * crosshair, and the ball's centre cross drawn over it so the offset from centre stays readable.
 */
export function drawStrike(c: CanvasRenderingContext2D, m: FrameMapping, g: PlayerGuide, k = 1, labels = true): void {
  if (g.cueBall.length) glowLine(c, mapPts(g.cueBall, m), 'rgba(255,255,255,0.9)', 1.5 * k, [], 0, true);
  for (const run of mapRuns(g.miscue, m)) glowLine(c, run, 'rgba(255,255,255,0.85)', 1.25 * k, [3, 3], 0);
  const s = g.strike;
  const showDot = !!s && s.visible;
  let q: Vec2 | null = null;
  let r = 0;
  if (showDot && s) {
    q = m.toScreen(s.p);
    const scale = Math.abs(m.toScreen({ x: 1, y: 0 }).x - m.toScreen({ x: 0, y: 0 }).x);
    r = Math.max(4.5 * k, s.r * scale);
    c.save();
    // Dark halo, blue tip footprint, white rim.
    c.beginPath();
    c.arc(q.x, q.y, r + 2.5 * k, 0, Math.PI * 2);
    c.fillStyle = 'rgba(7,11,20,0.55)';
    c.fill();
    c.beginPath();
    c.arc(q.x, q.y, r, 0, Math.PI * 2);
    c.fillStyle = 'rgba(0,114,178,0.92)';
    c.shadowColor = PALETTE.cue;
    c.shadowBlur = 10;
    c.fill();
    c.shadowBlur = 0;
    c.lineWidth = 2 * k;
    c.strokeStyle = '#FFFFFF';
    c.stroke();
    // Crosshair arms outside the dot.
    const arms: [number, number][] = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ];
    c.lineCap = 'round';
    for (const [dx, dy] of arms) {
      c.beginPath();
      c.moveTo(q.x + dx * (r + 3 * k), q.y + dy * (r + 3 * k));
      c.lineTo(q.x + dx * (r + 8 * k), q.y + dy * (r + 8 * k));
      c.strokeStyle = UI.haloStrong;
      c.lineWidth = 3.5 * k;
      c.stroke();
      c.strokeStyle = '#FFFFFF';
      c.lineWidth = 1.5 * k;
      c.stroke();
    }
    c.restore();
  }
  // The ball's centre cross (cue-axis centre), over the dot: the dot's offset from it is the spin.
  for (const run of mapRuns(g.cross, m)) glowLine(c, run, 'rgba(255,255,255,0.8)', 1 * k, [], 0);
  if (q) {
    c.save();
    c.beginPath();
    c.arc(q.x, q.y, 1.6 * k, 0, Math.PI * 2);
    c.fillStyle = '#FFFFFF';
    c.fill();
    c.restore();
    if (labels) label(c, 'Strike', { x: q.x + r + 12 * k, y: q.y }, UI.text, 13, 'left');
  }
}

/**
 * Magnified cue ball (FR-117): a square crop around the cue ball's silhouette, `zoom`× the photo
 * scale, with the face marks drawn bolder. Returns false when the cue ball is not in the photo.
 */
export function drawInset(canvas: HTMLCanvasElement, photo: Photo, g: PlayerGuide): boolean {
  const r = canvas.getBoundingClientRect();
  const dpr = Math.min(3, globalThis.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(r.width));
  const h = Math.max(1, Math.round(r.height));
  if (canvas.width !== Math.round(w * dpr)) canvas.width = Math.round(w * dpr);
  if (canvas.height !== Math.round(h * dpr)) canvas.height = Math.round(h * dpr);
  const c = canvas.getContext('2d')!;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, w, h);
  if (!g.cueCenter || !g.inFrame.cue || g.cueRadiusPx <= 0) return false;
  // Crop: 2.6 ball radii around the centre.
  const half = g.cueRadiusPx * 1.45;
  const s = Math.min(w, h) / (2 * half);
  const ox = w / 2 - g.cueCenter.x * s;
  const oy = h / 2 - g.cueCenter.y * s;
  const map: FrameMapping = { toScreen: (p) => ({ x: ox + p.x * s, y: oy + p.y * s }), toFrame: (p) => ({ x: (p.x - ox) / s, y: (p.y - oy) / s }) };
  c.save();
  c.imageSmoothingQuality = 'high';
  c.fillStyle = '#0b1220';
  c.fillRect(0, 0, w, h);
  c.drawImage(photo.canvas, ox, oy, photo.width * s, photo.height * s);
  c.restore();
  // Aim line start for direction context, then the face marks.
  for (const run of mapRuns(g.aim, map)) glowLine(c, run, PALETTE.aim, 3, [], 8);
  drawStrike(c, map, g, 1.6, false);
  return true;
}

/** Numbered tap markers for the manual fallback (cue ball, target ball). */
export function drawTaps(c: CanvasRenderingContext2D, m: FrameMapping, taps: { cue?: Vec2; target?: Vec2 }): void {
  const mark = (p: Vec2, text: string, color: string) => {
    const q = m.toScreen(p);
    c.save();
    c.beginPath();
    c.arc(q.x, q.y, 16, 0, Math.PI * 2);
    c.strokeStyle = UI.haloStrong;
    c.lineWidth = 6;
    c.stroke();
    c.strokeStyle = color;
    c.lineWidth = 3;
    c.shadowColor = color;
    c.shadowBlur = 10;
    c.stroke();
    c.restore();
    label(c, text, { x: q.x + 22, y: q.y }, UI.text, 13, 'left');
  };
  if (taps.cue) mark(taps.cue, 'Cue ball', '#FFFFFF');
  if (taps.target) mark(taps.target, 'Target', PALETTE.target);
}
