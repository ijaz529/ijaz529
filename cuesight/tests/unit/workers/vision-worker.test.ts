/**
 * The vision worker's handler (src/workers/vision.worker.ts), run in Node:
 *  - 'reset' forgets the table and the tracks but keeps issuing new ball ids (pipeline.reset(), wave-1
 *    item 21): ids held by the app never come to name another ball;
 *  - a still's `opts.fovDeg` (StillOptions) is the lens hint for that photo, over the latest config's.
 */
import { describe, expect, it } from 'vitest';
import { makeTable } from '../../../src/core/table';
import type { Frame } from '../../../src/vision/image';
import { BALL_COLORS, renderSyntheticTable, type SynthCamera } from '../../../src/vision/synth/render';
import { PROTOCOL_VERSION, type VisionIn, type VisionOut } from '../../../src/workers/protocol';
import { createVisionHandler, processStill } from '../../../src/workers/vision.worker';

const table = makeTable('pool9');
const balls = [
  { pos: { x: -0.7, y: -0.1 }, color: BALL_COLORS.cue! },
  { pos: { x: 0.3, y: 0.15 }, color: BALL_COLORS.yellow! },
  { pos: { x: -0.25, y: 0.4 }, color: BALL_COLORS.red! },
  { pos: { x: 0.95, y: -0.05 }, color: BALL_COLORS.blue! },
];
const corner: SynthCamera = { pos: { x: -2.25, y: -1.5, z: 1.8 }, target: { x: 0.15, y: 0.05, z: 0 }, fovDeg: 66 };
const render = (camera: SynthCamera, width = 640, height = 360): Frame => renderSyntheticTable({ table, balls, camera, width, height });

describe("vision worker 'reset'", () => {
  it('starts the table and the tracks over but never re-issues a ball id', () => {
    const handle = createVisionHandler();
    const send = (msg: VisionIn): VisionOut | null => {
      const reply = handle(msg);
      return reply ? reply.msg : null;
    };
    const f = render(corner);
    let id = 0;
    const frame = () => {
      const out = send({ v: PROTOCOL_VERSION, type: 'frame', id: ++id, width: f.width, height: f.height, buffer: f.data.slice().buffer });
      if (out?.type !== 'result') throw new Error(`unexpected reply ${out?.type}`);
      return out.result;
    };
    expect(send({ v: PROTOCOL_VERSION, type: 'config', table, fovDeg: 66, manualCorners: null, swapAxes: false })).toBeNull();
    let r = frame();
    for (let k = 0; k < 12 && !(r.status === 'locked' && r.balls.length >= 3); k++) r = frame();
    expect(r.status).toBe('locked');
    const num = (ids: string[]) => ids.filter((x) => /^b\d+$/.test(x)).map((x) => Number(x.slice(1)));
    const before = num(r.balls.map((b) => b.id));
    expect(before.length).toBeGreaterThanOrEqual(2);
    expect(send({ v: PROTOCOL_VERSION, type: 'reset' })).toBeNull();
    // The lock starts over (no stale table is reported as locked) …
    r = frame();
    expect(r.status).not.toBe('locked');
    for (let k = 0; k < 12 && !(r.status === 'locked' && r.balls.length >= 3); k++) r = frame();
    expect(r.status).toBe('locked');
    // … and the same balls come back under new ids, above every id issued before.
    const after = num(r.balls.map((b) => b.id));
    expect(after.length).toBe(before.length);
    expect(Math.min(...after)).toBeGreaterThan(Math.max(...before));
  });
});

describe('still: StillOptions.fovDeg is the lens hint for that photo', () => {
  // Straight down at the table: no perspective to estimate a focal length from, so the hint decides it.
  const top: SynthCamera = { pos: { x: 0, y: -0.02, z: 2.6 }, target: { x: 0, y: 0, z: 0 }, fovDeg: 75 };
  const cfg = (fovDeg: number) => ({ table, fovDeg, manualCorners: null, swapAxes: false });

  it('wins over the latest config (as if the config had said it), and an unusable hint falls back to the config', () => {
    const f = render(top, 960, 540);
    const asConfig = processStill(f, cfg(75));
    expect(asConfig.calibration).not.toBeNull();
    expect(asConfig.calibration!.focalSource).toBe('assumed'); // not vacuous: the hint matters here
    const hinted = processStill(f, cfg(50), { fovDeg: 75 });
    expect(hinted.calibration!.focal).toBeCloseTo(asConfig.calibration!.focal, 6);
    const other = processStill(f, cfg(50));
    expect(Math.abs(other.calibration!.focal - asConfig.calibration!.focal)).toBeGreaterThan(50);
    // NaN / missing: the config's figure.
    expect(processStill(f, cfg(50), { fovDeg: Number.NaN }).calibration!.focal).toBeCloseTo(other.calibration!.focal, 6);
    expect(processStill(f, cfg(50), {}).calibration!.focal).toBeCloseTo(other.calibration!.focal, 6);
  });

  it("the 'still' message carries it", () => {
    const handle = createVisionHandler();
    handle({ v: PROTOCOL_VERSION, type: 'config', table, fovDeg: 50, manualCorners: null, swapAxes: false });
    const f = render(top, 960, 540);
    const reply = handle({ v: PROTOCOL_VERSION, type: 'still', id: 1, frame: f, opts: { fovDeg: 75 } });
    expect(reply?.msg.type).toBe('still');
    const r = (reply!.msg as Extract<VisionOut, { type: 'still' }>).result;
    expect(r.calibration!.focal).toBeCloseTo(processStill(f, cfg(75)).calibration!.focal, 6);
  });
});
