# Contract: Worker Message Protocol (v2)

v2 supersedes [001 worker-protocol.md](../../001-realtime-shot-guide/contracts/worker-protocol.md)
(v1). The TypeScript source of truth is `src/workers/protocol.ts`, with `PROTOCOL_VERSION = 2`.

**Revised 2026-11-15** to match `fix2b/app`: the result buffer is not reused, `VisionResult` carries
`cloth` and `reason`, `reset` keeps the ball ids, `StillOptions` is part of the protocol, and the
planner adds the optional `plan` message, the full recommendation fields and `perEvalMs`. The rules
the app follows (`src/app/planner-client.ts`, `src/app/main.ts`, `src/app/snap/controller.ts`) are
listed at the end.

The common rules are unchanged:
- every message is a structured-cloneable object with `v`, `type` and, for request/response pairs,
  a numeric `id`;
- a receiver MUST ignore a message whose `v` it does not support and reply with an `error`;
- the app MUST drop a response whose `id` is older than the latest request **of the same type**
  (the stale-result rule).

## Vision worker (`vision.worker.ts`)

| Direction | Message | Fields | Since |
|---|---|---|---|
| app → worker | `config` | `table: TableSpec`, `fovDeg: number`, `manualCorners: Vec2[4] \| null`, `swapAxes: boolean` | v1 |
| app → worker | `frame` | `id`, `width`, `height`, `buffer: ArrayBuffer` (RGBA, **transferred**) | v1 |
| app → worker | `reset` | — | v1 |
| worker → app | `result` | `id`, `result: VisionResult`, `buffer: ArrayBuffer` (transferred back; **not reused**: 2D-canvas `getImageData` cannot fill an existing buffer) | v1 |
| app → worker | **`still`** | `id`, `frame: Frame` (`{ width, height, data: Uint8ClampedArray }`; `data.buffer` **transferred**), `opts?: StillOptions` | **v2** |
| worker → app | **`still`** | `id`, `result: VisionResult` | **v2** |
| app → worker | **`player-view`** | `id`, `input: PlayerViewInput` (`input.frame.data.buffer` **transferred**) | **v2** |
| worker → app | **`player-view`** | `id`, `result: PlayerViewResult` | **v2** |
| worker → app | `error` | `id?`, `message`, `buffer?` (the frame buffer, when the error came from a `frame`) | v1 |

- `config` reconfigures the live pipeline. Tracking restarts only on a geometry change (the table,
  the manual corners compared by value, or `swapAxes`), and ball ids keep counting up across it.
- `reset` calls `pipeline.reset()`: it forgets the table, the cloth and the tracks but **keeps the
  ball-id counter**, so an id the app still holds never names another ball.
- `VisionResult` (001 data-model.md) carries `cloth: ClothModel | null` and the optional
  `reason: 'cloth-unknown' | 'bad-quad' | 'moved'` (manual corners that are not locked). A frame
  without a usable quad has `calibration: null` and no balls.

### `still` semantics

- It runs the full 001 pipeline on one still photo, as a one-shot. It uses a **separate pipeline
  instance**, so the live `frame` tracking state is never changed.
- It runs several passes on the same frame (`opts.iterations`, default 6, at most 20) so the tracker
  can lock. It returns the final `VisionResult`; `ms` covers all passes. `status` is `'locked'` when
  the table was found and stable; otherwise it is `'searching'` or `'unstable'`, with
  `calibration: null` when no table was found.
- `StillOptions` (optional; each field overrides the latest `config` for this one still):

  | Field | Type | Meaning |
  |---|---|---|
  | `manualCorners` | `Vec2[] \| null` | tapped cloth corners for this photo (null: automatic) |
  | `swapAxes` | boolean | the long/short rail swap |
  | `iterations` | number | pipeline passes (default 6) |
  | `fovDeg` | number | the lens hint for this photo; used only when it is a usable field of view (`calibration.ts` `usableFovDeg`), else the config's |

- Snap always sends `opts.manualCorners` (its taps or null), `opts.swapAxes: false` and
  `opts.fovDeg` (the Settings field of view). Only `table` comes from the latest `config`, so Snap
  never needs a config round-trip.
- Backpressure: at most one `still` in flight. A newer `still` makes older ones stale under the
  stale-result rule.

### `player-view` semantics

- It calls `estimatePlayerView(input)` ([player-view-api.md](./player-view-api.md)) and replies with
  its result unchanged.
- At most one `player-view` in flight. A newer request makes older ones stale.
- Failures inside the estimator are reported as `ok: false` with a `reason`, **not** as `error`.
  `error` is for malformed messages and exceptions.

## Planner worker (`planner.worker.ts`)

| Direction | Message | Fields | Since |
|---|---|---|---|
| app → worker | `recommend` | `id`, `layout`, `request` (`request.landing` = the position-play spot), `params`, `perEvalMs?` | v1 (+ `perEvalMs`) |
| worker → app | `recommendation` | `id`, every `Recommendation` field (`stroke`, `score`, `reachable`, `restError?`, `rest?`, `evaluated`, `risks?`, `fragile?`, `nextQuality?`, `timedOut?`), `perEvalMs?` | v1 (+ optional fields) |
| app → worker | **`plan`** | `id`, `layout`, `request`, `params`, `opts?: { names?, recommended? }` | **v2, optional** |
| worker → app | **`plan`** | `id`, `plan: ShotPlan` | **v2, optional** |
| app → worker | `suggest` | `id`, `layout`, `params`, `max` | v1 |
| worker → app | `suggestions` | `id`, `items: ShotSuggestion[]` | v1 |
| app → worker | `heatmap` | `id`, `layout`, `nextBallId`, `excludeIds` (the current target), `params`, `cols`, `rows` | v1 |
| worker → app | `heatmap` | `id`, `cols`, `rows`, `values: Float32Array` (row-major from −y, 0..1, transferred) | v1 |
| worker → app | `error` | `id?`, `message` | v1 |

- **Recommendation semantics** (001 data-model.md § Recommendation):
  - `score` is the robust score (001 research.md R-11); `Number.isFinite(score)` is false only when
    no stroke pots the ball.
  - `fragile: true`: no stroke was verified against ±6/±12 % speed errors. The app says
    "speed-sensitive".
  - `risks`: absent means "not known", never "safe". It may be absent for a stroke that is not
    fragile when the budget ran out before the tip/aim probes.
  - `timedOut: true`: the safety cap cut the search short.
  - `nextQuality`: next-shot quality 0..1 of the chosen stroke (default objective only).
- **`plan`**: the plan the app shows, planned with the frozen power advice **on** (`planShot`
  `advice: true`), which the app's own main-thread plan skips. `opts.recommended` is sent only when
  the request has no stroke (`planShot` ignores it otherwise). It matters only for a frozen cue ball
  hit too softly, where the advice replans the stroke at each half step above the played power.
- **Heatmap**: `params` sets the frozen-ball throw bound. `values` is all zeros when `nextBallId` is
  the cue ball, the current target (in `excludeIds`) or unknown. Cells where the cue ball would
  overlap an object ball are 0.

### Evaluation budget (per device)

The worker keeps `recommendStroke` deterministic by giving it an evaluation count, not a deadline
(`src/workers/eval-budget.ts`).
- Once per number of balls, it times one `planShot` with the options the search evaluates with
  (`record: false, advice: false`), best of 3 after a warm-up. It then passes
  `maxEvaluations` = ⌊1200 ms ÷ that cost⌋, clamped to 60…324 (`FULL_EVALUATIONS`).
- A budget below the grid + the half steps + the robustness walk's 108 evaluations skips the half
  steps, so the recommended power is a whole number.
- It also sets `timeCapMs: 1500` as a safety net (the < 1.5 s budget of Constitution IV). A search
  cut short by the cap is reported as `timedOut`.
- `perEvalMs` (optional, `PlannerPerEvalMs` = ms per evaluation keyed by ball count) comes back with
  every recommendation. The app keeps it, even from superseded replies, and sends it with each
  `recommend`. A worker adopts any ball count it has not measured itself, so the budget, and with it
  the recommended stroke, stays the same for the page's life across worker restarts.

## How the app uses the workers

- **Stale results**: the app enforces the stale-result rule against the latest request key
  (`planner-client.ts`). To abandon a superseded recommendation it may terminate and restart the
  planner worker when nothing else waits on it. A `plan` request still pending is re-sent to the new
  worker.
- **Full plans**: the app sends `plan` debounced 120 ms, only when its own plan says `adviceSkipped`,
  keyed by the table spec, the exact ball positions, the request, the physics and the options, and it
  accepts only the latest key.
- **Planner failures**: an `error` reply, a worker that fails to load or a `messageerror` clears the
  pending request.
- **Vision config**: `config` is sent only when the table frame really changes (table, field of view,
  manual corners, Rotate). The app keeps the live selection across Rotate and Calibrate by finding it
  again in the new frame (001 data-model.md § App state), and clears it for a table or field-of-view
  change.
- **Vision failures**: a vision worker that fails to load, or 3 consecutive `error` replies to live
  frames, shows a camera message with *Try again*. A new vision worker is a new tracker: the live
  selection is dropped when the old one fails and again when the new one is created, and messages
  from a replaced worker are ignored. A failure also ends a pending Snap `still` or `player-view`
  request, with a message (002 spec, Snap edge cases).

## Migration v1 → v2

- `PROTOCOL_VERSION` is shared by both workers and the app. They ship in one bundle, so the bump is
  atomic. There is no mixed-version operation. A v1 message reaching a v2 worker gets an `error`
  reply, as the common rules require.
- Every v1 message keeps its fields and meaning. Only `v` changes.
- New message types: `still` (both directions), `player-view` (both directions) and the optional
  `plan` (both directions). New optional fields: `still.opts`, `recommend.perEvalMs`,
  `recommendation.perEvalMs` and the newer `Recommendation` fields.
- `isSupported(msg)` returns `msg.v === 2`.

## Compatibility

As in v1: adding optional fields is a non-breaking change. Removing or renaming a field, or changing
its meaning, requires `v: 3` and a migration note here.
