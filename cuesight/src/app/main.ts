/**
 * CueSight app wiring: modes (camera / practice), interactions, planning, workers and rendering.
 */
import './styles.css';
import { planShot, stunVert } from '../core/shot/planner';
import { powerToSpeed } from '../core/shot/power';
import { POCKET_NAMES, clampToTable } from '../core/table';
import type { Ball, PocketId, ShotPlan, ShotSuggestion, Stroke, TableLayout, Vec2 } from '../core/types';
import { dist } from '../core/vec';
import { PROTOCOL_VERSION, type PlannerIn, type PlannerOut, type VisionOut } from '../workers/protocol';
import { FrameGrabber, describeCameraError, startCamera, stopCamera } from './camera';
import { DRILLS, cueBall, objectBall } from './drills';
import { Overlay, containMapping, type OverlayData } from './render/overlay';
import { rgbCss } from './render/palette';
import { TableView } from './render/table-view';
import { loadSettings, physicsFor, saveSettings, tableFor, type Settings } from './settings';
import { createStore, type AppState, type Mode } from './store';
import { buildSettings, buildStrokeControls, buildToolbar, renderSuggestions } from './ui/controls';
import { renderShotCard } from './ui/shot-card';

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------
const settings = loadSettings();
const table = tableFor(settings);
const params = new URLSearchParams(location.search);
const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
const initialMode: Mode = params.get('mode') === 'practice' ? 'practice' : params.get('mode') === 'camera' ? 'camera' : coarse ? 'camera' : 'practice';

const store = createStore({
  mode: initialMode,
  settings,
  table,
  params: physicsFor(settings),
  practice: { table, balls: DRILLS[0]!.build(table), source: 'virtual', frozen: false },
  vision: null,
  frozen: null,
  targetId: null,
  pocketId: null,
  strokeMode: 'recommended',
  myStroke: { power: 4, side: 0, vert: 0 },
  recommended: null,
  landing: null,
  interaction: 'select',
  calibTaps: [],
  manualCorners: null,
  swapAxes: false,
  heatmap: null,
  suggestions: null,
  plan: null,
  cameraError: null,
  cueOverrideId: null,
  toast: null,
} satisfies AppState);
const S = store.state;

// ---------------------------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------------------------
const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const video = $<HTMLVideoElement>('#video');
const overlay = new Overlay($<HTMLCanvasElement>('#overlay'));
const practiceView = new TableView($<HTMLCanvasElement>('#table'));
const miniView = new TableView($<HTMLCanvasElement>('#minimap'));
const card = $<HTMLElement>('#shot-card');
const sugEl = $<HTMLElement>('#suggestions');
const statusPill = $<HTMLElement>('#status');
const camMsg = $<HTMLElement>('#camera-msg');
const toastEl = $<HTMLElement>('#toast');
const settingsDlg = $<HTMLDialogElement>('#settings');

// ---------------------------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------------------------
function cameraLayout(): TableLayout | null {
  if (S.frozen) return S.frozen.layout;
  if (!S.vision || !S.vision.calibration) return null;
  const balls: Ball[] = S.vision.balls.map((b) => ({ ...b }));
  if (S.cueOverrideId && balls.some((b) => b.id === S.cueOverrideId)) {
    for (const b of balls) b.kind = b.id === S.cueOverrideId ? 'cue' : 'object';
  }
  return { table: S.table, balls, source: 'camera', frozen: false };
}

function currentLayout(): TableLayout | null {
  return S.mode === 'practice' ? S.practice : cameraLayout();
}

function labelOf(id: string): string {
  const b = currentLayout()?.balls.find((x) => x.id === id);
  return b?.label ?? id;
}

/** Pocket names as the player sees them: screen-relative on the practice table, near/far in camera view. */
function pocketNames(): Record<PocketId, string> {
  const out = { ...POCKET_NAMES };
  const name = (pk: (typeof S.table.pockets)[number], q: Vec2, c: Vec2, camera: boolean) => {
    const dx = q.x - c.x;
    const dy = q.y - c.y;
    const v = camera ? (dy < 0 ? 'far' : 'near') : dy < 0 ? 'top' : 'bottom';
    const h = dx < 0 ? 'left' : 'right';
    if (pk.kind === 'corner') return camera ? `${v} ${h} corner` : `${v}-${h} corner`;
    return Math.abs(dx) > Math.abs(dy) ? `${h} side` : `${v} side`;
  };
  if (S.mode === 'practice') {
    const c = practiceView.toCanvas({ x: 0, y: 0 });
    for (const pk of S.table.pockets) out[pk.id] = name(pk, practiceView.toCanvas(pk.mouthCenter), c, false);
  } else {
    const cal = S.frozen?.calibration ?? S.vision?.calibration;
    if (cal) {
      const pr = (p: Vec2) => {
        const H = cal.H0;
        const w = H[6]! * p.x + H[7]! * p.y + H[8]!;
        return { x: (H[0]! * p.x + H[1]! * p.y + H[2]!) / w, y: (H[3]! * p.x + H[4]! * p.y + H[5]!) / w };
      };
      const c = pr({ x: 0, y: 0 });
      for (const pk of S.table.pockets) out[pk.id] = name(pk, pr(pk.mouthCenter), c, true);
    }
  }
  return out;
}

function toast(msg: string, ms = 2600): void {
  store.update((s) => (s.toast = msg));
  window.setTimeout(() => store.update((s) => (s.toast === msg ? (s.toast = null) : null)), ms);
}

// ---------------------------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------------------------
let planner: Worker | null = null;
let reqId = 0;
const latest: Record<string, number> = {};

function plannerWorker(): Worker {
  if (!planner) {
    planner = new Worker(new URL('../workers/planner.worker.ts', import.meta.url), { type: 'module' });
    planner.onmessage = (ev: MessageEvent<PlannerOut>) => onPlanner(ev.data);
  }
  return planner;
}

function send(kind: 'recommend' | 'suggest' | 'heatmap', msg: Omit<PlannerIn, 'v' | 'id'>): number {
  const id = ++reqId;
  latest[kind] = id;
  plannerWorker().postMessage({ ...msg, v: PROTOCOL_VERSION, id } as PlannerIn);
  return id;
}

function onPlanner(m: PlannerOut): void {
  if (m.type === 'recommendation') {
    if (m.id !== latest.recommend) return; // stale
    store.update((s) => {
      if (!s.recommended) return;
      s.recommended = { ...s.recommended, stroke: Number.isFinite(m.score) ? m.stroke : null, pending: false, reachable: m.reachable, evaluated: m.evaluated };
      if (s.landing && !m.reachable) toast('That spot can’t be reached safely — showing the closest safe stroke.');
    });
    replan();
  } else if (m.type === 'suggestions') {
    if (m.id !== latest.suggest) return;
    store.update((s) => (s.suggestions = { items: m.items, pending: false }));
  } else if (m.type === 'heatmap') {
    if (m.id !== latest.heatmap) return;
    store.update((s) => s.heatmap && (s.heatmap = { ...s.heatmap, cols: m.cols, rows: m.rows, values: m.values, pending: false }));
  } else if (m.type === 'error') {
    console.warn('planner error', m.message);
  }
}

function layoutKey(l: TableLayout): string {
  return l.balls.map((b) => `${b.id}:${Math.round(b.pos.x * 200)},${Math.round(b.pos.y * 200)}:${b.kind}`).join('|');
}

let recTimer = 0;
function requestRecommendation(layout: TableLayout): void {
  if (!S.targetId) return;
  const key = `${layoutKey(layout)}#${S.targetId}#${S.pocketId}#${S.landing ? `${S.landing.x.toFixed(2)},${S.landing.y.toFixed(2)}` : ''}#${JSON.stringify(S.params)}`;
  if (S.recommended?.key === key) return;
  store.update((s) => (s.recommended = { key, stroke: null, pending: true, reachable: true, evaluated: 0 }));
  window.clearTimeout(recTimer);
  recTimer = window.setTimeout(() => {
    send('recommend', {
      type: 'recommend',
      layout,
      request: { targetId: S.targetId!, ...(S.pocketId ? { pocketId: S.pocketId } : {}), ...(S.landing ? { landing: S.landing } : {}) },
      params: S.params,
    } as Omit<PlannerIn, 'v' | 'id'>);
  }, 180);
}

function replan(): void {
  const layout = currentLayout();
  let plan: ShotPlan | null = null;
  if (layout && S.targetId) {
    const target = layout.balls.find((b) => b.id === S.targetId);
    const hasCue = layout.balls.some((b) => b.kind === 'cue');
    if (target && target.kind !== 'cue' && hasCue) {
      const rec = S.recommended && !S.recommended.pending && S.recommended.stroke ? S.recommended.stroke : undefined;
      try {
        plan = planShot(
          layout,
          { targetId: S.targetId, ...(S.pocketId ? { pocketId: S.pocketId } : {}), ...(S.strokeMode === 'mine' ? { stroke: S.myStroke } : {}) },
          S.params,
          { names: pocketNames(), ...(rec ? { recommended: rec } : {}) },
        );
      } catch (e) {
        console.warn(e);
      }
      if (S.strokeMode === 'recommended') requestRecommendation(layout);
    }
  }
  store.update((s) => {
    s.plan = plan;
    if (plan && s.strokeMode === 'recommended') s.myStroke = { ...plan.stroke };
  });
}

// ---------------------------------------------------------------------------------------------
// Selection & interactions (shared by practice table, mini-map and AR overlay)
// ---------------------------------------------------------------------------------------------
function selectBall(b: Ball): void {
  if (S.interaction === 'mark-cue') {
    store.update((s) => {
      s.cueOverrideId = b.id;
      s.interaction = 'select';
      if (s.targetId === b.id) s.targetId = null;
    });
    toast('Cue ball set.');
    replan();
    return;
  }
  if (S.interaction === 'pick-next') {
    requestHeatmap(b.id);
    return;
  }
  if (b.kind === 'cue') {
    toast('That’s the cue ball — tap the ball you want to pocket.');
    return;
  }
  store.update((s) => {
    if (s.targetId !== b.id) {
      s.targetId = b.id;
      s.pocketId = null;
      s.landing = null;
      s.recommended = null;
      s.strokeMode = 'recommended';
    }
  });
  replan();
}

function selectPocket(p: PocketId): void {
  if (!S.targetId) {
    toast('Tap a ball first, then a pocket.');
    return;
  }
  store.update((s) => {
    s.pocketId = p;
    s.recommended = null;
  });
  replan();
}

function tableTap(p: Vec2): void {
  if (S.interaction === 'position') {
    if (!S.targetId) {
      toast('Pick a ball and pocket first.');
      return;
    }
    store.update((s) => {
      s.landing = clampToTable(s.table, p);
      s.interaction = 'select';
      s.strokeMode = 'recommended';
      s.recommended = null;
    });
    toast('Finding the stroke that lands there…');
    replan();
  }
}

function requestHeatmap(nextBallId: string): void {
  const layout = currentLayout();
  if (!layout) return;
  store.update((s) => {
    s.interaction = 'select';
    s.heatmap = { nextBallId, cols: 48, rows: 24, values: new Float32Array(48 * 24), pending: true };
  });
  send('heatmap', { type: 'heatmap', layout, nextBallId, excludeIds: S.targetId ? [S.targetId] : [], params: S.params, cols: 48, rows: 24 } as Omit<PlannerIn, 'v' | 'id'>);
  toast(`Bright zones = easy shot on ${labelOf(nextBallId)} next.`);
}

// Practice table: tap to select, drag to move balls.
{
  const canvas = practiceView.canvas;
  let drag: { id: string; startX: number; startY: number; moved: boolean } | null = null;
  const local = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  canvas.addEventListener('pointerdown', (e) => {
    const q = local(e);
    const b = practiceView.ballAt(q, S.practice.balls);
    if (b) {
      drag = { id: b.id, startX: q.x, startY: q.y, moved: false };
      canvas.setPointerCapture(e.pointerId);
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const q = local(e);
    if (!drag.moved && Math.hypot(q.x - drag.startX, q.y - drag.startY) < 6) return;
    drag.moved = true;
    const id = drag.id;
    store.update((s) => {
      const R = s.table.ballRadius;
      let p = clampToTable(s.table, practiceView.toTable(q));
      for (const o of s.practice.balls)
        if (o.id !== id && dist(o.pos, p) < 2 * R) {
          const d = dist(o.pos, p) || 1e-6;
          p = clampToTable(s.table, { x: o.pos.x + ((p.x - o.pos.x) / d) * 2 * R, y: o.pos.y + ((p.y - o.pos.y) / d) * 2 * R });
        }
      s.practice = { ...s.practice, balls: s.practice.balls.map((b) => (b.id === id ? { ...b, pos: p } : b)) };
      s.recommended = null;
      s.suggestions = null;
      s.heatmap = null;
    });
    replan();
  });
  canvas.addEventListener('pointerup', (e) => {
    const q = local(e);
    if (drag && !drag.moved) {
      const b = S.practice.balls.find((x) => x.id === drag!.id);
      if (b) selectBall(b);
    } else if (!drag) {
      const pk = practiceView.pocketAt(q);
      if (pk && S.interaction !== 'position') selectPocket(pk);
      else tableTap(practiceView.toTable(q));
    }
    drag = null;
  });
}

// Mini-map taps (camera mode).
miniView.canvas.addEventListener('click', (e) => {
  const r = miniView.canvas.getBoundingClientRect();
  const q = { x: e.clientX - r.left, y: e.clientY - r.top };
  const layout = currentLayout();
  if (!layout) return;
  const b = miniView.ballAt(q, layout.balls);
  if (b) return selectBall(b);
  const pk = miniView.pocketAt(q);
  if (pk && S.interaction !== 'position') return selectPocket(pk);
  tableTap(miniView.toTable(q));
});

// AR overlay taps.
function overlayData(): OverlayData {
  const layout = currentLayout();
  const cal = S.frozen ? (S.frozen.calibration && liveMatchesFrozen() ? S.vision!.calibration : null) : (S.vision?.calibration ?? null);
  return {
    table: S.table,
    calibration: cal,
    balls: layout?.balls ?? [],
    plan: S.plan,
    targetId: S.targetId,
    pocketId: S.pocketId,
    calibTaps: S.calibTaps,
    showPlan: true,
  };
}
function frameMapping() {
  const r = overlay.canvas.getBoundingClientRect();
  return containMapping(S.vision?.frameW ?? (video.videoWidth || 640), S.vision?.frameH ?? (video.videoHeight || 480), r.width, r.height);
}
overlay.canvas.addEventListener('click', (e) => {
  const r = overlay.canvas.getBoundingClientRect();
  const tap = { x: e.clientX - r.left, y: e.clientY - r.top };
  const map = frameMapping();
  if (S.interaction === 'calibrate') {
    const f = map.toFrame(tap);
    store.update((s) => s.calibTaps.push(f));
    if (S.calibTaps.length === 4) {
      store.update((s) => {
        s.manualCorners = s.calibTaps.slice();
        s.calibTaps = [];
        s.interaction = 'select';
      });
      configureVision();
      toast('Calibrated from your four corners.');
    } else toast(`Corner ${S.calibTaps.length}/4 — tap the next corner of the cloth.`);
    return;
  }
  const hit = Overlay.hitTest(tap, overlayData(), map);
  if (hit.ball) selectBall(hit.ball);
  else if (hit.pocket && S.interaction !== 'position') selectPocket(hit.pocket);
  else if (hit.table) tableTap(hit.table);
});

// ---------------------------------------------------------------------------------------------
// Camera + vision worker
// ---------------------------------------------------------------------------------------------
let vision: Worker | null = null;
let inFlight = false;
let frameId = 0;
let cameraOn = false;
const grabber = new FrameGrabber(640);
let frameSize = { w: 640, h: 480 };

function configureVision(): void {
  vision?.postMessage({ v: PROTOCOL_VERSION, type: 'config', table: S.table, fovDeg: S.settings.fovDeg, manualCorners: S.manualCorners, swapAxes: S.swapAxes });
}

function liveMatchesFrozen(): boolean {
  const a = S.frozen?.calibration?.corners;
  const b = S.vision?.calibration?.corners;
  if (!a || !b || S.vision?.status !== 'locked') return false;
  const diag = Math.hypot(S.vision.frameW, S.vision.frameH);
  return a.every((p) => b.some((q) => Math.hypot(p.x - q.x, p.y - q.y) < 0.03 * diag));
}

async function enterCamera(): Promise<void> {
  if (cameraOn) return;
  try {
    await startCamera(video);
    cameraOn = true;
    store.update((s) => (s.cameraError = null));
    if (!vision) {
      vision = new Worker(new URL('../workers/vision.worker.ts', import.meta.url), { type: 'module' });
      vision.onmessage = (ev: MessageEvent<VisionOut>) => onVision(ev.data);
      configureVision();
    }
    pump();
  } catch (e) {
    store.update((s) => (s.cameraError = describeCameraError(e)));
  }
}

function leaveCamera(): void {
  cameraOn = false;
  stopCamera(video);
}

function pump(): void {
  if (!cameraOn) return;
  if (!inFlight && vision && video.readyState >= 2) {
    const f = grabber.grab(video);
    if (f) {
      inFlight = true;
      frameSize = { w: f.width, h: f.height };
      vision.postMessage({ v: PROTOCOL_VERSION, type: 'frame', id: ++frameId, width: f.width, height: f.height, buffer: f.buffer }, [f.buffer]);
    }
  }
  requestAnimationFrame(pump);
}

let lastVisionKey = '';
function onVision(m: VisionOut): void {
  inFlight = false;
  if (m.type === 'error') {
    console.warn('vision error', m.message);
    return;
  }
  const r = m.result;
  const balls: Ball[] = r.balls.map((b) => ({
    id: b.id,
    kind: b.isCue ? 'cue' : 'object',
    pos: b.pos,
    label: b.isCue ? 'cue' : b.label,
    color: rgbCss(b.rgb),
    stripe: b.label.includes('stripe'),
    confidence: b.confidence,
  }));
  store.update((s) => {
    s.vision = { status: r.status, calibration: r.calibration, balls, quality: r.quality, ms: r.ms, frameW: frameSize.w, frameH: frameSize.h };
  });
  if (!S.frozen) {
    const key = balls.map((b) => `${b.id}:${Math.round(b.pos.x * 100)},${Math.round(b.pos.y * 100)}`).join('|');
    if (key !== lastVisionKey) {
      lastVisionKey = key;
      replan();
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------------------------
function setMode(mode: Mode): void {
  store.update((s) => {
    s.mode = mode;
    s.targetId = null;
    s.pocketId = null;
    s.plan = null;
    s.landing = null;
    s.recommended = null;
    s.suggestions = null;
    s.heatmap = null;
    s.interaction = 'select';
  });
  if (mode === 'camera') void enterCamera();
  else leaveCamera();
  const u = new URL(location.href);
  u.searchParams.set('mode', mode);
  history.replaceState(null, '', u);
  replan();
}

const toolbar = buildToolbar($<HTMLElement>('#toolbar'), {
  freeze() {
    if (S.frozen) {
      store.update((s) => (s.frozen = null));
      toast('Live again.');
    } else {
      const l = cameraLayout();
      if (!l || !S.vision?.calibration) return toast('Point at the table first — nothing to freeze yet.');
      store.update((s) => (s.frozen = { layout: { ...l, frozen: true }, calibration: s.vision!.calibration }));
      toast('Layout frozen — move freely; the plan stays on the map.');
    }
    replan();
  },
  calibrate() {
    if (S.manualCorners || S.interaction === 'calibrate') {
      store.update((s) => {
        s.manualCorners = null;
        s.calibTaps = [];
        s.interaction = 'select';
      });
      configureVision();
      toast('Back to automatic table detection.');
      return;
    }
    store.update((s) => {
      s.interaction = 'calibrate';
      s.calibTaps = [];
    });
    toast('Tap the 4 corners where the cloth meets the rails.', 4000);
  },
  swapAxes() {
    store.update((s) => (s.swapAxes = !s.swapAxes));
    configureVision();
    toast('Swapped long and short rails.');
  },
  markCue() {
    store.update((s) => (s.interaction = s.interaction === 'mark-cue' ? 'select' : 'mark-cue'));
    if (S.interaction === 'mark-cue') toast('Tap the cue ball.');
  },
  suggest() {
    if (S.suggestions) return store.update((s) => (s.suggestions = null));
    const layout = currentLayout();
    if (!layout) return toast('No table yet.');
    store.update((s) => (s.suggestions = { items: [], pending: true }));
    send('suggest', { type: 'suggest', layout, params: S.params, max: 3 } as Omit<PlannerIn, 'v' | 'id'>);
  },
  position() {
    if (S.landing) {
      store.update((s) => {
        s.landing = null;
        s.recommended = null;
      });
      replan();
      return;
    }
    if (!S.targetId) return toast('Pick a ball (and pocket) first.');
    store.update((s) => (s.interaction = s.interaction === 'position' ? 'select' : 'position'));
    if (S.interaction === 'position') toast('Tap where you want the cue ball to stop.');
  },
  zones() {
    if (S.heatmap || S.interaction === 'pick-next') {
      store.update((s) => {
        s.heatmap = null;
        s.interaction = 'select';
      });
      return;
    }
    store.update((s) => (s.interaction = 'pick-next'));
    toast('Tap the ball you want to play next.');
  },
  clear() {
    store.update((s) => {
      s.targetId = null;
      s.pocketId = null;
      s.landing = null;
      s.recommended = null;
      s.heatmap = null;
      s.suggestions = null;
      s.interaction = 'select';
      s.strokeMode = 'recommended';
    });
    replan();
  },
  addBall() {
    store.update((s) => {
      const used = new Set(s.practice.balls.map((b) => b.id));
      let n = 1;
      while (used.has(`b${n}`)) n++;
      const R = s.table.ballRadius;
      let p: Vec2 = { x: 0, y: 0 };
      for (let k = 0; k < 200; k++) {
        p = { x: (Math.random() - 0.5) * (s.table.length - 4 * R), y: (Math.random() - 0.5) * (s.table.width - 4 * R) };
        if (s.practice.balls.every((b) => dist(b.pos, p) > 3 * R)) break;
      }
      const balls = s.practice.balls.some((b) => b.kind === 'cue') ? [...s.practice.balls, objectBall(n, p)] : [...s.practice.balls, cueBall(p)];
      s.practice = { ...s.practice, balls };
    });
    replan();
  },
  removeBall() {
    if (!S.targetId) return toast('Select a ball to remove.');
    store.update((s) => {
      s.practice = { ...s.practice, balls: s.practice.balls.filter((b) => b.id !== s.targetId) };
      s.targetId = null;
      s.plan = null;
    });
    replan();
  },
  drill(id) {
    const d = DRILLS.find((x) => x.id === id);
    if (!d) return;
    store.update((s) => {
      s.practice = { ...s.practice, balls: d.build(s.table) };
      s.targetId = null;
      s.pocketId = null;
      s.landing = null;
      s.recommended = null;
      s.suggestions = null;
      s.heatmap = null;
    });
    replan();
  },
});

function cbDistance(): number {
  const l = currentLayout();
  const cue = l?.balls.find((b) => b.kind === 'cue');
  return cue && S.plan ? dist(cue.pos, S.plan.ghost) : 1;
}

const strokeControls = buildStrokeControls($<HTMLElement>('#stroke-controls'), {
  power(p) {
    store.update((s) => {
      s.strokeMode = 'mine';
      s.myStroke = { ...s.myStroke, power: p };
    });
    replan();
  },
  spin(side, vert) {
    store.update((s) => {
      s.strokeMode = 'mine';
      s.myStroke = { ...s.myStroke, side, vert };
    });
    replan();
  },
  preset(name) {
    const st: Stroke = { ...S.myStroke };
    if (name === 'stun') {
      // A stun needs enough pace for the backspin to last exactly until contact: raise power if needed.
      const d = cbDistance();
      let p = st.power;
      while (p < 10 && stunVert(d, powerToSpeed(p), S.params) < -0.45) p += 0.5;
      if (p > st.power) toast(`Stun from this distance needs more pace — power raised to ${p}.`);
      st.power = p;
      st.vert = Math.round(stunVert(d, powerToSpeed(p), S.params) * 100) / 100;
    }
    if (name === 'draw') st.vert = -0.4;
    if (name === 'follow') st.vert = 0.4;
    if (name === 'centre') st.side = 0;
    if (name === 'left') st.side = -0.25;
    if (name === 'right') st.side = 0.25;
    store.update((s) => {
      s.strokeMode = 'mine';
      s.myStroke = st;
    });
    replan();
  },
  useRecommended() {
    store.update((s) => (s.strokeMode = 'recommended'));
    replan();
  },
});

buildSettings(settingsDlg, () => S.settings, (next: Settings) => {
  saveSettings(next);
  const t = tableFor(next);
  store.update((s) => {
    const tableChanged = next.table !== s.settings.table || next.cushionWidthCm !== s.settings.cushionWidthCm;
    s.settings = next;
    s.params = physicsFor(next);
    s.recommended = null;
    if (tableChanged) {
      s.table = t;
      s.practice = { table: t, balls: DRILLS[0]!.build(t), source: 'virtual', frozen: false };
      s.targetId = null;
      s.pocketId = null;
      s.frozen = null;
    }
  });
  configureVision();
  replan();
});
$<HTMLButtonElement>('#btn-settings').addEventListener('click', () => settingsDlg.showModal());
document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode as Mode)));
$<HTMLButtonElement>('#btn-practice-fallback').addEventListener('click', () => setMode('practice'));
$<HTMLButtonElement>('#btn-retry-camera').addEventListener('click', () => void enterCamera());

// ---------------------------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------------------------
const STATUS_TEXT = { searching: 'Looking for the table…', unstable: 'Table found — hold steady', locked: 'Table locked' } as const;

function render(s: AppState): void {
  document.body.dataset.mode = s.mode;
  document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === s.mode)));
  toolbar.update(s);
  const layout = currentLayout();
  const heat = s.heatmap && !s.heatmap.pending ? s.heatmap : null;
  if (s.mode === 'practice') {
    practiceView.draw({ table: s.table, balls: s.practice.balls, plan: s.plan, targetId: s.targetId, pocketId: s.pocketId, landing: s.landing, heatmap: heat });
  } else {
    const live = s.vision;
    const status = s.frozen ? 'Frozen layout' : live ? STATUS_TEXT[live.status] : 'Starting camera…';
    statusPill.textContent = `${status}${live && !s.frozen ? ` · ${live.balls.length} balls · ${Math.round(live.ms)} ms` : ''}`;
    statusPill.dataset.status = s.frozen ? 'frozen' : (live?.status ?? 'searching');
    camMsg.hidden = !s.cameraError;
    camMsg.querySelector('p')!.textContent = s.cameraError ?? '';
    overlay.draw(overlayData(), frameMapping());
    if (layout) miniView.draw({ table: s.table, balls: layout.balls, plan: s.plan, targetId: s.targetId, pocketId: s.pocketId, landing: s.landing, heatmap: heat });
    else miniView.draw({ table: s.table, balls: [], plan: null, targetId: null, pocketId: null, landing: null, heatmap: null, dimmed: true });
  }
  const hint =
    s.mode === 'camera' && (!s.vision || s.vision.status === 'searching')
      ? 'Point the camera at the table so the whole cloth is in view.'
      : s.interaction === 'calibrate'
        ? 'Tap the 4 corners where the cloth meets the rails.'
        : s.targetId
          ? s.plan
            ? ''
            : 'Waiting for the cue ball and target to be visible…'
          : 'Tap the ball you want to pocket, then a pocket (or let CueSight pick the best one).';
  const names = pocketNames();
  renderShotCard(card, s.plan, {
    targetLabel: s.targetId ? labelOf(s.targetId) : '',
    pocketName: s.plan ? names[s.plan.pocketId] : '',
    status: s.mode === 'camera' && s.vision ? STATUS_TEXT[s.vision.status] : null,
    recommendedPending: !!s.recommended?.pending,
    showDetails: s.settings.showDetails,
    hint,
  });
  renderSuggestions(sugEl, s, labelOf, (id) => names[id], (x: ShotSuggestion) => {
    store.update((st) => {
      st.targetId = x.targetId;
      st.pocketId = x.pocketId;
      st.suggestions = null;
      st.recommended = null;
      st.strokeMode = 'recommended';
    });
    replan();
  });
  const rec = s.recommended?.stroke ?? null;
  strokeControls.update(s.plan?.stroke ?? s.myStroke, s.strokeMode === 'mine', rec);
  toastEl.textContent = s.toast ?? '';
  toastEl.hidden = !s.toast;
}
store.subscribe(render);
window.addEventListener('resize', () => store.update(() => {}));

// Live redraw of the overlay while the camera runs (video moves even if state doesn't).
function overlayLoop(): void {
  if (S.mode === 'camera') overlay.draw(overlayData(), frameMapping());
  requestAnimationFrame(overlayLoop);
}
requestAnimationFrame(overlayLoop);

// Test/debug hook (no data leaves the page).
declare global {
  interface Window {
    __cuesight?: unknown;
  }
}
window.__cuesight = {
  state: S,
  practiceToScreen(p: Vec2) {
    const r = practiceView.canvas.getBoundingClientRect();
    const q = practiceView.toCanvas(p);
    return { x: r.left + q.x, y: r.top + q.y };
  },
  overlayToScreen(p: Vec2, z: 'ball' | 'cloth' = 'ball') {
    const cal = S.vision?.calibration;
    if (!cal) return null;
    const H = z === 'ball' ? cal.HR : cal.H0;
    const w = H[6]! * p.x + H[7]! * p.y + H[8]!;
    const f = { x: (H[0]! * p.x + H[1]! * p.y + H[2]!) / w, y: (H[3]! * p.x + H[4]! * p.y + H[5]!) / w };
    const r = overlay.canvas.getBoundingClientRect();
    const q = frameMapping().toScreen(f);
    return { x: r.left + q.x, y: r.top + q.y };
  },
};

// PWA: offline support in production builds only.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => void navigator.serviceWorker.register('./sw.js').catch(() => undefined));
}

setMode(initialMode);
