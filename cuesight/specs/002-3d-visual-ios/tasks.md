---
description: "Task list for the 3D Table, Two-Photo Snap Guide, Polished UI and iOS App feature"
---

# Tasks: 3D Table, Two-Photo Snap Guide, Polished UI and iOS App

**Input**: Design documents from `/specs/002-3d-visual-ios/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/ (render3d-api,
player-view-api, worker-protocol-v2), quickstart.md

**Tests**: REQUIRED (Constitution Principle III). Test tasks come first in each phase and must fail
before their implementation task. GPU code is tested through its pure modules (camera, pick,
playback, scene-data, gestures) and through Playwright with SwiftShader.

**Organization**: tasks are grouped by user story, so each story can be built and demoed on its own.

## Format: `[ID] [P?] [Story] Description (pkg: owner)`

- **[P]**: can run in parallel (different files, no dependencies)
- **[Story]**: US1…US4 from spec.md
- **pkg**: the package that owns the files. Packages are `spec002`, `render3d`, `playerview`, `ui`,
  `ios` and `integrate`; the `coordinator` merges and validates.
- All paths are relative to `cuesight/`. `.github/` lives at the git root (`../.github/`).

---

## Phase 1: Setup (Shared Infrastructure)

- [X] T101 [P] Write the Spec Kit artifacts for 002 in `specs/002-3d-visual-ios/` (spec, checklist, research, plan, data-model, contracts, quickstart, tasks) and point `.specify/feature.json` at them (pkg: spec002)
- [ ] T102 Add the devDependencies `@capacitor/cli`, `@capacitor/core` and `@capacitor/ios`, pinned **exactly** to `8.6.0`, plus npm-script aliases (`icons`, Snap fixtures inside `fixtures`, `ios:sync` = `vite build && cap sync ios`), in `package.json` and `package-lock.json`. No runtime dependencies (pkg: ios)
- [ ] T103 [P] Create `capacitor.config.json`: `appId`, `appName: "CueSight"`, `webDir: "dist"`, `backgroundColor: "#070B14"`, `ios.contentInset: "never"`, no `server.url` (pkg: ios)
- [ ] T104 [P] Extend `playwright.config.ts`:
  - SwiftShader WebGL args on the Chromium project (`--use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist`);
  - a `webkit-iphone` project (iPhone device profile, `testIgnore: camera.spec.ts`)

  (pkg: integrate)

---

## Phase 2: Foundational (Blocking Prerequisites)

**⚠️ No user-story work can begin until this phase is complete.**

- [ ] T105 [P] Unit tests for worker protocol v2 in `tests/unit/workers/protocol.test.ts`:
  - `PROTOCOL_VERSION === 2` and `isSupported` rejects v1;
  - the `still` and `player-view` message shapes type-check and survive `structuredClone`

  (pkg: playerview)
- [ ] T106 Bump `PROTOCOL_VERSION` to 2 and add the `still` and `player-view` request/response types per contracts/worker-protocol-v2.md in `src/workers/protocol.ts`, keeping every v1 message (pkg: playerview)
- [ ] T107 [P] Unit tests for the projection helpers in `tests/unit/vision/player-view.test.ts`:
  - `projectPoint`: optical axis → (cx, cy), and `null` behind the camera;
  - on-axis `projectBallOutline` radius = f·R/√(d² − R²) ± 0.1 px;
  - `strikePoint`: the back pole at (0, 0), `|P − c| = R`, and `side > 0` toward the shooter's right

  (pkg: playerview)
- [ ] T108 Implement `projectPoint`, `projectBallOutline` and `strikePoint`, plus the exported types and an `estimatePlayerView` that returns `ok: false` until T141, in `src/vision/player-view.ts` (pkg: playerview)
- [ ] T109 [P] Create `src/app/render3d/index.ts` with the contract types and a `createTable3D` that returns `null`, so `integrate` compiles against the API before T130 lands (pkg: render3d)
- [ ] T110 [P] Add the Midnight Felt tokens (data-model.md § Design tokens), the system font stack, `color-scheme: dark`, focus rings, safe-area variables and reduced-motion overrides in `src/app/styles.css` (pkg: ui)
- [ ] T111 [P] Implement `icon(name, size)` with hand-written inline SVGs (24 px grid, 1.75 px round strokes, `currentColor`) for every `IconName` in data-model.md, in `src/app/ui/icons.ts` (pkg: ui)
- [ ] T112 [P] Add synthetic table-level scene helpers in `tests/helpers/player-scenes.ts`:
  - the deterministic scene grid (height 8–40 cm, distance 0.3–1.2 m, yaw ±15°, HFOV 40–100°, 3 cloths);
  - the ground-truth `CameraPose` from `cameraModel`;
  - a low-light post-process (gain × 0.15 + deterministic noise);
  - "balls moved" perturbations

  (pkg: playerview)
- [ ] T113 Write `scripts/make-snap-fixtures.ts`. It renders `tests/fixtures/snap-table.png`, `snap-player.png`, `snap-player-hard.png` (one ball visible) and `snap-player-cut.png` (cue ball cut by the frame edge), each with a `.json` ground truth (pkg: playerview)

**Checkpoint**: the protocol, the projection maths, the contract stubs, the tokens and the icons are
in place. The user stories can start in parallel.

---

## Phase 3: User Story 1 - Study the shot on a 3D table (Priority: P1) 🎯 MVP

**Goal**: a lamp-lit WebGL2 table with orbit, presets, picking, drag, the plan in 3D, the cue stick
and a physically consistent replay, with a 2D fallback.

**Independent Test**: quickstart Q101–Q108. `tests/unit/render3d/*` and `tests/e2e/practice3d.spec.ts`
pass.

### Tests for User Story 1 ⚠️ (write first, must fail)

- [ ] T114 [P] [US1] Unit tests for the vec3/quat/mat4 and ray helpers in `tests/unit/render3d/math3d.test.ts`: inverse, lookAt, perspective, quaternion integration with no drift over 1e4 steps (pkg: render3d)
- [ ] T115 [P] [US1] Unit tests for the camera in `tests/unit/render3d/camera.test.ts`:
  - Overview fits the table in portrait and landscape;
  - Player view eye at cue − 0.5·aimDir + 0.17 ẑ with pitch ≈ 12°, raised when outside the rail;
  - Broadcast angles;
  - pitch clamped to 8°…89°, pan target clamped to the bed;
  - a flight interpolates; reduced motion jumps

  (pkg: render3d)
- [ ] T116 [P] [US1] Unit tests for picking in `tests/unit/render3d/picking.test.ts`:
  - `toScreen` ↔ `pick` agree for every ball in all three presets;
  - the 22 px tolerance; pocket capture discs; cloth hits;
  - `null` off-table; `null` from `toScreen` behind the camera

  (pkg: render3d)
- [ ] T117 [P] [US1] Unit tests for the replay in `tests/unit/render3d/playback.test.ts`, using real `planShot` outputs (straight stop, 30° stun, draw, follow, cushion bank, pocketed object ball):
  - positions at every `SimEvent` time within 1 mm;
  - rolling slip < 1 % of the speed (rotation `|d|/R` about `ẑ × d̂`), independent of the frame rate;
  - duration ≤ 4 s after compression; pocket drop;
  - stop restores the layout;
  - if the R-17 level-2 slip integrator is built: stun cue ball ω ≈ 0 at the strike and draw ω
    reversed

  (pkg: render3d)
- [ ] T118 [P] [US1] Unit tests for the scene data in `tests/unit/render3d/scene-data.test.ts`:
  - ribbons: vertex count, monotonic arc length, dash attribute in metres;
  - the cue-stick axis through the strike point (`strikePoint3` equals `vision/player-view.strikePoint`), with the gap strictly increasing in power and the elevation clearing the rail;
  - the cue hidden while playing

  (pkg: render3d)
- [ ] T119 [P] [US1] Unit tests for the gesture machine in `tests/unit/render3d/gestures.test.ts`: tap < 8 px and < 350 ms, a drag on a ball vs an orbit on cloth, double-tap → last preset, pinch zoom and two-finger pan, a cancel ends the drag with `'end'` (pkg: render3d)
- [ ] T120 [US1] E2E test of the 3D practice table in `tests/e2e/practice3d.spec.ts`:
  - the WebGL2 renderer is active;
  - tap the ball and pocket via `__cuesight.practiceToScreen` → `30.0°`;
  - the preset buttons work; *Play shot* finishes within 5 s and the layout is restored;
  - dragging a ball works;
  - a pixel probe at `toScreen(ball)` shows the ball colour;
  - no `requestAnimationFrame` callbacks while idle (counted by an init script);
  - `?renderer=2d` shows the 2D table with the same card

  (pkg: integrate)

### Implementation for User Story 1

- [ ] T121 [P] [US1] Implement vec3/quat/mat4 and ray helpers (no per-frame allocation in the render loop) in `src/app/render3d/math3d.ts`, and the derived table geometry in `src/app/render3d/geom.ts` (pkg: render3d)
- [ ] T122 [P] [US1] Implement the orbit camera, presets, clamps and eased flights (research R-18) in `src/app/render3d/camera.ts` (pkg: render3d)
- [ ] T123 [P] [US1] Implement the ray casts, the screen tolerance and the `toScreen` projection (R-19) in `src/app/render3d/picking.ts` (pkg: render3d)
- [ ] T124 [P] [US1] Implement the timed tracks and the rolling rotation (R-17 level 1; level 2 optional, using `strikeBall` and the active `PhysicsParams`) in `src/app/render3d/playback.ts` (pkg: render3d)
- [ ] T125 [P] [US1] Implement the plan → ribbons, markers, ghost ball, pocket highlight, landing, heatmap decal and cue-stick pose (R-20; `strikePoint3`, tested to agree with T108's `strikePoint`) in `src/app/render3d/scene-data.ts` (pkg: render3d)
- [ ] T126 [P] [US1] Implement the procedural meshes in `src/app/render3d/meshes.ts`: bed with pocket cut-outs, cushions from `TableSpec.cushions`, wood rails, pocket cups, diamonds, the snooker baulk line, D and spots, an instanced sphere and the cue (pkg: render3d)
- [ ] T127 [P] [US1] Implement the textures in `src/app/render3d/textures.ts`: the cloth weave tile with mipmaps (anisotropy where available), wood grain, the ball number atlas (system font; it falls back to no numbers without a 2D canvas) (pkg: render3d)
- [ ] T128 [US1] Implement the GLSL ES 3.00 shaders (lit materials with Schlick clear coat, the analytic lamp environment, cloth sheen, ACES tone map plus vignette, ribbons with dashes, contact-shadow and glow decals) in `src/app/render3d/shaders.ts`; the program, mesh and texture helpers in `src/app/render3d/gl.ts`; and the frame renderer (draw order per R-16/R-20) in `src/app/render3d/scene.ts` (pkg: render3d)
- [ ] T129 [US1] Implement the pointer-gesture machine plus its DOM adapter (`setPointerCapture`, wheel, `touch-action: none`) in `src/app/render3d/gestures.ts` (pkg: render3d)
- [ ] T130 [US1] Implement `createTable3D` per contracts/render3d-api.md in `src/app/render3d/index.ts`:
  - render on demand, DPR cap;
  - the playback loop with skip/Escape;
  - context loss and restore; `destroy`

  (pkg: render3d)
- [ ] T131 [US1] Wire the 3D table into Practice in `src/app/main.ts`:
  - lazy `import()` plus idle prefetch; fall back to `TableView` on `null`, on `?renderer=2d` or on the setting, with the one-line note;
  - the preset control (Overview / Player view / Broadcast), *Play shot* and *Skip*;
  - `__cuesight.practiceToScreen` → `table3d.toScreen`;
  - `onBallDrag('end')` → the 001 overlap push-apart

  (pkg: integrate)
- [ ] T132 [US1] Add 3D screenshots (three presets, plus a replay frame) to `scripts/screenshots.cjs`, saved to `docs/screenshots/` (pkg: integrate)

**Checkpoint**: Practice is 3D, with every 001 feature. The 001 e2e suite passes unchanged.

---

## Phase 4: User Story 2 - Snap: two photos, then "hit it here, this hard" (Priority: P1)

**Goal**: the table photo → confirmed layout → plan → the player photo → pose → the guide drawn on the
photo (aim, ghost, strike dot, power), with the two-tap fallback.

**Independent Test**: quickstart Q109–Q116. `tests/integration/player-view.test.ts`,
`tests/integration/still.test.ts` and `tests/e2e/snap.spec.ts` pass.

### Tests for User Story 2 ⚠️ (write first, must fail)

- [ ] T133 [P] [US2] Unit tests for player-photo detection in `tests/unit/vision/player-detect.test.ts`, on table-level renders:
  - circle centre ≤ 1 px and radius ≤ 3 %;
  - a partial arc at the frame edge; balls overlapping in depth;
  - cushion-edge points within 2 px of the projected nose line;
  - scratch buffers reused (no allocation in pixel loops)

  (pkg: playerview)
- [ ] T134 [P] [US2] Unit tests for the Levenberg–Marquardt solver in `tests/unit/vision/lm.test.ts`: it converges on Rosenbrock and a known curve fit, damping adapts, and it honours the iteration and tolerance stops (pkg: playerview)
- [ ] T135 [P] [US2] Integration tests for `estimatePlayerView` against the accuracy contract in contracts/player-view-api.md, in `tests/integration/player-view.test.ts`:
  - ≥ 90 % success; ghost ≤ 1.5 % of the diagonal; strike ≤ 0.1 R;
  - no false confidence > 3 %; the failure scenes give reasons;
  - manual taps ≤ 2.5 %; focal ×0.5 and ×2;
  - deterministic; ≤ 500 ms per scene;
  - prints per-scene errors

  (pkg: playerview)
- [ ] T136 [P] [US2] Integration tests for still processing in `tests/integration/still.test.ts`: `locked` on synthetic 1280 px stills, 001 SC-003 accuracy, the manual-corners path through `config`, and the live pipeline state left unchanged (pkg: playerview)
- [ ] T137 [P] [US2] Unit tests for the Snap reducer in `tests/unit/app/snap-session.test.ts`: every transition in data-model.md § SnapSession, error paths, and frames released on *Start over* or on leaving Snap (pkg: integrate)
- [ ] T138 [US2] E2E test of the Snap flow in `tests/e2e/snap.spec.ts`:
  - `setInputFiles(snap-table.png)` → outline and balls → Confirm → tap the target;
  - `setInputFiles(snap-player.png)` → the guide is visible with "tip" words, `/10` power and confidence;
  - change the pocket → the guide redraws without a new photo;
  - `snap-player-hard.png` → the reason plus two taps → the guide;
  - `snap-player-cut.png` → the strike-point-off-photo message;
  - zero network requests (`page.on('request')`)

  (pkg: integrate)

### Implementation for User Story 2

- [ ] T139 [P] [US2] Implement the small dense Levenberg–Marquardt solver (Nielsen damping, forward-difference Jacobian, robust Cauchy weights) in `src/vision/lm.ts` (pkg: playerview)
- [ ] T140 [P] [US2] Implement the player-photo cloth mask, ball circle fits on cloth-adjacent arcs (Kåsa + geometric refinement) and cushion-edge points, with pre-allocated scratch, in `src/vision/player-detect.ts` (pkg: playerview)
- [ ] T141 [US2] Implement `estimatePlayerView` (R-24, R-25) in `src/vision/player-view.ts`:
  - the hypothesis grid; association by distance, radius and colour;
  - the residuals (silhouette centre, radius, cushion edges, priors); LM refinement and re-association;
  - confidence from the covariance; the canonical reasons; manual taps

  (pkg: playerview)
- [ ] T142 [US2] Implement `processStill` (N passes on one frame through a separate pipeline) in `src/vision/still.ts`, plus the `still` and `player-view` handlers (transfer buffers, stale ids, error replies) in `src/workers/vision.worker.ts` (pkg: playerview)
- [ ] T143 [P] [US2] Implement photo capture and decode in `src/app/snap/photo.ts`:
  - camera and library inputs;
  - `HTMLImageElement.decode()` → canvas at long side 1280 with EXIF orientation, with a `createImageBitmap` fast path;
  - `Frame` out; source released

  (pkg: integrate)
- [ ] T144 [P] [US2] Implement the pure `snapReducer` per data-model.md § SnapSession in `src/app/snap/session.ts` (pkg: integrate)
- [ ] T145 [US2] Implement the guide renderer in `src/app/render/player-guide.ts`:
  - aim line, ghost outline, contact point, object path and pocket, the optional cue path;
  - the strike dot with miscue ring, cross and tick marks; the 2.5× cue-ball inset;
  - hidden and off-frame indicators; the confidence chip; PALETTE colours and dashes

  (pkg: integrate)
- [ ] T146 [US2] Implement the Snap stage in `src/app/snap/snap-view.ts`:
  - photo display with the outline and balls; edit layout (drag, add, remove, mark cue);
  - *Tap corners*, *Retake*, the player-photo prompt, the manual two-tap mode;
  - reasons and warnings in player language

  (pkg: integrate)
- [ ] T147 [P] [US2] Add the bundled sample photos (`public/samples/snap-table.png` and `snap-player.png`, copied from T113's output) and the *Try sample photos* action in `src/app/snap/samples.ts` (FR-123) (pkg: integrate)
- [ ] T148 [US2] Wire Snap into `src/app/main.ts`:
  - the `snap` mode; v2 `still` / `player-view` requests with the stale-id rule;
  - `KnownBall.rgb` from the table photo; `focalPx` scaling;
  - re-plan → redraw; privacy clean-up on leaving the mode

  (pkg: integrate)

**Checkpoint**: Snap works end to end on fixtures and on a phone. A low-confidence fit never draws an
untrusted guide.

---

## Phase 5: User Story 3 - A polished, consistent look (Priority: P2)

**Goal**: the Midnight Felt UI everywhere, the redesigned shot card, the sheet or panel, onboarding,
the icon and the splash.

**Independent Test**: quickstart Q117–Q123. `tests/e2e/ui.spec.ts` and `tests/unit/icons.test.ts`
pass. The 001 e2e passes unchanged.

### Tests for User Story 3 ⚠️ (write first, must fail)

- [ ] T149 [P] [US3] E2E UI test in `tests/e2e/ui.spec.ts`:
  - the tokens are applied; the segmented "Live · Snap · Practice" control with `body[data-mode]`;
  - portrait sheet peek and expand; landscape and ≥ 900 px side panel;
  - every button ≥ 44 × 44; a focus ring is visible on Tab; body-text contrast ≥ 4.5:1;
  - reduced motion makes the transitions instant; onboarding shows once;
  - all 001 test ids and accessible names are present

  (pkg: ui)
- [ ] T150 [P] [US3] Unit test for the icon files in `tests/unit/icons.test.ts`. It parses the PNG IHDR: exact sizes, colour type 2 (no alpha) for `icon-180.png`, `icon-maskable-512.png` and `AppIcon-1024.png`, and `public/icon.svg` exists (pkg: ios)

### Implementation for User Story 3

- [ ] T151 [P] [US3] Implement `createSheet(el, { peek })` in `src/app/ui/sheet.ts`: drag with peek and expanded snap points, a handle button with `aria-expanded`, a static panel under `(orientation: landscape)` or `min-width: 900px` (pkg: ui)
- [ ] T152 [P] [US3] Implement `renderPowerMeter(power, minPower)` in `src/app/ui/power-meter.ts`: a 10-segment arc gauge, the min-power tick, accessible text "Power 6 of 10, medium-firm" (pkg: ui)
- [ ] T153 [P] [US3] Implement `renderSpinBall(side, vert, size)` in `src/app/ui/spin-ball.ts`: a shaded cue-ball SVG with the tip dot, the miscue ring and the spin text equivalent (pkg: ui)
- [ ] T154 [P] [US3] Implement `renderFractionGlyph(fraction, cutSide)` in `src/app/ui/fraction-glyph.ts`: two overlapping balls showing the overlap, with a title text (pkg: ui)
- [ ] T155 [US3] Redesign `renderShotCard` in `src/app/ui/shot-card.ts`: big numerals, the glyph, the gauge and the spin ball, the headline row used by the sheet's peek, and every 001 test id, text and class kept (pkg: ui)
- [ ] T156 [US3] Style the components in `src/app/styles.css`:
  - glass panels with the `@supports` fallback, the segmented control, sheet and panel;
  - buttons (dark text on `--accent`), chips, the toast, the settings dialog;
  - motion tokens, safe areas

  (pkg: ui)
- [ ] T157 [US3] Update `index.html`:
  - the segmented control (Live = `camera`, Snap = `snap`, Practice = `practice`) with icons;
  - icon links (`favicon-32`, `apple-touch-icon` = `icon-180`); `theme-color #070B14`;
  - an inline branded splash removed on first render

  (pkg: ui)
- [ ] T158 [P] [US3] Implement the first-run hint explaining the three modes, dismissal stored in guarded `localStorage`, in `src/app/ui/onboarding.ts` (pkg: ui)
- [ ] T159 [P] [US3] Make the icons:
  - design the full-bleed vector master `public/icon.svg`;
  - write `scripts/make-icons.cjs` (Chromium canvas rasterisation → in-house PNG encoder, RGB for opaque outputs);
  - generate `public/icons/{favicon-32,icon-180,icon-192,icon-512,icon-maskable-512}.png` and `ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png`

  (pkg: ios)
- [ ] T160 [US3] Update `public/manifest.webmanifest`: PNG icons with their `purpose` (`any` / `maskable`), `background_color` and `theme_color` `#070B14`, `start_url` (pkg: ios)
- [ ] T161 [US3] Bump the cache name in `public/sw.js` and precache the icons and the samples, so the lazily loaded 3D chunk is cached after its idle prefetch (pkg: integrate)
- [ ] T162 [US3] Restyle the Live overlay chrome (status pill, mini-map frame, camera message) and the 2D table frame to the tokens, keeping the overlay `PALETTE` unchanged, in `src/app/render/overlay.ts`, `src/app/render/table-view.ts` and `src/app/ui/controls.ts` (pkg: integrate)

**Checkpoint**: one coherent product look. Icons and splash everywhere. Accessibility checks pass.

---

## Phase 6: User Story 4 - A real iOS app, tested in the Simulator and on TestFlight (Priority: P2)

**Goal**: the Capacitor 8 wrapper, the Simulator smoke test and screenshots, WebKit e2e and TestFlight
upload in CI.

**Independent Test**: quickstart Q124–Q127. The iOS workflow passes with no secrets. With secrets,
the build reaches TestFlight.

- [ ] T163 [US4] Generate the iOS project with `npx cap add ios` (Capacitor 8 SPM template, iOS 15) and commit `ios/`. Its `.gitignore` must exclude the synced `App/App/public` and `capacitor.config.json` copies and `build/` (pkg: ios)
- [ ] T164 [US4] Configure the iOS project:
  - `ios/App/App/Info.plist`: `CFBundleDisplayName`, `NSCameraUsageDescription`, `NSPhotoLibraryUsageDescription`, `ITSAppUsesNonExemptEncryption = NO`, orientations (data-model.md § iOS app configuration);
  - `LaunchScreen.storyboard`: `#070B14` with the logo;
  - `AppIcon.appiconset/Contents.json` → `AppIcon-1024.png`

  (pkg: ios)
- [ ] T165 [P] [US4] Create `ios/ExportOptions.plist`: `method = app-store-connect`, `destination = upload`, `signingStyle = automatic`, `uploadSymbols = true`. The team ID is injected by CI (pkg: ios)
- [ ] T166 [US4] Make the app CI-friendly in `src/app/main.ts`:
  - log `console.info('[CueSight] ready mode=… renderer=…')` after the first render;
  - add the `VITE_CUESIGHT_TOUR=1` screenshot tour with `[CueSight] tour <step>` markers (Practice overview → player → broadcast → Snap samples → guide);
  - start in Practice when no `videoinput` device exists

  (pkg: integrate)
- [ ] T167 [US4] Create `../.github/workflows/ios.yml` (git root, `defaults.run.working-directory: cuesight`, Node 22, concurrency per ref) with these jobs:
  - `web`: typecheck, test, fixtures, build, Chromium e2e;
  - `ios-simulator`: tour build, `cap sync`, `xcodebuild` for the simulator with `CODE_SIGNING_ALLOWED=NO`, run-time simulator choice, boot, status-bar override, install, `launch --console-pty`, the 60 s `ready` gate, screenshots per tour marker, artifacts;
  - `webkit-e2e`: `playwright install webkit`, `--project=webkit-iphone`;
  - `testflight`: a secrets-presence step → skip with `::notice::`; key from base64 into `$RUNNER_TEMP`; `xcodebuild archive` + `-exportArchive` with API-key auth, `CURRENT_PROJECT_VERSION=${run_number}${run_attempt}`, `PRODUCT_BUNDLE_IDENTIFIER=vars.IOS_BUNDLE_ID`; key removed in an `always()` step

  Secret names follow data-model.md § CI secrets (pkg: ios)
- [ ] T168 [US4] First CI runs:
  1. Push a branch: `web`, `ios-simulator` and `webkit-e2e` are green, and the screenshots are attached.
  2. Configure the secrets per quickstart.md.
  3. Dispatch with `upload = true`: the build appears in TestFlight.
  4. Record the results in `specs/002-3d-visual-ios/analysis.md`.

  (pkg: coordinator)

**Checkpoint**: an iOS build in the Simulator on every push. TestFlight on demand.

---

## Phase 7: Polish & Cross-Cutting Concerns

- [ ] T169 [P] Update `README.md` with the 3D table, the Snap flow (with screenshots), the iOS app and the TestFlight setup summary, and add the limitations: pinhole assumption, table-level envelope, synthetic-only validation of the player-photo fit (pkg: integrate)
- [ ] T170 [P] Add a pointer from `specs/001-realtime-shot-guide/contracts/worker-protocol.md` to contracts/worker-protocol-v2.md (pkg: coordinator)
- [ ] T171 [P] Check the budgets:
  - initial gzip JS < 250 KB and the 3D chunk size recorded;
  - zero runtime dependencies (`npm ls --omit=dev` is empty);
  - device frame rate during orbit and replay recorded

  (pkg: integrate)
- [ ] T172 Run the quickstart validation (Q101–Q127) and `/speckit-analyze` for 002, writing the results to `specs/002-3d-visual-ios/analysis.md`, and fix the inconsistencies (pkg: coordinator)

---

## Dependencies & Execution Order

- **Setup (Phase 1)** → **Foundational (Phase 2)** → user stories.
- **US1 (3D)** needs T109 (stub). T108 is only needed for the `strikePoint3` agreement test in T118. T114–T119 (tests) → T121–T130
  (render3d) → T131 (integrate). T120 runs once T131 is in.
- **US2 (Snap)** needs T106 (protocol v2), T108 (projection) and T112/T113 (scenes and fixtures).
  - Vision chain: T133–T136 (tests) → T139–T142 (playerview).
  - App chain: T137, T143–T147 (in parallel with the vision chain, against the stubs) → T148
    (integrate) → T138 (e2e).
- **US3 (UI)** needs T110/T111. T151–T154 are parallel → T155 → T156/T157. Icons: T159 → T160 and
  T164. US3 can run in parallel with US1 and US2. T155 must keep the 001 test ids (T149 guards it).
- **US4 (iOS)** needs T102/T103 and T159 (icons). T163 → T164/T165 → T167. T166 needs T131 and T148
  for the full tour. T168 needs everything else.
- **Polish** comes last.

```text
Setup → Foundational ─┬─> US1 render3d (T114–T130) ──> T131 ─┐
                      ├─> US2 playerview (T133–T142) ─┐       ├─> T166 → T167 → T168 → Polish
                      │   US2 integrate (T137,T143–T147) ┴─> T148 ┘
                      ├─> US3 ui (T149, T151–T158)  ∥  ios icons (T150, T159–T160)
                      └─> US4 ios (T163–T165)
```

## Parallel Example: Foundational + User Story 1

```bash
# Foundational, in parallel across packages:
Task: "T105 protocol v2 tests"      Task: "T107 projection tests"     Task: "T109 render3d stub"
Task: "T110 tokens"                 Task: "T111 icons.ts"             Task: "T112 player scenes"
# US1 tests, in parallel:
Task: "T114 math3d"  Task: "T115 camera"  Task: "T116 picking"  Task: "T117 playback"  Task: "T118 scene-data"  Task: "T119 gestures"
# US1 implementation, in parallel (different files):
Task: "T121 math3d.ts"  Task: "T122 camera.ts"  Task: "T123 picking.ts"  Task: "T124 playback.ts"  Task: "T126 meshes.ts"  Task: "T127 textures.ts"
```

## Implementation Strategy

1. **MVP**: Setup → Foundational → US1 (3D Practice) and US2 (Snap) in parallel. Both are P1 and
   touch disjoint files. Validate Q101–Q116. **Ship the PWA.**
2. **Increment**: US3 (look and feel, icons) → US4 (iOS wrapper, Simulator CI, TestFlight).
3. Every phase ends at a checkpoint where `npm run typecheck`, `npm test` and the relevant e2e specs
   are green, and the 001 suites are unchanged.

## Requirement → task → verification coverage

| Requirement | Tasks | Verified by |
|---|---|---|
| FR-101 table geometry, FR-102 balls/light/shadows | T126–T128, T130 | `practice3d.spec.ts` (pixel probes), screenshots (T132) |
| FR-103 orbit/zoom/pan, FR-104 presets | T122, T129, T131 | `camera.test.ts`, `gestures.test.ts`, `practice3d.spec.ts` |
| FR-105 tap/drag selection | T123, T129, T131 | `picking.test.ts`, `practice3d.spec.ts` |
| FR-106 plan in 3D, FR-107 cue stick | T125, T130 | `scene-data.test.ts`, screenshots |
| FR-108 replay | T124, T130 | `playback.test.ts`, `practice3d.spec.ts` |
| FR-109 render on demand | T130 | `practice3d.spec.ts` (idle rAF count) |
| FR-110 2D fallback | T131 | `practice3d.spec.ts` (`?renderer=2d`) |
| FR-111 photo input, FR-112 still detection | T142, T143 | `still.test.ts`, `snap.spec.ts` |
| FR-113 edit/corners/retake | T146 | `snap.spec.ts`, quickstart Q110 |
| FR-114 target + plan, FR-115 player-photo prompt | T146, T148 | `snap.spec.ts` |
| FR-116 pose + confidence, FR-121 moved / not behind | T139–T141 | `player-view.test.ts` (integration) |
| FR-117 guide drawing, FR-119 partial visibility | T145, T146 | `snap.spec.ts`, quickstart Q112/Q115 |
| FR-118 manual fallback | T141, T146 | `player-view.test.ts`, `snap.spec.ts` |
| FR-120 re-plan on the same photo | T148 | `snap.spec.ts` |
| FR-122 photo privacy | T144, T148 | `snap-session.test.ts`, `snap.spec.ts` (no requests) |
| FR-123 sample photos | T147 | quickstart Q109, iOS tour (T166) |
| FR-124 tokens, FR-125 mode control | T110, T156, T157 | `ui.spec.ts`, 001 e2e unchanged |
| FR-126 sheet/panel | T151 | `ui.spec.ts` |
| FR-127 shot card | T152–T155 | `ui.spec.ts`, `virtual.spec.ts` unchanged |
| FR-128 onboarding, FR-129 motion | T110, T122, T156, T158 | `ui.spec.ts`, `camera.test.ts` |
| FR-130 accessibility | T110, T123, T156 | `ui.spec.ts`, `picking.test.ts` (22 px tolerance) |
| FR-131 icons + splash | T157, T159, T160, T164 | `icons.test.ts`, quickstart Q122 |
| FR-132 iOS wrapper, FR-133 permissions, FR-137 no encryption/analytics | T163, T164 | iOS smoke (T167), device check Q127 |
| FR-134 Simulator CI, FR-135 WebKit e2e, FR-136 TestFlight | T104, T165–T167 | workflow runs (T168) |

| Success criterion | Verified by |
|---|---|
| SC-101 3D frame budget, idle | device measurement (T171), idle rAF test (T120) |
| SC-102 pick accuracy | `picking.test.ts` |
| SC-103 replay fidelity | `playback.test.ts` |
| SC-104 3D = 2D values | `practice3d.spec.ts` |
| SC-105 still accuracy | `still.test.ts` |
| SC-106, SC-107, SC-108, SC-109 player-photo fit | `player-view.test.ts` (integration) |
| SC-110 first-use Snap < 60 s | usability session (open; it can't be automated) |
| SC-111 001 e2e + accessibility | `ui.spec.ts`, `virtual.spec.ts`, `camera.spec.ts` |
| SC-112 zero runtime deps, bundle | T171 |
| SC-113 CI on a clean runner | T168 |
| SC-114 zero network | `snap.spec.ts`, device check (T168) |
| SC-115 icon files | `icons.test.ts` |

## Notes

- Tasks are ticked `[X]` only when their files exist **and** their tests pass (Gate 3). The
  coordinator ticks the implementation tasks after verifying them.
- Contract files (`contracts/*.md`) are the API of record. A change to a signature needs an update
  there first.
