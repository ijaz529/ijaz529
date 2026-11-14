# Feature Specification: Real-Time Shot Guide

**Feature Branch**: `001-realtime-shot-guide`

**Created**: 2026-11-14

**Status**: Draft (clarified, ready for planning)

**Input**: User description: "Pool / snooker real-time shot guide. I point the camera at a table and it
shows me where, and on exactly which line, I have to hit the cue ball to pocket a particular target
ball. Power, spin, expected trajectory/path, etc. A real-time pool trainer in your pocket."
Expanded by `docs/MASTER_PROMPT.md`.

## Clarifications

### Session 2026-11-14

- Q: Is the guide rule-aware (8-ball groups, snooker colour order)? → A: No. v1 is rule-agnostic.
  Any object ball can be the target. Rule awareness is a later feature.
- Q: Does the app read the player's actual cue alignment or stroke? → A: No. The app *prescribes*
  the line, power and spin. Measuring the stroke from one handheld camera is unreliable and out of
  scope.
- Q: Which table types are supported at launch? → A: 9-ft, 8-ft and 7-ft pool, UK 7-ft pool and 12-ft
  snooker, as presets the player selects. The default is 9-ft pool.
- Q: How should power be communicated? → A: A 1–10 scale with a speed word (soft, medium-soft,
  medium, firm, hard, power). Estimated cue-ball speed is secondary detail.
- Q: How should spin be communicated? → A: A tip position drawn on a cue-ball face, plus words ("½ tip
  low, ¼ tip right"). One "tip" equals one tip-width (≈ ¼ of the ball radius from centre per tip,
  max 2 tips).
- Q: What does the app do when the phone moves after the player locks a layout? → A: The locked layout
  stays and is shown on the top-down map. The camera overlay is hidden until the table is re-acquired.
- Q: What if no camera is available or permission is denied? → A: The player gets the virtual practice
  table with the full planner.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Get a complete shot plan for a chosen ball and pocket (Priority: P1)

A player has a layout of balls on a table (from the camera or placed on the virtual practice table).
They tap the object ball they want to pocket, then tap a pocket. The app shows the full plan:

- the line the cue ball must travel and the ghost-ball position at contact,
- the contact point on the object ball, the cut angle and the fractional aim ("½-ball hit"),
- the aim correction for throw and squirt,
- the recommended power (1–10 plus a word) and spin (tip diagram plus words),
- the object ball's path into the pocket,
- the cue ball's predicted path through cushion bounces to where it stops,
- a margin of error and difficulty label,
- a short coaching tip explaining the physics in player language.

**Why this priority**: this is the product's brain. Without a correct, trustworthy plan nothing else
matters. On the virtual table it already delivers value: a player can study any shot.

**Independent Test**: on the virtual practice table, place cue and object balls, select ball and
pocket, and check that every plan element appears and matches reference physics for known layouts.

**Acceptance Scenarios**:

1. **Given** a straight-in layout (cue ball, object ball and pocket in a line), **When** the player selects
   that ball and pocket, **Then** the plan shows a cut angle of 0°, a "full-ball" aim, no throw
   correction, and the cue ball stopping or following on the same line, depending on the spin shown.
2. **Given** a 30° cut, **When** the plan is shown with stun (centre-ball at contact), **Then** the cue-ball
   path leaves along the tangent line: 90° to the line of centres. That holds within 1° for ideal balls.
   Real balls (restitution ≈ 0.95) leave up to ~4° forward of it, and the plan shows that real path.
   The coaching tip names the tangent-line (90°) rule.
3. **Given** a 30° cut, **When** the player chooses natural follow (rolling), **Then** the cue ball's
   deflection from its original line is about 33° (within 1°) and the tip names the 30° rule.
4. **Given** another ball blocking the cue ball's path to the ghost ball, **When** the plan is shown,
   **Then** it is clearly marked **blocked** and names the obstructing ball.
5. **Given** a cue-ball path that ends in a pocket, **When** the plan is shown, **Then** a **scratch**
   warning is displayed.
6. **Given** an impossible cut (≥ 88°) or no clear path to the pocket, **When** the player selects that
   pocket, **Then** the app says the shot is not makeable and suggests the best other pocket.

---

### User Story 2 - Point the camera at a real table and see the plan on it, live (Priority: P1)

The player opens the app, allows camera access and points the phone at a real table. The app finds
the playing surface and the balls, and marks the cue ball. A detection-quality indicator shows when
the table is locked. The player taps a ball and a pocket directly on the camera image; the plan from
Story 1 is drawn on the cloth in the camera view and on a top-down mini-map. The overlay follows the
table as the phone moves. "Freeze" locks the layout for study. If automatic detection fails, the
player taps the four corners of the playing surface to calibrate by hand.

**Why this priority**: it is the headline experience ("point the camera and it shows me") and the
main thing that sets us apart from competitors. It depends on Story 1's planner, but it is a
separately demoable slice: detection, overlay and calibration.

**Independent Test**: feed a reference video of a table with known ball positions as the camera.
Verify that the table is detected, balls are located within tolerance, the cue ball is identified,
and a selected plan is drawn aligned with the cloth.

**Acceptance Scenarios**:

1. **Given** the camera sees the whole table under normal lighting, **When** the app runs, **Then** the
   table outline is locked within 3 seconds and each ball is marked with the cue ball distinguished.
2. **Given** a locked table, **When** the player taps a ball on the camera image and then a pocket,
   **Then** the full plan is drawn over the cloth in the camera image and on the mini-map.
3. **Given** automatic detection fails (for example, one corner is off-screen), **When** the player
   chooses manual calibration and taps four corners, **Then** the table locks and planning works.
4. **Given** a locked layout, **When** the player presses Freeze and moves the phone, **Then** the layout
   and plan stay available on the mini-map, unchanged.
5. **Given** camera permission is denied, **When** the app starts, **Then** it explains why the camera
   is needed and offers the virtual practice table.

---

### User Story 3 - Try my own power and spin and see what happens (Priority: P2)

The player overrides the recommended power and spin with a power slider and a tap-to-place tip
position on a cue-ball diagram. The predicted cue-ball path, rest position, throw/squirt corrections
and scratch warning update instantly.

**Why this priority**: this is how players *learn* cue-ball control: experimenting with draw,
follow and english and seeing the result. It builds on Story 1.

**Independent Test**: on the virtual table, change spin from draw to follow and power from 2 to 8,
and check that the cue-ball path and rest position change in the physically expected direction.

**Acceptance Scenarios**:

1. **Given** a plan for a 0° shot, **When** the player moves the tip below centre, **Then** the cue
   ball's predicted path reverses back toward the player (draw). Moving it above centre makes it
   follow forward.
2. **Given** any plan, **When** the player increases power, **Then** the predicted cue-ball travel
   distance does not decrease (unless a collision or pocket ends the path).
3. **Given** the player adds side spin, **When** the plan updates, **Then** the squirt aim correction
   and the changed throw correction are shown in degrees.
4. **Given** the chosen power is too soft to get the object ball to the pocket, **When** the plan
   updates, **Then** the app warns "too soft — object ball stops short".

---

### User Story 4 - Show me the best shots on this table (Priority: P2)

The player taps "Suggest". The app ranks every makeable shot (each object ball into each reachable
pocket) by margin of error and cue-ball position quality, and highlights the top three with their
difficulty. Tapping a suggestion opens its full plan.

**Why this priority**: beginners often don't know which shot to play. Shot selection is a core skill
the app can teach. It depends only on Story 1.

**Independent Test**: on a virtual layout with one easy, one blocked and one hard shot, check that the
easy shot ranks first, the blocked shot is excluded, and the hard shot ranks lower.

**Acceptance Scenarios**:

1. **Given** a layout, **When** the player taps Suggest, **Then** up to three ranked shots appear within
   2 seconds, each with ball, pocket and difficulty label.
2. **Given** a ball with every pocket blocked, **When** suggestions are computed, **Then** that ball does
   not appear.

---

### User Story 5 - Get shape: land the cue ball where I want it (Priority: P3)

The player taps "Position" and then a spot on the mini-map where the cue ball should finish. The app
searches over power and spin and recommends the most reliable stroke that pockets the target and
leaves the cue ball closest to the spot without scratching. When the player has not picked a spot,
the default recommendation leaves the cue ball where the best next shot is easiest. The player can
also show a heatmap of good cue-ball zones for a chosen next ball.

**Why this priority**: position play is what separates good players from great ones. It is the most
advanced feature and builds on Stories 1 and 3.

**Independent Test**: on the virtual table, pick a landing spot reachable with draw, and check that the
recommended stroke uses below-centre spin and the simulated rest position is within 15 cm of the spot.

**Acceptance Scenarios**:

1. **Given** a planned shot, **When** the player taps a reachable target spot, **Then** within 2 seconds
   the app recommends power and spin, and the predicted cue-ball rest lies within 15 cm of the spot.
2. **Given** a spot that can't be reached without scratching, **When** the search completes, **Then** the
   app says so and offers the closest safe alternative.
3. **Given** a chosen next ball, **When** the player turns on the position-zone heatmap, **Then** cue-ball
   zones are coloured by how easy the next shot would be from there.

---

### Edge Cases

- Part of the table is outside the camera view, or a person/arm covers part of it → no auto-lock.
  Offer manual calibration. Balls under the occlusion are not invented.
- Strong glare on the cloth or balls → reflections must not be detected as balls (size/shape
  check). Low detection quality is shown.
- Non-green cloth (blue, red, grey) → the cloth colour is learned from the table centre, not assumed.
- Balls touching each other or frozen to a cushion → each ball is still detected separately. A plan
  with the object ball frozen to the rail is still computed.
- Cue ball not found, or several white-ish candidates → the player is asked to tap the cue ball.
- The cue ball touching the object ball → the plan warns that a frozen ball changes the throw.
- Object ball already in the pocket jaws → handled like any short shot; the margin reflects the jaws.
- Very thin cuts (> 80°) → allowed but flagged "very thin". Cuts ≥ 88° are not makeable.
- The phone moves while frozen → the locked layout stays; the overlay is hidden until re-acquired.
- Snooker table with 15+ reds → planning stays responsive and suggestions stay within the time budget.
- Device rotated or app backgrounded → camera resumes; the locked layout persists in the session.

## Requirements *(mandatory)*

### Functional Requirements

**Table, balls and calibration**

- **FR-001**: The system MUST let the player choose a table preset (9-ft, 8-ft, 7-ft pool; UK 7-ft pool;
  12-ft snooker). The preset sets playing-surface size, ball size and pocket sizes.
- **FR-002**: The system MUST automatically detect the playing-surface boundary in the live camera image,
  whatever the cloth colour.
- **FR-003**: The system MUST provide manual calibration by tapping the four playing-surface corners, and
  a control to swap which side is the long rail.
- **FR-004**: The system MUST detect ball positions on the table, identify the cue ball, and correct for
  ball height so that positions refer to where each ball touches the cloth.
- **FR-005**: The system MUST smooth detections over time and show a detection-quality indicator
  (searching / locked / unstable).
- **FR-006**: The system MUST let the player freeze the current layout and unfreeze it.
- **FR-007**: The system MUST let the player correct detection by tapping to mark the cue ball.
- **FR-008**: The system MUST offer a virtual practice table where balls can be added, dragged and removed.

**Shot planning**

- **FR-009**: The player MUST be able to select a target ball and a pocket by tapping them, on either the
  camera image or the top-down map. The system MUST auto-select the best pocket when the player picks
  only a ball.
- **FR-010**: For a selected shot the system MUST compute and display:
  - the ghost-ball position and the cue-ball aim line,
  - the contact point,
  - the cut angle and the fractional aim,
  - the object-ball path to the pocket.
- **FR-011**: The system MUST compute the aim correction for cut- and spin-induced throw, and the squirt
  correction for side spin, and display both in degrees.
- **FR-012**: The system MUST recommend power (1–10 plus a speed word, with estimated cue-ball speed as
  detail). The power MUST be enough for the object ball to reach the pocket.
- **FR-013**: The system MUST recommend spin as a tip position on a cue-ball diagram, described in tips
  and words, within the safe miscue limit.
- **FR-014**: The system MUST predict the cue ball's path for the chosen power and spin, including
  sliding-to-rolling transition, spin effects after contact, cushion rebounds, collisions with other
  balls and pocketing, and MUST show its rest position.
- **FR-015**: The system MUST compute a margin of error (allowed aim error in degrees) and a difficulty
  label (easy / medium / hard / very hard) for every planned shot.
- **FR-016**: The system MUST detect and flag:
  - a blocked cue-ball path or object-ball path (naming the blocking ball),
  - a cue-ball scratch,
  - an object ball that stops short,
  - a shot that is not makeable.
- **FR-017**: The system MUST show a one- or two-sentence coaching tip for each plan, in player
  language, explaining the main physics (for example, tangent line, 30° rule, throw, draw).

**Exploration and assistance**

- **FR-018**: The player MUST be able to override power and spin. All predictions MUST update within the
  real-time budget.
- **FR-019**: The system MUST rank all makeable shots on the table and present the top three on request.
- **FR-020**: The player MUST be able to set a desired cue-ball landing spot. The system MUST recommend
  the most reliable power and spin to get there without scratching, or report that the spot can't be
  reached and offer the closest safe alternative.
- **FR-021**: Without a chosen landing spot, the default recommendation MUST favour cue-ball positions
  that leave an easy next shot.
- **FR-022**: The system MUST show a position-zone heatmap for a chosen next ball on request.

**Rendering, privacy and platform**

- **FR-023**: The camera overlay MUST be drawn in perspective on the cloth and stay aligned as the phone
  moves while the table is locked. A top-down mini-map MUST always show the same plan.
- **FR-024**: The overlay MUST use a colour-blind-safe palette with redundant encodings (line styles and
  labels).
- **FR-025**: Camera frames MUST be processed on the device and MUST never be stored or sent over a
  network.
- **FR-026**: After first load, the app MUST work offline and be installable to the home screen.
- **FR-027**: When camera access is denied or unavailable, the system MUST explain why and offer the
  virtual practice table.
- **FR-028**: Physical parameters (cloth friction, cushion bounce, shaft type: standard or
  low-deflection) MUST be adjustable in settings, with sensible defaults.

### Key Entities

- **Table Spec**: playing-surface length and width, ball diameter and mass, six pockets (position, mouth
  width, type corner/side), physical parameters. Comes from a preset.
- **Ball**: identifier, position on the cloth, kind (cue / object), optional colour label, detection
  confidence.
- **Table Layout**: snapshot of all balls on a Table Spec at a moment, plus source (camera, virtual) and
  lock state.
- **Calibration**: mapping between camera image and table surface (from auto-detection or four tapped
  corners), plus quality.
- **Shot Request**: target ball, pocket, optional stroke override, optional desired landing spot.
- **Stroke**: power level (1–10, with cue-ball speed) and tip position (vertical and horizontal offset).
- **Shot Plan**:
  - ghost ball, aim line, contact point,
  - cut angle, fractional aim,
  - throw and squirt corrections,
  - recommended stroke,
  - predicted object-ball and cue-ball paths and rest positions,
  - margin of error, difficulty, warnings, coaching tip.
- **Shot Suggestion**: ranked Shot Plans with a score.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A first-time player with a whole table in view sees their first shot plan on the live camera
  image within 30 seconds of opening the app (no account, no setup beyond camera permission).
- **SC-002**: The overlay refreshes at least 30 times per second. Detection updates at least 10 times per
  second on a mid-range phone. A plan updates within 0.1 s of a selection or stroke change.
- **SC-003**: On reference table layouts with known ground truth, detected ball positions are within 1 cm
  (median) and 2.5 cm (95th percentile) of the true positions. The table outline is within 1.5 % of the
  image diagonal.
- **SC-004**: On reference shots, predicted aim, cue-ball deflection (stun and rolling), throw and squirt
  match published billiards physics within 0.5°–1° in the ideal-ball limit the formulas assume. With
  realistic ball properties, deviations from those idealised rules stay within 4°.
- **SC-005**: Position-play recommendations are returned within 2 seconds. For reachable spots on
  reference layouts, the predicted rest position is within 15 cm of the requested spot.
- **SC-006**: 90 % of test players can select a ball and pocket and correctly state the recommended aim,
  power and spin, on first use, without help.
- **SC-007**: Network monitoring during a full session shows zero image data leaving the device. The app
  remains usable in airplane mode after first load.
- **SC-008**: Suggestions on a 15-ball layout are produced within 2 seconds and never include a shot
  flagged as blocked.

## Assumptions

- Players use a modern smartphone with a rear camera. Tablets and laptops with webcams also work.
- The table's playing surface is a uniform cloth colour that contrasts with the balls and rails.
- Typical use is standing at the table, with the phone roughly at chest-to-head height and the whole table
  (or the relevant part) in view. An overhead view gives the best accuracy.
- Default physics uses standard cloth and cushion values. Real tables vary, so predicted paths are
  guidance with stated uncertainty, not guarantees.
- Ball numbers/colours are not needed for v1 planning beyond identifying the cue ball.
- Bank, kick, combination, massé and jump shots are out of scope for v1.
- The player strikes with a level cue (no elevation). Swerve is not modelled in v1.
