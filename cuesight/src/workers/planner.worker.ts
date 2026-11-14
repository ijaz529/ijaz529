/// <reference lib="webworker" />
import { positionHeatmap, recommendStroke } from '../core/shot/position';
import { suggestShots } from '../core/shot/suggest';
import { PROTOCOL_VERSION, isSupported, type PlannerIn, type PlannerOut } from './protocol';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (ev: MessageEvent<PlannerIn>) => {
  const msg = ev.data;
  const post = (m: PlannerOut, t: Transferable[] = []) => ctx.postMessage(m, t);
  if (!isSupported(msg)) {
    post({ v: PROTOCOL_VERSION, type: 'error', message: 'Unsupported protocol version' });
    return;
  }
  try {
    switch (msg.type) {
      case 'recommend': {
        const r = recommendStroke(msg.layout, msg.request, msg.params, msg.request.landing ? { landing: msg.request.landing } : {});
        post({ v: PROTOCOL_VERSION, type: 'recommendation', id: msg.id, ...r });
        break;
      }
      case 'suggest':
        post({ v: PROTOCOL_VERSION, type: 'suggestions', id: msg.id, items: suggestShots(msg.layout, msg.params, msg.max) });
        break;
      case 'heatmap': {
        const values = positionHeatmap(msg.layout, msg.nextBallId, msg.cols, msg.rows, msg.excludeIds);
        post({ v: PROTOCOL_VERSION, type: 'heatmap', id: msg.id, cols: msg.cols, rows: msg.rows, values }, [values.buffer]);
        break;
      }
    }
  } catch (e) {
    post({ v: PROTOCOL_VERSION, type: 'error', id: msg.id, message: String(e) });
  }
};
