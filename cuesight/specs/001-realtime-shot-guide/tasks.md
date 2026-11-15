---
description: "Task list for the Real-Time Shot Guide feature"
---

# Tasks: Real-Time Shot Guide

**Input**: Design documents from `/specs/001-realtime-shot-guide/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: REQUIRED. Constitution Principle III (test-first) and §9 of the master prompt require them.
Test tasks come first in each phase and must fail before their implementation task.

**Organization**: tasks are grouped by user story so each story can be implemented and demoed on its
own.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependencies)
- **[Story]**: US1…US5 from spec.md
- All paths are relative to `cuesight/`

---

## Phase 1: Setup (Shared Infrastructure)

- [X] T001 Create `package.json` (scripts: dev, build, preview, typecheck, test, e2e, fixtures), `tsconfig.json` (strict, ES2022, DOM + WebWorker libs) and `vite.config.ts` (worker format `es`)
- [X] T002 [P] Configure Vitest in `vitest.config.ts` (node environment, `tests/unit`, `tests/integration`) and Playwright in `playwright.config.ts` (pinned 1.63.0, webServer = vite preview, fake-camera Chromium args)
- [X] T003 [P] Create `.gitignore` (node_modules/, dist/, coverage/, test-results/, playwright-report/, *.log, .env*, tests/fixtures/*.y4m)
- [X] T004 [P] Create the app shell `index.html` plus `public/manifest.webmanifest`, `public/icon.svg` and `public/sw.js` (cache-first app shell, no runtime fetch of user data)

---

## Phase 2: Foundational (Blocking Prerequisites)

**⚠️ No user-story work can begin until this phase is complete.**

- [X] T005 [P] Unit tests for vector math in `tests/unit/core/vec.test.ts`
- [X] T006 [P] Implement 2D/3D vector helpers in `src/core/vec.ts`
- [X] T007 Define the shared domain types (TableSpec, PocketSpec, Ball, TableLayout, Stroke, ShotRequest, ShotPlan, Trajectory, SimEvent, Warning, PhysicsParams) per data-model.md in `src/core/types.ts`
- [X] T008 [P] Unit tests for table presets and pocket/cushion geometry in `tests/unit/core/table.test.ts`. Assert jaws lie on the rectangle, mouth widths match, and `cornerMouth > 2·ballRadius`
- [X] T009 Implement `makeTable`, `TABLE_PRESETS` (pool9 2.540×1.270, pool8 2.235×1.118, pool7 1.981×0.991, uk7 1.829×0.914, snooker12 3.569×1.778) and `clampToTable` in `src/core/table.ts`
- [X] T010 [P] Implement `DEFAULT_PHYSICS` with sourced defaults in `src/core/physics/params.ts`
- [X] T011 [P] Unit tests for analytic physics in `tests/unit/core/analytic.test.ts`:
  - 30° rule max ≈ 33.7°
  - throw ≈ 0 at full ball; throw of a slow stun half-ball hit between 3° and 6°
  - outside "gearing" english cancels throw
  - squirt is 1–3° at 0.5 R for m/mₑ = 23, and smaller for 35
- [X] T012 Implement `throwAngle`, `squirtAngle`, `rollingDeflection` and `rollingDistance` in `src/core/physics/analytic.ts`
- [X] T013 [P] Unit tests for the cue strike in `tests/unit/core/strike.test.ts`: natural roll at `vert = 0.4`, ω = (5/2)·v·b/R², radial clamp at 0.5
- [X] T014 Implement `strikeBall` (speed, spin, squirt) in `src/core/physics/strike.ts`
- [X] T015 [P] Unit tests for the simulator in `tests/unit/core/simulate.test.ts`:
  - no energy gain; no overlaps; slide→roll transition at the 5/7 speed rule
  - rolling stop distance = v²/(2·μr·g) within 2 %
  - stun at 30° leaves on the tangent line ±1°; rolling at 30° deflects 33.7° ± 1°
  - simulated throw matches `throwAngle` ± 0.15°
  - straight-in stop shot leaves the CB within 3 cm of contact
  - draw comes back, follow goes forward
  - cushion rebound reverses vₙ with e_c, and running english lengthens the angle
  - a ball rolled into a corner is pocketed
- [X] T016 Implement ball–ball and ball–cushion/jaw impulse models in `src/core/physics/collide.ts`
- [X] T017 Implement the continuous-collision time-stepped `simulate()` (sliding/rolling/spinning states, sub-step time of impact, pocket capture, trajectory recording) in `src/core/physics/simulate.ts`
- [X] T018 [P] Define the versioned worker messages per contracts/worker-protocol.md in `src/workers/protocol.ts`
- [X] T019 [P] Implement the tiny observable store in `src/app/store.ts` and guarded settings persistence in `src/app/settings.ts`

**Checkpoint**: the physics engine is tested. User stories can start.

---

## Phase 3: User Story 1 - Complete shot plan for a chosen ball and pocket (Priority: P1) 🎯 MVP

**Goal**: tap a ball and a pocket on the virtual table and get the full, physics-grounded plan.

**Independent Test**: quickstart Q1–Q5 on the virtual table. `tests/integration/planner.test.ts` passes.

- [X] T020 [P] [US1] Unit tests for ghost ball, cut angle, fraction labels and contact point in `tests/unit/core/geometry.test.ts`
- [X] T021 [P] [US1] Unit tests for pocket windows in `tests/unit/core/pocket-window.test.ts`:
  - straight-in corner window ≈ (mouth − 2R)/2 / d
  - side pocket closes at steep angles
  - window from a rail-frozen ball is non-empty and small
- [X] T022 [P] [US1] Unit tests for path blockers in `tests/unit/core/obstruction.test.ts`
- [X] T023 [P] [US1] Implement `ghostBall`, `cutAngle`, `fractionOf` and `contactPoint` in `src/core/shot/geometry.ts`
- [X] T024 [P] [US1] Implement `pocketWindow` in `src/core/shot/pocket-window.ts`
- [X] T025 [P] [US1] Implement `pathBlockers` in `src/core/shot/obstruction.ts`
- [X] T026 [P] [US1] Implement the power ↔ speed table, speed words and `describeSpin` in `src/core/shot/power.ts`
- [X] T027 [P] [US1] Implement difficulty labels (R-10 thresholds) and the coaching-tip generator in `src/core/shot/coach.ts`
- [X] T028 [US1] Integration tests for `planShot` in `tests/integration/planner.test.ts`:
  - straight-in: 0°, full, throw 0
  - 30° stun takes the tangent line; 30° rolling follows the 30° rule
  - blocked-cue and blocked-object name the blocking ball
  - scratch flagged; ≥ 88° cut is not makeable with an alternative pocket
  - auto best pocket; minPower; < 50 ms with 22 balls
- [X] T029 [US1] Implement `planShot`: pocket choice, throw-compensation iteration via the simulator, the default stroke, warnings and margin, in `src/core/shot/planner.ts`
- [X] T030 [P] [US1] Implement the Okabe–Ito palette and dash styles in `src/app/render/palette.ts`
- [X] T031 [US1] Implement the top-down table renderer, used for both the virtual table and the mini-map (balls, pockets, plan lines, ghost ball, rest marker, hit-testing, drag), in `src/app/render/table-view.ts`
- [X] T032 [US1] Implement the shot card (ball → pocket, cut, fraction, power meter, spin diagram, corrections, margin chip, warnings, tip) in `src/app/ui/shot-card.ts`
- [X] T033 [US1] Implement virtual-table mode with preset drills (straight-in, 30° cut, rail shot, blocked, scratch, full rack), selection flow and app wiring in `src/app/main.ts` and `src/app/styles.css`
- [X] T034 [US1] E2E test of the virtual table (select ball and pocket, card shows cut and power; tangent-line tip on the 30° preset) in `tests/e2e/virtual.spec.ts`

**Checkpoint**: MVP brain is demoable on the virtual table.

---

## Phase 4: User Story 2 - Live camera with plan overlay (Priority: P1)

**Goal**: point the camera at a table; it locks, detects balls and draws the plan on the cloth.

**Independent Test**: quickstart Q6–Q9. `tests/integration/pipeline.test.ts` meets the accuracy contract.

- [X] T035 [P] [US2] Unit tests for homography in `tests/unit/vision/homography.test.ts`:
  - 4-point DLT round trip
  - inverse
  - focal estimation recovers the true f within 3 % on synthetic poses
  - the plane-at-height homography matches direct projection
- [X] T036 [P] [US2] Implement DLT, apply, invert, `estimateFocal`, `poseFromHomography` and `planeHomography` in `src/vision/homography.ts`
- [X] T037 [P] [US2] Implement RGBA→HSV, the box-sum integral image and the bilinear sampler in `src/vision/image.ts`
- [X] T038 [US2] Implement the ray-traced synthetic table renderer (bed, cushions, rails, pocket holes, shaded or striped balls, shadows, camera pose and FOV) in `src/vision/synth/render.ts`
- [X] T039 [P] [US2] Unit tests for table detection on synthetic renders (green, blue and red cloth; 3 poses; corners within 1.5 % of the diagonal) in `tests/unit/vision/table-detect.test.ts`
- [X] T040 [US2] Implement the cloth model, mask, largest component, boundary hull, quad reduction and per-side line refit in `src/vision/table-detect.ts`
- [X] T041 [US2] Implement `calibrationFromCorners` (cushion-offset rectangle at cushion height → pose → H0/HR, axis-swap choice, FOV fallback) in `src/vision/calibration.ts`
- [X] T042 [P] [US2] Unit tests for ball detection (rectified at z = R, touching balls separated, cue ball identified, black ball found, median error ≤ 10 mm) in `tests/unit/vision/ball-detect.test.ts`
- [X] T043 [US2] Implement the rectify-at-ball-height, disk/ring scoring, NMS, centroid refinement and cue-ball classification in `src/vision/ball-detect.ts`
- [X] T044 [P] [US2] Unit tests for the tracker (EMA smoothing, association, lock state machine per data-model.md) in `tests/unit/vision/tracker.test.ts`
- [X] T045 [US2] Implement `createTracker` in `src/vision/tracker.ts`
- [X] T046 [US2] Integration tests for the end-to-end pipeline (`createPipeline().process`) on synthetic scenes against the accuracy contract, printing per-scene errors, in `tests/integration/pipeline.test.ts`
- [X] T047 [US2] Implement `createPipeline` (pipeline state, manual-corner support) in `src/vision/pipeline.ts`. The task text said `processFrame`; no function of that name was ever built
- [X] T048 [US2] Implement the vision worker adapter (transfer buffers, error replies) in `src/workers/vision.worker.ts`
- [X] T049 [US2] Implement camera capture (rear camera, permission errors, backpressured downscaled frames, video → display mapping) in `src/app/camera.ts`
- [X] T050 [US2] Implement the perspective AR overlay (table outline, ball rings, plan via H0, ghost ball via HR, pocket hit targets, lock indicator) in `src/app/render/overlay.ts`
- [X] T051 [US2] Wire camera mode: tap-to-select on the overlay, Freeze/Unfreeze, Calibrate (4 taps) and swap axes, mark cue ball, camera-denied fallback, in `src/app/main.ts` and `src/app/ui/controls.ts`
- [X] T052 [US2] Implement the fake-camera fixture generator (synthetic frames → Y4M 4:2:0) in `scripts/make-fake-camera.ts`
- [X] T053 [US2] E2E test with the fake camera (locks, ≥ 90 % of balls detected, tap ball + pocket → plan card) in `tests/e2e/camera.spec.ts`

**Checkpoint**: US1 + US2 make up the full MVP. It is shippable.

---

## Phase 5: User Story 3 - Try my own power and spin (Priority: P2)

**Goal**: override the stroke and see the predictions update instantly.

**Independent Test**: quickstart Q10–Q11. Monotonicity tests pass.

- [X] T054 [P] [US3] Integration tests in `tests/integration/stroke-override.test.ts`:
  - draw reverses the CB path and follow goes forward
  - travel distance is non-decreasing with power
  - side spin produces a squirt correction and changes throw
  - too-soft warning below minPower
- [X] T055 [US3] Implement the spin pad (tap or drag a tip position on the cue-ball face, miscue ring, quick presets for stop, draw, follow, left, right) in `src/app/ui/spin-pad.ts`
- [X] T056 [US3] Implement the power slider and the override toggle ("Use recommended" vs "My stroke") in `src/app/ui/controls.ts`, and wire it into re-planning in `src/app/main.ts`

---

## Phase 6: User Story 4 - Suggest best shots (Priority: P2)

**Goal**: rank every makeable shot and show the top three.

**Independent Test**: quickstart Q12. `tests/unit/core/suggest.test.ts` passes.

- [X] T057 [P] [US4] Unit tests in `tests/unit/core/suggest.test.ts`: easy beats hard, blocked shots excluded, ≤ 2 s on a 15-ball rack
- [X] T058 [US4] Implement `suggestShots` in `src/core/shot/suggest.ts`
- [X] T059 [US4] Implement the planner worker's `suggest` handler in `src/workers/planner.worker.ts`, and the suggestions list UI (tap to open a plan) in `src/app/ui/controls.ts`

---

## Phase 7: User Story 5 - Position play (Priority: P3)

**Goal**: land the cue ball on a chosen spot, or in the best next-shot zone by default. Heatmap.

**Independent Test**: quickstart Q13–Q14. `tests/integration/position.test.ts` passes.

- [X] T060 [P] [US5] Integration tests in `tests/integration/position.test.ts`:
  - a draw-reachable spot gets a below-centre stroke with rest ≤ 15 cm
  - an unreachable spot reports `reachable = false` with a safe alternative
  - the default recommendation improves next-shot quality over centre-ball
  - the heatmap is normalised to 0..1 and is higher near the next ball's natural line
- [X] T061 [US5] Implement `recommendStroke` (grid search, robustness re-sim, scratch rejection, budget) and `positionHeatmap` in `src/core/shot/position.ts`. The original wall-clock budget broke Principle III; T072 replaced it with a deterministic evaluation count
- [X] T062 [US5] Add the planner worker's `recommend` and `heatmap` handlers in `src/workers/planner.worker.ts`
- [X] T063 [US5] Implement Position mode (tap landing spot), the default-recommendation refresh, and heatmap rendering and toggle in `src/app/main.ts` and `src/app/render/table-view.ts`

---

## Phase 8: Polish & Cross-Cutting Concerns

- [X] T064 [P] Implement the settings sheet (table preset, cloth speed, cushion bounce, shaft type, cushion width, FOV, details toggle) in `src/app/ui/controls.ts`
- [X] T065 [P] Register the service worker in production builds and add offline handling in `src/app/main.ts`
- [X] T066 [P] Add performance guard tests against the device budgets (plan < 50 ms, vision < 100 ms, position search < 1.5 s), each with a stated CI factor, and print the measured medians:
  - `tests/integration/perf.test.ts`: planShot, 22 balls, median of 5 < 100 ms; recommendStroke, median < 3 s; suggestions on 9 balls < 2 s
  - `tests/integration/pipeline.test.ts`: vision pipeline at 640×480, median < 150 ms
  - `tests/integration/pipeline-420.test.ts`: the 4:2:0 rack frame < 250 ms, with ball detection ≤ 2.25× the fixture frame's
  - The original text claimed "< 50 ms" and "< 100 ms" guards, but the only assertion was 250 ms (review finding `tests-looser-than-claimed`)
- [X] T067 [P] Write `README.md`: what it is, run/test, architecture, "How accurate is this?", limitations, roadmap
- [X] T068 Accessibility pass (touch targets ≥ 44 px, aria labels, colour-blind-safe redundancy) in `src/app/styles.css` and the UI modules. **Reopened 2026-11-15**: ball hit targets on the mini-map, overlay and 3D view, and the settings fields, were below 44 px on `fix/wave1` (review findings `touch-targets-under-44px`, `a11y-touch-targets-aria`). **Closed again on `fix2b/app`**: a 22 CSS px pick-radius floor on the 2D table, mini-map, overlay and 3D table (`src/app/render3d/picking.ts`, with the ball-vs-pocket rule), 44 px controls and settings fields, checked by `tests/e2e/ui.spec.ts` (hit areas by `elementFromPoint` at 393×852 and 375×667) and `tests/unit/app/render3d-picking.test.ts`
- [X] T069 Run the quickstart validation (Q1–Q15) plus screenshots, and run `/speckit-analyze`. Fix inconsistencies. That analysis missed the drift the review found; see T077

---

## Phase 9: Review fixes (2026-11-15)

**Input**: the deep code review of HEAD 95d197b (86 findings: 83 confirmed, 3 rejected), grouped into
fix packages. Details, finding ids and what is still open: analysis.md "Post-review". The code
packages ran under the test-first rule (Principle III): their regression tests come from each
finding's test spec, and the commit messages record the evidence.

**Wave 1** (integrated on `fix/wave1`):

- [X] T070 [P] Physics: the cushion impulse acts on the full contact slip, so a rail changes top/back spin (R-08). The contact budget never skips a collision (relax sweeps, guarded drift). No per-step allocation and no `Math.hypot` in the step loop. `pocketArrivalSpeed` ASSUMPTION note. Squirt pinned to TP A.31. Files: `src/core/physics/collide.ts`, `simulate.ts`, `params.ts`; `tests/unit/core/collide.test.ts`, `simulate.test.ts`, `analytic.test.ts`
- [X] T071 [P] Vision geometry: truncated or absent tables return `null`. Adaptive refine band; quad validation; conditioned focal estimate and a stable long/short and 0°/180° frame; grey cloth; manual corners are honest (`reason`), with relative edge alignment. Anchored lock against occluders, cloth-change hysteresis, ids unique across reconfiguration, 2R separation. Files: `src/vision/table-detect.ts`, `calibration.ts`, `homography.ts`, `pipeline.ts`, `tracker.ts`; `tests/unit/vision/calibration.test.ts`, `table-detect.test.ts`, `tracker.test.ts`, `manual-cloth.test.ts`, `tests/integration/pipeline-live.test.ts`
- [X] T072 [P] Core shot: rail-frozen, frozen-cue-ball and corner-hanger shots planned (R-09). Snooker touching-ball rule. Throw search stays off the rail (`throw-uncompensable`). The "too soft" warning agrees with the simulation (`minPower` / `minPowerCapture`). Honest squirt and throw text (`cueAimDir`, `throwShiftDir`). Fraction labels in eighths with qualifiers. Blocked shots name another pocket. Deterministic worst-case position search (R-11), and a heatmap of zeros for the cue ball or target. Suggestions add next-shot quality. Files: `src/core/shot/*`, `src/core/types.ts`, `src/workers/planner.worker.ts`; `tests/integration/planner-edge.test.ts`, `position.test.ts`, `planner.test.ts`, `perf.test.ts`, `tests/unit/core/coach.test.ts`, `suggest.test.ts`, `geometry.test.ts`, `pocket-window.test.ts`
- [X] T073 [P] Vision balls: honest cue pick (no cue when ambiguous). Disc-model cluster split, cloth-hued balls, glare and stick shape gate, pocket hangers, colour names (pool and snooker palettes, neutral `ball`), module scratch reused (Principle IV). Files: `src/vision/ball-detect.ts`, `src/vision/synth/render.ts`; `tests/unit/vision/ball-detect-edge.test.ts`, `ball-detect.test.ts`, `tests/integration/pipeline-420.test.ts`
- [ ] T074 Vision balls robustness: make the disc-fit ball count stable under ±0.3 px calibration jitter, and make the touching-cluster tests check a set of jittered calibrations. **6 tests in `ball-detect-edge.test.ts` fail on `fix/wave1`**: 9-ball corner, 15-ball side, snooker end, side and corner, and 4:2:0 corner pairs at 30°. They are not weakened. Blocks Gate 3
- [X] T075 Integration of wave 1 (`f81ad62`): the pipeline-420 guard times the ball-detection stage. The exact-calibration 640×360 case learns the cloth inside the known outline. `player-view` ignores a neutral cloth hint
- [X] T076 [P] Docs, 001: the spec, plan, research, data model, contracts, quickstart and tasks describe the reviewed code (this revision)
- [X] T077 Re-run the `/speckit-analyze` cross-checks and record them in analysis.md "Post-review"

**Wave 2** (`fix2a/*`, merged with wave 1 in wave 2b on `fix2b/app`; T074 still waits for the vision branch):

- [X] T078 App core (`src/app/main.ts`, `live-logic.ts`, camera, `planner-client.ts`). Done on `fix2b/app`, plus Rotate/Calibrate keeping the selection (`rememberInFrame`, `remapThroughFrame`), the frozen power advice in the planner worker (`plan` message) and the budget kept across worker restarts (`perEvalMs`). Tests: `live-logic.test.ts`, `planner-client.test.ts`, `camera-session.test.ts`, `camera.spec.ts`, `wiring.spec.ts`:
  - selections survive tracker id churn;
  - live plan and overlay only while locked (2-result grace);
  - frozen overlay needs the same ordered frame; Mark cue works on a frozen layout;
  - "Tap the cue ball" when no ball `isCue`;
  - stale planner replies dropped; worker failures surfaced; one camera stream;
  - Position-mode taps; Zones refuses the cue ball and the target;
  - the app reads `fragile`, `timedOut`, `reason`, `cueAimDir`, `throwShiftDir`, `minPowerCapture` and the frozen-plan conventions;
  - grey cloth rendered grey (`fix2a/live`)
- [X] T079 App UI: settings dialog commit and validation, focus-safe re-renders, 44 px targets (closes T068), card texts (no "±-2.1 mm", throw direction), settings presets with source/ASSUMPTION notes (`fix2a/ui`, then the wave-2b card work: frozen tile, power gauge band, recommendation notes). Tests: `ui-components.test.ts`, `ui-review-fixes.test.ts`, `plan-ui.test.ts`, `settings.test.ts`, `ui.spec.ts`
- [X] T080 PWA: safe service-worker update for an open page, full precache with a build-level guard (`fix2a/platform`). Tests: `sw-precache.test.ts`, `sw-update.test.ts`, `offline.spec.ts`, `update.spec.ts`
- [X] T081 Docs, README and 002: known limitations (cushion model, cue ball not marked when ambiguous, green on green, clusters), the v2 protocol contract, 002 quickstart (listed in analysis.md "Post-review"). Done in the 2026-11-15 docs pass on `fix2b/app` (`fix2c/docs`)
- [X] T082 Decide the "tip" unit (¼ R vs a tip-width) and fix the "2 tip" plural (analysis.md P-F2). **Decided: keep 1 tip = ¼ R** (≈ 7 mm; 2 tips = the 0.5 R miscue limit), with the mm offset in the card details (`tipOffsetMm`); the words now say "2 tips" (`power-tips.test.ts`)
- [X] T083 [P] Add an automated check for FR-007 (mark the cue ball, live and frozen): `camera.spec.ts` "marking the cue ball on a frozen layout changes the frozen layout"; the live path shares `applyCueOverride` (`live-logic.test.ts`)

---

## Dependencies & Execution Order

- **Setup (P1)** → **Foundational (P2)** → user stories.
- **US1** depends only on Foundational. It is the MVP brain.
- **US2** depends on Foundational for types and table, and needs US1's planner for the overlay plan.
  Its vision tasks (T035–T047) are independent of US1 and can run in parallel with it.
- **US3** depends on US1 (planner, card).
- **US4** depends on US1 (planner) and adds the planner worker.
- **US5** depends on US1 and US3, and on the planner worker from US4.
- **Polish** comes last.
- **Review fixes** (Phase 9): wave-1 packages T070–T073 touch disjoint files and run in parallel,
  physics first for the merge. Wave 2 (T078–T081) consumes wave 1's new optional fields, and T074
  must land before Gate 3 can pass.

```text
Setup → Foundational ─┬─> US1 ─┬─> US3 ─┐
                      │        ├─> US4 ─┼─> US5 → Polish
                      └─> US2 (vision T035–T047 ∥ US1) ┘
```

## Parallel Example: User Story 2

```bash
# The vision maths and fixtures can be built in parallel:
Task: "T035 homography tests"     Task: "T037 image helpers"     Task: "T038 synthetic renderer"
# Then detection tests in parallel:
Task: "T039 table-detect tests"   Task: "T042 ball-detect tests"  Task: "T044 tracker tests"
```

## Implementation Strategy

1. **MVP first**: Setup → Foundational → US1. Validate Q1–Q5 on the virtual table. Then US2. Validate
   Q6–Q9 with the fake camera. **Ship.**
2. **Increment**: US3 (learning by experiment) → US4 (shot selection) → US5 (position play).
3. Each story ends at a checkpoint where all tests are green and it is demoable on its own.
