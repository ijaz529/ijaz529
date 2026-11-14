/**
 * Perspective AR overlay on the live camera image (FR-023). Lines on the cloth go through H0; ball
 * centres, paths and the ghost ball go through HR (plane at ball-centre height).
 */
import type { Ball, PocketId, ShotPlan, TableSpec, Vec2 } from '../../core/types';
import type { Calibration } from '../../vision/calibration';
import { applyH, invert3 } from '../../vision/homography';
import { DASH, PALETTE } from './palette';

export interface FrameMapping {
  /** Processing-frame px → CSS px in the overlay canvas. */
  toScreen(p: Vec2): Vec2;
  toFrame(p: Vec2): Vec2;
}

/** object-fit: contain mapping from a frame of (fw × fh) into a box of (w × h). */
export function containMapping(fw: number, fh: number, w: number, h: number): FrameMapping {
  const s = Math.min(w / fw, h / fh);
  const ox = (w - fw * s) / 2;
  const oy = (h - fh * s) / 2;
  return {
    toScreen: (p) => ({ x: ox + p.x * s, y: oy + p.y * s }),
    toFrame: (p) => ({ x: (p.x - ox) / s, y: (p.y - oy) / s }),
  };
}

export interface OverlayData {
  table: TableSpec;
  calibration: Calibration | null;
  balls: Ball[];
  plan: ShotPlan | null;
  targetId: string | null;
  pocketId: PocketId | null;
  calibTaps: Vec2[];
  showPlan: boolean;
}

export class Overlay {
  private ctx: CanvasRenderingContext2D;
  constructor(readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
  }

  resize(): { w: number; h: number } {
    const dpr = Math.min(3, globalThis.devicePixelRatio || 1);
    const r = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width));
    const h = Math.max(1, Math.round(r.height));
    if (this.canvas.width !== Math.round(w * dpr)) this.canvas.width = Math.round(w * dpr);
    if (this.canvas.height !== Math.round(h * dpr)) this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w, h };
  }

  draw(d: OverlayData, map: FrameMapping): void {
    const { w, h } = this.resize();
    const c = this.ctx;
    c.clearRect(0, 0, w, h);
    for (const t of d.calibTaps) {
      const q = map.toScreen(t);
      c.strokeStyle = PALETTE.target;
      c.lineWidth = 3;
      c.beginPath();
      c.arc(q.x, q.y, 10, 0, Math.PI * 2);
      c.stroke();
    }
    const cal = d.calibration;
    if (!cal) return;
    const t = d.table;
    const R = t.ballRadius;
    const on0 = (p: Vec2) => map.toScreen(applyH(cal.H0, p.x, p.y));
    const onR = (p: Vec2) => map.toScreen(applyH(cal.HR, p.x, p.y));
    // Playing-surface outline.
    const hx = t.length / 2;
    const hy = t.width / 2;
    c.strokeStyle = 'rgba(255,255,255,0.55)';
    c.lineWidth = 1.5;
    c.beginPath();
    [
      { x: -hx, y: -hy },
      { x: hx, y: -hy },
      { x: hx, y: hy },
      { x: -hx, y: hy },
    ].forEach((p, i) => {
      const q = on0(p);
      if (i === 0) c.moveTo(q.x, q.y);
      else c.lineTo(q.x, q.y);
    });
    c.closePath();
    c.stroke();
    // Pocket targets.
    for (const pk of t.pockets) {
      const q = on0(pk.mouthCenter);
      c.strokeStyle = pk.id === d.pocketId ? PALETTE.target : 'rgba(255,255,255,0.7)';
      c.lineWidth = pk.id === d.pocketId ? 4 : 2;
      c.beginPath();
      c.arc(q.x, q.y, 11, 0, Math.PI * 2);
      c.stroke();
    }
    const circle = (centre: Vec2, r: number, color: string, dash: number[], width: number) => {
      c.strokeStyle = color;
      c.lineWidth = width;
      c.setLineDash(dash);
      c.beginPath();
      for (let k = 0; k <= 24; k++) {
        const a = (k / 24) * Math.PI * 2;
        const q = onR({ x: centre.x + r * Math.cos(a), y: centre.y + r * Math.sin(a) });
        if (k === 0) c.moveTo(q.x, q.y);
        else c.lineTo(q.x, q.y);
      }
      c.stroke();
      c.setLineDash([]);
    };
    // Plan.
    const plan = d.plan;
    const cue = d.balls.find((b) => b.kind === 'cue');
    if (plan && cue && d.showPlan) {
      const poly = (pts: Vec2[], color: string, dash: number[], width: number) => {
        if (pts.length < 2) return;
        c.strokeStyle = color;
        c.lineWidth = width;
        c.setLineDash(dash);
        c.beginPath();
        pts.forEach((p, i) => {
          const q = onR(p);
          if (i === 0) c.moveTo(q.x, q.y);
          else c.lineTo(q.x, q.y);
        });
        c.stroke();
        c.setLineDash([]);
      };
      // Shadow strokes first for contrast on bright cloth.
      poly([cue.pos, plan.ghost], 'rgba(0,0,0,0.5)', [], 7);
      poly([cue.pos, plan.ghost], plan.makeable ? PALETTE.aim : PALETTE.warn, [], 4);
      poly(plan.objectPath.points, 'rgba(0,0,0,0.45)', [], 6);
      poly(plan.objectPath.points, PALETTE.object, DASH.object, 3.5);
      const hit = plan.cuePath.events.find((e) => e.kind === 'ball');
      const pts = plan.cuePath.points;
      const i0 = hit ? Math.max(0, pts.findIndex((p) => Math.hypot(p.x - hit.pos.x, p.y - hit.pos.y) < 1e-6)) : pts.length;
      poly(pts.slice(i0), 'rgba(0,0,0,0.45)', [], 5);
      poly(pts.slice(i0), PALETTE.cue, DASH.cue, 3);
      circle(plan.ghost, R, PALETTE.ghost, DASH.ghost, 2.5);
      if (plan.cueRest) circle(plan.cueRest, R, PALETTE.cue, [2, 3], 2);
    }
    // Detected balls.
    for (const b of d.balls) {
      const isT = b.id === d.targetId;
      circle(b.pos, R * 1.15, isT ? PALETTE.target : b.kind === 'cue' ? '#ffffff' : 'rgba(255,255,255,0.6)', [], isT ? 4 : b.kind === 'cue' ? 3 : 1.5);
    }
  }

  /** Hit-test a tap (CSS px) against balls and pockets using the calibration. */
  static hitTest(tap: Vec2, d: OverlayData, map: FrameMapping): { ball?: Ball; pocket?: PocketId; table?: Vec2 } {
    const cal = d.calibration;
    if (!cal) return {};
    const onR = (p: Vec2) => map.toScreen(applyH(cal.HR, p.x, p.y));
    const on0 = (p: Vec2) => map.toScreen(applyH(cal.H0, p.x, p.y));
    const R = d.table.ballRadius;
    let best: Ball | undefined;
    let bd = Infinity;
    for (const b of d.balls) {
      const q = onR(b.pos);
      const e = onR({ x: b.pos.x + R, y: b.pos.y });
      const rpx = Math.max(14, 2.2 * Math.hypot(e.x - q.x, e.y - q.y));
      const dd = Math.hypot(q.x - tap.x, q.y - tap.y);
      if (dd < rpx && dd < bd) {
        bd = dd;
        best = b;
      }
    }
    if (best) return { ball: best };
    for (const pk of d.table.pockets) {
      const q = on0(pk.mouthCenter);
      if (Math.hypot(q.x - tap.x, q.y - tap.y) < 26) return { pocket: pk.id };
    }
    const f = map.toFrame(tap);
    const p = applyH(invert3(cal.HR), f.x, f.y);
    if (Math.abs(p.x) <= d.table.length / 2 && Math.abs(p.y) <= d.table.width / 2) return { table: p };
    return {};
  }
}
