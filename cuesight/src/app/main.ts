/**
 * CueSight app wiring: modes (Live camera / Snap two-photo guide / Practice 3D table), interactions,
 * planning, workers and rendering.
 */
import './styles.css';
import { planShot, stunVert } from '../core/shot/planner';
import { powerToSpeed, speedReference } from '../core/shot/power';
import { POCKET_NAMES, clampToTable } from '../core/table';
import type { Ball, PocketId, ShotPlan, ShotRequest, ShotSuggestion, Stroke, StrokeRisk, TableLayout, Vec2 } from '../core/types';
import { dist } from '../core/vec';
import { PROTOCOL_VERSION, type PlannerPlanOptions, type VisionOut } from '../workers/protocol';
import { applyH, invert3 } from '../vision/homography';
import { FrameGrabber, createCameraSession, describeCameraError } from './camera';
import { DRILLS, cueBall, objectBall } from './drills';
import { Overlay, containMapping, type OverlayData } from './render/overlay';
import { rgbCss } from './render/palette';
import { TableView } from './render/table-view';
import { loadSettings, physicsFor, saveSettings, tableFor, type Settings } from './settings';
import { createAnnouncer } from './announce';
import { perspectivePocketNames, shooterPocketNames } from './pocket-names';
import { createStore, type AppState, type Mode } from './store';
import {
  applyCueOverride,
  bedPointFromProjection,
  calibrationFeedback,
  cameraHint,
  cameraMessageTitle,
  clearSelection,
  cornersPlausible,
  dropLiveSelection,
  explicitMode,
  framesMatch,
  liveGate,
  nextCornersOut,
  nextSinceLocked,
  pickNextAllowed,
  pillMeta,
  pillText,
  probeCamera,
  rememberInFrame,
  restoreFromFrame,
  startMode,
  tableSettingsChanged,
  trackSelection,
  unfreezeSelection,
  visionConfigChanged,
  visionFailureMessage,
  CALIBRATION_MESSAGES,
  REMAP_MESSAGES,
  REMAP_TTL,
  STATUS_TEXT,
  type FrameMemory,
} from './live-logic';
import { cardDetailsShown, cardPlanOf, createPlannerClient, fullPlanOptions, planRequestKey, recommendationOutcome, recommendedFromReply, watchWorker } from './planner-client';
import { createTable3D, type CameraPreset, type FrameInfo, type Pick3D, type Scene3DData, type Table3D } from './render3d';
import { landscapeFrame } from './render3d/camera';
import { createSnapController } from './snap/controller';
import { clothRgbOf } from './snap/photo';
import { initialSnap, snapReducer, type SnapEvent } from './snap/session';
import { registerServiceWorker } from './sw-update';
import { buildSettings, buildStrokeControls, buildToolbar, renderSuggestions } from './ui/controls';
import { hydrateIcons } from './ui/icons';
import { mountOnboarding } from './ui/onboarding';
import { createSheet } from './ui/sheet';
import { createBallTags } from './ui/ball-tags';
import { createShotLabel, planLabelContent, type LabelContent } from './ui/scene-labels';
import { recommendationContext, renderShotCard } from './ui/shot-card';
import { hideSplash } from './ui/splash';
import { buildViewControls } from './ui/view-controls';

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------
const settings = loadSettings();
const table = tableFor(settings);
const params = new URLSearchParams(location.search);
const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
// ?mode= wins; otherwise touch devices start in Live and desktops in Practice. A touch device without
// a camera (iOS Simulator) is told apart at start-up with enumerateDevices(), before any getUserMedia.
const modeOverride = explicitMode(params.get('mode'));
const initialMode: Mode = modeOverride ?? startMode(coarse, null);
const reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

const store = createStore({
  mode: initialMode,
  settings,
  table,
  params: physicsFor(settings),
  practice: { table, balls: DRILLS[0]!.build(table), source: 'virtual', frozen: false },
  vision: null,
  frozen: null,
  targetId: null,
  targetMem: null,
  cueMem: null,
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
  snap: initialSnap(),
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
const statusPill = $<HTMLElement>('#status-pill');
const statusText = $<HTMLElement>('#status');
const statusMeta = $<HTMLElement>('#status-meta');
const camMsg = $<HTMLElement>('#camera-msg');
const toastEl = $<HTMLElement>('#toast');
const settingsDlg = $<HTMLDialogElement>('#settings');
const practiceViewEl = $<HTMLElement>('.practice-view');
const viewControlsEl = $<HTMLElement>('#view-controls');
hydrateIcons();
const sheet = createSheet($<HTMLElement>('#panel'));
document.body.dataset.mode = initialMode;
// Power and strike pinned next to the cue ball on the 3D table (follows the camera every frame).
const shotLabel = createShotLabel($<HTMLElement>('#stage'));
// Ball numbers in the top view, where the balls are too small to read (Snap's "check the layout").
const ballTags = createBallTags($<HTMLElement>('#stage'));
let lastFrame: FrameInfo | null = null;
function labelShown(s: AppState): boolean {
  return !!view3d && tableStageOn(s) && !!s.plan && sheet.state() !== 'expanded' && document.body.classList.contains('has-3d') && !document.querySelector('#snap[data-inspect="true"]');
}
/** What the in-scene label says (refreshed on every render; the label itself follows every 3D frame). */
let labelContent: LabelContent | null = null;
function labelContentOf(s: AppState, names: Record<PocketId, string>): LabelContent | null {
  return planLabelContent(s.plan, names, { pending: s.strokeMode === 'recommended' && !!s.recommended?.pending, snooker: s.table.id === 'snooker12' });
}
function updateLabel(): void {
  shotLabel.update(lastFrame, labelContent, labelShown(S));
  const balls = editableBalls(S);
  ballTags.update(lastFrame, balls ?? [], !!view3d && !!balls && tableStageOn(S) && sheet.state() !== 'expanded' && document.body.classList.contains('has-3d') && !document.querySelector('#snap[data-inspect="true"]'), S.table.id === 'snooker12');
}
// Polite announcements: the plan the player will play (after the recommendation lands, debounced),
// and each warning once when it first appears (announce.ts).
const liveEl = document.createElement('div');
liveEl.className = 'sr-only';
liveEl.setAttribute('aria-live', 'polite');
liveEl.id = 'plan-live';
document.body.appendChild(liveEl);
const announcer = createAnnouncer(liveEl);

// ---------------------------------------------------------------------------------------------
// 3D table (feature 002 US1): the stage of Practice and of Snap's layout step. The 2D TableView is
// the automatic fallback without WebGL2, or with ?renderer=2d (FR-110).
// ---------------------------------------------------------------------------------------------
const canvas3d = $<HTMLCanvasElement>('#table3d');
const force2d = params.get('renderer') === '2d';
let cameraPreset: CameraPreset | 'custom' = 'overview';
let view3d: Table3D | null = null;
/** The GPU context was lost for good (or could not be rebuilt): 2D for the rest of the session (FR-110). */
let failed3d = false;
/** Creates or drops the 3D table to match the URL flag and the "3D table" setting. */
function sync3D(): void {
  const want = !force2d && !failed3d && S.settings.table3d;
  if (want && !view3d) {
    view3d = createTable3D(
      canvas3d,
      {
        onTap: (p, ev) => on3DTap(p, ev),
        onBallDrag: (id, pos, phase) => moveBall(id, pos, phase),
        onCameraChange: (p) => {
          cameraPreset = p;
          store.update(() => {});
        },
        onFrame: (info) => {
          lastFrame = info;
          updateLabel();
        },
      },
      { reducedMotion },
    );
    cameraPreset = 'overview';
    last3D = [];
    lastInsets = '';
  } else if (!want && view3d) {
    view3d.destroy();
    view3d = null;
    lastFrame = null;
    shotLabel.hide();
    ballTags.hide();
  }
  document.body.classList.toggle('has-3d', !!view3d);
  view3d?.resize();
}
// FR-110 / contracts/render3d-api.md § Context loss: a GPU context that is lost for good (no
// `webglcontextrestored` within 3 s), or that the renderer could not rebuild, falls back to the 2D table.
// The layout, selection and plan live in the app state, so nothing is lost.
let lostTimer = 0;
function fail3D(): void {
  window.clearTimeout(lostTimer);
  if (failed3d || !view3d) return;
  failed3d = true;
  sync3D();
  queueInsets();
  store.update(() => {});
  toast('The 3D table stopped working on this device — showing the 2D table.', 4000);
}
canvas3d.addEventListener('webglcontextlost', () => {
  window.clearTimeout(lostTimer);
  if (view3d) lostTimer = window.setTimeout(fail3D, 3000);
});
canvas3d.addEventListener('webglcontextrestored', () => {
  window.clearTimeout(lostTimer);
  // The renderer rebuilds its GPU resources in its own listener; check the outcome after it ran.
  window.setTimeout(() => {
    if (view3d?.isFailed?.()) fail3D();
  }, 0);
});
let told2d = false;
let last3D: unknown[] = [];

/** The table stage (3D canvas or 2D fallback) is showing. */
function tableStageOn(s: AppState): boolean {
  return s.mode === 'practice' || (s.mode === 'snap' && s.snap.step === 'review');
}

// Frame the table inside the area the floating chrome leaves free.
let lastInsets = '';
let insetsQueued = false;
/** Orientation of the Overview preset (long rail across the screen when the free area is wide). */
let freeWide = innerWidth >= innerHeight;
function update3DInsets(): void {
  if (!view3d || !tableStageOn(S)) return;
  const c = canvas3d.getBoundingClientRect();
  if (c.width < 2 || c.height < 2) return;
  const pv = practiceViewEl.getBoundingClientRect();
  let top = pv.top - c.top;
  let bottom = c.bottom - pv.bottom;
  const left = Math.max(0, pv.left - c.left);
  let right = Math.max(0, c.right - pv.right);
  if (S.mode === 'snap') {
    const b = snapCtl.stageBounds();
    if (b) {
      top = b.top - c.top + 6;
      bottom = c.bottom - b.bottom + 6;
    }
  }
  // Keep the table clear of the camera pill centred at the top of the stage (Play sits at the dock's
  // level, below the free area), so the table is framed centred with even gutters.
  const vc = viewControlsEl.querySelector<HTMLElement>('.vc-presets')?.getBoundingClientRect();
  if (vc && vc.width > 0 && vc.height > 0) top = Math.max(top, vc.bottom - c.top + 6);
  const ins = { top: Math.max(0, top), right, bottom: Math.max(0, bottom), left };
  freeWide = landscapeFrame(c.width / c.height, { top: ins.top / c.height, right: ins.right / c.width, bottom: ins.bottom / c.height, left: ins.left / c.width });
  const key = [ins.top, ins.right, ins.bottom, ins.left].map((v) => Math.round(v)).join(',');
  if (key === lastInsets) return;
  lastInsets = key;
  view3d.setInsets?.(ins);
}
function queueInsets(): void {
  if (insetsQueued) return;
  insetsQueued = true;
  requestAnimationFrame(() => {
    insetsQueued = false;
    update3DInsets();
  });
}
if (typeof ResizeObserver === 'function') new ResizeObserver(queueInsets).observe(practiceViewEl);

// ---------------------------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------------------------
/** The live table may be planned on and drawn (locked, with a short grace after a lock; Constitution II). */
function liveOpen(): boolean {
  return !!S.vision && liveGate(S.vision.status, S.vision.sinceLocked, !!S.vision.calibration);
}

function cameraLayout(): TableLayout | null {
  if (S.frozen) return S.frozen.layout;
  if (!S.vision || !liveOpen()) return null;
  const live: TableLayout = { table: S.table, balls: S.vision.balls, source: 'camera', frozen: false };
  return S.cueOverrideId ? applyCueOverride(live, S.cueOverrideId) : { ...live, balls: live.balls.map((b) => ({ ...b })) };
}

/** Snap's confirmed (editable) layout from the table photo. */
let snapLayoutCache: { balls: Ball[]; table: AppState['table']; layout: TableLayout } | null = null;
function snapLayout(): TableLayout | null {
  const balls = S.snap.layout;
  if (!balls) return null;
  if (!snapLayoutCache || snapLayoutCache.balls !== balls || snapLayoutCache.table !== S.table) {
    snapLayoutCache = { balls, table: S.table, layout: { table: S.table, balls, source: 'camera', frozen: true } };
  }
  return snapLayoutCache.layout;
}

function currentLayout(): TableLayout | null {
  return S.mode === 'practice' ? S.practice : S.mode === 'snap' ? snapLayout() : cameraLayout();
}

/** The balls the player can edit by hand (practice table, Snap layout), or null in Live mode. */
function editableBalls(s: AppState): Ball[] | null {
  return s.mode === 'practice' ? s.practice.balls : s.mode === 'snap' ? s.snap.layout : null;
}
function setEditableBalls(s: AppState, balls: Ball[]): void {
  if (s.mode === 'practice') s.practice = { ...s.practice, balls };
  else if (s.mode === 'snap') s.snap = snapReducer(s.snap, { type: 'layout', balls });
}

function labelOf(id: string): string {
  const b = currentLayout()?.balls.find((x) => x.id === id);
  return b?.label ?? id;
}

/** Pocket names as the player sees them: screen-relative on the practice table, near/far in camera and Snap (unique, see pocket-names.ts). */
function pocketNames(targetId: string | null = S.targetId): Record<PocketId, string> {
  const out = { ...POCKET_NAMES };
  const name = (pk: (typeof S.table.pockets)[number], q: Vec2, c: Vec2) => {
    const dx = q.x - c.x;
    const dy = q.y - c.y;
    const v = dy < 0 ? 'top' : 'bottom';
    const h = dx < 0 ? 'left' : 'right';
    if (pk.kind === 'corner') return `${v}-${h} corner`;
    return Math.abs(dx) > Math.abs(dy) ? `${h} side` : `${v} side`;
  };
  // Named from the shooter's side: standing behind the cue ball, facing the target (or the middle
  // of the table), by bearing (pocket-names.ts). They stay the same whatever the 3D camera does. In
  // Snap, once the player's photo is lined up, from where that photo was taken and the way it faces.
  const balls = S.mode === 'practice' ? S.practice.balls : S.mode === 'snap' ? S.snap.layout : null;
  const cue = balls?.find((b) => b.kind === 'cue');
  const tgt = targetId ? balls?.find((b) => b.id === targetId) : undefined;
  const pose = S.mode === 'snap' ? S.snap.player?.result?.pose : undefined;
  if (pose) {
    const R = pose.R;
    const t = pose.t;
    // Camera centre C = −Rᵀt; its view direction is the third row of R, on the table plane.
    const C = { x: -(R[0]! * t.x + R[3]! * t.y + R[6]! * t.z), y: -(R[1]! * t.x + R[4]! * t.y + R[7]! * t.z) };
    const fwd = { x: R[6]!, y: R[7]! };
    if (Math.hypot(fwd.x, fwd.y) > 0.2) return { ...out, ...shooterPocketNames(S.table.pockets, C, fwd) };
  }
  if (cue && (S.mode === 'practice' || tgt)) {
    let f = tgt ? { x: tgt.pos.x - cue.pos.x, y: tgt.pos.y - cue.pos.y } : { x: -cue.pos.x, y: -cue.pos.y };
    if (Math.hypot(f.x, f.y) < 0.05) f = { x: 1, y: 0 };
    return { ...out, ...shooterPocketNames(S.table.pockets, cue.pos, f) };
  }
  if (S.mode === 'practice') {
    if (view3d) {
      const up = freeWide ? { x: 0, y: 1 } : { x: 1, y: 0 };
      const right = { x: up.y, y: -up.x };
      for (const pk of S.table.pockets) {
        const m = pk.mouthCenter;
        out[pk.id] = name(pk, { x: m.x * right.x + m.y * right.y, y: -(m.x * up.x + m.y * up.y) }, { x: 0, y: 0 });
      }
    } else {
      const c = practiceView.toCanvas({ x: 0, y: 0 });
      for (const pk of S.table.pockets) out[pk.id] = name(pk, practiceView.toCanvas(pk.mouthCenter), c);
    }
  } else {
    const cal = S.mode === 'snap' ? S.snap.overview?.vision?.calibration : (S.frozen?.calibration ?? S.vision?.calibration);
    if (cal) {
      const pr = (p: Vec2) => {
        const H = cal.H0;
        const w = H[6]! * p.x + H[7]! * p.y + H[8]!;
        return { x: (H[0]! * p.x + H[1]! * p.y + H[2]!) / w, y: (H[3]! * p.x + H[4]! * p.y + H[5]!) / w };
      };
      const pockets = S.table.pockets;
      Object.assign(out, perspectivePocketNames(pockets, (id) => pr(pockets.find((pk) => pk.id === id)!.mouthCenter)));
    }
  }
  return out;
}

/** Inside the iOS app (Capacitor's native shell) rather than a browser. */
function isNativeShell(): boolean {
  return !!(window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.();
}

function toast(msg: string, ms = 2600): void {
  store.update((s) => (s.toast = msg));
  window.setTimeout(() => store.update((s) => (s.toast === msg ? (s.toast = null) : null)), ms);
}

// ---------------------------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------------------------
// Requests, staleness and failures live in planner-client.ts; the app only applies accepted replies,
// and only to the request still open in the state (the key / pending flag it was made for).
const planner = createPlannerClient({
  createWorker: () => new Worker(new URL('../workers/planner.worker.ts', import.meta.url), { type: 'module' }),
  onRecommendation(key, m) {
    let msg: string | null = null;
    store.update((s) => {
      if (!s.recommended || s.recommended.key !== key || !s.recommended.pending) return;
      const out = recommendationOutcome(m, !!s.landing);
      // fragile / timedOut / nextQuality / risks as the reply has them: risks absent = not known (never []).
      const { key: k } = s.recommended;
      s.recommended = { key: k, ...recommendedFromReply(m, out) };
      // The toast is about the stroke shown: not when the player has set their own meanwhile.
      if (s.strokeMode === 'recommended') msg = out.toast;
    });
    if (msg) toast(msg, 3600);
    replan();
  },
  onPlan(key, m) {
    // The full plan (frozen power advice included) for the plan still on show: it replaces it as is.
    if (key !== fullPlanKey) return;
    fullPlanKey = '';
    lastFullPlan = { key, plan: m.plan };
    store.update((s) => {
      s.plan = m.plan;
      if (s.strokeMode === 'recommended') s.myStroke = { ...m.plan.stroke };
    });
  },
  onSuggestions(m) {
    store.update((s) => s.suggestions?.pending && (s.suggestions = { items: m.items, pending: false }));
  },
  onHeatmap(m) {
    store.update((s) => s.heatmap?.pending && (s.heatmap = { ...s.heatmap, cols: m.cols, rows: m.rows, values: m.values, pending: false }));
  },
  onFailure(kind, key, message) {
    console.warn('planner failed', kind, message);
    if (kind === 'plan') {
      // The plan on show stays, without the power figure (its too-soft warning still says it is too soft).
      if (key === fullPlanKey) {
        fullPlanKey = '';
        store.update(() => {});
      }
      return;
    }
    if (kind === 'recommend') {
      // Keep the key: the same inputs are not retried in a loop; any change asks again.
      store.update((s) => {
        if (s.recommended && s.recommended.key === key && s.recommended.pending) s.recommended = { ...s.recommended, stroke: null, pending: false };
      });
      replan();
    } else if (kind === 'suggest') {
      if (!S.suggestions?.pending) return;
      store.update((s) => (s.suggestions = null));
      toast('Couldn’t work out the best shots — try again.');
    } else {
      if (!S.heatmap?.pending) return;
      store.update((s) => (s.heatmap = null));
      toast('Couldn’t work out the zones — try again.');
    }
  },
});

function layoutKey(l: TableLayout): string {
  return l.balls.map((b) => `${b.id}:${Math.round(b.pos.x * 200)},${Math.round(b.pos.y * 200)}:${b.kind}`).join('|');
}

function requestRecommendation(layout: TableLayout): void {
  if (!S.targetId) return;
  const key = `${layoutKey(layout)}#${S.targetId}#${S.pocketId}#${S.landing ? `${S.landing.x.toFixed(2)},${S.landing.y.toFixed(2)}` : ''}#${JSON.stringify(S.params)}`;
  if (S.recommended?.key === key) return;
  store.update((s) => (s.recommended = { key, stroke: null, pending: true, reachable: true, evaluated: 0 }));
  // The request is fixed now (debounced in the client): a later tap supersedes it, never rewrites it.
  planner.recommend(key, {
    type: 'recommend',
    layout,
    request: { targetId: S.targetId, ...(S.pocketId ? { pocketId: S.pocketId } : {}), ...(S.landing ? { landing: S.landing } : {}) },
    params: S.params,
  });
}

/**
 * The plan on show was made without the frozen power advice (ShotPlan.adviceSkipped): its full
 * version is asked of the planner worker under this key, and replaces it when it comes ('' = none).
 */
let fullPlanKey = '';
/** The last full plan the worker sent, by key: the same inputs planned again reuse it (no flicker, no new request). */
let lastFullPlan: { key: string; plan: ShotPlan } | null = null;

function replan(): void {
  const layout = currentLayout();
  let plan: ShotPlan | null = null;
  let full: { key: string; request: ShotRequest; opts: PlannerPlanOptions } | null = null;
  if (layout && S.targetId) {
    const target = layout.balls.find((b) => b.id === S.targetId);
    const hasCue = layout.balls.some((b) => b.kind === 'cue');
    if (target && target.kind !== 'cue' && hasCue) {
      const rec = S.recommended && !S.recommended.pending && S.recommended.stroke ? S.recommended.stroke : undefined;
      const request: ShotRequest = { targetId: S.targetId, ...(S.pocketId ? { pocketId: S.pocketId } : {}), ...(S.strokeMode === 'mine' ? { stroke: S.myStroke } : {}) };
      const opts: PlannerPlanOptions = { names: pocketNames(), ...(rec ? { recommended: rec } : {}) };
      try {
        // Without the frozen power advice: for a too-soft frozen cue ball it re-plans the stroke at
        // every half step (8–70 ms on a desktop, more on a phone, at every slider step), so it runs
        // in the planner worker and its plan replaces this one (Constitution IV: < 10 ms here).
        plan = planShot(layout, request, S.params, { ...opts, advice: false });
        if (plan.adviceSkipped) {
          // Only what planShot reads: with the player's own stroke the recommended one is ignored, so a
          // recommendation landing later neither re-keys this plan nor throws its full plan away.
          const fullOpts = fullPlanOptions(request, opts);
          const key = planRequestKey(layout, request, S.params, fullOpts);
          if (lastFullPlan?.key === key) plan = lastFullPlan.plan;
          else full = { key, request, opts: fullOpts };
        }
      } catch (e) {
        console.warn(e);
      }
      if (S.strokeMode === 'recommended') requestRecommendation(layout);
    }
  }
  if (full && layout) {
    fullPlanKey = full.key;
    planner.plan(full.key, { type: 'plan', layout, request: full.request, params: S.params, opts: full.opts });
  } else if (fullPlanKey) {
    fullPlanKey = '';
    planner.cancel('plan');
  }
  store.update((s) => {
    s.plan = plan;
    if (plan && s.strokeMode === 'recommended') s.myStroke = { ...plan.stroke };
  });
}

// ---------------------------------------------------------------------------------------------
// Selection & interactions (shared by the 3D/2D table, the mini-map, the AR overlay and Snap)
// ---------------------------------------------------------------------------------------------
function selectBall(b: Ball): void {
  if (S.interaction !== 'position') dropRemap(); // a new choice: the one waiting for the new frame is not restored
  if (S.interaction === 'position') {
    // Position mode places the landing spot: a tap near a ball never changes the target.
    toast('Tap the cloth where the cue ball should stop (tap Position again to cancel).');
    return;
  }
  if (S.interaction === 'mark-cue') {
    if (S.mode === 'camera') {
      store.update((s) => {
        s.cueOverrideId = b.id;
        s.cueMem = { id: b.id, pos: b.pos, ...(b.label ? { label: b.label } : {}) };
        // A frozen layout is what is planned on: the marked cue ball must change it too.
        if (s.frozen) s.frozen = { ...s.frozen, layout: applyCueOverride(s.frozen.layout, b.id) };
        s.interaction = 'select';
        if (s.targetId === b.id) {
          s.targetId = null;
          s.targetMem = null;
        }
        s.recommended = null;
      });
    } else {
      store.update((s) => {
        const balls = editableBalls(s);
        if (balls)
          setEditableBalls(
            s,
            balls.map((x) => (x.id === b.id ? { ...x, kind: 'cue', label: 'cue' } : x.kind === 'cue' ? { ...x, kind: 'object', label: x.label === 'cue' ? 'white?' : x.label } : x)),
          );
        s.interaction = 'select';
        if (s.targetId === b.id) s.targetId = null;
        s.recommended = null;
      });
    }
    toast('Cue ball set.');
    replan();
    return;
  }
  if (S.interaction === 'pick-next') {
    // The next ball: neither the cue ball nor the one being potted (they have no "next shot" map).
    if (!pickNextAllowed(b, S.targetId)) return toast('Pick a different object ball to play next.');
    requestHeatmap(b.id);
    return;
  }
  if (b.kind === 'cue') {
    toast('That’s the cue ball — tap the ball you want to pocket.');
    return;
  }
  // Live, no cue ball found (spec 001 edge case): ask for it first, keeping the ball tapped as the target.
  // Two whites too close to call (wave-1 ball-detect: neither is the cue): ask which one.
  const shown = S.mode === 'camera' ? currentLayout() : null;
  const noCue = !!shown && !shown.balls.some((x) => x.kind === 'cue');
  const twoWhites = !!shown && shown.balls.filter((x) => x.label === 'white?').length >= 2;
  store.update((s) => {
    if (s.targetId !== b.id) {
      s.targetId = b.id;
      s.targetMem = s.mode === 'camera' ? { id: b.id, pos: b.pos, ...(b.label ? { label: b.label } : {}) } : null;
      s.pocketId = null;
      s.landing = null;
      s.recommended = null;
      s.strokeMode = 'recommended';
    }
    if (noCue) s.interaction = 'mark-cue';
  });
  if (noCue) toast(twoWhites ? 'Two white balls — tap the one you play with first.' : 'I can’t find the cue ball — tap it first.', 3600);
  replan();
}

function selectPocket(p: PocketId): void {
  dropRemap();
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
  planner.send('heatmap', { type: 'heatmap', layout, nextBallId, excludeIds: S.targetId ? [S.targetId] : [], params: S.params, cols: 48, rows: 24 });
  toast(`Bright zones = easy shot on ${labelOf(nextBallId)} next.`);
}

/** Moves a ball of the editable layout (practice table / Snap), clamped to the bed and pushed clear of the others. */
function moveBall(id: string, to: Vec2, phase: 'start' | 'move' | 'end' = 'move'): void {
  if (phase === 'start') return;
  store.update((s) => {
    const balls = editableBalls(s);
    if (!balls) return;
    const R = s.table.ballRadius;
    let p = clampToTable(s.table, to);
    for (const o of balls)
      if (o.id !== id && dist(o.pos, p) < 2 * R) {
        const d = dist(o.pos, p) || 1e-6;
        p = clampToTable(s.table, { x: o.pos.x + ((p.x - o.pos.x) / d) * 2 * R, y: o.pos.y + ((p.y - o.pos.y) / d) * 2 * R });
      }
    setEditableBalls(
      s,
      balls.map((b) => (b.id === id ? { ...b, pos: p } : b)),
    );
    s.recommended = null;
    s.suggestions = null;
    s.heatmap = null;
  });
  replan();
}

// 3D table taps: the same selection flow as the 2D table (FR-105).
function on3DTap(p: Pick3D, ev?: PointerEvent): void {
  if (!p) return;
  const layout = currentLayout();
  if (!layout) return;
  if (S.interaction === 'position') {
    // Every tap on the bed is a landing spot, even next to (or over) a ball.
    const v = view3d;
    const bed = v && ev ? bedPointFromProjection((q) => v.toScreen(q), { x: S.table.length / 2, y: S.table.width / 2 }, { x: ev.clientX, y: ev.clientY }) : null;
    const spot = bed ?? (p.kind === 'cloth' ? p.pos : p.kind === 'pocket' ? S.table.pockets.find((q) => q.id === p.id)!.mouthCenter : null);
    if (spot) tableTap(spot);
    return;
  }
  if (p.kind === 'ball') {
    const b = layout.balls.find((x) => x.id === p.id);
    if (b) selectBall(b);
  } else if (p.kind === 'pocket') selectPocket(p.id);
}

// 2D table (fallback): tap to select, drag to move balls.
{
  const canvas = practiceView.canvas;
  let drag: { id: string; startX: number; startY: number; moved: boolean } | null = null;
  const local = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  canvas.addEventListener('pointerdown', (e) => {
    const q = local(e);
    const b = practiceView.ballAt(q, currentLayout()?.balls ?? []);
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
    moveBall(drag.id, practiceView.toTable(q));
  });
  canvas.addEventListener('pointerup', (e) => {
    const q = local(e);
    if (drag && !drag.moved && S.interaction === 'position') tableTap(practiceView.toTable(q));
    else if (drag && !drag.moved) {
      const b = currentLayout()?.balls.find((x) => x.id === drag!.id);
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
  if (S.interaction === 'position') return tableTap(miniView.toTable(q));
  const b = miniView.ballAt(q, layout.balls);
  if (b) return selectBall(b);
  const pk = miniView.pocketAt(q);
  if (pk) selectPocket(pk);
});

// AR overlay taps.
function overlayData(): OverlayData {
  const layout = currentLayout();
  // Live: only a locked table is drawn (and hit-tested), so no stale pocket targets from old corners.
  const cal = S.frozen ? (S.frozen.calibration && liveMatchesFrozen() ? S.vision!.calibration : null) : liveOpen() ? S.vision!.calibration : null;
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
      if (!cornersPlausible(S.calibTaps, frameSize.w, frameSize.h)) {
        store.update((s) => (s.calibTaps = []));
        toast(CALIBRATION_MESSAGES.badQuad, 4000);
        return;
      }
      store.update((s) => {
        s.manualCorners = s.calibTaps.slice();
        s.calibTaps = [];
        s.interaction = 'select';
      });
      // Confirmed (or refused) by the first vision result computed with these corners (onVision). The
      // camera has not moved: the selection waits for the new frame and is found again (keepThroughFrame).
      const kept = keepThroughFrame();
      manualCheckFrom = frameId + 1;
      toast(kept === 'cleared' ? 'Corners set — checking… The selection was cleared: the table frame changed.' : 'Corners set — checking…', 4000);
    } else toast(`Corner ${S.calibTaps.length}/4 — tap the next corner of the cloth.`);
    return;
  }
  const d = overlayData();
  if (S.interaction === 'position') {
    // Every tap is a landing spot (the cloth point under it), even next to a ball.
    if (d.calibration) {
      const f = map.toFrame(tap);
      tableTap(applyH(invert3(d.calibration.HR), f.x, f.y));
    }
    return;
  }
  const hit = Overlay.hitTest(tap, d, map);
  if (hit.ball) selectBall(hit.ball);
  else if (hit.pocket) selectPocket(hit.pocket);
});

// ---------------------------------------------------------------------------------------------
// Camera + vision worker (Live frames, and Snap's still / player-view requests)
// ---------------------------------------------------------------------------------------------
let vision: Worker | null = null;
let inFlight = false;
let frameId = 0;
let cameraOn = false;
const grabber = new FrameGrabber(640);
let frameSize = { w: 640, h: 480 };
/** Consecutive live-frame `error` replies (3 in a row: detection is not working). */
let visionErrors = 0;
/** Table-frame generation: bumped whenever the live ball ids change meaning (new frame, new tracker). */
let frameGen = 0;
/** Manual corners were just sent: the first result for a frame id ≥ this confirms or refuses them. */
let manualCheckFrom: number | null = null;
let lastReason = '';
/** The current vision worker has replied at least once (it loaded): a later failure is not a load failure. */
let visionAnswered = false;
/** Corner pockets of the live table outside the frame (live-logic nextCornersOut), for the status pill. */
let cornersOut = 0;
/**
 * First frame id of the current table frame (tableFrameChanged), and the last such id a result has
 * started: the new frame's first result counts its lock afresh (live-logic nextSinceLocked).
 */
let tableFrameFrom = 0;
let tableFrameSeen = 0;

function visionWorker(): Worker {
  if (!vision) {
    const w = new Worker(new URL('../workers/vision.worker.ts', import.meta.url), { type: 'module' });
    vision = w;
    visionAnswered = false;
    w.onmessage = (ev: MessageEvent<VisionOut>) => {
      if (vision !== w) return; // a replaced worker's tracker ids mean nothing any more
      visionAnswered = true;
      onVision(ev.data);
    };
    watchWorker(w, (msg) => {
      if (vision === w) visionFailed(msg);
    });
    configureVision();
    // A new worker is a new tracker: its ids start again at b1, so ids held from an older one name other balls.
    if (liveIdsChanged()) toast('Table detection restarted. The selection was cleared.');
  }
  return vision;
}

/** The vision worker cannot run (script not available offline, crashed): say so instead of waiting forever. */
function visionFailed(message: string): void {
  console.warn('vision worker failed', message);
  try {
    vision?.terminate();
  } catch {
    /* already gone */
  }
  vision = null; // recreated by "Try again" or by entering Live again
  visionErrors = 0;
  dropRemap();
  // The tracker that issued the selected ids is gone: "Try again" starts a new one (ids from b1).
  liveIdsChanged();
  // A Snap photo waiting on this worker will never be answered: Snap says so instead of spinning.
  snapCtl.visionFailed(visionAnswered);
  if (S.mode !== 'camera') return;
  leaveCamera(); // without detection the camera has nothing to do
  store.update((s) => {
    s.cameraError = visionFailureMessage(visionAnswered);
    s.vision = null;
  });
}

function configureVision(): void {
  vision?.postMessage({ v: PROTOCOL_VERSION, type: 'config', table: S.table, fovDeg: S.settings.fovDeg, manualCorners: S.manualCorners, swapAxes: S.swapAxes });
}

/**
 * Sends the vision config after a change of the table frame (Rotate, corners set or cleared, another
 * table or field of view). The tracker restarts its ball ids, so a live selection no longer means the
 * same balls (see liveIdsChanged). Returns whether something the player had selected was cleared.
 * A selection waiting to be found again (keepThroughFrame) waits for this newest frame instead.
 */
function tableFrameChanged(): boolean {
  configureVision();
  tableFrameFrom = frameId + 1;
  const cleared = liveIdsChanged();
  if (remap) {
    remap.fromFrame = frameId + 1;
    remap.ttl = REMAP_TTL;
  }
  return cleared;
}

/**
 * Rotate / Calibrate (wave-2a item 17): the camera has not moved, so the selection (target, marked
 * cue ball, pocket, landing) is remembered where the camera sees it and found again on the first
 * results of the new table frame (live-logic restoreFromFrame; onVision → applyRemap), with "Kept
 * your selection", or the cleared message after REMAP_TTL results without it.
 */
let remap: { mem: FrameMemory; fromFrame: number; ttl: number } | null = null;
function dropRemap(): void {
  remap = null;
}
/** tableFrameChanged for Rotate / Calibrate: 'waiting' (a selection waits for the new frame), 'cleared' or 'none'. */
function keepThroughFrame(): 'waiting' | 'cleared' | 'none' {
  const cal = S.vision?.calibration;
  const mem = S.mode === 'camera' && !S.frozen && cal && liveOpen() ? rememberInFrame(S, S.vision!.balls, S.table, cal) : null;
  const cleared = tableFrameChanged();
  if (remap) return 'waiting'; // already waiting (a second Rotate): re-armed for this frame
  if (mem && cleared) {
    remap = { mem, fromFrame: frameId + 1, ttl: REMAP_TTL };
    return 'waiting';
  }
  return cleared ? 'cleared' : 'none';
}
/**
 * Toasts `msg` after the toast still showing ("Swapped long and short rails.", "Calibrated from your
 * four corners.") rather than over it, so both are read.
 */
function noteAfter(msg: string): void {
  const now = S.toast;
  toast(now && !now.includes(msg) ? `${now} ${msg}` : msg, 4000);
}
/** One result of the new frame: restore the waiting selection when every remembered ball is in view. */
function applyRemap(): void {
  const rm = remap;
  if (!rm) return;
  rm.ttl--;
  const cal = S.vision?.calibration;
  if (cal && liveOpen()) {
    const back = restoreFromFrame(rm.mem, S.vision!.balls, S.table, cal);
    if (back.found) {
      remap = null;
      const balls = S.vision!.balls;
      const memOf = (id: string | null) => {
        const b = id ? balls.find((x) => x.id === id) : undefined;
        return b ? { id: b.id, pos: b.pos, ...(b.label ? { label: b.label } : {}) } : null;
      };
      store.update((s) => {
        s.cueOverrideId = back.cueOverrideId;
        s.cueMem = memOf(back.cueOverrideId);
        s.targetId = back.targetId;
        s.targetMem = memOf(back.targetId);
        s.pocketId = back.targetId ? back.pocketId : null;
        s.landing = back.targetId && back.landing ? clampToTable(s.table, back.landing) : null;
        s.recommended = null;
      });
      noteAfter(REMAP_MESSAGES.kept);
      replan();
      return;
    }
  }
  if (rm.ttl <= 0) {
    remap = null;
    noteAfter(REMAP_MESSAGES.cleared);
  }
}

/**
 * The live ball ids changed meaning (a new table frame or a new tracker): bumps `frameGen`, so a
 * frozen snapshot taken before is unfrozen without its selection, and clears the live selection
 * together with the planner requests made for it. Returns whether anything selected was cleared.
 */
function liveIdsChanged(): boolean {
  frameGen++;
  let cleared = false;
  store.update((s) => (cleared = dropLiveSelection(s)));
  if (cleared) for (const k of ['recommend', 'suggest', 'heatmap'] as const) planner.cancel(k);
  return cleared;
}

function liveMatchesFrozen(): boolean {
  if (S.vision?.status !== 'locked') return false;
  return framesMatch(S.frozen?.calibration?.corners, S.vision.calibration?.corners, Math.hypot(S.vision.frameW, S.vision.frameH));
}

const camSession = createCameraSession(video);
async function enterCamera(): Promise<void> {
  if (cameraOn) return;
  const r = await camSession.start();
  if (r.kind === 'stale') return; // Live was left (or restarted) while the camera was starting
  if (r.kind === 'error') {
    if (S.mode === 'camera') store.update((s) => (s.cameraError = describeCameraError(r.error, isNativeShell())));
    return;
  }
  if (S.mode !== 'camera') {
    camSession.stop();
    return;
  }
  if (cameraOn) return; // the second caller of the same start
  cameraOn = true;
  store.update((s) => (s.cameraError = null));
  // The camera can stop under us (another app took it, permission revoked): say so.
  r.stream.getVideoTracks()[0]?.addEventListener('ended', () => {
    if (!cameraOn || camSession.stream() !== r.stream) return;
    leaveCamera();
    store.update((s) => (s.cameraError = 'The camera stopped. Tap “Try again”, or use the practice table.'));
  });
  visionWorker();
  if (!pumpRaf) pump();
}

function leaveCamera(): void {
  cameraOn = false;
  inFlight = false;
  camSession.stop();
}

/** One frame-grab loop at a time (a second start must not add a second rAF chain). */
let pumpRaf = 0;
function pump(): void {
  pumpRaf = 0;
  if (!cameraOn) return;
  if (!inFlight && vision && video.readyState >= 2) {
    const f = grabber.grab(video);
    if (f) {
      inFlight = true;
      frameSize = { w: f.width, h: f.height };
      vision.postMessage({ v: PROTOCOL_VERSION, type: 'frame', id: ++frameId, width: f.width, height: f.height, buffer: f.buffer }, [f.buffer]);
    }
  }
  pumpRaf = requestAnimationFrame(pump);
}

let lastVisionKey = '';
function onVision(m: VisionOut): void {
  // Snap's one-shot requests never touch the live-frame backpressure.
  if (snapCtl.onVision(m)) return;
  inFlight = false;
  if (m.type === 'error') {
    console.warn('vision error', m.message);
    if (++visionErrors >= 3) visionFailed(m.message);
    return;
  }
  if (m.type !== 'result' || S.mode !== 'camera') return;
  visionErrors = 0;
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
  const prev = S.vision?.balls;
  // The new table frame's first result gets no grace from the old frame's lock: nothing is restored,
  // planned or drawn on it before it locks itself (results still in flight from the old frame count on).
  const newFrame = m.id >= tableFrameFrom && tableFrameSeen !== tableFrameFrom;
  if (newFrame) tableFrameSeen = tableFrameFrom;
  const sinceLocked = nextSinceLocked(S.vision?.sinceLocked ?? Infinity, r.status, newFrame);
  cornersOut = nextCornersOut(cornersOut, r.calibration?.corners, r.calibration?.width ?? frameSize.w, r.calibration?.height ?? frameSize.h);
  store.update((s) => {
    s.vision = { status: r.status, calibration: r.calibration, balls, quality: r.quality, ms: r.ms, frameW: frameSize.w, frameH: frameSize.h, sinceLocked };
    if (s.frozen) return;
    // Tracker ids are volatile (an occlusion re-issues one): keep the marked cue ball and the target
    // on the same physical balls, re-binding a lost id to a new track at the same spot.
    const R = s.table.ballRadius;
    const c = trackSelection(s.cueOverrideId, s.cueMem, prev, balls, R, { allowCue: true, exclude: [s.targetId] });
    s.cueOverrideId = c.id;
    s.cueMem = c.mem;
    const seen = c.id ? applyCueOverride({ table: s.table, balls, source: 'camera', frozen: false }, c.id).balls : balls;
    const t = trackSelection(s.targetId, s.targetMem, prev, seen, R, { exclude: [c.id] });
    s.targetId = t.id;
    s.targetMem = t.mem;
  });
  checkManualCorners(m.id, r);
  if (remap && m.id >= remap.fromFrame && !S.frozen) applyRemap();
  if (!S.frozen) {
    // Replan when the balls move or the lock gate opens/closes (no plan on an unlocked table).
    const key = `${liveOpen() ? 'open' : 'shut'}|${balls.map((b) => `${b.id}:${Math.round(b.pos.x * 100)},${Math.round(b.pos.y * 100)}`).join('|')}`;
    if (key !== lastVisionKey) {
      lastVisionKey = key;
      replan();
    }
  }
}

/** Says whether the four tapped corners worked, from the first result computed with them (not before). */
function checkManualCorners(id: number, r: Extract<VisionOut, { type: 'result' }>['result']): void {
  if (!S.manualCorners) {
    manualCheckFrom = null;
    return;
  }
  // `reason` is an optional field of newer vision pipelines ('bad-quad', 'cloth-unknown', 'moved').
  const reason = 'reason' in r && typeof r.reason === 'string' ? r.reason : '';
  if (manualCheckFrom !== null) {
    if (id < manualCheckFrom) return; // a frame sent before the corners
    const fb = calibrationFeedback({ status: r.status, calibration: r.calibration, cloth: r.cloth, reason });
    if (!fb) return;
    manualCheckFrom = null;
    lastReason = reason;
    toast(fb.message, 4000);
    if (fb.retry) {
      store.update((s) => {
        s.manualCorners = null;
        s.calibTaps = [];
        s.interaction = 'calibrate';
      });
      tableFrameChanged();
    }
    return;
  }
  if (reason === 'moved' && lastReason !== 'moved') toast(CALIBRATION_MESSAGES.moved, 4000);
  lastReason = reason;
}

// ---------------------------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------------------------
function setMode(mode: Mode, initial = false): void {
  const prev = S.mode;
  if (!initial && prev === 'snap' && mode === 'snap') return; // keep the Snap session when its tab is tapped again
  if (prev === 'snap' && mode !== 'snap') snapCtl.leave(); // photos are released when leaving Snap (FR-122)
  view3d?.stopPlayback();
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
    s.toast = null;
    s.cueOverrideId = null;
    s.targetMem = null;
    s.cueMem = null;
    // Entering Live: an old result (calibration, balls) is not shown as current until a new one arrives.
    if (mode === 'camera' && prev !== 'camera') s.vision = null;
    if (mode !== 'snap') s.snap = snapReducer(s.snap, { type: 'reset' });
  });
  for (const k of ['recommend', 'suggest', 'heatmap'] as const) planner.cancel(k);
  dropRemap();
  if (mode === 'camera') {
    lastVisionKey = '';
    cornersOut = 0;
  }
  document.body.dataset.mode = mode;
  if (mode === 'camera') void enterCamera();
  else leaveCamera();
  startOverlayLoop();
  const u = new URL(location.href);
  u.searchParams.set('mode', mode);
  history.replaceState(null, '', u);
  if (mode === 'practice' && !view3d && !force2d && S.settings.table3d && !told2d) {
    told2d = true;
    toast('3D needs WebGL2, which this browser doesn’t offer — showing the 2D table.', 4000);
  }
  queueInsets();
  replan();
}

const actions = {
  freeze() {
    dropRemap();
    if (S.frozen) {
      const fr = S.frozen;
      let cleared = false;
      store.update((s) => {
        s.frozen = null;
        if (fr.gen !== frameGen) cleared = clearSelection(s); // Rotate / Calibrate while frozen: other ids now
        else unfreezeSelection(s, fr.layout, s.table.ballRadius);
      });
      lastVisionKey = '';
      toast(cleared ? 'Live again. The selection was cleared: the table frame changed.' : 'Live again.');
    } else {
      const l = cameraLayout();
      if (!l || !S.vision?.calibration) return toast('Point at the table first — nothing to freeze yet.');
      store.update((s) => (s.frozen = { layout: { ...l, frozen: true }, calibration: s.vision!.calibration, gen: frameGen }));
      toast('Layout frozen — move freely; the plan stays on the map.');
    }
    replan();
  },
  calibrate() {
    if (S.manualCorners || S.interaction === 'calibrate') {
      const hadCorners = !!S.manualCorners;
      store.update((s) => {
        s.manualCorners = null;
        s.calibTaps = [];
        s.interaction = 'select';
      });
      manualCheckFrom = null;
      // Only dropping real corners changes the table frame (and so the vision config); the selection
      // waits for the automatic frame and is found again.
      const kept = hadCorners ? keepThroughFrame() : 'none';
      toast(kept === 'cleared' ? 'Back to automatic table detection. The selection was cleared: the table frame changed.' : 'Back to automatic table detection.');
      replan();
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
    // The camera has not moved: the selection waits for the new frame and is found again where it is.
    const kept = keepThroughFrame();
    toast(kept === 'cleared' ? 'Swapped long and short rails. The selection was cleared: the table frame changed.' : 'Swapped long and short rails.');
    replan();
  },
  markCue() {
    store.update((s) => (s.interaction = s.interaction === 'mark-cue' ? 'select' : 'mark-cue'));
    if (S.interaction === 'mark-cue') toast('Tap the cue ball.');
  },
  suggest() {
    if (S.suggestions) {
      planner.cancel('suggest'); // a reply still on its way is not shown after closing
      return store.update((s) => (s.suggestions = null));
    }
    const layout = currentLayout();
    if (!layout) return toast('No table yet.');
    store.update((s) => (s.suggestions = { items: [], pending: true }));
    planner.send('suggest', { type: 'suggest', layout, params: S.params, max: 3 });
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
      planner.cancel('heatmap');
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
    dropRemap();
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
      const balls = editableBalls(s);
      if (!balls) return;
      const used = new Set(balls.map((b) => b.id));
      let n = 1;
      while (used.has(`b${n}`)) n++;
      const R = s.table.ballRadius;
      let p: Vec2 = { x: 0, y: 0 };
      for (let k = 0; k < 200; k++) {
        p = { x: (Math.random() - 0.5) * (s.table.length - 4 * R), y: (Math.random() - 0.5) * (s.table.width - 4 * R) };
        if (balls.every((b) => dist(b.pos, p) > 3 * R)) break;
      }
      const hasCue = balls.some((b) => b.kind === 'cue');
      const cueId = used.has('cue') ? `cue${n}` : 'cue';
      setEditableBalls(s, hasCue ? [...balls, objectBall(n, p)] : [...balls, { ...cueBall(p), id: cueId }]);
    });
    if (S.mode === 'snap') toast('Ball added in the middle of the table. Drag it to where it is.');
    replan();
  },
  removeBall() {
    if (!S.targetId) return toast('Select a ball to remove.');
    store.update((s) => {
      const balls = editableBalls(s);
      if (!balls) return;
      setEditableBalls(
        s,
        balls.filter((b) => b.id !== s.targetId),
      );
      s.targetId = null;
      s.plan = null;
    });
    replan();
  },
  drill(id: string) {
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
};
const toolbar = buildToolbar($<HTMLElement>('#toolbar'), actions);

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
    // Stun, draw and follow are centre-line strokes: they drop any side from an earlier stroke.
    if (name === 'stun' || name === 'draw' || name === 'follow') st.side = 0;
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

// 3D view controls: camera presets and Play shot (FR-104, FR-108).
let slowReplay = false;
async function playShot(): Promise<void> {
  if (!view3d || !S.plan || view3d.isPlaying()) return;
  const done = view3d.playShot(S.plan, { slow: slowReplay });
  store.update(() => {});
  await done;
  store.update(() => {});
}
const viewControls = buildViewControls(viewControlsEl, {
  preset(p) {
    view3d?.setCamera(p, true);
    cameraPreset = p;
    store.update(() => {});
  },
  play: () => void playShot(),
  slow(on) {
    slowReplay = on;
    toast(on ? 'Replays at half speed.' : 'Replays at full speed.');
  },
  stop() {
    view3d?.stopPlayback();
    store.update(() => {});
  },
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && view3d?.isPlaying()) viewControls.skip();
});

// Snap mode (feature 002 US2).
const snapCtl = createSnapController($<HTMLElement>('#snap'), {
  state: () => S,
  dispatch(e: SnapEvent) {
    store.update((s) => {
      const from = s.snap.step;
      s.snap = snapReducer(s.snap, e);
      // A hint from the previous step ("Found the table… tap the one you want to pocket") must not
      // linger over the next step's instructions (e.g. "Tap the cue ball" in the manual fallback).
      if (s.snap.step !== from) s.toast = null;
    });
    queueInsets();
  },
  visionWorker,
  toast,
  selectBall,
  selectPocket,
  resetSelection() {
    store.update((s) => {
      s.targetId = null;
      s.pocketId = null;
      s.landing = null;
      s.recommended = null;
      s.suggestions = null;
      s.heatmap = null;
      s.plan = null;
      s.interaction = 'select';
      s.strokeMode = 'recommended';
    });
    replan();
  },
  addBall: () => actions.addBall(),
  removeBall: () => actions.removeBall(),
  toggleMarkCue: () => actions.markCue(),
  expandSheet: () => sheet.expand(),
  collapseSheet: () => sheet.collapse(),
  layoutChanged: queueInsets,
  refresh: () => store.update(() => {}),
  pocketName: (id) => pocketNames()[id],
  riskPockets: () => planRisks(S).map((r) => r.pocketId),
});

buildSettings(settingsDlg, () => S.settings, (next: Settings) => {
  saveSettings(next);
  const t = tableFor(next);
  const tableChanged = tableSettingsChanged(S.settings, next);
  // Only camera-relevant changes reconfigure vision: every config rebuilds the tracker (new ball ids).
  const visionChanged = visionConfigChanged(S.settings, next);
  if (tableChanged) dropRemap();
  if (tableChanged && S.mode === 'snap' && S.snap.step !== 'intro') {
    snapCtl.leave();
    toast('New table size: take the table photo again.');
  }
  let cleared = false;
  store.update((s) => {
    s.settings = next;
    s.params = physicsFor(next);
    s.recommended = null;
    if (tableChanged) {
      s.table = t;
      s.practice = { table: t, balls: DRILLS[0]!.build(t), source: 'virtual', frozen: false };
      cleared = clearSelection(s) && s.mode === 'camera';
      s.frozen = null;
    }
  });
  if (visionChanged) cleared = tableFrameChanged() || cleared;
  if (cleared) toast('Selection cleared — the table frame changed.');
  sync3D();
  queueInsets();
  replan();
});
$<HTMLButtonElement>('#btn-settings').addEventListener('click', () => settingsDlg.showModal());
document.querySelectorAll<HTMLButtonElement>('.mode-switch [data-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode as Mode)));
$<HTMLButtonElement>('#btn-practice-fallback').addEventListener('click', () => setMode('practice'));
$<HTMLButtonElement>('#btn-snap-fallback').addEventListener('click', () => setMode('snap'));
$<HTMLButtonElement>('#btn-retry-camera').addEventListener('click', () => void enterCamera());

// ---------------------------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------------------------

function update3D(s: AppState, layout: TableLayout, heat: Scene3DData['heatmap']): void {
  if (!view3d) return;
  const cloth = s.mode === 'snap' ? clothRgbOf(s.snap.overview?.vision?.cloth) : undefined;
  const risks = planRisks(s).map((r) => r.pocketId);
  const deps = [s.table, layout.balls, s.plan, s.targetId, s.pocketId, s.landing, heat, cloth?.join(','), risks.join(',')];
  if (deps.length === last3D.length && deps.every((d, i) => d === last3D[i])) return;
  last3D = deps;
  view3d.setData({
    table: s.table,
    balls: layout.balls,
    plan: s.plan,
    targetId: s.targetId,
    pocketId: s.pocketId,
    landing: s.landing,
    heatmap: heat,
    stroke: s.plan?.stroke ?? null,
    ...(cloth ? { clothRgb: cloth } : {}),
    ...(risks.length ? { riskPockets: risks } : {}),
  });
}

function snapHint(s: AppState): string {
  switch (s.snap.step) {
    case 'intro':
      return 'Take a photo of the whole table to start.';
    case 'overview-processing':
      return 'Finding the table and the balls…';
    case 'overview-error':
    case 'corners':
      return 'Show CueSight the whole table first.';
    default:
      return s.targetId ? (s.plan ? '' : 'Waiting for the cue ball and target…') : 'Tap the ball you want to pocket, on the table or on the photo.';
  }
}

/** Scratch risks of the stroke being shown, when it is the recommended one (from its robustness probes). */
function planRisks(s: AppState): StrokeRisk[] {
  const r = s.recommended;
  const p = s.plan;
  if (!p || !r || r.pending || !r.stroke || p.strokeSource !== 'recommended' || !p.makeable) return [];
  const same = r.stroke.power === p.stroke.power && r.stroke.side === p.stroke.side && r.stroke.vert === p.stroke.vert;
  return same ? (r.risks ?? []) : [];
}

function render(s: AppState): void {
  document.body.dataset.mode = s.mode;
  document.body.classList.toggle('camera-off', s.mode === 'camera' && !!s.cameraError);
  document.body.dataset.snap = s.snap.step;
  document.querySelectorAll<HTMLButtonElement>('.mode-switch [data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === s.mode)));
  toolbar.update(s);
  const layout = currentLayout();
  const heat = s.heatmap && !s.heatmap.pending ? s.heatmap : null;
  if (tableStageOn(s) && layout) {
    if (view3d) update3D(s, layout, heat);
    else practiceView.draw({ table: s.table, balls: layout.balls, plan: s.plan, targetId: s.targetId, pocketId: s.pocketId, landing: s.landing, heatmap: heat });
  }
  if (s.mode === 'camera') {
    const live = s.vision;
    // The polite live region carries the lock state only, rewritten only when it changes; the
    // per-frame counters sit beside it, hidden from assistive tech.
    setText(statusText, pillText(live?.status ?? null, !!s.frozen, liveOpen() ? cornersOut : 0));
    const meta = pillMeta(live, !!s.frozen);
    setText(statusMeta, meta);
    if (statusMeta.hidden !== !meta) statusMeta.hidden = !meta;
    const st = s.frozen ? 'frozen' : (live?.status ?? 'searching');
    if (statusPill.dataset.status !== st) statusPill.dataset.status = st;
    camMsg.hidden = !s.cameraError;
    setText(camMsg.querySelector('.msg-title')!, cameraMessageTitle(s.cameraError));
    camMsg.querySelector('p')!.textContent = s.cameraError ?? '';
    overlay.draw(overlayData(), frameMapping());
    if (layout) miniView.draw({ table: s.table, balls: layout.balls, plan: s.plan, targetId: s.targetId, pocketId: s.pocketId, landing: s.landing, heatmap: heat });
    else miniView.draw({ table: s.table, balls: [], plan: null, targetId: null, pocketId: null, landing: null, heatmap: null, dimmed: true });
  }
  if (s.mode === 'snap') snapCtl.render(s);
  viewControls.update(cameraPreset, !!s.plan && tableStageOn(s), !!view3d?.isPlaying());
  const camHint =
    s.mode === 'camera'
      ? cameraHint({
          error: !!s.cameraError,
          status: s.vision?.status ?? null,
          live: liveOpen(),
          frozen: !!s.frozen,
          balls: layout?.balls.length ?? 0,
          hasCue: !!layout?.balls.some((b) => b.kind === 'cue'),
          interaction: s.interaction,
          unsureWhites: layout?.balls.filter((b) => b.label === 'white?').length ?? 0,
        })
      : null;
  const hint =
    s.mode === 'snap'
      ? snapHint(s)
      : camHint !== null
        ? camHint
        : s.interaction === 'calibrate'
          ? 'Tap the 4 corners where the cloth meets the rails.'
          : s.targetId
            ? s.plan
              ? ''
              : 'Waiting for the cue ball and target to be visible…'
            : 'Tap the ball you want to pocket, then a pocket (or let CueSight pick the best one).';
  const names = pocketNames();
  const tb = s.targetId ? layout?.balls.find((b) => b.id === s.targetId) : undefined;
  const cueB = layout?.balls.find((b) => b.kind === 'cue');
  const alt = s.plan && !s.plan.makeable ? s.plan.alternatives[0] : undefined;
  // A frozen plan whose power advice is still coming (or failed) shows no power minimum: the one it
  // carries is not the power to play (planner-client cardPlanOf).
  renderShotCard(card, cardPlanOf(s.plan), {
    ...(tb?.color ? { targetColor: tb.color } : {}),
    targetStripe: !!tb?.stripe,
    targetLabel: s.targetId ? labelOf(s.targetId) : '',
    pocketName: s.plan ? names[s.plan.pocketId] : '',
    status: s.mode === 'camera' && s.vision ? STATUS_TEXT[s.vision.status] : null,
    recommendedPending: !!s.recommended?.pending,
    showDetails: cardDetailsShown(s.plan, s.settings.showDetails),
    hint,
    speedRef: s.plan ? speedReference(s.plan.obPocketSpeed, s.table.length, s.params) : null,
    altPocket: alt ? { id: alt.pocketId, name: names[alt.pocketId] } : null,
    // Keyboard / screen-reader (and big-finger) way to pick: the balls, then the pockets by name.
    balls: (layout?.balls ?? [])
      .filter((b) => b.kind !== 'cue')
      .map((b) => ({ id: b.id, label: labelOf(b.id), ...(b.color ? { color: b.color } : {}), ...(b.stripe ? { stripe: true } : {}) })),
    pockets: s.targetId ? s.table.pockets.map((p) => ({ id: p.id, name: names[p.id], selected: (s.plan?.pocketId ?? s.pocketId) === p.id })) : [],
    ...(cueB && s.plan ? { cbDistance: dist(cueB.pos, s.plan.ghost), ballRadius: s.table.ballRadius } : {}),
    risks: planRisks(s).map((r) => ({ scratchIf: r.scratchIf, pocketName: names[r.pocketId] })),
    snooker: s.table.id === 'snooker12',
    ...recommendationContext(s.recommended, s.plan),
  });
  // A plan whose power advice is still coming is not spoken yet (its too-soft warning has no figure):
  // the announcer starts again with the full plan, a moment later.
  announcer.update(s.plan?.adviceSkipped && fullPlanKey ? null : s.plan, !!s.recommended?.pending && s.strokeMode === 'recommended', names, labelOf);
  labelContent = labelContentOf(s, names);
  updateLabel();
  // Each suggestion's pocket is named from behind the cue ball facing that suggestion's ball.
  renderSuggestions(sugEl, s, labelOf, (id, targetId) => (targetId && targetId !== s.targetId ? pocketNames(targetId)[id] : names[id]), (x: ShotSuggestion) => {
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
  setText(toastEl, s.toast ?? '');
  if (toastEl.hidden !== !s.toast) toastEl.hidden = !s.toast;
}
/** Writes only on change: a live region rewritten with the same text is announced again by some readers. */
function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}
store.subscribe(render);

// Shot card actions (the not-makeable card offers another pocket or suggestions).
card.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-card-act]');
  if (!b) return;
  if ((b.dataset.cardAct === 'alt' || b.dataset.cardAct === 'pocket') && b.dataset.pocket) selectPocket(b.dataset.pocket as PocketId);
  else if (b.dataset.cardAct === 'ball' && b.dataset.id) {
    const ball = currentLayout()?.balls.find((x) => x.id === b.dataset.id);
    if (ball) selectBall(ball);
  }
  else if (b.dataset.cardAct === 'suggest') {
    if (!S.suggestions) actions.suggest();
  }
});
sheet.onChange = (st) => {
  document.body.dataset.sheet = st;
  queueInsets();
  updateLabel();
};
window.addEventListener('resize', () => {
  queueInsets();
  store.update(() => {});
});

// Live redraw of the overlay while the camera runs (video moves even if state doesn't). The loop only
// runs in Live: Practice and Snap stay idle between changes (FR-109, SC-101: no frames without interaction).
let overlayRaf = 0;
function overlayLoop(): void {
  overlayRaf = 0;
  if (S.mode !== 'camera') return;
  overlay.draw(overlayData(), frameMapping());
  overlayRaf = requestAnimationFrame(overlayLoop);
}
function startOverlayLoop(): void {
  if (!overlayRaf && S.mode === 'camera') overlayRaf = requestAnimationFrame(overlayLoop);
}
startOverlayLoop();

// Test/debug hook (no data leaves the page).
declare global {
  interface Window {
    __cuesight?: unknown;
  }
}
const hook = {
  state: S,
  /** The 3D table, or null when the 2D fallback is in use. */
  get view3d() {
    return view3d;
  },
  /** Table metres → page px on whichever practice/Snap table view is showing (3D or 2D). */
  practiceToScreen(p: Vec2, z = 0) {
    if (view3d && document.body.classList.contains('has-3d')) {
      const q = view3d.toScreen(p, z);
      if (q) return q;
    }
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
  setMode: (m: Mode) => setMode(m),
  playShot,
  /** Selection by id (tests and the screenshot tour drive the same flow as a tap). */
  selectBall(id: string) {
    const b = currentLayout()?.balls.find((x) => x.id === id);
    if (b) selectBall(b);
  },
  selectPocket,
  setCamera(p: CameraPreset) {
    view3d?.setCamera(p, true);
    cameraPreset = p;
    store.update(() => {});
  },
  snap: {
    session: () => S.snap,
    /** Loads the bundled sample table photo (then `useSamplePlayer` for step 2). */
    useSamples: () => snapCtl.useSample('table'),
    useSamplePlayer: () => snapCtl.useSample('player'),
    /** Photo px → page px on the Snap photo that is showing. */
    photoToScreen: (p: Vec2) => snapCtl.photoToScreen(p),
    guide: () => snapCtl.guide(),
    busy: () => snapCtl.isBusy(),
    photos: () => snapCtl.photos(),
  },
};
window.__cuesight = hook;
export type CueSightHook = typeof hook;

// PWA: offline support in production web builds only (not inside the iOS app, not from file: etc.).
// A new deploy is offered with "Reload" (src/app/sw-update.ts), never forced on the open page.
const nativeShell = isNativeShell();
if (import.meta.env.PROD && 'serviceWorker' in navigator && !nativeShell && (location.protocol === 'https:' || location.protocol === 'http:')) {
  window.addEventListener('load', () => registerServiceWorker(navigator.serviceWorker, $<HTMLElement>('#stage')));
}

sync3D();
update3DInsets();
function start(mode: Mode): void {
  setMode(mode, true);
  mountOnboarding($<HTMLElement>('#stage'));
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      hideSplash();
      console.info(`[CueSight] ready mode=${S.mode} renderer=${view3d ? 'webgl2' : '2d'}`);
      if (import.meta.env.VITE_CUESIGHT_TOUR === '1') void import('./tour').then((m) => m.runTour(hook));
    }),
  );
}
// A touch device that would start in Live first checks a camera exists (enumerateDevices needs no
// permission and opens nothing): without one (iOS Simulator, camera-less tablets) it starts in Practice.
if (modeOverride || initialMode !== 'camera') start(initialMode);
else void probeCamera(navigator.mediaDevices).then((has) => start(startMode(coarse, has)));
