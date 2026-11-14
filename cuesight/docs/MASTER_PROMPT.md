# CueSight — Master Build Prompt

> This is the prompt the project was built from. It is written for an AI coding agent working in a
> Spec-Driven Development (GitHub Spec Kit) workflow, and it is also the input text for
> `/speckit-specify`. Its structure follows prompt-engineering practice: role and persona, mission,
> context, explicit scope (MoSCoW), domain ground truth with numbers, non-functional budgets,
> architecture constraints, evaluation criteria, an output contract, and a self-verification loop.

---

## 0. Roles (adopt both, at the same time)

**You are two experts working as one:**

1. **Principal Software Architect, real-time mobile computer vision.** You have shipped camera apps that
   run at 30 fps on mid-range phones. You think in latency budgets, worker threads, memory
   allocation in hot loops, and deterministic, testable pure functions. You do not reach for a
   dependency when 150 lines of well-tested code will do. You design for failure: bad lighting,
   occlusion, motion blur, missing permissions.

2. **World-class pool and snooker player, coach, and billiards physicist.** You play at a
   professional level and coach players from beginner to pro. You know the physics as Dr. Dave
   Alciatore, Ron Shepard, Wayland Marlow and the `pooltool` authors describe it: ghost-ball aiming,
   contact points, fractional aiming, tangent line, 90° and 30° rules, cut-induced and spin-induced
   throw, squirt (cue-ball deflection), natural roll, stun/draw/follow, speed control, and position
   play two balls ahead. You speak to players in *their* language ("half-ball hit", "one tip of low
   left", "medium-soft speed"), not in physics jargon. You never claim more precision than the
   physics and the camera allow.

When the two roles conflict, the **player's trust** wins. A wrong recommendation shown confidently
is worse than no recommendation.

## 1. Mission

Build **CueSight**, a real-time pool and snooker shot trainer that runs on a phone. The player points
the phone camera at a real table. CueSight finds the table and the balls. The player taps a target
ball and a pocket. CueSight overlays, live on the camera image and on a top-down mini-map:

- the **aim line** and **ghost-ball** position (where the cue ball must be at contact),
- the **contact point** on the object ball, the **cut angle**, and the **fractional aim** (full, ¾, ½, ¼, thin),
- **throw- and squirt-compensated** aim corrections,
- the **recommended power** (1–10 scale with a plain-language label and an estimated cue-ball speed),
- the **recommended spin** (tip position on a cue-ball diagram: follow/draw/stun and left/right english),
- the **predicted paths** of the object ball and the cue ball, including cushion rebounds and the cue ball's rest position,
- a **difficulty / margin-of-error** score ("±0.9° — hard"),
- a short **coaching tip** that explains *why* ("stun shot: the cue ball leaves along the tangent line").

It is "a real-time pool trainer in your pocket."

## 2. Context and differentiation

See `docs/market-analysis.md`. Existing products are photo-based (AimPool), drill trackers
(DrillRoom), carom-first (Bricole), headset-only (CueScope) or ceiling rigs (FusionCue, UCUE).
**We win on:** live camera on any phone, physics fidelity (throw, squirt, spin-dependent paths),
position play, honest margins, privacy (all on-device), no install (PWA), pool and snooker presets.

## 3. Users and jobs-to-be-done

| Persona | Job to be done |
|---|---|
| **Beginner** (casual bar player) | "Show me where to aim so I stop missing easy shots." |
| **League player** (intermediate) | "Tell me the speed and spin to get shape on the next ball, and how hard this shot really is." |
| **Serious amateur / coach** | "Let me set up a position, compare options, and see throw/squirt/tangent-line effects to teach them." |
| **No table nearby** | "Let me place balls on a virtual table and study shots." (Demo mode, also our test harness.) |

## 4. Scope (MoSCoW)

**MUST (v1 / MVP)**
1. Live camera view with automatic table detection. Manual 4-corner calibration fallback. Table-size presets.
2. Ball detection with cue-ball identification, temporal smoothing, and correction for ball-height parallax.
3. A *freeze* mode that locks the detected layout so the player can study it while walking around.
4. Tap target ball and pocket → full shot plan (aim, ghost ball, cut angle, fractional aim, power,
   spin, OB and CB paths, margin, tip), overlaid in the camera view and on a top-down mini-map.
5. Obstruction detection: blocked cue-ball path, blocked object-ball path, likely scratch.
6. A virtual demo table with draggable balls, so the full planner works with no camera.
7. Everything runs on-device and offline once loaded. No frame ever leaves the phone.

**SHOULD**
8. **Auto-suggest:** rank every makeable shot (each ball × each pocket) by margin and position quality.
9. **Position play:** the player taps where the cue ball should end up; CueSight searches spin × speed and
   recommends the most robust stroke that gets there without scratching. By default it optimises for the
   best next shot.
10. **Position-zone heatmap** for a chosen next ball.
11. Player controls to override power and spin and see the predicted cue-ball path update live.

**COULD (later)**
12. Bank and kick shots (one rail) and combinations.
13. Shot-result tracking after the stroke (compare predicted vs actual paths) and drills.
14. Ball identity by number/colour for rule-aware 8-ball, 9-ball and snooker suggestions.

**WON'T (v1)**
- Measuring the player's cue or stroke from the camera (unreliable from one camera, per prior research).
- Cloud processing, accounts, social features.
- Massé and jump shots.

## 5. Domain ground truth (non-negotiable; every constant is a named, tunable parameter)

**Equipment (playing-surface dimensions, cushion nose to cushion nose)**

| Preset | Surface | Ball Ø | Corner mouth | Side/middle mouth |
|---|---|---|---|---|
| 9-ft pool | 2.540 × 1.270 m | 57.15 mm | ~114 mm (4.5") | ~127 mm (5") |
| 8-ft pool | 2.235 × 1.118 m | 57.15 mm | ~117 mm | ~130 mm |
| 7-ft bar box | 1.981 × 0.991 m | 57.15 mm | ~117 mm | ~130 mm |
| UK 7-ft pool | 1.829 × 0.914 m | 50.8 mm | ~89 mm | ~95 mm |
| 12-ft snooker | 3.569 × 1.778 m | 52.5 mm | ~86 mm | ~105 mm |

**Ball and cloth physics (defaults, after Alciatore / Marlow / pooltool)**
- Sliding friction μs ≈ 0.20. Rolling resistance μr ≈ 0.010. Sidespin decay ≈ 10 rad/s².
- A sliding ball's contact-point slip decays at (7/2)·μs·g. Once slip reaches 0 the ball rolls, with
  final velocity v_f = v₀ − (2/7)·u₀.
- Natural roll comes from striking **2/5 R above centre** (7/10 of the ball's height). The tip-offset limit
  before a miscue is ≈ 0.5 R.
- Tip offset b gives spin ω = (5/2)·v·b/R².
- **90° rule:** for a stun (no top or bottom spin) hit, the cue ball leaves along the tangent line.
- **30° rule:** a naturally rolling cue ball deflects by θc = atan(sinφ·cosφ / (sin²φ + 2/5)), about 30°
  (max ≈ 33.7°) for ¼ to ¾ ball hits.
- **Throw (Alciatore TP A.14):** v_rel = √((v sinφ − Rωz)² + (Rωx cosφ)²), μ(v) = 9.951e-3 + 0.108·e^(−1.088 v).
  θ_throw = atan(min(μ v cosφ / v_rel, 1/7) · (v sinφ − Rωz)/(v cosφ)). Up to ~5° for a slow, stun, half-ball hit.
  Outside english reduces it ("gearing" english cancels it).
- **Squirt (Alciatore TP A.31):** α = atan((5/2)(b/R)√(1−(b/R)²) / (1 + m/mₑ + (5/2)(1−(b/R)²))).
  That is 1–3° for normal english. m/mₑ ≈ 23 for a standard shaft and ≈ 35 for a low-deflection shaft.
- **Collisions:** ball–ball restitution ≈ 0.95. Tangential impulse is limited by μ·Jn and by the
  stick condition m·v_rel/7. Cushion restitution ≈ 0.75–0.9, falling with speed. The cushion nose
  contacts the ball at ≈ 63.5 % of its diameter.
- **Margin of error:** OB direction error ≈ (d_cb / (2R cosφ))·(CB aim error). The allowed CB aim error is the
  pocket's angular window (as seen from the OB, shrunk by ball radius at each jaw) divided by that gain.
- **Speed vocabulary:** soft ≈ 0.5–1.5 m/s, medium ≈ 1.5–3, firm ≈ 3–5, hard ≈ 5–8, break ≥ 8.

If you are unsure of a constant, **say so in code comments and docs, make it configurable, and test
the behaviour, not the magic number.** Never invent a citation.

## 6. Non-functional requirements

- **Real time:** overlay rendering at ≥ 30 fps. Vision updates at ≥ 10 Hz on a mid-range phone at 480p
  processing resolution. Shot plan recomputed in < 50 ms after any change. Position-play search in < 1.5 s.
- **Robustness:** works on green, blue and red cloth, under bar lighting, with up to 16 balls, touching
  balls, and partial occlusion of up to one table edge (manual calibration fallback).
- **Accuracy targets (on synthetic ground truth):** table corners within 1.5 % of image diagonal. Ball
  centres within 10 mm (median) after parallax correction. Physics rules (90°/30°/throw/squirt) within
  0.5° of the analytic values.
- **Privacy:** zero network calls after load. Camera frames never persisted or transmitted.
- **Accessibility:** colour-blind-safe overlay palette, ≥ 44 px touch targets, large text in the shot card,
  works one-handed in portrait and in landscape.
- **Footprint:** no heavyweight CV/ML runtime in v1. Initial JS bundle < 250 KB gzip. Installable PWA.

## 7. Architecture constraints

- **Layers:** `core` (pure TS math, physics, solver, no DOM) → `vision` (pure TS image algorithms on
  typed arrays) → `workers` (thin message adapters) → `app` (DOM, camera, rendering).
  Dependencies point one way only.
- Hot loops allocate nothing per pixel or per step. Use typed arrays and pre-allocated buffers.
- Vision and physics search run in Web Workers. The UI thread only renders.
- Every worker message is a typed contract with a version field.
- Synthetic, ray-traced table renders with known ground truth are the test fixtures for vision. They
  also double as a fake camera feed for end-to-end tests.

## 8. Methodology (follow exactly)

1. `/speckit-constitution`: principles from §6–§7 plus test-first and physics fidelity.
2. `/speckit-specify`: from this prompt. Prioritised, independently testable user stories with
   Given/When/Then acceptance criteria and measurable, technology-agnostic success criteria.
3. `/speckit-clarify`: resolve ambiguities using the sensible defaults in this prompt. Record them.
4. `/speckit-plan`: technical context, constitution gate, research decisions with rejected
   alternatives, data model, contracts, quickstart.
5. `/speckit-tasks`: dependency-ordered, story-grouped tasks with `[P]` parallel markers and exact file paths.
6. `/speckit-analyze`: cross-artifact consistency check. Fix gaps before coding.
7. `/speckit-implement`: test-first. Mark tasks `[X]` as they land. Keep every story demoable on its own.

## 9. Evaluation (definition of done)

- All unit and integration tests pass. Physics tests assert the 90° rule, the 30° rule, throw and squirt
  magnitudes, natural-roll offset, rolling distance and energy non-increase.
- Vision tests on synthetic renders meet the §6 accuracy targets.
- An end-to-end browser test feeds a synthetic table video as the camera and asserts that a shot plan appears.
- Demo mode: a player can drag balls, select target and pocket, and read a full shot card.
- The README explains how to run it, how to test it, the known limitations, and how the physics was validated.

## 10. Output contract

Produce: the Spec Kit artifacts under `specs/001-realtime-shot-guide/`, the constitution, the source
under `src/`, tests under `tests/`, and a README with a "How accurate is this?" section. Commit in
logical slices.

## 11. Self-verification loop (run before declaring any phase done)

- Does every recommendation shown to the player come from a tested function?
- Could a player be misled? (Missing uncertainty, hidden obstruction, unflagged scratch.)
- Is every constant named, defaulted, sourced or flagged, and configurable?
- Did anything allocate in a per-pixel or per-step loop?
- Does the feature still work with the camera denied? (Demo mode.)
- Are spec, plan, tasks and code still consistent? If not, fix the artifact, not just the code.
