import { writeFileSync } from 'node:fs';
import { renderSyntheticTable } from '../src/vision/synth/render';
import { POSES, scene } from '../tests/helpers/scenes';
import { encodePng } from './png';
const out = process.argv[2]!;
for (const pose of Object.keys(POSES)) {
  const t0 = performance.now();
  const f = renderSyntheticTable(scene(pose as keyof typeof POSES));
  writeFileSync(`${out}/${pose}.png`, encodePng(f));
  console.log(pose, (performance.now() - t0).toFixed(0), 'ms');
}
