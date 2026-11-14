/// <reference lib="webworker" />
import { createPipeline } from '../vision/pipeline';
import { makeTable } from '../core/table';
import { PROTOCOL_VERSION, isSupported, type VisionIn, type VisionOut } from './protocol';

const ctx = self as unknown as DedicatedWorkerGlobalScope;
let pipeline = createPipeline({ table: makeTable('pool9') });

function post(msg: VisionOut, transfer: Transferable[] = []): void {
  ctx.postMessage(msg, transfer);
}

ctx.onmessage = (ev: MessageEvent<VisionIn>) => {
  const msg = ev.data;
  if (!isSupported(msg)) {
    post({ v: PROTOCOL_VERSION, type: 'error', message: `Unsupported protocol version ${String((msg as { v?: unknown }).v)}` });
    return;
  }
  try {
    switch (msg.type) {
      case 'config':
        pipeline.configure({ table: msg.table, fovDeg: msg.fovDeg, manualCorners: msg.manualCorners, swapAxes: msg.swapAxes });
        break;
      case 'reset':
        pipeline = createPipeline({ table: makeTable('pool9') });
        break;
      case 'frame': {
        const data = new Uint8ClampedArray(msg.buffer);
        const result = pipeline.process({ width: msg.width, height: msg.height, data });
        post({ v: PROTOCOL_VERSION, type: 'result', id: msg.id, result, buffer: msg.buffer }, [msg.buffer]);
        break;
      }
    }
  } catch (e) {
    const buffer = msg.type === 'frame' ? msg.buffer : undefined;
    post({ v: PROTOCOL_VERSION, type: 'error', id: msg.type === 'frame' ? msg.id : undefined, message: String(e), ...(buffer ? { buffer } : {}) }, buffer ? [buffer] : []);
  }
};
