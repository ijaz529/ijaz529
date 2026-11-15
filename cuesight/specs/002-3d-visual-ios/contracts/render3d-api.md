# Contract: 3D Table API (`src/app/render3d/index.ts`)

**Implemented by** package `render3d`. **Consumed by** package `integrate` (`src/app/main.ts`).
This file is the API of record. The TypeScript block is verbatim. The sections after it pin
down behaviour the block leaves implicit.

**Revised 2026-11-15** to match `fix2b/app`: the optional members that the app uses (`riskPockets`,
`onFrame`, `setInsets`, `isAnimating`, `isFailed`) and `playShot`'s options are now in the API of
record, and the replay, gesture, pick, `toScreen` and `destroy` notes describe the code.

## API of record

```ts
import type { Ball, PocketId, ShotPlan, Stroke, TableSpec, Vec2 } from '../../core/types';

export type CameraPreset = 'overview' | 'player' | 'broadcast';

export type Pick3D = { kind: 'ball'; id: string } | { kind: 'pocket'; id: PocketId } | { kind: 'cloth'; pos: Vec2 } | null;
export interface Scene3DData {
  table: TableSpec; balls: Ball[]; plan: ShotPlan | null; targetId: string | null; pocketId: PocketId | null;
  landing: Vec2 | null; heatmap: { cols: number; rows: number; values: Float32Array } | null; stroke: Stroke | null;
  clothRgb?: [number, number, number];
  riskPockets?: PocketId[];                 // pockets at risk of a scratch under a small error (dashed rings)
}
/** Where things are on screen after a frame is drawn (client CSS px), for HTML labels in the scene. */
export interface FrameInfo {
  cue: { x: number; y: number; r: number } | null;   // cue ball centre and radius, or null off screen
  avoid: { x: number; y: number; w?: number }[];      // plan lines, balls and the cue stick to keep clear
  free: { left: number; top: number; right: number; bottom: number };  // canvas not under floating controls
  preset: CameraPreset | 'custom';
  pitch: number;                                      // camera elevation (rad); π/2 = straight down
  playing: boolean;
  balls?: { id: string; x: number; y: number; r: number }[];  // on-screen balls, for number tags
  moving?: boolean;                                   // a transition, a camera gesture or a ball drag
}
export interface Table3DEvents {
  onTap?(p: Pick3D, ev: PointerEvent): void;
  onBallDrag?(id: string, pos: Vec2, phase: 'start' | 'move' | 'end'): void;
  onCameraChange?(preset: CameraPreset | 'custom'): void;
  onFrame?(info: FrameInfo): void;          // after each drawn frame
}
export interface Table3D {
  readonly canvas: HTMLCanvasElement;
  setData(d: Scene3DData): void;            // cheap; marks dirty, renders on next rAF
  setCamera(preset: CameraPreset, animate?: boolean): void;
  getCamera(): CameraPreset | 'custom';
  playShot(plan: ShotPlan, opts?: { slow?: boolean }): Promise<void>;  // real time (×1, motion capped at 4 s), `slow` at half speed; skippable
  stopPlayback(): void;
  isPlaying(): boolean;
  pick(clientX: number, clientY: number): Pick3D;
  toScreen(p: Vec2, z?: number): { x: number; y: number } | null; // table metres -> client CSS px (getBoundingClientRect-based)
  resize(): void;
  destroy(): void;
  setInsets?(insets: { top?: number; right?: number; bottom?: number; left?: number }): void; // CSS px under floating UI
  isAnimating?(): boolean;                  // a camera transition is running (tests)
  isFailed?(): boolean;                     // a lost GPU context could not be rebuilt
}

export function createTable3D(canvas: HTMLCanvasElement, events?: Table3DEvents, opts?: { reducedMotion?: boolean; maxPixelRatio?: number }): Table3D | null; // null if WebGL2 is unavailable
```

## Gesture rules (normative)

Implemented by the pure state machine `src/app/render3d/gestures.ts` (tests:
`tests/unit/app/render3d-gestures.test.ts`, including a pointercancel during a ball drag).

| Input | Result |
|---|---|
| Tap: movement < 8 px and < 350 ms | `onTap(pick(x, y), ev)` |
| Drag that starts on a ball | `onBallDrag(id, pos, 'start' \| 'move' \| 'end')`. The ball follows the pointer on the `z = R` plane, clamped to the bed (`\|x\| ≤ L/2 − R`, `\|y\| ≤ W/2 − R`). The renderer shows the dragged position at once; the app owns overlap resolution and calls `setData` |
| Drag on empty cloth or background | orbit: yaw/pitch, pitch clamped to 8°…89°. The camera becomes `'custom'` → `onCameraChange('custom')` |
| Pinch / wheel | zoom (distance clamped). Wheel: × exp(dy · 0.0015); Ctrl + wheel (a trackpad pinch): × exp(dy · 0.01) |
| Two-finger drag | pan. The target is clamped to the table |
| Double-tap: a second tap on empty cloth or background within 320 ms and 30 px | back to the last preset → `onCameraChange(preset)` |
| `pointercancel` (or lost capture) | ends any gesture and is never a tap; a ball drag ends with `'end'` at the last position |

Rendering is on demand. A dirty flag is set by `setData`, camera changes, `resize`, texture uploads
and playback. The `requestAnimationFrame` loop runs only while a flight, a gesture, a playback or the
Player view's idle practice strokes are active. The practice strokes: in Player view the cue takes
three strokes of 1.8 s each (5.4 s in all) after the stroke, the cue ball or the view changes, then
rests at address; there are none with reduced motion.

## Behavioural notes

- **`createTable3D`**:
  - Returns `null` when `canvas.getContext('webgl2', …)` returns `null`, or when shader compilation
    or linking fails during set-up. It never throws for a missing capability.
  - It sets `touch-action: none` on the canvas, and gives the canvas an accessible name if it has
    none.
- **Pixel ratio**: `min(devicePixelRatio, opts.maxPixelRatio ?? 2)`. `resize()` re-reads the canvas
  client size.
- **Reduced motion**: `opts.reducedMotion` (default: the `prefers-reduced-motion` media query) makes
  `setCamera(…, animate)` jump and turns off the idle practice strokes. Playback still runs, because
  it is content, and stays skippable.
- **`setCamera`**:
  - `'player'` uses `plan.aimDir` from the current data.
  - Without a plan it uses cue → table centre.
  - Without a cue ball it behaves like `'overview'`.
- **`playShot(plan, opts?)`**:
  - Replays `plan.cuePath`, `plan.objectPath` and `plan.otherPaths`, timed from their recorded
    point times (`Trajectory.times`) or, for hand-built tracks, from their `events` (research R-17).
  - A 0.5 s strike lead-in comes first: the cue strikes the ball.
  - Rate: 1× real time, or uniformly faster when the simulated duration T > 4 s, so the balls'
    motion lasts ≤ 4 s and still ends at the true rest positions. `opts.slow` plays at half speed.
  - Rotation: rolling balls MUST satisfy no-slip (rotation `|d|/R` about `ẑ × d̂`). Sliding is
    replayed from the recorded angular velocities (`Trajectory.spins`), so a draw ball visibly turns
    backward while it slides.
  - Pocketed balls drop into their pocket and hide.
  - The end position is held 3.5 s (6.3 s with reduced motion) for study. The renderer then restores
    the `Scene3DData` layout and resolves the promise.
  - A tap on the canvas, the app's Skip button or the Escape key ends the replay at once (lead-in,
    motion or hold) by calling `stopPlayback()`.
  - Calling `playShot` while playing stops the current replay first.
- **`stopPlayback()`**: ends the replay at once, restores the layout and resolves the pending
  promise. It is a no-op when idle.
- **`setData` during playback**: a **different** plan object stops the replay first, and the layout
  returns to its planned state, so old trajectories never run under the new plan's lines.
- **`pick`**: in client coordinates, like `PointerEvent.clientX/Y`. Priority (`picking.ts`):
  1. exact sphere hit, nearest first;
  2. the ball whose closest approach to the ray is within max(1.8·R + 12 CSS px, 22 CSS px) at the
     ball's distance; the nearest ball wins;
  3. a ball reached only through the 22 px floor (beyond 1.8·R + 12 px) yields to a pocket mouth
     nearer the tap on screen;
  4. a pocket capture disc on the bed plane, around a point 2 cm from the mouth centre into the
     pocket, radius 0.75 × the mouth width and at least 22 CSS px;
  5. a bed point (`kind: 'cloth'`);
  6. `null`.
- **`toScreen(p, z = 0)`**: projects the table point `(p.x, p.y, z)` to **client** (viewport)
  coordinates in CSS px: the canvas `getBoundingClientRect()` origin, with no scroll offset. It
  returns `null` when the point is behind the camera or outside the clip volume. Contract for tests:
  `pick(toScreen(ball.pos, R))` returns that ball whenever the ball is visible.
- **Context loss**: on `webglcontextlost` the renderer calls `preventDefault()` and stops drawing. On
  `webglcontextrestored` it rebuilds every GPU resource and redraws. If rebuilding fails, it stays
  failed, draws nothing, and `isFailed()` returns true; the app then falls back to the 2D table.
- **`destroy()`**: ends a replay, removes listeners, cancels the animation frame and deletes the GPU
  objects. It keeps the WebGL context (no `loseContext()`), because the app reuses the canvas.
  Further calls are no-ops.

## Drawing contract (what `setData` must show)

| Data | Drawn as |
|---|---|
| balls | glossy spheres. Pool: numbered solids/stripes from `label`/`color`/`stripe`. Snooker: canonical colours. Cue: white. A ball vision could not name (`'ball'`) and that has no measured colour is neutral grey `#9a9a9a`. Soft contact shadows |
| `targetId` | ring in `PALETTE.target` |
| `plan` (makeable) | aim line (solid `PALETTE.aim`), ghost ball (translucent sphere + dotted white ring), contact point, object path (solid `PALETTE.object`), cue path (dashed `PALETTE.cue`), other paths (dash-dot `PALETTE.other`), rest ✕ |
| `plan` with a frozen cue ball (warning `frozen`) | no ghost ball and no ghost ring: the aim ribbon runs along `aimDir` from the cue ball for 3R + 0.1 m (10 cm past the object ball's far side), clipped to the bed. `FrameState.ghost` comes from `scene-data.ts` `frameGhost(plan, cue, showPlan)`: null for a frozen cue ball or a hidden plan |
| `pocketId` | pocket ring + chevron |
| `riskPockets` | dashed rings on those pockets |
| `landing` | ring + ✕ in `PALETTE.landing` |
| `heatmap` | bed decal, single-hue alpha ramp, under the paths |
| `stroke` (or `plan.stroke`) | cue stick behind the cue ball, posed along `ShotPlan.cueDir` (`cueAimDir` is the same vector; `render/plan-draw.ts` `stickDir`): axis through the strike point (the `strikePoint` convention), tip gap growing with power (`cueGap`), raised only to clear the rail. Hidden in the Top (overview) view and above 70° of camera pitch, and in a replay once the strike is over |
| `clothRgb` | the cloth base colour (default felt `#0E6B4F`). A grey (neutral) cloth from a Snap photo is drawn grey |

## Proposed extensions (not yet in the API of record)

- `getLabelAnchors(): { id: string; x: number; y: number }[]`, for DOM labels such as pocket names
  and "ghost". Not built: `onFrame(FrameInfo)` gives the app what its labels need.

## Invariants (tested)

- `toScreen` and `pick` agree for every visible ball in all three presets (SC-102).
- The pitch never leaves [8°, 89°], and the pan target never leaves the bed rectangle.
- After `playShot` resolves, the rendered ball positions equal `Scene3DData.balls`.
- With recorded trajectories (`Trajectory.times`) the replay passes every recorded point at its
  simulated time (scaled by the rate); hand-built tracks match their event points within 1 µm
  (`EVENT_MATCH_M`). The rolling slip stays < 1 % of the speed (SC-103).
- With no input, no playback and no practice strokes, no frames are drawn (SC-101).
