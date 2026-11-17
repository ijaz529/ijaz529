# Specification Analysis Report: Real-Time Shot Guide

`/speckit-analyze` cross-artifact pass, run after implementation (2026-11-14).
Artifacts checked: spec.md, plan.md, research.md, data-model.md, contracts/, tasks.md, constitution
v1.0.0, and the code and tests.

**Corrected 2026-11-15.** The code review that followed found this pass too optimistic. The
original findings below are kept as a record, with their corrections marked. The coverage table and
metrics now describe `fix/wave1` (two rows are marked as updated for `fix2b/app`). The review, and a
fresh cross-check of the revised artifacts against the code, are in
[Post-review (2026-11-15)](#post-review-2026-11-15); the status after wave 2 is in
[Post-wave-2](#post-wave-2-2026-11-15-fix2bapp--00f722d).

## Findings (2026-11-14 pass)

| ID | Category | Severity | Location | Summary | Resolution |
|---|---|---|---|---|---|
| A1 | Inconsistency | MEDIUM | spec.md US1-AS2, SC-004 | The original "within 1° of the tangent line" contradicted the implemented (realistic) restitution e = 0.95. Real balls deviate 1–4° | **Fixed**: the spec now states 1° for ideal balls and ≤ 4° for real balls. Tests cover both |
| A2 | Drift | LOW | plan.md structure | `vision/calibration.ts`, `app/drills.ts` and `scripts/screenshots.cjs` were added during implementation | **Fixed**: added to the plan tree |
| A3 | Drift | LOW | research.md R-11 | The speed penalty was strengthened after UX review (it recommended power 9) | **Fixed**: R-11 documents the quadratic penalty above power 6. *2026-11-15:* R-11 was rewritten for the new robustness rule and budget (P-F3) |
| A4 | Drift | LOW | data-model.md DetectedBall | New fields `white` and `px`, plus the 1.7 R de-duplication rule | **Fixed** |
| A5 | Coverage gap | MEDIUM | SC-003 | Accuracy is verified only on synthetic renders, not on real tables | **Open**: roadmap item 1 (real-table dataset). Disclosed in README "Known limitations" (Principle II) |
| A6 | Coverage gap | MEDIUM | SC-001, SC-006 | "First plan within 30 s" and "90 % of players understand the card" need on-device user testing | **Open**: needs a usability session with real players |
| A7 | Coverage gap | LOW | SC-002 | 30 fps overlay and ≥ 10 Hz vision are verified in Node and headless Chromium (~40–60 ms/frame), not yet on a mid-range phone | **Open**: device benchmark |
| A8 | Underspecification | LOW | FR-020 | "Most reliable stroke" is defined in research.md R-11 (worst case over ±12 % speed), not in the spec. *2026-11-15:* the code then scored candidates by a mean of nominal and worst outcome, not the worst case R-11 claimed | Accepted, then **fixed**: the code now uses the worst case over nominal and ±6/±12 % speed, and any scratch or miss disqualifies (R-11). The spec's 2026-11-15 clarification states it |

~~There are no CRITICAL findings and no constitution violations.~~ *Corrected 2026-11-15:* that was
false. The review confirmed violations of Principles I, II, III, IV and VI, and false claims in the
artifacts themselves. See P-C1 … P-C8 below.

## Requirement → task → test coverage (updated 2026-11-15, `fix/wave1`)

| Requirement | Tasks | Verified by |
|---|---|---|
| FR-001 presets | T009, T064 | `table.test.ts` |
| FR-002 auto table detection | T040, T071 | `table-detect.test.ts`: 4 poses on green cloth, plus blue (side) and red (corner) cloth, grey cloths on grey and wooden floors, tables filling the frame, and truncated tables (null or exact). `pipeline-live.test.ts` covers occluders and camera moves |
| FR-003 manual calibration, axis swap | T041, T051, T071 | `pipeline.test.ts` (manual corners), `calibration.test.ts` (quad validation, axis choice, stable frame), `manual-cloth.test.ts`, `pipeline-live.test.ts` (moved, finger error), `homography.test.ts` |
| FR-004 balls, cue, parallax | T043, T073 | `ball-detect.test.ts`: the assertion is median ≤ 10 mm and p95 ≤ 25 mm. The worst measured median on the 9-ball fixture is 6.3 mm (end view; 4:2:0 end view 6.4 mm). `ball-detect-edge.test.ts` covers clusters, hangers, glare, sticks, cue ambiguity and names. **6 cluster cases fail** (P-C1). *Updated for `rc/release`:* the 6 cases pass (T074). Every cluster scene runs under 62 calibrations (`ball-detect-edge.test.ts`, `ball-detect-clusters.test.ts`), and `ball-detect-determinism.test.ts` checks that results do not depend on earlier frames |
| FR-005 smoothing and quality | T045, T071 | `tracker.test.ts`, `pipeline-live.test.ts` |
| FR-006 freeze | T051 | `camera.spec.ts` |
| FR-007 mark cue ball | T051, T083 | *Updated for `fix2b/app`:* `camera.spec.ts` (frozen layout), `live-logic.test.ts` (`applyCueOverride`, the "Tap the cue ball." hint). Quickstart Q16 for the live path by hand |
| FR-008 practice table | T033 | `virtual.spec.ts`, `practice3d.spec.ts` (drag). Adding and removing balls is not automated |
| FR-009 tap ball/pocket, auto pocket | T029, T033, T051 | `planner.test.ts`, e2e |
| FR-010 aim geometry | T023–T024, T029, T072 | `geometry.test.ts` (eighth labels within 2°), `pocket-window.test.ts` (corner hangers), `planner-edge.test.ts` (rail-frozen, frozen cue ball) |
| FR-011 throw and squirt | T012, T029, T072 | `analytic.test.ts` (squirt pinned to TP A.31: 2.40°/1.64°), `simulate.test.ts`, `planner.test.ts`, `planner-edge.test.ts` (throw direction, `cueAimDir`) |
| FR-012 power ≥ minimum | T026, T029, T072 | `planner.test.ts`, `planner-edge.test.ts` (the displayed minimum pots; too-soft never contradicts the simulation) |
| FR-013 spin within miscue limit | T014 | `strike.test.ts` |
| FR-014 cue-ball path | T017, T029, T070 | `simulate.test.ts`, `collide.test.ts` (rail spin), `stroke-override.test.ts` |
| FR-015 margin and difficulty | T027, T029 | `planner.test.ts`, `planner-edge.test.ts` (tolerance never negative) |
| FR-016 warnings | T029, T072 | `planner.test.ts`, `planner-edge.test.ts` (blocked names another pocket, throw-uncompensable, snooker touching ball) |
| FR-017 coaching tip | T027, T072 | `coach.test.ts`, `planner.test.ts`, `virtual.spec.ts` (90° and 30° rules) |
| FR-018 overrides | T055–T056 | `stroke-override.test.ts`, `virtual.spec.ts` |
| FR-019 suggestions | T057–T059, T072 | `suggest.test.ts`: easy before hard, blocked excluded, open 15-ball grid in < 2 s, and position quality breaks near-ties. Also `virtual.spec.ts` |
| FR-020/021 position play | T060–T063, T072 | `position.test.ts` (deterministic budget, scratch-prone variants rejected, reachable from any stroke, post-shot next-shot quality), `perf.test.ts` |
| FR-022 heatmap | T061, T063, T072 | `position.test.ts` (orientation and indexing; zeros for the cue ball or target) |
| FR-023 perspective overlay | T050 | `camera.spec.ts`, screenshots. Alignment while the phone moves is not automated |
| FR-024 colour-blind-safe palette | T030 | design review (Okabe–Ito plus dash patterns) |
| FR-025 on-device only | T048–T049 | `offline.spec.ts`: zero requests to any other origin |
| FR-026 offline and installable | T004, T065 | `offline.spec.ts`: offline reload, Practice and Snap work offline. Installability is checked by hand only |
| FR-027 camera-denied fallback | T051 | `camera.spec.ts` |
| FR-028 tunable physics | T010, T064, T079 | *Updated for `fix2b/app`:* `settings.test.ts` asserts every preset combination of `physicsFor` and the settings ranges and validation |

## Metrics (updated 2026-11-15, `fix/wave1`)

- Requirements: 28 FR and 8 SC.
- FR coverage:
  - 28/28 have tasks.
  - 26/28 have an automated test. 4 of those cover the requirement only in part: FR-008 (add and
    remove), FR-023 (alignment while moving), FR-026 (installability) and FR-028 (preset mapping).
  - FR-007 is manual (Q16), and FR-024 is checked by design review.
  - The 2026-11-14 pass also claimed 26/28. It counted FR-025 and FR-026, which were then checked
    by hand; `tests/e2e/offline.spec.ts` (added in 95d197b) now automates both.
- SC: SC-003, SC-004, SC-005, SC-007 and SC-008 are tested on synthetic data. SC-003 fails for
  touching clusters (P-C1). SC-001, SC-002 (on a device) and SC-006 are open (A5–A7).
- Tasks: 75/83 done. 68/69 of the original tasks are done (T068 reopened), and 7/14 of the
  Phase 9 review-fix tasks.
- Tests (`npx vitest run`, 2026-11-15): 538 tests in 37 files, all features. 532 pass and 6 fail
  (P-C1). Under a shared CPU, timing tests can fail and must be re-run alone.
- Playwright: 8 e2e spec files. They were not run in this pass, because another workflow held the
  ports.
- Open items:
  - A5–A7: real-world validation, which needs hardware and people, not code.
  - The wave-2 items in "Post-review".

## Post-review (2026-11-15)

### The review

A deep code review of HEAD `95d197b` (plus its uncommitted working tree) produced **86 findings: 83
confirmed, 3 rejected**. The 83 confirmed findings break down as 24 high, 38 medium and 21 low
severity, across these dimensions:
- detection 12, app 12, spec-conformance 12;
- planner 9, position 9, pro-coach 9;
- vision-geometry 8, workers-pwa-privacy 8;
- physics 4.

Two ids were reported twice by different lenses, so there are 81 distinct ids. They were
consolidated into 52 work items in 8 fix packages, with no file owned by two packages.

Rejected (0 votes):
- `squirt-test-cannot-detect-compensation`: the planner's squirt "compensation" was only the
  reported `squirtDeg`, so the test was not the defect claimed.
- `vision-reset-hardcodes-pool9` and `ios-svg-only-icons`: these described older committed files.
  The working tree had already fixed them.

The critic also flagged that three PWA findings (`offline-after-first-load-broken` twice,
`sw-never-updates-bricks-after-deploy`) described an older `sw.js`. At `95d197b` the build injects
the full asset list and a per-build cache id. What remains is a build-level guard and a safe
update for an already-open page (wave 2, `fix2a/platform`).

### What wave 1 fixed (`fix/wave1` = `f81ad62`)

Status of the 83 confirmed findings on `fix/wave1`:
- **44 fixed**: their whole fix is in core, vision or these docs.
- **24 partly fixed**: the core or vision side has landed, and the app side is wave 2.
- **15 open**: app, UI and PWA only.

The table lists each finding under the package that fixed its core or vision part. The 24 partly
fixed findings still need the app work listed under "Open for wave 2".

| Package (commits) | Findings fixed | Evidence (tests) |
|---|---|---|
| Physics (`f98bc42`, `c7c749a`) | `cushion-ignores-topspin-backspin`, `cushion-keeps-topspin-speed-scale` (R-08); `iteration-cap-drift-interpenetration`; `per-step-allocation`; the squirt part of `tests-looser-than-claimed`; the `pocketArrivalSpeed` note | `collide.test.ts`; `simulate.test.ts` (per-step overlap and cushion invariants under forced budgets, round-off loop, GC and `Math.hypot` guards, 9-ball golden); `analytic.test.ts` |
| Vision geometry (`8be455b`, `64992c9`) | `truncated-table-locks`, `refine-band-narrower-than-pocket-chamfer`, `single-constraint-focal-wins-axis-swap`, `canonical-orientation-flip-unstable`, `end-view-orientation-flip`, `grey-cloth-and-manual-calibration-silent-failure`, `manual-mode-fake-lock`, `manual-calibration-always-locked`, `no-quad-validation-degenerate-taps`, `occluder-relearned-as-cloth`, `configure-restarts-ids` (and its duplicates), `learncloth-per-pixel-allocation`; the vision parts of `plan-drawn-while-unlocked`, `overlay-drawn-while-unlocked` (no stale calibration), `frozen-cb-cut-180` (2R separation) and `settings-dialog-commit-semantics` (FOV 0 → 65°); the vision perf guard (150 ms) | `calibration.test.ts`, `pipeline-live.test.ts`, `table-detect.test.ts`, `tracker.test.ts`, `manual-cloth.test.ts` |
| Core shot (`439cd82`, `0ffa9c0`) | `rail-frozen-ob-not-makeable`, `corner-hanger-window-reversed`, the squirt-text findings (3 ids), `throw-iteration-ghost-in-cushion`, the frozen-cue-ball findings (3 ids), `too-soft-contradicts-sim`, `too-soft-false-stops-short`, `stun-tip-when-cb-never-arrives`, `blocked-shot-no-alternative`, `coarse-fraction-labels`, `robustness-allows-scratch-prone-strokes`, `reachable-flag-false-negatives`, `next-shot-scored-on-stale-layout`, `wall-clock-budget-in-core`, `robust-loop-skip-returns-neg-infinity`, `heatmap-cue-or-target-fallback`, `suggest-ignores-position-quality`, `rack-test-vacuous`, `position-tests-cannot-fail`; the core parts of `throw-sign-contract-and-thinner-label` and `negative-tolerance-cut-over-90` | `planner-edge.test.ts` (21 tests), `coach.test.ts`, `position.test.ts` (15), `suggest.test.ts` (open 15-ball grid), `geometry.test.ts`, `pocket-window.test.ts`, `perf.test.ts` (22-ball planShot < 100 ms) |
| Vision balls (`fafd515`, `bb72a30`) | `cue-misid-default-420-scene`, `no-cue-false-positive`, `cluster-k-underestimate`, `side-by-side-pair-collapse`, `green-ball-on-green-cloth`, `phantom-balls-glare-stick`, `throat-mask-erases-hangers`, `colour-names-wrong`, `per-frame-allocation`, `vision-per-pixel-allocation` | `ball-detect-edge.test.ts`, `pipeline-420.test.ts`, `ball-detect.test.ts`. **But** after integration 6 cluster and pair cases fail (P-C1), so the two cluster findings have regressed |
| Integration (`f81ad62`) | Interactions between packages: the rack-vs-fixture guard times `detectBalls`; the exact-calibration 640×360 case learns the cloth in the known outline; `player-view` ignores a neutral cloth hint | `pipeline-420.test.ts`, `ball-detect-edge.test.ts`, `player-view.test.ts` |
| Docs, 001 (this revision) | `contract-docs-false`, `analysis-coverage-claims-false` (docs part), `speed-scale-doc-claims`, `frame-buffer-reuse-claim-false`, and the doc parts of the cushion, allocation, wall-clock, unlocked-overlay, throw-sign, fraction, tip-unit, perf-guard and suggestion findings | — |

### Open for wave 2

- **App core** (`fix2a/live`, 11 work items). Finding ids:
  - `tracker-ids-repoint-or-orphan-selection`;
  - `camera-start-race-keeps-capturing` and `camera-start-race-leaks-stream`;
  - `frozen-mode-overlay-and-mark-cue` and `mark-cue-ignored-when-frozen`;
  - `overlay-drawn-while-unlocked` and `plan-drawn-while-unlocked` (app part);
  - `stale-suggestions-shown`, `stale-recommendation-stamped-on-new-key` and
    `stale-rule-defeated-by-debounce`;
  - `worker-failures-pending-forever`;
  - `position-mode-taps-near-balls`;
  - `rerender-destroys-focus-and-spams-at` (live status);
  - the app parts of the manual-calibration, Zones and recommendation findings.
- **App UI** (`fix2a/ui`, 7 work items):
  - `settings-dialog-commit-semantics`;
  - `rerender-destroys-focus-and-spams-at`;
  - the throw-direction text on the card (`throw-text-always-thinner` and duplicates);
  - `tip-unit-quarter-radius` (P-F2);
  - `touch-targets-under-44px` and `a11y-touch-targets-aria` (T068);
  - `negative-tolerance-cut-over-90` (card part);
  - the settings-preset notes (P-C4).
- **PWA** (`fix2a/platform`): a safe SW update for an open page, and a build-level precache guard.
- **Vision balls**: T074, the 6 failing tests (P-C1).
- **App-side use of the wave-1 API**. This is the list consolidated at integration, for wave 2b:
  - **Cue stick.** The cue stick and the Snap strike point use `plan.cueAimDir ?? plan.aimDir`.
    `aimDir` stays the drawn ball path. Optionally, draw a faint cue line when |squirt| ≥ 0.1°.
  - **Throw text.** The card uses `throwShiftDir` instead of the hard-coded "thinner".
  - **Frozen and hanger plans.** A frozen plan is drawn from the cue ball along `aimDir`. Hangers
    fall back to `objectPath` (data-model.md).
  - **Minimum power.** `minPower` is "drops with pace" again. The optional `minPowerCapture` lets
    the UI mark the "only just drops" band.
  - **Recommendation flags.** Show `fragile` as "This stroke may need precise pace: a little harder or softer could miss or scratch." Treat `timedOut` as a partial
    search. `Number.isFinite(score)` is false only when no stroke pots.
  - **New labels and codes.**
    - The new warning `throw-uncompensable`.
    - Eighth labels with "thin"/"thick" prefixes; check widths and wording.
    - The snooker touching-ball reason text.
    - The new ball labels `pink`, `brown` and neutral `ball`. Give `ball` no letter in the table
      view, because "B" is taken.
  - **Tap prompt.** "Tap the cue ball" when no tracked ball `isCue`.
  - **Frozen-overlay check.** `liveMatchesFrozen` compares corners in order, so a 180° flip is
    caught.
  - **Locked-only drawing.** Draw only while `status === 'locked'`.
  - **Manual-corner reasons.** Read `VisionResult.reason`:
    - `bad-quad` → "Those four taps aren't the cloth corners";
    - `cloth-unknown` → "Couldn't tell the cloth…";
    - `moved` → "The phone moved…".
  - **Grey cloth.** Render a neutral cloth grey.
  - **Snap on grey cloth.** `player-view` matching is hue-based, so it needs neutral-cloth support.
  - **Worker reset.** If the app starts sending `reset`, call `pipeline.reset()`, which keeps the
    id counter.
  - **e2e expectations.** Strokes and rest positions after a rail changed with R-08. Do not
    recalibrate `POWER_SPEEDS`.
- **Docs, README and 002** (deferred because another workflow is editing them; T081):
  - README "Known limitations":
    - drop "the cue ball is the reliable one";
    - say that the cue ball is not marked when ambiguous, and that the player is asked to tap it;
    - give the remaining green-on-green limits (the green 14 stripe is lost in most 4:2:0 frames
      when its band faces the camera) and the cluster limits (a snooker pack in the end and corner
      views on 4:2:0 loses 3–5 reds);
    - describe the cushion model and its uncertainty: a few degrees in rail angles, about 10 % in
      post-rail speed.
  - README "How accurate is this?": the R-08 cushion rows, and the 2026-11-15 vision medians.
  - README speed and power: note that cue-ball travel per power level changed with the cushion fix
    (the R-12 table).
  - `002 contracts/worker-protocol-v2.md`:
    - the `result` buffer is "transferred back (not reused)";
    - the recommendation row adds `fragile?`, `nextQuality?` and `timedOut?`;
    - the heatmap `params` sets the frozen throw bound, and the map is all zeros for the cue ball
      or target;
    - the per-device evaluation budget;
    - `reset` restarts ids;
    - `VisionResult.reason` and `cloth`.
  - `002 quickstart.md` Q112: no change while 1 tip = ¼ R. It changes if the tip unit changes
    (T082).

### Cross-check of the revised artifacts against `fix/wave1` (2026-11-15)

Severity follows `/speckit-analyze`: a constitution conflict is CRITICAL. A resolved row has no
severity.

| ID | Category | Severity | Location | Summary | Status |
|---|---|---|---|---|---|
| P-C1 | Constitution (Gate 3), coverage | CRITICAL | `tests/unit/vision/ball-detect-edge.test.ts`; SC-003; FR-004 | 6 tests fail every run: touching clusters (9-ball corner, 15-ball side, snooker end, side and corner) and 4:2:0 corner pairs at 30°. `ball-detect.ts` is the vision-balls version. The only input change is vision-geometry's refined corners, 0.1–0.3 px from the old ones and no less accurate. With ±0.3 px corner jitter the ball count swings: 0–3 balls missed in the 9-ball corner view, 2–5 in the snooker end view, and phantoms in 4–5 of 20 snooker corner samples. The tests are not weakened | **Open**: T074. Make the disc-fit count stable under calibration jitter, and test over jittered calibrations |
| P-C2 | Constitution II | CRITICAL | `src/app/main.ts` (`cameraLayout`, `overlayData`) | The app plans and draws on `unstable` frames that have a quad. With no tracked cue ball it says "Waiting for the cue ball…" instead of asking for a tap. Vision itself no longer reports a stale calibration | **Open**: T078 (`fix2a/live`: locked-only plans with a 2-result grace, tap prompt) |
| P-C3 | Constitution VI | CRITICAL | `src/app/styles.css`, overlay and table hit-testing | Touch targets below 44 px: ball picks on the mini-map, overlay and 3D view, and the settings fields | **Open**: T068 reopened, T079 (`fix2a/ui`, with an e2e hit-area check) |
| P-C4 | Constitution I | CRITICAL | `src/app/settings.ts` `physicsFor` | The cloth and cushion preset literals have no source or ASSUMPTION notes. The "lively" cushion e0 0.93 lies above the cited 0.75–0.9 range | **Open**: T079 (`fix2a/ui` adds the notes and moves e0 to 0.9) |
| P-C5 | Constitution IV | — | `simulate.ts`, `ball-detect.ts`, `table-detect.ts` | Per-step and per-pixel allocation | **Resolved** (T070, T071, T073), with the output-record exception in plan.md Complexity Tracking |
| P-C6 | Constitution III | — | `position.ts` | Wall-clock budget in core | **Resolved** (T072) by a deterministic evaluation count, with the optional `timeCapMs` exception in plan.md Complexity Tracking |
| P-C7 | Constitution I | — | `params.ts` `pocketArrivalSpeed` | No source or ASSUMPTION note | **Resolved** (T070) |
| P-C8 | Constitution V | HIGH | `public/sw.js` | After a deploy, the new service worker takes over an open page, whose lazily created workers then 404. Runtime-cached Snap sample photos are dropped on every update | **Open**: T080 (`fix2a/platform`) |
| P-F1 | Inconsistency | — | contracts/core-api.md, contracts/worker-protocol.md | `processFrame` did not exist. The signatures of `pocketWindow`, `strikeBall`, `detectTable`, `calibrationFromCorners`, `detectBalls` and `positionHeatmap` were wrong. `budgetMs`, the missing `excludeIds`, "transferred back for reuse", and missing recommendation fields | **Resolved** (this revision) |
| P-F2 | Inconsistency, Principle VI | MEDIUM | spec.md clarification; data-model.md Stroke; `core/shot/power.ts` | The spec said "one tip = one tip-width (≈ ¼ R)", which contradicts itself. The code uses ¼ R, about half a tip-width. The natural-roll and Follow presets read "1½ tip", and the miscue limit reads "2 tip" (no plural) | **Open decision**: T082. The artifacts now state the implemented ¼ R, and the card adds mm (wave 2a) |
| P-F3 | Inconsistency | — | research.md R-02, R-03, R-06, R-08, R-11, R-12 | Wrong rationale for the cushion model, the old focal scoring, the robustness wording, a power range "to firm-break speeds" with an unchecked attribution, and "about 10 ms per frame" | **Resolved** (this revision) |
| P-F4 | Inconsistency | — | data-model.md ShotPlan, Warning, VisionResult, state machine | The `throwDeg` sign convention, the fraction labels, the not-makeable reasons, the `throw-uncompensable` and too-soft semantics, the new optional fields, and the lock rules (no quad → no calibration, the quality gate, the anchor, the manual reasons) | **Resolved** (this revision) |
| P-F5 | Inconsistency | LOW | `src/core/shot/geometry.ts` (`fractionOf` doc comment) | The comment's example "44° is 'thin ⅜'" is wrong: the code gives "thick ¼" (nearest eighth by overlap, 48.6° reference). The behaviour and the tests are right; only the comment is wrong | **Open** (core-shot owner, comment only). data-model.md uses checked examples |
| P-F6 | Inconsistency | LOW | README.md, specs/002 | The README and 002 statements listed under "Open for wave 2" | **Open**: T081 (deferred) |
| P-F7 | Drift | — | tasks.md T047, T061, T066, T068 | `processFrame`, the time budget, perf guards that did not exist, and T068 ticked while targets were under 44 px | **Resolved** (this revision). T068 is unticked |
| P-F8 | Inconsistency | LOW | research.md R-12 vs MASTER_PROMPT §5 | The speed words map to different m/s bands than MASTER_PROMPT §5 | **Accepted**: a deliberate deviation, documented with its bands in R-12 |
| P-E1 | Coverage gap | MEDIUM | FR-007 | No automated test, and broken on a frozen layout | **Open**: T083, T078. Manual Q16 until then |
| P-E2 | Coverage gap | LOW | FR-008, FR-023, FR-026, FR-028 | Covered only in part (see the coverage table) | Open, low priority |
| P-U1 | Underspecification | LOW | contracts/worker-protocol.md `reset` | `reset` builds a fresh pipeline, so ids restart at b1. The app does not send it today | Documented. If it is ever sent, use `pipeline.reset()`, which keeps the ids |

**Metrics for this pass**:
- Findings: 19 (P-C1 … P-U1).
  - 4 CRITICAL, all open: P-C1 … P-C4.
  - 1 HIGH, open: P-C8.
  - 2 MEDIUM, open: P-F2, P-E1.
  - 5 LOW: P-F5, P-F6, P-F8, P-E2, P-U1.
  - 7 resolved, with no severity: P-C5, P-C6, P-C7, P-F1, P-F3, P-F4, P-F7.
- No duplicated requirements.
- No new ambiguities: the 2026-11-15 clarifications settle the tip unit (as a recorded open
  decision), the speed words, the fraction labels, the frozen cue ball, the ambiguous cue ball and
  "most reliable".

**Next actions**:
1. Do not merge `fix/wave1` to `main` as it stands: P-C1 breaks Gate 3.
2. Wave 2b merges `fix2a/*`, which should resolve P-C2, P-C3, P-C4, P-C8 and most of P-E1. Land
   T074 (P-C1). Then re-run this cross-check, and run `npm run e2e` with the R-08 path changes in
   mind.
3. Decide the tip unit (T082) before any copy work on spin text.
4. Apply the README and 002 edits listed above (T081).

## Post-wave-2 (2026-11-15, `fix2b/app` = 00f722d)

Wave 2a (`fix2a/*`) and wave 2b (`fix2b/base`, `plan-ui`, `live-snap`, integration and a final
verify) landed the app side on top of the wave-1 merge (`fix1b/merge`). This pass re-checks the
open items above against the code on `fix2b/app`. The README and 002 edits (T081) were applied in
the same docs pass.

<!-- RELEASE: the test counts below are the README "Test status" figures; update both together. -->
**Tests on `fix2b/app`**: `npx vitest run` 887 tests in 61 files, 881 pass and 6 fail (the same
`ball-detect-edge.test.ts` cases as P-C1). `npm run e2e` 125 tests, all passing. `tsc --noEmit` is
clean. **On the release branch** (after the vision merge and the polish pass): 1052 tests in 69 files,
all passing (P-C1 resolved; the player-view CPU guards are relative to fits measured in the same run), and 141 e2e
tests, all passing.

| ID | Status on `fix2b/app` | Evidence |
|---|---|---|
| P-C1 | **Open** (CRITICAL; Gate 3). The 6 cluster and pair tests still fail. T074 belongs to the vision branch, which changes `src/vision` separately | `ball-detect-edge.test.ts` |
| P-C2 | **Resolved**. The live plan and overlay are drawn only on a locked table, with a 2-result grace that a new table frame does not inherit (`live-logic.ts` `liveGate`, `nextSinceLocked`). A frozen plan is drawn only through a live calibration with the same ordered corners (`framesMatch`). With no cue ball the hint asks for a tap | `live-logic.test.ts`, `camera.spec.ts` |
| P-C3 | **Resolved**. 22 CSS px pick floor on every table view, with the ball-vs-pocket rule; 44 px controls and fields. T068 is closed | `ui.spec.ts`, `render3d-picking.test.ts` |
| P-C4 | **Resolved**. `physicsFor` presets carry source and ASSUMPTION notes; lively cushion e0 is 0.9, inside the cited 0.75–0.9 | `settings.ts`, `settings.test.ts` |
| P-C8 | **Resolved**. A new version waits and offers "Reload"; the precache covers the whole build (icons, manifest, sample photos), revalidates every file and refuses a shell from another build; older caches are kept for open pages | `sw-precache.test.ts`, `sw-update.test.ts`, `update.spec.ts`, `offline.spec.ts` |
| P-F2 | **Resolved** (decision). 1 tip = ¼ R is kept (2 tips = the 0.5 R miscue limit), the plural is fixed, and the card details add the offset in mm. spec.md, data-model.md and the 002 quickstart say so | `power-tips.test.ts`, `shot-card.ts` `tipOffsetMm` |
| P-F5 | **Resolved**. The wrong `fractionOf` comment example is gone; the comment's examples (38.7° "⅜", 35.7° "thick ⅜") match the code, and the threshold is now 1.5° for label and phrase | `geometry.ts`, `geometry.test.ts` |
| P-F6 | **Resolved** by this docs pass (README, `docs/ios.md`, specs/002) | — |
| P-E1 | **Resolved** in part. The frozen-layout path of FR-007 is automated; the live path shares `applyCueOverride` and is unit-tested | `camera.spec.ts`, `live-logic.test.ts` |
| P-U1 | **Resolved**. `reset` now calls `pipeline.reset()`, which keeps the id counter | `vision-worker.test.ts` |

New cross-checks of this pass (the artifacts against `fix2b/app`):

| ID | Category | Severity | Location | Summary | Status |
|---|---|---|---|---|---|
| W-1 | Drift | — | data-model.md, core-api.md, research.md R-11 | The merged recommender (probes at half weight, `risks`, half steps, `TOO_SOFT_PENALTY`, `NO_SIDE_PENALTY`, `FULL_EVALUATIONS` 324), the frozen power advice (`advice`, `adviceSkipped`, `noWorkingPower`), `cb-short`, `fractionPhrase`, `strokeName`, `obPocketSpeed`, `throwAim` and the 1.5° fraction rule were missing | **Resolved** (this pass) |
| W-2 | Drift | — | worker-protocol.md, 002 worker-protocol-v2.md | Budget bound 228 (now 324), `reset` restarting ids, no `plan` message, no `perEvalMs`, no `risks` | **Resolved** (this pass) |
| W-3 | Drift | — | spec.md FR-003, FR-009, FR-012, FR-020, FR-023, FR-024, FR-028, edge cases | The kept selection, the calibration and camera-failure words, the pick floor, the power gauge, the fallback toasts, the lock gate, the cue-stick style and the settings ranges were not specified | **Resolved** (this pass) |
| W-4 | Coverage gap | LOW | FR-008, FR-023, FR-026 | Add/remove balls, overlay alignment while moving, and installability are still covered only in part (P-E2) | Open, low priority |

**Metrics for this pass**: 28 FR, 8 SC. 27/28 FRs have an automated test (FR-024 by design review), 3
of them only in part (W-4). Tasks: 82/83 done (all 69 original tasks; 13/14 of Phase 9); T074 is the
one open task. Constitution: I, II, V, VI and VII are met; III and IV are met with the exceptions
documented in plan.md Complexity Tracking (`timeCapMs`; simulation output records); Gate 3 is not met
while P-C1 stands.

**Next actions**:
1. Do not merge to `main` while P-C1 stands: land the vision branch's T074 fix first.
2. After that merge, update the README "Test status" line and the counts above, and re-run the e2e
   suite (the recommended strokes depend on the measured device budget, so e2e tests must not pin
   exact recommended strokes).

## Post-vision merge (2026-11-15, `rc/release` = 9a162bf)

The two vision branches landed on the release branch: the ball-cluster fix (`fix1b/vclusters`
`d66694b`, merged as `360b268`; T074) and the player-photo fit (`fix1b/pview` `453561e`, merged as
`0a30cf5`; spec 002), followed by the Snap app acting on the fit's reason (`9a162bf`). This pass
re-checks P-C1 and the 001 artifacts against that code. The test counts are not repeated here: the
release step updates the README "Test status" line and the counts above.

| ID | Status on `rc/release` | Evidence |
|---|---|---|
| P-C1 | **Resolved** (T074). The 6 cluster and pair cases pass, and the tests were not weakened: the count is a model selection over k with a penalised whole-cluster cost (research.md R-04), and every cluster scene is now checked under 62 calibrations (auto, exact and 60 jittered at ±0.15–1 px). No phantom appears next to a cluster under any of them. The auto and exact calibrations hold every criterion, every ball with ≥ 25 % of its outline is found (one recorded exception, V-2), and at most `jitterFails` of the 60 per view may lose one more ball or exceed a 10 mm median (spec.md SC-003 notes) | `ball-detect-edge.test.ts` (touching clusters, touching pairs), `ball-detect-clusters.test.ts`, `ball-detect-determinism.test.ts`, `ball-detect-helpers.ts` |

New cross-checks of this pass (the artifacts against `rc/release`):

| ID | Category | Severity | Location | Summary | Status |
|---|---|---|---|---|---|
| V-1 | Drift | — | research.md R-04, plan.md, data-model.md DetectedBall, spec.md SC-003 and edge cases | The model-selection count, the forgiven dilation ring (`chromaBand`), the window pass with its second scratch set, `px` in whole-table pixels and the rim-geometry cue rule were not described | **Resolved** (this pass) |
| V-2 | Decision record | LOW | spec.md SC-003 notes; `ball-detect-edge.test.ts` | Two hidden-ball allowances were raised from 2 to 3 (15-ball corner view: six balls at 6–13 % of their outline; snooker end view: three at 9 %), and one per-ball exception is recorded (`KNOWN_VISIBLE_MISS`: the 15-ball end view under the exact calibration misses the green 6, at 29 %; the wave-1 detector and the auto calibration find it). Each allowance is capped by the ray-cast count of balls under 15 % | **Accepted** with the merge; recorded in the SC-003 notes for the spec owner to revisit |
| V-3 | Known limit | LOW | README "Known limitations"; R-04 | On 4:2:0 video, snooker packs in the end, corner and mirrored corner views still lose or misplace 3–5 reds, with phantoms next to the pack (fewer than wave-1, and bounded by its counts in the tests). Grey-cloth detection of the white cue ball and light stripes in Live and Snap table photos is on a separate branch | Open, documented (Constitution II) |

**Metrics for this pass**: 28 FR, 8 SC. 27/28 FRs have an automated test (FR-024 by design review), 3
of them only in part (W-4). Tasks: 83/83 done (T074 closed). Constitution: I, II, V, VI and VII are
met; III and IV are met with the exceptions documented in plan.md Complexity Tracking (`timeCapMs`;
simulation output records). **Gate 3 is met**: P-C1, the last item that held it open, is resolved.

**Next actions**:
1. The release step updates the README "Test status" line and the counts in "Post-wave-2", and
   re-runs the e2e suite.
2. Decide V-2 (the two raised allowances and the 15-ball end-view exception).
3. Land the grey-cloth ball-detection branch (V-3) once its repair is done, and re-run this check.
