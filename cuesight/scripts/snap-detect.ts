import { writeFileSync } from 'node:fs';
import { renderSyntheticTable } from '../src/vision/synth/render';
import { detectTable } from '../src/vision/table-detect';
import { scene } from '../tests/helpers/scenes';
import { encodePng } from './png';
const [out, pose] = [process.argv[2]!, process.argv[3] ?? 'side'];
const f = renderSyntheticTable({ ...scene(pose as 'side'), ss: 1 });
const det = detectTable(f)!;
const put = (x: number, y: number) => {
  for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
    const xx = Math.round(x + dx), yy = Math.round(y + dy);
    if (xx < 0 || yy < 0 || xx >= f.width || yy >= f.height) continue;
    const i = (yy * f.width + xx) * 4; f.data[i] = 255; f.data[i + 1] = 0; f.data[i + 2] = 255;
  }
};
for (let k = 0; k < 4; k++) {
  const a = det.corners[k]!, b = det.corners[(k + 1) % 4]!;
  for (let t = 0; t <= 1; t += 0.002) put(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
}
console.log(det.corners);
writeFileSync(`${out}/detect-${pose}.png`, encodePng(f));
