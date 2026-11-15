# Contract: Player-View Pose API (`src/vision/player-view.ts`)

**Implemented by** package `playerview`. **Consumed by** package `integrate`, through the vision
worker (`player-view` message, [worker-protocol-v2.md](./worker-protocol-v2.md)). This file is the
API of record. The TypeScript block is verbatim. Every function is pure and deterministic: no DOM, no
timers except `performance.now()` for `ms`, no randomness, and no mutation of inputs.

## API of record

```ts
import type { Frame } from './image'; import type { TableSpec, Vec2, Vec3 } from '../core/types'; import type { ClothModel } from './table-detect';
export interface KnownBall { id: string; pos: Vec2; isCue: boolean; rgb?: [number, number, number] }
export interface PlayerViewInput { frame: Frame; table: TableSpec; balls: KnownBall[]; cueId: string; targetId?: string; focalPx?: number /* from the overview calibration scaled to this frame: a soft hint, the lens may differ */; manualTaps?: { cue: Vec2; target: Vec2 } /* image px, manual fallback */; clothHint?: ClothModel | null /* the overview's cloth (VisionResult.cloth), chromatic or neutral; optional, non-breaking */ }
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

*Revised 2026-11-15 for the player-photo merge (`0a30cf5`, from `fix1b/pview` `453561e`).* Detection
lives in `src/vision/player-detect.ts` (internal, not part of this API); hypotheses, refinement and
the decision in `src/vision/player-view.ts`. The constants and their evidence are in research R-24.

1. **Validate**: exactly one `isCue` ball, `cueId` matching it, and `frame.width·height > 0` (and a
   `targetId` of a non-cue ball with `manualTaps`). Otherwise `ok: false` with reason "I couldn't
   line up this photo. Tap the cue ball, then your target."
2. **Detect** (`player-detect.ts`):
   - **Cloth candidates.** A table-level photo is mostly not cloth (the room above the far rail, the
     near rail, the floor), and the cloth can be any colour, grey included. Every chromatic hue mode
     (up to `MAX_CANDIDATES` 6, ≥ 30° apart) and grey value mode (up to 2, ≥ ×1.5 apart) covering
     ≥ 1.5 % of the photo is a candidate. Candidates are ranked by a structure score: the cloth's
     main region has round, ball-sized holes, while a rail band, a floor or a wall has none, and a
     band that cuts through a surface's own shading leaves speckle. `clothHint` is promoted only when
     this photo has a candidate of that colour at least half as convincing as the best (a neutral
     hint matches a neutral candidate; a chromatic one a hue within 25°). The best 3 are tried in
     turn until one fits (step 3).
   - **Evidence.** Crack points on the boundary between the main cloth and anything else (ball
     silhouettes, cushion edges), with sensor-noise specks (< 10 px) removed and the coarse cloth
     grid block-averaged. Ball circles are fitted to the cloth-bordered arcs of each non-cloth blob
     (Kåsa plus deterministic RANSAC; arcs ≥ 120°, so a ball cut by the frame edge or partly behind
     a nearer ball still fits), also per colour class of the blob's edge, so a red ball in front of
     the cue ball does not merge with it; large blobs (the rail band, the room) get local-arc
     proposals.
   - **Colour.** Each circle's colour descriptor and whiteness come from its own pixels, not those a
     nearer circle covers nor those away from its own arc (occlusion-aware sampling; crack
     assignment is occlusion-aware too). The thresholds follow the exposure read off the brightest
     balls, never above nominal, so a light cloth is not taken for an over-exposed photo.
3. **Hypothesise and refine** (`player-view.ts`):
   - **Lens sweep.** 20 focal guesses, 0.446 · 1.1ⁱ × the 65° default (HFOV ≈ 110° to 26°, the 0.5×
     to 3× lenses), plus `focalPx` × 0.95, 1 and 1.05 when given. `focalPx` is a soft hint: the focal
     prior is heavy-tailed (Cauchy) around it, so a lens change is decided by the image.
   - **Pair hypotheses.** The cue-ball circle fixes the cue ball in camera coordinates. Pairing any
     other circle with a colour-compatible known ball (its depth within ×2 of the circle's
     apparent-size depth, `PAIR_DEPTH_RATIO`) fixes the rotation up to a turn about the line between
     them: the level member in closed form, and roll completion, where the remaining circles vote
     for the roll (2° bins, |roll| ≤ 35°) of a phone held at an angle.
   - **Scoring.** Known balls that land, one per circle, on circles of the right size and colour;
     balls predicted on bare cloth; circles left unexplained. The best 64 (`TOP_HYPS`) seed the
     refinement.
   - **Refinement.** Levenberg–Marquardt over (rotation, camera centre, log f) on exact residuals:
     for a ball, the angle between a crack point's ray and the silhouette cone's axis minus the
     cone's half-angle; for a cushion edge (outer and nose), the angle between the ray and the plane
     through the camera and that edge. ICP-style re-association under a shrinking gate, coarse to
     fine (30 points per ball and 55 per edge on the wide gates, 90 and 160 on the last two), Cauchy
     weights, the focal prior and a level-phone prior (roll σ 10°, 5° with taps). A cushion edge
     seen from behind its rail is left out (the rail lip's height is unknown).
   - **Attempt order and deterministic budget.** The work per photo is counted, not timed, so the
     result stays deterministic: at most `REFINE_BUDGET` 10 refined seeds over all attempts. Pass 1
     takes the cloth candidates in rank order (a further one only while its structure score is ≥ ¼
     of the first's, or the first shows fewer than two ball holes): the whitest circle as the cue
     ball (`SEEDS_FIRST` 4 seeds for the photo's first solve, `SEEDS_LATER` 2 after), then the next
     white circle (one seed) unless the fit is ok and convincing. Pass 2, when nothing fits, runs on
     the candidate whose failed fit matched the most balls: up to `ALT_ANCHORS` 2 balls of unique
     colour anchor the pose instead of the cue ball (a moved cue ball pulls every cue-anchored pose
     off), one seed each; such a pose is used when it also finds the cue ball, or when it shows the
     balls moved.
   - **Manual** (`manualTaps`): the taps seed `cueId` and `targetId`, local circle fits run around
     the taps, then the LM runs with the stronger priors of R-25. `confidence` is capped at 0.7
     unless 3 or more balls are matched.
4. **Decide**:
   - **Confidence** = inlier term × residual term × exp(−σ_px / (0.01·diag)), where σ_px is the
     target's image uncertainty from the posterior covariance. For fits of 4 or fewer balls the
     layout's own uncertainty (5 mm per coordinate of each matched ball, 001 SC-003) is propagated
     into σ_px too, unless crossing cushion lines (a side and an end cushion) pin the pose (with
     taps: unless ≥ 20 edge inliers).
   - **Sure identity**: a matched ball whose colour in the photo confirms it (a hue within 14°) and
     that no unmatched layout ball could share. Snooker reds and a pool colour's solid and stripe
     are never sure on their own.
   - `ok = confidence ≥ 0.5` and `residualPx ≤ max(4, 0.006·diag)` and enough balls, and the cue or
     target matched (the cue ball itself for a pose anchored on another ball). Enough balls: ≥ 3
     matched, where a near-minimal fit (3 balls, < 20 edge inliers) needs sure identities and
     nothing predicted on bare cloth, or the two taps; or 2 balls with crossing cushion lines, sure
     identities, ≥ 55 % of the cloth boundary explained and nothing unexplained; or the two tapped
     balls.
   - In automatic mode, a camera away from the cue ball (`notBehind`: > 2 m from it, or > 40° off
     the cue → target line) is accepted only on a convincing fit (nothing on bare cloth, residual
     < 1 px, > 60 % of the boundary explained, no stray circle); otherwise the fit fails.
   - **FR-121**: an otherwise ok fit fails with `moved` when the target, the cue ball or any other
     ball is not where the layout puts it (data-model.md § PlayerViewResult has the rule).
   - When `!ok`, `confidence` is below 0.5.
   - `pose` is returned whenever the solver converged, even when `!ok`, so the app can show hints.
     The app MUST NOT draw a guide from a pose with `!ok` as if it were right.
5. **Reasons**: `reason` is one of the canonical player-facing strings in data-model.md
   § PlayerViewResult, naming the true cause (too dark, too grainy, no cloth, too few balls, moved,
   no cue ball, no fit). "You're not behind the cue ball…" may accompany `ok: true` as a warning.
6. **Timing**: `ms` is wall time inside the call. Measured at 960×720 on Node: median ≈ 104 ms,
   p95 ≈ 250 ms over the envelope (the slow tail is wide-angle and snooker photos); a 1280×960
   photo stays inside SC-109's 500 ms.

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

*Measured on `rc/release`* (`tests/integration/player-view-envelope.test.ts`, which renders an L18
orthogonal array over table, HFOV 40/65/100°, height 8/20/40 cm, distance 0.3/0.75/1.2 m, yaw
±15°, roll ±10° and occlusion at 960×720 and 1280×960, each photo fitted without and with the app's
hints; `tests/integration/player-view-honesty.test.ts` on random layouts and continuous poses; and
independent sweeps):
- SC-106: ≈ 95 % within tolerance over 912 photos with enough balls in view (the cue ball and two
  more with ≥ 50 % of their disc visible), with and without the app's hints; the test asserts ≥ 90 %
  on its grid and ≥ 85 % with a ball in front of the cue ball.
- SC-107: 0 violations; the test asserts that no ok fit lies outside the SC-106 tolerance on any
  photo, and never on grey cloth or after a shot.
- Lens change between the photos (0.5×, 1×, 2× and 3× lenses, HFOV 100°, 65°, 40° and 28°): the
  test's seven pairs all fit within tolerance with the focal length recovered; an independent sweep
  fits 45 of 48, with no ok fit off tolerance.
- Grey cloth: tinted greys fit; untinted greys (S ≤ 0.06) fit in ≈ 30 % and otherwise fail honestly
  (R-24 known limits).
- CPU per 960×720 photo: p95 < 250 ms, guarded over the envelope and over a set of mostly failing
  photos.

## Unit invariants (tested)

- `projectPoint` of a point on the optical axis is `(cx, cy)`. Points behind the camera give `null`.
- For a sphere on the optical axis at distance d, the `projectBallOutline` radius is
  `f·R/√(d² − R²)`, within 0.1 px.
- `strikePoint(c, d, 0, 0, R) = c − R·d̂` (the back pole). `|strikePoint(...) − c| = R` for every
  offset in the miscue limit. `side > 0` moves the point to the shooter's right.
- `estimatePlayerView` is deterministic: the same input gives a bit-identical result, except `ms`.
