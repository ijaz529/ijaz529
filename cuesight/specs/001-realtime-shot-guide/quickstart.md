# Quickstart & Validation Scenarios: Real-Time Shot Guide

## Run

```bash
cd cuesight
npm install
npm run dev            # http://localhost:5173 — open on a phone on the same network via --host
npm run typecheck
npm test               # unit + integration (Vitest)
npm run fixtures       # renders tests/fixtures/table.y4m (fake camera) and the Snap fixtures
npm run e2e            # fixtures + build + Playwright: virtual table + fake camera (+ the 002 specs)
npm run build          # production PWA into dist/
```

To use a real phone: run `npm run dev -- --host`, then open the HTTPS tunnel or LAN URL. Camera
access requires HTTPS or localhost. Or deploy `dist/` to any static host.

## Validation scenarios (map to spec acceptance criteria)

| # | Scenario | How to verify | Spec ref |
|---|---|---|---|
| Q1 | Straight-in shot | Virtual table → *Straight-in* preset → tap OB, tap pocket. Card shows cut 0.0°, "full", throw 0.0° | US1-AS1 |
| Q2 | Tangent line | *30° cut* preset with stun selected. Dashed CB line leaves ~90° to the OB path. Tip mentions the tangent line | US1-AS2 |
| Q3 | 30° rule | Same preset, tap "Follow" on the spin pad. CB deflection ≈ 34°. Tip mentions the 30° rule | US1-AS3 |
| Q4 | Blocked | Drag a ball onto the aim line. "Blocked by …" warning | US1-AS4 |
| Q5 | Scratch | Line up a straight shot into a corner with follow and high power. Scratch warning | US1-AS5 |
| Q6 | Live camera | `npm run e2e` runs `camera.spec.ts`: fake camera → "Locked" → balls detected → plan drawn | US2-AS1/2 |
| Q7 | Manual calibration | Camera mode → *Calibrate* → tap 4 corners → "Corners set — checking…" → "Calibrated from your four corners." once a result confirms them → locked. Four taps that can't form a table (three on one rail, two on one spot) are refused at once ("Those four taps aren’t the cloth corners — tap them again.") and calibrate mode stays on. Taps off the cloth corners give the same words; an unreadable cloth "Couldn’t tell the cloth from its surroundings — tap the 4 cloth corners again, or use Snap."; a later camera move "The phone moved — recalibrate, or tap Calibrate to go back to automatic detection." The target stays on its ball (`camera.spec.ts`) | US2-AS3, FR-003 |
| Q8 | Freeze | Camera mode → *Freeze* → layout persists on the mini-map | US2-AS4 |
| Q9 | Camera denied | Block camera permission → "Camera unavailable" message and a *Practice table* button. A touch device with no camera starts in Practice. If only table detection fails, the title reads "Table detection is off" with *Try again* (`camera.spec.ts`) | US2-AS5, FR-027 |
| Q10 | Draw/follow | Move the tip below then above centre. CB path reverses, then follows | US3-AS1 |
| Q11 | Too soft | Power 1 on a long shot. "Too soft" warning | US3-AS4 |
| Q12 | Suggest | *Suggest* → up to 3 ranked shots in < 2 s. No blocked shots | US4 |
| Q13 | Position | *Position* → tap a spot. Recommended stroke. Rest marker near the spot (≤ 15 cm when reachable) | US5-AS1 |
| Q14 | Heatmap | *Zones* → choose the next ball. Coloured zones drawn | US5-AS3 |
| Q15 | Offline | Build + preview, load once, go offline, reload. App works. Automated by `tests/e2e/offline.spec.ts` (zero external requests, then an offline reload) | FR-025, FR-026 |
| Q16 | Mark the cue ball | Camera mode → *Cue ball* (the hint reads "Tap the cue ball.") → tap the white ball. The toast says "Cue ball set." and the plan is redrawn from that ball, live or on a frozen layout. The frozen case is automated in `camera.spec.ts` | FR-007 |
| Q17 | Cue ball not identified | Fake camera or real table with two whites side by side, or none. No ball is marked as the cue ball. The hint reads 'No cue ball found — tap “Cue ball”, then tap the cue ball.' (two whites: 'Two white balls — tap “Cue ball”, then tap the one you play with.'). Tapping an object ball keeps it as the target and asks for the cue ball first | Edge case "Cue ball not found" |
| Q18 | Frozen cue ball | Practice table: drag the cue ball against the object ball, with the line of centres a few degrees off the pocket. "Frozen" warning with a stroke angle. On a snooker preset: "Not makeable … push stroke" | Edge case "cue ball touching" |
| Q19 | Rail return (automated) | `tests/unit/core/collide.test.ts`: a ball rolling at 1 m/s from 0.3 m before the foot cushion comes back at least 1.0 m. Draw and stun come off a rail within 0.05 m/s of each other | FR-014, research.md R-08 |
| Q20 | Rotate keeps the selection | Camera mode, a locked table with a target → *Rotate* → *Rotate* again. "Kept your selection." and the target is the same ball. A single Rotate of a correctly detected table finds no balls: after 15 results "The selection was cleared: the table frame changed." (`camera.spec.ts`) | FR-003 |
| Q21 | Lock gate | Camera mode: while the pill reads "Table found — hold steady" no plan is drawn; it appears once "Table locked" shows, and survives one missed outline. A corner pocket off screen reads "Table locked — a corner pocket is out of view" | FR-023, Constitution II |

## Accuracy self-check

`npm test -- vision` prints per-scene corner and ball-position errors. Compare them with the
targets in `contracts/core-api.md`.

On `fix2b/app` (2026-11-15; the README's "Test status" line is the one place the release updates),
`npx vitest run` gives 887 tests in 61 files: 881 pass and 6 fail. The failures are the
touching-cluster and 4:2:0 corner-pair cases in `ball-detect-edge.test.ts` (analysis.md
"Post-review"), pending the vision branch. On the release branch those 6 cases pass (T074, analysis.md
"Post-vision merge"): 1052 tests in 69 files, all passing. `npm run e2e` runs 141 tests. Timing tests can fail when
the CPU is shared. Re-run a failing timing test on its own before concluding.
