# Contract: Player-View Pose API (`src/vision/player-view.ts`)

**Implemented by** package `playerview`. **Consumed by** package `integrate`, through the vision
worker (`player-view` message, [worker-protocol-v2.md](./worker-protocol-v2.md)). This file is the
API of record. The TypeScript block is verbatim. Every function is pure and deterministic: no DOM, no
timers except `performance.now()` for `ms`, no randomness, and no mutation of inputs.

## API of record

```ts
import type { Frame } from './image'; import type { TableSpec, Vec2, Vec3 } from '../core/types';
export interface KnownBall { id: string; pos: Vec2; isCue: boolean; rgb?: [number, number, number] }
export interface PlayerViewInput { frame: Frame; table: TableSpec; balls: KnownBall[]; cueId: string; targetId?: string; focalPx?: number /* from the overview calibration scaled to this frame, if same camera */; manualTaps?: { cue: Vec2; target: Vec2 } /* image px, manual fallback */ }
export interface CameraPose { R: number[] /* 3x3 row-major world->camera */; t: Vec3; f: number; cx: number; cy: number; width: number; height: number }
export interface PlayerViewResult { ok: boolean; pose: CameraPose | null; confidence: number /* 0..1 */; residualPx: number; matched: { id: string; image: Vec2; radiusPx: number }[]; reason?: string /* player-facing message when !ok */; ms: number }
export function estimatePlayerView(input: PlayerViewInput): PlayerViewResult;
export function projectPoint(pose: CameraPose, p: Vec3): Vec2 | null; // null if behind the camera
export function projectBallOutline(pose: CameraPose, center: Vec3, R: number, n?: number): Vec2[]; // silhouette polygon
export function strikePoint(cueCenter: Vec3, aimDir: Vec2, side: number, vert: number, R: number): Vec3; // 3D point on the cue ball the tip touches (behind the ball, offset side*R right / vert*R up)
```

## Conventions

- **World**: the 001 table frame (metres, origin at the bed centre, `+z` up). A ball centre is at
  `z = table.ballRadius`.
- **Camera** (OpenCV, as in `vision/synth/render.ts`): `X_c = R·X_w + t`. Rows of `R` are the camera
  right, down and forward axes in world coordinates. The camera centre is `C = −Rᵀ·t`.
- **Projection**: `u = f·X_c/Z_c + cx`, `v = f·Y_c/Z_c + cy`. `projectPoint` returns `null` when
  `Z_c ≤ 1e-6`.
- **`projectBallOutline`**: returns `n` (default 48) image points of the exact silhouette, the
  tangent cone of the sphere, in order. It returns `[]` when the camera is inside or behind the
  sphere.
- **`strikePoint`**: with `right = (aimDir.y, −aimDir.x, 0)` and `up = (0, 0, 1)`,
  `P = c − aimDir·R·√(1 − side² − vert²) + side·R·right + vert·R·up`. Inputs follow the 001 stroke
  convention: `side > 0` is right english, `vert > 0` is follow, and `side² + vert² ≤ 0.25`. Larger
  offsets are clamped radially to 0.5 before use. `|P − c| = R` always holds.

## `estimatePlayerView` behaviour

1. **Validate**: exactly one `isCue` ball, `cueId` matching it, and `frame.width·height > 0`.
   Otherwise `ok: false` with reason "I couldn't line up this photo. Tap the cue ball, then your
   target."
2. **Detect** ball circles and cushion-edge points in `frame` (research R-24). Partial arcs ≥ 120°
   are accepted, so a cue ball cut by the frame edge still counts.
3. **Hypothesise and refine**:
   - **Automatic** (no `manualTaps`): the deterministic multi-hypothesis "behind the cue ball" grid →
     association → Levenberg–Marquardt over the 6-DoF pose plus log f, with a focal prior (`focalPx`
     if given, else a 65° HFOV).
   - **Manual** (`manualTaps`): the taps seed `cueId` and `targetId` (required in this mode), local
     circle fits run around the taps, then the LM runs with the stronger priors of R-25.
     `confidence` is capped at 0.7 unless further balls are matched automatically after the first
     fit.
4. **Decide**: `ok = confidence ≥ 0.5` and `residualPx ≤ max(4, 0.006·diag)` and (≥ 3 balls matched,
   or 2 balls plus ≥ 1 cushion edge) and (cue or target matched).
   - `pose` is returned whenever the solver converged, even when `!ok`, so the app can show hints.
     The app MUST NOT draw a guide from a pose with `!ok` as if it were right.
5. **Reasons**: `reason` is one of the canonical player-facing strings in data-model.md
   § PlayerViewResult. "You're not behind the cue ball…" may accompany `ok: true` as a warning.
6. **Timing**: `ms` is wall time inside the call.

## Accuracy contract (tested on synthetic table-level renders)

The scene grid covers:
- camera height 8–40 cm above the bed;
- distance 0.3–1.2 m behind the cue ball;
- yaw up to ±15° off the cue→target line;
- HFOV 40°–100°;
- three cloth colours;
- ≥ 3 balls in view;
- 1280 px wide frames.

| Metric | Target |
|---|---|
| Automatic success rate (`ok`) | ≥ 90 % of scenes (SC-106) |
| Ghost-ball centre, projected with the estimated pose vs ground truth | ≤ 1.5 % of the image diagonal when `ok` |
| Strike point, back-projected onto the sphere | ≤ 0.1 R from the true strike point when `ok` |
| False confidence | no scene with `ok` and a ghost error > 3 % of the diagonal (SC-107) |
| Failure scenes (one ball visible, balls moved by ≥ 10 cm, frame darkened ×0.15 with noise) | `ok: false` plus a non-empty `reason` |
| Manual taps within 1.5 % of the diagonal of the true centres | ghost-ball error ≤ 2.5 % of the diagonal (SC-108) |
| Different focal (focal prior off by ×0.5 or ×2) | still within the targets above for ≥ 80 % of scenes |
| Runtime (Node, CI) | ≤ 500 ms per 1280 px scene (SC-109) |

## Unit invariants (tested)

- `projectPoint` of a point on the optical axis is `(cx, cy)`. Points behind the camera give `null`.
- For a sphere on the optical axis at distance d, the `projectBallOutline` radius is
  `f·R/√(d² − R²)`, within 0.1 px.
- `strikePoint(c, d, 0, 0, R) = c − R·d̂` (the back pole). `|strikePoint(...) − c| = R` for every
  offset in the miscue limit. `side > 0` moves the point to the shooter's right.
- `estimatePlayerView` is deterministic: the same input gives a bit-identical result, except `ms`.
