/**
 * Top-down table view: the practice table and the camera-mode mini-map. Auto-rotates the table so its
 * long axis follows the canvas's long axis. Draws the plan with the colour-blind-safe palette.
 */
import type { Ball, PocketId, ShotPlan, TableSpec, Trajectory, Vec2 } from '../../core/types';
import { DASH, PALETTE } from './palette';

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

export class TableView {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private s = 1;
  private cx = 0;
  private cy = 0;
  private rotated = false;
  private table: TableSpec | null = null;
  private cssW = 0;
  private cssH = 0;

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
    this.cssW = w;
    this.cssH = h;
    const ox = table.length / 2 + table.cushionWidth + RAIL;
    const oy = table.width / 2 + table.cushionWidth + RAIL;
    // Pick the orientation that draws the table larger.
    const sFlat = Math.min((w - 8) / (2 * ox), (h - 8) / (2 * oy));
    const sRot = Math.min((w - 8) / (2 * oy), (h - 8) / (2 * ox));
    this.rotated = sRot > sFlat * 1.02;
    this.s = this.rotated ? sRot : sFlat;
    this.cx = w / 2;
    this.cy = h / 2;
    this.table = table;
  }

  ballAt(q: Vec2, balls: Ball[], slop = 1.8): Ball | null {
    if (!this.table) return null;
    const p = this.toTable(q);
    let best: Ball | null = null;
    let bd = this.table.ballRadius * slop + 12 / this.s;
    for (const b of balls) {
      const d = Math.hypot(b.pos.x - p.x, b.pos.y - p.y);
      if (d < bd) {
        bd = d;
        best = b;
      }
    }
    return best;
  }

  pocketAt(q: Vec2): PocketId | null {
    if (!this.table) return null;
    const p = this.toTable(q);
    let best: PocketId | null = null;
    let bd = Math.max(this.table.cornerMouth, 22 / this.s);
    for (const pk of this.table.pockets) {
      const d = Math.hypot(pk.mouthCenter.x - p.x, pk.mouthCenter.y - p.y);
      if (d < bd) {
        bd = d;
        best = pk.id;
      }
    }
    return best;
  }

  draw(d: TableViewData): void {
    const t = d.table;
    this.layout(t);
    const c = this.ctx;
    c.clearRect(0, 0, this.cssW, this.cssH);
    const R = t.ballRadius;
    const hx = t.length / 2;
    const hy = t.width / 2;
    const cw = t.cushionWidth;
    const rect = (x0: number, y0: number, x1: number, y1: number, fill: string) => {
      const a = this.toCanvas({ x: x0, y: y0 });
      const b = this.toCanvas({ x: x1, y: y1 });
      c.fillStyle = fill;
      c.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    };
    rect(-hx - cw - RAIL, -hy - cw - RAIL, hx + cw + RAIL, hy + cw + RAIL, '#5b3418');
    rect(-hx - cw, -hy - cw, hx + cw, hy + cw, '#1d6b3d');
    rect(-hx, -hy, hx, hy, '#23854b');
    // Diamonds (sights) every 1/8 of the length and 1/4 of the width.
    c.fillStyle = '#f4ead2';
    for (let k = 1; k < 8; k++) {
      if (k === 4) continue;
      for (const sy of [-1, 1]) {
        const q = this.toCanvas({ x: -hx + (k * t.length) / 8, y: sy * (hy + cw + RAIL / 2) });
        c.beginPath();
        c.arc(q.x, q.y, 2, 0, Math.PI * 2);
        c.fill();
      }
    }
    for (let k = 1; k < 4; k++)
      for (const sx of [-1, 1]) {
        const q = this.toCanvas({ x: sx * (hx + cw + RAIL / 2), y: -hy + (k * t.width) / 4 });
        c.beginPath();
        c.arc(q.x, q.y, 2, 0, Math.PI * 2);
        c.fill();
      }
    // Pockets.
    for (const pk of t.pockets) {
      const q = this.toCanvas({ x: pk.mouthCenter.x - pk.inward.x * 0.02, y: pk.mouthCenter.y - pk.inward.y * 0.02 });
      const r = ((pk.kind === 'corner' ? t.cornerMouth : t.sideMouth) / 2) * this.s * 1.05;
      c.fillStyle = '#0b0b0b';
      c.beginPath();
      c.arc(q.x, q.y, r, 0, Math.PI * 2);
      c.fill();
      if (pk.id === d.pocketId) {
        c.strokeStyle = PALETTE.target;
        c.lineWidth = 3;
        c.stroke();
      }
    }
    // Heatmap of good cue-ball zones.
    if (d.heatmap) {
      const { cols, rows, values } = d.heatmap;
      const ix = hx - R;
      const iy = hy - R;
      for (let j = 0; j < rows; j++)
        for (let i = 0; i < cols; i++) {
          const v = values[j * cols + i]!;
          if (v <= 0.05) continue;
          const x0 = -ix + (i / cols) * 2 * ix;
          const y0 = -iy + (j / rows) * 2 * iy;
          const a = this.toCanvas({ x: x0, y: y0 });
          const b = this.toCanvas({ x: x0 + (2 * ix) / cols, y: y0 + (2 * iy) / rows });
          c.fillStyle = `rgba(240,228,66,${(0.15 + 0.5 * v).toFixed(3)})`;
          c.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x) + 0.5, Math.abs(b.y - a.y) + 0.5);
        }
    }
    if (d.plan) this.drawPlan(d.plan, d.balls);
    // Landing target.
    if (d.landing) {
      const q = this.toCanvas(d.landing);
      const r = 0.15 * this.s;
      c.strokeStyle = PALETTE.landing;
      c.setLineDash([4, 3]);
      c.lineWidth = 2;
      c.beginPath();
      c.arc(q.x, q.y, r, 0, Math.PI * 2);
      c.stroke();
      c.setLineDash([]);
      c.beginPath();
      c.moveTo(q.x - 6, q.y);
      c.lineTo(q.x + 6, q.y);
      c.moveTo(q.x, q.y - 6);
      c.lineTo(q.x, q.y + 6);
      c.stroke();
    }
    // Balls.
    for (const b of d.balls) {
      const q = this.toCanvas(b.pos);
      const r = Math.max(3, R * this.s);
      c.fillStyle = b.kind === 'cue' ? '#f7f7f2' : (b.color ?? '#c33');
      c.beginPath();
      c.arc(q.x, q.y, r, 0, Math.PI * 2);
      c.fill();
      if (b.stripe) {
        c.save();
        c.clip();
        c.fillStyle = '#f7f7f2';
        c.fillRect(q.x - r, q.y - r, 2 * r, r * 0.55);
        c.fillRect(q.x - r, q.y + r * 0.45, 2 * r, r * 0.55);
        c.restore();
      }
      c.strokeStyle = 'rgba(0,0,0,0.55)';
      c.lineWidth = 1;
      c.stroke();
      if (b.id === d.targetId) {
        c.strokeStyle = PALETTE.target;
        c.lineWidth = 3;
        c.beginPath();
        c.arc(q.x, q.y, r + 4, 0, Math.PI * 2);
        c.stroke();
      }
      if (b.label && b.kind !== 'cue' && r >= 6) {
        c.fillStyle = '#fff';
        c.beginPath();
        c.arc(q.x, q.y, r * 0.55, 0, Math.PI * 2);
        c.fill();
        c.fillStyle = '#111';
        c.font = `bold ${Math.round(r * 0.75)}px system-ui, sans-serif`;
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillText(/^\d+$/.test(b.label) ? b.label : b.label.charAt(0).toUpperCase(), q.x, q.y + 0.5);
      }
    }
    if (d.dimmed) {
      c.fillStyle = 'rgba(0,0,0,0.35)';
      c.fillRect(0, 0, this.cssW, this.cssH);
    }
  }

  private path(tr: Trajectory, color: string, dash: number[], width: number): void {
    if (tr.points.length < 2) return;
    const c = this.ctx;
    c.strokeStyle = color;
    c.lineWidth = width;
    c.setLineDash(dash);
    c.lineJoin = 'round';
    c.beginPath();
    tr.points.forEach((p, i) => {
      const q = this.toCanvas(p);
      if (i === 0) c.moveTo(q.x, q.y);
      else c.lineTo(q.x, q.y);
    });
    c.stroke();
    c.setLineDash([]);
  }

  private drawPlan(plan: ShotPlan, balls: Ball[]): void {
    const c = this.ctx;
    const cue = balls.find((b) => b.kind === 'cue');
    if (!cue) return;
    const R = this.table!.ballRadius;
    for (const o of plan.otherPaths) this.path(o, PALETTE.other, DASH.other, 1.5);
    // Object ball path (to the pocket in the sim).
    const obIdx = plan.objectPath.points.length;
    if (obIdx > 1) this.path(plan.objectPath, PALETTE.object, DASH.object, 3);
    // Cue-ball path after contact (dashed) — split at the first ball contact.
    const hit = plan.cuePath.events.find((e) => e.kind === 'ball');
    const pts = plan.cuePath.points;
    const hitIdx = hit ? pts.findIndex((p) => Math.hypot(p.x - hit.pos.x, p.y - hit.pos.y) < 1e-6) : -1;
    const after = hit ? pts.slice(Math.max(0, hitIdx)) : [];
    if (after.length > 1) this.path({ ...plan.cuePath, points: after }, PALETTE.cue, DASH.cue, 2.5);
    // Aim line: cue ball → ghost ball.
    const a = this.toCanvas(cue.pos);
    const g = this.toCanvas(plan.ghost);
    c.strokeStyle = plan.makeable ? PALETTE.aim : PALETTE.warn;
    c.lineWidth = 3;
    c.beginPath();
    c.moveTo(a.x, a.y);
    c.lineTo(g.x, g.y);
    c.stroke();
    // Ghost ball.
    c.strokeStyle = PALETTE.ghost;
    c.setLineDash(DASH.ghost);
    c.lineWidth = 2;
    c.beginPath();
    c.arc(g.x, g.y, R * this.s, 0, Math.PI * 2);
    c.stroke();
    c.setLineDash([]);
    // Contact point.
    const cp = this.toCanvas(plan.contactPoint);
    c.fillStyle = PALETTE.warn;
    c.beginPath();
    c.arc(cp.x, cp.y, 3, 0, Math.PI * 2);
    c.fill();
    // Cue-ball rest (X).
    if (plan.cueRest) {
      const q = this.toCanvas(plan.cueRest);
      c.strokeStyle = PALETTE.cue;
      c.lineWidth = 2.5;
      c.beginPath();
      c.moveTo(q.x - 6, q.y - 6);
      c.lineTo(q.x + 6, q.y + 6);
      c.moveTo(q.x + 6, q.y - 6);
      c.lineTo(q.x - 6, q.y + 6);
      c.stroke();
      c.beginPath();
      c.arc(q.x, q.y, R * this.s, 0, Math.PI * 2);
      c.setLineDash([2, 3]);
      c.stroke();
      c.setLineDash([]);
    }
  }
}
