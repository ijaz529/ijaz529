# Contract: Core & Vision Public API

These are the only functions that `workers/` and `app/` may import from `core/` and `vision/`.
Every function is pure: it has no side effects and never mutates its inputs unless the parameter
is named `out`.

## core/table.ts

```ts
makeTable(preset: TablePresetId, overrides?: Partial<TableDims>): TableSpec
TABLE_PRESETS: Record<TablePresetId, TableDims>
clampToTable(table: TableSpec, p: Vec2): Vec2          // keeps a ball centre inside the cushions
```

## core/physics

```ts
DEFAULT_PHYSICS: PhysicsParams
throwAngle(cutRad, v, wzR, wxR, params): number          // TP A.14, radians, signed
squirtAngle(sideFrac, massRatio): number                 // TP A.31, radians (≥ 0)
rollingDeflection(cutRad): number                        // 30° rule, radians
strikeBall(dir: Vec2, stroke: Stroke, table, params): { vel: Vec2; omega: Vec3; squirtRad: number }
simulate(table, balls: SimBallInit[], params, opts?: { maxTime?, record? }): SimResult
  // SimBallInit = { id, pos, vel?, omega? }
  // SimResult = { trajectories: Trajectory[], events: SimEvent[], final: Map<id, {pos, pocket}> }
```

**Invariants (tested)**:

- Total kinetic energy (translational + rotational) never increases across a step.
- A stationary layout stays stationary.
- No two balls ever overlap by more than 0.1 mm.
- A ball struck at `vert = 0.4` rolls with no slip from t = 0.
- Stun at a 30° cut: the CB departs within 1° of the tangent line.
- Rolling at a 30° cut: the CB deflects 33.7° ± 1°.
- The simulated OB direction matches `throwAngle` within 0.1° (for e = 1).

## core/shot

```ts
pocketWindow(table, from: Vec2, pocket: PocketSpec, R): { ok: boolean; dir: Vec2; halfRad: number; mouthHit: Vec2 }
ghostBall(ob: Vec2, obDir: Vec2, R): Vec2
cutAngle(cue: Vec2, ghost: Vec2, obDir: Vec2): number    // radians, 0..π
fractionOf(cutRad): { fraction: number; label: string }
pathBlockers(from: Vec2, to: Vec2, balls: Ball[], clearance: number, ignore: string[]): Ball[]
powerToSpeed(power): number; speedToPower(v): number; speedWord(power): string
describeSpin(stroke): string                               // "½ tip low, ¼ tip right"
planShot(layout, request: ShotRequest, params, opts?: { recommended?: Stroke }): ShotPlan
suggestShots(layout, params, max = 3): ShotSuggestion[]
recommendStroke(layout, request, params, opts?: { landing?: Vec2; budgetMs?: number }): Recommendation
positionHeatmap(layout, cueBallIgnoredId, nextBallId, params, cols, rows): Float32Array
```

`planShot` MUST return within 50 ms for 22 balls (tested with a timing guard at 10× margin in CI).

## vision

```ts
detectTable(frame: Frame, opts: TableDetectOptions, scratch?: Scratch): TableDetection | null
  // → { corners: Vec2[4] (image px, table order), quality }
calibrationFromCorners(corners, table, frameW, frameH, opts: { fovDeg, cushionWidth, cushionHeight, swapAxes? }): Calibration
detectBalls(frame, calib, table, opts, scratch?): DetectedBall[]
createTracker(opts): { update(det: { corners?, balls }): VisionResult; reset(): void }
processFrame(frame, state: PipelineState): VisionResult      // orchestrates the above
renderSyntheticTable(scene: SynthScene): Frame                // test fixtures + fake camera
```

**Accuracy contract (tested on synthetic scenes, 3 camera poses)**:

- Corners within 1.5 % of the image diagonal.
- Ball centres: median error ≤ 10 mm, p95 ≤ 25 mm.
- Cue ball identified correctly in 100 % of fixture scenes.
