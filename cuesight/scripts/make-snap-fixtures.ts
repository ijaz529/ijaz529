/**
 * Snap-mode fixtures (spec 002 US2): an overview photo of the whole table and table-level "player"
 * photos of the SAME ball layout, ray traced with exact ground truth (Constitution III).
 *
 *   npx tsx scripts/make-snap-fixtures.ts [outDir]        (default tests/fixtures)
 *
 * Writes:
 *   snap-overview.png       1280×720, whole table from a corner (the 001 pipeline locks on it)
 *   snap-player.png         1280×960, crouched 0.5 m behind the cue ball, aimed at the target
 *   snap-player-hard.png    1280×960, only the cue ball and target in frame, no cushion: the automatic
 *                           fit must refuse; two taps (cue, then target) must succeed
 *   snap-player-cut.png     1280×960, cue ball cut by the bottom edge (strike point off the photo)
 *   snap-layout.json        balls (ids, table metres, colours), per-photo camera, CameraPose, image
 *                           positions of the balls in view, and the expected estimator outcome
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTable } from '../src/core/table';
import type { PocketId } from '../src/core/types';
import { estimatePlayerView, projectBallOutline, projectPoint, type CameraPose, type KnownBall } from '../src/vision/player-view';
import { BALL_COLORS, cameraModel, playerViewCamera, renderSyntheticTable, type RGB, type SynthBall, type SynthCamera } from '../src/vision/synth/render';
import { encodePng } from './png';

export const SNAP_TABLE = 'pool9' as const;
const table = makeTable(SNAP_TABLE);
const R = table.ballRadius;
const C = BALL_COLORS;

export interface SnapBall {
  id: string;
  label: string;
  pos: { x: number; y: number };
  rgb: RGB;
  stripe: boolean;
  isCue: boolean;
}

/** A 9-ball-style spread with clear pots: 1 (yellow) → TR is a ~13° cut, 8 (black) → BM ~27°, 15 (maroon stripe) → TR ~29°. */
export const SNAP_BALLS: SnapBall[] = [
  { id: 'cue', label: 'cue', pos: { x: -0.7, y: -0.1 }, rgb: C.cue!, stripe: false, isCue: true },
  { id: '1', label: 'yellow', pos: { x: 0.3, y: 0.15 }, rgb: C.yellow!, stripe: false, isCue: false },
  { id: '2', label: 'blue', pos: { x: 0.55, y: -0.32 }, rgb: C.blue!, stripe: false, isCue: false },
  { id: '3', label: 'red', pos: { x: -0.25, y: 0.4 }, rgb: C.red!, stripe: false, isCue: false },
  { id: '12', label: 'purple stripe', pos: { x: 0.95, y: -0.05 }, rgb: C.purple!, stripe: true, isCue: false },
  { id: '5', label: 'orange', pos: { x: 0.95 + 2 * R + 0.0005, y: -0.05 }, rgb: C.orange!, stripe: false, isCue: false },
  { id: '15', label: 'maroon stripe', pos: { x: 0.05, y: -0.08 }, rgb: C.maroon!, stripe: true, isCue: false },
  { id: '8', label: 'black', pos: { x: -0.45, y: -0.42 }, rgb: C.black!, stripe: false, isCue: false },
  { id: '9', label: 'yellow stripe', pos: { x: 1.05, y: 0.25 }, rgb: C.yellow!, stripe: true, isCue: false },
];

const synthBalls: SynthBall[] = SNAP_BALLS.map((b) => ({ pos: b.pos, color: b.rgb, ...(b.stripe ? { stripe: true } : {}) }));
const ball = (id: string) => SNAP_BALLS.find((b) => b.id === id)!;

export function poseOf(cam: SynthCamera, width: number, height: number): CameraPose {
  const m = cameraModel(cam, width, height);
  const Rm = [m.R[0].x, m.R[0].y, m.R[0].z, m.R[1].x, m.R[1].y, m.R[1].z, m.R[2].x, m.R[2].y, m.R[2].z];
  const c = m.C;
  const t = {
    x: -(Rm[0]! * c.x + Rm[1]! * c.y + Rm[2]! * c.z),
    y: -(Rm[3]! * c.x + Rm[4]! * c.y + Rm[5]! * c.z),
    z: -(Rm[6]! * c.x + Rm[7]! * c.y + Rm[8]! * c.z),
  };
  return { R: Rm, t, f: m.f, cx: width / 2, cy: height / 2, width, height };
}

interface PhotoSpec {
  key: 'overview' | 'player' | 'playerHard' | 'playerCut';
  file: string;
  width: number;
  height: number;
  camera: SynthCamera;
  targetId?: string;
  pocketId?: PocketId;
  note: string;
}

const PW = 1280;
const PH = 960;
const player = (targetId: string, o: { distance: number; height: number; fovDeg: number; cueRow: number; yawOffsetDeg?: number }): SynthCamera =>
  playerViewCamera({ cue: ball('cue').pos, aimAt: ball(targetId).pos, imageWidth: PW, imageHeight: PH, ballRadius: R, ...o });

export const SNAP_PHOTOS: PhotoSpec[] = [
  {
    key: 'overview',
    file: 'snap-overview.png',
    width: 1280,
    height: 720,
    camera: { pos: { x: -2.25, y: -1.5, z: 1.8 }, target: { x: 0.15, y: 0.05, z: 0 }, fovDeg: 66 },
    note: 'Whole table from a corner; the 001 pipeline locks on it and finds all 9 balls.',
  },
  {
    key: 'player',
    file: 'snap-player.png',
    width: PW,
    height: PH,
    targetId: '1',
    pocketId: 'TR',
    camera: player('1', { distance: 0.5, height: 0.3, fovDeg: 65, cueRow: 0.72 }),
    note: 'Crouched 0.5 m behind the cue ball, 0.3 m above the bed, aimed at the 1 ball. The automatic fit succeeds.',
  },
  {
    key: 'playerHard',
    file: 'snap-player-hard.png',
    width: PW,
    height: PH,
    targetId: '8',
    pocketId: 'BM',
    camera: player('8', { distance: 0.3, height: 0.3, fovDeg: 40, cueRow: 0.78 }),
    note: 'Only the cue ball and the 8 ball in frame, no cushion: the automatic fit refuses (ok: false + reason); two taps (cue, then 8) succeed with confidence capped at 0.7.',
  },
  {
    key: 'playerCut',
    file: 'snap-player-cut.png',
    width: PW,
    height: PH,
    targetId: '1',
    pocketId: 'TR',
    camera: player('1', { distance: 0.45, height: 0.3, fovDeg: 65, cueRow: 1.0, yawOffsetDeg: 6 }),
    note: 'Cue-ball centre on the bottom edge: the strike point (below the centre, on the back) is off the photo. The automatic fit succeeds.',
  },
];

function ballsInView(pose: CameraPose): { id: string; center: { x: number; y: number }; outlineCenter: { x: number; y: number }; radiusPx: number }[] {
  const out: { id: string; center: { x: number; y: number }; outlineCenter: { x: number; y: number }; radiusPx: number }[] = [];
  for (const b of SNAP_BALLS) {
    const c3 = { x: b.pos.x, y: b.pos.y, z: R };
    const ol = projectBallOutline(pose, c3, R, 96);
    const p = projectPoint(pose, c3);
    if (!ol.length || !p) continue;
    const mx = ol.reduce((a, q) => a + q.x, 0) / ol.length;
    const my = ol.reduce((a, q) => a + q.y, 0) / ol.length;
    const r = ol.reduce((a, q) => a + Math.hypot(q.x - mx, q.y - my), 0) / ol.length;
    if (mx + r < 0 || mx - r > pose.width || my + r < 0 || my - r > pose.height) continue;
    const round = (v: number) => Math.round(v * 100) / 100;
    out.push({ id: b.id, center: { x: round(p.x), y: round(p.y) }, outlineCenter: { x: round(mx), y: round(my) }, radiusPx: round(r) });
  }
  return out;
}

function main(): void {
  const outDir = process.argv[2] ?? 'tests/fixtures';
  mkdirSync(outDir, { recursive: true });
  const known: KnownBall[] = SNAP_BALLS.map((b) => ({ id: b.id, pos: b.pos, isCue: b.isCue, rgb: b.rgb }));
  const photos: Record<string, unknown> = {};
  for (const ph of SNAP_PHOTOS) {
    const t0 = performance.now();
    const frame = renderSyntheticTable({ table, balls: synthBalls, camera: ph.camera, width: ph.width, height: ph.height, ss: 2 });
    writeFileSync(join(outDir, ph.file), encodePng(frame));
    const pose = poseOf(ph.camera, ph.width, ph.height);
    const inView = ballsInView(pose);
    let expect: Record<string, unknown> | undefined;
    if (ph.key !== 'overview') {
      const auto = estimatePlayerView({ frame, table, balls: known, cueId: 'cue', targetId: ph.targetId! });
      expect = { ok: auto.ok, reason: auto.reason ?? null };
      if (ph.key === 'playerHard') {
        const cue = inView.find((b) => b.id === 'cue')!.outlineCenter;
        const tgt = inView.find((b) => b.id === ph.targetId)!.outlineCenter;
        const manual = estimatePlayerView({ frame, table, balls: known, cueId: 'cue', targetId: ph.targetId!, manualTaps: { cue, target: tgt } });
        expect = { ...expect, manualTaps: { cue, target: tgt }, manualOk: manual.ok, manualConfidence: Math.round(manual.confidence * 100) / 100 };
      }
    }
    const m = cameraModel(ph.camera, ph.width, ph.height);
    const X = table.length / 2 + table.cushionWidth;
    const Y = table.width / 2 + table.cushionWidth;
    const corners =
      ph.key === 'overview'
        ? [
            [-X, -Y],
            [X, -Y],
            [X, Y],
            [-X, Y],
          ].map(([x, y]) => {
            const p = m.project({ x: x!, y: y!, z: table.cushionHeight });
            return { x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 };
          })
        : undefined;
    photos[ph.key] = {
      file: ph.file,
      width: ph.width,
      height: ph.height,
      note: ph.note,
      ...(ph.targetId ? { targetId: ph.targetId, pocketId: ph.pocketId } : {}),
      camera: { ...ph.camera, f: m.f },
      pose,
      ...(corners ? { clothCorners: corners } : {}),
      ballsInView: inView,
      ...(expect ? { expect } : {}),
    };
    console.log(`${ph.file}: ${ph.width}×${ph.height}, ${inView.length} balls in view${expect ? `, expect ${JSON.stringify(expect)}` : ''} (${(performance.now() - t0).toFixed(0)} ms)`);
  }
  const layout = {
    description: 'CueSight Snap fixtures (spec 002 US2): synthetic photos of one ball layout with exact ground truth. Regenerate with `npx tsx scripts/make-snap-fixtures.ts`.',
    units: 'metres, table frame (origin at the bed centre, +x along the long rail, z up); image px with pixel (u, v) covering [u, u+1)×[v, v+1)',
    poseConvention: 'X_cam = R·X_world + t; rows of R = camera right, down, forward; u = f·X/Z + cx, v = f·Y/Z + cy',
    table: SNAP_TABLE,
    ballRadius: R,
    cueId: 'cue',
    targetId: '1',
    pocketId: 'TR',
    balls: SNAP_BALLS,
    photos,
  };
  writeFileSync(join(outDir, 'snap-layout.json'), JSON.stringify(layout, null, 2) + '\n');
  console.log(`wrote ${join(outDir, 'snap-layout.json')}`);
}

if (process.argv[1] && /make-snap-fixtures\.ts$/.test(process.argv[1])) main();
