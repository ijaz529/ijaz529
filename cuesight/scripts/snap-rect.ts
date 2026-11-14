import { writeFileSync } from 'node:fs';
import { detectBalls, rectify } from '../src/vision/ball-detect';
import { calibrationFromCorners } from '../src/vision/calibration';
import { renderSyntheticTable } from '../src/vision/synth/render';
import { detectTable } from '../src/vision/table-detect';
import { scene } from '../tests/helpers/scenes';
import { encodePng } from './png';
const [out, pose] = [process.argv[2]!, (process.argv[3] ?? 'end') as 'end'];
const sc = scene(pose);
const f = renderSyntheticTable(sc);
const det = detectTable(f)!;
const cal = calibrationFromCorners(det.corners, sc.table, f.width, f.height)!;
const r = rectify(f, cal, sc.table, det.cloth);
const balls = detectBalls(f, cal, sc.table, det.cloth);
const img = { width: r.w, height: r.h * 2, data: new Uint8ClampedArray(r.w * r.h * 2 * 4) };
for (let k = 0; k < r.w * r.h; k++) {
  for (let c = 0; c < 3; c++) img.data[k * 4 + c] = r.rgb[k * 3 + c]!;
  img.data[k * 4 + 3] = 255;
  const m = (r.w * r.h + k) * 4;
  img.data[m] = img.data[m + 1] = img.data[m + 2] = r.nonCloth[k] ? 255 : 0;
  img.data[m + 3] = 255;
}
for (const b of balls) {
  const i = Math.round((b.pos.x - r.x0) * r.scale), j = Math.round((r.y0 - b.pos.y) * r.scale);
  for (let d = -4; d <= 4; d++) for (const [x, y] of [[i + d, j], [i, j + d]]) {
    if (x! < 0 || y! < 0 || x! >= r.w || y! >= r.h) continue;
    const q = (y! * r.w + x!) * 4; img.data[q] = 255; img.data[q + 1] = 0; img.data[q + 2] = b.isCue ? 0 : 255;
  }
}
console.log(r.w, r.h, r.scale.toFixed(0), balls.map(b => `${b.label}@(${b.pos.x.toFixed(2)},${b.pos.y.toFixed(2)}) w=${b.white.toFixed(2)} s=${b.score.toFixed(2)}`).join('\n'));
writeFileSync(`${out}/rect-${pose}.png`, encodePng(img));
