# Specification Quality Checklist: 3D Table, Two-Photo Snap Guide, Polished UI and iOS App

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-11-14
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs). See note 1 for the named platforms
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded (an explicit Out of Scope section)
- [x] Dependencies and assumptions identified (Apple membership, App Store Connect record, macOS runners)

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows (3D study, two-photo guide, look and feel, iOS delivery)
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Constitution alignment (pre-plan, Gate 1)

- [x] Principle I: no new physics. Replay rotation and the strike point are derived from the 001 model (FR-108, FR-117)
- [x] Principle II: the player-photo fit reports confidence and reasons and never draws an untrusted guide as if it were right (FR-116, FR-118, SC-107)
- [x] Principle III: the player-photo fit and replay timing are verified on synthetic ground truth (SC-103, SC-106)
- [x] Principle IV: frame and latency budgets are stated (SC-101, SC-105, SC-109)
- [x] Principle V: photos stay in memory, nothing leaves the device, the iOS app makes no requests (FR-122, FR-132, SC-114)
- [x] Principle VI: player language for strike and power; redundant encodings; ≥ 44 px targets; full 2D fallback (FR-117, FR-130, FR-110)
- [x] Principle VII: zero runtime npm dependencies kept (SC-112)

## Notes

1. The spec names WebGL2, iOS, the iOS Simulator, WebKit and TestFlight. These are delivery targets
   the user asked for by name ("in 3d", "run the app on a simulator", "send to testflight"), not design
   choices. How they are met is left to plan.md and research.md. `?renderer=2d` (FR-110) and
   `data-mode` (FR-125) are kept on purpose. They are test hooks that end-to-end tests depend on (the
   second one already exists in 001).
2. Iteration 1 found three issues, all fixed:
   1. FR-108 originally said "realistic rotation". It now says *no slip while rolling* (MUST, which
      SC-103 measures as slip < 1 % of speed) and the slide-to-roll transition (SHOULD, research R-17
      level 2).
   2. FR-118 originally said "fallback when the fit is bad". It now names the trigger (failure or
      confidence below the threshold) and the exact fallback (tap the cue ball and the target).
   3. SC-106 originally said "accurate on most photos". It now states the scene envelope (height,
      distance, yaw, field of view), the success rate (≥ 90 %) and both tolerances.
3. Ten clarifications were resolved with the feature defaults. They are recorded under
   `## Clarifications` in spec.md.
4. SC-110 (first-use Snap in < 60 s) needs a usability session with real players, as 001 SC-006 did.
   It cannot be automated and is tracked as an open item for `/speckit-analyze`.
