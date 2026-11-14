/// <reference lib="webworker" />
/**
 * Vision worker (protocol v2, specs/002-3d-visual-ios/contracts/worker-protocol-v2.md):
 *  - `config` / `frame` / `reset`: the live 001 pipeline (unchanged behaviour);
 *  - `still`: the full pipeline run several times on one photo through a *separate* pipeline, so live
 *    tracking state is never touched; configuration comes from the latest `config` (+ optional opts);
 *  - `player-view`: `estimatePlayerView` on a table-level photo; its failures are `ok: false` results
 *    with a reason, never `error` replies.
 * The handler is a plain function (testable in Node); it is bound to `onmessage` only inside a worker.
 */
import { makeTable } from '../core/table';
import type { TableSpec, Vec2 } from '../core/types';
import type { Frame } from '../vision/image';
import { createPipeline, type VisionResult } from '../vision/pipeline';
import { estimatePlayerView } from '../vision/player-view';
import { PROTOCOL_VERSION, isSupported, type StillOptions, type VisionIn, type VisionOut } from './protocol';

export interface VisionConfig {
  table: TableSpec;
  fovDeg: number;
  manualCorners: Vec2[] | null;
  swapAxes: boolean;
}

export const STILL_ITERATIONS = 6;

/**
 * One-shot full pipeline on a still photo: a fresh pipeline processes the same frame `iterations`
 * times (the tracker locks after 5 calm frames) and the last result is returned, with `ms` covering
 * every pass.
 */
export function processStill(frame: Frame, cfg: VisionConfig, opts: StillOptions = {}): VisionResult {
  const t0 = performance.now();
  const manualCorners = opts.manualCorners !== undefined ? opts.manualCorners : cfg.manualCorners;
  const pipeline = createPipeline({ table: cfg.table, fovDeg: cfg.fovDeg, manualCorners, swapAxes: opts.swapAxes ?? cfg.swapAxes });
  const n = Math.max(1, Math.min(20, Math.round(opts.iterations ?? STILL_ITERATIONS)));
  let result = pipeline.process(frame);
  for (let i = 1; i < n; i++) result = pipeline.process(frame);
  return { ...result, ms: performance.now() - t0 };
}

export interface VisionReply {
  msg: VisionOut;
  transfer: Transferable[];
}

/** Stateful message handler: returns the reply to post (and what to transfer), or null for none. */
export function createVisionHandler(): (msg: VisionIn) => VisionReply | null {
  let cfg: VisionConfig = { table: makeTable('pool9'), fovDeg: 65, manualCorners: null, swapAxes: false };
  let pipeline = createPipeline({ ...cfg });
  const error = (message: string, id?: number, buffer?: ArrayBuffer): VisionReply => ({
    msg: { v: PROTOCOL_VERSION, type: 'error', ...(id !== undefined ? { id } : {}), message, ...(buffer ? { buffer } : {}) },
    transfer: buffer ? [buffer] : [],
  });
  return (msg) => {
    if (!isSupported(msg)) return error(`Unsupported protocol version ${String((msg as { v?: unknown }).v)}`);
    const id = 'id' in msg ? msg.id : undefined;
    const frameBuffer = msg.type === 'frame' ? msg.buffer : undefined;
    try {
      switch (msg.type) {
        case 'config':
          cfg = { table: msg.table, fovDeg: msg.fovDeg, manualCorners: msg.manualCorners, swapAxes: msg.swapAxes };
          pipeline.configure({ ...cfg });
          return null;
        case 'reset':
          pipeline = createPipeline({ ...cfg });
          return null;
        case 'frame': {
          const data = new Uint8ClampedArray(msg.buffer);
          const result = pipeline.process({ width: msg.width, height: msg.height, data });
          return { msg: { v: PROTOCOL_VERSION, type: 'result', id: msg.id, result, buffer: msg.buffer }, transfer: [msg.buffer] };
        }
        case 'still':
          return { msg: { v: PROTOCOL_VERSION, type: 'still', id: msg.id, result: processStill(msg.frame, cfg, msg.opts) }, transfer: [] };
        case 'player-view':
          return { msg: { v: PROTOCOL_VERSION, type: 'player-view', id: msg.id, result: estimatePlayerView(msg.input) }, transfer: [] };
        default:
          return error(`Unknown message type ${String((msg as { type?: unknown }).type)}`, id);
      }
    } catch (e) {
      return error(String(e), id, frameBuffer);
    }
  };
}

// Bind only when running as a dedicated worker (not when imported by tests).
if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {
  const ctx = self as unknown as DedicatedWorkerGlobalScope;
  const handle = createVisionHandler();
  ctx.onmessage = (ev: MessageEvent<VisionIn>) => {
    const reply = handle(ev.data);
    if (reply) ctx.postMessage(reply.msg, reply.transfer);
  };
}
