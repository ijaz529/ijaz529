/**
 * Top-down table view: the 2D practice table (fallback when WebGL2 is missing) and the camera-mode
 * mini-map. Auto-rotates the table so its long axis follows the canvas's long axis. Draws the plan
 * with the colour-blind-safe palette and redundant line styles.
 *
 * Look ("Midnight Felt"): walnut rails with grain, felt cloth with an overhead-lamp falloff and a
 * faint weave, inlaid diamonds, leather-lined pockets, shaded balls with numbers and stripes. The
 * static table is cached in an offscreen canvas and only redrawn when the size or table changes.
 */
import type { Ball, PocketId, ShotPlan, TableSpec, Trajectory, Vec2 } from '../../core/types';
import { tagText } from '../ui/ball-tags';
import { DASH, HIT_RADIUS_PX, PALETTE, STICK_ALPHA, UI, ballCss } from './palette';
import { aimLine, planLabel, stickLine } from './plan-draw';

export interface TableViewData {
  table: TableSpec;
  balls: Ball[];
  plan: ShotPlan | null;
  targetId: string | null;
  pocketId: PocketId | null;
  landing: Vec2 | null;
  heatmap: { cols: number; rows: number; values: Float32Array } | null;
  dimmed?: boolean;
}

const RAIL = 0.09;

/** Deterministic pseudo-random numbers (grain/weave must not flicker between frames). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

type Ctx = CanvasRenderingContext2D;

export class TableView {
  readonly canvas: HTMLCanvasElement;
  private ctx: Ctx;
  private s = 1;
  private cx = 0;
  private cy = 0;
  private rotated = false;
  private table: TableSpec | null = null;
  private cssW = 0;
  private cssH = 0;
  private dpr = 1;
  private bg: HTMLCanvasElement | null = null;
  private bgKey = '';
  private heat: HTMLCanvasElement | null = null;
  /** Label boxes placed this frame (simple collision avoidance). */
  private placed: { x: number; y: number; w: number; h: number }[] = [];

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
  }

  /** Table metres → CSS pixels within the canvas. */
  toCanvas(p: Vec2): Vec2 {
    return this.rotated ? { x: this.cx - p.y * this.s, y: this.cy - p.x * this.s } : { x: this.cx + p.x * this.s, y: this.cy - p.y * this.s };
  }

  /** CSS pixels within the canvas → table metres. */
  toTable(q: Vec2): Vec2 {
    return this.rotated ? { x: (this.cy - q.y) / this.s, y: (this.cx - q.x) / this.s } : { x: (q.x - this.cx) / this.s, y: (this.cy - q.y) / this.s };
  }

  get scale(): number {
    return this.s;
  }

  private layout(table: TableSpec): void {
    const dpr = Math.min(3, globalThis.devicePixelRatio || 1);
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.dpr = dpr;
    this.cssW = w;
    this.cssH = h;
    const ox = table.length / 2 + table.cushionWidth + RAIL;
    const oy = table.width / 2 + table.cushionWidth + RAIL;
    // Pick the orientation that draws the table larger (a small margin leaves room for the shadow).
    const m = Math.min(12, Math.max(2, Math.min(w, h) * 0.02));
    const sFlat = Math.max(1e-3, Math.min((w - 2 * m) / (2 * ox), (h - 2 * m) / (2 * oy)));
    const sRot = Math.max(1e-3, Math.min((w - 2 * m) / (2 * oy), (h - 2 * m) / (2 * ox)));
    this.rotated = sRot > sFlat * 1.02;
    this.s = this.rotated ? sRot : sFlat;
    this.cx = w / 2;
    this.cy = h / 2;
    this.table = table;
  }

  /**
   * The ball under a tap (CSS px), or null. A ball inside its natural pick radius (slop × R + 12 px)
   * always wins; beyond that, up to the 22 px floor, it wins only when no pocket mouth is nearer the
   * tap, so the caller falls through to pocketAt for a tap on a pocket next to a ball.
   */
  ballAt(q: Vec2, balls: Ball[], slop = 1.8): Ball | null {
    if (!this.table) return null;
    const p = this.toTable(q);
    let best: Ball | null = null;
    const natural = this.table.ballRadius * slop + 12 / this.s;
    // At least a 44 CSS px target (22 px radius) even on the small mini-map; the nearest ball wins.
    let bd = Math.max(natural, HIT_RADIUS_PX / this.s);
    for (const b of balls) {
      const d = Math.hypot(b.pos.x - p.x, b.pos.y - p.y);
      if (d < bd) {
        bd = d;
        best = b;
      }
    }
    if (best && bd >= natural) {
      const pk = this.nearestPocket(p);
      if (pk && pk.d < bd) return null;
    }
    return best;
  }

  pocketAt(q: Vec2): PocketId | null {
    if (!this.table) return null;
    return this.nearestPocket(this.toTable(q))?.id ?? null;
  }

  /** The nearest pocket mouth within its pick radius (table metres), or null. */
  private nearestPocket(p: Vec2): { id: PocketId; d: number } | null {
    if (!this.table) return null;
    let best: PocketId | null = null;
    let bd = Math.max(this.table.cornerMouth, 22 / this.s);
    for (const pk of this.table.pockets) {
      const d = Math.hypot(pk.mouthCenter.x - p.x, pk.mouthCenter.y - p.y);
      if (d < bd) {
        bd = d;
        best = pk.id;
      }
    }
    return best ? { id: best, d: bd } : null;
  }

  /** Screen-space axis-aligned rect of a table-space rect. */
  private srect(x0: number, y0: number, x1: number, y1: number): { x: number; y: number; w: number; h: number } {
    const a = this.toCanvas({ x: x0, y: y0 });
    const b = this.toCanvas({ x: x1, y: y1 });
    return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
  }

  /** Sets the context transform so drawing happens in table metres (y up). */
  private tableSpace(c: Ctx): void {
    const d = this.dpr;
    const s = this.s;
    if (this.rotated) c.setTransform(0, -s * d, -s * d, 0, this.cx * d, this.cy * d);
    else c.setTransform(s * d, 0, 0, -s * d, this.cx * d, this.cy * d);
  }

  draw(d: TableViewData): void {
    const t = d.table;
    this.layout(t);
    const c = this.ctx;
    c.clearRect(0, 0, this.cssW, this.cssH);
    this.placed = [];
    // Hidden or collapsed canvas (e.g. the mini-map behind the camera message): nothing to draw.
    if (this.cssW < 24 || this.cssH < 16) return;
    this.drawBackground(t);
    if (this.bg) c.drawImage(this.bg, 0, 0, this.cssW, this.cssH);
    const R = t.ballRadius;
    const hx = t.length / 2;
    const hy = t.width / 2;
    // Selected pocket.
    if (d.pocketId) {
      const pk = t.pockets.find((p) => p.id === d.pocketId);
      if (pk) {
        const q = this.toCanvas({ x: pk.mouthCenter.x - pk.inward.x * 0.02, y: pk.mouthCenter.y - pk.inward.y * 0.02 });
        const r = ((pk.kind === 'corner' ? t.cornerMouth : t.sideMouth) / 2) * this.s * 1.05;
        this.ring(q, r + 3, PALETTE.pocket, 3, 10);
      }
    }
    // Heatmap of good cue-ball zones (smoothly upscaled).
    if (d.heatmap) this.drawHeat(d.heatmap, hx - R, hy - R);
    if (d.plan) this.drawPlan(d.plan, d.balls, false);
    // Landing target.
    if (d.landing) {
      const q = this.toCanvas(d.landing);
      const r = 0.15 * this.s;
      c.save();
      c.lineCap = 'round';
      c.strokeStyle = UI.halo;
      c.lineWidth = 5;
      c.beginPath();
      c.arc(q.x, q.y, r, 0, Math.PI * 2);
      c.stroke();
      c.strokeStyle = PALETTE.landing;
      c.setLineDash([5, 4]);
      c.lineWidth = 2.2;
      c.stroke();
      c.setLineDash([]);
      c.beginPath();
      c.moveTo(q.x - 7, q.y);
      c.lineTo(q.x + 7, q.y);
      c.moveTo(q.x, q.y - 7);
      c.lineTo(q.x, q.y + 7);
      c.stroke();
      c.restore();
    }
    // Balls.
    for (const b of d.balls) this.drawBall(b, R);
    // Target highlight.
    const target = d.targetId ? d.balls.find((b) => b.id === d.targetId) : undefined;
    if (target) this.ring(this.toCanvas(target.pos), Math.max(3, R * this.s) + 4, PALETTE.target, 2.6, 8);
    if (d.plan) this.drawPlan(d.plan, d.balls, true);
    if (d.dimmed) {
      c.fillStyle = 'rgba(7,11,20,0.45)';
      c.fillRect(0, 0, this.cssW, this.cssH);
    }
  }

  // --------------------------------------------------------------------------------------------
  // Static table (cached)
  // --------------------------------------------------------------------------------------------
  private drawBackground(t: TableSpec): void {
    const key = `${this.canvas.width}x${this.canvas.height}|${this.rotated}|${this.s.toFixed(3)}|${t.id}|${t.length}|${t.width}|${t.cushionWidth}|${t.cornerMouth}|${t.sideMouth}`;
    if (this.bg && key === this.bgKey) return;
    this.bgKey = key;
    const cv = this.bg ?? document.createElement('canvas');
    this.bg = cv;
    cv.width = this.canvas.width;
    cv.height = this.canvas.height;
    const c = cv.getContext('2d')!;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, this.cssW, this.cssH);
    const s = this.s;
    const hx = t.length / 2;
    const hy = t.width / 2;
    const cw = t.cushionWidth;
    const outer = this.srect(-hx - cw - RAIL, -hy - cw - RAIL, hx + cw + RAIL, hy + cw + RAIL);
    const inner = this.srect(-hx - cw, -hy - cw, hx + cw, hy + cw);
    const bed = this.srect(-hx, -hy, hx, hy);
    const rr = Math.max(3, RAIL * s * 0.45);
    const rrect = (r: { x: number; y: number; w: number; h: number }, rad: number) => {
      c.beginPath();
      if (typeof c.roundRect === 'function') c.roundRect(r.x, r.y, r.w, r.h, rad);
      else c.rect(r.x, r.y, r.w, r.h);
    };

    // Floor shadow under the table.
    c.save();
    c.shadowColor = 'rgba(0,0,0,0.6)';
    c.shadowBlur = Math.max(8, 0.12 * s);
    c.shadowOffsetY = Math.max(3, 0.04 * s);
    rrect(outer, rr);
    c.fillStyle = '#2a190e';
    c.fill();
    c.restore();

    // Walnut rails with grain.
    c.save();
    rrect(outer, rr);
    c.clip();
    const wood = c.createLinearGradient(outer.x, outer.y, outer.x + outer.w * 0.35, outer.y + outer.h);
    wood.addColorStop(0, UI.woodHi);
    wood.addColorStop(0.5, UI.wood);
    wood.addColorStop(1, UI.woodLo);
    c.fillStyle = wood;
    c.fillRect(outer.x, outer.y, outer.w, outer.h);
    const rnd = lcg(7);
    const along = outer.w >= outer.h; // grain runs along the long side
    const n = Math.round((along ? outer.h : outer.w) / 2.2);
    for (let i = 0; i < n; i++) {
      const f = rnd();
      c.strokeStyle = f > 0.5 ? `rgba(255,214,170,${(0.025 + 0.04 * rnd()).toFixed(3)})` : `rgba(0,0,0,${(0.05 + 0.08 * rnd()).toFixed(3)})`;
      c.lineWidth = 0.6 + rnd() * 1.4;
      const o = (i / n) * (along ? outer.h : outer.w);
      const amp = 1 + rnd() * 3;
      const ph = rnd() * Math.PI * 2;
      c.beginPath();
      const len = along ? outer.w : outer.h;
      for (let k = 0; k <= 24; k++) {
        const u = (k / 24) * len;
        const v = o + Math.sin(ph + (k / 24) * Math.PI * (1.5 + rnd() * 0.2)) * amp;
        if (along) c.lineTo(outer.x + u, outer.y + v);
        else c.lineTo(outer.x + v, outer.y + u);
      }
      c.stroke();
    }
    // Top-light sheen on the rail and a bevel along the outer edge.
    const sheen = c.createLinearGradient(0, outer.y, 0, outer.y + outer.h);
    sheen.addColorStop(0, 'rgba(255,230,200,0.10)');
    sheen.addColorStop(0.5, 'rgba(255,230,200,0)');
    sheen.addColorStop(1, 'rgba(0,0,0,0.18)');
    c.fillStyle = sheen;
    c.fillRect(outer.x, outer.y, outer.w, outer.h);
    c.restore();
    c.save();
    rrect({ x: outer.x + 0.75, y: outer.y + 0.75, w: outer.w - 1.5, h: outer.h - 1.5 }, rr);
    c.strokeStyle = 'rgba(255,220,180,0.22)';
    c.lineWidth = 1.5;
    c.stroke();
    c.restore();

    // Cushions (darker felt) with an inner shadow where they meet the wood.
    c.save();
    c.fillStyle = UI.cushion;
    c.fillRect(inner.x, inner.y, inner.w, inner.h);
    c.strokeStyle = 'rgba(0,0,0,0.45)';
    c.lineWidth = 2;
    c.strokeRect(inner.x + 1, inner.y + 1, inner.w - 2, inner.h - 2);
    c.restore();

    // Cloth with an overhead-lamp falloff.
    c.save();
    const lamp = c.createRadialGradient(bed.x + bed.w / 2, bed.y + bed.h / 2, 0, bed.x + bed.w / 2, bed.y + bed.h / 2, Math.hypot(bed.w, bed.h) * 0.6);
    lamp.addColorStop(0, UI.clothHi);
    lamp.addColorStop(0.55, UI.cloth);
    lamp.addColorStop(1, UI.clothLo);
    c.fillStyle = lamp;
    c.fillRect(bed.x, bed.y, bed.w, bed.h);
    // Faint weave.
    const weave = document.createElement('canvas');
    weave.width = weave.height = 32;
    const wc = weave.getContext('2d')!;
    const wr = lcg(11);
    for (let y = 0; y < 32; y++)
      for (let x = 0; x < 32; x++) {
        const v = ((x + y) & 1 ? 0.5 : -0.5) + (wr() - 0.5);
        wc.fillStyle = v > 0 ? `rgba(255,255,255,${(0.035 * v).toFixed(3)})` : `rgba(0,0,0,${(-0.05 * v).toFixed(3)})`;
        wc.fillRect(x, y, 1, 1);
      }
    const pat = c.createPattern(weave, 'repeat');
    if (pat) {
      c.fillStyle = pat;
      c.fillRect(bed.x, bed.y, bed.w, bed.h);
    }
    // Cushion nose: a light line along the bed edge and a soft shadow onto the cloth.
    c.strokeStyle = 'rgba(255,255,255,0.10)';
    c.lineWidth = 1;
    c.strokeRect(bed.x + 0.5, bed.y + 0.5, bed.w - 1, bed.h - 1);
    const edge = Math.max(2, 0.025 * s);
    for (const [x, y, w, h, x0, y0, x1, y1] of [
      [bed.x, bed.y, bed.w, edge, 0, bed.y, 0, bed.y + edge],
      [bed.x, bed.y + bed.h - edge, bed.w, edge, 0, bed.y + bed.h, 0, bed.y + bed.h - edge],
      [bed.x, bed.y, edge, bed.h, bed.x, 0, bed.x + edge, 0],
      [bed.x + bed.w - edge, bed.y, edge, bed.h, bed.x + bed.w, 0, bed.x + bed.w - edge, 0],
    ] as const) {
      const g = c.createLinearGradient(x0, y0, x1, y1);
      g.addColorStop(0, 'rgba(0,0,0,0.28)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = g;
      c.fillRect(x, y, w, h);
    }
    c.restore();

    // Table markings (pool: head string + spots; snooker: baulk line, D and spots).
    c.save();
    this.tableSpace(c);
    c.lineWidth = 1 / s;
    c.strokeStyle = 'rgba(255,255,255,0.16)';
    c.fillStyle = 'rgba(255,255,255,0.4)';
    const snooker = t.id === 'snooker12';
    const lineX = snooker ? -hx + t.length * 0.2 : -hx + t.length / 4;
    c.beginPath();
    c.moveTo(lineX, -hy);
    c.lineTo(lineX, hy);
    c.stroke();
    if (snooker) {
      const dr = t.width * 0.165;
      c.beginPath();
      c.arc(lineX, 0, dr, Math.PI / 2, (3 * Math.PI) / 2);
      c.stroke();
    }
    const spot = (x: number) => {
      c.beginPath();
      c.arc(x, 0, Math.max(0.006, 2 / s), 0, Math.PI * 2);
      c.fill();
    };
    spot(hx - t.length / 4);
    spot(snooker ? 0 : lineX);
    c.restore();

    // Diamonds (sights) every 1/8 of the length and 1/4 of the width, inlaid in the rail.
    c.save();
    const dsz = Math.max(1.6, Math.min(4, RAIL * s * 0.09));
    const diamond = (p: Vec2) => {
      const q = this.toCanvas(p);
      c.beginPath();
      c.moveTo(q.x, q.y - dsz * 1.4);
      c.lineTo(q.x + dsz, q.y);
      c.lineTo(q.x, q.y + dsz * 1.4);
      c.lineTo(q.x - dsz, q.y);
      c.closePath();
      c.fill();
    };
    c.fillStyle = UI.pearl;
    c.shadowColor = 'rgba(0,0,0,0.5)';
    c.shadowBlur = 2;
    for (let k = 1; k < 8; k++) {
      if (k === 4) continue;
      for (const sy of [-1, 1]) diamond({ x: -hx + (k * t.length) / 8, y: sy * (hy + cw + RAIL / 2) });
    }
    for (let k = 1; k < 4; k++) for (const sx of [-1, 1]) diamond({ x: sx * (hx + cw + RAIL / 2), y: -hy + (k * t.width) / 4 });
    c.restore();

    // Pockets: leather liner + deep hole.
    for (const pk of t.pockets) {
      const q = this.toCanvas({ x: pk.mouthCenter.x - pk.inward.x * 0.02, y: pk.mouthCenter.y - pk.inward.y * 0.02 });
      const r = ((pk.kind === 'corner' ? t.cornerMouth : t.sideMouth) / 2) * s * 1.05;
      c.save();
      c.shadowColor = 'rgba(0,0,0,0.55)';
      c.shadowBlur = Math.max(2, r * 0.35);
      c.fillStyle = UI.leather;
      c.beginPath();
      c.arc(q.x, q.y, r * 1.2, 0, Math.PI * 2);
      c.fill();
      c.restore();
      const rim = c.createLinearGradient(q.x - r, q.y - r, q.x + r, q.y + r);
      rim.addColorStop(0, 'rgba(255,255,255,0.18)');
      rim.addColorStop(1, 'rgba(255,255,255,0)');
      c.strokeStyle = rim;
      c.lineWidth = 1;
      c.beginPath();
      c.arc(q.x, q.y, r * 1.2 - 0.5, 0, Math.PI * 2);
      c.stroke();
      const hole = c.createRadialGradient(q.x - r * 0.25, q.y - r * 0.3, r * 0.1, q.x, q.y, r);
      hole.addColorStop(0, '#000');
      hole.addColorStop(0.75, '#050505');
      hole.addColorStop(1, '#1d1d1d');
      c.fillStyle = hole;
      c.beginPath();
      c.arc(q.x, q.y, r, 0, Math.PI * 2);
      c.fill();
    }
  }

  // --------------------------------------------------------------------------------------------
  // Dynamic layers
  // --------------------------------------------------------------------------------------------
  private ring(q: Vec2, r: number, color: string, width: number, glow: number): void {
    const c = this.ctx;
    c.save();
    c.strokeStyle = UI.halo;
    c.lineWidth = width + 3;
    c.beginPath();
    c.arc(q.x, q.y, r, 0, Math.PI * 2);
    c.stroke();
    c.shadowColor = color;
    c.shadowBlur = glow;
    c.strokeStyle = color;
    c.lineWidth = width;
    c.stroke();
    c.restore();
  }

  private drawHeat(h: { cols: number; rows: number; values: Float32Array }, ix: number, iy: number): void {
    const { cols, rows, values } = h;
    if (!cols || !rows) return;
    const cv = this.heat ?? document.createElement('canvas');
    this.heat = cv;
    if (cv.width !== cols || cv.height !== rows) {
      cv.width = cols;
      cv.height = rows;
    }
    const hc = cv.getContext('2d')!;
    const img = hc.createImageData(cols, rows);
    for (let j = 0; j < rows; j++)
      for (let i = 0; i < cols; i++) {
        const v = values[j * cols + i]!;
        const o = (j * cols + i) * 4;
        img.data[o] = 240;
        img.data[o + 1] = 228;
        img.data[o + 2] = 66;
        img.data[o + 3] = v <= 0.05 ? 0 : Math.round((0.15 + 0.5 * Math.min(1, v)) * 255);
      }
    hc.putImageData(img, 0, 0);
    const c = this.ctx;
    c.save();
    this.tableSpace(c);
    c.imageSmoothingEnabled = true;
    // Image row j holds y = -iy + j·dy: the table-space transform puts it the right way up.
    c.drawImage(cv, -ix, -iy, 2 * ix, 2 * iy);
    c.restore();
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  private drawBall(b: Ball, R: number): void {
    const c = this.ctx;
    const q = this.toCanvas(b.pos);
    const r = Math.max(3, R * this.s);
    const snooker = this.table?.id === 'snooker12';
    const base = ballCss(b, snooker);
    // Contact shadow (light from the top-left lamp).
    const sh = c.createRadialGradient(q.x + r * 0.28, q.y + r * 0.38, r * 0.2, q.x + r * 0.28, q.y + r * 0.38, r * 1.3);
    sh.addColorStop(0, 'rgba(0,0,0,0.5)');
    sh.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = sh;
    c.beginPath();
    c.arc(q.x + r * 0.28, q.y + r * 0.38, r * 1.3, 0, Math.PI * 2);
    c.fill();
    c.save();
    c.beginPath();
    c.arc(q.x, q.y, r, 0, Math.PI * 2);
    c.clip();
    c.fillStyle = b.stripe ? UI.ivory : base;
    c.fillRect(q.x - r, q.y - r, 2 * r, 2 * r);
    if (b.stripe) {
      c.fillStyle = base;
      c.fillRect(q.x - r, q.y - r * 0.55, 2 * r, r * 1.1);
    }
    // Number disc: the number, or the colour's short name (Br/Bl/Bk on snooker); none for the cue ball
    // or a ball vision could not name ('ball'), the same text as the 3D table's ball tags.
    const label = b.label ? tagText(b, snooker) : '';
    if (label && r >= 5.5) {
      c.fillStyle = '#FBFAF5';
      c.beginPath();
      c.arc(q.x, q.y, r * 0.5, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = '#111';
      c.font = `800 ${Math.max(6, Math.round(r * (label.length > 1 ? 0.52 : 0.62)))}px -apple-system, system-ui, sans-serif`;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(label, q.x, q.y + r * 0.04);
    }
    // Shading: edge darkening + specular highlight.
    const dark = c.createRadialGradient(q.x - r * 0.25, q.y - r * 0.3, r * 0.3, q.x - r * 0.1, q.y - r * 0.1, r * 1.25);
    dark.addColorStop(0, 'rgba(0,0,0,0)');
    dark.addColorStop(0.6, 'rgba(0,0,0,0.1)');
    dark.addColorStop(1, 'rgba(0,0,0,0.55)');
    c.fillStyle = dark;
    c.fillRect(q.x - r, q.y - r, 2 * r, 2 * r);
    const spec = c.createRadialGradient(q.x - r * 0.38, q.y - r * 0.42, 0, q.x - r * 0.38, q.y - r * 0.42, r * 0.55);
    spec.addColorStop(0, 'rgba(255,255,255,0.9)');
    spec.addColorStop(0.4, 'rgba(255,255,255,0.25)');
    spec.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = spec;
    c.fillRect(q.x - r, q.y - r, 2 * r, 2 * r);
    c.restore();
    c.strokeStyle = 'rgba(0,0,0,0.55)';
    c.lineWidth = 0.75;
    c.beginPath();
    c.arc(q.x, q.y, r, 0, Math.PI * 2);
    c.stroke();
  }

  private poly(pts: Vec2[], color: string, dash: number[], width: number): void {
    if (pts.length < 2) return;
    const c = this.ctx;
    c.save();
    c.lineJoin = 'round';
    c.lineCap = 'round';
    c.beginPath();
    pts.forEach((p, i) => {
      const q = this.toCanvas(p);
      if (i === 0) c.moveTo(q.x, q.y);
      else c.lineTo(q.x, q.y);
    });
    // Dark halo, then the colour with a soft glow.
    c.strokeStyle = UI.halo;
    c.lineWidth = width + 3;
    c.stroke();
    c.setLineDash(dash);
    c.shadowColor = color;
    c.shadowBlur = 6;
    c.strokeStyle = color;
    c.lineWidth = width;
    c.stroke();
    c.restore();
  }

  private path(tr: Trajectory, color: string, dash: number[], width: number): void {
    this.poly(tr.points, color, dash, width);
  }

  private label(text: string, q: Vec2, color: string = UI.text, align: 'left' | 'right' = 'left'): void {
    const c = this.ctx;
    c.save();
    c.font = `600 12px -apple-system, 'SF Pro Text', system-ui, sans-serif`;
    c.textAlign = 'left';
    c.textBaseline = 'middle';
    const w = c.measureText(text).width;
    const x0 = align === 'right' ? q.x - w : q.x;
    const x = Math.min(this.cssW - w - 4, Math.max(4, x0));
    let y = Math.min(this.cssH - 8, Math.max(8, q.y));
    const hit = (yy: number) => this.placed.some((b) => x < b.x + b.w && x + w > b.x && yy - 8 < b.y + b.h && yy + 8 > b.y);
    for (let k = 1; k <= 6 && hit(y); k++) y = Math.min(this.cssH - 8, Math.max(8, q.y + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 16));
    this.placed.push({ x, y: y - 8, w, h: 16 });
    c.lineJoin = 'round';
    c.strokeStyle = UI.haloStrong;
    c.lineWidth = 4;
    c.strokeText(text, x, y);
    c.fillStyle = color;
    c.fillText(text, x, y);
    c.restore();
  }

  /** The cue-stick line (table metres) for side spin, kept on the table and its rails. */
  private stickOf(plan: ShotPlan, cue: Vec2): { from: Vec2; to: Vec2 } | null {
    const t = this.table!;
    return stickLine(plan, cue, t.ballRadius, { hx: t.length / 2 + t.cushionWidth + RAIL * 0.8, hy: t.width / 2 + t.cushionWidth + RAIL * 0.8 });
  }

  /** A translucent shaded ghost ball with the dotted ring, centred at g (canvas px), radius gr. */
  private ghostBall(g: Vec2, gr: number): void {
    const c = this.ctx;
    c.save();
    const fill = c.createRadialGradient(g.x - gr * 0.35, g.y - gr * 0.4, gr * 0.05, g.x, g.y, gr);
    fill.addColorStop(0, 'rgba(255,255,255,0.55)');
    fill.addColorStop(0.7, 'rgba(255,255,255,0.16)');
    fill.addColorStop(1, 'rgba(255,255,255,0.06)');
    c.fillStyle = fill;
    c.beginPath();
    c.arc(g.x, g.y, gr, 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = UI.halo;
    c.lineWidth = 3.5;
    c.stroke();
    c.strokeStyle = PALETTE.ghost;
    c.setLineDash(DASH.ghost);
    c.lineWidth = 1.8;
    c.stroke();
    c.restore();
  }

  /** `top` = false draws the lines under the balls; true draws the ghost ball, contact and labels above. */
  private drawPlan(plan: ShotPlan, balls: Ball[], top: boolean): void {
    const c = this.ctx;
    const cue = balls.find((b) => b.kind === 'cue');
    if (!cue) return;
    const R = this.table!.ballRadius;
    const big = this.s > 120; // the full table, not the mini-map
    if (!top) {
      for (const o of plan.otherPaths) this.path(o, PALETTE.other, DASH.other, 1.5);
      if (plan.objectPath.points.length > 1) this.path(plan.objectPath, PALETTE.object, DASH.object, 3);
      // Cue-ball path after contact (dashed) — split at the first ball contact.
      const hit = plan.cuePath.events.find((e) => e.kind === 'ball');
      const pts = plan.cuePath.points;
      const hitIdx = hit ? pts.findIndex((p) => Math.hypot(p.x - hit.pos.x, p.y - hit.pos.y) < 1e-6) : -1;
      const after = hit ? pts.slice(Math.max(0, hitIdx)) : [];
      if (after.length > 1) this.path({ ...plan.cuePath, points: after }, PALETTE.cue, DASH.cue, 2.5);
      // Aim line: cue ball → ghost ball (a frozen cue ball: the stroke from the cue ball, no ghost ball).
      const t = this.table!;
      const aim = aimLine(plan, cue.pos, R, { hx: t.length / 2, hy: t.width / 2 });
      this.poly([aim.from, aim.to], plan.makeable ? PALETTE.aim : PALETTE.warn, [], 3);
      // Side spin: the cue stick behind the cue ball (faint, long-dashed, labelled on the top layer).
      const stick = big ? this.stickOf(plan, cue.pos) : null;
      if (stick) {
        c.save();
        c.globalAlpha = STICK_ALPHA;
        this.poly([stick.from, stick.to], PALETTE.stick, DASH.stick, 2);
        c.restore();
      }
      // Cue-ball rest (X in a dotted ring).
      if (plan.cueRest) {
        const q = this.toCanvas(plan.cueRest);
        c.save();
        c.lineCap = 'round';
        for (const [col, w] of [
          [UI.halo, 5],
          [PALETTE.cue, 2.5],
        ] as const) {
          c.strokeStyle = col;
          c.lineWidth = w;
          c.beginPath();
          c.moveTo(q.x - 6, q.y - 6);
          c.lineTo(q.x + 6, q.y + 6);
          c.moveTo(q.x + 6, q.y - 6);
          c.lineTo(q.x - 6, q.y + 6);
          c.stroke();
        }
        c.setLineDash([2, 3]);
        c.lineWidth = 1.8;
        c.beginPath();
        c.arc(q.x, q.y, R * this.s, 0, Math.PI * 2);
        c.stroke();
        c.restore();
      }
      return;
    }
    const aim = aimLine(plan, cue.pos, R, { hx: this.table!.length / 2, hy: this.table!.width / 2 });
    const gr = R * this.s;
    // The label sits by the ghost ball, or by the end of a frozen cue ball's stroke line.
    const g = this.toCanvas(aim.ghost ?? aim.to);
    // Ghost ball: a translucent shaded sphere with a dotted ring (none for a frozen cue ball).
    if (aim.ghost) this.ghostBall(g, gr);
    // Contact point.
    const cp = this.toCanvas(plan.contactPoint);
    c.save();
    c.fillStyle = PALETTE.warn;
    c.strokeStyle = '#fff';
    c.lineWidth = 1.2;
    c.beginPath();
    c.arc(cp.x, cp.y, big ? 3.6 : 2.6, 0, Math.PI * 2);
    c.fill();
    c.stroke();
    c.restore();
    if (big) {
      // Labels sit on the side of the ghost ball away from the aim line.
      const a = this.toCanvas(cue.pos);
      const dx = g.x - a.x;
      const dy = g.y - a.y;
      const L = Math.hypot(dx, dy) || 1;
      const nx = -dy / L;
      const ny = dx / L;
      const side = nx >= 0 ? 1 : -1;
      const text = planLabel(plan, cue.pos);
      const off = gr + 10;
      this.label(text, { x: g.x + nx * side * off, y: g.y + ny * side * off }, plan.makeable ? UI.text : '#FFAB7A', side < 0 ? 'right' : 'left');
      // The stick line's own label at its far end, so it is never read as a ball path.
      const stick = this.stickOf(plan, cue.pos);
      if (stick) {
        const e = this.toCanvas(stick.to);
        const sx = this.toCanvas(stick.from);
        this.label('Cue stick', { x: e.x + 6, y: e.y + (e.y >= sx.y ? 10 : -10) }, 'rgba(244,246,251,0.85)', e.x < sx.x ? 'right' : 'left');
      }
      if (plan.cueRest) {
        const q = this.toCanvas(plan.cueRest);
        this.label('Cue stops', { x: q.x + gr + 8, y: q.y });
      }
    }
  }
}
