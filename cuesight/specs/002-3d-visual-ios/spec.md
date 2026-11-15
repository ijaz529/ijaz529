# Feature Specification: 3D Table, Two-Photo Snap Guide, Polished UI and iOS App

**Feature Branch**: `002-3d-visual-ios`

**Created**: 2026-11-14

**Status**: Implemented on `fix2b/app` (wave 2b). Clarified again on 2026-11-15 after the code review
and the wave-2 fixes (see "Session 2026-11-15" below).

**Builds on**: [001 Real-Time Shot Guide](../001-realtime-shot-guide/spec.md) (complete). Every 001
requirement still holds unless this spec says otherwise.

**Input**: User description: "I want to do a visual pass of the app. Make it look nice and polished
and in 3d. Run the app on a simulator, test everything, make a nice app icon and send to testflight
too. For functioning, im thinking like you can either take a full picture of the table, and then also
take a picture from the players perspective, facing the cue ball on table level, and it shows where to
hit the ball and with how much power."

## Clarifications

### Session 2026-11-14

These were resolved with the defaults agreed for this feature. No `/speckit-clarify` questions are
outstanding.

- Q: Does the live camera mode (001 US2) stay? → A: Yes. The top-level modes become **Live · Snap ·
  Practice**. Live is the 001 camera overlay, restyled. Snap is new. Practice becomes the 3D table.
- Q: What does each Snap photo contribute? → A: The **table photo** gives the layout: where every
  ball is. The **player photo** only gives where the phone was. The app never reads ball positions
  from the player photo; it uses that photo to find the camera, so the guide can be drawn on it.
- Q: Does the app read the player's cue or stroke from the player photo? → A: No. As in 001, the app
  *prescribes* the line, the strike point and the power. It does not measure the stroke.
- Q: How are side and vertical tip offsets drawn on the cue ball? → A: From the shooter's view:
  `side > 0` is right english and `vert > 0` is follow (top). The strike dot sits on the face of the
  cue ball that faces the player. One tip is 0.25 R (as in 001): about 7 mm on a pool ball, so the
  0.5 R miscue limit is 2 tips. The card details give the offset in mm as well.
- Q: How is power communicated in Snap? → A: Exactly as in 001: 1–10, a speed word and a visual meter.
- Q: Which table types get the 3D table? → A: Every 001 preset. Pool tables show numbered solids and
  stripes. The snooker table shows snooker colours, the baulk line, the D and the spots.
- Q: How are balls in the two photos matched? → A: By position. The layout comes from the table
  photo; the cue ball is the white one. Ball numbers are not recognised (as in 001).
- Q: What is the iOS delivery target? → A: TestFlight (internal testing), uploaded by CI. App Store
  review and public release are out of scope.
- Q: What if no Apple credentials are configured? → A: CI still builds, tests and screenshots the app
  in the iOS Simulator. Only the archive and upload steps are skipped, with a clear notice.
- Q: Can the 3D renderer use a library such as three.js? → A: No. Runtime dependencies stay at zero
  (Principle VII). Research R-15 records the decision.

### Session 2026-11-15 (post-review)

These record what the reviewed implementation does.

- Q: How long does a replay last? → A: The balls' motion takes at most 4 s (longer shots are sped up
  evenly). A 0.5 s strike lead-in comes before it, and the end position is held 3.5 s for study (×1.8
  with reduced motion). One tap on the table, Skip or Escape ends it at once. So "at most 4 s" is the
  motion, not the whole replay (FR-108, US1-AS5).
- Q: Is the tip unit still 0.25 R? → A: Yes, decided and kept (001 T082): 1 tip = ¼ R ≈ 7 mm on a pool
  ball, 2 tips = the 0.5 R miscue limit, and the card details give mm.
- Q: Which iOS version? → A: iOS 16 or later. The UI uses CSS container queries, which need Safari and
  WKWebView 16; the Xcode project's deployment target is 16.0 (FR-132).
- Q: When does CI upload to TestFlight? → A: Only for a push to `main` or a manual run with upload
  ticked (off by default), and only after the web, Chromium e2e, WebKit e2e and Simulator jobs pass
  (FR-136).
- Q: What is the Snap fit's confidence about? → A: The target ball the fit was made for. Changing the
  target fits the same photo again; after a two-tap fit the player taps again. Changing the pocket or
  the stroke keeps the fit (FR-116).
- Q: What size are Snap photos processed at? → A: 960 px on the long side (`snap/photo.ts`
  `SNAP_MAX_DIM`). The 1280 px figures below are the test fixtures' size.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Study the shot on a 3D table (Priority: P1)

The practice table becomes a realistic 3D table: wood rails, cloth with a subtle weave, cushions,
pockets, diamond sights, glossy numbered pool balls (or snooker colours), soft contact shadows and
overhead-lamp lighting. The player orbits, pinches to zoom and pans with two fingers. Three camera
presets help:

- **Overview**: top-down.
- **Player view**: the eye low behind the cue ball, looking down the aim line.
- **Broadcast**: a 3/4 view.

The player taps a ball and a pocket, and drags balls to move them, as on the 2D table. The full 001
shot plan is drawn in 3D: aim line, ghost ball, contact point, object-ball path, cue-ball path, pocket
highlight, landing marker and position heatmap. A cue stick sits behind the cue ball. Its tip touches
the recommended strike point (spin), and it is pulled back in proportion to the power. **Play shot**
replays the simulated shot in real time, and the balls roll with the correct rotation.

**Why this priority**: it is the visual heart of the "make it 3D" request, and it turns the planner
into something a player can *see* from their own eye line. It needs no camera, so it is the fastest
way to show the product, on a phone or in a store screenshot.

**Independent Test**: open Practice on a WebGL2 device. Select the *30° cut* drill's ball and pocket.
Check that the 3D plan matches the 2D plan's numbers. Switch through the three presets. Play the shot
and check that the balls end where the plan says. Force the 2D fallback and check that everything
still works.

**Acceptance Scenarios**:

1. **Given** a device with WebGL2, **When** the player opens Practice, **Then** the 3D table renders in
   the Overview preset within 2 s. It shows rails, cloth, cushions, six pockets, diamonds, every ball
   with its number or colour, and soft shadows.
2. **Given** the 3D table, **When** the player drags on empty cloth, **Then** the view orbits. Pitch
   stays between 8° and 89°, and the camera control shows "Custom". Pinching or the mouse wheel zooms,
   and a two-finger drag pans. A double-tap on empty cloth returns to the last preset.
3. **Given** the 3D table, **When** the player taps a ball and then a pocket, **Then** the same plan as
   001 is drawn in 3D, and the shot card shows the same numbers as the 2D table for the same layout
   (for example, "30.0°" on the *30° cut* drill).
4. **Given** a plan, **When** the player chooses Player view, **Then** the camera moves to eye level
   behind the cue ball, looking down the aim line. The move is animated unless reduced motion is on.
   The cue stick is drawn behind the cue ball, its tip at the recommended side and vertical offset,
   pulled back further for more power.
5. **Given** a plan, **When** the player taps Play shot, **Then** every ball the simulation moves
   travels its path in real time. The balls' motion takes at most 4 s (longer shots are sped up
   evenly); a 0.5 s strike lead-in comes before it and the end position is held 3.5 s (×1.8 with
   reduced motion). A ball's numbers turn the way a rolling ball turns, without skidding, once it
   rolls. A pocketed ball drops into the pocket. One tap on the table, Skip or Escape ends the replay
   at once and shows the planned layout, as does the end of the hold.
6. **Given** the 3D table, **When** the player drags a ball and releases it, **Then** the ball stays
   where it was dropped, inside the cushions and not overlapping another ball, and the plan updates
   within 0.1 s.
7. **Given** a position-play target or heatmap (001 US5), **When** it is active, **Then** the landing
   marker and the heatmap are drawn on the 3D cloth.
8. **Given** a device without WebGL2, or a 3D view that fails or loses its GPU context for good,
   **When** Practice opens, **Then** the 001 2D table appears with every feature working, and a
   one-line note says the 3D table isn't available on this device.

---

### User Story 2 - Snap: two photos, then "hit it here, this hard" (Priority: P1)

The player's own idea. In **Snap** mode:

1. **Table photo.** The player photographs the whole table, with the camera or from the photo
   library. The app finds the table and the balls with the 001 pipeline and shows them on the photo.
   The player confirms or fixes the layout, then taps the target ball (and a pocket if they want one).
   The app plans the shot.
2. **Player photo.** The player crouches behind the cue ball at table level and takes a second photo
   from their own point of view. The app works out where the phone was, using the layout it already
   knows. It then draws on that photo:
   - **where to aim**: the aim line on the cloth from the cue ball to the ghost ball, the ghost ball,
     and the object ball's path into the pocket;
   - **where to strike the cue ball**: a dot drawn on the visible face of the cue ball at the
     recommended tip offset, with the miscue limit and words such as "½ tip below centre";
   - **how hard**: power 1–10, a speed word and a meter.

If the app can't work out the phone's position, it says why in plain words. It then asks the player
to tap the cue ball and the target ball in the photo, and draws the guide from those two taps.

**Why this priority**: it answers the core question ("where do I hit it, and how hard?") from the
player's real eye line on a real table. It avoids the hardest problem of live table-level AR: at
table level the whole table is never in view. It reuses the 001 detector where it works best (the
overview photo) and adds one new algorithm (pose from a known layout).

**Independent Test**: feed a synthetic table photo and a synthetic table-level player photo with
known ground truth, through the photo picker. Check that the layout is found, that the guide's ghost
ball and strike dot land within tolerance of ground truth on the player photo, and that a hopeless
player photo leads to the two-tap fallback instead of a wrong guide.

**Acceptance Scenarios**:

1. **Given** Snap mode, **When** the player takes or picks a photo of the whole table, **Then**
   within 3 s the photo shows the detected table outline and every ball, with the cue ball marked,
   and the app asks the player to confirm the layout.
2. **Given** a detected layout with a missing, extra or misplaced ball, **When** the player drags,
   adds or removes a ball or marks the cue ball, **Then** the edited layout is used for planning.
3. **Given** a table photo where automatic table detection fails, **When** the player chooses
   *Tap corners* and taps the four playing-surface corners on the photo, **Then** the table and balls
   are found and the flow continues. *Retake* is always offered too.
4. **Given** a confirmed layout, **When** the player taps the target ball (and optionally a pocket),
   **Then** the 001 plan is shown in the shot card, and the app prompts: "Now crouch behind the cue
   ball and take a photo at table level, with the cue ball and your target in the picture."
5. **Given** a player photo showing the cue ball and at least two other balls, **When** it is
   processed, **Then** within 2 s the photo shows, in perspective:
   - the aim line on the cloth from the cue ball to the ghost ball, and the ghost-ball outline;
   - the object-ball path to the highlighted pocket;
   - the strike dot on the cue ball's face, with the miscue ring and the spin in words;
   - power 1–10, a speed word and a meter;
   - a confidence indicator.
6. **Given** a player photo where the automatic fit fails or its confidence is too low, **When** it is
   processed, **Then** the app does not draw a guide as if it were right. It says why ("I can't see
   enough balls — include the cue ball and two others") and asks the player to tap the cue ball and the
   target ball. After the two taps, the guide is drawn with its confidence shown.
7. **Given** a guide on the player photo, **When** the player changes the target, pocket, power or
   spin, **Then** the guide is redrawn on the same photo without retaking it.
8. **Given** a guide on screen, **When** the player takes another player photo from a new spot,
   **Then** the new photo is fitted against the same table layout, with no new table photo needed.
9. **Given** any Snap session, **When** the player leaves Snap or taps *Start over*, **Then** both
   photos are discarded. Photos are never stored or sent anywhere.

---

### User Story 3 - A polished, consistent look (Priority: P2)

The whole app adopts one design system, "Midnight Felt": a calm, premium, night-time pool-hall look
with a dark UI where the table is the hero. Controls float on frosted glass over a full-bleed stage
(the 3D table, the camera or the photo). A segmented control at the top switches **Live · Snap ·
Practice**.

On a phone in portrait, the shot card is a bottom sheet. Its peek height shows the headline: target
and pocket, cut, power and spin. The player drags it up for the details. In landscape and on tablets,
the card is a side panel. The shot card is redesigned:

- big numerals for cut and power;
- a fractional-aim graphic showing how much the two balls overlap;
- a 10-segment power gauge;
- a small shaded 3D cue ball showing the tip position.

A short hint welcomes first-time players. Every transition is smooth and respects reduced motion. The
app has a proper icon at every size (home screen, browser, iOS) and a branded splash while it loads.

**Why this priority**: the user asked for a polished look. It makes the 3D table and Snap feel like
one product, but the guidance works without it, so it is P2.

**Independent Test**: on a phone-sized viewport in portrait and landscape, walk through all three
modes. Check the tokens, the sheet's peek and expanded states, touch-target sizes, focus rings, the
reduced-motion behaviour and that every 001 end-to-end test still passes unchanged.

**Acceptance Scenarios**:

1. **Given** any mode, **When** the app is shown, **Then** it uses the Midnight Felt tokens, the system
   font and glass panels, and the top control reads "Live · Snap · Practice" with the active mode
   marked by more than colour alone.
2. **Given** a phone in portrait with a plan, **When** the card is at peek height, **Then** it shows
   target → pocket, cut, power and spin. **When** the player drags it up or taps its handle, **Then**
   it expands to the full card. In landscape, or at a width of 900 px or more, the card is a static
   side panel.
3. **Given** a plan, **When** the shot card renders, **Then** it shows the cut and power as big
   numerals, the overlap graphic, the power gauge with the minimum-power mark, and the shaded spin
   ball. Each has a text equivalent for screen readers.
4. **Given** a first launch, **When** the app opens, **Then** a dismissible hint explains the three
   modes. After dismissal it does not come back.
5. **Given** the system setting "reduce motion", **When** the player changes mode, opens the sheet or
   switches camera preset, **Then** the change is instant (no animated flight or slide).
6. **Given** the app installed to the home screen (PWA) or as the iOS app, **When** the icon is shown,
   **Then** it is the CueSight icon, crisp at that size. A branded splash appears while the app loads.
7. **Given** the redesign, **When** the 001 end-to-end tests run, **Then** they pass unchanged: same
   test ids, accessible names and texts.

---

### User Story 4 - A real iOS app, tested in the Simulator and on TestFlight (Priority: P2)

CueSight ships as an iOS app that wraps the same web app: bundled, offline, with no account. A CI
workflow on macOS builds it, runs it in the iOS Simulator, takes screenshots, runs the browser
end-to-end tests on WebKit with an iPhone profile, and, when App Store Connect credentials are
configured, uploads a signed build to TestFlight.

**Why this priority**: the user asked for a simulator run and TestFlight. The PWA already runs on
iPhone, so the store build is about distribution and trust, not new capability.

**Independent Test**: run the iOS workflow on a clean macOS runner with no secrets. It must pass and
attach Simulator screenshots. Then add the App Store Connect secrets and run it again; the build must
appear in TestFlight.

**Acceptance Scenarios**:

1. **Given** the repository, **When** the iOS workflow runs on a macOS runner, **Then** it:
   - builds the web app and copies it into the iOS project;
   - builds the app for the iOS Simulator, installs it and launches it;
   - fails if the app does not report that it is ready within `READY_TIMEOUT` (90 s by default; the
     first CI run reported ready after 22 s), checked after every launch (default, Practice, Snap);
   - saves screenshots of Practice (3D) and Snap as workflow artifacts.
2. **Given** the same workflow, **When** the WebKit end-to-end job runs with an iPhone profile,
   **Then** the Practice, Snap and UI end-to-end tests pass.
3. **Given** App Store Connect API key secrets, **When** the workflow runs on the main branch or is
   started by hand with upload on, **Then** it archives a signed Release build with a new build number
   and uploads it to TestFlight.
4. **Given** no secrets, **When** the workflow runs, **Then** archive and upload are skipped with a
   visible notice, and the workflow still passes.
5. **Given** the iOS app on a device, **When** the player first uses Live or the Snap camera, **Then**
   iOS asks for camera permission with a plain-language reason. If the player says no, the 001 fallback
   applies (practice table), and Snap still offers the photo library.
6. **Given** the iOS app, **When** it runs in airplane mode, **Then** every mode works. The app makes
   no network requests at all.

---

### Edge Cases

**3D table**

- WebGL2 unavailable, blocked or failing to create a context → the 2D table (FR-110). A setting and
  the URL parameter `?renderer=2d` force the fallback (for testing and for players who prefer it).
- GPU context lost (backgrounded app, memory pressure) → the 3D view restores its resources on
  `webglcontextrestored` and redraws. If restoring fails, it falls back to 2D without losing the layout.
- Low-end GPU → the pixel ratio is capped (default 2) and effects degrade, never the plan drawing.
- Snooker with 22 balls → the scene still renders at the frame budget (SC-101).
- The player drags a ball onto another ball or into a pocket → the ball is clamped inside the cushions
  and pushed clear of other balls, as in 001.
- A plan changes during playback (the player taps something) → playback stops first, and the layout
  returns to its planned state.
- Shots that last more than 4 s in the simulation → the replay is sped up evenly to finish in 4 s, so
  every ball still reaches its true rest position.
- Player view preset when the cue ball is frozen to a rail → the eye stays 0.5 m behind the cue ball
  down the aim line, at least 7 cm above the cue's rail-clearing line, so beyond the rail when the
  ball is frozen to it.
- Snooker, a ball touching the cue ball → the 3D label reads "Not makeable · touching ball" with "Play
  away from it (a push is a foul)"; the card shows the planner's push-stroke reason (001).

**Snap**

- The table photo misses part of the table, or has glare → no table, or a table cut off by the
  border that vision cannot complete, gives "The whole table must be in the photo — step back or turn
  the phone and retake it. All four corners already in view? Tap them." Balls hidden from view are not
  invented. A table with one end cropped off is completed and accepted (measured on 15–28 % side crops
  of the sample: 9/9 balls, max error 6 mm, "9 balls · good"). A near rail touching the bottom border
  gives the no-table message.
- Tapped corners → four taps that cannot be a table outline (three on one rail, two on one spot, a
  sliver) are refused before the photo is processed again: "Those four taps aren’t the cloth corners —
  tap them again." (Live's words). Corners the still pipeline refuses get the same text (`bad-quad`),
  or "Couldn’t tell the cloth from its surroundings — tap the four cloth corners again, or retake the
  photo." (`cloth-unknown`). A loose quad opens the review with "Your four corners don’t quite match
  the cloth — check the layout, or tap the corners again."
- Table detection itself fails while a Snap photo is processed (the vision worker dies) → Snap says
  so, and the next photo or tap starts a new worker:
  - table photo, the worker never answered: "Table detection couldn’t start — it may not be
    available offline yet. Reconnect, then retake the photo or choose it again.";
  - table photo, the worker had answered: "Table detection stopped working on this photo. Retake it
    or choose it again to try once more.";
  - player photo: the two-tap step with "Table detection stopped working on this photo. Tap the cue
    ball, then your target, to try again."
- Player photo with the cue ball **partly cut off** at the frame edge → the ball is fitted from its
  visible arc. If the strike point falls outside the photo, the app says so ("The strike point is just
  below the photo — tilt up a little") and shows the strike point on the shaded spin ball instead.
- Cue ball **not visible** in the player photo → the pose can still come from other balls and the
  cushions. The aim line and ghost ball are drawn. The strike point is shown on the spin ball, with
  the message "Include the cue ball in the photo to see where to strike it". *Not yet met on
  `rc/release`*: a photo without the cue ball is not fitted from the other balls; it fails with "I
  can't find the cue ball…" (or "I couldn't line up this photo…") and offers the two taps.
- Target ball hidden behind another ball in the player photo → the aim line and ghost ball are still
  drawn from the known layout, and the hidden part of the path is dashed and labelled "hidden".
- **Low light** or a noisy photo → detection confidence falls. The app shows low confidence, suggests
  more light or a steadier phone, and offers the two-tap fallback. It never draws a guide it trusts
  less than the threshold as if it were right. The reasons say which: "The photo is too dark to read
  the table…" only for a dark photo or a dim cloth, and "The photo is too grainy to read the table…"
  only when sensor noise is what defeats the fit (cloth texture is not noise). Snap shows the reason,
  suggests a better photo and still offers the two taps.
- A photo with **no table cloth** in view (a wall, the floor, the photo aimed too high) → "I can't
  find the table cloth in this photo. Aim along your shot so more of the cloth is in view." The two
  taps are still offered. A grey cloth is found like any other colour.
- **Different zoom between the two photos** (for example 1× for the table, 0.5× or 2× for the player
  photo) → the focal length is re-estimated for the player photo. The table photo's focal length is
  only a soft hint, so a lens change does not break the fit: the fit sweeps the phone lenses
  (HFOV ≈ 110° to 26°) and its focal prior is heavy-tailed around the hint.
- The player photo is not taken from behind the cue ball (for example from the far side) → the fit
  can still succeed. The app says "You're not behind the cue ball" and still draws the guide.
- Balls moved between the two photos → the fit is poor or contradicts the layout. The app says "The
  balls seem to have moved — retake the table photo". This also stops a fit that would otherwise be
  good, when the target, the cue ball or any other ball is no longer where the table photo put it
  (FR-121). Snap then asks for a new table photo (Retake the table photo, or Start over) and does not
  offer the two taps, because a guide from the old layout would be wrong. Limits: a target
  camouflaged in the cloth (green on green) cannot be seen to be gone; when the whole layout moved
  around a cue ball that stayed, about a third of the photos say "I couldn't line up this photo"
  instead.
- Snap reason → next step (`snap/session.ts` `playerFailAction`): "moved" → retake the table photo;
  too dark, too grainy, no cloth → a better photo, with the two taps still offered; no cue ball, too
  few balls (fewer than three ball circles in the photo), no fit → the two taps. A failed fit never
  reports a confidence of 0.5 or more.
- Table photo **from video frames** (the in-app camera's frame, whose colour is often 4:2:0
  upsampled bilinearly) → ball detection reads the chroma's transition width and widens its
  dilation ring by itself (001 research R-04). Limit: on 960-px frames from such video the snooker
  end view loses a red that shows 28 % of its outline in 5 of 6 calibrations.
- Photo orientation → the app reads the photo's EXIF orientation itself and neutralises the tag
  before decoding, so no decoder turns the photo twice. Portrait and landscape photos are both
  upright.
- Very large photos (12–48 MP) or HEIC → the photo is decoded straight to the processing size (960 px
  on the long side) with `createImageBitmap` `resizeWidth`/`resizeHeight` when the header gives its
  size (JPEG, PNG) and the platform supports the options; otherwise the full-size bitmap is drawn once
  and closed at once. Only the scaled copy is kept, in memory.
- The device has no camera (desktop, iOS Simulator) → Snap uses the photo picker. Sample photos are
  offered so the flow can be tried without a table.

**iOS and CI**

- **No Apple credentials** configured → Simulator build, tests and screenshots still run. Archive and
  TestFlight upload are skipped with a notice. Forks and pull requests never see secrets.
- Camera permission denied in the iOS app → as in 001: explain, offer Practice, and keep Snap's photo
  library option.
- The CI runner's Simulator device list changes → the workflow picks an available iPhone simulator at
  run time instead of a hard-coded model.
- Build number collisions in App Store Connect → the build number comes from the CI run number, so it
  always increases.

## Requirements *(mandatory)*

### Functional Requirements

**3D practice table (US1)**

- **FR-101**: The system MUST render a 3D table for every table preset: wood rails, cloth with a subtle
  weave, cushions, six pockets, diamond sights on pool tables, and the baulk line, D and spots on the
  snooker table.
- **FR-102**: The system MUST render every ball as a glossy sphere: numbered solids and stripes for
  pool, snooker colours, a white cue ball. Balls MUST have soft contact shadows and overhead-lamp
  lighting.
- **FR-103**: The player MUST be able to orbit (drag on empty cloth or background), zoom (pinch or
  wheel) and pan (two-finger drag). Pitch MUST stay between 8° and 89°, and the view target MUST stay
  over the table.
- **FR-104**: The system MUST offer three camera presets:
  - **Overview**: top-down, fitted to the screen.
  - **Player view**: the eye low behind the cue ball, looking down the aim line.
  - **Broadcast**: a 3/4 view.

  The active preset (or "Custom" after an orbit) MUST be shown. A double-tap on empty cloth MUST
  return to the last preset. Preset changes MUST be animated unless reduced motion is on.
- **FR-105**: Tapping a ball, a pocket or the cloth MUST drive the same selection flow as the 2D table
  (001 FR-009). Dragging a ball MUST move it, clamped to the bed and pushed clear of other balls, with
  the plan recomputed within the 001 real-time budget.
- **FR-106**: The system MUST draw the shot plan in 3D with the 001 colour and line-style encoding:
  aim line, ghost ball, contact point, object-ball path, cue-ball path and other balls' paths, the
  pocket highlight, the rest and landing markers and the position heatmap. Labels MUST be readable
  text. The in-scene label keeps clear of every ball's disc (a ball weighs as much as ten line
  points; the label may slide up to 24 px) and of the floating Play / slow-motion buttons; in a
  cramped view (medium sheet, side spin) it can still cover a ball's edge.
- **FR-107**: When a plan exists, the system MUST draw a cue stick behind the cue ball along the aim
  line, near level and raised only as needed to clear the rail. Its axis MUST pass through the
  recommended strike point (side and vertical offset), and the gap between its tip and the ball MUST
  grow with power.
- **FR-108**: *Play shot* MUST replay the simulated trajectories of every ball in motion at real-time
  speed, passing every simulation event at its time. Motion longer than 4 s MUST be sped up evenly
  to last 4 s. A 0.5 s strike lead-in comes first, and the end position is held 3.5 s (×1.8 with
  reduced motion) so the player can study it; a tap, Skip or Escape ends the hold at once. A
  half-speed replay (½×) MAY be offered.
  - Ball rotation MUST be consistent with rolling: no slip while a ball rolls. It SHOULD also show
    the sliding-to-rolling transition after the strike and after impact, so stun, draw and follow
    look different.
  - Pocketed balls MUST drop into their pocket.
  - The replay MUST be skippable (button, tap, Escape) and MUST restore the planned layout when it
    ends.
- **FR-109**: The 3D view MUST draw frames only when something changes (camera move, data change,
  playback) and MUST be idle otherwise. The one exception is the Player view's three idle practice
  strokes of the cue (5.4 s after the stroke, the cue ball or the view changes; none with reduced
  motion), after which it is idle again.
- **FR-110**: When WebGL2 is unavailable, or the 3D view cannot be created or restored, the system MUST
  fall back to the 001 2D table with every feature, and say so in one line. A setting and the URL
  parameter `?renderer=2d` MUST force the fallback.

**Snap: two-photo guide (US2)**

- **FR-111**: In Snap mode, the player MUST be able to provide the table photo from the camera or the
  photo library. The photo's orientation tag MUST be honoured (the app reads the EXIF orientation and
  neutralises the tag before decoding), and the photo MUST be scaled to the processing size (960 px
  on the long side), decoded straight to it where the platform allows. Every failure MUST be said in
  player words: no table or a table cut off by the border, refused corner taps, a loose quad, and a
  failed detection worker (the Snap edge cases above).
- **FR-112**: The system MUST detect the table and the balls in the table photo with the 001 pipeline.
  It MUST show the outline and the balls over the photo, mark the cue ball and show the detection
  quality. The Snap 3D table takes its cloth colour from the table photo; a grey (neutral) cloth is
  rendered grey.
- **FR-113**: The player MUST be able to fix the detected layout (move, add or remove a ball, mark the
  cue ball), tap the four corners by hand when detection fails, and retake the photo. Add puts the
  ball on the free spot nearest the middle of the table (on the cloth, clear of every other ball),
  and the toast says "Ball added in the middle of the table." / "…near the middle…". In Snap it is
  unnamed (the neutral 'ball'), never a tag vision gave another ball.
- **FR-114**: The player MUST be able to pick the target ball and optionally a pocket, on the photo or
  on the table map. The system MUST plan the shot with the 001 planner and show the full shot card.
- **FR-115**: The system MUST then guide the player to take the player photo ("crouch behind the cue
  ball at table level, with the cue ball and the target in the picture"), from the camera or the
  photo library.
- **FR-116**: The system MUST estimate where the camera was for the player photo, using the confirmed
  layout and the table's known geometry. It MUST report a confidence from 0 to 1 and, on failure, a
  player-facing reason. The confidence is for the target ball the fit was made for: changing the
  target fits the same photo again (after a two-tap fit, the player taps again); changing the pocket
  or the stroke keeps the fit.
- **FR-117**: When the estimate succeeds, the system MUST draw on the player photo, in perspective:
  - the aim line on the cloth from the cue ball to the ghost ball, and the ghost-ball outline;
  - the contact point;
  - the object-ball path and the highlighted pocket;
  - the strike dot on the cue ball's visible face at the recommended side and vertical offset, with
    the miscue-limit ring, a centre cross, and the spin in words;
  - a magnified inset of the cue ball;
  - power as 1–10, a speed word and a meter;
  - the confidence.

  A plan with no ghost ball (a frozen cue ball) labels its stroke end on the photo, or its cue ball
  when that end is off the photo ("Frozen · stroke 12° left"; "Not makeable" goes on the cue ball), at
  the canvas scale. Photo labels never overlap: the aim label keeps clear of the "Strike here" label.
  The HUD under the photo words a frozen cue ball's aim as "Frozen: stroke N° to the left/right of the
  line of centres" (or "straight through"), with the same degrees and side as the card tile, the 2D
  and photo labels and the core warning, and the instruction reads "Frozen balls: aim the stroke, not
  a ghost ball. Strike … (the blue dot on the ball's face)." The HUD meter words the plan as the
  card's meter does, so it shows no power minimum while the frozen advice is pending or when no power
  works.
- **FR-118**: When the estimate fails or its confidence is below the threshold, the system MUST NOT draw
  the guide as if it were right. It MUST show the reason and offer the manual fallback: tap the cue
  ball and the target ball in the photo. After the two taps it MUST draw the guide and show its
  confidence.
- **FR-119**: The system MUST handle partial visibility. When the cue ball, the strike point or the
  target is outside the photo or hidden, it MUST draw what is visible, say what is missing and how to
  fix it, and show the strike point on the spin ball.
- **FR-120**: Changing the target, pocket or stroke MUST redraw the guide on the current player photo
  without retaking it. The player MUST be able to take further player photos against the same layout.
- **FR-121**: The system MUST warn when the player photo contradicts the layout ("the balls seem to
  have moved") and when the camera was not behind the cue ball.
- **FR-122**: Snap photos MUST be processed on the device, kept in memory only for the Snap session,
  never stored or sent, and discarded on *Start over* or on leaving Snap. The photo canvas and its
  thumbnail are cleared then too, and a photo still being decoded or loaded at that moment MUST be
  discarded when it arrives. Of several photos picked in a row, only the latest is used.
- **FR-123**: Snap SHOULD offer bundled sample photos (a table photo and a player photo of a synthetic
  table), so the flow can be tried without a table or a camera.

**Polished UI, icon and splash (US3)**

- **FR-124**: The whole UI MUST use the Midnight Felt design tokens and the system font stack. It MUST
  NOT load web fonts, icon packages or any remote resource.
- **FR-125**: A segmented control at the top MUST switch between Live, Snap and Practice. The body MUST
  expose the mode as `data-mode` (`camera`, `snap` or `practice`).
- **FR-126**: On portrait phones, the shot card MUST be a draggable bottom sheet. Its peek height MUST
  show target → pocket, cut, power and spin. In landscape, or at 900 px wide or more, it MUST be a
  static side panel. Safe-area insets MUST be respected. The card's wording, as implemented:
  - **Headline warning**: on a makeable card it is the warning's only copy (no chip repeats it). It
    wraps instead of ending in an ellipsis. At the peek it is clamped to 2 lines (the frozen power
    advice runs to 3–4 lines at 375–393 px) and the CUT / POWER / SPIN captions step aside; medium and
    expanded show all of it. `throw-uncompensable` is a headline warning, ranked with `ob-missed`.
  - **Frozen cue ball**: the cut tile reads "Frozen · N° · stroke left/right" (or "straight"), never
    "0° · full-ball hit". At the peek with a headline warning it shows "FROZEN" over "N° stroke
    left/right" or "0° straight". Screen readers hear "Balls frozen together." with no angle. The
    generic frozen hint is never shown or spoken next to a not-makeable reason.
  - **Not makeable with no other pocket**: the tip reads "No other pocket is clear for this ball: pick
    another ball or play a safety." When a warning on the card already says that, it reads "Pick
    another ball, or tap Suggest a shot."
  - A ball vision could not name is "Unnamed ball" in the card title, the ball picker and the
    announcer.
  - **Recommended-stroke notes** (one note line, only while the recommended stroke is shown):
    "This stroke may need precise pace: a little harder or softer could miss or scratch." (`fragile`, the same sentence as the toast), "Search cut short —
    the best stroke found in time." (`timedOut`), "Scratch risk from small errors not checked."
    (`risks` absent).
- **FR-127**: The shot card MUST show:
  - the cut and power as big numerals;
  - a fractional-aim overlap graphic;
  - a 10-segment power gauge with the minimum-power mark. A dashed arc marks minPowerCapture …
    minPower as "only just drops", and the text reads "Minimum X; from Y it only just drops". Past 10
    it reads "Needs more than full power for pace"; for a frozen cue ball, or any plan with
    `noWorkingPower`, "No power gets it in with pace", with no tick and Min power "none". No minimum
    is shown while a frozen cue ball's power advice is still being worked out (`adviceSkipped`).
    `ui/power-meter.ts` (`meterOptions`, `meterMinPower`) is the one reader for the card and the Snap
    HUD;
  - a shaded 3D cue ball with the tip dot and the miscue ring;
  - the stroke name in the spin tile in full: a name with side takes two lines, the ball shrinking so
    the hero keeps its height.

  Each MUST have a text equivalent. Every 001 test id, accessible name and tested text MUST be kept.
- **FR-128**: On first launch, the system MUST show a short, dismissible hint that explains the three
  modes, and MUST remember the dismissal on the device.
- **FR-129**: Transitions MUST take 180–240 ms with the shared easing. With reduced motion, they MUST
  be instant, and camera flights MUST jump to their end.
- **FR-130**: Accessibility MUST hold everywhere:
  - touch targets ≥ 44 px;
  - visible focus rings;
  - text contrast ≥ 4.5:1 (3:1 for large numerals);
  - icons with labels;
  - no meaning carried by colour alone.
- **FR-131**: The app MUST have an icon at every size it needs: a vector master, PWA icons (32, 180,
  192, 512 and a maskable 512) and an opaque 1024 px iOS icon. It MUST show a branded splash while
  loading, on the web and in the iOS app.

**iOS app and delivery (US4)**

- **FR-132**: The iOS app MUST wrap the same web build with bundled assets. It MUST work offline, make
  no network requests, support iOS 16 or later (CSS container queries need Safari and WKWebView 16),
  run in portrait and landscape, and respect safe areas.
- **FR-133**: The iOS app MUST explain camera and photo-library use in plain language when iOS asks for
  permission, and MUST handle a denial with the 001 fallback.
- **FR-134**: CI on macOS MUST, on every push to `main` and `claude/**` and every pull request into
  `main` (a pull request from a `claude/**` branch of this repository is covered by that branch's push
  run):
  - run the web checks;
  - build the iOS app for the Simulator, install and launch it, and check that it reports ready;
  - save Simulator screenshots of Practice and Snap.
- **FR-135**: CI MUST run the end-to-end tests on WebKit with an iPhone profile.
- **FR-136**: When App Store Connect API key secrets are configured, CI MUST archive a signed Release
  build with a strictly increasing build number and upload it to TestFlight. This happens only for a
  push to `main`, or for a manual run with upload requested (the input is off by default), and only
  after the web, Chromium e2e, WebKit e2e and Simulator jobs pass. An upload in progress is never
  cancelled. Without secrets, it MUST skip these steps with a notice and still pass. Secrets MUST
  never be printed or committed.
- **FR-137**: The iOS app MUST declare that it uses no non-exempt encryption and MUST contain no
  analytics or tracking.

### Key Entities

- **3D Scene Data**: what the 3D table draws. It holds the table spec, balls, current plan, target and
  pocket, landing spot, heatmap, stroke and optional cloth colour.
- **Camera Preset**: Overview, Player view or Broadcast, or "Custom" after the player orbits.
- **Pick**: what a tap hit: a ball, a pocket, a point on the cloth, or nothing.
- **Playback**: a time-scaled replay of a plan's trajectories. It holds each ball's position and
  rotation over time.
- **Snap Session**: the two-photo flow. It holds the table photo and its detection, the confirmed
  layout, target and pocket, the plan, the player photo and its pose (or the manual taps), and the
  session state.
- **Camera Pose**: where the player photo was taken from and how the camera was aimed (rotation,
  position, focal length, image centre and size).
- **Player View Result**: the pose, its confidence and residual, the balls matched in the photo, and
  the reason when it failed.
- **Strike Point**: the 3D point on the cue ball where the tip should touch, for a given aim direction
  and tip offset.
- **Icon Set**: the vector master and every raster size, with their transparency rules.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-101**: On a mid-range phone, the 3D table is interactive within 2 s of opening Practice. It
  renders at ≥ 30 fps while orbiting and during playback, with up to 22 balls. With no interaction it
  draws no frames (after the Player view's idle practice strokes, FR-109).
- **SC-102**: In every camera preset, tapping the on-screen centre of any visible ball selects that
  ball, and tapping a pocket mouth selects that pocket, in 100 % of test cases. A dragged ball comes to
  rest within 2 mm of the cloth point under the finger.
- **SC-103**: In replays, every ball is within 1 mm of its simulated position at each simulation event
  time. While rolling, the contact-point slip speed is below 1 % of the ball's speed. No replay's
  motion lasts more than 4 s (the lead-in and the end hold of FR-108 come on top).
- **SC-104**: For the same layout and selection, the 3D and 2D tables show identical shot-card values.
- **SC-105**: On synthetic table photos at the Snap processing resolution, detected ball positions meet
  001 SC-003: median error ≤ 10 mm, 95th percentile ≤ 25 mm. The layout appears within 3 s on a
  mid-range phone.
- **SC-106**: On synthetic table-level player photos with at least three balls in view, the automatic
  fit succeeds in ≥ 90 % of scenes. The scenes cover cameras 8–40 cm above the bed, 0.3–1.2 m behind
  the cue ball, up to ±15° off the aim line, and 40°–100° horizontal field of view. In scenes where it
  succeeds:
  - the drawn ghost-ball centre is within 1.5 % of the image diagonal of ground truth;
  - the strike dot is within 0.1 R of the true strike point on the ball's face.

  *Met on `rc/release`* (the player-photo merge `0a30cf5`): ≈ 95 % of 912 envelope photos with
  enough balls in view line up within tolerance, with and without the app's hints, and there are
  0 SC-107 violations (research R-24). `tests/integration/player-view-envelope.test.ts` asserts
  ≥ 90 % over its L18 grid of the envelope (with roll ±10° and occlusion added) and no ok fit
  outside tolerance on any photo. A 960×720 photo takes ≈ 104 ms (median) and ≈ 250 ms (p95) on
  Node. The remaining limits (untinted grey cloth, a charcoal cloth in a dark room, a camouflaged
  target, rare strike-dot residuals and false "moved", the cue ball out of frame) are in R-24 and
  the README.
- **SC-107**: Honest failure. No synthetic player-photo scene reports success with a ghost-ball error
  above 3 % of the image diagonal. Every scene that fails gives a player-facing reason.
- **SC-108**: With two manual taps within 1.5 % of the image diagonal of the true ball centres, the
  ghost ball is drawn within 2.5 % of the diagonal of ground truth.
- **SC-109**: The player-photo fit finishes within 1.5 s on a mid-range phone, and within 0.5 s per
  scene in CI (Node) at 1280 px.
- **SC-110**: 90 % of test players finish the Snap flow (two photos to a guide) in under 60 s on first
  use and can then say where to strike the cue ball and how hard.
- **SC-111**: All 001 end-to-end tests pass unchanged. Every interactive element is at least 44 × 44 px
  and text meets the contrast targets, checked by an automated end-to-end test.
- **SC-112**: The app has zero runtime npm dependencies, and the initial gzip JS stays under 250 KB. The
  3D renderer is part of the initial bundle (there is no lazy chunk): the main JS is about 112 kB gzip
  on `fix2b/app`.
- **SC-113**: The iOS workflow passes on a clean macOS runner with no secrets, in under 30 minutes, and
  produces at least two Simulator screenshots. With secrets, the build reaches TestFlight processing.
- **SC-114**: During a full Snap session, on the web and in the iOS app, zero network requests leave the
  device, and no photo is written to storage.
- **SC-115**: Every icon file has its exact pixel size. The iOS 1024 px icon has no alpha channel. The
  maskable icon keeps its artwork inside the central 80 % safe zone.

## Assumptions

- The balls do not move between the table photo and the player photo. If they do, the app detects it
  (FR-121) and asks for a new table photo.
- The player photo is taken at table level: the camera is 5–50 cm above the bed, within about 1.5 m of
  the cue ball, roughly behind it and held roughly level (roll within ±20°).
- Phone cameras deliver photos with lens distortion already corrected, so a pinhole model is enough.
  The image centre is assumed to be the principal point.
- The same table preset applies to both photos.
- Players have a device with WebGL2 for the 3D table (iOS 16+, current Android and desktop browsers).
  Others get the full 2D experience.
- The iOS app is distributed through TestFlight for testing. App Store review, pricing and store
  listing are a later step.
- An Apple Developer Program membership, an App Store Connect app record and an API key are needed for
  TestFlight. The workflow cannot create them. Until they exist, CI stops after the Simulator stage.
- GitHub-hosted macOS runners with a recent Xcode are available to the repository.

## Out of Scope

- Reading the player's actual cue, bridge or stroke from the player photo.
- Continuous live AR at table level (tracking the pose in video). Snap uses still photos.
- ARKit, LiDAR or depth sensors, and native camera plugins.
- An Android store build (the PWA continues to cover Android).
- App Store submission, review and release; in-app purchases.
- Recognising ball numbers; rule-aware play (8-ball groups, snooker order).
- Bank, kick, combination, massé and jump shots (unchanged from 001).
- Accounts, cloud sync, sharing photos or analytics.
