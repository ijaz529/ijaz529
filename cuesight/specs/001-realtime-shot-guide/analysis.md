# Specification Analysis Report: Real-Time Shot Guide

`/speckit-analyze` cross-artifact pass, run after implementation (2026-11-14).
Artifacts checked: spec.md, plan.md, research.md, data-model.md, contracts/, tasks.md, constitution
v1.0.0, and the code and tests.

## Findings

| ID | Category | Severity | Location | Summary | Resolution |
|---|---|---|---|---|---|
| A1 | Inconsistency | MEDIUM | spec.md US1-AS2, SC-004 | The original "within 1° of the tangent line" contradicted the implemented (realistic) restitution e = 0.95. Real balls deviate 1–4° | **Fixed**: the spec now states 1° for ideal balls and ≤ 4° for real balls. Tests cover both |
| A2 | Drift | LOW | plan.md structure | `vision/calibration.ts`, `app/drills.ts` and `scripts/screenshots.cjs` were added during implementation | **Fixed**: added to the plan tree |
| A3 | Drift | LOW | research.md R-11 | The speed penalty was strengthened after UX review (it recommended power 9) | **Fixed**: R-11 now documents the quadratic penalty above power 6 |
| A4 | Drift | LOW | data-model.md DetectedBall | New fields `white` and `px`, plus the 1.7 R de-duplication rule | **Fixed** |
| A5 | Coverage gap | MEDIUM | SC-003 | Accuracy is verified only on synthetic renders, not on real tables | **Open**: roadmap item 1 (real-table dataset). Disclosed in README "Known limitations" (Principle II) |
| A6 | Coverage gap | MEDIUM | SC-001, SC-006 | "First plan within 30 s" and "90 % of players understand the card" need on-device user testing | **Open**: needs a usability session with real players |
| A7 | Coverage gap | LOW | SC-002 | 30 fps overlay and ≥ 10 Hz vision are verified in Node and headless Chromium (~40–60 ms/frame), not yet on a mid-range phone | **Open**: device benchmark |
| A8 | Underspecification | LOW | FR-020 | "Most reliable stroke" is defined in research.md R-11 (worst case over ±12 % speed), not in the spec | Accepted: it's an implementation detail of a testable requirement |

There are no CRITICAL findings and no constitution violations.

## Requirement → task → test coverage

| Requirement | Tasks | Verified by |
|---|---|---|
| FR-001 presets | T009, T064 | `table.test.ts` |
| FR-002 auto table detection | T040 | `table-detect.test.ts` (3 cloths × 4 poses) |
| FR-003 manual calibration, axis swap | T041, T051 | `pipeline.test.ts` (manual corners), `homography.test.ts` |
| FR-004 balls, cue, parallax | T043 | `ball-detect.test.ts` (median ≤ 4.1 mm) |
| FR-005 smoothing and quality | T045 | `tracker.test.ts` |
| FR-006 freeze | T051 | `camera.spec.ts` |
| FR-007 mark cue ball | T051 | manual (quickstart) |
| FR-008 practice table | T033 | `virtual.spec.ts` |
| FR-009 tap ball/pocket, auto pocket | T029, T033, T051 | `planner.test.ts`, e2e |
| FR-010 aim geometry | T023–T024, T029 | `geometry.test.ts`, `pocket-window.test.ts` |
| FR-011 throw and squirt | T012, T029 | `analytic.test.ts`, `simulate.test.ts`, `planner.test.ts` |
| FR-012 power ≥ minimum | T026, T029 | `planner.test.ts` (minPower, too-soft) |
| FR-013 spin within miscue limit | T014 | `strike.test.ts` |
| FR-014 cue-ball path | T017, T029 | `simulate.test.ts`, `stroke-override.test.ts` |
| FR-015 margin and difficulty | T027, T029 | `planner.test.ts` |
| FR-016 warnings | T029 | `planner.test.ts` (blocked, scratch, not-makeable, too-soft) |
| FR-017 coaching tip | T027 | `planner.test.ts`, `virtual.spec.ts` (90° and 30° rules) |
| FR-018 overrides | T055–T056 | `stroke-override.test.ts`, `virtual.spec.ts` |
| FR-019 suggestions | T057–T059 | `suggest.test.ts`, `virtual.spec.ts` |
| FR-020/021 position play | T060–T063 | `position.test.ts`, `perf.test.ts` |
| FR-022 heatmap | T061, T063 | `position.test.ts` |
| FR-023 perspective overlay | T050 | `camera.spec.ts`, screenshots |
| FR-024 colour-blind-safe palette | T030 | design review (Okabe–Ito plus dash patterns) |
| FR-025 on-device only | T048–T049 | offline check: 0 external requests |
| FR-026 offline and installable | T004, T065 | offline reload verified |
| FR-027 camera-denied fallback | T051 | `camera.spec.ts` |
| FR-028 tunable physics | T010, T064 | `settings.ts` → `physicsFor` |

## Metrics

- Requirements: 28 FR and 8 SC.
- FR coverage: 28/28 have tasks, and 26/28 have automated tests. FR-007 and FR-024 are verified manually
  or by design review.
- Tasks: 69/69 done.
- Tests: 98 unit/integration and 5 e2e, all passing.
- Open items: A5–A7 (real-world validation), which need hardware and people, not code.
