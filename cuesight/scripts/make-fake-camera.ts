/**
 * Renders a synthetic table and writes it as a Y4M (YUV 4:2:0) video that Chromium can use as a
 * fake camera (--use-file-for-fake-video-capture). Used by the Playwright e2e tests and for demos.
 *
 *   npx tsx scripts/make-fake-camera.ts [out.y4m] [pose] [frames]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { renderSyntheticTable } from '../src/vision/synth/render';
import type { Frame } from '../src/vision/image';
import { POSES, scene } from '../tests/helpers/scenes';

export function toY4m(frames: Frame[], fps = 30): Buffer {
  const { width: w, height: h } = frames[0]!;
  const header = Buffer.from(`YUV4MPEG2 W${w} H${h} F${fps}:1 Ip A1:1 C420jpeg\n`, 'ascii');
  const parts: Buffer[] = [header];
  for (const f of frames) {
    const y = Buffer.alloc(w * h);
    const u = Buffer.alloc((w / 2) * (h / 2));
    const v = Buffer.alloc((w / 2) * (h / 2));
    const d = f.data;
    for (let j = 0; j < h; j++)
      for (let i = 0; i < w; i++) {
        const k = (j * w + i) * 4;
        y[j * w + i] = Math.round(0.299 * d[k]! + 0.587 * d[k + 1]! + 0.114 * d[k + 2]!);
      }
    for (let j = 0; j < h / 2; j++)
      for (let i = 0; i < w / 2; i++) {
        let r = 0;
        let g = 0;
        let b = 0;
        for (const [dx, dy] of [
          [0, 0],
          [1, 0],
          [0, 1],
          [1, 1],
        ] as const) {
          const k = ((2 * j + dy) * w + 2 * i + dx) * 4;
          r += d[k]!;
          g += d[k + 1]!;
          b += d[k + 2]!;
        }
        r /= 4;
        g /= 4;
        b /= 4;
        u[j * (w / 2) + i] = Math.max(0, Math.min(255, Math.round(128 - 0.168736 * r - 0.331264 * g + 0.5 * b)));
        v[j * (w / 2) + i] = Math.max(0, Math.min(255, Math.round(128 + 0.5 * r - 0.418688 * g - 0.081312 * b)));
      }
    parts.push(Buffer.from('FRAME\n', 'ascii'), y, u, v);
  }
  return Buffer.concat(parts);
}

const out = process.argv[2] ?? 'tests/fixtures/table.y4m';
const pose = (process.argv[3] ?? 'corner') as keyof typeof POSES;
const n = Number(process.argv[4] ?? 4);
const t0 = performance.now();
const frame = renderSyntheticTable(scene(pose));
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, toY4m(Array.from({ length: n }, () => frame)));
console.log(`wrote ${out} (${pose}, ${n} frames) in ${(performance.now() - t0).toFixed(0)} ms`);
