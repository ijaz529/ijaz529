# Phase 1 Data Model: 3D Table, Two-Photo Snap Guide, Polished UI and iOS App

All 001 entities ([001 data-model](../001-realtime-shot-guide/data-model.md)) are unchanged. Units
are SI internally.

## Coordinate frames

| Frame | Definition |
|---|---|
| **Table** | As in 001. Origin at the playing-surface centre, `+x` along the long rail, `+y` toward the top long rail, `+z` up from the bed. A ball centre is at `z = R` |
| **Camera** (player photo) | OpenCV convention, matching `vision/synth/render.ts` `CameraModel.R` rows: `x` right, `y` down, `z` forward. `X_c = R·X_w + t`. The camera centre is `C = −Rᵀt` |
| **Image** | Pixels of the processed frame (after orientation and downscale). Origin top-left. `u = f·X_c/Z_c + cx`, `v = f·Y_c/Z_c + cy` |
| **Client** | CSS pixels in page coordinates, as returned by `getBoundingClientRect` plus the scroll offset. This is what `Table3D.toScreen` returns |
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
| `clothRgb` | `[r,g,b]`? | 0..255. Defaults to the brand felt `#0E6B4F` |

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
| `player` | eye ≈ cue − 0.55·aimDir + 0.30·ẑ, fov 50° (landscape) or 58° (portrait). The look point lies on z = R along the aim line, keeping the ghost ball in view and the cue ball low in the frame. Without a plan, aimDir = cue → table centre |
| `broadcast` | elevated 3/4 view, fov 38°. Landscape: yaw ≈ −112°, pitch ≈ 34°. Portrait: yaw ≈ 196°, pitch ≈ 40°. Distance fitted |

Flights interpolate (target, yaw, pitch, log distance, fovY) over 240–600 ms with
`cubic-bezier(.2,.8,.2,1)`, or instantly with reduced motion.

## Pick3D

`{ kind: 'ball', id } | { kind: 'pocket', id } | { kind: 'cloth', pos } | null`. The priority is
exact sphere hit → screen tolerance (22 CSS px) → pocket capture disc (radius mouth/2 + R) → bed
→ `null` (R-19).

## Gesture state machine (3D canvas)

```text
idle ──pointerdown──▶ pending(start, t0, hitBall?)
pending ──moved ≥ 8 px & hitBall──▶ ball-drag   (onBallDrag 'start' … 'move' … 'end')
pending ──moved ≥ 8 px & !hitBall──▶ orbit     (camera → 'custom', onCameraChange)
pending ──2nd pointer──▶ pinch-pan             (zoom by distance ratio, pan by midpoint)
pending ──up < 8 px & < 350 ms──▶ tap           (onTap(pick)); 2 taps on empty ≤ 300 ms, ≤ 24 px → lastPreset
any ──pointercancel / lost capture──▶ idle      (ball-drag emits 'end' at the last position)
```

## Playback (R-17)

### Playback track (pure, per moving ball)

| Field | Type | Notes |
|---|---|---|
| `ballId` | string | |
| `t[]`, `x[]`, `y[]` | Float64Array | one entry per recorded point. Points at events get the event's exact time; others are spread by arc length with a constant display deceleration (R-17) |
| `q[]` | Float64Array (4 per point) | cumulative rolling rotation: displacement `d` → `|d|/R` about `ẑ × d̂` |
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
idle ──playShot(plan)──▶ playing(rate = max(1, T/4))
playing ──t ≥ T──▶ holding(600 ms) ──▶ idle (restore Scene3DData layout; promise resolves)
playing|holding ──stopPlayback() / tap / Escape / setData with a new plan──▶ idle (restore; promise resolves)
```

## Cue stick pose

| Quantity | Value |
|---|---|
| Axis | along `aimDir`, through the strike point (`strikePoint3` in `scene-data.ts`, the same convention as `vision/player-view.strikePoint`) |
| Tip gap behind the strike point | `cueGap(power) = 0.05 + 0.03·power` m (display mapping, not physics) |
| Elevation | small minimum (`MIN_CUE_ELEVATION`), raised only to clear the rail behind the cue ball (max 60°) |
| Visibility | when a plan exists and no playback is running |

## Player view (vision)

### KnownBall

`{ id, pos: Vec2 (table m), isCue, rgb?: [r,g,b] }`, from the confirmed Snap layout (`rgb` from the
table photo's tracked balls).

### PlayerViewInput

| Field | Type | Rule |
|---|---|---|
| `frame` | Frame | RGBA, long side ≤ 1600 px (the app sends 1280) |
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
| Confidence | `PlayerViewResult.confidence` | chip: "Fit: good / fair / low" + percentage |
| Hidden or off-frame parts | visibility tests | dashed and labelled "hidden", or an edge arrow plus a message |

## SnapSession (state machine)

```text
idle
 ──table photo chosen──▶ overview-captured        (frame decoded; 'still' sent)
overview-captured                                  (sub-status: processing → review | error)
 ──still result received──▶ overview-captured(review)   (outline + balls on the photo; player may edit)
 ──detection failed──▶ overview-captured(error)          (offers Tap corners / Retake)
 ──corners tapped──▶ overview-captured(processing)      (still re-run with manual corners)
 ──Confirm (after optional edits)──▶ layout-confirmed
layout-confirmed
 ──tap target (+pocket)──▶ target-chosen           (plan computed; prompt for player photo)
target-chosen
 ──player photo chosen──▶ player-captured          ('player-view' sent)
player-captured
 ──result ok──▶ guided
 ──result !ok──▶ manual-taps                       (reason shown)
manual-taps
 ──tap cue, tap target──▶ player-captured          ('player-view' with manualTaps) ──▶ guided
guided
 ──change target/pocket/stroke──▶ guided           (re-plan, redraw on the same photo)
 ──new player photo──▶ player-captured
 ──Edit layout──▶ layout-confirmed                 (player photo kept; refit on return)
any ──Start over / leave Snap──▶ idle              (photos released)
any ──Retake table photo──▶ idle → overview-captured
```

| Field | Type | Present from |
|---|---|---|
| `state` | the states above | always |
| `overview` | `{ frame: Frame; bitmapUrl?: string; vision: VisionResult }` | overview-captured |
| `layout` | Ball[] (edited) | layout-confirmed |
| `manualCorners` | Vec2[4] \| null | overview-captured (error) |
| `targetId`, `pocketId` | string, PocketId? | target-chosen |
| `plan` | ShotPlan | target-chosen |
| `player` | `{ frame: Frame; result: PlayerViewResult \| null }` | player-captured |
| `taps` | `{ cue?: Vec2; target?: Vec2 }` | manual-taps |
| `error` | string \| null | any |

Invariants:
- Photos live only in this object and the worker. Leaving `snap` mode sets `state = idle` and drops
  every frame (FR-122).
- The pure transition function `snapReducer(session, event) → session` is unit-tested.

## Worker protocol v2 (summary)

See [contracts/worker-protocol-v2.md](./contracts/worker-protocol-v2.md). New: `still` →
`still` (VisionResult) and `player-view` → `player-view` (PlayerViewResult). Every v1 message keeps
its shape with `v: 2`.

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
export function renderPowerMeter(power: number, minPower: number | null): HTMLElement;
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
| `capacitor.config.json` | `appId` (default `app.cuesight.ios`; CI overrides `PRODUCT_BUNDLE_IDENTIFIER` with `vars.IOS_BUNDLE_ID`), `appName: "CueSight"`, `webDir: "dist"`, `backgroundColor: "#070B14"`, `ios.contentInset: "never"`, no `server.url` |
| Deployment target | iOS 15.0 (Capacitor 8 template) |
| `CFBundleDisplayName` | `CueSight` |
| `NSCameraUsageDescription` | "CueSight uses the camera to see the table and the balls so it can show you the shot. Photos and video stay on your phone." |
| `NSPhotoLibraryUsageDescription` | "Choose a photo of your table to plan a shot. Photos stay on your phone." |
| `ITSAppUsesNonExemptEncryption` | `false` |
| Orientations | portrait, landscape left/right (iPhone); all (iPad) |
| Launch screen | `#070B14` background with the centred logo |
| Build numbers | `MARKETING_VERSION` = `package.json` version; `CURRENT_PROJECT_VERSION` = `${run_number}${run_attempt}` |

### CI secrets and variables (names of record)

| Name | Kind | Content |
|---|---|---|
| `APP_STORE_CONNECT_KEY_ID` | secret | API key ID (10 characters) |
| `APP_STORE_CONNECT_ISSUER_ID` | secret | issuer UUID |
| `APP_STORE_CONNECT_KEY_P8` | secret | base64 of `AuthKey_<KEYID>.p8` |
| `APPLE_TEAM_ID` | secret | 10-character team ID |
| `IOS_BUNDLE_ID` | repository variable | bundle ID registered in App Store Connect |
