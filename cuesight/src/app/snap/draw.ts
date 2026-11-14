/**
 * Canvas drawing for Snap: the photo itself (object-fit: contain), the player guide in perspective
 * (FR-117), the magnified cue-ball inset and the manual-tap markers. Plan colours and line styles are
 * the 001 Okabe–Ito encoding (aim solid blue, object-ball path solid orange, cue-ball path dashed sky,
 * ghost ball dotted white), each with a dark halo so it reads on any cloth, and every mark has a label.
 */
import type { Vec2 } from '../../core/types';
import { DASH, PALETTE, UI } from '../render/palette';
import { containMapping, type FrameMapping } from '../render/overlay';
import { placeLabel, type Box, type Pt } from '../ui/label-place';
import type { PlayerGuide, StrikeFace } from './guide';
import type { Photo } from './photo';

/**
 * Photo → canvas mapping that zooms onto a region of interest (photo px) with `pad` of its size
 * around it: never smaller than the whole photo fitted (contain) and at most `maxZoom`× that; the
 * crop is kept inside the photo wherever the photo is larger than the canvas, so no letterbox shows
 * on that axis.
 */
export function focusMapping(fw: number, fh: number, w: number, h: number, roi: { x0: number; y0: number; x1: number; y1: number } | null, pad = 0.15, maxZoom = 4): FrameMapping & { scale: number } {
  const contain = Math.min(w / fw, h / fh);
  let s = contain;
  let cx = fw / 2;
  let cy = fh / 2;
  if (roi) {
    const bw = Math.max(1, roi.x1 - roi.x0);
    const bh = Math.max(1, roi.y1 - roi.y0);
    s = Math.min(w / (bw * (1 + 2 * pad)), h / (bh * (1 + 2 * pad)));
    s = Math.max(contain, Math.min(contain * maxZoom, s));
    cx = (roi.x0 + roi.x1) / 2;
    cy = (roi.y0 + roi.y1) / 2;
  }
  // Keep the crop inside the photo on each axis where the photo overflows the canvas.
  const clampC = (c: number, size: number, view: number) => {
    const half = view / (2 * s);
    return size * s <= view ? size / 2 : Math.max(half, Math.min(size - half, c));
  };
  cx = clampC(cx, fw, w);
  cy = clampC(cy, fh, h);
  const ox = w / 2 - cx * s;
  const oy = h / 2 - cy * s;
  return { scale: s, toScreen: (p) => ({ x: ox + p.x * s, y: oy + p.y * s }), toFrame: (p) => ({ x: (p.x - ox) / s, y: (p.y - oy) / s }) };
}

const FONT = `-apple-system, 'SF Pro Text', system-ui, 'Segoe UI', Roboto, sans-serif`;

/** A canvas that shows one photo scaled to fit its CSS box, plus an overlay drawn in photo px. */
export class PhotoCanvas {
  readonly ctx: CanvasRenderingContext2D;
  photo: Photo | null = null;
  /** Region of the photo to zoom onto (photo px), or null for the whole photo. */
  focus: { x0: number; y0: number; x1: number; y1: number } | null = null;
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
    this.map = this.focus ? focusMapping(p.width, p.height, this.w, this.h, this.focus) : containMapping(p.width, p.height, this.w, this.h);
    const o = this.map.toScreen({ x: 0, y: 0 });
    const e = this.map.toScreen({ x: p.width, y: p.height });
    c.save();
    c.imageSmoothingQuality = 'high';
    roundRect(c, Math.max(0, o.x), Math.max(0, o.y), Math.min(this.w, e.x) - Math.max(0, o.x), Math.min(this.h, e.y) - Math.max(0, o.y), 14);
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

  /** The visible part of the photo inside the canvas (CSS px, canvas-relative). */
  photoRect(): { x: number; y: number; w: number; h: number } | null {
    if (!this.photo) return null;
    const o = this.map.toScreen({ x: 0, y: 0 });
    const e = this.map.toScreen({ x: this.photo.width, y: this.photo.height });
    const x = Math.max(0, o.x);
    const y = Math.max(0, o.y);
    return { x, y, w: Math.min(this.w, e.x) - x, h: Math.min(this.h, e.y) - y };
  }
}

function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  // A zero or negative box (a transient layout) must not throw: arcTo rejects a negative radius.
  w = Math.max(0, w);
  h = Math.max(0, h);
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
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

/**
 * A glass pill label (Midnight Felt surface, 12 px radius, 13 px semibold) at `q` (its anchor
 * point per `align`), kept inside the canvas. Returns the pill's box (CSS px).
 */
export function label(c: CanvasRenderingContext2D, text: string, q: Vec2, color: string = UI.text, size = 13, align: CanvasTextAlign = 'left'): Box {
  c.save();
  c.font = `650 ${size}px ${FONT}`;
  c.textBaseline = 'middle';
  c.textAlign = 'left';
  const t = c.getTransform();
  const W = c.canvas.width / (t.a || 1);
  const Hh = c.canvas.height / (t.d || 1);
  const padX = 9;
  const h = size + 12;
  const w = c.measureText(text).width + padX * 2;
  let x0 = align === 'center' ? q.x - w / 2 : align === 'right' || align === 'end' ? q.x - w : q.x;
  let y0 = q.y - h / 2;
  x0 = Math.max(6, Math.min(W - 6 - w, x0));
  y0 = Math.max(6, Math.min(Hh - 6 - h, y0));
  pill(c, x0, y0, w, h);
  c.fillStyle = color;
  c.fillText(text, x0 + padX, y0 + h / 2 + 0.5);
  c.restore();
  return { left: x0, top: y0, right: x0 + w, bottom: y0 + h };
}

function pill(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  c.save();
  roundRect(c, x, y, w, h, 12);
  c.shadowColor = 'rgba(0,0,0,0.45)';
  c.shadowBlur = 10;
  c.shadowOffsetY = 3;
  c.fillStyle = 'rgba(18,26,43,0.94)';
  c.fill();
  c.shadowColor = 'transparent';
  c.lineWidth = 1;
  c.strokeStyle = 'rgba(255,255,255,0.18)';
  c.stroke();
  c.restore();
}

/** Size of a label pill for `text` (CSS px). */
function labelSize(c: CanvasRenderingContext2D, text: string, size = 13): { w: number; h: number } {
  c.save();
  c.font = `650 ${size}px ${FONT}`;
  const w = c.measureText(text).width + 18;
  c.restore();
  return { w, h: size + 12 };
}

/**
 * A label pill next to a circle (anchor + radius) at whichever side covers the fewest of `avoid`
 * (screen points along the plan's lines), with a leader line to the circle's rim.
 */
export function placedLabel(c: CanvasRenderingContext2D, text: string, anchor: Pt & { r: number }, avoid: Pt[], free: Box, color: string = UI.text): Box {
  const size = labelSize(c, text);
  const pl = placeLabel(anchor, size, avoid, free, { gap: 14 });
  const dx = pl.lead.x - anchor.x;
  const dy = pl.lead.y - anchor.y;
  const L = Math.hypot(dx, dy) || 1;
  if (L > anchor.r + 4) {
    c.save();
    c.beginPath();
    c.moveTo(pl.lead.x, pl.lead.y);
    c.lineTo(anchor.x + (dx / L) * (anchor.r + 2), anchor.y + (dy / L) * (anchor.r + 2));
    c.strokeStyle = 'rgba(7,11,20,0.7)';
    c.lineWidth = 3;
    c.stroke();
    c.strokeStyle = 'rgba(244,246,251,0.85)';
    c.lineWidth = 1.25;
    c.stroke();
    c.restore();
  }
  return label(c, text, { x: pl.x, y: pl.y + size.h / 2 }, color, 13, 'left');
}

/** Screen points along the guide's lines and balls, for label placement. */
function guideAvoid(g: PlayerGuide, m: FrameMapping): Pt[] {
  const out: Pt[] = [];
  const add = (runs: Vec2[][], step = 3) => {
    for (const r of runs) for (let i = 0; i < r.length; i += step) out.push(m.toScreen(r[i]!));
  };
  add(g.aim, 2);
  add(g.objectPath);
  add(g.cuePath);
  add(g.pocket, 6);
  for (const poly of [g.ghost, g.target]) for (let i = 0; i < poly.length; i += 4) out.push(m.toScreen(poly[i]!));
  return out;
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
  /** Text appended to the strike label (e.g. "4/10 · medium"): power next to where to hit. */
  strikeNote?: string;
  /** Boxes (canvas CSS px) the labels must keep clear of, e.g. a button floating over the photo. */
  avoidRects?: Box[];
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
  // Pocket ring (target yellow) + object-ball path into it.
  for (const run of mapRuns(g.pocket, m)) glowLine(c, run, PALETTE.pocket, 3 * k, [], 14);
  // Scratch risk: a dashed vermillion ring on a pocket a small error would send the cue ball into.
  for (const rings of g.risk ?? []) for (const run of mapRuns(rings, m)) glowLine(c, run, PALETTE.warn, 2.5 * k, [8, 6], 0);
  const ob = mapRuns(g.objectPath, m);
  for (const run of ob) glowLine(c, run, PALETTE.object, 4 * k, DASH.object, 8);
  if (ob.length) chevron(c, ob[ob.length - 1]!, PALETTE.object, 12 * k);
  if (st.showCuePath) for (const run of mapRuns(g.cuePath, m)) glowLine(c, run, PALETTE.cue, 2.5 * k, DASH.cue, 6);
  // The cue's line toward the player (faint), then the aim line on the cloth.
  for (const run of mapRuns(g.cueAxis, m)) glowLine(c, run, 'rgba(244,246,251,0.55)', 2 * k, [2, 7], 0);
  // Not makeable: vermillion and dashed (never colour alone).
  const aimColor = st.makeable === false ? PALETTE.warn : PALETTE.aim;
  for (const run of mapRuns(g.aim, m)) glowLine(c, run, aimColor, 5 * k, st.makeable === false ? [10, 7] : DASH.aim, 12);
  // Target ball ring.
  if (g.target.length) glowLine(c, mapPts(g.target, m), PALETTE.target, 2.5 * k, [], 10, true);
  // Ghost ball: a dotted white outline only, so the real object ball stays visible through it.
  let ghostAnchor: (Pt & { r: number }) | null = null;
  if (g.ghost.length) {
    const pts = mapPts(g.ghost, m);
    const q = centre(pts);
    const r = meanRadius(pts, q);
    glowLine(c, pts, PALETTE.ghost, 2.5 * k, DASH.ghost, 6, true);
    ghostAnchor = { x: q.x, y: q.y, r };
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
  const W = c.canvas.width / (c.getTransform().a || 1);
  const Hh = c.canvas.height / (c.getTransform().d || 1);
  const free: Box = st.clip ? { left: st.clip.x + 4, top: st.clip.y + 4, right: st.clip.x + st.clip.w - 4, bottom: st.clip.y + st.clip.h - 4 } : { left: 4, top: 4, right: W - 4, bottom: Hh - 4 };
  const avoid = labels ? guideAvoid(g, m) : [];
  for (const r of st.avoidRects ?? []) for (let x = r.left; x <= r.right; x += 10) for (let y = r.top; y <= r.bottom; y += 10) avoid.push({ x, y });
  // A shot that cannot be played as planned: no strike point and no power on the photo (Principle II).
  if (st.makeable !== false) drawStrike(c, m, g, k, labels, st.strikeNote, avoid, free);
  if (labels && ghostAnchor) placedLabel(c, st.makeable === false ? 'Not makeable' : 'Aim here', ghostAnchor, avoid, free, st.makeable === false ? '#FF9B66' : UI.text);
}

/**
 * The strike point face-on over the cue ball (as coaches draw it, see StrikeFace): a translucent
 * flat face, the ball's centre cross, the miscue-limit ring and the blue tip dot with a crosshair.
 * "High" is above the centre on screen, whatever the camera's height.
 */
export function drawFace(c: CanvasRenderingContext2D, f: StrikeFace, toScreen: (p: Vec2) => Vec2, scale: number, k = 1): { x: number; y: number; r: number } {
  const q = toScreen(f.c);
  const r = Math.max(6, f.r * scale);
  const d = toScreen(f.dot);
  const dr = Math.max(3.5 * k, f.dotR * scale);
  c.save();
  // Face: soft ivory disc with a crisp rim, so the photo's own shading does not read as an offset.
  c.beginPath();
  c.arc(q.x, q.y, r, 0, Math.PI * 2);
  c.fillStyle = 'rgba(246,243,234,0.38)';
  c.fill();
  c.lineWidth = 3.5 * k;
  c.strokeStyle = UI.haloStrong;
  c.stroke();
  c.lineWidth = 1.6 * k;
  c.strokeStyle = 'rgba(255,255,255,0.95)';
  c.stroke();
  // Centre cross (equator and vertical meridian of the face).
  c.beginPath();
  c.moveTo(q.x - r, q.y);
  c.lineTo(q.x + r, q.y);
  c.moveTo(q.x, q.y - r);
  c.lineTo(q.x, q.y + r);
  c.lineWidth = 1 * k;
  c.strokeStyle = 'rgba(7,11,20,0.55)';
  c.stroke();
  // Miscue limit.
  c.beginPath();
  c.arc(q.x, q.y, f.miscueR * scale, 0, Math.PI * 2);
  c.setLineDash([3 * k, 3 * k]);
  c.lineWidth = 1.4 * k;
  c.strokeStyle = '#D55E00';
  c.stroke();
  c.setLineDash([]);
  // Tip dot: dark halo, blue footprint, white rim, white centre point.
  c.beginPath();
  c.arc(d.x, d.y, dr + 2.5 * k, 0, Math.PI * 2);
  c.fillStyle = 'rgba(7,11,20,0.5)';
  c.fill();
  c.beginPath();
  c.arc(d.x, d.y, dr, 0, Math.PI * 2);
  c.fillStyle = '#0072B2';
  c.fill();
  c.lineWidth = 2 * k;
  c.strokeStyle = '#FFFFFF';
  c.stroke();
  c.beginPath();
  c.arc(d.x, d.y, Math.max(1.2, 1.4 * k), 0, Math.PI * 2);
  c.fillStyle = '#FFFFFF';
  c.fill();
  c.restore();
  return { x: q.x, y: q.y, r };
}

/** Strike mark on the photo's cue ball (face-on), with a label carrying the power too. */
export function drawStrike(c: CanvasRenderingContext2D, m: FrameMapping, g: PlayerGuide, k = 1, labels = true, note?: string, avoid: Pt[] = [], free?: Box): void {
  if (!g.face) return;
  const scale = Math.abs(m.toScreen({ x: 1, y: 0 }).x - m.toScreen({ x: 0, y: 0 }).x);
  const a = drawFace(c, g.face, (p) => m.toScreen(p), scale, k);
  if (labels) {
    const W = c.canvas.width / (c.getTransform().a || 1);
    const Hh = c.canvas.height / (c.getTransform().d || 1);
    placedLabel(c, note ? `Strike here · ${note}` : 'Strike here', a, avoid, free ?? { left: 4, top: 4, right: W - 4, bottom: Hh - 4 });
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
  // Aim line start for direction context, then the face-on strike mark.
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
