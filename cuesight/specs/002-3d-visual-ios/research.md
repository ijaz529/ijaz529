# Phase 0 Research: 3D Table, Two-Photo Snap Guide, Polished UI and iOS App

Decisions continue the numbering of [001 research](../001-realtime-shot-guide/research.md) (R-01 … R-14).
Each decision lists what was chosen, why, and what was rejected. `ASSUMPTION:` marks a value that
tests on synthetic fixtures must confirm or tune.

## R-15 3D renderer: hand-written WebGL2, no library

- **Decision**: a small, purpose-built WebGL2 renderer in `src/app/render3d/`. It contains:
  - a math module (vec3 and quat tuples, mat4 on `Float32Array`, rays);
  - procedural meshes;
  - one lit material shader with variants (cloth, wood, ball, cushion, pocket), a line/ribbon
    shader and a decal shader (contact shadows, glows);
  - CPU ray picking.

  It is loaded with a dynamic `import()` when a 3D view is first needed, so it does not count against
  the initial bundle.
- **Rationale**:
  - Principle VII: zero runtime dependencies. The scene is a fixed, known set of objects: one
    table, ≤ 22 spheres, one cue, a few overlays. It needs no scene graph, loaders or physics.
  - Budget: three.js is ~150 KB+ gzip even when tree-shaken for a lit scene with lines, which alone
    would take most of the 250 KB initial budget. The hand-written renderer is ~30–45 KB gzip
    (ASSUMPTION: estimated from ~2–3k lines of TypeScript and GLSL).
  - Control over render-on-demand, DPR capping, context-loss recovery and the exact line styles the
    2D view uses (Principle VI parity).
- **Alternatives rejected**:
  - three.js, Babylon.js: size, and a runtime dependency to justify for little gain.
  - regl, OGL, twgl: small, but they still add a dependency and solve only the boilerplate (~300
    lines here).
  - WebGPU: not available on iOS 15–17 Safari. WebGL2 covers iOS 15+.
  - CSS 3D transforms: no lighting, shadows or sphere shading.

## R-16 Materials, lighting and shadows

- **Decision**:
  - **Lighting**: "overhead lamp" lighting from 2–3 area lights over the table centre line (like a
    pool-table lamp), each approximated as a point light with a size term. A dim hemispheric ambient
    (warm from below, cool from above) is added.
  - **Shading**: specular highlights plus a Fresnel (Schlick) clear-coat lobe for the balls (glossy
    phenolic), the varnished rails and the cue. Lambert plus a soft sheen term for the cloth.
    Lighting is computed in linear space with an ACES-fitted tone map, sRGB output and a subtle
    vignette.
  - **Ball reflections**: an analytic "pool hall" environment function in the shader: a dark room
    with bright rectangular lamp shapes, so the balls show the characteristic lamp highlights. It
    needs no texture. Roughness widens the lamp shapes.
  - **Shadows**: soft contact shadows drawn as analytic darkening **decals** on the cloth, one per
    ball. Each is a blurred core under the contact point plus a penumbra elongated along the lamp
    axis and pushed away from it (the sphere-occluder shape under an overhead lamp). The cushion
    bases and pocket holes get an ambient-occlusion falloff in the shaders. Decals follow the balls
    every frame at the cost of one quad per ball.
    - An upgrade path, if decals look flat on device: a bed-space shadow texture rendered by a pass
      that evaluates the analytic sphere occlusion per texel, re-rendered only when balls move.
  - **Cloth weave**: a 256² procedurally generated twill tile with mipmaps, plus anisotropic filtering
    where `EXT_texture_filter_anisotropic` exists, so the weave fades without moiré at grazing angles.
    A low-frequency nap variation and the lamp falloff give the cloth depth. The cloth colour comes
    from `Scene3DData.clothRgb` when given (for example, the cloth learned from a Snap photo).
  - **Wood**: a procedural grain texture (512 × 64). **Diamonds**: small inlaid quads on the rail top
    (pool only). **Snooker markings**: baulk line, D and spots, drawn into the bed texture.
  - **Antialiasing**: the default framebuffer's MSAA (`antialias: true`). The device pixel ratio is
    capped by `opts.maxPixelRatio` (default 2).
- **Rationale**: overhead lamps cast nearly vertical, soft shadows. An analytic sphere-occluder
  shape is right for that case, has no acne or aliasing, runs on SwiftShader in CI, and costs one quad
  per ball.
- **Alternatives rejected**:
  - Shadow maps: one map per lamp, PCF for softness, acne and peter-panning tuning, and higher mobile
    cost.
  - SSAO: heavy, and noisy on mobile GPUs.
  - Baked lightmaps: balls move, so the shadows can't be baked.

## R-17 Replay timing and ball rotation from trajectories

- **Context**: `Trajectory.points` are positions sampled at every event and at least every 2 cm. They
  carry no timestamps. `Trajectory.events` carry exact simulation times `t` and positions.
- **Decision (timing)**: build a per-ball timeline, a pure function in `render3d/playback.ts`:
  - **Keyframes**: every recorded point that coincides with one of the ball's events gets that
    event's exact time `t`.
  - **Between keyframes**: points are spread by arc length assuming a constant deceleration. This is
    a display choice: the implementation uses an ASSUMPTION constant (`PLAYBACK_DECEL`); a
    per-phase `μ_slide·g` / `μ_roll·g` is an option. A span that ends the motion ends at zero speed
    (ease-out). Spans with no timing information fall back to distance with an ease-out.
  - Position at time `t` comes by interpolating the timed points.
  - Every keyframe is hit exactly, so positions at event times match the simulation by construction
    (SC-103). The between-event model only shapes the speed profile.
- **Decision (rotation), level 1 (required)**: rolling without slip along the path. A displacement
  `d` turns the ball by `|d|/R` about `ẑ × d̂`. Orientations are accumulated per recorded point, so
  the result is exact along each straight sub-segment and independent of the frame rate. This meets
  FR-108's MUST and SC-103's no-slip criterion.
- **Decision (rotation), level 2 (recommended, FR-108 SHOULD)**: show the sliding phase too, so stun,
  draw and follow look different right after the strike and after impact. Integrate a 3D angular
  velocity ω and an orientation quaternion per ball, with sub-steps ≤ 4 ms. The sliding-friction
  torque is the 001 simulator's own model.
  - **Initial spin**: the cue ball starts with `strikeBall(aimDir, stroke, table, params).omega`.
    Object balls start at ω = 0 when first hit (as in R-07, ball–ball friction transfers only a small
    spin, which is ignored for display).
  - **Slip**: at each sub-step, `u = v + ω × (−R ẑ)` (contact-point velocity).
  - **Sliding** (`|u| > ε`): `ω += (5 μ_slide g / 2R) · (ẑ × û) · dt`. This drives the slip to zero at
    the rate (7/2) μ g, exactly as in the simulator.
  - **Rolling**: `ω_h = ẑ × v / R`, with no slip by construction.
  - **Sidespin**: `ω_z` decays at `spinDecel`.
  - **Impulses**: at `ball`, `cushion` and `jaw` events the ball keeps its ω and the slip is
    re-evaluated, so a draw shot visibly spins backward after contact and then turns over.
  - **Orientation**: `q ← exp(½ ω dt) ⊗ q`.
- **Decision (replay)**:
  - Rate 1×. If the total simulated time T exceeds 4 s, the replay runs at T/4×, so it always ends at
    the true rest positions within 4 s.
  - A pocketed ball, after its `pocket` event, moves to the pocket centre and falls under gravity
    (`POCKET_DROP_S` ≈ 0.4 s), then hides.
  - *Revised 2026-11-15:* a 0.5 s strike lead-in comes first, and the final frame holds for
    3.5 s (×1.8 with reduced motion) so the player can study the end position; a tap, Skip or
    Escape ends it at once. The renderer then shows the `Scene3DData` layout again. The 4 s cap is
    on the balls' motion only (spec FR-108).
  - `stopPlayback()` restores at once.
  - Resting orientation: number up, tilted 20° toward the default camera, so numbers read in
    Overview.
- **Rationale**: positions stay exactly faithful to the physics at every event, with no change to
  core. Level 1 is exact for every rolling phase, which is most of what a player watches. Level 2
  reuses the simulator's own friction law (Principle I), so the sliding phases look right too. Until
  level 2 lands, the spin of a stun or draw shot right after the strike is drawn as rolling. That is
  a documented display simplification, not a physics claim.
- **Alternative**: record per-point timestamps (`Trajectory.times?`) in `simulate()`. It would be a
  non-breaking optional field in core and would remove the reconstruction, but it touches the core API.
  Deferred until replay accuracy needs it. The SC-103 tests decide.
- **Outcome (2026-11-15)**: the alternative was taken. `simulate()` records each point's time and
  angular velocity (`Trajectory.times`, `Trajectory.spins`) when `record` is on, and the replay passes
  every recorded point at its simulated time (scaled by the rate) and shows sliding from the recorded
  spins. Hand-built tracks without times still use the reconstruction and match their event points
  within 1 µm.

## R-18 Camera model, presets and gestures

- **Decision**:
  - **Orbit camera**: target T, yaw ψ, pitch θ, distance d and vertical FOV.
    - User gestures clamp θ to [8°, 89°] and d to a fixed range (`DIST_MIN` … `DIST_MAX` in
      `camera.ts`). Pan moves T, which is clamped to the table's outer rectangle.
    - Presets may set θ = 90° (exact top-down).
    - Transitions interpolate (T, ψ, θ, log d, fov) with an ease-in-out cubic over 720 ms
      (`TRANSITION_MS`, revised 2026-11-15). With reduced motion it jumps.
  - **Defaults** (ASSUMPTION, tuned visually; the constants in `src/app/render3d/camera.ts` are
    authoritative):
    - **Overview**: θ = 90°, fov 30°. ψ is chosen so the table's long axis follows the screen's long
      axis. Landscape: +x right and +y up, like the 2D view. Portrait: +x up. d is fitted so the table
      plus rails fill the viewport (≈ 3.5 % margin, minus UI insets).
    - **Player view** (revised 2026-11-15 to `camera.ts`): eye 0.5 m behind the cue-ball centre
      along −aimDir and 0.21 m above the bed, and at least 7 cm above the cue's rail-clearing line, so
      beyond the rail when the ball is frozen to it. fov 50° (landscape) or 58° (portrait). To keep
      the pocket, the object ball's path and the ghost ball in view, the fit may back off by up to
      0.38 m, widen the fov by up to 17° and turn toward the pocket. The look point lies on the z = R
      plane. Without a plan, aimDir = the direction from the cue ball to the table centre.
    - **Broadcast**: an elevated three-quarter view, fov 38°. Landscape: from the bottom long rail,
      turned toward a corner (ψ ≈ −112°, θ ≈ 34°). Portrait: from behind the left short rail,
      slightly off-axis (ψ ≈ 196°, θ ≈ 40°). d is fitted.
- **Gestures**: a pointer state machine with `setPointerCapture` and `touch-action: none`.
  - **Tap**: movement < 8 px and duration < 350 ms → `onTap(pick)`.
  - **Double-tap**: a second tap on empty cloth within 320 ms and 30 px → the last preset
    (`gestures.ts`, revised 2026-11-15).
  - **Drag**: on a ball → `onBallDrag` (start/move/end) on the z = R plane, clamped to the bed. On
    empty cloth or background → orbit (0.3°/px), which sets the camera to `custom`.
  - **Two pointers**: the distance ratio → zoom; the midpoint motion → pan. **Wheel**: zoom by
    exp(dy·0.0015); Ctrl + wheel (a trackpad pinch) by exp(dy·0.01).
  - **pointercancel** ends any gesture and is never a tap. The machine is the pure
    `src/app/render3d/gestures.ts`, tested in `tests/unit/app/render3d-gestures.test.ts`.
- **Rationale**: an orbit camera is predictable for players. The presets map to what coaches show:
  the map view, the shooter's eye line and the TV angle. Thresholds match platform tap conventions.

## R-19 Picking: analytic CPU ray casts

- **Decision**: unproject the pointer through the inverse view-projection into a world ray. Hits are
  tried in this order:
  1. Nearest ray–sphere hit among the balls (z = R).
  2. Otherwise the nearest ball whose closest approach to the ray is within 1.8·R + 12 CSS px at the
     ball's distance (its natural radius), or the 22 CSS px floor that keeps the 44 px touch target
     (Principle VI). A ball reached only through that floor yields to a pocket mouth nearer the tap
     on screen, the same rule as the 2D table and the overlay (revised 2026-11-15).
  3. Otherwise the ray–bed-plane hit inside a pocket's capture disc → pocket. The disc is centred
     2 cm from the mouth centre into the pocket, with radius 0.75 × the mouth width and at least
     22 CSS px.
  4. Otherwise a hit inside the bed → cloth.
  5. Otherwise `null`.

  `toScreen` is the exact forward projection used by tests.
- **Rationale**: exact, deterministic, pure (unit-testable in Node), no GPU read-back stall.
- **Alternative rejected**: GPU ID-buffer picking. It needs `readPixels` (slow on mobile, async in
  Safari) and an extra pass.

## R-20 Drawing the plan in 3D

- **Decision**:
  - **Paths** (aim line, object-ball path, cue-ball path, other paths): screen-space ribbons of
    constant pixel width (3 CSS px; 4 for the aim line). They are extruded in the vertex shader from
    neighbouring points and drawn 0.6 mm above the cloth with polygon offset. Depth testing against
    the balls is on, so paths pass behind balls correctly.
  - **Dashes** use a per-vertex arc length in metres (cue path 40 mm on / 25 mm off; other paths
    dash-dot), so dashes foreshorten with perspective and read as "on the cloth".
  - **Colours** are exactly `PALETTE` and `DASH` from `render/palette.ts`.
  - **Ghost ball**: a translucent white sphere (α 0.22) with a dotted screen-facing ring.
  - **Contact point**: a small dot on the object ball's surface.
  - **Target and pocket**: the target ring in `PALETTE.target`, and a pocket ring plus chevron in the
    object-ball colour.
  - **Rest marker**: ✕. **Landing marker**: ring plus ✕ in `PALETTE.landing`.
  - **Heatmap**: an R8 bed texture with a single-hue alpha ramp, under the paths.
  - **Text labels** (pocket names, "ghost", "rest") are DOM elements placed with `toScreen`, so they
    stay crisp, accessible and translatable.
  - **Cue stick**: a tapered cylinder (tip, ferrule, maple shaft, wrap, butt) along −aimDir. Its axis
    passes through the strike point, using the same convention as `strikePoint` (R-26).
    `render3d` keeps its own copy (`strikePoint3`), which is tested to agree.
    - Tip gap behind the strike point: `cueGap(power) = 0.05 + 0.03·power` m. This is a display
      mapping, not physics.
    - Elevation: near-level (a small minimum, `MIN_CUE_ELEVATION`), raised only as much as needed to
      clear the rail behind the cue ball. The shot card notes it when the elevation is noticeable.
    - It is hidden during playback.
- **Rationale**: the same visual language as the 2D view and the camera overlay (Principle VI). It
  stays legible at any zoom.

## R-21 Two photos ("Snap") instead of live table-level AR

- **Decision**: a new **Snap** mode with two stills. The **table photo** gives the layout, using the
  001 detector where it is accurate. The **player photo** gives only the camera pose, fitted against
  that known layout. Live (001) stays for overhead use.
- **Rationale**:
  - At table level the whole table is never in view, and the cloth is seen at a grazing angle. The
    001 approach (quad → homography → rectified balls) cannot run there.
  - Depth from one grazing photo is hopeless. For a camera 0.15 m above the bed and a ball 2 m away,
    one pixel of vertical error is ≈ 2.7 cm of depth error (f ≈ 1000 px). Lateral resolution there
    is ≈ 2 mm/px, which is exactly what drawing an aim line needs. An overview photo gives positions
    with a median error of ≈ 4 mm (001 results). Each photo does what it is good at.
  - Stills give full sensor resolution, autofocus, HDR and no motion blur. Timing is not critical.
- **Alternatives rejected**:
  - Continuous live AR at table level (pose tracking at 10 Hz): fragile with motion blur and with
    balls as the only features. Kept as a later upgrade, since the pose solver (R-24) is the same.
  - Player photo only: layout depth error too large (above).
  - ARKit world tracking: native only, breaks PWA parity, and still needs the layout.

## R-22 Taking and decoding photos

- **Decision**:
  - Two file inputs, both `accept="image/*"`: one with `capture="environment"` (camera) and one
    without (library). They open the native camera and picker in Safari, WKWebView and Chrome.
  - *Revised 2026-11-15 to `snap/photo.ts` and `snap/exif.ts`:* the processing size is **960 px** on
    the long side for both photos (`SNAP_MAX_DIM`). The app reads the photo's size and EXIF
    orientation from the header itself, sets the JPEG orientation tag to 1 in the bytes it decodes
    (so no decoder turns the photo, whatever it supports) and turns the pixels itself. The platform
    decodes straight to the processing size with `createImageBitmap` `resizeWidth`/`resizeHeight`
    where it supports them; otherwise without them, or through an `HTMLImageElement` and
    `decode()`. A full-size bitmap is drawn once and closed at once.
  - Then `getImageData` → `Frame` → transferred to the vision worker.
  - The object URL is revoked and the full-size image dropped at once. A photo that finishes decoding
    after Start over or leaving Snap is dropped too (FR-122).
  - HEIC is converted to JPEG by iOS for file inputs.
  - Nothing is written to storage (Principle V).
- **Rationale**: the native camera UI is familiar and gives the best photo. `ImageCapture.takePhoto`
  is not supported in Safari. A frame grabbed from `getUserMedia` is limited to video resolution.
- **Known risk**: decoding 48 MP photos needs a large transient buffer on older iPhones. Mitigation:
  scale while drawing, and release the source promptly. This is checked in the device test.

## R-23 Table photo processing: the 001 pipeline on a still

- **Decision**: the vision worker keeps a **separate** pipeline instance for stills, so live tracking
  state is never disturbed. On a `still` message it runs `process(frame)` repeatedly on the same
  frame (N = 6 by default: the tracker locks after 5 stable frames), and returns the last
  `VisionResult`, with `ms` covering all iterations. After the first pass it MAY reuse the first
  table detection to save time. Configuration (table, FOV, axis swap) comes from the last `config`
  message.
- **Rationale**: one detector, one accuracy contract (SC-105 reuses 001 SC-003). The tracker's lock
  logic doubles as a stability check.
- **Gap**: manual corners for a still are not in the v2 message. See the proposed optional extension
  in [contracts/worker-protocol-v2.md](./contracts/worker-protocol-v2.md).

## R-24 Player-photo pose: known-layout model fitting

*Revised 2026-11-15 for the player-photo merge (`0a30cf5`, from `fix1b/pview` `453561e`). The
earlier design (a cloth hue from the photo's lower band, a fixed d × h × yaw grid with three focal
guesses, centre and radius residuals) met SC-106 on 53.7 % of the envelope; it is replaced below.
The step-by-step contract is [contracts/player-view-api.md](./contracts/player-view-api.md).*

- **Camera model**: pinhole, square pixels, principal point at the image centre, no distortion.
  ASSUMPTION: phone pipelines correct lens distortion. Unknowns (rotation, camera centre C ∈ ℝ³,
  log f): **6-DoF plus focal**.
- **Detection** (`src/vision/player-detect.ts`; pure, deterministic, typed-array scratch reused
  between calls):
  - **Cloth candidates, not "the colour of the bottom of the photo"**: a table-level photo is mostly
    the room, the near rail and the floor, and the cloth can be any colour, grey included. Every
    chromatic hue mode and grey value mode covering ≥ 1.5 % of the photo is a candidate, ranked by a
    structure score (round, ball-sized holes in the main region; speckle from a band that cuts
    through a surface's shading counts against it). The overview's cloth is promoted only when this
    photo shows a plausible region of it. The best 3 are tried in turn until one fits.
  - **Evidence**: cloth-boundary crack points with noise speckle removed; ball circles on
    cloth-bordered arcs ≥ 120° (Kåsa plus deterministic RANSAC, also per colour class, local arcs on
    large blobs); colour and whiteness from each circle's own pixels, with thresholds scaled by the
    exposure read off the brightest balls.
- **Hypotheses**: a 20-step lens sweep (HFOV ≈ 110° to 26°) plus the overview's focal length ×0.95,
  1 and 1.05. Per focal guess, the cue-ball circle fixes the cue ball in camera coordinates, and any
  other circle paired with a colour-compatible known ball fixes the rotation up to a turn about the
  line between them: the level member in closed form, plus roll completion from the remaining
  circles' votes. Scored by the known balls that land on circles of the right size and colour, the
  balls predicted on bare cloth and the circles left unexplained.
- **Refinement**: Levenberg–Marquardt over (rotation, C, log f), forward-difference Jacobian, 8
  iterations per stage, on exact residuals: for a ball, the angle between a crack point's ray and the
  silhouette cone's axis minus its half-angle (no off-axis ellipse bias; σ 1 px); for a cushion edge,
  outer and nose, the angle between the ray and the plane through the camera and the edge (σ 1.5 px).
  ICP-style re-association under a shrinking gate (24, 12, 6, 3.5 px per 1000 px of the long side,
  at least 3 px), Cauchy weights (scale 2σ). Priors: log f heavy-tailed around `focalPx` (σ 0.1) or
  Gaussian around 65° HFOV (σ 0.5) without it; roll σ 10° (5° with taps); camera height soft-bounded
  to 2 cm–2 m (0.2 ± 0.15 m with taps).
- **Confidence and honesty** (Principle II): inlier term × residual term × exp(−σ_px / (0.01·diag)),
  σ_px from the posterior covariance at the target's image position plus, for fits of ≤ 4 balls
  without crossing cushion lines, the layout's own uncertainty. `ok` needs confidence ≥ 0.5,
  residualPx ≤ max(4 px, 0.6 % of the diagonal), enough balls with sure identities (a near-minimal
  fit), the cue or target matched, a convincing fit for a camera away from the cue ball, and no
  moved ball (FR-121). A failure never reports confidence ≥ 0.5. Reasons name the true cause; the
  table is in data-model.md § PlayerViewResult.
- **Decisions and constants** (ASSUMPTION: synthetic table-level renders unless stated; each
  constant is documented in place in `player-view.ts` / `player-detect.ts`):

  | Decision | Constant(s) | Evidence |
  |---|---|---|
  | Hue modes tried as cloth candidates | `MAX_CANDIDATES` 6 (≥ 30° apart; grey value modes: 2, ≥ ×1.5 apart) | With 4 slots, σ 6 noise gave the dark room hue modes that pushed a green cloth seen as a 2.6 % sliver off the list |
  | Smallest candidate and main cloth region | `MIN_CANDIDATE_SHARE` 1.5 %, `MIN_CLOTH_AREA` 1 % of the frame | From 8 cm up and 1.2 m back with a 100° lens the cloth is ≈ 2.5 % of the frame |
  | Exposure from the brightest balls, never above nominal | `BRIGHT_NOMINAL` 0.9, `MIN_EXPOSURE` 0.5 | A cloth-based scale took a light cloth's albedo for exposure and lost the cue ball: light cloths 49/80 → 80/80 |
  | Noise speckle | `SPECK_AREA` 10 px | Removed before cracks and circles |
  | "Too grainy" | `NOISY_SPECKS` 60 per 1000 px of cloth; `NOISY_SIGMA` 4.5 (whole-frame chroma σ, when no cloth region was kept) | 4 cloths × 7 noise levels: green and light-blue fits succeed below 60 specks (40/40, 48/48) and on none above; a smooth render reads σ ≈ 0.3, and σ ≥ 10 dissolves a tinted grey's region |
  | "Too dark" | `DARK_MEAN_V` 0.12, `DARK_SHARE` 0.8, `DIM_CLOTH_V` 0.15 | A lit table-level photo has mean V 0.25–0.5, cloth V 0.3–0.55; the ×0.15 test frame 0.06. "Too dark" on lit photos: 8–12 per perturbation variant → 0 |
  | "Too few balls" | `MIN_BALL_CIRCLES` 3 | Means what it says: fewer than 3 ball circles in the photo |
  | Sure identity | `MINIMAL_COLOUR_COST` 1 (a hue within 14°) | Neighbouring pool colours differ by 20–25°; a repeated colour (a snooker red, a solid/stripe pair) let a camera 95 cm off fit two orange balls swapped with a third out of view |
  | A pose the static scene supports | `SOLID_EXPLAINED` 0.5, `SOLID_EDGES` 0.2 | A right pose puts 25–40 % of the cracks on the cushions, a wrong one 2–5 % |
  | Plausible camera for "moved" | `PLAUSIBLE_CAMERA_DIST` 2 m, height 2–80 cm (`PLAUSIBLE_CAMERA_HEIGHT` 0.8) | Spec assumptions (5–50 cm, ≤ 1.5 m) with margin: from a few cm up a camera metres away can line up nearly parallel cushion lines |
  | Moved-ball signature | `DISPLACED_MIN` 2.5 R, `DISPLACED_SIZE` 1.5 | A moved ball's new spot is ≥ 2.5 R away (layout error ≲ 1 cm) |
  | The pose cannot absorb a moved ball | `STILL_FITS_RATIO` 2.5, `STILL_FITS_ABS` 100 | An unmoved ball at the edge of a 92° grey photo costs ×1.3–1.8; a cue ball moved 8–20 cm ×4.7–23 (+170 … +1000) |
  | Plain cloth is no evidence of absence on untinted grey | `UNTINTED_SAT` 0.08 | A ball's shaded side has the cloth's own grey; 4 of 117 static grey photos said "moved" otherwise |
  | Colour of a partly cloth-like ball | `BALL_PIXEL_SHARE` 0.1 | A white ball's lit cap on untinted grey is 10–40 % of its disc; bare cloth ≈ 0 % |
  | Layout uncertainty | `LAYOUT_SIGMA` 5 mm per coordinate | 001 SC-003 (median ≤ 10 mm). From 7 cm up with a 96° lens three balls and the far cushion fitted a camera 35 cm off within 1 px (ghost 7 %): σ 9 px with the propagation, 0.3 px without |
  | Lens sweep | `LENS_SWEEP` 0.446 · 1.1ⁱ, i < 20 | HFOV ≈ 110° (0.5×) to 26° (3×) in ≈ 10 % steps; lens-change sweep 45/48 with no bad ok |
  | Pair depth check | `PAIR_DEPTH_RATIO` 2 | No change over 136 photos; it prunes roots whose depth disagrees with the circle's size |
  | Roll | `ROLL_MAX` 35°, 2° vote bins over ±40° | The spec allows ±20°, with margin for the fit to settle |
  | Deterministic budget | `REFINE_BUDGET` 10, `SEEDS_FIRST` 4, `SEEDS_LATER` 2, `ALT_ANCHORS` 2 | Fits need 1 refine in 95 % of cases (at most 8, over 154 runs); failing photos refined up to 24, which took 450–630 ms CPU |
  | Hypotheses kept | `TOP_HYPS` 64 | Far more than the ≤ 4 diverse seeds a solve takes |
  | Coarse-to-fine refine | 30 / 55 points per ball / edge on the wide gates, 90 / 160 on the last two | The wide gates only bring a seed into the basin |

- **Measured** (independent sweeps and the tests `player-view-envelope.test.ts`,
  `player-view-honesty.test.ts`, `player-view.test.ts`):
  - SC-106 envelope, 912 photos with enough balls in view: 53.7 % → 95.4 % within tolerance without
    hints (pool 438/454, snooker 432/458), 40.0 % → 95.5 % with the app's hints; SC-107 violations
    7 → 0 (with hints). The Snap fixtures and the player-view grid are unchanged (snap-player.png:
    0.39 cm, 0.026°, ghost 0.012 %, confidence 0.99).
  - Perturbations (40 photos): noise σ 3 / 6 / 8 97.5 / 92.5 / 90 %, gain 0.5–1.5 92.5–97.5 %,
    4:2:0 95 %, layout jitter 2 / 6 / 10 mm 95 / 85 / 80 %.
  - A ball in front of the cue ball: 88.8 % (80 photos); light cloths 80/80.
  - Grey cloth, by tint S: 0 33 %, 0.04 29 %, 0.08 67 %, 0.10 79 %, 0.12 96 %; never an ok fit off
    tolerance, never "too dark".
  - FR-121: the cue ball moved 8–20 cm 78/80 "moved"; the target moved 22/24; a shot played since
    the table photo: no ok fit with a wrong guide in 160 runs; static photos never "moved" in the
    envelope tests.
  - Time per 960×720 photo: median ≈ 104 ms, p95 ≈ 250 ms (wall, Node; before: 61 and 140 ms). The
    the device budget is 250 ms per 960×720 photo; the tests guard it relative to fits measured in the same run (failing photos p95 < 4 × the successful-fit median, envelope p95 < 2.75 × its median) with a 500 ms CI backstop (device budget × the CI factor 2 of perf.test.ts); a 1280 px
    photo stays inside SC-109's 500 ms. The slow tail is wide-angle and snooker photos (5–6 k
    hypotheses).
- **Known limits** (Constitution II):
  - untinted grey cloth (S ≤ 0.06): the shaded cue ball has the cloth's own grey, so ≈ 30 % line up;
    the failures are honest (no cue ball, no fit) and the two taps fit. Reaching 90 % needs a
    different cue-ball cue (shading or specular) in the detector;
  - a charcoal cloth in a dark grey room: the room shares the cloth's neutral band and outgrows its
    region, so the photo may read "no cloth";
  - a target camouflaged in the cloth (green on green) cannot trigger "moved" when it moves or is
    pocketed: plain cloth is no evidence of its absence;
  - a rare strike-dot residual on a small cue ball: one random-envelope photo fits with ghost 0.08 %
    but the dot 0.23 R off (confidence 0.52); the hypotheses never seed its true basin;
  - rare false "moved": 1 of 77 static untinted grey photos, and 2 snooker photos at the envelope's
    extreme corner (HFOV 100°, 8 cm up, 1.2 m back) pinned by 3 balls and crossing cushion lines;
  - a whole layout moved around a cue ball that stayed: "moved" in ≈ 2/3 of photos, otherwise
    "couldn't line up" (no correct pose exists then); never an ok fit with a wrong guide;
  - the cue ball out of frame: the photo is not yet fitted from the other balls (the reason is "can't
    find the cue ball" or "couldn't line up");
  - two-ball fits whose second ball has a repeated colour fail honestly and ask for the taps.
- **Alternatives rejected**:
  - PnP from ball centres alone (EPnP and the like): needs ≥ 4 well-spread correspondences and known
    association. At table level, balls are often nearly collinear in depth, and the association is
    the hard part.
  - Learned pose regression: needs a dataset and a model runtime (Principle VII).
  - Vanishing points from cushion lines alone: the rails are often out of frame or occluded at table
    level.
  - A generic "moved" rule (two balls missing, or one missing and a circle unexplained): "moved" on
    30 of 146 static envelope runs and 2–3 of 117 static grey photos.
  - For the false "moved" in the extreme corner: requiring a non-minimal pose, or a nearby-circle test
    for missing balls; neither separated them, both were reverted.
  - Two other grey-band variants for untinted cloth: measured worse.
  - A plain-cloth brightness check in the "missing ball" test: it changed no outcome in the sweeps
    and was dropped.

## R-25 Manual two-tap fallback

- **Decision**: the player taps the cue ball, then the target ball.
  1. Each tap seeds the association for that ball id.
  2. A local circle fit runs in a window around the tap (radius 8 % of the diagonal) to get the
     centre and radius. If it fails, the tap is the centre and the radius residual is dropped.
  3. The same LM runs with stronger priors: roll 0 ± 5°, height 0.2 ± 0.15 m, yaw within ±30° of the
     cue→target direction, the focal prior. Two balls give up to 6 equations, plus the priors, for 7
     unknowns.
  4. Associations are then re-run, so any other ball found automatically adds constraints, and the
     solver refines.

  Confidence is capped at 0.7 when only the two tapped balls constrain the fit, and it is always
  shown.
- **Rationale**: two taps are the least a player can do. With the apparent radii they fix depth, and
  with a level phone they fix the pose well enough to draw the aim line (SC-108).

## R-26 Drawing the strike point on the cue ball

- **Decision**:
  - **Geometry**: `strikePoint(c, aimDir, side, vert, R)`. Take the level cue axis along `aimDir`,
    offset by `side·R` to the shooter's right (`(aimDir.y, −aimDir.x)`) and `vert·R` up. Intersect it
    with the sphere on the *back* side:
    `P = c − aimDir·R·√(1 − side² − vert²) + side·R·right + vert·R·ẑ`, so `|P − c| = R`.
  - **Dot**: projected with the pose, as a filled `PALETTE.aim` disc of the tip's size (tip Ø 13 mm →
    ≈ 0.23 R) with a white halo and a dark outer stroke.
  - **Context drawn on the sphere and then projected**, so perspective is right even when the camera
    is off the cue axis:
    - the miscue-limit ring (the 3D circle of points at offset 0.5 R, dashed);
    - a centre cross (the vertical and horizontal arcs through the back pole);
    - ¼-tip ticks.
  - **Text label**: e.g. "Strike ½ tip below centre, ¼ tip right" from 001 `describeSpin` (1 tip = ¼ R).
  - **Inset**: a magnified (2.5×) crop of the cue ball from the photo, with the same drawing.
  - **Visibility**: P is visible when (P − C)·(P − c) < 0. When it is hidden or off-frame, the guide
    shows the strike point on the shaded spin ball (`renderSpinBall`) with the message from FR-119.
- **Rationale**: the dot is where the player's tip must touch, seen from where they stand. The text
  and spin ball give a redundant encoding (Principle VI).

## R-27 iOS wrapper: Capacitor 8 (dev-only npm), no plugins

- **Decision**: Capacitor 8 with `@capacitor/cli`, `@capacitor/core` and `@capacitor/ios` as
  **devDependencies pinned exactly to 8.6.0** (verified on npm; the CLI requires Node ≥ 22).
  - **iOS project**: the Capacitor 8 default Swift Package Manager template (no CocoaPods), committed
    under `ios/`. Minimum **iOS 16.0** (revised 2026-11-15: the UI's CSS container queries need
    Safari and WKWebView 16).
  - **Config**: `capacitor.config.ts` (appId `com.cuesight.app`) with `webDir: "dist"`, no
    `server.url` (bundled assets only), and the background colour `#070B14`.
  - **No plugins**, and app code never imports `@capacitor/core`. The native bridge injects
    `window.Capacitor`, and feature detection reads that global. The web bundle keeps **zero runtime
    npm dependencies**.
- **Rationale**:
  - Capacitor serves assets from `capacitor://localhost`, a secure context. `getUserMedia`, module
    workers and service-worker-free offline loading all work there. Plain `file://` would break
    workers and the camera.
  - It configures WKWebView correctly. Verified in the 8.6.0 sources: `allowsInlineMediaPlayback =
    true`, and the media-capture permission delegate grants the per-origin prompt, so only the
    system camera prompt appears.
  - It handles safe areas, the status bar and `cap sync`, and it was the planned path (001 R-01).
- **Native runtime dependency**: the Capacitor Swift package (`capacitor-swift-pm` 8.x) is linked
  into the iOS binary. It is justified here and listed in plan.md Complexity Tracking.
- **Alternatives rejected**:
  - **Hand-written WKWebView shell**: ~200 lines of Swift, but we would own a `WKURLSchemeHandler`
    (MIME types, range requests), permission delegates, safe areas and keyboard behaviour that
    Capacitor already gets right.
  - **PWA only**: the user asked for TestFlight, and store presence matters for trust.
  - **Cordova**: legacy, CocoaPods-based.
  - **Tauri 2 mobile**: adds a Rust toolchain to CI for no gain here.
  - **React Native WebView**: a whole JS runtime for a wrapper.

## R-28 Camera and photos inside WKWebView

- **Decision**:
  - **Live**: `getUserMedia` works in WKWebView on iOS 14.3+, with
    `<video playsinline muted autoplay>`. Capacitor sets inline playback, so the 001 camera module
    needs no change.
  - **Snap**: uses the file inputs (R-22). In WKWebView, "Take Photo" presents the system camera, and
    "Photo Library" uses the system picker, which needs no library permission on iOS 14+.
  - **Info.plist**:
    - `NSCameraUsageDescription` (required): "CueSight uses the camera to see the table and the balls
      so it can show you the shot. Photos and video stay on your phone."
    - `NSPhotoLibraryUsageDescription` (defensive, for older picker paths): "Choose a photo of your
      table to plan a shot. Photos stay on your phone."
    - `ITSAppUsesNonExemptEncryption = NO`.
  - **Simulator**: there is no camera. `getUserMedia` rejects, which triggers the 001 fallback, and
    the camera input falls back to the photo library. When no `videoinput` device exists, the app
    starts in Practice.
- **Rationale**: the same code path on the web and in the app. No camera plugin, so no runtime
  dependency.

## R-29 CI on GitHub-hosted macOS runners

- **Decision**: one workflow at the **git root** (`/`; the app lives in `cuesight/`, so
  `defaults.run.working-directory: cuesight`). *As built (2026-11-15):* the file is
  `.github/workflows/cuesight-ios.yml`. It runs on pushes to `main` and `claude/**`, on pull requests
  into `main` (a pull request from a `claude/**` branch of this repository is covered by that branch's
  push run) and on `workflow_dispatch` (input `upload: boolean`, off by default). A newer run cancels
  a superseded one on the same branch or pull request, except runs that may upload, which have their
  own never-cancelled group. The jobs as built are `web` (typecheck, Vitest, `vite build`, sizes),
  `chromium-e2e` (`npm run e2e`), `ios-simulator` (`scripts/ios-sim-smoke.sh`), `webkit-e2e` and
  `testflight`; [docs/ios.md](../../docs/ios.md) describes them. The original design follows.
  1. **`web`** (ubuntu-latest, Node 22): `npm ci`, `typecheck`, `test`, `fixtures`, `vite build`, and
     the Chromium e2e suite (SwiftShader WebGL flags).
  2. **`ios-simulator`** (macOS image with Xcode 26; the job prints `xcodebuild -version`):
     1. `npm ci`, then `VITE_CUESIGHT_TOUR=1 npx vite build`, then `npx cap sync ios`.
     2. Build:
        `xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Debug -sdk iphonesimulator -destination "id=$UDID" -derivedDataPath build/ios CODE_SIGNING_ALLOWED=NO build`.
        `$UDID` is the first available iPhone simulator on the newest iOS runtime, chosen from
        `xcrun simctl list devices available -j`.
     3. `simctl boot` + `bootstatus -b`, status-bar override (9:41, full battery), `simctl install`.
     4. Launch with `simctl launch --console-pty` (a pty, so Swift's `print` is line-buffered), with
        output tee'd to `sim.log`.
     5. **Smoke test**: the app logs `[CueSight] ready` (Capacitor forwards `console.*` to native stdout
        as `⚡️  [info] - …` in Debug builds, verified in the 8.6.0 sources). The job fails if the marker
        doesn't appear within `READY_TIMEOUT` after a launch: 90 s by default (revised from 60 s; the
        first CI run reported ready after 22 s), checked after every launch (default, Practice,
        Snap).
     6. **Screenshot tour**: the build-time flag `VITE_CUESIGHT_TOUR` makes the app step through
        Practice Overview → Player view → Broadcast → Snap (bundled sample photos, FR-123) → guide. It
        logs `[CueSight] tour <step>` at each step. CI runs `simctl io screenshot` on each marker.
     7. Logs and screenshots are uploaded as artifacts.
  3. **`webkit-e2e`** (macOS): `npx playwright install webkit`, then `playwright test
     --project=webkit-iphone` (an iPhone device profile). The live-camera spec is skipped on WebKit,
     which has no fake camera. Practice, Snap (with `setInputFiles`) and UI specs run.
  4. **`testflight`** (macOS; needs `web`, `chromium-e2e`, `ios-simulator` and `webkit-e2e`; runs
     only for a push to `main` or a manual run with `inputs.upload`, in its own never-cancelled
     concurrency group) — see R-30.
- **Rationale**: the tour flag gives deterministic screenshots without an XCUITest target. It is a
  compile-time define, so release builds never contain it. Picking the simulator at run time survives
  runner-image updates.
- **Alternatives rejected**:
  - An XCUITest target: more Xcode project surgery, slower, and it can't see inside the web view
    without accessibility plumbing.
  - Appium: heavy.
  - Self-hosted Macs: not available.

## R-30 TestFlight upload with an App Store Connect API key

- **Decision**: `xcodebuild` only, with no fastlane or altool.
  1. A first step checks that the secrets `APP_STORE_CONNECT_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID`,
     `APP_STORE_CONNECT_KEY_P8` (base64 of the `.p8`) and `APPLE_TEAM_ID` are present, through `env`.
     GitHub does not allow `secrets` in a job-level `if`. It sets an output. When they are missing,
     every later step is skipped and the job prints `::notice::TestFlight upload skipped — App Store
     Connect secrets are not configured`.
  2. The key is decoded to `$RUNNER_TEMP/AuthKey.p8` (mode 600) and deleted in an `always()` step.
  3. Release web build (no tour flag), then `cap sync ios`.
  4. `xcodebuild archive` with `-scheme App -configuration Release -destination
     'generic/platform=iOS' -archivePath build/App.xcarchive -allowProvisioningUpdates
     -authenticationKeyPath … -authenticationKeyID … -authenticationKeyIssuerID …` and the settings
     `DEVELOPMENT_TEAM`, `CODE_SIGN_STYLE=Automatic`, `PRODUCT_BUNDLE_IDENTIFIER=${{ vars.IOS_BUNDLE_ID
     }}`, a strictly increasing build number and `MARKETING_VERSION` from `package.json`. As built,
     `scripts/ios-testflight.sh` runs these steps; the build number is `<run number>.<run attempt>`
     and the `.p8` may be given as PEM text or base64.
  5. `xcodebuild -exportArchive -exportOptionsPlist ios/ExportOptions.plist` with `method =
     app-store-connect`, `destination = upload`, `signingStyle = automatic`, `teamID` and
     `uploadSymbols = true`, plus the same authentication flags. This uploads straight to App Store
     Connect, and the build then appears in TestFlight after processing.
- **App Store Connect prerequisites** (one-time, manual):
  - an app record with the bundle ID;
  - a Team API key. The **Admin** role lets Xcode create a cloud-managed distribution certificate on a
    fresh runner. App Manager is enough only when signing assets already exist. Verify on the first
    run.
- **Rationale**: the smallest toolchain, which is Apple's supported path. The API key avoids Apple ID
  passwords and two-factor prompts. Secrets never reach pull requests from forks.

## R-31 Icon pipeline: headless Chromium rasterisation

- **Decision**:
  - **Master**: `public/icon.svg` is the vector master. It is full-bleed square, with the artwork
    designed to survive the iOS mask and the maskable safe zone.
  - **Rasterising**: `scripts/make-icons.cjs` uses the pre-installed Playwright Chromium
    (`require('playwright')`, deviceScaleFactor 1). It draws the SVG into a `<canvas>` at each target
    size, reads the pixels with `getImageData` and returns them to Node.
  - **Encoding**: Node encodes PNGs with an in-house encoder (the `scripts/png.ts` approach, extended
    with an RGB colour type):
    - `icon-192`, `icon-512`, `favicon-32`: RGBA.
    - `icon-maskable-512`: artwork scaled to the central 80 % on the full-bleed background.
    - `icon-180` (apple-touch) and `AppIcon-1024`: **RGB, no alpha channel**, because App Store
      validation rejects alpha.
  - **Small sizes**: the favicon MAY use a simplified small-size variant.
  - **Output**: committed to the repo. A unit test parses each PNG's IHDR to check the size and colour
    type.
- **Rationale**: no new dependencies (sharp, resvg and ImageMagick are not available or are native).
  Chromium's SVG renderer is the reference renderer for the PWA anyway.

## R-32 Design system implementation ("Midnight Felt")

- **Decision**:
  - CSS custom properties on `:root`, exactly as listed in data-model.md, with `color-scheme: dark`.
  - Glass panels use `backdrop-filter` and `-webkit-backdrop-filter`, with
    `@supports not (backdrop-filter: blur(1px))` → `--surface-solid`.
  - Motion tokens `--dur: 200ms; --ease: cubic-bezier(.2,.8,.2,1)`. Under
    `prefers-reduced-motion: reduce`, `--dur: 0ms`, and JS reads the same media query for camera
    flights.
  - Icons are inline SVG built with `createElementNS` (24 px grid, 1.75 px round strokes,
    `currentColor`).
  - The bottom sheet uses pointer drag with two snap points (peek and expanded), and a handle button
    with `aria-expanded` for keyboard and screen-reader users.
- **Contrast rules** (computed against `--bg #070B14`):
  - `--text` 18.2:1, `--text-2` 9.3:1, `--accent` 8.5:1, `--warn` 8.7:1, `--danger` 5.1:1, `--ok`
    5.7:1.
  - **`--text-3` is only 4.3:1** (3.8:1 on `--surface-solid`). It is for large text (≥ 24 px) or
    non-essential, decorative text only. Captions use `--text-2`.
  - Buttons filled with `--accent` use dark text (`--bg`, 8.5:1). White on `--accent` is only 2.3:1.
    White text needs `--accent-2` (5.2:1).
- **Rationale**: no framework or runtime dependency. Tokens make the camera overlay, 3D view and cards
  one product.

## R-33 Testing strategy for 002

- **Decision**:
  - **Pure modules** (Vitest, Node):
    - `render3d`: math, camera presets and clamps, picking, playback timing and rotation, plan
      geometry and cue placement, the gesture state machine;
    - `vision/player-view`: projection, silhouettes, strike point, the estimator on synthetic photos;
    - `vision/player-detect`: cloth candidates (grey included), circles on touching and merged
      blobs, colour and exposure, noise speckle (`tests/unit/vision/player-detect.test.ts`);
    - the Snap session state machine;
    - the icon headers.
  - **Synthetic player photos**: `vision/synth/render.ts` already supports any camera pose and FOV.
    Table-level scenes come from a fixed, deterministic grid (heights 8–40 cm, distances 0.3–1.2 m,
    yaw ±15°, HFOV 40–100°, 3 cloths). "Low light" frames are post-processed in the test helper with
    gain and deterministic noise. Negative scenes: one ball visible, balls moved, too dark.
    *Since the player-photo merge*, `tests/integration/player-view-envelope.test.ts` covers the whole
    SC-106 envelope (an L18 orthogonal array over table, HFOV, height, distance, yaw, roll and
    occlusion at 960×720 and 1280×960, with and without the app's hints), plus lens changes, grey
    and light cloths, exposure, noise, 4:2:0, layout error, FR-121 and the reasons; and
    `tests/integration/player-view-honesty.test.ts` checks SC-107 and FR-121 on random layouts and
    continuous poses, the grain reasons and the per-photo CPU budget.
  - **Browser** (Playwright):
    - Chromium with SwiftShader (`--use-angle=swiftshader --enable-unsafe-swiftshader
      --ignore-gpu-blocklist`) proves the WebGL2 path, using `toScreen` taps and pixel probes.
    - `?renderer=2d` proves the fallback.
    - Snap uses `setInputFiles` with PNG fixtures from `scripts/make-snap-fixtures.ts`.
    - WebKit with an iPhone profile runs on macOS CI.
  - **iOS**: the Simulator smoke test and screenshot tour (R-29).
- **Rationale**: Principle III. Every new algorithm has ground truth, and GPU code is checked through
  its observable projection.
