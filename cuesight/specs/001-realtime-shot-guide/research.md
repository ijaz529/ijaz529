# Phase 0 Research: Real-Time Shot Guide

Each decision lists what was chosen, why, and what was rejected.

**Revised 2026-11-15** after the code review (see analysis.md, "Post-review"). R-03, R-06, R-08,
R-09, R-10, R-11 and R-12 now describe the code on `fix/wave1`; R-11, R-12 (coaching vocabulary) and
R-14 (palette) were revised again for `fix2b/app`. Where the earlier text was wrong,
the correction is stated in the decision itself.

## R-01 Platform: installable PWA

- **Decision**: a browser PWA (Vite + TypeScript), using `getUserMedia` for the rear camera and Web
  Workers for compute.
- **Rationale**: one codebase covers iOS and Android with no store install, which fits the "in your
  pocket" goal. All competitors are iOS-only native apps. The camera and Workers are standard. CI can
  test the whole stack in headless Chromium with a fake camera.
- **Alternatives rejected**:
  - Native Swift/Kotlin: two codebases and store friction. ARKit/ARCore depth would help but is not
    needed for a planar table.
  - React Native: the camera frame-processing bridge adds latency and native modules.
  - Later option: wrap the PWA with Capacitor if store presence matters.

## R-02 Vision: classical, in-house pipeline (no OpenCV/ML runtime in v1)

- **Decision**: colour segmentation, geometric fitting and template scoring, written in TypeScript
  over typed arrays.
- **Rationale**: the table is a near-uniform cloth with a strong prior (rectangle with a known aspect
  ratio), and balls are fixed-size disks after rectification. Classical methods are deterministic,
  explainable and testable on synthetic ground truth. They are fast enough: the whole pipeline
  takes a few tens of ms per 640×480 frame in Node (32 ms median in the 2026-11-15 run; the guard
  is 150 ms, against a 100 ms device budget). The earlier "about 10 ms" estimate was optimistic.
  The bundle stays tiny (Principle VII).
- **Alternatives rejected**:
  - OpenCV.js: ~8 MB of wasm, slow first load on bar Wi-Fi. We only need ~5 algorithms.
  - A learned detector (YOLO via ONNX Runtime Web or TF.js): better for occlusion and ball-number
    recognition, but needs a labelled dataset and a multi-MB model. Kept as the upgrade path behind
    the `detectBalls` contract (same input/output).

## R-03 Table geometry: robust quad + homography + focal-length estimate

- **Decision** (`vision/table-detect.ts`, `vision/calibration.ts`, `vision/homography.ts`):
  1. **Cloth colour.** First try the pipeline's established cloth model. Keep it while it still
     segments a plausible table that the camera is aimed at (component ≥ 5 % of the frame, quality
     ≥ 0.6). Otherwise learn the cloth as the modal hue of the frame centre. When that chromatic
     model finds no good table but the centre is mostly grey, try a low-saturation **neutral**
     (grey) model. Its `hue` is meaningless (0), and it matches on low S and V near the median.
  2. Mask the cloth-coloured pixels. Take the connected component the camera is aimed at (its
     outline contains the frame centre, or it covers most of the central window); otherwise take
     the largest component.
  3. Collect boundary points from per-row and per-column extremes, then take their convex hull.
  4. Reduce the hull to 4 vertices, then **refit each side by least squares** on boundary points
     away from the corners and away from the image border. The search band adapts so that it
     reaches past the corner-pocket cut-outs, and a second pass follows. Intersect the sides. A
     side with no supporting points, or a sharp or far-off corner, gives no quad.
  5. **Truncated tables.** A table cut off by the image border is accepted only when every side is
     still supported by real edge points and the outline runs off the frame wherever the cloth
     does. Otherwise the result is `null`, never a border-hugging quad. A frame with no table is
     also `null`.
  6. **Quality** is the intersection over union of the cloth component and the fitted quad. The
     pipeline locks only on quality ≥ 0.6 (`MIN_TABLE_QUALITY`, an ASSUMPTION from the synthetic
     renders: a correct outline scores 0.96–0.98).
  7. **Calibration.** Reject quads that cannot be a table outline: points not distinct (> 3 % of
     the diagonal apart), not strictly convex, or covering ≤ 2 % of the frame. Compute the
     homography to the outer cloth-edge rectangle by 4-point DLT.
  8. Estimate the focal length *f* from the known rectangle with Zhang's single-plane constraints
     and one unknown: K⁻¹h₁ ⊥ K⁻¹h₂ and ‖K⁻¹h₁‖ = ‖K⁻¹h₂‖. Each constraint is used only when it is
     well conditioned (axis tilt above a 0.1 floor). A one-constraint estimate reports the other
     constraint's residual as its inconsistency, so it is never "perfectly consistent".
  9. **Long/short assignment.** Score both assignments at one common focal: the orthogonality
     focal, which is the same for both, when it is plausible, else the assumed one. The score is
     the equal-norm residual, plus a weak prior toward the assumed focal, plus a penalty when the
     equal-norm constraint has no solution. Near-ties (< 0.05) keep the previous frame's choice; on
     a first lock they go to the longer-looking sides. The wrong assignment is off by about
     |log((L/W)²)| ≈ 1.3. `swapAxes` is an absolute override.
  10. **0°/180° frame.** It follows the previous frame's corners, so it never flips between
      frames. On a first lock it is set by the table axis that runs most across the image.
  11. Use the estimated *f* only when it is plausible (0.35–3.5 × the image width) and consistent
      (inconsistency < 0.25). Otherwise use the settings' FOV: default 65°, and only 20–150° is
      accepted. A pose that puts the camera less than 0.3 m above the cushion top is rejected
      (ASSUMPTION: a phone is held at least that high).
- **Rationale**: robust to pocket notches, side-pocket gaps and partial ball occlusion of the edge.
  Focal estimation lets us correct ball parallax without device calibration. The validation and
  conditioning rules exist because the earlier "two *f* estimates agree best" rule scored a
  single-constraint estimate as perfect, so about 1.5 px of corner noise could swap the rails
  (review finding `single-constraint-focal-wins-axis-swap`).
- **Alternatives rejected**:
  - Hough lines: more parameters, slower, and fragile with the rail diamonds.
  - Asking the user to calibrate: kept as the fallback (FR-003), not the default.

## R-04 Ball-height parallax correction

- **Decision**: decompose the homography into pose (r₁, r₂, r₃, t) using the estimated K. Build the
  homography of the plane at ball-centre height, H_R = H + s·(R − h)·K·r₃, and **rectify the image
  through H_R**. A ball silhouette's centre then maps onto its true (X, Y).
- **Rationale**: at a 45° viewing angle, mapping blob centres through the cloth-plane homography
  biases positions by ≈ R·cot(elevation), about 3 cm, which breaks SC-003. Rectifying at z = R
  removes that bias to first order.
- **Alternatives rejected**: ignoring it (fails accuracy); per-ball ray–sphere fitting (heavier, small gain).

## R-05 Cushion offset

- **Decision**: cushions are covered with the same cloth, so the detected cloth boundary is the
  *cushion top outer edge*. It is offset outward from the playing surface by `cushionWidth`
  (default 0.05 m) at height `cushionHeight` (default 0.635 × ball Ø). We fit the homography to that
  enlarged rectangle at that height and derive the bed plane (z = 0) through the pose.
- **Rationale**: matches real table construction. Both values are configurable (FR-028).
- **Alternative**: rectified-edge refinement of the nose line. Deferred. Settings cover the variance.

## R-06 Physics engine: time-stepped with exact sub-step contact times

- **Decision**: a fixed step (default 1 ms). Inside a step, positions drift linearly and the earliest
  ball–ball, ball–cushion or ball–jaw contact time is solved exactly (quadratic). Advance to it,
  resolve the impulse, continue. Friction updates velocities at the end of the step, with analytic
  clamping at the sliding→rolling and rolling→stop transitions. Ball state is 3D angular velocity
  plus 2D linear velocity.
  - A contact counts only when its normal closing speed is above `APPROACH_EPS` = 1e-9 m/s, so
    resting contacts cannot repeat at t = 0.
  - Up to 64·n contacts are resolved exactly per step (a frozen rack needs about 40). If that
    budget is spent, every touching contact is relaxed in sequential-impulse sweeps and exact
    detection resumes. If it is spent again, the rest of the step is drifted in sub-steps of at
    most R/8, with overlaps and cushion penetrations pushed out and resolved. No contact is skipped
    on any path.
  - Allocation: the step loop allocates only output records (one `SimEvent` per event, trajectory
    points when `record` is on, and at most n first-hit records). Searches run with `record: false`.
    The plan.md Complexity Tracking records this exception to Principle IV.
- **Rationale**: simple, robust (no tunnelling, no quartic root-finding) and accurate enough. Position
  error is O(a·dt²) ≈ µm. A 5 s shot costs ~5k steps × O(moving × balls), a few ms. That fits
  Principle IV.
- **Alternatives rejected**:
  - Event-based analytic simulation (Leckie & Greenspan / pooltool): exact, but needs robust quartic
    solving for every ball pair. Upgrade path.
  - Pure analytic rules only: can't model cushions, other balls or spin evolution.

## R-07 Ball–ball collision: frictional impulse with stick limit

- **Decision**:
  - Normal impulse Jn = m(1+e)/2 · vₙ, with e = 0.95.
  - Tangential impulse Jt = min(μ(v_rel)·Jn, m·|u_t|/7), opposing the contact slip u_t (3D, includes
    top/back-spin slip).
  - μ(v) = 9.951e-3 + 0.108·e^(−1.088·v) (Alciatore TP A.14, from Marlow's data).
- **Rationale**: this one model reproduces cut-induced throw, spin-induced throw, the 1/7 stick limit
  and spin transfer. Test: with e → 1 it matches TP A.14 to < 0.05°.
- **Alternative rejected**: a frictionless collision plus an analytic throw angle (can't evolve spin
  transfer).

## R-08 Cushion collision: rigid-body impulse on the full contact slip

- **Decision** (`core/physics/collide.ts`, `resolveCushion`; also used for jaw points):
  - The contact is taken at the ball's equator, r = −R·n̂.
  - Normal: speed-dependent restitution on the horizontal normal speed,
    vₙ' = −e_c·vₙ with e_c(vₙ) = max(0.55, 0.88 − 0.035·|vₙ|) (ASSUMPTION, fitted to the typical
    0.75–0.9 range).
  - Friction: Coulomb friction (μ_c = 0.2, ASSUMPTION) on the **full 3-D contact slip**. That is
    the horizontal slip u_t = (v + ω×r)·t̂ and the vertical slip u_z = (ω×r)_z, which comes from
    top/back spin against the rail. The sticking impulse (−u_t/(7/2), −u_z/(5/2)) per unit mass is
    scaled into the cone |P_f| ≤ μ_c·Jₙ. Then r × P_f updates ωx, ωy and ωz. So the rail changes
    top/back spin as well as side spin: a rolling ball loses most of its topspin at the rail.
  - This is the impulse structure of Han (2005, "Dynamics in carom and three cushion billiards",
    J. Mech. Sci. Tech. 19(4)), the `han_2005` cushion model in pooltool, with the contact moved to
    the equator. It needs no constants beyond e_c and μ_c. Scaling the sticking impulse, rather
    than applying μ_c·Jₙ along −û, keeps every impact dissipative by construction.
  - ASSUMPTION: the elevated contact (nose ≈ 1.27 R; WPA 62.5–64.5 % of the ball diameter,
    `cushionHeight`) is not modelled geometrically. Its downward push is what keeps the ball on the
    bed (no v_z) while the vertical friction acts. That holds while μ_c < tan θ ≈ 0.28. Cloth
    friction during the impact (part of Mathavan's model) is ignored.
- **Rationale**: the earlier model applied friction to the horizontal slip only, so top/back spin
  passed through every rail unchanged. Its stated rationale ("topspin effects come afterwards
  through cloth friction") was wrong. The kept topspin acted as draw against the rebound, so a
  rolling ball ended up rolling away from a head-on rail at only 0.32 of its arrival speed. Kept
  backspin acted as follow, so draw came back as follow (review findings
  `cushion-ignores-topspin-backspin`, `cushion-keeps-topspin-speed-scale`).
  - At the same e_c and μ_c, the review's ports of Han 2005 and of Mathavan, Jackson & Parkin
    (2010) give, against this model:
    - head-on natural roll leaving at ≈ 0.58 of the arrival speed (Han ≈ 0.54, Mathavan ≈ 0.51);
    - a 45° roll-in leaving ≈ 32° off the rail (Han ≈ 31°, Mathavan ≈ 36°).
  - Rail paths are therefore uncertain by a few degrees, and post-rail speed by about 10 %.
    `tests/unit/core/collide.test.ts` pins them as ranges: 0.5–0.65 of the arrival speed, and
    30–40° for a 45° roll-in.
- **Alternatives**: the full Han (2005) model with the contact angle θ = asin(h/R − 1), from the
  existing `cushionHeight`, and Mathavan et al. (2010). The old "needs cushion-specific constants"
  reason for rejecting Han was wrong. The remaining reason is simplicity. On rebound angle this
  model lands between the two published ones. On post-rail speed it is a little livelier than both
  (0.58 against 0.51–0.54). Upgrade path: the elevated contact angle.

## R-09 Pocket model

- **Decision**:
  - A pocket is two **jaw points** on the cushion-nose rectangle. A corner jaw sits mouth/√2 from the
    corner along each rail; a side jaw sits ±mouth/2 from the rail centre.
  - Cushions are the segments between jaws.
  - Acceptance window from a ball: between the directions to the jaws, each rotated inward by
    asin(R/d). It is empty if the shot is too steep.
  - Aim at the window bisector. The window's half-width is the object-ball angular margin.
  - **Ball frozen to a rail.** When the bisector's ghost ball would sit inside the cushion, the aim
    moves to the centre of the longest part of the window whose ghost is on the table (1 mm
    slack).
  - **Corner hanger.** When the ball's centre is on or past the mouth line, the window is the arc
    facing the pocket, which is then the long arc. The ball is already at the mouth: distance 0,
    and `mouthHit` is the ball itself.
  - **Cue ball touching the object ball** (centres ≤ 2R + 1 mm apart). There is no ghost ball: the
    object ball leaves along the line of centres, turned only by throw.
    - The shot is makeable when the line of centres is within the window's half-width plus the
      largest throw the model allows. That throw is TP A.14 throw at the softest stroke that still
      reaches the pocket: about 5° with the default physics, depending on `params`.
    - The planner searches the stroke angle (scan, then bisection or golden section), because
      throw is not monotonic in it: it peaks near 30° of stroke angle (31.5° at 0.6 m/s with the
      default μ(v), where the bound is 4.96°).
    - On snooker tables a touching ball is not makeable: moving it is a push stroke, a foul under
      the "touching ball" rule.
  - In simulation, a ball is pocketed when its centre leaves the rectangle, which is only possible
    through a gap.
- **Rationale**: one geometric model gives aim target, makeability, margin and simulation capture.
  It reproduces the known effective-target behaviour: side pockets narrow sharply at steep angles,
  rail-frozen balls have small windows.
- **Known limitation**: pocket facings, which let balls rattle in, are not modelled, so margins are
  slightly conservative. Documented in the README.

## R-10 Margin of error and difficulty

- **Decision**: CB aim tolerance δψ = w·2R·cosφ / d. Here w is the pocket half-window (rad) seen
  from the OB, φ the cut angle, and d the CB → ghost-ball distance (first-order error propagation,
  Alciatore). Labels by tolerance:
  - easy ≥ 0.20°
  - medium ≥ 0.08°
  - hard ≥ 0.04°
  - very hard < 0.04°

  We also report the tolerance as mm of contact-point error (2R·cosφ·w).
  - d is floored at 2R, and cos φ at 0. A not-makeable shot has tolerance 0, never a negative
    value (cuts past 90° are "wrong side").
  - Frozen cue ball: the plan's tolerance is the stroke-angle tolerance its search has at the played
    speed and tip — how far the stroke can turn either way and the object ball still leave inside the
    window (nearer edge; probes 0.25° doubling to 2°, then every 2° to 16°, 5 bisections; at most
    16°). It is the cue-ball direction tolerance, so the same thresholds apply; its mm figure is the
    departure margin × 2R. The line-of-centres-plus-throw margin (R-09) only ranks pockets and
    suggestions.
  - A plan that misses as played (`ob-missed`, `throw-uncompensable`) or that no power works for
    (`noWorkingPower`, or `minPowerCapture` > 10) has tolerance 0 and is "very hard", never easy or
    medium; the card shows "±0 mm" / "±0°".
- **Rationale**: one physically meaningful number that combines distance, cut and pocket. Thresholds
  are calibrated so a 1 m + 1 m, 30° corner shot is "medium", and are configurable.

## R-11 Stroke recommendation and position play

- **Decision** (`core/shot/position.ts`, `recommendStroke`): a grid search over tip offset and
  speed. Each candidate is a full `planShot` on the whole layout, with throw compensation and
  `record: false`.
  - **Grid.**
    - Vertical offsets: −0.4, −0.25, −0.1, 0.1, 0.25, 0.4 R. Side offsets: −0.2, 0, +0.2 R.
    - Power levels: every integer from ⌊`minPowerCapture`⌋ (the bare capture minimum, see
      data-model.md) to 10.
    - **Coarse to fine.** Centre ball at vert −0.4, 0.1 and 0.4 for every power comes first, then
      the rest of the grid. So a smaller budget thins every power evenly instead of dropping the
      hard strokes.
  - **Rejection.** A stroke is rejected when the object ball does not drop in the chosen pocket,
    the cue ball scratches, or the cue ball has no rest position.
  - **Score** = objective − penalty.
    - Objective with a landing spot: −(rest error) / 0.15 m.
    - Objective without one: 3 × next-shot quality (0..1), judged on the **post-shot table**: the
      target, the cue ball and any pocketed ball are removed, and balls the shot moved sit at their
      rest spots. Quality is the best log-scaled cue-ball tolerance over the remaining balls and
      pockets (0.02° → 0, ≥ 1° → 1).
    - Penalty (coaching heuristics, ASSUMPTION): 0.06·power + 0.1·max(0, power − 6)² (a coach's
      bias toward controllable pace) + a pace cost of 0.06 per diamond the object ball would roll
      past the pocket beyond 2 diamonds (a quarter of that with a landing spot; a firm ball meets a
      smaller effective pocket, after Alciatore TP 3.5–3.6) + 0.05 per metre of cue-ball travel
      beyond the first + 1.5·|side| + 0.3·|vert| + 1 for a kiss + 0.5 for any cue-ball contact with
      another ball.
    - Last resorts (penalty 10 each, larger than the whole objective range plus every other
      penalty): `TOO_SOFT_PENALTY` for a stroke whose own plan warns `too-soft` ("Very soft"), so
      the card never shows "recommended" next to "too soft" while a firmer stroke works; and
      `NO_SIDE_PENALTY` for side on a near-straight shot (cut < 5°) with no landing spot while any
      centre-line stroke pots the ball.
  - **Half steps** (default objective only): the softest potting power that is not too soft is
    refined half a step below and above, at every tip height (a stroke between whole numbers often
    pots at pocket speed with a better leave). They run only while the robustness walk's whole
    allowance (`WALK_RESERVE` = 108) still fits after them, so a device-sized budget keeps its speed
    checks and recommends whole-number powers.
  - **Reachable.** A landing spot is reachable when any potting stroke ends within 15 cm of it.
    Then only those strokes compete.
  - **Robustness** (the "most reliable stroke" of FR-020), spent in this order:
    1. **Speed check.** Candidates are walked in score order. Each is re-simulated as the same cue
       line (no re-aim, same tip) at 0.88, 0.94, 1.06 and 1.12 × its true speed. Underhits below
       power 1 are simulated at their real speed. **Any scratch or miss at those speeds
       disqualifies the candidate.** A survivor's robust score is min(nominal score, worst variant
       objective − its penalty), i.e. the worst case. The walk stops after 5 candidates pass, or
       when the budget runs out; it continues past the first 5 when they fail.
    2. **Probes.** Each survivor is mis-hit the other ways a player does: ±0.05 R of tip height, an
       aim error of 60 % of the shot's own tolerance, and (with side) a standard shaft's squirt
       instead of the configured one. Half of the worst of those outcomes counts (a scratch costs 6,
       a miss 3), and every cue-ball scratch seen is recorded in `Recommendation.risks`.
    3. **Polish finalists**: the best three centre-line strokes and the best stroke at each of the
       two softest powers, each checked in full, so side has a fair rival and a gentler stroke can
       win.
    - Only strokes whose checks all ran compete with each other.
    - Overhits past full power (7.0 m/s) cannot be played or tested. A stroke that needs them is
      used only when no fully tested one survives.
    - Side only when it clearly pays: a side stroke must beat the best centre-line stroke by
      `SIDE_MIN_GAIN` = 0.4. Among strokes within `SOFTEST_WITHIN` = 0.1 of the best, the softest
      wins.
    - If nothing survives, the best nominal stroke is returned with `fragile: true`.
  - **Score reported**: the robust score (the probe blend when the probes ran), with the coaching
    penalties. It is −∞ only when no stroke pots the ball.
  - **`risks`**: a list (empty when no scratch was seen) when every check ran. Absent means "not
    known": a fragile stroke, or a budget that ran out before the probes. Never `[]` for a fragile
    stroke.
  - **Budget (Constitution III).** The search is bounded by an evaluation count, `maxEvaluations`
    (default `FULL_EVALUATIONS` = 10 × 18 grid strokes + 2 × 18 half steps + `WALK_RESERVE`
    12 × (4 + 5) = **324**). The result is a deterministic function of the inputs and that count.
    The core reads the clock only when the caller sets the optional safety net `timeCapMs`, and the
    result then says `timedOut: true`. `onEvaluate` reports every planned grid stroke, half steps
    included.
    - The planner worker picks the count once per device and ball count: 1.2 s divided by the
      measured cost of one search plan (`record: false, advice: false`), clamped to 60–324
      (`src/workers/eval-budget.ts`). The figures are kept across worker restarts (`perEvalMs`), so
      the same request gets the same stroke for the page's life.
    - It sets `timeCapMs: 1500` as the safety net (the < 1.5 s budget of Principle IV).
- **Rationale**: transparent, deterministic for a given budget, and fast enough in a worker. The
  robustness rule prefers forgiving strokes, which is what a coach does. The review found that the
  earlier rule (a mean of nominal and worst, a fixed 3-point scratch cost, only the top 5 checked,
  a wall-clock budget in core) let scratch-prone strokes win and varied with device speed (findings
  `robustness-allows-scratch-prone-strokes`, `wall-clock-budget-in-core`, `contract-docs-false`).
- **Alternative rejected**: gradient-based optimisation (discontinuous objective at collisions and
  pockets).

## R-12 Power scale

- **Decision**: power levels 1–10 map to CB speeds [0.6, 0.9, 1.2, 1.6, 2.1, 2.7, 3.4, 4.3, 5.5, 7.0]
  m/s, with linear interpolation between levels. The speed word uses the power rounded to the
  nearest level, so each word covers this band of cue-ball speed:

  | Word | Power | CB speed (m/s) | MASTER_PROMPT §5 word for that speed |
  |---|---|---|---|
  | soft | 1–2 | 0.6 – 1.05 | soft |
  | medium-soft | 3 | 1.05 – 1.4 | soft |
  | medium | 4–5 | 1.4 – 2.4 | soft (< 1.5) / medium |
  | medium-firm | 6 | 2.4 – 3.05 | medium / firm (≥ 3) |
  | firm | 7 | 3.05 – 3.85 | firm |
  | hard | 8 | 3.85 – 4.9 | firm |
  | power | 9–10 | 4.9 – 7.0 | firm (< 5) / hard |

- **Rationale**: the scale spans very soft position play (0.6 m/s, 1.3 mph) to a hard power stroke
  (7.0 m/s, 15.7 mph). Break speeds (≥ 8 m/s in MASTER_PROMPT §5) are **out of scope**: the earlier
  claim that it "spans lag to firm-break speeds (Alciatore's speed categories)" was wrong, and the
  attribution was never checked against the source, so it is withdrawn. The non-linear spacing
  matches how players perceive speed.
- **Deliberate deviation from MASTER_PROMPT §5** (soft ≈ 0.5–1.5, medium ≈ 1.5–3, firm ≈ 3–5,
  hard ≈ 5–8, break ≥ 8 m/s). The words follow the spec.md clarification, which splits the
  playable range more finely. As a result 4.3 m/s is "hard" here but "firm" there, and
  5.5–7.0 m/s is "power" here but "hard" there. The m/s value is always available as secondary
  detail (FR-012).
- **What a level means on the table** (model output, not a measurement: pool9, default cloth
  μᵣ = 0.01, a centre-ball stroke from 0.3 m off the head cushion along the long axis; the total
  cue-ball path in table lengths L):

  | Power | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
  |---|---|---|---|---|---|---|---|---|---|---|
  | Path (L), cushion model of R-08 | 0.39 | 0.87 | 1.12 | 1.54 | 1.98 | 2.32 | 2.76 | 3.09 | 3.68 | 3.97 |
  | Path (L), old model (before 2026-11-15) | 0.39 | 0.87 | 0.96 | 1.12 | 1.35 | 1.68 | 1.89 | 2.00 | 2.57 | 3.02 |

  The old cushion model kept topspin through each rail (R-08), so it under-predicted cue-ball
  travel after a rail by up to about a third. The power scale itself was not recalibrated: the
  planner chooses power through the simulation, so fixing the cushion fixes the recommendation.
  Whether the default μᵣ matches real lag speed is still unchecked against a measurement.
- **Coaching vocabulary** (2026-11-15, `core/shot/power.ts`, `coach.ts`, `planner.ts`), one wording
  for the card, the 3D label, the coaching tip, Snap and the screen reader:
  - **Spin**: `describeSpin` says "½ tip below centre", "1½ tips above centre, 1 tip right" or
    "centre ball" (1 tip = ¼ R, spec.md clarification).
  - **Stroke names**: "Stop shot", "Stun", "Draw", "Follow", with the english side ("Follow, right
    english"); none when the cue ball never reaches the object ball.
  - **Squirt** is said once: the degrees off the blue line plus the offset at the ghost ball ("aim
    the cue 1.1° to the right of the blue line, about ⅓ of a ball (17 mm) right of the ghost ball").
    The figure depends on the shaft setting.
  - **Throw**: "Throw ≈ 1.2° pushes the object ball thick, so the ghost ball is shifted 1.3 mm
    thinner."; outside english is named for a thicker shift; a full-ball hit says "Throw: …" (centre
    ball) or "Side-spin throw: …".
  - **Too soft**: `cb-short` ("The cue ball stops before it reaches the 3. Use power 4.5+.") and
    `too-soft` are never emitted together. Every advice figure is `advisePower(minPower)`: `minPower`
    rounded up to the 0.5 step the power control moves in, the same figure as the meter and the 3D
    label.
  - **Frozen cue ball**: the advice quotes the first run of half-step powers that pots with pace and
    keeps the cue ball up ("A", "A–B" or "A+") and why it ends ("harder throws it less", or "the cue
    ball follows it in" for a scratch). With none it says no power gets it in with pace and gives the
    centre-ball alternative for a stroke with spin.

## R-13 Testing strategy

- **Decision**: a ray-traced synthetic renderer (`vision/synth/render.ts`) models:
  - the bed, cushion boxes and rails,
  - pocket holes,
  - shaded spheres with stripes, specular highlights and shadows,
  - a configurable camera pose and FOV.

  It produces frames with exact ground truth for vision tests. `scripts/make-fake-camera.ts` writes a
  `.y4m` that Chromium plays as the camera (`--use-file-for-fake-video-capture`) in Playwright e2e.
  Playwright is pinned to 1.63.0 to match the pre-installed Chromium.
- **Rationale**: Principle III. Measurable accuracy without real tables in CI.

## R-14 Overlay palette and encoding

- **Decision**: Okabe–Ito colour-blind-safe palette.
  - Aim line: solid blue (#0072B2).
  - Object-ball path: solid orange (#E69F00).
  - Cue-ball path: dashed sky (#56B4E9).
  - Ghost ball: dotted white ring.
  - Warnings: vermillion (#D55E00) plus an icon and text.
  - Cue stick (2026-11-15): #F4F6FB at 60 %, long dashes 18/7, labelled "Cue stick", drawn behind
    the cue ball along the cue's own line when |squirt| ≥ 0.1°, on the full 2D table and the camera
    overlay (not the mini-map), so it is never read as a ball path.
  - Table labels use the card tile's words: "30° · ½-ball hit", "36° · ⅜+ ball", "Frozen · stroke
    12° left", "Not makeable".
  - Balls: a ball vision could not name (`'ball'`) gets no letter and, without a measured colour,
    neutral grey #9a9a9a in 2D, in 3D and on the card's chips. Snooker colours are canonical in 2D
    too. Letters: on pool a colour-named ball shows its number as the 3D tags do; on snooker
    R/Y/G/Br/Bl/P/Bk.
- **Rationale**: Principle VI. Redundant encoding through dash patterns and labels.
