# Phase 1 Data Model: Real-Time Shot Guide

All units are SI: metres, seconds, radians internally, and degrees only in display fields that end in
`Deg`.

**Table frame**:
- The origin is the centre of the playing surface (cushion nose to cushion nose).
- `+x` runs along the long rail toward the "right" short rail. `+y` runs toward the "top" long rail.
  `+z` points up from the bed.

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
| `cushionHeight` | number (m) | default `0.635 × 2R`. Nose height (vision only) |
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
| `muSlide` | 0.20 | Alciatore, typical cloth sliding friction |
| `muRoll` | 0.010 | rolling resistance (0.005 fast cloth … 0.015 slow) |
| `spinDecel` | 10 rad/s² | ASSUMPTION: sidespin decay on cloth, so ~3 s of spin |
| `eBall` | 0.95 | phenolic ball–ball restitution |
| `ballFriction` | {a: 9.951e-3, b: 0.108, c: 1.088} | μ(v) = a + b·e^(−c·v), Alciatore TP A.14 |
| `cushionE0`, `cushionESlope`, `cushionEMin` | 0.88, 0.035, 0.55 | e_c = max(min, e0 − slope·\|vₙ\|) |
| `muCushion` | 0.20 | ASSUMPTION: cushion contact friction |
| `squirtMassRatio` | 23 | m_ball / m_endmass for a standard shaft. 35 for low-deflection (TP A.31) |
| `dt` | 0.001 s | simulator step |
| `maxTime` | 12 s | simulation cap |
| `pocketArrivalSpeed` | 0.3 m/s | the minimum OB speed at the mouth for "makes it" |

## Ball

| Field | Type | Rule |
|---|---|---|
| `id` | string | unique within a layout. `'cue'` for the cue ball |
| `kind` | `'cue' \| 'object'` | exactly one `'cue'` per plannable layout |
| `pos` | Vec2 | must lie within `|x| ≤ L/2 − R`, `|y| ≤ W/2 − R`. Clamped on input |
| `label` | string? | e.g. "8", "red", "yellow" |
| `color` | string? | CSS colour for drawing |
| `confidence` | number? | 0..1 (vision only) |

Validation: no two balls may overlap by more than 2 mm (`|pᵢ − pⱼ| ≥ 2R − 0.002`). Overlaps are
resolved by pushing the balls apart on input.

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

Display: 1 tip ≈ 0.25 R, so "½ tip low" means `vert = −0.125`.

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
| `makeable` | boolean | false ⇒ only `warnings` and `alternatives` are meaningful |
| `ghost` | Vec2 | throw-corrected ghost-ball centre |
| `ghostUncorrected` | Vec2 | pure geometric ghost ball |
| `aimDir` | Vec2 (unit) | CB travel direction |
| `contactPoint` | Vec2 | point on the OB surface touched at impact |
| `obDir` | Vec2 (unit) | intended OB direction (window bisector) |
| `cutAngleDeg` | number | 0..90 |
| `fraction` | number | ball overlap `1 − sin φ` (1 = full, 0.5 = half-ball) |
| `fractionLabel` | string | "full", "¾", "½", "¼", "⅛", "thin" |
| `throwDeg` | number | OB throw angle for this stroke (+ = thrown toward the cut side) |
| `throwShiftMm` | number | ghost-ball shift applied to compensate for throw |
| `squirtDeg` | number | cue aim correction for squirt. 0 when no side spin |
| `stroke` | Stroke | stroke used for the predictions |
| `strokeSource` | `'player' \| 'recommended' \| 'default'` | |
| `minPower` | number | lowest power level that delivers the OB at `pocketArrivalSpeed` |
| `cuePath`, `objectPath` | Trajectory | |
| `otherPaths` | Trajectory[] | other balls set in motion |
| `cueRest` | Vec2 \| null | null if pocketed |
| `obPocketed` | boolean | as simulated |
| `scratch` | boolean | |
| `windowHalfDeg` | number | OB angular margin |
| `toleranceDeg` | number | CB aim tolerance (R-10) |
| `toleranceMm` | number | contact-point tolerance |
| `difficulty` | `'easy' \| 'medium' \| 'hard' \| 'very hard'` | |
| `warnings` | Warning[] | |
| `tip` | string | coaching sentence(s) |
| `cbSpeedAtContact`, `obSpeed` | number (m/s) | detail |

### Trajectory

`{ ballId, points: Vec2[], events: SimEvent[], rest: Vec2 | null, pocket: PocketId | null }`

`points` are sampled at every event and at least every 2 cm of travel.

### SimEvent

`{ t, kind: 'ball' | 'cushion' | 'jaw' | 'pocket' | 'roll' | 'stop', ballId, otherId?, pos }`

### Warning

`{ code, message, ballId? }`. The codes are:

| Code | Meaning |
|---|---|
| `not-makeable` | no pocket window, or the cut is ≥ 88° |
| `blocked-cue` | something is in the CB path to the ghost ball |
| `blocked-object` | something is in the OB path to the pocket |
| `scratch` | CB pocketed |
| `too-soft` | power < `minPower` |
| `kiss` | CB or OB hits another ball first, per the simulation |
| `ob-missed` | OB not pocketed in the simulation |
| `thin-cut` | cut > 80° |
| `frozen` | CB touching the OB |
| `miscue-risk` | spin offset > 0.45 R |

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

### DetectedBall

`{ pos (table m), image (px), isCue, score 0..1, rgb [r,g,b], label, white (cue-likelihood score), px (blob pixel count) }`

Two detections closer than 1.7 R are merged: real balls can't be closer than 2R.

### VisionResult

`{ status: 'searching' | 'unstable' | 'locked', calibration | null, balls: DetectedBall[], quality 0..1, ms }`

## State machines

**Vision lock**:
- `searching` → `unstable` when a quad is found.
- `unstable` → `locked` after 5 consecutive frames with corner motion < 1.5 % of the diagonal.
- `locked` → `unstable` on a large jump.
- any → `searching` after 10 frames without a quad.

**App mode**: `camera` ⇄ `virtual`.
- In camera mode, `live` ⇄ `frozen`.
- Frozen keeps the layout and calibration snapshot. Unfreeze resumes live updates.

**Selection**: `idle` → `target-selected` (tap a ball) → `planned` (tap a pocket or auto) →
`position-target` (Position + tap). Tapping empty cloth or pressing Clear → `idle`.
