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
- [X] T046 [US2] Integration tests for the end-to-end `processFrame` on synthetic scenes against the accuracy contract, printing per-scene errors, in `tests/integration/pipeline.test.ts`
- [X] T047 [US2] Implement `processFrame` with pipeline state and manual-corner support in `src/vision/pipeline.ts`
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
- [X] T061 [US5] Implement `recommendStroke` (grid search, robustness re-sim, scratch rejection, time budget) and `positionHeatmap` in `src/core/shot/position.ts`
- [X] T062 [US5] Add the planner worker's `recommend` and `heatmap` handlers in `src/workers/planner.worker.ts`
- [X] T063 [US5] Implement Position mode (tap landing spot), the default-recommendation refresh, and heatmap rendering and toggle in `src/app/main.ts` and `src/app/render/table-view.ts`

---

## Phase 8: Polish & Cross-Cutting Concerns

- [X] T064 [P] Implement the settings sheet (table preset, cloth speed, cushion bounce, shaft type, cushion width, FOV, details toggle) in `src/app/ui/controls.ts`
- [X] T065 [P] Register the service worker in production builds and add offline handling in `src/app/main.ts`
- [X] T066 [P] Add a performance guard test (planShot 22 balls < 50 ms; vision frame 640×480 < 100 ms in node) in `tests/integration/perf.test.ts`
- [X] T067 [P] Write `README.md`: what it is, run/test, architecture, "How accurate is this?", limitations, roadmap
- [X] T068 Accessibility pass (touch targets ≥ 44 px, aria labels, colour-blind-safe redundancy) in `src/app/styles.css` and the UI modules
- [X] T069 Run the quickstart validation (Q1–Q15) plus screenshots, and run `/speckit-analyze`. Fix inconsistencies

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
