/**
 * Gesture state machine of the 3D table (pure: no DOM, no WebGL; contracts/render3d-api.md § Gesture
 * rules). It turns pointer and wheel input into intents the renderer carries out:
 *
 * | Input | Intent |
 * |---|---|
 * | Tap: movement < 8 px and < 350 ms | `tap(pick)`; while a replay runs, `skipPlayback()` instead |
 * | Second tap on empty cloth within 320 ms and 30 px | `doubleTap()` (back to the last preset) |
 * | Drag that starts on a ball (when ball dragging is on) | `ballDrag('start' | 'move' | 'end')` |
 * | Drag on empty cloth / background | `custom()` once, then `orbit(dx, dy)` per move |
 * | Right-button or Shift drag | `custom()` once, then `pan(dx, dy)` per move |
 * | Two pointers | `custom()`, then `zoomTo(dist0 · d0 / d)` and `pan(midpoint motion)` |
 * | Wheel | `custom()`, then `zoomBy(exp(dy · k))` (k = 0.01 with Ctrl, i.e. a trackpad pinch) |
 *
 * The host answers the few questions the machine needs (what is under a point, whether a replay
 * runs, the camera distance) and owns pointer capture, `preventDefault` and drawing.
 */
import type { Pick3D } from './picking';

export const TAP_MAX_PX = 8;
export const TAP_MAX_MS = 350;
export const DOUBLE_TAP_MS = 320;
export const DOUBLE_TAP_PX = 30;
/** Wheel zoom per pixel of scroll (and per "pixel" of a Ctrl+wheel trackpad pinch). */
export const WHEEL_K = 0.0015;
export const WHEEL_PINCH_K = 0.01;

export type GestureMode = 'none' | 'pending' | 'orbit' | 'pan' | 'ball' | 'pinch';

export interface PointerInput<E = unknown> {
  id: number;
  x: number;
  y: number;
  /** Mouse button (2 = right) and the Shift key: either starts a pan instead of an orbit. */
  button?: number;
  shift?: boolean;
  /** pointercancel: ends the gesture without a tap. */
  cancel?: boolean;
  /** The original event, handed back with `tap`. */
  ev?: E;
}

export interface WheelInput {
  deltaY: number;
  /** 1 = lines (×16 px), else pixels. */
  deltaMode?: number;
  ctrl?: boolean;
}

export interface GestureHost<E = unknown> {
  now(): number;
  /** What is under the point (client px). */
  pick(x: number, y: number): Pick3D;
  isPlaying(): boolean;
  /** Ball dragging is on (the app listens for it). */
  canDragBalls(): boolean;
  /** The renderer can take camera input (it has a table and a camera). */
  cameraReady(): boolean;
  /** Current camera distance (for pinch). */
  distance(): number;
  releasePointer?(id: number): void;
  // Intents
  tap(hit: Pick3D, ev: E | undefined): void;
  doubleTap(): void;
  skipPlayback(): void;
  /** Leave the preset: the camera becomes 'custom'. */
  custom(): void;
  orbit(dx: number, dy: number): void;
  pan(dx: number, dy: number): void;
  zoomTo(dist: number): void;
  zoomBy(factor: number): void;
  ballDrag(phase: 'start' | 'move', id: string, x: number, y: number): void;
  /** Ends a ball drag in progress (no-op when none). */
  endBallDrag(): void;
}

interface Ptr {
  x: number;
  y: number;
  sx: number;
  sy: number;
  t0: number;
}

export interface Gestures<E = unknown> {
  down(p: PointerInput<E>): void;
  move(p: PointerInput<E>): void;
  up(p: PointerInput<E>): void;
  /** Returns true when the wheel was used (the caller then prevents the page from scrolling). */
  wheel(w: WheelInput): boolean;
  mode(): GestureMode;
  /** The camera is being moved by hand (orbit, pan or pinch). */
  steering(): boolean;
}

export function createGestures<E = unknown>(host: GestureHost<E>): Gestures<E> {
  const ptrs = new Map<number, Ptr>();
  let mode: GestureMode = 'none';
  let pendingBall: string | null = null;
  let panButton = false;
  let pinch: { d0: number; dist0: number; mx: number; my: number } | null = null;
  let lastTap: { t: number; x: number; y: number; empty: boolean } | null = null;

  const firstTwo = () => [...ptrs.values()] as [Ptr, Ptr];

  function down(e: PointerInput<E>): void {
    ptrs.set(e.id, { x: e.x, y: e.y, sx: e.x, sy: e.y, t0: host.now() });
    if (ptrs.size === 1) {
      mode = 'pending';
      panButton = e.button === 2 || !!e.shift;
      const p = host.isPlaying() ? null : host.pick(e.x, e.y);
      pendingBall = p && p.kind === 'ball' && !panButton ? p.id : null;
    } else if (ptrs.size === 2) {
      host.endBallDrag();
      mode = 'pinch';
      const [a, b] = firstTwo();
      pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, dist0: host.distance(), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
      host.custom();
    }
  }

  function move(e: PointerInput<E>): void {
    const p = ptrs.get(e.id);
    if (!p) return;
    const dx = e.x - p.x;
    const dy = e.y - p.y;
    p.x = e.x;
    p.y = e.y;
    if (mode === 'pending' && Math.hypot(p.x - p.sx, p.y - p.sy) >= TAP_MAX_PX) {
      if (pendingBall && host.canDragBalls()) {
        mode = 'ball';
        host.ballDrag('start', pendingBall, e.x, e.y);
      } else {
        mode = panButton ? 'pan' : 'orbit';
        host.custom();
      }
    }
    if (mode === 'orbit') host.orbit(dx, dy);
    else if (mode === 'pan') host.pan(dx, dy);
    else if (mode === 'ball' && pendingBall) host.ballDrag('move', pendingBall, e.x, e.y);
    else if (mode === 'pinch' && pinch && ptrs.size >= 2) {
      const [a, b] = firstTwo();
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      host.zoomTo((pinch.dist0 * pinch.d0) / d);
      host.pan(mx - pinch.mx, my - pinch.my);
      pinch.mx = mx;
      pinch.my = my;
    }
  }

  function up(e: PointerInput<E>): void {
    const p = ptrs.get(e.id);
    if (!p) return;
    ptrs.delete(e.id);
    host.releasePointer?.(e.id);
    const wasMode = mode;
    if (wasMode === 'ball') host.endBallDrag();
    if (ptrs.size === 0) {
      mode = 'none';
      pinch = null;
    } else if (wasMode === 'pinch') {
      mode = 'none';
    }
    if (wasMode !== 'pending' || e.cancel) return;
    const t = host.now();
    if (Math.hypot(e.x - p.sx, e.y - p.sy) >= TAP_MAX_PX || t - p.t0 > TAP_MAX_MS) return;
    if (host.isPlaying()) {
      host.skipPlayback();
      return;
    }
    const hit = host.pick(e.x, e.y);
    const empty = !hit || hit.kind === 'cloth';
    if (empty && lastTap && lastTap.empty && t - lastTap.t < DOUBLE_TAP_MS && Math.hypot(e.x - lastTap.x, e.y - lastTap.y) < DOUBLE_TAP_PX) {
      lastTap = null;
      host.doubleTap();
      return;
    }
    lastTap = { t, x: e.x, y: e.y, empty };
    host.tap(hit, e.ev);
  }

  function wheel(w: WheelInput): boolean {
    if (!host.cameraReady()) return false;
    const k = w.ctrl ? WHEEL_PINCH_K : WHEEL_K;
    const dyPx = w.deltaMode === 1 ? w.deltaY * 16 : w.deltaY;
    host.custom();
    host.zoomBy(Math.exp(dyPx * k));
    return true;
  }

  return {
    down,
    move,
    up,
    wheel,
    mode: () => mode,
    steering: () => mode === 'orbit' || mode === 'pan' || mode === 'pinch',
  };
}
