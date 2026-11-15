# Phase 1 Data Model: 3D Table, Two-Photo Snap Guide, Polished UI and iOS App

All 001 entities ([001 data-model](../001-realtime-shot-guide/data-model.md)) are unchanged. Units
are SI internally.

**Revised 2026-11-15** to match `fix2b/app`. The TypeScript sources of truth are
`src/app/render3d/index.ts`, `src/app/render3d/camera.ts`, `src/app/render3d/gestures.ts`,
`src/app/snap/session.ts`, `src/app/snap/guide.ts`, `src/vision/player-view.ts` and
`src/workers/protocol.ts`.

## Coordinate frames

| Frame | Definition |
|---|---|
| **Table** | As in 001. Origin at the playing-surface centre, `+x` along the long rail, `+y` toward the top long rail, `+z` up from the bed. A ball centre is at `z = R` |
| **Camera** (player photo) | OpenCV convention, matching `vision/synth/render.ts` `CameraModel.R` rows: `x` right, `y` down, `z` forward. `X_c = R·X_w + t`. The camera centre is `C = −Rᵀt` |
| **Image** | Pixels of the processed frame (after orientation and downscale). Origin top-left. `u = f·X_c/Z_c + cx`, `v = f·Y_c/Z_c + cy` |
| **Client** | CSS pixels in client (viewport) coordinates, like `PointerEvent.clientX/Y`: `getBoundingClientRect()`-based, with no scroll offset. This is what `Table3D.toScreen` returns and `pick` takes |
| **Shooter** | `aimDir` (unit, table plane). `right = (aimDir.y, −aimDir.x)` and `up = ẑ`. `side > 0` is right english and `vert > 0` is follow |

## Scene3DData (input to the 3D view)

| Field | Type | Rule |
|---|---|---|
| `table` | TableSpec | any 001 preset |
| `balls` | Ball[] | 0..22. Positions are clamped by the app before `setData` |
| `plan` | ShotPlan \| null | drawn when non-null and `makeable`. Only warnings otherwise |
| `targetId` | string \| null | ring on the target ball |
| `pocketId` | PocketId \| null | pocket highlight |
| `landing` | Vec2 \| null | landing marker (001 US5) |
| `heatmap` | `{ cols, rows, values: Float32Array }` \| null | row-major, 0..1, over the bed |
| `stroke` | Stroke \| null | cue-stick tip offset and pull-back. Defaults to `plan.stroke` |
| `clothRgb` | `[r,g,b]`? | 0..255. Defaults to the brand felt `#0E6B4F`. Snap passes the table photo's cloth (`snap/photo.ts` `clothRgbOf`); a grey (neutral) cloth model is drawn grey, never with its meaningless hue |
| `riskPockets` | PocketId[]? | pockets where the recommended stroke scratches under a small error (`Recommendation.risks`): dashed rings |

`setData` is cheap: it stores a reference, marks the scene dirty and renders on the next animation
frame. The renderer never mutates the data.

## Camera3DState

| Field | Type | Rule |
|---|---|---|
| `preset` | `'overview' \| 'player' \| 'broadcast' \| 'custom'` | becomes `custom` after an orbit or pan |
| `lastPreset` | CameraPreset | the double-tap target |
| `target` | Vec3 | clamped by user gestures to the table's outer rectangle |
| `yaw` | rad | free |
| `pitch` | rad | user gestures: 8°…89°. Presets may use 90° |
| `distance` | m | user gestures: `DIST_MIN` … `DIST_MAX` (`camera.ts`) |
| `fovY` | rad | per preset |

### Presets (R-18; defaults are tunable, and `src/app/render3d/camera.ts` is authoritative)

| Preset | Eye / orbit parameters |
|---|---|
| `overview` | pitch 90°, fov 30°. Yaw aligns the long axis with the viewport's long axis (landscape: +x right, like 2D). Distance fitted with ≈ 3.5 % margin, minus UI insets |
| `player` | eye 0.5 m behind the cue ball along −aimDir (`PLAYER_BACK`), 0.21 m above the bed (`PLAYER_EYE_HEIGHT`) and at least 7 cm above the cue's rail-clearing line (so beyond the rail when the ball is frozen to it), fov 50° (landscape) or 58° (portrait). To keep the pocket, the object ball's path and the ghost ball in view it may back off by up to 0.38 m, widen the fov by up to 17° and turn toward the pocket. The look point lies on z = R. Without a plan, aimDir = cue → table centre. In this view the cue takes three idle practice strokes (1.8 s each) after the stroke, the cue ball or the view changes, then rests at address; none with reduced motion |
| `broadcast` | elevated 3/4 view, fov 38°. Landscape: yaw ≈ −112°, pitch ≈ 34°. Portrait: yaw ≈ 196°, pitch ≈ 40°. Distance fitted |

Flights interpolate (target, yaw, pitch, log distance, fovY) over 720 ms with an ease-in-out cubic,
or instantly with reduced motion.

## Pick3D

`{ kind: 'ball', id } | { kind: 'pocket', id } | { kind: 'cloth', pos } | null`. The priority
(`render3d/picking.ts`, R-19):
1. an exact sphere hit, nearest first;
2. a ball whose closest approach to the ray is within its natural radius, 1.8·R + 12 CSS px at the
   ball's distance (the nearest ball wins);
3. a ball reached only through the 22 CSS px floor yields to a pocket mouth that is nearer the tap on
   screen (the same rule as the 2D table and the camera overlay);
4. a pocket capture disc on the bed: centred 2 cm from the mouth centre into the pocket, radius
   0.75 × the mouth width, and at least 22 CSS px;
5. a bed point, else `null`.

## Gesture state machine (3D canvas)

The pure state machine `src/app/render3d/gestures.ts` (tests: `tests/unit/app/render3d-gestures.test.ts`):

```text
idle ──pointerdown──▶ pending(start, t0, hitBall?)
pending ──moved ≥ 8 px & hitBall──▶ ball-drag   (onBallDrag 'start' … 'move' … 'end')
pending ──moved ≥ 8 px & !hitBall──▶ orbit     (camera → 'custom', onCameraChange)
pending ──2nd pointer──▶ pinch-pan             (zoom by distance ratio, pan by midpoint)
pending ──up < 8 px & < 350 ms──▶ tap           (onTap(pick)); a 2nd tap on empty cloth ≤ 320 ms, ≤ 30 px → lastPreset
wheel ──▶ custom, zoom × exp(dy·0.0015)         (Ctrl + wheel, a trackpad pinch: exp(dy·0.01))
any ──pointercancel / lost capture──▶ idle      (never a tap; ball-drag emits 'end' at the last position)
```

## Playback (R-17)

### Playback track (pure, per moving ball)

| Field | Type | Notes |
|---|---|---|
| `ballId` | string | |
| `t[]`, `x[]`, `y[]` | Float64Array | one entry per recorded point. Points at events get the event's exact time; others are spread by arc length with a constant display deceleration (R-17) |
| `q[]` | Float64Array (4 per point) | cumulative rolling rotation: displacement `d` → `\|d\|/R` about `ẑ × d̂` |
| `start` | s | 0 for the cue ball; the first `ball` event time for others |
| `end` | s | the time the ball stops or enters the pocket mouth |
| `pocket` | `{ id, x, y, depth }` \| null | drop animation after `end` |

`sample(track, t) → { x, y, z, q }`. It is exact at every event time.

### Optional slip state (R-17 level 2, FR-108 SHOULD)

`{ q: quat (world←ball), ω: Vec3 }`.
- Initial ω for the cue ball: `strikeBall(aimDir, stroke, table, params).omega`. For object balls:
  0.
- Sub-steps ≤ 4 ms:
  - **sliding**: `ω += (5 μ_slide g / 2R)(ẑ × û)·dt`;
  - **rolling**: `ω_h = ẑ × v/R`;
  - **sidespin**: `ω_z` decays at `spinDecel`;
  - **orientation**: `q ← exp(½ω dt) ⊗ q`.

**Resting orientation**: number up, tilted toward the default camera, so numbers read in Overview.

### Playback state machine

```text
idle ──playShot(plan, {slow?})──▶ lead-in(0.5 s strike) ──▶ playing(rate = max(1, T/4); ½ with slow)
playing ──t ≥ T──▶ holding(3.5 s; 6.3 s with reduced motion) ──▶ idle (restore Scene3DData layout; promise resolves)
lead-in|playing|holding ──stopPlayback() / tap / Skip / Escape / setData with a new plan──▶ idle (restore; promise resolves)
```

With recorded trajectories (`Trajectory.times`, `Trajectory.spins`), the replay passes every
recorded point at its simulated time (scaled by the rate) and shows sliding from the recorded spins;
hand-built tracks match their event points within 1 µm (`EVENT_MATCH_M`).

## Cue stick pose

| Quantity | Value |
|---|---|
| Axis | through the strike point (`strikePoint3` in `scene-data.ts`, the same convention as `vision/player-view.strikePoint`) |
| Axis direction | `ShotPlan.cueDir` (`cueAimDir` is the same vector; `render/plan-draw.ts` `stickDir`): the cue's own squirt-corrected line, while the drawn ball path stays `aimDir` |
| Tip gap behind the strike point | `cueGap(power) = 0.05 + 0.03·power` m (display mapping, not physics) |
| Elevation | small minimum (`MIN_CUE_ELEVATION` = 4°), raised only to clear the rail behind the cue ball (max 60°) |
| Visibility | when a plan (or a target) exists, outside the Top view and below 70° of camera pitch; in a replay only during the strike |

## Player view (vision)

### KnownBall

`{ id, pos: Vec2 (table m), isCue, rgb?: [r,g,b] }`, from the confirmed Snap layout (`rgb` from the
table photo's tracked balls).

### PlayerViewInput

| Field | Type | Rule |
|---|---|---|
| `frame` | Frame | RGBA, long side ≤ 1600 px (the app sends 960, `snap/photo.ts` `SNAP_MAX_DIM`; the test fixtures are 1280) |
| `table` | TableSpec | same preset as the table photo |
| `balls` | KnownBall[] | ≥ 1, exactly one with `isCue` |
| `cueId` | string | must match the `isCue` ball |
| `targetId` | string? | sets the yaw hypotheses and the confidence point (ghost ball) |
| `focalPx` | number? | soft prior (σ log f = 0.15); otherwise a 65° HFOV prior (σ = 0.6) |
| `manualTaps` | `{ cue: Vec2; target: Vec2 }`? | image px. Switches to the R-25 fallback |

### CameraPose

| Field | Type | Rule |
|---|---|---|
| `R` | number[9] | row-major world→camera rotation. Orthonormal, det = +1 |
| `t` | Vec3 | m. `X_c = R·X_w + t` |
| `f` | number | px, > 0 |
| `cx`, `cy` | number | px. The image centre for the estimator |
| `width`, `height` | number | px of the frame the pose refers to |

### PlayerViewResult

| Field | Type | Notes |
|---|---|---|
| `ok` | boolean | confidence ≥ 0.5 and the residual and match rules of R-24 |
| `pose` | CameraPose \| null | may be non-null with `ok = false` (low-confidence pose, for display hints only) |
| `confidence` | 0..1 | capped at 0.7 for the manual fallback |
| `residualPx` | number | robust RMS of the ball-centre residuals |
| `matched` | `{ id, image, radiusPx }[]` | balls found in the photo and their ids |
| `reason` | string? | player-facing, present when `!ok` (see below). Also used for "not behind the cue ball" warnings when `ok` |
| `ms` | number | solver time |

Reason messages (the canonical wording; the app shows them verbatim):

| Situation | `reason` |
|---|---|
| fewer than 2 balls matched | "I can't see enough balls. Include the cue ball and at least two others." |
| the layout contradicts the photo | "The balls seem to have moved. Retake the table photo." |
| too dark or no cloth found | "The photo is too dark to read the table. Add light or hold the phone steady." |
| cue ball not matched | "I can't find the cue ball. Tap the cue ball, then your target." |
| camera far from the shooter's position | "You're not behind the cue ball. The guide is drawn from where you stood." (a warning; `ok` may be true) |
| solver did not converge | "I couldn't line up this photo. Tap the cue ball, then your target." |

### Strike point

`strikePoint(c: Vec3, aimDir: Vec2, side, vert, R) = c − aimDir·R·√(1 − side² − vert²) +
side·R·right + vert·R·ẑ`, with `side² + vert² ≤ 0.25` (the 001 miscue clamp) so `|P − c| = R`. It
is visible when `(P − C)·(P − c) < 0`.

### PlayerGuide (what is drawn on the photo, image px)

| Element | Source | Encoding |
|---|---|---|
| Aim line | cue → ghost on the cloth (z = 0), projected polyline | solid blue `#0072B2` |
| Ghost ball | `projectBallOutline(ghost, R)` | dotted white ring |
| Contact point | `plan.contactPoint` at z = R | small dot |
| Object-ball path | `plan.objectPath.points` at z = 0 | solid orange `#E69F00`, pocket ring and chevron |
| Cue-ball path (toggle) | `plan.cuePath.points` | dashed sky `#56B4E9` |
| Strike dot | `projectPoint(strikePoint(...))`, radius = projected tip radius | blue disc, white halo, dark stroke, text label |
| Miscue ring and centre cross | 3D circle and arcs on the sphere, projected | dashed ring, thin cross |
| Cue-ball inset | 2.5× crop around the projected cue-ball outline | same drawing |
| Power | `plan.stroke.power`, `speedWord`, `minPower` | numerals + word + `renderPowerMeter` |
| Confidence | `PlayerViewResult.confidence` | chip: "Fit: good / fair / low" + percentage, for the target the fit was made for (`SnapSession.player.fitTargetId`) |
| Hidden parts | `PlayerGuide.hidden { aim, objectPath, cuePath }`: the stretches that another ball (`GuideInput.others`, the other balls of the layout) hides from the camera | drawn dashed and labelled "hidden", never dropped; a message says so. Line under the cue ball or the target itself is not "hidden" |
| Off-frame parts | visibility tests | an edge arrow plus a message |
| Aim label | `PlayerGuide.aimLabel { text, at, r, warn } \| null`: the photo label of a plan with **no ghost ball** (a frozen cue ball) | `planLabel`'s words ("Frozen · stroke 12° left") at the stroke line's end when that end is in the photo, otherwise on the cue ball; "Not makeable" (`warn`) on the cue ball. Null when the ghost ball carries the label or no anchor is in the photo. `at` and `r` are image px; `guide.ts` `aimLabelAnchor(aimLabel, mapping)` gives the canvas circle (centre by `toScreen`, radius by the mapping's scale), and `snap/draw.ts` places the label there, clear of the "Strike here" label |

`guide.ts` builds no HUD text. The Snap HUD's aim line and the guide instruction come from
`snap/session.ts` `snapAimText` and `snapGuideInstruction` (a frozen cue ball: "Frozen: stroke N° to
the left/right of the line of centres"), and the HUD meter from `ui/power-meter.ts`, as on the card.

## SnapSession (state machine)

*Revised 2026-11-15* to `src/app/snap/session.ts`. The steps (`SnapStep`) and the events that move
between them:

```text
intro ──overview-photo──▶ overview-processing          (photo decoded; 'still' sent)
overview-processing
 ──overview-result, detectionUsable──▶ review          (outline + balls; fix the layout, pick the target)
 ──overview-result, no calibration──▶ overview-error   (the reason in words, see below)
 ──overview-failed──▶ overview-error                   (the vision worker failed)
overview-error ──start-corners──▶ corners ──4 corner-taps──▶ overview-processing   ('still' with the taps)
corners ──4 implausible taps──▶ overview-error         (refused locally, nothing sent)
corners ──cancel-corners──▶ review (a layout exists) | overview-error
review ──layout──▶ review                              (edited layout)
review ──player-photo──▶ player-processing             ('player-view' sent)
player-processing ──player-result ok──▶ guide
player-processing ──player-result !ok, player-failed──▶ manual-taps   (reason shown)
manual-taps ──manual-tap (cue), manual-tap (target)──▶ player-processing   ('player-view' with manualTaps)
guide ──refit──▶ guide (player.refitting)              (a new target: the same photo is fitted again)
guide ──edit-layout──▶ review ──back-to-guide──▶ guide | manual-taps
any ──reset (Start over, leaving Snap)──▶ intro        (photos released)
```

| Field | Type | Notes |
|---|---|---|
| `step` | `SnapStep` | the steps above |
| `overview` | `PhotoInfo & { vision: VisionResult \| null }` \| null | the table photo's size and source (`camera`, `library`, `sample`) and its detection |
| `layout` | Ball[] \| null | the detected, then edited, layout |
| `corners`, `cornerTaps` | Vec2[] \| null, Vec2[] | tapped cloth corners (table-photo px) and the taps in progress |
| `player` | `PhotoInfo & { result; fitTargetId?; manual?; refitting? }` \| null | the player photo and its fit. `fitTargetId`: the target the fit (and its confidence) was made for; `manual`: a fit from the two taps; `refitting`: a quiet re-fit for a new target |
| `taps` | `{ cue?: Vec2; target?: Vec2 }` | manual-fallback taps (image px) |
| `error` | string \| null | the player-facing message |

- `player-result` carries `{ result, targetId, manual }`. `fitCheck(session, targetId)` says whether
  the fit on show is for the current target: `current`, `checking`, `refit` (an automatic fit for
  another target: fit again), `taps` (a two-tap fit for another target: tap again) or `none`. The
  pocket and the stroke never matter.
- `detectionUsable(v)` = the result has a calibration. A table found without balls still opens the
  review ("I found the table but no balls…"). A table cut off by the border that vision cannot
  complete has no calibration.
- Messages (`SNAP_MESSAGES`):
  - no table: "The whole table must be in the photo — step back or turn the phone and retake it. All
    four corners already in view? Tap them.";
  - `bad-quad`, or four implausible taps: "Those four taps aren’t the cloth corners — tap them
    again.";
  - `cloth-unknown`: "Couldn’t tell the cloth from its surroundings — tap the four cloth corners
    again, or retake the photo.";
  - `moved` on a still (a loose quad) opens the review with "Your four corners don’t quite match the
    cloth — check the layout, or tap the corners again.";
  - a failed vision worker: the detection-failure texts of the spec's Snap edge cases
    (`visionFailedEvent`).

Invariants:
- Photo pixels live only in the Snap controller and the worker, never in this state. Returning to
  `intro` (Start over, leaving Snap) drops every photo, and a photo that finishes decoding after that
  is dropped too (FR-122).
- The pure transition function `snapReducer(session, event) → session` is unit-tested
  (`tests/unit/app/snap-session.test.ts`).

## Worker protocol v2 (summary)

See [contracts/worker-protocol-v2.md](./contracts/worker-protocol-v2.md). New: `still` →
`still` (VisionResult) and `player-view` → `player-view` (PlayerViewResult) on the vision worker, and
the optional `plan` → `plan` (the full ShotPlan with a frozen cue ball's power advice) and `perEvalMs`
on the planner worker. Every v1 message keeps its shape with `v: 2`.

## Design tokens ("Midnight Felt", `:root` in `src/app/styles.css`)

| Token | Value | Use |
|---|---|---|
| `--bg` | `#070B14` | page background |
| `--bg-2` | `#0C1322` | stage background, gradients |
| `--surface` | `rgba(17,24,39,0.72)` + `backdrop-filter: blur(18px) saturate(140%)` | glass panels |
| `--surface-solid` | `#121A2B` | fallback without backdrop-filter |
| `--border` / `--border-strong` | `rgba(255,255,255,0.08)` / `0.16` | hairlines / focus and hover |
| `--text` / `--text-2` / `--text-3` | `#F4F6FB` / `#A9B3C7` / `#6B768C` | primary / secondary / large or decorative only (4.3:1) |
| `--accent` / `--accent-2` | `#56B4E9` / `#0072B2` | primary actions (dark text) / white-text actions |
| `--felt` / `--felt-hi` | `#0E6B4F` / `#18A374` | brand felt |
| `--gold` | `#E9C46A` | premium highlights, sparingly |
| `--ok` / `--warn` / `--danger` | `#009E73` / `#E69F00` / `#D55E00` | status, always with an icon and text |
| radii | `22px / 16px / 12px / 999px` | sheet / card / control / pill |
| `--shadow-1` / `--shadow-2` | `0 8px 24px rgba(0,0,0,.35)` / `0 18px 48px rgba(0,0,0,.5)` | floating / sheet |
| type | `-apple-system, "SF Pro Display", "SF Pro Text", system-ui, "Segoe UI", Roboto, sans-serif`; scale 12/14/16/20/28/40; `font-variant-numeric: tabular-nums` for numbers | |
| motion | 180–240 ms, `cubic-bezier(.2,.8,.2,1)`; 0 ms under reduced motion | |

The plan and overlay colours stay `PALETTE` in `src/app/render/palette.ts` (unchanged).

## UI components (binding signatures, package `ui`)

```ts
// src/app/ui/icons.ts
export type IconName = 'play' | 'pause' | 'camera' | 'image' | 'target' | 'crosshair' | 'cube' | 'layers'
  | 'sparkles' | 'settings' | 'info' | 'close' | 'check' | 'chevron-up' | 'chevron-down' | 'refresh'
  | 'snowflake' | 'hand' | 'ruler' | 'cue' | 'ball' | 'eye' | 'rotate-3d' | 'upload' /* | more */;
export function icon(name: IconName, size?: number): SVGSVGElement;
// src/app/ui/sheet.ts
export function createSheet(el: HTMLElement, opts?: { peek?: number }): { expand(): void; collapse(): void; isExpanded(): boolean };
// src/app/ui/power-meter.ts
export function renderPowerMeter(power: number, minPower: number | null, opts?: MeterOptions): HTMLElement;
// MeterOptions (frozen, no working power, …) and the minimum come from meterOptions(plan) and
// meterMinPower(plan): the one reader of a plan's power figures for the card and the Snap HUD.
// src/app/ui/spin-ball.ts
export function renderSpinBall(side: number, vert: number, size?: number): HTMLElement;
// src/app/ui/fraction-glyph.ts
export function renderFractionGlyph(fraction: number, cutSide: 'left' | 'right' | 'straight'): SVGSVGElement;
// src/app/ui/shot-card.ts: renderShotCard(el, plan, ctx) unchanged
```

Kept from 001 (regression contract):
- test ids `shot-card`, `cut`, `power`, `difficulty`, `tip`;
- texts: cut like `30.0°`, power containing `/10`, difficulty containing `±`;
- `.warnings`, `.suggest li button`;
- buttons "Stun", "Follow", "Use recommended", "Suggest the best shots", "Freeze the detected
  layout", "Use practice table";
- select `aria-label="Practice layout"`, `#status`, `#camera-msg` and `body[data-mode]`.

## Icon set

| File | Size | Alpha | Notes |
|---|---|---|---|
| `public/icon.svg` | vector | — | full-bleed master |
| `public/icons/favicon-32.png` | 32 × 32 | yes | may use the small-size variant |
| `public/icons/icon-180.png` | 180 × 180 | **no** | `apple-touch-icon` |
| `public/icons/icon-192.png` | 192 × 192 | yes | manifest `any` |
| `public/icons/icon-512.png` | 512 × 512 | yes | manifest `any` |
| `public/icons/icon-maskable-512.png` | 512 × 512 | no | manifest `maskable`; artwork inside the central 80 % |
| `ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png` | 1024 × 1024 | **no** (PNG colour type 2) | referenced by `Contents.json` (single-size universal icon) |

## iOS app configuration

| Item | Value |
|---|---|
| `capacitor.config.ts` | `appId` (default `com.cuesight.app`; `CUESIGHT_APP_ID` overrides it at `cap sync`, and CI overrides `PRODUCT_BUNDLE_IDENTIFIER` with `vars.IOS_BUNDLE_ID`), `appName: "CueSight"`, `webDir: "dist"`, `backgroundColor: "#070B14"`, `ios.contentInset: "never"`, no `server.url`, no plugins |
| Deployment target | iOS 16.0 (`IPHONEOS_DEPLOYMENT_TARGET`; the UI's CSS container queries need WKWebView 16) |
| `CFBundleDisplayName` | `CueSight` |
| `NSCameraUsageDescription` | "CueSight uses the camera to see the table and guide your shot. Frames never leave your phone." |
| `NSPhotoLibraryUsageDescription` | "CueSight opens the table photos you choose to plan a shot. Photos never leave your phone." |
| `ITSAppUsesNonExemptEncryption` | `false` |
| Orientations | portrait, landscape left/right (iPhone); all (iPad) |
| Launch screen | `#070B14` background with the centred logo |
| Build numbers | `MARKETING_VERSION` = `package.json` version; build number = `<run number>.<run attempt>` (`scripts/ios-testflight.sh`; `BUILD_NUMBER` overrides it) |

### CI secrets and variables (names of record)

| Name | Kind | Content |
|---|---|---|
| `APP_STORE_CONNECT_KEY_ID` | secret | API key ID (10 characters) |
| `APP_STORE_CONNECT_ISSUER_ID` | secret | issuer UUID |
| `APP_STORE_CONNECT_KEY_P8` | secret | `AuthKey_<KEYID>.p8`: the PEM text as is, or its base64 |
| `APPLE_TEAM_ID` | secret (or repository variable) | 10-character team ID |
| `IOS_BUNDLE_ID` | repository variable, optional | bundle ID registered in App Store Connect (default `com.cuesight.app`) |
| `XCODE_VERSION` | repository variable, optional | pins Xcode (default: the newest installed) |
