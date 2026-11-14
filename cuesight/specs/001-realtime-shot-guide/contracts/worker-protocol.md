# Contract: Worker Message Protocol (v1)

Every message is a plain structured-cloneable object with `v: 1`, a `type`, and, for any
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
| worker → app | `result` | `id`, `result: VisionResult`, `buffer: ArrayBuffer` (transferred back for reuse) |
| worker → app | `error` | `id?`, `message` |

**Backpressure**: the app keeps at most **one** frame in flight. It captures the next frame only after
`result` or `error` arrives. This bounds latency to one processing time and never queues stale
frames.

## Planner worker (`planner.worker.ts`)

| Direction | Message | Fields |
|---|---|---|
| app → worker | `recommend` | `id`, `layout: TableLayout`, `request: ShotRequest`, `params: PhysicsParams` |
| worker → app | `recommendation` | `id`, `stroke: Stroke`, `score`, `reachable: boolean`, `restError?: number`, `evaluated: number` |
| app → worker | `suggest` | `id`, `layout`, `params`, `max` |
| worker → app | `suggestions` | `id`, `items: ShotSuggestion[]` |
| app → worker | `heatmap` | `id`, `layout`, `nextBallId`, `params`, `cols`, `rows` |
| worker → app | `heatmap` | `id`, `cols`, `rows`, `values: Float32Array` (row-major, 0..1, **transferred**) |
| worker → app | `error` | `id?`, `message` |

`ShotSuggestion = { targetId, pocketId, toleranceDeg, difficulty, score }`, sorted by descending
`score`.

## Compatibility

Adding optional fields is a non-breaking change. Removing or renaming a field, or changing its
meaning, requires `v: 2` and a migration note here.
