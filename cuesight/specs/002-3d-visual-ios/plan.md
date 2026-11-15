# Implementation Plan: 3D Table, Two-Photo Snap Guide, Polished UI and iOS App

**Branch**: `002-3d-visual-ios` | **Date**: 2026-11-14, revised 2026-11-15 to match `fix2b/app` |
**Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/002-3d-visual-ios/spec.md`

## Summary

Feature 002 builds on the finished 001 shot guide. It adds four things:

1. **3D practice table** (US1). A hand-written WebGL2 renderer (`src/app/render3d/`, part of the
   main bundle; see T131) draws a lamp-lit pool or snooker table. It has orbit, pinch and pan gestures, three camera presets,
   tap-to-pick and drag, and the 001 plan drawn in 3D. A cue stick shows the strike point and power,
   and a physically consistent **Play shot** replay runs from the simulated trajectories. When
   WebGL2 is missing, the app falls back to the 001 2D `TableView`.
2. **Snap two-photo guide** (US2). A table photo runs through the 001 vision pipeline on a still,
   giving the layout. A table-level player photo is fitted against that known layout by a new pure
   solver (`src/vision/player-view.ts`, with the photo detection in `src/vision/player-detect.ts`):
   6-DoF plus focal Levenberg–Marquardt over ball silhouettes and cushion edges, from pair
   hypotheses over a phone-lens sweep (research R-24). The app then
   draws the aim line, ghost ball, object-ball path, the strike dot on the cue ball and the power on
   the photo. A two-tap manual fallback covers the failures. Both new vision messages travel over
   worker protocol v2. Snap photos are processed at 960 px on the long side.
3. **Midnight Felt UI** (US3). Design tokens, glass panels, a segmented mode control, a bottom sheet
   or side panel, a redesigned shot card (big numerals, overlap glyph, power gauge, shaded spin ball),
   an onboarding hint, the app icon at every size and a splash.
4. **iOS app** (US4). A Capacitor 8.6.0 wrapper (dev dependencies only) and a GitHub Actions workflow
   on macOS. The workflow builds and runs the app in the iOS Simulator (smoke test plus screenshot
   tour), runs Playwright WebKit iPhone e2e, and uploads to TestFlight with an App Store Connect API
   key when its secrets exist.

## Technical Context

**Language/Version**: TypeScript 5.x (strict), ES2022. GLSL ES 3.00 shaders. Swift only as generated
by the Capacitor template (no hand-written Swift).

**Primary Dependencies**:
- Runtime (npm): **none** (unchanged). The 3D renderer, pose solver and UI are in-house (R-15, R-24,
  R-32).
- Dev (npm), new: `@capacitor/cli`, `@capacitor/core` and `@capacitor/ios`, pinned exactly to `8.6.0`
  (R-27; the CLI needs Node ≥ 22). Existing: Vite 6, Vitest 3, Playwright 1.63.0, tsx, TypeScript.
- Native (iOS binary only): the Capacitor Swift package `capacitor-swift-pm` 8.x through SPM
  (justified in R-27 and under Complexity Tracking).

**Storage**: none server-side.
- `localStorage` (guarded): settings, the onboarding dismissal and the 2D/3D preference.
- Snap photos: in memory only, released on *Start over* or on leaving Snap.

**Testing**:
- **Vitest (Node)**:
  - render3d pure modules: math3d, camera, picking, playback, scene-data, gestures
    (`tests/unit/app/render3d-*.test.ts`);
  - player-view projection, the strike point and the estimator on synthetic table-level renders;
  - the still pipeline and worker protocol v2 (`tests/integration/player-view.test.ts`,
    `tests/unit/workers/vision-worker.test.ts`), the Snap session state machine and guide, the photo
    decoding, and the icon headers.
- **Playwright**:
  - Chromium phone with the SwiftShader WebGL flags: Practice 3D, Snap via `setInputFiles`, UI and
    accessibility, and the 001 suites unchanged;
  - WebKit iPhone on macOS CI.
- **iOS Simulator**: launch smoke (ready marker) plus a screenshot tour (R-29).

**Target Platform**:
- Web: as in 001 (iOS Safari 16+, Chrome Android 110+, desktop browsers). WebGL2 for 3D, otherwise
  2D.
- iOS app: iOS 16+ through Capacitor 8 (SPM template; deployment target 16.0, because the UI's CSS
  container queries need WKWebView 16), iPhone and iPad, portrait and landscape.

**Project Type**: single client-side web app (PWA) plus a thin native iOS wrapper project (`ios/`).

**Performance Goals**:
- **3D**: ≥ 30 fps while orbiting and during playback on a mid-range phone, with 22 balls. Zero frames
  when idle. Interactive within 2 s.
- **3D frame budget** (ASSUMPTION, checked on device): ≤ 60 draw calls (instanced balls), ≤ 150k
  triangles, DPR ≤ 2.
- **Snap**: table photo → layout < 3 s. Player photo → guide < 2 s on a mid-range phone, and
  < 0.5 s per scene in Node CI on the 1280 px fixtures (SC-109). The app itself sends 960 px photos.
- **Plan**: re-plan stays < 50 ms (001).

**Constraints**:
- No network at runtime: no CDNs, web fonts or analytics. The iOS app has no `server.url`.
- No allocation in per-pixel loops (player-photo detection). Per-frame render work does no
  per-vertex allocation: meshes are built once per table, and plan ribbons are rebuilt into a
  pre-allocated buffer only when the plan changes.
- Initial gzip JS < 250 KB. *Revised 2026-11-15*: the 3D renderer is imported statically by
  `main.ts` and ships in the main chunk (about 112 kB gzip with it on `fix2b/app`), so there is no lazy
  chunk to prefetch. The service worker precaches every built file (001 plan.md, Constitution V), so
  it works offline either way.
- Every worker message carries `v` (now `2`).

**Scale/Scope**: ~5–6k new lines of TypeScript and GLSL including tests. 3 modes, ~8 new UI
components, 1 native wrapper and 1 CI workflow.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| # | Principle | How this plan complies | Status |
|---|---|---|---|
| I | Physics Fidelity | No new physics constants. The 3D replay uses the 001 simulator's trajectories and event times, and the 001 sliding-friction law for rotation (R-17), with `params` from the active `PhysicsParams`. The strike point is exact sphere geometry (R-26). The cue-stick power gap is a display mapping, not physics, and is labelled as such | ✅ |
| II | Honest Uncertainty | The player-photo fit returns a confidence from 0 to 1, the residual and a reason. The guide is not drawn as if right below the threshold. The manual fallback shows its (capped) confidence. Warnings cover "balls moved", "not behind the cue ball" and "strike point off-photo" (FR-116 … FR-121, SC-107). The 3D fallback note says when 3D is unavailable | ✅ |
| III | Test-First, Deterministic Core | The new algorithms are pure and deterministic, with no randomness (fixed hypothesis order): `vision/player-view.ts` and, since the player-photo merge, `vision/player-detect.ts` (the photo detection, T133/T140; the solver is still inside `player-view.ts`, so the planned `lm.ts` split, T134/T139, is not made), `render3d/{math3d,geom,camera,picking,playback,scene-data,gestures}.ts` and `snap/session.ts`. Ground truth comes from synthetic table-level renders through the existing ray tracer. Test tasks precede implementation in tasks.md | ✅ |
| IV | Real-Time Budget | Render on demand. Contact shadows are one decal quad per ball (no shadow maps). Plan ribbons are rebuilt only when the plan changes, into a pre-allocated buffer. Pose solving and still processing run in the vision worker. No allocation in per-pixel loops. Budgets: SC-101, SC-105, SC-109 | ✅ |
| V | Privacy by Architecture | Photos stay in memory in the page and the worker, and are discarded on *Start over* or on leaving Snap. Still no `fetch` for user data. The iOS app bundles its assets with no remote URL. No analytics. The TestFlight upload is CI-only and never part of the app | ✅ |
| VI | Player-First Language and Accessibility | Strike shown as a dot plus words ("½ tip below centre"; 1 tip = ¼ R, with mm in the card details) plus the spin ball. Power as 1–10, a speed word and a meter. The Okabe–Ito palette and dash styles reused in 3D and on photos. Targets ≥ 44 px (also in 3D picking, R-19). Focus rings, contrast rules (R-32) and a full 2D fallback | ✅ |
| VII | Simplicity and Minimal Dependencies | **Zero runtime npm dependencies kept**: the WebGL2 renderer is hand-written (R-15), and app code imports nothing from `@capacitor/*`. Capacitor packages are dev-only and pinned. Layering is unchanged: `core` ← `vision` ← `workers` ← `app`. `render3d` (app layer) imports `core` (types, `strikeBall`, params) and `app/render/palette.ts`; `player-view` imports `core` types and `vision` helpers only | ✅ |
| — | Technical constraints | The worker protocol is bumped to v2 with a migration note in [contracts/worker-protocol-v2.md](./contracts/worker-protocol-v2.md). The initial bundle stays < 250 KB with the 3D renderer in it (≈ 112 kB gzip; there is no lazy 3D chunk). The iOS 16+ wrapper keeps the PWA as the primary platform | ✅ |

Post-design re-check (after Phase 1): ✅ no violations. One native runtime dependency (the Capacitor
Swift package inside the iOS binary) is justified below.

Post-review re-check (2026-11-15, `fix2b/app`): the rows above hold for the 002 code, with the
corrections made in place (no lazy 3D chunk, iOS 16, the consolidated `player-view.ts`). The 6 failing
`ball-detect-edge.test.ts` cases belong to the 001 vision code (001 T074) and keep Gate 3 open for the
merge (001 analysis.md, "Post-wave-2").

Post-vision-merge re-check (2026-11-15, `rc/release` = 9a162bf): the rows still hold. The
player-photo merge adds `player-detect.ts` (pure, deterministic, typed-array scratch reused between
calls) and bounds the work per photo by a counted budget, not a clock (Principle III). The 001 T074
cases pass, so Gate 3 is met (001 analysis.md, "Post-vision merge").

## Project Structure

### Documentation (this feature)

```text
specs/002-3d-visual-ios/
├── spec.md                    # Feature specification (US1–US4, FR-101…, SC-101…)
├── plan.md                    # This file
├── research.md                # Phase 0: decisions R-15 … R-33
├── data-model.md              # Phase 1: entities, tokens, state machines
├── quickstart.md              # Phase 1: run + validation scenarios, iOS Simulator, TestFlight secrets
├── contracts/
│   ├── render3d-api.md        # createTable3D / Table3D (API of record)
│   ├── player-view-api.md     # estimatePlayerView & projection helpers (API of record)
│   └── worker-protocol-v2.md  # v2 messages: still, player-view (+ all v1 messages)
├── checklists/requirements.md
└── tasks.md                   # Phase 2: T101 …
```

### Source Code (repository root = `cuesight/`; the git root is its parent)

New and changed files. Owner packages are in brackets. Files marked *advisory* may be split
differently by their owner; the contract files are binding. *Revised 2026-11-15* to the files that
exist on `fix2b/app`; where the build differs from the original plan, the line says so.

```text
src/
├── app/
│   ├── render3d/                  # [render3d] US1 (in the main chunk: no lazy load, T131)
│   │   ├── index.ts               # createTable3D, contracts/render3d-api.md (binding)
│   │   ├── math3d.ts              # vec3/quat/mat4, rays (pure)                     (advisory)
│   │   ├── geom.ts                # derived 3D table geometry (rails, pockets) (pure)(advisory)
│   │   ├── camera.ts              # orbit camera, presets, fit, clamps (pure)       (advisory)
│   │   ├── gestures.ts            # pointer → tap/drag/orbit/pinch/pan machine      (advisory)
│   │   ├── picking.ts             # ray picking with touch slop (pure)              (advisory)
│   │   ├── playback.ts            # timed tracks + rolling rotation (pure)          (advisory)
│   │   ├── scene-data.ts          # ball looks, plan ribbons/markers, cue pose (pure)(advisory)
│   │   ├── meshes.ts              # mesh builders (typed arrays, pure)              (advisory)
│   │   ├── textures.ts            # procedural cloth, wood, number atlas            (advisory)
│   │   ├── shaders.ts             # GLSL ES 3.00 sources                            (advisory)
│   │   ├── gl.ts                  # programs, meshes, textures on the GPU           (advisory)
│   │   └── scene.ts               # the WebGL2 renderer: draws one frame            (advisory)
│   ├── snap/                      # [integrate] US2
│   │   ├── session.ts             # SnapSession state machine, Snap messages and HUD words (pure)
│   │   ├── photo.ts               # file → upright Photo at 960 px, sample photos (FR-111, FR-123)
│   │   ├── exif.ts                # JPEG/PNG header: size and EXIF orientation (pure)
│   │   ├── guide.ts               # PlayerGuide: what is drawn on the player photo (pure)
│   │   ├── draw.ts                # draws the guide and the layout on the photo canvas
│   │   └── controller.ts          # the Snap stage: photos, review/edit, corners, taps, worker calls
│   ├── live-logic.ts              # [integrate] pure Live rules: lock gate, hints, calibration words, remap
│   ├── planner-client.ts          # [integrate] planner worker client: stale rule, restarts, budgets
│   ├── pocket-names.ts            # [integrate] view-relative pocket names
│   ├── sw-update.ts               # [integrate] "A new version… Reload" prompt
│   ├── ui/                        # [ui] US3
│   │   ├── icons.ts               # icon(name, size): SVGSVGElement (binding)
│   │   ├── sheet.ts               # createSheet(el, opts) (binding)
│   │   ├── power-meter.ts         # renderPowerMeter(power, minPower) (binding)
│   │   ├── spin-ball.ts           # renderSpinBall(side, vert, size?) (binding)
│   │   ├── fraction-glyph.ts      # renderFractionGlyph(fraction, cutSide) (binding)
│   │   ├── shot-card.ts           # redesigned; same signature, test ids, texts
│   │   ├── view-controls.ts       # Top · Player · Orbit, Play / Skip, ½×
│   │   ├── scene-labels.ts, label-place.ts, ball-tags.ts   # 3D / 2D labels and ball letters
│   │   └── onboarding.ts          # first-run hint                                  (advisory)
│   ├── styles.css                 # [ui] Midnight Felt tokens + components
│   └── main.ts                    # [integrate] Live·Snap·Practice, 3D↔2D, tour, ready marker
├── vision/                        # [playerview] US2
│   ├── player-view.ts             # contracts/player-view-api.md (binding): hypotheses, the LM solver
│   │                              # (no separate lm.ts, T134/T139) and the decision
│   └── player-detect.ts           # cloth candidates, crack evidence, circle candidates (T133/T140)
└── workers/                       # [playerview]
    ├── protocol.ts                # PROTOCOL_VERSION = 2; still + player-view (+ plan, perEvalMs) messages
    ├── vision.worker.ts           # still (processStill: N passes, separate pipeline) + player-view
    └── eval-budget.ts             # per-device evaluation budget of the planner worker

index.html                         # [ui] segmented mode control, icon links, splash, theme-color
public/
├── icon.svg                       # [ios] vector master (full-bleed)
├── icons/                         # [ios] icon-180/192/512, icon-maskable-512, favicon-32 (.png)
├── manifest.webmanifest           # [ios] icons, colours #070B14
├── sw.js                          # precaches every built file (list written by scripts/sw-precache.ts)
└── samples/                       # [integrate] snap-table.png, snap-player.png (FR-123)
scripts/
├── make-icons.cjs                 # [ios] Chromium rasterisation → PNGs (R-31)
└── make-snap-fixtures.ts          # [playerview] synthetic table + player photos + truth JSON
capacitor.config.ts                # [ios] appId (com.cuesight.app), appName, webDir dist, backgroundColor
ios/                               # [ios] Capacitor 8 SPM project (committed)
│   └── App/App/
│       ├── Info.plist             # display name, camera/photo strings, ITSAppUsesNonExemptEncryption
│       ├── Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png  (opaque, RGB)
│       └── Base.lproj/LaunchScreen.storyboard   # #070B14 + logo splash
ios/ExportOptions.plist            # [ios] method app-store-connect, destination upload
../.github/workflows/cuesight-ios.yml  # [ios] at the git root; working-directory cuesight (R-29, R-30)
scripts/ios-sim-smoke.sh, ios-testflight.sh, ios-select-xcode.sh      # [ios] CI steps, also run on a Mac
playwright.config.ts               # [integrate] SwiftShader args; Pixel 7, iPhone SE and iPad projects
playwright.webkit.config.ts        # [integrate] the WebKit iPhone 15 run (skips the live camera and offline)

tests/
├── unit/app/render3d-*.test.ts       # [render3d] math, camera, picking, playback, scene, gestures
├── unit/vision/player-view.test.ts   # [playerview] projection, outline, strike point
├── unit/workers/vision-worker.test.ts  # [playerview] still options, reset keeps ids
├── unit/app/snap-session.test.ts, snap-guide.test.ts, snap-photo.test.ts   # [integrate] Snap
├── unit/icons.test.ts                # [ios] sizes + colour type (no alpha on iOS 1024)
├── unit/ios-sim-smoke.test.ts        # [ios] the smoke script's ready gate
├── integration/player-view.test.ts   # [playerview] accuracy grid, failures, manual taps, perf,
│                                     # protocol v2 and the still pipeline on the 1280 px fixtures
├── e2e/practice3d.spec.ts            # [integrate] 3D picks, presets, playback, 2D fallback
├── e2e/snap.spec.ts                  # [integrate] two-photo flow, manual taps, no network
├── e2e/ui.spec.ts                    # [ui] tokens, sheet, 44 px hit areas, focus, contrast, onboarding
├── e2e/update.spec.ts                # [integrate] a deploy never takes over an open page
└── e2e/wiring.spec.ts                # [integrate] package-integration checks (chromium-phone)
```

**Structure Decision**: the single client-side project from 001, extended. New code stays in its
layer:
- pure pose maths in `vision/`;
- message adapters in `workers/`;
- WebGL, DOM and Snap flow in `app/`.

The native wrapper lives beside it in `ios/` and contains only generated Capacitor files plus
configuration. CI lives at the git root because the app is a subdirectory.

## Phase 0 — Research

See [research.md](./research.md). Every Technical Context unknown is resolved (R-15 … R-33). There
are no `NEEDS CLARIFICATION` items.

## Phase 1 — Design

- Entities, tokens and state machines: [data-model.md](./data-model.md)
- Interfaces:
  - [contracts/render3d-api.md](./contracts/render3d-api.md)
  - [contracts/player-view-api.md](./contracts/player-view-api.md)
  - [contracts/worker-protocol-v2.md](./contracts/worker-protocol-v2.md)
- UI component signatures (binding, owned by `ui`): listed in data-model.md § UI components.
- Validation scenarios, the iOS Simulator job and TestFlight setup: [quickstart.md](./quickstart.md)

## Integration notes (cross-package)

- **3D in the app** (`integrate`):
  - `main.ts` imports `render3d` statically (no lazy chunk), calls `createTable3D`, and falls back to
    `TableView` on `null`, on `?renderer=2d`, on the setting, or when `isFailed()` reports a context
    that could not be restored.
  - `window.__cuesight.practiceToScreen` must delegate to `table3d.toScreen(p, R)` when 3D is active,
    so the 001 e2e taps keep working.
  - `onBallDrag('end')` applies the 001 overlap push-apart before `setData`.
- **Snap** (`integrate`): drives the vision worker with `still` and `player-view` (v2).
  - `KnownBall.rgb` comes from the table photo's `TrackedBall.rgb`.
  - `focalPx` is the table photo's estimated `calibration.focal`, scaled to the player photo
    (`guide.ts` `scaleFocal`), passed when the table photo's focal was estimated. The solver treats it
    as a soft prior (R-24), so a lens change only weakens it.
  - Every `still` carries `opts.manualCorners` (the tapped corners or null), `opts.swapAxes: false`
    and `opts.fovDeg` (the Settings field of view); the table comes from the latest `config`.
- **Ready marker and tour** (`integrate`):
  - `console.info('[CueSight] ready mode=<mode> renderer=<webgl2|2d>')` once the first frame is
    drawn.
  - `import.meta.env.VITE_CUESIGHT_TOUR === '1'` enables the screenshot tour (R-29), which logs
    `[CueSight] tour <step>`.
- **Body mode**: `body[data-mode]` is `camera` (labelled Live), `snap` or `practice`. The 001 test ids
  and accessible names are kept.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| Native runtime dependency in the iOS binary: the Capacitor Swift package (`capacitor-swift-pm` 8.x) | The user asked for an iOS app on TestFlight. Capacitor gives a secure-context custom scheme (`capacitor://localhost`) for bundled assets, a correct WKWebView configuration for camera and inline video, safe areas and `cap sync` (R-27) | A hand-written WKWebView shell would reimplement the scheme handler, permission delegates and safe-area handling (more code to own and test, Principle VII). PWA-only can't reach TestFlight. The web bundle itself keeps zero runtime npm dependencies |
