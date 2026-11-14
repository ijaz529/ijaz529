# Implementation Plan: Real-Time Shot Guide

**Branch**: `001-realtime-shot-guide` | **Date**: 2026-11-14 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-realtime-shot-guide/spec.md`

## Summary

CueSight is an installable, offline-capable web app (PWA). A player points a phone camera at a pool
or snooker table and gets a live shot plan: ghost ball, aim line, contact point, cut angle and
fractional aim, throw and squirt corrections, recommended power and spin, predicted object-ball and
cue-ball paths, margin of error, and a coaching tip.

The work splits into three dependency-free TypeScript layers:

1. **`core`**: billiards physics and planning.
   - A continuous-collision, time-stepped rigid-ball simulator with sliding/rolling/spinning friction,
     a frictional ball–ball impulse model (yields throw and spin transfer), a cushion impulse model,
     and the cue-strike model (spin from tip offset, squirt).
   - On top of it: a geometric planner (pocket angular windows, ghost ball, obstructions, margin) and
     search-based recommenders (default stroke, position play, suggestions, heatmap).
2. **`vision`**: a classical, allocation-free image pipeline.
   - Learn the cloth colour, segment the table and fit a quad by robust line fitting.
   - Recover the homography and camera pose, with focal length estimated from the known rectangle.
   - Rectify at ball-centre height (parallax correction) and detect balls by disk/ring scoring with
     non-maximum suppression.
   - Classify the cue ball and track balls over time.
3. **`app`**: camera capture, Web Worker orchestration, perspective overlay, top-down mini-map, shot
   card, spin pad and power slider, plus a virtual practice table.

Vision is validated against a built-in ray-traced synthetic table renderer with exact ground truth.
The same renderer produces the fake camera video for browser end-to-end tests.

## Technical Context

**Language/Version**: TypeScript 5.x (strict), ES2022 target

**Primary Dependencies**:
- Runtime: none (no CV/ML runtime, no UI framework). Justified in research.md R-01 and R-08.
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
- A single-shot plan with full simulation in < 50 ms (target < 10 ms).
- Position search in < 1.5 s. Suggestions for 15 balls in < 2 s.

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
| I | Physics Fidelity | All constants live in `core/physics/params.ts` with source comments. The analytic rules are in `core/physics/analytic.ts`. Tests pin the 90° rule, the 30° rule, throw (TP A.14), squirt (TP A.31), natural roll at 2/5 R, rolling distance and no energy gain | ✅ |
| II | Honest Uncertainty | Every plan carries a margin of error, a difficulty label and warnings (blocked, scratch, short, not-makeable). Vision reports quality and lock state. The UI hides the overlay when the table is unlocked | ✅ |
| III | Test-First, Deterministic Core | `core` and `vision` are pure over typed arrays. A synthetic ray-traced renderer gives ground truth. Tests are written with each module | ✅ |
| IV | Real-Time Budget | Vision runs in a worker. Position, suggest and heatmap searches run in a planner worker. Pre-allocated buffers. Backpressured frame submission | ✅ |
| V | Privacy by Architecture | No `fetch` in app code. The service worker caches the app shell only. Frames stay in memory, in workers | ✅ |
| VI | Player-First Language | `core/shot/coach.ts` maps physics to coaching phrases. Palette is Okabe–Ito with dash patterns. Virtual table works without a camera | ✅ |
| VII | Simplicity | Zero runtime deps. Layering enforced by folder and import direction (`core` imports nothing from `vision` or `app`) | ✅ |

Post-design re-check (after Phase 1): ✅ no violations. The Complexity Tracking table is empty.

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
│   ├── table-detect.ts         # Cloth model, mask, components, hull, quad line fit
│   ├── ball-detect.ts          # Rectify @ ball height, disk/ring score, NMS, classify
│   ├── tracker.ts              # Temporal smoothing + lock state
│   ├── pipeline.ts             # processFrame()
│   └── synth/render.ts         # Ray-traced synthetic table renderer (fixtures + fake camera)
├── workers/
│   ├── protocol.ts             # Versioned message types (contracts/worker-protocol.md)
│   ├── vision.worker.ts
│   └── planner.worker.ts
└── app/
    ├── main.ts                 # Bootstrapping, mode switch, wiring
    ├── store.ts                # Tiny observable app state
    ├── camera.ts               # getUserMedia + backpressured frame capture
    ├── settings.ts             # Persisted settings (guarded localStorage)
    ├── render/
    │   ├── palette.ts          # Okabe–Ito colours + dash styles
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

scripts/make-fake-camera.ts     # Renders synthetic table frames → tests/fixtures/table.y4m
public/                         # manifest.webmanifest, sw.js, icon.svg
index.html
```

**Structure Decision**: a single client-side project. Layering is enforced by directory: `core` has
no imports outside itself, `vision` may import `core` math only, `workers` adapt `core` and `vision`
to messages, and `app` owns everything DOM.

## Phase 0 — Research

See [research.md](./research.md). All Technical Context unknowns are resolved (decisions R-01 … R-12).

## Phase 1 — Design

- Entities and state machines: [data-model.md](./data-model.md)
- Interfaces: [contracts/core-api.md](./contracts/core-api.md), [contracts/worker-protocol.md](./contracts/worker-protocol.md)
- Validation scenarios: [quickstart.md](./quickstart.md)

## Complexity Tracking

No constitution violations. Nothing to justify.
