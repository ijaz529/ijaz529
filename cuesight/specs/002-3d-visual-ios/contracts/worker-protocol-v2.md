# Contract: Worker Message Protocol (v2)

v2 supersedes [001 worker-protocol.md](../../001-realtime-shot-guide/contracts/worker-protocol.md)
(v1). The TypeScript source of truth is `src/workers/protocol.ts`, with `PROTOCOL_VERSION = 2`.

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
| worker → app | `result` | `id`, `result: VisionResult`, `buffer: ArrayBuffer` (transferred back for reuse) | v1 |
| app → worker | **`still`** | `id`, `frame: Frame` (`{ width, height, data: Uint8ClampedArray }`; `data.buffer` **transferred**) | **v2** |
| worker → app | **`still`** | `id`, `result: VisionResult` | **v2** |
| app → worker | **`player-view`** | `id`, `input: PlayerViewInput` (`input.frame.data.buffer` **transferred**) | **v2** |
| worker → app | **`player-view`** | `id`, `result: PlayerViewResult` | **v2** |
| worker → app | `error` | `id?`, `message`, `buffer?` | v1 |

### `still` semantics

- It runs the full 001 pipeline on one still photo, as a one-shot. It uses a **separate pipeline
  instance**, so the live `frame` tracking state is never changed.
- It runs several internal iterations on the same frame (default 6) so the tracker can lock. It
  returns the final `VisionResult`; `ms` covers all iterations. `status` is `'locked'` when the
  table was found and stable; otherwise it is `'searching'` or `'unstable'`, with
  `calibration: null` when no table was found.
- Configuration (`table`, `fovDeg`, `swapAxes`, `manualCorners`) comes from the **latest `config`
  message**. To process a still with tapped corners, the app sends `config` with `manualCorners`,
  then `still`. It sends `config` again (with `manualCorners: null`) before returning to Live.
- Backpressure: at most one `still` in flight. A newer `still` makes older ones stale under the
  stale-result rule.

### `player-view` semantics

- It calls `estimatePlayerView(input)` ([player-view-api.md](./player-view-api.md)) and replies with
  its result unchanged.
- At most one `player-view` in flight. A newer request makes older ones stale.
- Failures inside the estimator are reported as `ok: false` with a `reason`, **not** as `error`.
  `error` is for malformed messages and exceptions.

## Planner worker (`planner.worker.ts`)

Unchanged apart from `v: 2`:

| Direction | Message | Fields |
|---|---|---|
| app → worker | `recommend` | `id`, `layout`, `request`, `params` |
| worker → app | `recommendation` | `id`, `stroke`, `score`, `reachable`, `restError?`, `rest?`, `evaluated` |
| app → worker | `suggest` | `id`, `layout`, `params`, `max` |
| worker → app | `suggestions` | `id`, `items: ShotSuggestion[]` |
| app → worker | `heatmap` | `id`, `layout`, `nextBallId`, `excludeIds`, `params`, `cols`, `rows` |
| worker → app | `heatmap` | `id`, `cols`, `rows`, `values: Float32Array` (transferred) |
| worker → app | `error` | `id?`, `message` |

## Migration v1 → v2

- `PROTOCOL_VERSION` is shared by both workers and the app. They ship in one bundle, so the bump is
  atomic. There is no mixed-version operation. A v1 message reaching a v2 worker gets an `error`
  reply, as the common rules require.
- Every v1 message keeps its fields and meaning. Only `v` changes.
- New message types: `still` (both directions) and `player-view` (both directions).
- `isSupported(msg)` returns `msg.v === 2`.

## Proposed optional extension (not yet in the API of record)

These fields are non-breaking, so they need no version bump. `integrate` may ask for them:

- `still.opts?: { manualCorners?: Vec2[4]; swapAxes?: boolean; iterations?: number }`. This would
  override the `config` values for that one still and remove the config round-trip described above.
- `still` reply `cloth?: ClothModel` (already inside `VisionResult.cloth`; listed so that consumers
  can rely on it for `Scene3DData.clothRgb`).

## Compatibility

As in v1: adding optional fields is a non-breaking change. Removing or renaming a field, or changing
its meaning, requires `v: 3` and a migration note here.
