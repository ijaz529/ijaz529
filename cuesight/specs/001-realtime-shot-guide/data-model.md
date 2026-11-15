# Phase 1 Data Model: Real-Time Shot Guide

All units are SI: metres, seconds, radians internally, and degrees only in display fields that end in
`Deg`.

**Revised 2026-11-15** to match the code on `fix/wave1` after the code review (analysis.md,
"Post-review"). The TypeScript sources of truth are `src/core/types.ts`, `src/vision/pipeline.ts`,
`src/vision/calibration.ts`, `src/vision/ball-detect.ts` and `src/vision/tracker.ts`. Fields marked
*optional* were added after v1 and may be absent from older producers.

**Table frame**:
- The origin is the centre of the playing surface (cushion nose to cushion nose).
- `+x` runs along the long rail toward the "right" short rail. `+y` runs toward the "top" long rail.
  `+z` points up from the bed.
- Angles and signed quantities (`throwDeg`, `squirtDeg`, `cutSide`) are counter-clockwise positive
  seen from above, unless a field says otherwise.

## TableSpec

| Field | Type | Rule |
|---|---|---|
| `id` | `'pool9' \| 'pool8' \| 'pool7' \| 'uk7' \| 'snooker12'` | required |
| `name` | string | display name |
| `length`, `width` | number (m) | `length > width > 0`. Playing surface |
| `ballRadius` | number (m) | `0.02 ≤ R ≤ 0.035` |
| `ballMass` | number (kg) | `> 0` |
| `cornerMouth`, `sideMouth` | number (m) | `> 2·ballRadius` (a ball must fit) |
| `cushionWidth` | number (m) | `0 ≤ c ≤ 0.12`. Nose to the outer cloth edge (vision only) |
| `cushionHeight` | number (m) | default `0.635 × 2R`. Nose height (vision only; the cushion impulse takes the contact at the equator, research.md R-08) |
| `pockets` | `PocketSpec[6]` | derived from the above |
| `cushions` | `Segment[6]` | derived: segments between jaw points |

### PocketSpec

| Field | Type | Rule |
|---|---|---|
| `id` | `'BL' \| 'BM' \| 'BR' \| 'TL' \| 'TM' \| 'TR'` | B = −y rail, T = +y rail; L/M/R = −x / middle / +x |
| `kind` | `'corner' \| 'side'` | |
| `jawA`, `jawB` | Vec2 | on the cushion-nose rectangle. Ordered counter-clockwise around the table |
| `mouthCenter` | Vec2 | midpoint of the jaws. Used for labels and taps |
| `inward` | Vec2 (unit) | points from the pocket into the table (bisector) |

## PhysicsParams (defaults; every field configurable — FR-028)

| Field | Default | Source / note |
|---|---|---|
| `g` | 9.81 | |
| `muSlide` | 0.20 | Alciatore, pooltool: typical cloth sliding friction |
| `muRoll` | 0.010 | rolling resistance (0.005 fast cloth … 0.015 slow) |
| `spinDecel` | 10 rad/s² | ASSUMPTION: sidespin decay on cloth, so ~3 s of spin |
| `eBall` | 0.95 | phenolic ball–ball restitution (0.92–0.98) |
| `ballFriction` | {a: 9.951e-3, b: 0.108, c: 1.088} | μ(v) = a + b·e^(−c·v), Alciatore TP A.14 (Marlow's data) |
| `cushionE0`, `cushionESlope`, `cushionEMin` | 0.88, 0.035, 0.55 | e_c = max(min, e0 − slope·\|vₙ\|). ASSUMPTION fitted to the typical 0.75–0.9 range |
| `muCushion` | 0.20 | ASSUMPTION: ball–cushion contact friction, applied to the full 3-D contact slip (research.md R-08) |
| `squirtMassRatio` | 23 | m_ball / m_endmass for a standard shaft. 35 for low-deflection (TP A.31) |
| `dt` | 0.001 s | simulator step |
| `maxTime` | 12 s | simulation cap |
| `pocketArrivalSpeed` | 0.3 m/s | ASSUMPTION: object-ball speed at the mouth regarded as "drops with pace" (≈ 0.46 m of extra roll at μᵣ 0.01). A coaching margin for `minPower` and the "too soft" advice, not a physical minimum: the hard test is whether the simulated ball crosses the capture line |

The app's settings presets (cloth speed, cushion bounce) map to these fields in `app/settings.ts`
(`physicsFor`). On `fix/wave1` those preset literals carry no source or ASSUMPTION notes; that is an
open Principle I item (analysis.md P-C4).

## Ball

| Field | Type | Rule |
|---|---|---|
| `id` | string | unique within a layout. `'cue'` for the cue ball |
| `kind` | `'cue' \| 'object'` | exactly one `'cue'` per plannable layout |
| `pos` | Vec2 | must lie within `\|x\| ≤ L/2 − R`, `\|y\| ≤ W/2 − R`. Clamped on input (`clampToTable`) |
| `label` | string? | e.g. "8", "red", "yellow stripe" |
| `color` | string? | CSS colour for drawing |
| `stripe` | boolean? | drawn as a stripe |
| `confidence` | number? | 0..1 (vision only) |

Validation: two balls may not overlap (`|pᵢ − pⱼ| ≥ 2R`).
- Practice table: a dragged ball is pushed out to 2R from the ball it lands on.
- Camera: the pipeline's `separateBalls` relaxes the reported positions to convergence. Each
  overlapping pair is set to exactly 2R, a cushion clamp is applied after every move, and
  coincident detections separate along the line from the table centre.
- The planner treats a cue ball within 2R + 1 mm of the object ball as frozen to it (`FROZEN_EPS`).

## TableLayout

| Field | Type | Rule |
|---|---|---|
| `table` | TableSpec | |
| `balls` | Ball[] | 0..22 |
| `source` | `'camera' \| 'virtual'` | |
| `frozen` | boolean | true when the player locked a camera layout |

## Stroke

| Field | Type | Rule |
|---|---|---|
| `power` | number | `1 ≤ power ≤ 10` (fractional allowed). Speed by linear interpolation of the R-12 table |
| `side` | number | tip offset as a fraction of R. `+` = right english |
| `vert` | number | tip offset as a fraction of R. `+` = follow, `−` = draw |
| (constraint) | | `√(side² + vert²) ≤ 0.5` (miscue limit). Clamped radially |

Display (`describeSpin`, `TIP_FRACTION` in `core/shot/power.ts`): **1 tip = 0.25 R** of offset.
So "½ tip low" means `vert = −0.125`, the natural-roll offset 0.4 R reads "1½ tip high", and the
0.5 R miscue limit reads "2 tip high" (the missing plural is a known wording bug).
- 0.25 R is about 7 mm on a pool ball, about one cue-tip radius. That is half the tip-width that
  players usually mean by "one tip" (a 13 mm tip is ≈ 0.45 R on a pool ball and ≈ 0.37 R on a
  snooker ball).
- The earlier text called this "one tip-width", which was wrong. Whether to switch the unit to
  tip-widths is open (analysis.md P-F2, review finding `tip-unit-quarter-radius`).
- Until then the shot card's detail row shows the offset in mm (wave 2a, `fix2a/ui`).

## ShotRequest

| Field | Type | Rule |
|---|---|---|
| `targetId` | string | must reference an object ball |
| `pocketId` | PocketId? | when absent, choose the best makeable pocket |
| `stroke` | Stroke? | player override. When absent, use the recommended or default stroke |
| `landing` | Vec2? | desired CB rest position (position play) |

## ShotPlan (output)

| Field | Type | Notes |
|---|---|---|
| `targetId`, `pocketId` | | |
| `makeable` | boolean | false ⇒ not makeable **or** blocked. Then only `warnings` and `alternatives` are meaningful |
| `ghost` | Vec2 | throw-corrected ghost-ball centre |
| `ghostUncorrected` | Vec2 | pure geometric ghost ball |
| `aimDir` | Vec2 (unit) | the direction the CB travels (cue ball → ghost). This is the line the app draws |
| `cueAimDir` | Vec2 (unit), *optional* | the cue-stick direction: `aimDir` rotated by the squirt correction (clockwise for right english), so the ball squirts onto `aimDir`. Equal to `aimDir` with no side spin. Consumers fall back to `aimDir` |
| `contactPoint` | Vec2 | point on the OB surface touched at impact |
| `obDir` | Vec2 (unit) | intended OB direction (window bisector, or the rail-frozen aim of R-09) |
| `cutAngleDeg` | number | 0..90 for a makeable shot; ≥ 90 means the CB is on the wrong side |
| `cutSide` | `1 \| −1 \| 0` | + = the OB departs to the left (CCW) of the CB line; 0 = straight or frozen |
| `fraction` | number | ball overlap `1 − sin φ` (1 = full, 0.5 = half-ball) |
| `fractionLabel` | string | see "Fraction labels" below |
| `throwDeg` | number | signed OB throw (deg, CCW + in the table frame): OB departure minus the aim line, at the first clean impact probe. See "Throw sign" below |
| `throwShiftMm` | number | distance (mm) the throw correction moved the ghost from `ghostUncorrected` |
| `throwShiftDir` | `'thinner' \| 'thicker' \| 'left' \| 'right'`, *optional* | which way the ghost moved: thinner (the usual cut-induced throw), thicker (e.g. outside english past gearing throws the ball thin), or left/right of the CB line for a near-straight shot (cut < 2°). Absent when there is no shift (or frozen) |
| `squirtDeg` | number | squirt correction (deg), signed with the side spin. 0 when no side spin |
| `stroke` | Stroke | stroke used for the predictions |
| `strokeSource` | `'player' \| 'recommended' \| 'default'` | |
| `minPower` | number | lowest power (analytic chain) at which the OB reaches the mouth with ≥ `pocketArrivalSpeed`: "drops with pace". > 10: not even at full power. This is the minimum the app shows and the "too soft" advice quotes |
| `minPowerCapture` | number, *optional* (always set by `planShot`) | lowest power at which the CB reaches the OB and the OB just crosses the capture line (≤ `minPower`). Below it the ball stops short; between it and `minPower` it only just drops. Optimistic: the simulation needs ≈ 6 % more CB speed (median of 50 random pool9 layouts, up to 12 %). The position search starts here |
| `minPowerSafe` | number, *optional*, deprecated | same as `minPower` |
| `cuePath`, `objectPath` | Trajectory | |
| `otherPaths` | Trajectory[] | other balls set in motion |
| `cueRest` | Vec2 \| null | null if pocketed |
| `obPocketed` | boolean | as simulated, in the chosen pocket |
| `scratch` | boolean | |
| `windowHalfDeg` | number | OB angular margin |
| `toleranceDeg` | number | CB aim tolerance (R-10). 0 when not makeable, never negative |
| `toleranceMm` | number | contact-point tolerance. 0 when not makeable |
| `difficulty` | `'easy' \| 'medium' \| 'hard' \| 'very hard'` | from `toleranceDeg` |
| `warnings` | Warning[] | |
| `tip` | string | up to three coaching sentences |
| `cbSpeedAtContact`, `obSpeed` | number (m/s) | detail |
| `alternatives` | `{ pocketId, toleranceDeg }[]` | the other clear, makeable pockets for this ball, best first |

**Fraction labels** (`fractionOf`):
- "full" from 97 % overlap (cut ≤ 1.7°).
- Otherwise the nearest eighth: "⅞", "¾", "⅝", "½", "⅜", "¼", "⅛". The reference cuts are
  asin(1 − f): 7.2°, 14.5°, 22.0°, 30°, 38.7°, 48.6°, 61.0°.
- The eighth is chosen by nearest overlap. It is prefixed "thin " or "thick " when the real cut is
  more than 2° thinner or thicker than that eighth's reference cut. For example, 40° is "⅜", 42° is
  "thin ⅜", 44° is "thick ¼" and 54° is "thin ¼".
- "thin" below 1/16 overlap (cut > 69.6°).

**Throw sign**: `throwDeg` is a table-frame angle, not a cut-relative one.
- Relative to the cut, `throwDeg · cutSide < 0` means the OB is thrown **thick** (the usual
  cut-induced throw), so the ghost is shifted **thinner**.
- `> 0` means it is thrown **thin**, so the ghost is shifted thicker.
- For a near-straight shot (cut < 2°), `throwShiftDir` says left or right instead.
- Read `throwShiftDir` rather than recomputing it.

**Frozen cue ball** (CB within 2R + 1 mm of the OB; warning `frozen`):
- There is no ghost ball. `ghost` = `ghostUncorrected` = the CB position, `cutAngleDeg` = 0,
  `fractionLabel` = "full", `cutSide` = 0 and `throwShiftDir` is absent.
- `aimDir` is the chosen stroke direction (the line of centres turned by the stroke-angle search).
- `contactPoint` lies on the line of centres. `throwDeg` is the OB departure minus the line of
  centres.
- Draw the cue line from the CB along `aimDir`, not a zero-length cue → ghost segment.

**Corner hanger past the mouth line**: the window distance is 0 and the window's `mouthHit` is the
ball itself. A drawing of the OB → mouth segment should fall back to `objectPath`.

### Trajectory

`{ ballId, points: Vec2[], events: SimEvent[], rest: Vec2 | null, pocket: PocketId | null }`

`points` are sampled at every event and at least every 2 cm of travel (when recording is on).

### SimEvent

`{ t, kind: 'ball' | 'cushion' | 'jaw' | 'pocket' | 'roll' | 'stop', ballId, otherId?, pos }`

### Warning

`{ code, message, ballId? }`. The codes are:

| Code | Meaning |
|---|---|
| `not-makeable` | one of: no pocket window from the ball; the CB is on the wrong side (cut ≥ 90°); the ghost ball would be inside the cushion; the cut is ≥ 88°; frozen balls whose line of centres is outside the window plus the available throw; or, on snooker, a touching ball (push stroke). The message names the best other clear pocket when there is one |
| `blocked-cue` | something is in the CB path to the ghost ball, including after the throw correction moved the ghost. The message names the ball and the best other clear pocket |
| `blocked-object` | something is in the OB path to the pocket |
| `scratch` | CB pocketed |
| `too-soft` | decided after the simulation, so it never contradicts it. "Too soft — the cue ball won't reach the object ball", "Too soft — object ball stops short", "Too far: even full power may not reach the pocket" (all for a simulated miss), or "Very soft — the object ball only just drops" (it drops, but below `minPower`) |
| `kiss` | CB or OB hits another ball first, per the simulation |
| `ob-missed` | OB not pocketed in the simulation, for a reason other than speed or throw |
| `throw-uncompensable` | OB misses because no aim with the ghost clear of the rail cancels the throw, or (frozen) because no stroke angle throws the OB into the window at this speed |
| `thin-cut` | cut > 80° |
| `frozen` | CB touching the OB. The message gives the stroke angle off the line of centres |
| `miscue-risk` | spin offset > 0.45 R |

## Recommendation (planner worker output)

| Field | Type | Notes |
|---|---|---|
| `stroke` | Stroke | |
| `score` | number | robust (worst-case) score, research.md R-11. `−Infinity` only when no stroke pots the ball |
| `reachable` | boolean | with a landing spot: some potting stroke ends within 15 cm of it. Without one: true |
| `restError` | number?, m | distance from the chosen stroke's rest to the landing spot |
| `rest` | Vec2 \| null, *optional* | the chosen stroke's CB rest |
| `evaluated` | number | simulations run (grid plans plus speed variants). Deterministic for a given layout, request and `maxEvaluations` |
| `fragile` | boolean, *optional* | no candidate survived the ±6/±12 % speed check (or the budget ran out first): treat the stroke as speed-sensitive and say so |
| `nextQuality` | number 0..1, *optional* | next-shot quality of the chosen stroke on the post-shot table (default objective only) |
| `timedOut` | boolean, *optional* | the optional wall-clock safety cap cut the search short (the result then depends on device speed) |

## ShotSuggestion

`{ targetId, pocketId, toleranceDeg, difficulty, score }`, sorted by descending `score`.
- `score` = log₁₀(tolerance°) + 0.5 × next-shot quality of the default stroke's leave (ASSUMPTION
  weight, `POSITION_WEIGHT`).
- It loses 2 for a simulated kiss, miss, uncompensable throw or blocked path, and 0.5 for a
  scratch.
- Only geometrically clear, makeable shots are candidates. The 3 × `max` with the best tolerance
  are simulated and ranked; the rest are dropped.

## Vision entities

### Calibration

| Field | Type | Notes |
|---|---|---|
| `corners` | Vec2[4] (image px) | outer cloth edge in table order: (−x,−y), (+x,−y), (+x,+y), (−x,+y) |
| `H0` | number[9] (row-major) | table plane z = 0 (m) → image px |
| `HR` | number[9] | plane z = R → image px |
| `focal` | number (px) | estimated or assumed |
| `focalSource` | `'estimated' \| 'assumed'` | |
| `source` | `'auto' \| 'manual'` | |
| `camera` | Vec3 (m) | camera centre in table coordinates (z = height above the bed) |
| `width`, `height` | number (px) | frame size the calibration belongs to |

`calibrationFromCorners` returns `null` for a quad that cannot be a table outline, or for a pose with
the camera less than 0.3 m above the cushion top (research.md R-03).

### ClothModel

`{ hue, sat, val, kind?: 'chromatic' | 'neutral' }`. For `'neutral'` (grey) cloth, `hue` is
meaningless (0). Consumers must not treat it as a colour: render it grey, and never use it as a hue
hint.

### DetectedBall (per frame, `detectBalls`)

`{ pos (table m), image (px), isCue, score 0..1, rgb [r,g,b], label, white (cue-likelihood score), px (blob pixel count) }`

- **Cue ball**: the whitest *complete* ball (own plus hidden share of its true-size silhouette),
  with a clear margin (0.15) over the runner-up. When the choice is ambiguous (no white ball, two
  whites too close to call, a stripe whose band faces away), **no** ball has `isCue`, and the app
  should ask the player to tap the cue ball.
- **Labels**: 'cue', 'white?' (a white ball that was not picked as the cue), 'black', or a palette
  name.
  - Pool palette: red, maroon, orange, yellow, green, blue, purple, with a " stripe" suffix for
    stripes.
  - Snooker palette: red, pink, brown, yellow, green, blue.
  - 'ball' (neutral) when the hue sits between two prototypes or between the red and maroon
    brightness bounds.
  - `BallDetectOptions.palette` picks the palette (default: snooker on snooker tables). Colour
    names are approximate (Constitution II).
- Two detections from different blobs closer than 1.7 R are merged: real balls cannot be closer
  than 2R.

### TrackedBall (per frame, after the tracker)

`{ id, pos, image, isCue, label, rgb, confidence 0..1 }`.
- `id` is `'cue'` for the track with the strongest cue vote above 0.5; otherwise it is `b<n>`.
- Ids are unique for the life of a pipeline. A geometry change (table, manual corners, swap axes)
  starts a new tracker that continues the numbering. The worker's `reset` message builds a new
  pipeline, so ids restart at b1 (see contracts/worker-protocol.md).

### VisionResult

`{ status: 'searching' | 'unstable' | 'locked', calibration | null, balls: TrackedBall[], quality 0..1, cloth: ClothModel | null, ms, reason? }`

- `calibration` is `null`, and `balls` is empty, on any frame without a usable quad. Nothing stale
  is reported.
- `reason` is set for manual corners only, when the status is not `'locked'`:
  - `'cloth-unknown'`: no cloth colour could be learned for the quad;
  - `'bad-quad'`: the four taps cannot be a table outline;
  - `'moved'`: the quad no longer matches the cloth, i.e. the phone moved since the corners were set.

## State machines

**Vision lock** (`tracker.ts`, `pipeline.ts`):
- A quad counts only when its quality (IoU) is ≥ 0.6, or when it is the manual corners.
- `searching` → `unstable` when a quad is found.
- `unstable` → `locked` after 5 consecutive frames with corner motion < 1.5 % of the diagonal.
- `unstable` or `locked` → `unstable` on a corner jump of more than 6 % of the diagonal. The
  smoothing restarts from the new quad.
- `locked` → `unstable` on the first frame without a quad. That frame reports no calibration and no
  balls.
- Any state → `searching` after 10 consecutive frames without a quad.
- **Occlusion.** Once locked, the outline is an anchor with a cloth-edge profile. While the anchor's
  edges still match (the camera has not moved), a quad elsewhere is an occlusion (an arm, a person,
  an object of another colour). That frame has no quad, and no new cloth is learned. A real camera
  move shifts the edges and releases the anchor.
- **Cloth change.** A new cloth colour must persist for 5 frames, and the anchored table must have
  left its place, before it replaces the established colour. The lock then starts over.
- **Manual corners.**
  - `locked` while quality = min(cloth coverage of the quad, edge alignment relative to the first
    calibrated frame) is ≥ 0.8.
  - Otherwise `unstable` with `reason: 'moved'`.
  - `searching` with `'cloth-unknown'` or `'bad-quad'` when no calibration is possible.

**App mode**: `camera` ⇄ `virtual`.
- In camera mode, `live` ⇄ `frozen`.
- Frozen keeps the layout and calibration snapshot. Unfreeze resumes live updates.
- Constitution II asks for no plan while the table is not locked. On `fix/wave1` the app still
  plans and draws on `unstable` frames that have a quad; gating on `locked`, with a short grace, is
  open (wave 2, `fix2a/live`).

**Selection**: `idle` → `target-selected` (tap a ball) → `planned` (tap a pocket or auto) →
`position-target` (Position + tap). Tapping empty cloth or pressing Clear → `idle`.
