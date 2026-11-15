/**
 * Perspective AR overlay on the live camera image (FR-023). Lines on the cloth go through H0; ball
 * centres, paths and the ghost ball go through HR (plane at ball-centre height).
 * Look: every line has a dark halo and a soft glow in its palette colour, the ghost ball is a shaded
 * translucent sphere with the dotted ring, labels are crisp text on a dark halo.
 */
import type { Ball, PocketId, ShotPlan, TableSpec, Vec2 } from '../../core/types';
import type { Calibration } from '../../vision/calibration';
import { applyH, invert3 } from '../../vision/homography';
import { DASH, HIT_RADIUS_PX, PALETTE, UI } from './palette';

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

/** Pocket pick radius around the mouth centre, CSS px. */
const POCKET_PICK_PX = 26;

export class Overlay {
  private ctx: CanvasRenderingContext2D;
  private cssW = 0;
  private cssH = 0;
  /** Label boxes placed this frame (simple collision avoidance). */
  private placed: { x: number; y: number; w: number; h: number }[] = [];
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
    this.cssW = w;
    this.cssH = h;
    return { w, h };
  }

  draw(d: OverlayData, map: FrameMapping): void {
    const { w, h } = this.resize();
    const c = this.ctx;
    c.clearRect(0, 0, w, h);
    this.placed = [];
    c.lineCap = 'round';
    c.lineJoin = 'round';
    // Manual calibration taps: numbered rings.
    d.calibTaps.forEach((t, i) => {
      const q = map.toScreen(t);
      this.ring(q, 11, PALETTE.pocket, 3, 8);
      this.label(String(i + 1), { x: q.x + 15, y: q.y - 12 });
    });
    const cal = d.calibration;
    if (!cal) return;
    const t = d.table;
    const R = t.ballRadius;
    const on0 = (p: Vec2) => map.toScreen(applyH(cal.H0, p.x, p.y));
    const onR = (p: Vec2) => map.toScreen(applyH(cal.HR, p.x, p.y));
    // Playing-surface outline.
    const hx = t.length / 2;
    const hy = t.width / 2;
    const outline = [
      { x: -hx, y: -hy },
      { x: hx, y: -hy },
      { x: hx, y: hy },
      { x: -hx, y: hy },
      { x: -hx, y: -hy },
    ].map(on0);
    this.screenPoly(outline, 'rgba(255,255,255,0.42)', [], 1.25, 0, UI.halo, 3);
    // Pocket targets: faint rings, the chosen pocket glows.
    for (const pk of t.pockets) {
      const q = on0(pk.mouthCenter);
      if (pk.id === d.pocketId) {
        this.ring(q, 13, PALETTE.pocket, 3.5, 14);
        this.ring(q, 7, '#FFFFFF', 1.5, 0);
      } else this.ring(q, 11, 'rgba(255,255,255,0.6)', 1.5, 0);
    }
    const circlePts = (centre: Vec2, r: number, n = 28) => {
      const out: Vec2[] = [];
      for (let k = 0; k <= n; k++) {
        const a = (k / n) * Math.PI * 2;
        out.push(onR({ x: centre.x + r * Math.cos(a), y: centre.y + r * Math.sin(a) }));
      }
      return out;
    };
    // Plan.
    const plan = d.plan;
    const cue = d.balls.find((b) => b.kind === 'cue');
    if (plan && cue && d.showPlan) {
      for (const o of plan.otherPaths) this.screenPoly(o.points.map(onR), PALETTE.other, DASH.other, 2, 4, UI.halo, 4);
      this.screenPoly(plan.objectPath.points.map(onR), PALETTE.object, DASH.object, 3.5, 8, UI.halo, 7);
      const hit = plan.cuePath.events.find((e) => e.kind === 'ball');
      const pts = plan.cuePath.points;
      const i0 = hit ? Math.max(0, pts.findIndex((p) => Math.hypot(p.x - hit.pos.x, p.y - hit.pos.y) < 1e-6)) : pts.length;
      this.screenPoly(pts.slice(i0).map(onR), PALETTE.cue, DASH.cue, 3, 8, UI.halo, 6);
      this.screenPoly([cue.pos, plan.ghost].map(onR), plan.makeable ? PALETTE.aim : PALETTE.warn, [], 4, 10, UI.halo, 6);
      // Ghost ball: a shaded translucent sphere with a dotted ring.
      const ring = circlePts(plan.ghost, R);
      const g = onR(plan.ghost);
      const gr = ring.reduce((acc, q) => acc + Math.hypot(q.x - g.x, q.y - g.y), 0) / ring.length;
      c.save();
      const fill = c.createRadialGradient(g.x - gr * 0.35, g.y - gr * 0.4, gr * 0.05, g.x, g.y, gr * 1.05);
      fill.addColorStop(0, 'rgba(255,255,255,0.6)');
      fill.addColorStop(0.7, 'rgba(255,255,255,0.18)');
      fill.addColorStop(1, 'rgba(255,255,255,0.05)');
      c.fillStyle = fill;
      c.beginPath();
      ring.forEach((q, i) => (i ? c.lineTo(q.x, q.y) : c.moveTo(q.x, q.y)));
      c.fill();
      c.restore();
      this.screenPoly(ring, PALETTE.ghost, DASH.ghost, 2.5, 0, UI.halo, 5);
      // Contact point on the object ball.
      const cp = onR(plan.contactPoint);
      c.save();
      c.fillStyle = PALETTE.warn;
      c.strokeStyle = '#FFFFFF';
      c.lineWidth = 1.5;
      c.beginPath();
      c.arc(cp.x, cp.y, 4.5, 0, Math.PI * 2);
      c.fill();
      c.stroke();
      c.restore();
      // Ghost label on the side away from the aim line.
      const a = onR(cue.pos);
      const L = Math.hypot(g.x - a.x, g.y - a.y) || 1;
      const nx = -(g.y - a.y) / L;
      const ny = (g.x - a.x) / L;
      const side = nx >= 0 ? 1 : -1;
      const text = plan.makeable ? `${plan.cutAngleDeg.toFixed(0)}° · ${plan.fractionLabel} ball` : 'Not makeable';
      this.label(text, { x: g.x + nx * side * (gr + 12), y: g.y + ny * side * (gr + 12) }, plan.makeable ? UI.text : '#FFAB7A', side < 0 ? 'right' : 'left');
      if (plan.cueRest) {
        this.screenPoly(circlePts(plan.cueRest, R), PALETTE.cue, [2, 3], 2, 0, UI.halo, 4);
        const q = onR(plan.cueRest);
        this.label('Cue stops', { x: q.x + gr + 8, y: q.y });
      }
    }
    // Detected balls.
    for (const b of d.balls) {
      const isT = b.id === d.targetId;
      const pts = circlePts(b.pos, R * 1.15, 24);
      if (isT) this.screenPoly(pts, PALETTE.target, [], 3.5, 12, UI.halo, 6);
      else if (b.kind === 'cue') this.screenPoly(pts, '#FFFFFF', [], 2.5, 6, UI.halo, 5);
      else this.screenPoly(pts, 'rgba(255,255,255,0.62)', [], 1.5, 0, UI.halo, 3);
    }
  }

  /** A screen-space polyline with a halo underneath and an optional coloured glow. */
  private screenPoly(pts: Vec2[], color: string, dash: number[], width: number, glow: number, halo: string, haloExtra: number): void {
    if (pts.length < 2) return;
    const c = this.ctx;
    c.save();
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.beginPath();
    pts.forEach((q, i) => (i ? c.lineTo(q.x, q.y) : c.moveTo(q.x, q.y)));
    c.strokeStyle = halo;
    c.lineWidth = width + haloExtra;
    c.stroke();
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

  private ring(q: Vec2, r: number, color: string, width: number, glow: number): void {
    const c = this.ctx;
    c.save();
    c.beginPath();
    c.arc(q.x, q.y, r, 0, Math.PI * 2);
    c.strokeStyle = UI.halo;
    c.lineWidth = width + 3;
    c.stroke();
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
   * A glass pill label (the Snap and 3D label style: rgba(7,11,20,.78), 1 px strong border, 12 px/700),
   * kept inside the canvas and clear of the labels already placed.
   */
  private label(text: string, q: Vec2, color: string = UI.text, align: 'left' | 'right' = 'left'): void {
    const c = this.ctx;
    c.save();
    c.font = `700 12px -apple-system, 'SF Pro Text', system-ui, sans-serif`;
    c.textBaseline = 'middle';
    c.textAlign = 'left';
    const tw = c.measureText(text).width;
    const padX = 8;
    const w = tw + padX * 2;
    const h = 22;
    const x = Math.min(this.cssW - w - 6, Math.max(6, align === 'right' ? q.x - w : q.x - padX));
    let y = Math.min(this.cssH - h / 2 - 4, Math.max(h / 2 + 4, q.y));
    const hit = (yy: number) => this.placed.some((b) => x < b.x + b.w && x + w > b.x && yy - h / 2 < b.y + b.h && yy + h / 2 > b.y);
    for (let k = 1; k <= 6 && hit(y); k++) y = Math.min(this.cssH - h / 2 - 4, Math.max(h / 2 + 4, q.y + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * (h + 4)));
    this.placed.push({ x, y: y - h / 2, w, h });
    const r = h / 2;
    c.beginPath();
    c.moveTo(x + r, y - r);
    c.arcTo(x + w, y - r, x + w, y + r, r);
    c.arcTo(x + w, y + r, x, y + r, r);
    c.arcTo(x, y + r, x, y - r, r);
    c.arcTo(x, y - r, x + w, y - r, r);
    c.closePath();
    c.fillStyle = 'rgba(7,11,20,0.78)';
    c.fill();
    c.lineWidth = 1;
    c.strokeStyle = 'rgba(255,255,255,0.16)';
    c.stroke();
    c.fillStyle = color;
    c.fillText(text, x + padX, y + 0.5);
    c.restore();
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
    let natural = false;
    for (const b of d.balls) {
      const q = onR(b.pos);
      const e = onR({ x: b.pos.x + R, y: b.pos.y });
      const rNat = Math.max(14, 2.2 * Math.hypot(e.x - q.x, e.y - q.y));
      // At least a 44 CSS px target (22 px radius) for small, far balls; the nearest ball wins.
      const rpx = Math.max(HIT_RADIUS_PX, rNat);
      const dd = Math.hypot(q.x - tap.x, q.y - tap.y);
      if (dd < rpx && dd < bd) {
        bd = dd;
        best = b;
        natural = dd < rNat;
      }
    }
    let pocket: PocketId | undefined;
    let pd = POCKET_PICK_PX;
    for (const pk of d.table.pockets) {
      const q = on0(pk.mouthCenter);
      const dd = Math.hypot(q.x - tap.x, q.y - tap.y);
      if (dd < pd) {
        pd = dd;
        pocket = pk.id;
      }
    }
    // A ball reached only through the 22 px floor yields to a pocket mouth nearer the tap (a ball
    // a few cm from a pocket must not swallow taps on that pocket).
    if (best && (natural || !pocket || bd <= pd)) return { ball: best };
    if (pocket) return { pocket };
    const f = map.toFrame(tap);
    const p = applyH(invert3(cal.HR), f.x, f.y);
    if (Math.abs(p.x) <= d.table.length / 2 && Math.abs(p.y) <= d.table.width / 2) return { table: p };
    return {};
  }
}
