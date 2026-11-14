# Phase 0 Research: Real-Time Shot Guide

Each decision lists what was chosen, why, and what was rejected.

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
  explainable, testable on synthetic ground truth, and about 10 ms per frame. The bundle stays tiny
  (Principle VII).
- **Alternatives rejected**:
  - OpenCV.js: ~8 MB of wasm, slow first load on bar Wi-Fi. We only need ~5 algorithms.
  - A learned detector (YOLO via ONNX Runtime Web or TF.js): better for occlusion and ball-number
    recognition, but needs a labelled dataset and a multi-MB model. Kept as the upgrade path behind
    the `detectBalls` contract (same input/output).

## R-03 Table geometry: robust quad + homography + focal-length estimate

- **Decision**:
  1. Learn the cloth colour as the modal hue of the frame centre, and mask cloth-coloured pixels.
  2. Take the largest connected component near the centre.
  3. Collect boundary points from per-row and per-column extremes, then take their convex hull.
  4. Reduce the hull to 4 vertices, then **refit each side by least squares** on boundary points
     away from the corners. Intersect the sides. This recovers true corners even though corner
     pockets chamfer the cloth mask.
  5. Compute the homography by 4-point DLT.
  6. Estimate focal length *f* from the known rectangle: the orthogonality and equal-norm
     constraints on K⁻¹h₁ and K⁻¹h₂ (Zhang's single-plane calibration with one unknown).
  7. Choose the long/short side assignment whose two *f* estimates agree best. Fall back to a 65°
     horizontal FOV when the view is near fronto-parallel (f unobservable).
- **Rationale**: robust to pocket notches, side-pocket gaps and partial ball occlusion of the edge.
  Focal estimation lets us correct ball parallax without device calibration.
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

## R-08 Cushion collision: simplified impulse model

- **Decision**:
  - Restitution e_c(vₙ) = max(0.55, 0.88 − 0.035·|vₙ|).
  - Tangential impulse Jt = min(μ_c·Jn, (2/7)·m·|u_t|) at the equatorial contact, with μ_c = 0.2.
    Updates both velocity and sidespin (running/reverse english).
- **Rationale**: captures the first-order effects players see: rebound angle shortens with no spin
  and lengthens with running english, and speed loss. Topspin effects come afterwards through cloth
  friction.
- **Alternatives rejected**: Han (2005) and Mathavan et al. (2010) models: more accurate but need
  cushion-specific constants. Upgrade path.

## R-09 Pocket model

- **Decision**:
  - A pocket is two **jaw points** on the cushion-nose rectangle. A corner jaw sits mouth/√2 from the
    corner along each rail; a side jaw sits ±mouth/2 from the rail centre.
  - Cushions are the segments between jaws.
  - Acceptance window from a ball: between the directions to the jaws, each rotated inward by
    asin(R/d). It is empty if the shot is too steep.
  - Aim at the window bisector. The window's half-width is the object-ball angular margin.
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
- **Rationale**: one physically meaningful number that combines distance, cut and pocket. Thresholds
  are calibrated so a 1 m + 1 m, 30° corner shot is "medium", and are configurable.

## R-11 Stroke recommendation and position play

- **Decision**: grid search over tip offset and speed, simulating each candidate on the full layout.
  - Vertical offsets: −0.4, −0.25, −0.1, 0.1, 0.25, 0.4 R.
  - Side offsets: −0.2, 0, +0.2 R.
  - Speeds: power levels between the minimum feasible level and 10.
  - Score = objective − penalties.
    - Objective: next-shot quality from the CB rest position (best log-tolerance over remaining
      balls and pockets), or −distance to the player's target spot.
    - Penalties: speed (0.06·power + 0.1·max(0, power − 6)², a coach's bias toward controllable
      pace), spin magnitude, OB not pocketed, any kiss.
    - Hard rejection: scratch.
  - Robustness: each finalist is re-simulated at ±12 % speed and scored by its worst case.
- **Rationale**: transparent, deterministic, and fast enough in a worker (~200–600 short sims). The
  robustness check prefers forgiving strokes, which is what a coach does.
- **Alternative rejected**: gradient-based optimisation (discontinuous objective at collisions and
  pockets).

## R-12 Power scale

- **Decision**: power levels 1–10 map to CB speeds [0.6, 0.9, 1.2, 1.6, 2.1, 2.7, 3.4, 4.3, 5.5, 7.0]
  m/s. Speed words:
  - soft (1–2)
  - medium-soft (3)
  - medium (4–5)
  - medium-firm (6)
  - firm (7)
  - hard (8)
  - power (9–10)
- **Rationale**: spans lag to firm-break speeds (Alciatore's speed categories). The non-linear spacing
  matches how players perceive speed.

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
- **Rationale**: Principle VI. Redundant encoding through dash patterns and labels.
