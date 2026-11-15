# Phase 1 Data Model: Real-Time Shot Guide

All units are SI: metres, seconds, radians internally, and degrees only in display fields that end in
`Deg`.

**Revised 2026-11-15** to match the code on `fix/wave1` after the code review (analysis.md,
"Post-review"), then again for `fix2b/app` after the wave-2 fixes. The TypeScript sources of truth
are `src/core/types.ts`, `src/vision/pipeline.ts`, `src/vision/calibration.ts`,
`src/vision/ball-detect.ts`, `src/vision/tracker.ts`, and for the app state `src/app/store.ts`,
`src/app/live-logic.ts` and `src/app/settings.ts`. Fields marked *optional* were added after v1 and
may be absent from older producers.

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

The app's settings presets map to these fields in `app/settings.ts` (`physicsFor`), each with its
source or ASSUMPTION note (Principle I):
- cloth fast / normal / slow → `muRoll` 0.007 / 0.01 / 0.014, inside the 0.005–0.015 range above;
- cushions dead / normal / lively → `cushionE0` 0.8 / 0.88 / 0.9 (lively is the top of the cited
  0.75–0.9 range);
- shaft standard / low-deflection → `squirtMassRatio` 23 / 35.

**Settings** (`Settings`, guarded `localStorage`): cushion width 2–10 cm in 0.5 cm steps; field of
view 40–110° in 1° steps (default 65°). An empty or out-of-range value is rejected in the dialog and
on load (a stored 0 heals to the default). Enter saves; Esc, Cancel and × discard.

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

Display (`describeSpin`, `tipsText`, `TIP_FRACTION` in `core/shot/power.ts`): **1 tip = 0.25 R**
of offset from the centre, about 7 mm on a pool ball (≈ 6.5 mm on a snooker ball). So the 0.5 R
miscue limit is **2 tips**, and the words run from ¼ to 2 tips in quarter steps.
- "½ tip below centre" means `vert = −0.125`; the natural-roll offset 0.4 R reads "1½ tips above
  centre" and the miscue limit "2 tips above centre" (plural above one tip).
- **Decided and kept** (2026-11-15, T082): players who mean a tip-width (a 13 mm tip ≈ 0.45 R on a
  pool ball) would put the miscue limit at about 1 tip and have no words for the small offsets the
  planner uses. The shot card's details therefore also give the offset in mm (`ui/shot-card.ts`
  `tipOffsetMm`: "11 mm below centre, 7 mm right"), so it reads either way.

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
| `aimDir` | Vec2 (unit) | the direction the CB travels (cue ball → ghost). This is the line the app draws (the "blue line") |
| `cueDir` | Vec2 (unit) | the cue-stick direction: `aimDir` rotated by the squirt correction (clockwise for right english), so the ball squirts onto `aimDir`. Equal to `aimDir` with no side spin. The 3D cue stick, the Snap strike point and the 2D "Cue stick" line use it |
| `cueAimDir` | Vec2 (unit), *optional* | the same vector as `cueDir` (the name wave-1 consumers use) |
| `contactPoint` | Vec2 | point on the OB surface touched at impact |
| `obDir` | Vec2 (unit) | intended OB direction (window bisector, or the rail-frozen aim of R-09) |
| `cutAngleDeg` | number | 0..90 for a makeable shot; ≥ 90 means the CB is on the wrong side |
| `cutSide` | `1 \| −1 \| 0` | + = the OB departs to the left (CCW) of the CB line; 0 = straight or frozen |
| `fraction` | number | ball overlap `1 − sin φ` (1 = full, 0.5 = half-ball) |
| `fractionLabel` | string | see "Fraction labels" below |
| `fractionPhrase` | string | the same label in words, by the same 1.5° rule: "½-ball", "a touch thinner than ½-ball", "full-ball", "a thin hit" |
| `throwDeg` | number | signed OB throw (deg, CCW + in the table frame): OB departure minus the aim line, at the first clean impact probe. See "Throw sign" below |
| `throwShiftMm` | number | distance (mm) the throw correction moved the ghost from `ghostUncorrected` |
| `throwAim` | `'thinner' \| 'thicker' \| 'left' \| 'right' \| null` | which way the ghost moved, as the player aims it: thinner (the usual cut-induced throw), thicker (e.g. outside english past gearing throws the ball thin), or left/right of full ball, only when `fractionLabel` is "full". null when there is no shift, and for a frozen cue ball |
| `throwShiftDir` | same values, *optional* | the same as `throwAim`, absent instead of null (an earlier name) |
| `squirtDeg` | number | squirt correction (deg), signed with the side spin. 0 when no side spin |
| `stroke` | Stroke | stroke used for the predictions |
| `strokeSource` | `'player' \| 'recommended' \| 'default'` | |
| `minPower` | number | lowest power (analytic chain) at which the OB reaches the mouth with ≥ `pocketArrivalSpeed`: "drops with pace". > 10: not even at full power. This is the minimum the app shows. The `cb-short` and `too-soft` advice, the tip and the 3D label quote it rounded **up** to the half step (`advisePower`, `POWER_ADVICE_STEP` 0.5), so the quoted figure never triggers them; it is the same figure as the meter's. Frozen cue ball: see "Frozen power advice" below |
| `minPowerCapture` | number, *optional* (always set by `planShot`) | lowest power at which the CB reaches the OB and the OB just crosses the capture line (≤ `minPower`). Below it the ball stops short; between it and `minPower` it only just drops (the meter's dashed "only just drops" band). Optimistic: the simulation needs ≈ 6 % more CB speed (median of 50 random pool9 layouts, up to 12 %). The position search starts here |
| `minPowerSafe` | number, *optional*, deprecated | same as `minPower` |
| `noWorkingPower` | `'throw' \| 'other'`, *optional* | frozen cue ball played too softly, and no power on the scale pots it with pace and keeps the CB up (`minPower` is then 10.5). It means "not more than full power": `'throw'` = harder throws it less; `'other'` = it scratches or never drops with pace |
| `adviceSkipped` | `true`, *optional* | the frozen power advice was skipped (`PlanOptions.advice` false, the default with `record: false`, and the app's own main-thread plan). The too-soft warning then has no figure, and `minPower` is the minimum at the played power's stroke angle, **not** a power to play: callers must not show it as a minimum. The planner worker's `plan` message gives the full plan |
| `cuePath`, `objectPath` | Trajectory | |
| `otherPaths` | Trajectory[] | other balls set in motion |
| `cueRest` | Vec2 \| null | null if pocketed |
| `obPocketed` | boolean | as simulated, in the chosen pocket |
| `scratch` | boolean | |
| `windowHalfDeg` | number | OB angular margin |
| `toleranceDeg` | number | CB aim tolerance (R-10); frozen: the stroke-angle tolerance (≤ 16°). 0 when not makeable, when the stroke misses as played or when no power works; never negative |
| `toleranceMm` | number | contact-point tolerance; frozen: the departure margin × 2R. 0 whenever `toleranceDeg` is |
| `difficulty` | `'easy' \| 'medium' \| 'hard' \| 'very hard'` | from `toleranceDeg`; no margin ⇒ 'very hard' |
| `warnings` | Warning[] | |
| `tip` | string | up to three coaching sentences |
| `strokeName` | string \| null | the stroke as coaches name it ("Draw", "Stun", "Stop shot", "Follow, right english"). null whenever the CB never reaches the OB, makeable or not. A frozen shot names it from the stroke angle |
| `cbSpeedAtContact`, `obSpeed` | number (m/s) | detail |
| `obPocketSpeed` | number (m/s) | OB speed as it crosses into the pocket (0 when it does not drop); the pace reference ("pocket speed + 2 diamonds") comes from it |
| `alternatives` | `{ pocketId, toleranceDeg }[]` | the other clear, makeable pockets for this ball, best first |

**Fraction labels** (`fractionOf`):
- "full" from 97 % overlap (cut ≤ 1.7°).
- Otherwise the nearest eighth: "⅞", "¾", "⅝", "½", "⅜", "¼", "⅛". The reference cuts are
  asin(1 − f): 7.2°, 14.5°, 22.0°, 30°, 38.7°, 48.6°, 61.0°.
- The eighth is chosen by nearest overlap. It is prefixed "thin " or "thick " when the real cut is
  more than 1.5° (`FRACTION_EXACT_DEG`) thinner or thicker than that eighth's reference cut. For
  example, 40° is "⅜", 42° is "thin ⅜", 44° is "thick ¼" and 54° is "thin ¼". `fractionPhrase` uses
  the same rule ("a touch thinner than ⅜-ball"), so label and phrase never disagree.
- "thin" below 1/16 overlap (cut > 69.6°).
- The app's table labels use the card tile's wording: "30° · ½-ball hit", "36° · ⅜+ ball",
  "Frozen · stroke 12° left", "Not makeable".

**Throw sign**: `throwDeg` is a table-frame angle, not a cut-relative one.
- Relative to the cut, `throwDeg · cutSide < 0` means the OB is thrown **thick** (the usual
  cut-induced throw), so the ghost is shifted **thinner**.
- `> 0` means it is thrown **thin**, so the ghost is shifted thicker.
- When `fractionLabel` is "full", `throwAim` says left or right of full ball instead.
- Read `throwAim` rather than recomputing it. The card words it with `throwSentence`: "Throw ≈ 1.2°
  pushes the object ball thick, so the ghost ball is shifted 1.3 mm thinner."; outside english is
  named as the cause of a thicker shift, and a full-ball hit says "Throw: …" for a centre-ball stroke
  and "Side-spin throw: …" with side.

**Frozen cue ball** (CB within 2R + 1 mm of the OB; warning `frozen`):
- There is no ghost ball. `ghost` = `ghostUncorrected` = the CB position, `cutAngleDeg` = 0,
  `fractionLabel` = "full", `cutSide` = 0, `throwAim` is null and `throwShiftDir` is absent.
- `aimDir` is the chosen stroke direction (the line of centres turned by the stroke-angle search).
  The `frozen` warning gives that angle; `strokeName` is named from it. The margin is the stroke
  angle's (shown in degrees). When no angle throws the OB in at this speed, the `frozen` message says
  the angle shown is "the closest it gets to the pocket at this speed".
- `contactPoint` lies on the line of centres. `throwDeg` is the OB departure minus the line of
  centres.
- Draw the cue line from the CB along `aimDir` (the app draws 3R + 0.1 m of it, 10 cm past the
  object ball, clipped to the bed), not a zero-length cue → ghost segment.
- **Frozen power advice** (`PlanOptions.advice`): when the played stroke is too soft, the stroke is
  replanned at every half step above it (harder throws less, so the angle and the minimum move with
  the power). Only the first run of powers that pots with pace and keeps the CB up is quoted ("A",
  "A–B" or "A+"), with the reason the run ends (throw, or a scratch at X). `minPower` is then the
  lowest working power (to about 0.06) and `minPowerCapture` is capped at it. With no such run the
  warning says no power gets it in with pace (and gives the centre-ball powers for a stroke with
  spin), `minPower` is 10.5 and `noWorkingPower` is set. The advice is checked on the half-step scale
  only; powers in between are not checked.

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
| `cb-short` | both the analytic chain and the simulation say the CB stops before the OB: "The cue ball stops before it reaches the 3. Use power 4.5+." (or "…, even at full power."). It names the ball, replaces the old "won't reach" too-soft message, and is never emitted together with `too-soft` |
| `too-soft` | decided after the simulation, so it never contradicts it. "Too soft — object ball stops short.", "Too far: even full power may not reach the pocket." (both for a simulated miss), or "Very soft — the object ball only just drops; any roll-off will miss." (it drops, but below `minPower`). The advice figure is `advisePower(minPower)`; a frozen cue ball gets the frozen power advice above, or no figure while `adviceSkipped` |
| `kiss` | CB or OB hits another ball first, per the simulation |
| `ob-missed` | OB not pocketed in the simulation, for a reason other than speed or throw |
| `throw-uncompensable` | OB misses because no aim with the ghost clear of the rail cancels the throw, or (frozen) because no stroke angle throws the OB into the window at this speed |
| `thin-cut` | cut > 80° |
| `frozen` | CB touching the OB. The message gives the stroke angle off the line of centres; when no angle throws it in, it says that angle is the closest it gets to the pocket at this speed |
| `miscue-risk` | spin offset > 0.45 R |

## Recommendation (planner worker output)

| Field | Type | Notes |
|---|---|---|
| `stroke` | Stroke | |
| `score` | number | robust score, research.md R-11: the worst of nominal and ±6/±12 % speed, blended half and half with the worst tip/aim/shaft probe when those ran, including the coaching penalties. `−Infinity` only when no stroke pots the ball |
| `risks` | `{ scratchIf: 'harder' \| 'softer' \| 'tip' \| 'aim'; pocketId }[]`, *optional* | cue-ball scratches the robustness checks saw. A list (empty: none seen) when every check ran; **absent means "not known", never "safe"** (a fragile stroke, or a budget that ran out before the tip/aim probes). Never `[]` for a fragile stroke |
| `reachable` | boolean | with a landing spot: some potting stroke ends within 15 cm of it. Without one: true |
| `restError` | number?, m | distance from the chosen stroke's rest to the landing spot |
| `rest` | Vec2 \| null, *optional* | the chosen stroke's CB rest |
| `evaluated` | number | simulations run (grid plans plus speed variants). Deterministic for a given layout, request and `maxEvaluations` |
| `fragile` | boolean, *optional* | no candidate survived the ±6/±12 % speed check (or the budget ran out first). Shown, in the toast and the card, as the one sentence "This stroke may need precise pace: a little harder or softer could miss or scratch." |
| `nextQuality` | number 0..1, *optional* | next-shot quality of the chosen stroke on the post-shot table (default objective only) |
| `timedOut` | boolean, *optional* | the optional wall-clock safety cap cut the search short (the result then depends on device speed) |

## ShotSuggestion

`{ targetId, pocketId, toleranceDeg, toleranceMm, difficulty, score, frozen? }`, sorted by descending
`score`. Tolerance and difficulty are the verified default-stroke plan's; `score` still ranks by the
geometric tolerance; `frozen: true` when the CB touches the OB.
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
  starts a new tracker that continues the numbering. The worker's `reset` message calls
  `pipeline.reset()`, which keeps the counter too (contracts/worker-protocol.md). A new vision
  *worker* is a new pipeline: the app drops its live selection then.

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

**App mode**: `camera` (labelled Live) ⇄ `practice` ⇄ `snap` (feature 002).
- In camera mode, `live` ⇄ `frozen`.
- Frozen keeps the layout and calibration snapshot (`frozen.gen` is the table-frame generation it
  was taken in). Unfreeze ("Go live") resumes live updates.
- **Lock gate** (Constitution II, `live-logic.ts` `liveGate`): the live layout is planned on and
  drawn only while the table is `locked`, or `unstable` within `LOCK_GRACE` = 2 results after a lock
  (a single missed quad does not hide the plan), and only with a calibration.
  `LiveVision.sinceLocked` counts the results since the last lock (Infinity = never locked).
- After Rotate, setting or clearing corners, or a table or field-of-view change, the new table frame
  gets no grace from the old frame's lock: nothing is planned, drawn or restored on it until it locks
  itself, and then the usual 2-result grace applies.
- A frozen plan is drawn on the camera view only through a live calibration with the same ordered
  corners (`framesMatch`, within 3 % of the frame diagonal), so a 180° flip or Rotate is caught.

### App state (`src/app/store.ts`)

| Field | Type | Notes |
|---|---|---|
| `vision` | `LiveVision \| null` | the last live result: `status`, `calibration`, `balls`, `quality`, `ms`, the frame size and `sinceLocked` |
| `frozen` | `{ layout, calibration, gen? } \| null` | the frozen snapshot |
| `targetId`, `targetMem` | string \| null, `SelectionMemory \| null` | the target, and in Live where it was last seen (`{ id, pos, label? }`), so a selection whose tracker id disappears is re-bound to a new track at the same spot |
| `cueOverrideId`, `cueMem` | string \| null, `SelectionMemory \| null` | the ball the player marked as the cue ball (FR-007), live or frozen, with its memory |
| `pocketId`, `landing` | PocketId \| null, Vec2 \| null | the pocket and the position-play spot |
| `recommended` | `{ key, stroke, pending, reachable, evaluated, risks?, fragile?, timedOut?, nextQuality? } \| null` | the planner worker's answer for the request `key`. `fragile`, `timedOut`, `nextQuality` and `risks` are copied from the Recommendation as is: **`risks` absent means "not known", never "safe"**. `ui/shot-card.ts` `recommendationContext` is the reader, and `main.ts` passes its notes to the card |
| `interaction` | `'select' \| 'position' \| 'calibrate' \| 'mark-cue' \| 'pick-next'` | what the next tap does |
| `manualCorners`, `swapAxes` | Vec2[] \| null, boolean | sent to the vision worker in `config` |

**Selection**: `idle` → `target-selected` (tap a ball) → `planned` (tap a pocket or auto) →
`position-target` (Position + tap). Tapping empty cloth or pressing Clear → `idle`.
- **Picking a ball by tap**: the pick radius is at least 22 CSS px (a 44 px target) on the 2D table,
  the mini-map, the camera overlay and the 3D table. A ball within its natural radius always wins
  (2D: 1.8·R + 12 px; overlay: max(14 px, 2.2·R_px); 3D: 1.8·R + 12 px at the ball's distance). A
  ball reached only through the 22 px floor yields to a pocket mouth nearer the tap.
- In Position mode every tap, even next to a ball, sets the landing spot.
- Live with no ball marked as the cue (`cameraHint`): the card hint is 'No cue ball found — tap “Cue
  ball”, then tap the cue ball.', or with two whites too close to call 'Two white balls — tap “Cue
  ball”, then tap the one you play with.'. Tapping an object ball keeps it as the target and asks for
  the cue ball first. While the *Cue ball* tool is on, the hint is "Tap the cue ball.".
- **Rotate and Calibrate keep the selection** (`rememberInFrame`, `remapThroughFrame`): the target,
  the marked cue ball, the pocket and the landing are remembered in frame px and found again where the
  camera sees them once the new frame locks: the nearest ball within max(12 px, 2 ball radii) with
  the same label, or max(6 px, 1 radius) otherwise ("Kept your selection."). If nothing is found within
  `REMAP_TTL` = 15 results: "The selection was cleared: the table frame changed.". A table or
  field-of-view change in Settings clears it ("Selection cleared — the table frame changed.").

**Pocket names** (`app/pocket-names.ts`): in Live and on Snap's table photo, pockets are named from
where they appear in the image: the two corners highest in the image are "far", the other two
"near", each pair split into left and right; the side pockets are left/right or far/near. Names
from where the player stands (`shooterPocketNames`) go by bearing: "corner straight ahead", "corner
behind you", "corner on your right/left", else far/near and left/right ("far right corner"). They
never put a pocket on the wrong side and never call a corner behind the player "far"; they fall back
to ranking only when more than three corners are on one side (or the pose is degenerate).

**Ball look** (2D, 3D and the card's chips): a ball vision could not name (`'ball'`) gets no letter
and, without a measured colour, neutral grey `#9a9a9a`. Snooker colours are canonical in 2D too.
With the table known, the card title, the ball picker and the suggestions letter balls like the 3D
tags: on pool a colour maps to its number ('red' → 3, 'yellow stripe' → 9); on snooker
R/Y/G/Br/Bl/P/Bk. A grey (neutral) cloth is rendered grey.
