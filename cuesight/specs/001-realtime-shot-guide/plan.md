# Implementation Plan: Real-Time Shot Guide

**Branch**: `001-realtime-shot-guide` | **Date**: 2026-11-14, revised 2026-11-15 after the code
review and again for the wave-2 app (`fix2b/app`) | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-realtime-shot-guide/spec.md`

## Summary

CueSight is an installable, offline-capable web app (PWA). A player points a phone camera at a pool
or snooker table and gets a live shot plan: ghost ball, aim line, contact point, cut angle and
fractional aim, throw and squirt corrections, recommended power and spin, predicted object-ball and
cue-ball paths, margin of error, and a coaching tip.

The work splits into three dependency-free TypeScript layers:

1. **`core`**: billiards physics and planning.
   - A continuous-collision, time-stepped rigid-ball simulator with sliding/rolling/spinning friction,
     a frictional ball–ball impulse model (yields throw and spin transfer), a cushion impulse model
     on the full contact slip (changes top/back spin, research.md R-08), and the cue-strike model
     (spin from tip offset, squirt).
   - On top of it: a geometric planner (pocket angular windows, ghost ball, obstructions, margin;
     rail-frozen, frozen-cue-ball and corner-hanger cases) and search-based recommenders (default
     stroke, deterministic position play, suggestions, heatmap).
2. **`vision`**: a classical image pipeline over typed arrays. Its per-pixel loops never allocate.
   - Learn the cloth colour (grey cloth included), segment the table and fit a quad by robust line
     fitting. Truncated or implausible outlines are rejected.
   - Recover the homography and camera pose, with focal length estimated from the known rectangle.
   - Rectify at ball-centre height (parallax correction). Detect balls as blobs, then count each
     cluster's balls with a de-stretched disc model (a model selection over the count, with a
     penalised whole-cluster cost; a small pack is fitted again on a finer window), apply a shape
     gate, and fit circles to the visible silhouette (research.md R-04).
   - Name ball colours, pick the cue ball only when it is unambiguous, and track balls over time,
     with an anchored lock that tells occluders from camera moves.
3. **`app`**: camera capture, Web Worker orchestration, perspective overlay, top-down mini-map, shot
   card, spin pad and power slider, plus a virtual practice table.

Vision is validated against a built-in ray-traced synthetic table renderer with exact ground truth.
The same renderer produces the fake camera video for browser end-to-end tests.

## Technical Context

**Language/Version**: TypeScript 5.x (strict), ES2022 target

**Primary Dependencies**:
- Runtime: none (no CV/ML runtime, no UI framework). Justified in research.md R-01 and R-02.
- Dev: Vite (build/dev server, worker bundling), Vitest, Playwright 1.63 (matches the pre-installed
  Chromium), tsx (scripts).

**Storage**: none server-side. Settings go in `localStorage` (try/catch guarded); layouts live in the
session only.

**Testing**:
- Vitest: unit tests for core and vision, integration tests for the vision pipeline on synthetic
  renders and for the planner on full layouts.
- Playwright: e2e with Chromium's fake media stream fed a generated `.y4m` of a synthetic table.

**Target Platform**: mobile browsers (iOS Safari 16+, Chrome Android 110+) and desktop Chrome, Edge,
Firefox and Safari. Installable PWA.

**Project Type**: single-project client-side web app (PWA).

**Performance Goals**:
- Overlay at ≥ 30 fps (rAF).
- Vision at ≥ 10 Hz at 640 px processing width.
  - A frame with a snooker pack spends about 10–20 ms more in `detectBalls` since the cluster fix
    (≈ 45–56 ms against 35–40 ms on Node), for the finer window pass. Pool frames and frames without
    a cluster are unchanged or faster.
- A single-shot plan with full simulation in < 50 ms (target < 10 ms).
  - The main-thread plan skips the frozen power advice (`PlanOptions.advice: false`): measured median
    ≤ 1 ms and max 1.2–6 ms on 2–16 balls, against 11–22 ms median and up to 73 ms with the advice
    (desktop). The advice runs in the planner worker (`plan` message) once the input settles; the
    full plan replaces the quick one about 120 ms plus the worker's time later. Under SwiftShader CI
    load that is seconds: up to 2.3 s to post plus up to 3.0 s in the worker.
  - The search plans (position search, suggestions) skip the advice too.
- Position search in < 1.5 s. It is bounded by an evaluation count that the planner worker sizes
  once per device (at most 324, `FULL_EVALUATIONS`), so the result does not depend on device speed.
  The measured figures travel with each request (`perEvalMs`), so a restarted worker keeps the same
  budget. Suggestions for 15 balls in < 2 s.
- CI guards are looser than the device budgets, to absorb shared-runner noise:
  - planShot with 22 balls: median < 100 ms;
  - vision pipeline at 640×480: median < 150 ms;
  - position search: median < 3 s;
  - the 4:2:0 rack frame: < 250 ms, with ball detection ≤ 2.25× the fixture frame's.

**Constraints**:
- No network after load. Frames never leave the device.
- No allocation in per-pixel or per-step loops.
- Initial gzip JS < 250 KB.

**Scale/Scope**: up to 22 balls (snooker), 6 pockets, ~5 screens and panels, about 6–8k lines of
TypeScript including tests.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| # | Principle | How this plan complies | Status |
|---|---|---|---|
| I | Physics Fidelity | Physics constants live in `core/physics/params.ts`, each with a source or an ASSUMPTION note (`pocketArrivalSpeed` gained its note in the review fixes). Planner and vision tunables carry ASSUMPTION notes in place, and so do the app's settings presets (`settings.ts` `physicsFor`; lively cushions e0 0.9, inside 0.75–0.9). The analytic rules are in `core/physics/analytic.ts`. Tests pin the 90° rule, the 30° rule, throw (TP A.14), squirt (TP A.31, 2.40°/1.64°), natural roll at 2/5 R, rolling distance, the cushion behaviour of R-08 and no energy gain | ✅ |
| II | Honest Uncertainty | Every plan carries a margin of error, a difficulty label and warnings (blocked, scratch, too soft, cb-short, not-makeable, throw-uncompensable). Vision reports quality and lock state. It returns no calibration and no balls on frames without a usable quad, flags no cue ball when it is ambiguous, and gives manual corners a reason when they are not locked. The live plan and overlay are computed and drawn only on a locked table (a 2-result grace after a lock absorbs a single missed quad; a new table frame gets no grace from the old one). A frozen plan is drawn only through a live calibration with the same ordered corners. The card says when a recommended stroke is speed-sensitive, when the search was cut short, and when its scratch risk was not checked | ✅ |
| III | Test-First, Deterministic Core | `core` and `vision` are pure over typed arrays. A synthetic ray-traced renderer gives ground truth. Tests are written with each module. `recommendStroke` is bounded by a deterministic evaluation count (`maxEvaluations`), not by the clock | ✅, with one documented exception (Complexity Tracking: the optional `timeCapMs` safety net) |
| IV | Real-Time Budget | Vision runs in a worker. Position, suggest and heatmap searches run in a planner worker. Backpressured frame submission (one frame in flight). Table detection uses a pre-allocated scratch (`TableScratch`). Ball detection reuses module-level typed arrays across frames (≈ 40–50 KB of heap per call, none of it per pixel): two scratch sets, one for the whole-table pass and a second for the cluster window pass, so the first pass's buffers stay intact; both only grow, and the work queue grows instead of skipping a step, so results do not depend on earlier frames. The simulator's step loop allocates only output records | ✅, with one documented exception (Complexity Tracking: simulation output records) |
| V | Privacy by Architecture | No `fetch` for user data: the only `fetch` in app code is the same-origin bundled sample photo. The service worker precaches the build's own files (shell, chunks, workers, icons, manifest, sample photos) from a list written at build time; the build id hashes every listed file's bytes; each install revalidates with the server and checks that the shell belongs to the build; a new version never takes over an open page ("Reload"). No user data. Frames stay in memory, in workers. `tests/e2e/offline.spec.ts` checks for zero external requests and an offline reload; `tests/e2e/update.spec.ts` checks a deploy under an open page | ✅ |
| VI | Player-First Language | `core/shot/coach.ts` maps physics to coaching phrases. Palette is Okabe–Ito with dash patterns. Virtual table works without a camera. Touch targets ≥ 44 px (ball picks have a 22 px radius floor), checked by `tests/e2e/ui.spec.ts`. One tip = ¼ R, decided and kept, with mm in the card details (T082) | ✅ |
| VII | Simplicity | Zero runtime deps. Layering enforced by folder and import direction (`core` imports nothing from `vision` or `app`) | ✅ |

Post-design re-check (after Phase 1, 2026-11-14): ✅ no violations.

Post-review re-check (2026-11-15, `fix/wave1`): the earlier "no violations" was not true. See
analysis.md "Post-review" for the review's evidence.
- III and IV are now met, with the two exceptions justified below.
- I is met in core and vision. The app's settings presets still lack notes (P-C4).
- II and VI still have open app-side items.
- All the open items are scheduled for wave 2.
- Gate 3 (merge) is **not met**: 6 vision unit tests fail.

Post-wave-2 re-check (2026-11-15, `fix2b/app`):
- I, II, V and VI are now met on the app side too (rows above): the preset notes, the lock gate,
  the safe service-worker update and the 44 px targets landed, and the tip unit is decided.
- III and IV are met with the exceptions below.
- Gate 3 is **still not met**: the same 6 `ball-detect-edge.test.ts` cases fail (T074), pending the
  vision branch. See analysis.md "Post-wave-2".

Post-vision-merge re-check (2026-11-15, `rc/release` = 9a162bf):
- The ball-cluster fix (T074, merged as `360b268`) makes the 6 cases pass: P-C1 is resolved and
  Gate 3 is met. See analysis.md "Post-vision merge".
- IV still holds: the window pass adds a second, grow-only scratch set (row IV), and the extra cost
  on snooker packs is within the vision budget (Performance Goals).

## Project Structure

### Documentation (this feature)

```text
specs/001-realtime-shot-guide/
├── plan.md              # This file
├── research.md          # Phase 0: decisions, rationale, alternatives
├── data-model.md        # Phase 1: entities, fields, validation rules, state machines
├── quickstart.md        # Phase 1: run + validate scenarios
├── contracts/
│   ├── core-api.md      # Public function contracts of core + vision
│   └── worker-protocol.md  # Versioned worker message schemas
├── checklists/requirements.md
└── tasks.md             # Phase 2 (/speckit-tasks)
```

### Source Code (repository root = `cuesight/`)

```text
src/
├── core/                       # Pure TS — no DOM
│   ├── vec.ts                  # 2D/3D vector math
│   ├── table.ts                # TableSpec presets, pockets, cushion segments
│   ├── types.ts                # Shared domain types (Ball, Layout, Stroke, ShotPlan…)
│   ├── physics/
│   │   ├── params.ts           # PhysicsParams defaults + sources
│   │   ├── analytic.ts         # Throw, squirt, 30° rule, rolling distance, etc.
│   │   ├── strike.ts           # Stroke → initial ball state (speed, spin, squirt)
│   │   ├── collide.ts          # Ball–ball + ball–cushion impulse models
│   │   └── simulate.ts         # Continuous-collision time-stepped simulator
│   └── shot/
│       ├── geometry.ts         # Ghost ball, cut angle, fractional aim, contact point
│       ├── pocket-window.ts    # Angular acceptance window of a pocket from a ball
│       ├── obstruction.ts      # Swept-circle path checks
│       ├── power.ts            # Power levels ↔ speed, speed words, tips language
│       ├── coach.ts            # Difficulty labels + coaching tips
│       ├── planner.ts          # planShot(): full ShotPlan
│       ├── suggest.ts          # Rank all shots
│       └── position.ts         # Stroke search, next-shot quality, heatmap
├── vision/                     # Pure TS image algorithms on typed arrays
│   ├── image.ts                # RGBA/HSV helpers, integral images
│   ├── homography.ts           # DLT, apply/invert, focal estimation, pose, plane-at-height
│   ├── table-detect.ts         # Cloth model (incl. grey), mask, components, hull, quad, line refit, edge profiles
│   ├── calibration.ts          # Quad validation, corner ordering, axis choice, focal estimate, pose → H0 / HR
│   ├── ball-detect.ts          # Rectify @ ball height, blobs, disc-model count (+ window pass), shape gate, colour names, cue pick
│   ├── tracker.ts              # Temporal smoothing + lock state
│   ├── pipeline.ts             # createPipeline(): anchored lock, manual corners, 2R separation
│   └── synth/render.ts         # Ray-traced synthetic table renderer (fixtures + fake camera)
├── workers/
│   ├── protocol.ts             # Versioned message types (v2: 002 contracts/worker-protocol-v2.md)
│   ├── vision.worker.ts
│   ├── planner.worker.ts
│   └── eval-budget.ts          # Per-device evaluation budget of the stroke search
└── app/
    ├── main.ts                 # Bootstrapping, mode switch, wiring
    ├── store.ts                # Tiny observable app state
    ├── live-logic.ts           # Pure Live rules: lock gate, hints, calibration words, kept selection
    ├── planner-client.ts       # Planner worker client: stale rule, restarts, full-plan requests
    ├── pocket-names.ts         # View-relative pocket names
    ├── announce.ts             # Screen-reader announcements of a plan
    ├── sw-update.ts            # Service-worker registration and the "Reload" prompt
    ├── camera.ts               # getUserMedia + backpressured frame capture
    ├── settings.ts             # Persisted settings (guarded localStorage), physics presets
    ├── drills.ts               # Practice-table layouts
    ├── render/
    │   ├── palette.ts          # Okabe–Ito colours + dash styles (and the "Cue stick" style)
    │   ├── plan-draw.ts        # Shared plan geometry and labels for every view
    │   ├── overlay.ts          # Perspective AR overlay on the camera view
    │   └── table-view.ts       # Top-down table (mini-map + virtual table)
    ├── ui/
    │   ├── shot-card.ts        # Plan panel
    │   ├── spin-pad.ts         # Tip-position control
    │   └── controls.ts         # Toolbar, power slider, settings sheet
    └── styles.css

tests/
├── unit/core/…                 # physics + shot tests
├── unit/vision/…               # homography, detection tests
├── integration/…               # pipeline on synthetic renders, planner on layouts
└── e2e/…                       # Playwright (virtual table + fake camera)

scripts/make-fake-camera.ts     # Renders synthetic table frames → tests/fixtures/table.y4m (npm run fixtures)
scripts/sw-precache.ts          # Writes the precache list and build id into dist/sw.js
scripts/screenshots.cjs         # README screenshots (fake camera)
public/                         # manifest.webmanifest, sw.js, icon.svg
index.html
```

**Structure Decision**: a single client-side project. Layering is enforced by directory: `core` has
no imports outside itself, `vision` may import `core` math only, `workers` adapt `core` and `vision`
to messages, and `app` owns everything DOM.

## Phase 0 — Research

See [research.md](./research.md). All Technical Context unknowns are resolved (decisions R-01 … R-14).

## Phase 1 — Design

- Entities and state machines: [data-model.md](./data-model.md)
- Interfaces: [contracts/core-api.md](./contracts/core-api.md), [contracts/worker-protocol.md](./contracts/worker-protocol.md)
- Validation scenarios: [quickstart.md](./quickstart.md)

## Complexity Tracking

Documented exceptions (added 2026-11-15; the earlier "nothing to justify" was wrong):

| Principle | Exception | Why it is needed | Bound / safeguard |
|---|---|---|---|
| IV (no allocation in per-step loops) | `simulate()` allocates its **output records** inside the step loop: one `SimEvent` per event, trajectory points when `record` is on (with each point's time and spin, `mark()`), and at most n `FirstHit` records | These are the result itself. Pre-sized output buffers would need a guessed event count or a resize path, and would not change the cost: allocation scales with events, not with steps | Bounded by the event count, not the step count. Searches run with `record: false`. Per-step and fallback helpers read doubles from a pre-allocated buffer, so nothing is boxed per step. Guarded by `simulate.test.ts`: ≈ 3 M steps trigger ≤ 3 GC collections, and a lint test bans `Math.hypot` |
| III (no timing dependencies in core) | `recommendStroke` reads `performance.now()` **only when** the caller passes the optional `timeCapMs` safety net. The planner worker passes 1500 ms | Principle IV's < 1.5 s search budget must hold even when the worker's per-device evaluation count under-estimates the cost (a heavy layout, a throttled CPU) | Off by default, so the core is deterministic in tests and for any caller that does not set it. When the cap fires, the result says `timedOut: true`, so the app can call the search partial. The evaluation count, not the clock, is the primary budget |

Not exceptions, but recorded for honesty:
- The app allocates a new RGBA frame per capture (`getImageData` cannot fill an existing buffer).
  That is per frame, not per pixel. The buffer transferred back by the worker is not reused
  (contracts/worker-protocol.md).
- `detectBalls` and the pipeline allocate small per-frame objects (detections, anchors). Their
  per-pixel loops run on reused typed arrays.
