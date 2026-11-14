# CueSight Constitution

## Core Principles

### I. Physics Fidelity (NON-NEGOTIABLE)

Every recommendation shown to a player (aim, throw/squirt compensation, power, spin, path,
margin) MUST come from a model grounded in published billiards physics (Alciatore, Marlow,
Shepard, pooltool) or from a documented approximation of one.

- Every physical constant MUST be a named, configurable parameter with a default value and a
  source comment, or an explicit `ASSUMPTION:` note.
- Physics behaviour MUST be pinned by tests against analytic results: the 90° rule, the 30° rule,
  natural-roll height, throw and squirt magnitudes, rolling distance, and no energy gain.
- Inventing citations or fudge factors without a note is a constitution violation.

Rationale: players stop trusting a trainer after one confidently wrong shot.

### II. Honest Uncertainty

The product MUST show the player how confident it is. That means the margin of error in degrees,
a difficulty label, a detection-quality indicator, and visible warnings for an obstructed path, a
likely scratch, or poor table lock. When inputs are too poor to plan (table not locked, target not
visible), the UI MUST say so instead of drawing a plan.

Rationale: a wrong line drawn with confidence is worse than no line.

### III. Test-First, Deterministic Core

- Core math, physics, solver and vision algorithms MUST be pure, deterministic functions over plain
  data and typed arrays, with no DOM or timing dependencies.
- Tests MUST be written alongside or before the implementation and MUST pass before a task is marked
  done.
- Vision MUST be validated on synthetic, ray-traced table renders with known ground truth. The same
  renders feed end-to-end tests as a fake camera.

Rationale: real tables are not available in CI. Ground-truth fixtures make accuracy measurable.

### IV. Real-Time Performance Budget

- Overlay rendering MUST target ≥ 30 fps. Vision updates MUST target ≥ 10 Hz at the processing
  resolution.
- A shot plan MUST be recomputed in < 50 ms after any change. Position-play search MUST finish in
  < 1.5 s on a mid-range phone.
- Vision and search MUST run off the UI thread (Web Workers).
- Per-pixel and per-simulation-step loops MUST NOT allocate. They use pre-allocated typed arrays.

Rationale: an overlay that lags the camera feels broken and misleads aim.

### V. Privacy by Architecture

All processing MUST happen on-device. Camera frames MUST NOT be stored, uploaded or sent to any
network endpoint. The app MUST work offline after first load, with no account. Any future
telemetry would need a constitution amendment and explicit opt-in.

Rationale: pointing a camera around a bar or a home needs absolute trust.

### VI. Player-First Language and Accessibility

- Guidance MUST be phrased the way coaches speak: fractional aim, tips of english, speed words. SI
  values go in secondary detail.
- Overlays MUST use a colour-blind-safe palette with redundant encoding (dash patterns, labels).
- Touch targets MUST be ≥ 44 px. The full planner MUST work without a camera (demo table).

Rationale: the product is a coach, not a physics simulator.

### VII. Simplicity and Minimal Dependencies

- Prefer small, well-tested in-house code over heavyweight runtimes (no OpenCV/TF in v1).
- Every runtime dependency MUST be justified in `research.md`.
- Layers MUST depend one way only: `core` ← `vision` ← `workers` ← `app`.
- YAGNI: build the user story in front of you.

Rationale: a small bundle loads fast on bar Wi-Fi and keeps the codebase auditable.

## Technical Constraints

- Platform: an installable Progressive Web App on modern mobile browsers (iOS Safari 16+,
  Chrome/Android 110+) and desktop browsers.
- Language: TypeScript in strict mode. Build: Vite. Unit/integration tests: Vitest. End-to-end:
  Playwright (Chromium with a fake camera stream).
- Units: SI internally (metres, seconds, radians, kilograms). Table frame origin at the table
  centre, +x along the long rail, +y along the short rail.
- Every worker message MUST carry a `v` (protocol version) field and be defined in `contracts/`.
- Initial gzip JS bundle budget: < 250 KB.

## Development Workflow & Quality Gates

- Spec Kit flow is mandatory for features: constitution → specify → clarify → plan → tasks →
  analyze → implement.
- Gate 1 (pre-plan): the spec has no unresolved `[NEEDS CLARIFICATION]` markers and the
  requirements checklist passes.
- Gate 2 (plan): the Constitution Check table is all-pass, or every violation is justified in
  Complexity Tracking.
- Gate 3 (merge): `npm run typecheck`, `npm test` and `npm run e2e` pass. Tasks are marked `[X]`.
  The README is updated for user-visible changes.
- Commits are small and scoped to a task or story slice.

## Governance

This constitution overrides ad-hoc preferences. Amendments require a PR that edits this file,
states the version bump with rationale, and updates any affected templates and specs.

Versioning: semantic (MAJOR = principle removed or redefined; MINOR = principle or section added;
PATCH = wording). Every plan's Constitution Check MUST cite the principles by number. Reviewers
MUST reject changes that violate a principle without a documented justification.

**Version**: 1.0.0 | **Ratified**: 2026-11-14 | **Last Amended**: 2026-11-14
