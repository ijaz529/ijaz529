# Contract: 3D Table API (`src/app/render3d/index.ts`)

**Implemented by** package `render3d`. **Consumed by** package `integrate` (`src/app/main.ts`).
This file is the API of record. The TypeScript block is verbatim. The sections after it pin
down behaviour the block leaves implicit.

## API of record

```ts
import type { Ball, PocketId, ShotPlan, Stroke, TableSpec, Vec2 } from '../../core/types';

export type CameraPreset = 'overview' | 'player' | 'broadcast';

export type Pick3D = { kind: 'ball'; id: string } | { kind: 'pocket'; id: PocketId } | { kind: 'cloth'; pos: Vec2 } | null;
export interface Scene3DData { table: TableSpec; balls: Ball[]; plan: ShotPlan | null; targetId: string | null; pocketId: PocketId | null; landing: Vec2 | null; heatmap: { cols: number; rows: number; values: Float32Array } | null; stroke: Stroke | null; clothRgb?: [number, number, number] }
export interface Table3DEvents { onTap?(p: Pick3D, ev: PointerEvent): void; onBallDrag?(id: string, pos: Vec2, phase: 'start' | 'move' | 'end'): void; onCameraChange?(preset: CameraPreset | 'custom'): void }
export interface Table3D {
  readonly canvas: HTMLCanvasElement;
  setData(d: Scene3DData): void;            // cheap; marks dirty, renders on next rAF
  setCamera(preset: CameraPreset, animate?: boolean): void;
  getCamera(): CameraPreset | 'custom';
  playShot(plan: ShotPlan): Promise<void>;  // animate cuePath/objectPath/otherPaths in real time (x1, capped 4 s, skippable), balls roll with physically consistent rotation
  stopPlayback(): void;
  isPlaying(): boolean;
  pick(clientX: number, clientY: number): Pick3D;
  toScreen(p: Vec2, z?: number): { x: number; y: number } | null; // table metres -> client (CSS px, page coords like getBoundingClientRect-based), used by tests
  resize(): void;
  destroy(): void;
}

export function createTable3D(canvas: HTMLCanvasElement, events?: Table3DEvents, opts?: { reducedMotion?: boolean; maxPixelRatio?: number }): Table3D | null; // null if WebGL2 is unavailable
```

## Gesture rules (normative)

| Input | Result |
|---|---|
| Tap: movement < 8 px and < 350 ms | `onTap(pick(x, y), ev)` |
| Drag that starts on a ball | `onBallDrag(id, pos, 'start' \| 'move' \| 'end')`. The ball follows the pointer on the `z = R` plane, clamped to the bed (`|x| ≤ L/2 − R`, `|y| ≤ W/2 − R`). The renderer shows the dragged position at once; the app owns overlap resolution and calls `setData` |
| Drag on empty cloth or background | orbit: yaw/pitch, pitch clamped to 8°…89°. The camera becomes `'custom'` → `onCameraChange('custom')` |
| Pinch / wheel | zoom (distance clamped) |
| Two-finger drag | pan. The target is clamped to the table |
| Double-tap on empty cloth or background | back to the last preset → `onCameraChange(preset)` |

Rendering is on demand. A dirty flag is set by `setData`, camera changes, `resize`, texture uploads
and playback. The `requestAnimationFrame` loop runs only while a flight, a gesture or a playback is
active.

## Behavioural notes

- **`createTable3D`**:
  - Returns `null` when `canvas.getContext('webgl2', …)` returns `null`, or when shader compilation
    or linking fails during set-up. It never throws for a missing capability.
  - It sets `touch-action: none` on the canvas, and gives the canvas an accessible name if it has
    none.
- **Pixel ratio**: `min(devicePixelRatio, opts.maxPixelRatio ?? 2)`. `resize()` re-reads the canvas
  client size.
- **Reduced motion**: `opts.reducedMotion` makes `setCamera(…, animate)` jump. Playback still runs,
  because it is content, and stays skippable.
- **`setCamera`**:
  - `'player'` uses `plan.aimDir` from the current data.
  - Without a plan it uses cue → table centre.
  - Without a cue ball it behaves like `'overview'`.
- **`playShot(plan)`**:
  - Replays `plan.cuePath`, `plan.objectPath` and `plan.otherPaths`, timed from their `events`
    (research R-17).
  - Rate: 1× real time, or uniformly faster when the simulated duration T > 4 s, so the replay lasts
    ≤ 4 s and still ends at the true rest positions.
  - Rotation: rolling balls MUST satisfy no-slip (rotation `|d|/R` about `ẑ × d̂`). Sliding phases
    SHOULD relax to rolling under the 001 sliding-friction law, starting from
    `strikeBall(...).omega` for the cue ball (research R-17 level 2).
  - Pocketed balls drop into their pocket and hide.
  - After a 600 ms hold, the renderer restores the `Scene3DData` layout and resolves the promise.
  - A tap on the canvas or the Escape key while playing calls `stopPlayback()`.
  - Calling `playShot` while playing stops the current replay first.
- **`stopPlayback()`**: ends the replay at once, restores the layout and resolves the pending
  promise. It is a no-op when idle.
- **`setData` during playback**: stored; applied when the replay ends. A **different** plan object
  stops the replay first.
- **`pick`**: in client coordinates, like `PointerEvent.clientX/Y`. Priority:
  1. exact sphere hit;
  2. the nearest ball whose projected centre is within max(projected radius, 22 CSS px);
  3. a pocket capture disc (mouth centre, radius mouth/2 + R) on the bed plane;
  4. a bed point (`kind: 'cloth'`);
  5. `null`.
- **`toScreen(p, z = 0)`**: projects the table point `(p.x, p.y, z)` to **page** coordinates in CSS
  px (canvas `getBoundingClientRect()` origin plus `scrollX/scrollY`). It returns `null` when the
  point is behind the camera or outside the clip volume. Contract for tests:
  `pick(toScreen(ball.pos, R) − scroll)` returns that ball whenever the ball is visible.
- **Context loss**: on `webglcontextlost` the renderer calls `preventDefault()` and stops drawing. On
  `webglcontextrestored` it rebuilds every GPU resource and redraws. If rebuilding fails, it stays
  failed and draws nothing. Until the proposed `isFailed()` exists, the app detects this itself: it
  listens for `webglcontextlost` on the canvas and falls back to 2D when no `webglcontextrestored`
  follows within 3 s.
- **`destroy()`**: removes listeners, cancels the animation frame, deletes GPU objects and calls
  `WEBGL_lose_context.loseContext()` where available. Further calls are no-ops.

## Drawing contract (what `setData` must show)

| Data | Drawn as |
|---|---|
| balls | glossy spheres. Pool: numbered solids/stripes from `label`/`color`/`stripe`. Snooker: colours. Cue: white. Soft contact shadows |
| `targetId` | ring in `PALETTE.target` |
| `plan` (makeable) | aim line (solid `PALETTE.aim`), ghost ball (translucent sphere + dotted white ring), contact point, object path (solid `PALETTE.object`), cue path (dashed `PALETTE.cue`), other paths (dash-dot `PALETTE.other`), rest ✕ |
| `pocketId` | pocket ring + chevron |
| `landing` | ring + ✕ in `PALETTE.landing` |
| `heatmap` | bed decal, single-hue alpha ramp, under the paths |
| `stroke` (or `plan.stroke`) | cue stick behind the cue ball: axis through the strike point (the `strikePoint` convention), tip gap growing with power (`cueGap`), raised only to clear the rail |
| `clothRgb` | the cloth base colour (default felt `#0E6B4F`) |

## Proposed extensions (not yet in the API of record)

These are optional and non-breaking. `integrate` may ask for them:
- `isFailed(): boolean`, so a context that could not be restored is detectable without heuristics.
- `getLabelAnchors(): { id: string; x: number; y: number }[]`, for DOM labels such as pocket names
  and "ghost".

## Invariants (tested)

- `toScreen` and `pick` agree for every visible ball in all three presets (SC-102).
- The pitch never leaves [8°, 89°], and the pan target never leaves the bed rectangle.
- After `playShot` resolves, the rendered ball positions equal `Scene3DData.balls`.
- The replay timeline hits every `SimEvent` position within 1 mm at its time (scaled by the rate),
  and the rolling slip stays < 1 % of the speed (SC-103).
- With no input and no playback, no frames are drawn (SC-101).
