# Contract: Worker Message Protocol (v1)

> **Superseded by v2**: [002 worker-protocol-v2.md](../../002-3d-visual-ios/contracts/worker-protocol-v2.md).
> The code sends `v: 2` (`PROTOCOL_VERSION = 2`). v2 keeps every v1 message with the same fields and
> meaning, and adds `still` and `player-view`. The message tables below are the v1 messages as they
> are sent today. They were **revised 2026-11-15** to match `src/workers/protocol.ts` on `fix/wave1`;
> the corrections (and the optional fields) apply to v2 as well.

Every message is a plain structured-cloneable object with `v`, a `type`, and, for any
request/response pair, a numeric `id`. The receiver MUST ignore a message whose `v` it does not
support and reply with an `error`. The app MUST drop a response whose `id` is older than the latest
request of the same type (stale-result rule).

The TypeScript source of truth is `src/workers/protocol.ts`.

## Vision worker (`vision.worker.ts`)

| Direction | Message | Fields |
|---|---|---|
| app → worker | `config` | `table: TableSpec`, `fovDeg: number`, `manualCorners: Vec2[4] \| null`, `swapAxes: boolean` |
| app → worker | `frame` | `id`, `width`, `height`, `buffer: ArrayBuffer` (RGBA, **transferred**) |
| app → worker | `reset` | — |
| worker → app | `result` | `id`, `result: VisionResult`, `buffer: ArrayBuffer` (transferred back; **not reused** by the app, see below) |
| worker → app | `error` | `id?`, `message`, `buffer?` (the frame buffer, when the error came from a `frame`) |

- `config` reconfigures the live pipeline (`pipeline.configure`). Tracking restarts only on a
  geometry change: the table, the manual corners (compared by value) or `swapAxes`. Ball ids keep
  counting up across that restart, so an old id never names a different ball. Settings that change
  nothing geometric keep the lock and the ids.
- `reset` builds a **fresh pipeline** from the last `config`, so ball ids restart at `b1`. The app
  does not send it on `fix/wave1`. If it starts to, the worker should call `pipeline.reset()`
  instead, which keeps the id counter.
- `VisionResult` (data-model.md) adds the optional `cloth` and `reason` to the v1 shape. On a frame
  without a usable quad it has `calibration: null` and no balls.
- **Buffers**: the `frame` buffer is transferred to the worker and back in `result`. The app does
  not reuse it: 2D-canvas `getImageData` cannot fill an existing buffer, so every capture allocates
  a new RGBA frame (per frame, not per pixel). Real reuse would need `VideoFrame.copyTo` into a
  pooled buffer. The earlier text "transferred back for reuse" was not true.

**Backpressure**: the app keeps at most **one** frame in flight. It captures the next frame only after
`result` or `error` arrives. This bounds latency to one processing time and never queues stale
frames.

## Planner worker (`planner.worker.ts`)

| Direction | Message | Fields |
|---|---|---|
| app → worker | `recommend` | `id`, `layout: TableLayout`, `request: ShotRequest` (`request.landing` = the position-play spot), `params: PhysicsParams` |
| worker → app | `recommendation` | `id` plus every `Recommendation` field: `stroke: Stroke`, `score`, `reachable: boolean`, `restError?`, `rest?: Vec2 \| null`, `evaluated: number`, `fragile?: boolean`, `nextQuality?: number`, `timedOut?: boolean` |
| app → worker | `suggest` | `id`, `layout`, `params`, `max` |
| worker → app | `suggestions` | `id`, `items: ShotSuggestion[]` |
| app → worker | `heatmap` | `id`, `layout`, `nextBallId: string`, `excludeIds: string[]` (the current target), `params` (sets the frozen-ball throw bound), `cols`, `rows` |
| worker → app | `heatmap` | `id`, `cols`, `rows`, `values: Float32Array` (row-major from −y, 0..1, **transferred**) |
| worker → app | `error` | `id?`, `message` |

`ShotSuggestion = { targetId, pocketId, toleranceDeg, difficulty, score }`, sorted by descending
`score` (data-model.md).

**Recommendation semantics**:
- `score` is the worst-case robust score (research.md R-11). `Number.isFinite(score)` is false only
  when no stroke pots the ball.
- `fragile: true` means no stroke was verified against ±6/±12 % speed errors: show a
  "speed-sensitive" note.
- `timedOut: true` means the search is partial.

**Evaluation budget (per device)**: the worker keeps `recommendStroke` deterministic by giving it an
evaluation count, not a deadline.
- Once per device and number of balls, it times one `planShot` (best of 3 after a warm-up). It then
  passes `maxEvaluations` = ⌊1200 ms ÷ that cost⌋, clamped to 60…228.
- It also sets `timeCapMs: 1500` as a safety net (the < 1.5 s budget of Constitution IV). A search
  cut short by the cap is reported as `timedOut`.

**Heatmap semantics**: `values` is all zeros when `nextBallId` is the cue ball, the current target
(in `excludeIds`) or unknown. Cells where the cue ball would overlap an object ball are 0.

## Compatibility

Adding optional fields is a non-breaking change. Removing or renaming a field, or changing its
meaning, requires a version bump and a migration note. v1 → v2 is described in the 002 contract.
