/**
 * The 3D table's gesture rules (contracts/render3d-api.md § Gesture rules, tasks T119/T129), on the
 * pure state machine: a fake host records the intents, so every rule is checked without a GPU.
 */
import { describe, expect, it } from 'vitest';
import { DOUBLE_TAP_MS, TAP_MAX_MS, TAP_MAX_PX, WHEEL_K, WHEEL_PINCH_K, createGestures, type GestureHost } from '../../../src/app/render3d/gestures';
import type { Pick3D } from '../../../src/app/render3d/picking';

type Call = [string, ...unknown[]];

function rig(opts: { pick?: (x: number, y: number) => Pick3D; playing?: boolean; drag?: boolean; ready?: boolean; dist?: number } = {}) {
  const calls: Call[] = [];
  let t = 1000;
  let playing = opts.playing ?? false;
  let dist = opts.dist ?? 2;
  const host: GestureHost<string> = {
    now: () => t,
    pick: (x, y) => (opts.pick ? opts.pick(x, y) : { kind: 'cloth', pos: { x, y } }),
    isPlaying: () => playing,
    canDragBalls: () => opts.drag ?? true,
    cameraReady: () => opts.ready ?? true,
    distance: () => dist,
    releasePointer: (id) => calls.push(['release', id]),
    tap: (hit, ev) => calls.push(['tap', hit, ev]),
    doubleTap: () => calls.push(['doubleTap']),
    skipPlayback: () => calls.push(['skip']),
    custom: () => calls.push(['custom']),
    orbit: (dx, dy) => calls.push(['orbit', dx, dy]),
    pan: (dx, dy) => calls.push(['pan', dx, dy]),
    zoomTo: (d) => {
      dist = d;
      calls.push(['zoomTo', d]);
    },
    zoomBy: (f) => calls.push(['zoomBy', f]),
    ballDrag: (phase, id, x, y) => calls.push(['ball', phase, id, x, y]),
    endBallDrag: () => calls.push(['endBall']),
  };
  const g = createGestures(host);
  return {
    g,
    calls,
    names: () => calls.map((c) => c[0]),
    advance: (ms: number) => (t += ms),
    setPlaying: (p: boolean) => (playing = p),
  };
}

const ballAt = (cx: number, cy: number, id = 'b1') => (x: number, y: number): Pick3D => (Math.hypot(x - cx, y - cy) < 10 ? { kind: 'ball', id } : { kind: 'cloth', pos: { x, y } });

describe('render3d gestures (pure state machine)', () => {
  it('a short, still press is a tap on what is under it, with the original event', () => {
    const r = rig({ pick: ballAt(100, 100) });
    r.g.down({ id: 1, x: 100, y: 100 });
    r.advance(120);
    r.g.move({ id: 1, x: 103, y: 102 });
    r.g.up({ id: 1, x: 103, y: 102, ev: 'pointerup#1' });
    expect(r.calls).toEqual([
      ['release', 1],
      ['tap', { kind: 'ball', id: 'b1' }, 'pointerup#1'],
    ]);
    expect(r.g.mode()).toBe('none');
  });

  it('a press held too long, or moved too far, is not a tap', () => {
    const slow = rig();
    slow.g.down({ id: 1, x: 10, y: 10 });
    slow.advance(TAP_MAX_MS + 1);
    slow.g.up({ id: 1, x: 10, y: 10 });
    expect(slow.names()).toEqual(['release']);
    const cancel = rig();
    cancel.g.down({ id: 1, x: 10, y: 10 });
    cancel.g.up({ id: 1, x: 10, y: 10, cancel: true });
    expect(cancel.names()).toEqual(['release']);
  });

  it('dragging on the cloth orbits (after the 8 px tap slop) and leaves the preset once', () => {
    const r = rig();
    r.g.down({ id: 1, x: 50, y: 50 });
    r.g.move({ id: 1, x: 54, y: 50 }); // still within the tap slop: nothing yet
    expect(r.calls).toEqual([]);
    r.g.move({ id: 1, x: 50 + TAP_MAX_PX, y: 50 });
    r.g.move({ id: 1, x: 70, y: 45 });
    expect(r.calls).toEqual([
      ['custom'],
      ['orbit', TAP_MAX_PX - 4, 0],
      ['orbit', 20 - TAP_MAX_PX, -5],
    ]);
    expect(r.g.mode()).toBe('orbit');
    expect(r.g.steering()).toBe(true);
    r.g.up({ id: 1, x: 70, y: 45 });
    expect(r.names().at(-1)).toBe('release');
    expect(r.names()).not.toContain('tap');
    expect(r.g.steering()).toBe(false);
  });

  it('right-button or Shift drags pan, even when they start on a ball', () => {
    for (const p of [{ button: 2 }, { shift: true }]) {
      const r = rig({ pick: ballAt(100, 100) });
      r.g.down({ id: 1, x: 100, y: 100, ...p });
      r.g.move({ id: 1, x: 112, y: 100 });
      expect(r.calls).toEqual([['custom'], ['pan', 12, 0]]);
      expect(r.g.mode()).toBe('pan');
    }
  });

  it('a drag that starts on a ball moves the ball (start, moves, end), and never orbits', () => {
    const r = rig({ pick: ballAt(100, 100) });
    r.g.down({ id: 1, x: 100, y: 100 });
    r.g.move({ id: 1, x: 110, y: 100 });
    r.g.move({ id: 1, x: 130, y: 90 });
    r.g.up({ id: 1, x: 130, y: 90 });
    expect(r.calls).toEqual([
      ['ball', 'start', 'b1', 110, 100],
      ['ball', 'move', 'b1', 110, 100],
      ['ball', 'move', 'b1', 130, 90],
      ['release', 1],
      ['endBall'],
    ]);
    expect(r.g.steering()).toBe(false);
  });

  it('a pointercancel during a ball drag ends the drag (end, no tap), and the next press starts afresh', () => {
    const r = rig({ pick: ballAt(100, 100) });
    r.g.down({ id: 1, x: 100, y: 100 });
    r.g.move({ id: 1, x: 112, y: 100 });
    // The system takes the pointer (a notification, a scroll, the home gesture): back at the start point
    // it would look like a tap, but a cancel is never one.
    r.g.up({ id: 1, x: 100, y: 100, cancel: true });
    expect(r.calls).toEqual([
      ['ball', 'start', 'b1', 112, 100],
      ['ball', 'move', 'b1', 112, 100],
      ['release', 1],
      ['endBall'],
    ]);
    expect(r.g.mode()).toBe('none');
    expect(r.g.steering()).toBe(false);
    // Nothing is left over: a later move of that pointer does nothing, a new press is a plain tap.
    r.calls.length = 0;
    r.g.move({ id: 1, x: 140, y: 100 });
    expect(r.calls).toEqual([]);
    r.g.down({ id: 2, x: 100, y: 100 });
    r.g.up({ id: 2, x: 100, y: 100, ev: 'pointerup#2' });
    expect(r.calls).toEqual([
      ['release', 2],
      ['tap', { kind: 'ball', id: 'b1' }, 'pointerup#2'],
    ]);
  });

  it('a pointercancel ends an orbit or a pinch without a tap', () => {
    const orbit = rig();
    orbit.g.down({ id: 1, x: 50, y: 50 });
    orbit.g.move({ id: 1, x: 70, y: 50 });
    orbit.g.up({ id: 1, x: 50, y: 50, cancel: true });
    expect(orbit.names()).toEqual(['custom', 'orbit', 'release']);
    expect(orbit.g.mode()).toBe('none');
    const pinch = rig();
    pinch.g.down({ id: 1, x: 0, y: 0 });
    pinch.g.down({ id: 2, x: 100, y: 0 });
    pinch.g.up({ id: 1, x: 0, y: 0, cancel: true });
    pinch.g.up({ id: 2, x: 100, y: 0, cancel: true });
    expect(pinch.names()).toEqual(['endBall', 'custom', 'release', 'release']);
    expect(pinch.g.mode()).toBe('none');
    expect(pinch.g.steering()).toBe(false);
  });

  it('without ball dragging (no listener) a drag on a ball orbits instead', () => {
    const r = rig({ pick: ballAt(100, 100), drag: false });
    r.g.down({ id: 1, x: 100, y: 100 });
    r.g.move({ id: 1, x: 110, y: 100 });
    expect(r.names()).toEqual(['custom', 'orbit']);
  });

  it('two pointers pinch: zoom from the distance at the start, pan with the midpoint; a ball drag in progress ends', () => {
    const r = rig({ pick: ballAt(100, 100), dist: 2 });
    r.g.down({ id: 1, x: 100, y: 100 });
    r.g.move({ id: 1, x: 112, y: 100 }); // ball drag starts
    r.g.down({ id: 2, x: 212, y: 100 }); // d0 = 100
    expect(r.names()).toEqual(['ball', 'ball', 'endBall', 'custom']);
    expect(r.g.mode()).toBe('pinch');
    r.calls.length = 0;
    r.g.move({ id: 2, x: 262, y: 100 }); // d = 150, midpoint +25
    expect(r.calls[0]![0]).toBe('zoomTo');
    expect(r.calls[0]![1]).toBeCloseTo((2 * 100) / 150, 12);
    expect(r.calls[1]).toEqual(['pan', 25, 0]);
    // Lifting one finger ends the pinch without a tap; the other finger does nothing more.
    r.g.up({ id: 2, x: 262, y: 100 });
    expect(r.g.mode()).toBe('none');
    r.calls.length = 0;
    r.g.move({ id: 1, x: 140, y: 100 });
    r.g.up({ id: 1, x: 140, y: 100 });
    expect(r.names()).toEqual(['release']);
  });

  it('a third pointer is ignored', () => {
    const r = rig();
    r.g.down({ id: 1, x: 0, y: 0 });
    r.g.down({ id: 2, x: 100, y: 0 });
    r.calls.length = 0;
    r.g.down({ id: 3, x: 50, y: 50 });
    expect(r.calls).toEqual([]);
    expect(r.g.mode()).toBe('pinch');
  });

  it('a double tap on empty cloth goes back to the preset; on a ball it is two taps', () => {
    const r = rig({ pick: ballAt(300, 300) });
    const tap = (x: number, y: number) => {
      r.g.down({ id: 1, x, y });
      r.advance(40);
      r.g.up({ id: 1, x, y });
    };
    tap(50, 50);
    r.advance(DOUBLE_TAP_MS - 100);
    tap(60, 55);
    expect(r.names().filter((n) => n !== 'release')).toEqual(['tap', 'doubleTap']);
    // Too slow: two single taps.
    r.calls.length = 0;
    tap(50, 50);
    r.advance(DOUBLE_TAP_MS + 10);
    tap(50, 50);
    expect(r.names().filter((n) => n !== 'release')).toEqual(['tap', 'tap']);
    // Too far apart: two single taps.
    r.calls.length = 0;
    r.advance(1000);
    tap(50, 50);
    tap(120, 50);
    expect(r.names().filter((n) => n !== 'release')).toEqual(['tap', 'tap']);
    // On a ball: always taps (selection), never a camera reset.
    r.calls.length = 0;
    r.advance(1000);
    tap(300, 300);
    tap(300, 300);
    expect(r.names().filter((n) => n !== 'release')).toEqual(['tap', 'tap']);
  });

  it('while a replay runs a tap skips it (nothing is picked or dragged)', () => {
    const r = rig({ pick: ballAt(100, 100), playing: true });
    r.g.down({ id: 1, x: 100, y: 100 });
    r.g.up({ id: 1, x: 100, y: 100 });
    expect(r.names()).toEqual(['release', 'skip']);
    // A drag on a ball during the replay orbits (no ball was picked at the press).
    r.calls.length = 0;
    r.g.down({ id: 1, x: 100, y: 100 });
    r.g.move({ id: 1, x: 120, y: 100 });
    expect(r.names()).toEqual(['custom', 'orbit']);
  });

  it('the wheel zooms (finer for a Ctrl+wheel trackpad pinch, lines count 16 px) once the camera is ready', () => {
    const r = rig();
    expect(r.g.wheel({ deltaY: 100 })).toBe(true);
    expect(r.calls[0]).toEqual(['custom']);
    expect(r.calls[1]![1]).toBeCloseTo(Math.exp(100 * WHEEL_K), 12);
    r.calls.length = 0;
    r.g.wheel({ deltaY: -3, deltaMode: 1 });
    expect(r.calls[1]![1]).toBeCloseTo(Math.exp(-48 * WHEEL_K), 12);
    r.calls.length = 0;
    r.g.wheel({ deltaY: 10, ctrl: true });
    expect(r.calls[1]![1]).toBeCloseTo(Math.exp(10 * WHEEL_PINCH_K), 12);
    const notReady = rig({ ready: false });
    expect(notReady.g.wheel({ deltaY: 100 })).toBe(false);
    expect(notReady.calls).toEqual([]);
  });

  it('moves and ups of an unknown pointer are ignored', () => {
    const r = rig();
    r.g.move({ id: 9, x: 1, y: 1 });
    r.g.up({ id: 9, x: 1, y: 1 });
    expect(r.calls).toEqual([]);
  });
});
