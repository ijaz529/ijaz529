# Contract: Core & Vision Public API

These are the public contracts of `core/` and `vision/` that `workers/` and `app/` build on.
- Every function is pure: it has no side effects and never mutates its inputs, unless a parameter
  is named `out` or is a documented scratch buffer. The exceptions are the stateful factories
  (`createTracker`, `createPipeline`) and the in-place collision resolvers.
- `app/` also imports small helpers that are not listed here: the `vec.ts` helpers, `clampTip`,
  `stunVert`, `POCKET_NAMES`, and `applyH` / `invert3`. The source signatures are authoritative.

**Revised 2026-11-15** to match the code on `fix/wave1`. The earlier version listed a
`processFrame` that does not exist, the wrong `pocketWindow`, `strikeBall`, `detectTable`,
`calibrationFromCorners`, `detectBalls` and `positionHeatmap` signatures, and a `budgetMs` option.
New optional fields are marked *optional*. Entity fields are in [data-model.md](../data-model.md).

## core/table.ts

```ts
makeTable(preset: TablePresetId, overrides?: Partial<TableDims>): TableSpec
TABLE_PRESETS: Record<TablePresetId, TableDims>
clampToTable(table: TableSpec, p: Vec2): Vec2          // keeps a ball centre ≥ R inside the cushion lines
pocketById(table, id: PocketId): PocketSpec
```

## core/physics

```ts
DEFAULT_PHYSICS: PhysicsParams; withPhysics(overrides?: Partial<PhysicsParams>): PhysicsParams
throwAngle(cut: number, v: number, wzR: number, wxR: number, params: Pick<PhysicsParams, 'ballFriction'>): number
                                                            // TP A.14, radians
squirtAngle(sideFrac: number, massRatio: number): number    // TP A.31, radians (≥ 0)
rollingDeflection(cut: number): number                      // 30° rule, radians
rollingDistance(v: number, params: Pick<PhysicsParams, 'muRoll' | 'g'>): number
strikeBall(travelDir: Vec2, speed: number, side: number, vert: number, ballRadius: number, squirtMassRatio: number): StrikeResult
  // StrikeResult = { vel, omega: Vec3, squirtRad (≥ 0), cueDir (cue direction that squirts the ball onto travelDir), side, vert }
  // (side, vert) are clamped radially to the 0.5 R miscue limit
simulate(table, balls: SimBallInit[], params, opts?: SimOptions): SimResult
  // SimBallInit = { id, pos, vel?, omega? }
  // SimOptions  = { maxTime?, record? (default true), recordSpacing? (default 0.02 m),
  //                 stopOnFirstHitOf?: string, onStep? (test hook), maxContactsPerStep? (test knob) }
  // SimResult   = { trajectories: Trajectory[], events: SimEvent[],
  //                 final: Record<id, { pos, pocket: PocketId | null, pocketSpeed }>,
  //                 firstHits: Record<id, { other, t, pos, vel }>, time, steps }
resolveBallBall(s, i, j, R, params) / resolveCushion(s, i, nx, ny, R, params)   // in place on BallArrays
```

**Invariants (tested)**:

- Total kinetic energy (translational + rotational) never increases across a step. That includes
  1000 random cushion impacts with spin about every axis.
- A stationary layout stays stationary.
- No two balls ever overlap by more than 0.1 mm. This holds per step, for frozen racks and lines
  too, and under forced contact budgets.
- A ball struck at `vert = 0.4` rolls with no slip from t = 0.
- Stun at a 30° cut: for ideal balls (e = 1), the CB departs within 0.5° of the tangent line. With
  e = 0.95 it departs less than 4° forward of it.
- Rolling at a 30° cut: the CB deflects 33.7° ± 1°.
- The simulated OB direction matches `throwAngle` within 0.1° (for e = 1).
- Squirt: `squirtAngle(0.5, 23)` = 2.40° and `squirtAngle(0.5, 35)` = 1.64° (± 0.05°).
- Cushion (research.md R-08):
  - A rolling ball loses most of its topspin at a rail and leaves at 0.5–0.65 of its arrival
    speed.
  - A 45° roll-in leaves 30–40° off the rail.
  - Draw is not handed back as follow.
- Allocation: the step loop allocates only output records. About 3 M steps of a lone ball trigger
  at most 3 GC collections (measured 0–2), and no `Math.hypot` is used on simulation paths.

## core/shot

```ts
pocketWindow(from: Vec2, pocket: PocketSpec, R: number): PocketWindow
  // PocketWindow = { ok, dir (OB aim, window bisector), halfRad, mouthHit, distance }
  // corner hanger on/past the mouth line: the arc facing the pocket, distance 0, mouthHit = from
mouthIntersect(from: Vec2, dir: Vec2, pocket): { mouthHit: Vec2; t: number }
ghostBall(ob: Vec2, obDir: Vec2, R): Vec2;  contactPoint(ob, obDir, R): Vec2
cutAngle(cue: Vec2, ghost: Vec2, obDir: Vec2): number      // radians, 0..π
cutSide(cue, ghost, obDir): 1 | -1 | 0                     // + = OB departs CCW of the CB line
fractionOf(cutRad): { fraction: number; label: string }    // eighths with "thin "/"thick " qualifiers (data-model.md)
pathBlockers(from: Vec2, to: Vec2, balls: Ball[], clearance: number, ignore: string[]): Ball[]   // nearest first
powerToSpeed(power): number; speedToPower(v): number; speedWord(power): string   // R-12
describeSpin(stroke: { side, vert }): string                // "½ tip low, ¼ tip right"; 1 tip = 0.25 R (data-model.md)
shotGeometry(table, balls, cue: Ball, target: Ball, pocket: PocketSpec, params = DEFAULT_PHYSICS): ShotGeometry
  // geometry only (no simulation); params sets the frozen-ball throw bound; used by suggestions
minimumPower(geo, stroke: { vert }, params, criterion: 'capture' | 'pace' = 'capture'): number   // 10.5 = not even at 10
planShot(layout, request: ShotRequest, params, opts?: { recommended?: Stroke; record?: boolean; names?: Partial<Record<PocketId, string>> }): ShotPlan
suggestShots(layout, params, max = 3): ShotSuggestion[]
recommendStroke(layout, request, params, opts?: RecommendOptions): Recommendation
  // RecommendOptions = { landing?: Vec2,
  //   maxEvaluations?: number   (default FULL_EVALUATIONS = 228; the result is a function of it),
  //   timeCapMs?: number        (optional wall-clock safety net; result.timedOut when it fires),
  //   budgetMs?: number         (@deprecated alias of timeCapMs),
  //   onEvaluate?: (stroke, score | null) => void   (test hook) }
nextShotQuality(layout, cuePos: Vec2, excludeIds: string[], onlyBallId?: string, params?): number   // 0..1
postShotLayout(layout, plan: { targetId, otherPaths }): TableLayout
positionHeatmap(layout, nextBallId: string, cols: number, rows: number, excludeIds: string[] = [], params?: PhysicsParams): Float32Array
coachingTip(t: TipInput): string;  difficultyOf(toleranceDeg): Difficulty
```

**Behaviour contracts (tested)**:

- `planShot`:
  - Device budget: < 50 ms for 22 balls. CI guard: median of 5 runs < 100 ms
    (`tests/integration/perf.test.ts`); measured 7.1 ms on 2026-11-15.
  - The `too-soft` warning never contradicts the simulation.
  - A blocked or not-makeable plan names the best other clear pocket when there is one.
  - Frozen and corner-hanger plans follow the conventions in data-model.md.
- `recommendStroke`:
  - With `timeCapMs` unset, the same inputs and `maxEvaluations` give the same result: it is
    deterministic and does not depend on device speed.
  - `score` is the worst-case robust score (research.md R-11) and is finite whenever some stroke
    pots the ball.
  - `fragile: true` when no candidate survived the ±6/±12 % speed check.
  - `reachable` is true when any potting stroke ends within 15 cm of the landing spot.
- `positionHeatmap`:
  - The values are row-major, with rows along +y from −W/2 + R. The cells cover the area that
    ball centres can reach.
  - Each value is the 0..1 quality of the best shot on `nextBallId` with the cue ball in that
    cell. A cell where the cue ball would overlap an object ball is 0.
  - The map is **all zeros** when `nextBallId` is the cue ball, is in `excludeIds` (the current
    target), or is unknown: there is no next shot to map.
  - `params` only matters for a frozen cue ball, where it sets the throw bound.
- `suggestShots`:
  - Only geometrically clear, makeable shots are returned.
  - The leaders are verified by simulating the default stroke, then ranked by margin plus
    next-shot quality (data-model.md ShotSuggestion).
  - ≤ 2 s on an open 15-ball layout, and no returned item carries a blocked warning.

## vision

```ts
createTableScratch(w: number, h: number): TableScratch
detectTable(frame: Frame, scratch?: TableScratch, prior?: ClothModel | null): TableDetection | null
  // → { corners: Vec2[4] (image px, polygon order — NOT table order), cloth: ClothModel, quality (IoU 0..1) }
  // null for no table, or a truncated outline it cannot support (research.md R-03)
learnClothInQuad(scratch, quad: Vec2[]): ClothModel | null    // manual corners; scratch HSV planes must be filled
calibrationFromCorners(corners: Vec2[], table, width: number, height: number,
                       opts?: { fovDeg?, swapAxes? (absolute), source?: 'auto' | 'manual', prev?: Vec2[] | null }): Calibration | null
detectBalls(frame, calib: Calibration, table, cloth: ClothModel, opts?: { scale?: number; palette?: 'pool' | 'snooker' }): DetectedBall[]
createTracker(opts: { ballRadius, firstId?, … }): { updateCorners(c, diag), updateBalls(dets), update(u), reset(), resetLock(), nextId() }
createPipeline(config: { table, fovDeg?, manualCorners?: Vec2[] | null, swapAxes? }):
  { configure(next: Partial<PipelineConfig>): void; reset(): void; process(frame: Frame): VisionResult }
  // configure restarts tracking only on a geometry change (table, corners, swapAxes); ids continue
  // reset forgets the lock, the cloth and the tracks but keeps the id counter
separateBalls(balls: TrackedBall[], table): TrackedBall[]     // 2R separation + cushion clamp (copies)
renderSyntheticTable(scene: SynthScene): Frame                 // test fixtures + fake camera
```

**Accuracy contract (tested on synthetic scenes: 4 camera poses, RGB and 4:2:0 video-like frames)**:

- Corners within 1.5 % of the image diagonal: green cloth in 4 poses, blue and red cloth, grey
  cloths on grey and wooden floors, and tables filling the frame.
- Ball centres: median error ≤ 10 mm, p95 ≤ 25 mm, with automatic and with exact calibration.
  - Worst measured median on the 9-ball fixture on 2026-11-15: 6.3 mm (end view, RGB) and 6.4 mm
    (end view, 4:2:0).
  - **Not met on `fix/wave1`** for touching clusters: the 9-ball diamond corner view, the 15-ball
    triangle side view, the snooker pack in the end, side and corner views, and 4:2:0 touching
    pairs at 30° in the corner view. 6 tests in `ball-detect-edge.test.ts` fail (analysis.md,
    "Post-review").
- Cue ball identified correctly in every fixture scene. When the choice is ambiguous, no ball is
  flagged; the detector never guesses.
- Frames with no usable quad report `calibration: null` and no balls.
