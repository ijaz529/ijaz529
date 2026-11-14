import { makeTable } from '../../src/core/table';
import type { TablePresetId } from '../../src/core/types';
import { fixtureBalls, type RGB, type SynthCamera, type SynthScene } from '../../src/vision/synth/render';

export const POSES: Record<string, SynthCamera> = {
  end: { pos: { x: -2.6, y: 0.0, z: 1.65 }, target: { x: 0.2, y: 0, z: 0 }, fovDeg: 66 },
  side: { pos: { x: 0.2, y: -2.05, z: 1.9 }, target: { x: 0, y: 0.08, z: 0 }, fovDeg: 68 },
  corner: { pos: { x: -2.25, y: -1.5, z: 1.8 }, target: { x: 0.15, y: 0.05, z: 0 }, fovDeg: 66 },
  overhead: { pos: { x: 0.0, y: -0.35, z: 2.7 }, target: { x: 0, y: 0, z: 0 }, fovDeg: 64 },
};

export function scene(pose: keyof typeof POSES, opts: { cloth?: RGB; preset?: TablePresetId; width?: number; height?: number; ss?: number } = {}): SynthScene {
  const table = makeTable(opts.preset ?? 'pool9');
  return {
    table,
    balls: fixtureBalls(table).balls,
    camera: POSES[pose]!,
    width: opts.width ?? 640,
    height: opts.height ?? 480,
    ss: opts.ss ?? 2,
    ...(opts.cloth ? { cloth: opts.cloth } : {}),
  };
}
