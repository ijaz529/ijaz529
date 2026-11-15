/**
 * A recording 2D canvas for Node tests of the canvas renderers (TableView, Overlay): every stroked
 * path is kept with its points, arcs, dash pattern, colour and width; every fillText with its text,
 * position and colour; every fillRect/fill with its colour. Enough to check what a renderer draws
 * (and what it no longer draws) without a browser.
 */
import type { Vec2 } from '../../../../src/core/types';

export interface StrokeRec {
  pts: Vec2[];
  arcs: { x: number; y: number; r: number }[];
  dash: number[];
  color: string;
  width: number;
  alpha: number;
}
export interface TextRec {
  text: string;
  x: number;
  y: number;
  color: string;
}
export interface FillRec {
  color: string;
  arcs: { x: number; y: number; r: number }[];
  rect?: { x: number; y: number; w: number; h: number };
}

export function recordingCanvas(w: number, h: number) {
  const strokes: StrokeRec[] = [];
  const texts: TextRec[] = [];
  const fills: FillRec[] = [];
  let path: Vec2[] = [];
  let arcs: { x: number; y: number; r: number }[] = [];
  const st: Record<string, unknown> = {
    strokeStyle: '#000',
    fillStyle: '#000',
    lineWidth: 1,
    globalAlpha: 1,
    font: '',
    lineCap: 'butt',
    lineJoin: 'miter',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    shadowColor: '',
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    imageSmoothingEnabled: true,
  };
  let dash: number[] = [];
  const stack: { st: Record<string, unknown>; dash: number[] }[] = [];
  const grad = { addColorStop() {} };
  const ctx: Record<string, unknown> = {
    save: () => stack.push({ st: { ...st }, dash: [...dash] }),
    restore: () => {
      const s = stack.pop();
      if (s) {
        Object.assign(st, s.st);
        dash = s.dash;
      }
    },
    setLineDash: (d: number[]) => (dash = [...d]),
    getLineDash: () => dash,
    beginPath: () => {
      path = [];
      arcs = [];
    },
    moveTo: (x: number, y: number) => path.push({ x, y }),
    lineTo: (x: number, y: number) => path.push({ x, y }),
    closePath: () => {},
    arc: (x: number, y: number, r: number) => arcs.push({ x, y, r }),
    arcTo: () => {},
    rect: () => {},
    roundRect: () => {},
    ellipse: () => {},
    stroke: () => strokes.push({ pts: path.map((p) => ({ ...p })), arcs: arcs.map((a) => ({ ...a })), dash: [...dash], color: String(st.strokeStyle), width: Number(st.lineWidth), alpha: Number(st.globalAlpha) }),
    fill: () => fills.push({ color: String(st.fillStyle), arcs: arcs.map((a) => ({ ...a })) }),
    clip: () => {},
    fillRect: (x: number, y: number, rw: number, rh: number) => fills.push({ color: String(st.fillStyle), arcs: arcs.map((a) => ({ ...a })), rect: { x, y, w: rw, h: rh } }),
    strokeRect: () => {},
    clearRect: () => {},
    drawImage: () => {},
    fillText: (text: string, x: number, y: number) => texts.push({ text, x, y, color: String(st.fillStyle) }),
    strokeText: () => {},
    measureText: (t: string) => ({ width: t.length * 7 }),
    createRadialGradient: () => grad,
    createLinearGradient: () => grad,
    createPattern: () => null,
    createImageData: (iw: number, ih: number) => ({ data: new Uint8ClampedArray(iw * ih * 4) }),
    putImageData: () => {},
    setTransform: () => {},
    translate: () => {},
    rotate: () => {},
    scale: () => {},
  };
  for (const k of Object.keys(st)) Object.defineProperty(ctx, k, { get: () => st[k], set: (v) => (st[k] = v), enumerable: true });
  const canvas = { width: 0, height: 0, getContext: () => ctx, getBoundingClientRect: () => ({ width: w, height: h, left: 0, top: 0, right: w, bottom: h }) };
  const reset = () => {
    strokes.length = 0;
    texts.length = 0;
    fills.length = 0;
  };
  return { canvas: canvas as unknown as HTMLCanvasElement, strokes, texts, fills, reset };
}

/** A `document` stub whose createElement hands out recording canvases (TableView's cached background). */
export function stubDocument(): void {
  (globalThis as unknown as { document: unknown }).document = { createElement: () => recordingCanvas(64, 64).canvas, activeElement: null };
}

export const sameDash = (a: readonly number[] | undefined, b: readonly number[] | undefined): boolean => !!a && !!b && a.length === b.length && a.every((v, i) => Math.abs(v - b[i]!) < 1e-9);
export const polyLength = (pts: Vec2[]): number => pts.reduce((s, p, i) => (i ? s + Math.hypot(p.x - pts[i - 1]!.x, p.y - pts[i - 1]!.y) : 0), 0);
