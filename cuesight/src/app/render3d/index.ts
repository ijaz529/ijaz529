/**
 * 3D practice table (feature 002, US1): a hand-written WebGL2 renderer with orbit/pinch/pan,
 * camera presets, picking, ball dragging, the shot plan in 3D, a cue stick showing tip offset and
 * power, and a physically consistent "Play shot" replay. Returns null without WebGL2 so the app can
 * fall back to the 2D TableView.
 */
import { clampToTable } from '../../core/table';
import type { Ball, PocketId, ShotPlan, Stroke, TableSpec, Vec2 } from '../../core/types';
import { PALETTE } from '../render/palette';
import {
  broadcastOrbit,
  cameraMatrices,
  clampUserOrbit,
  insetShift,
  landscapeFrame,
  lerpOrbit,
  overviewOrbit,
  pixelAtUnit,
  playerOrbit,
  NO_INSETS,
  type CameraMatrices,
  type Insets,
  type Orbit,
} from './camera';
import { tableGeom, type TableGeom } from './geom';
import { easeInOutCubic, easeOutCubic, mat4, mat4FromBasis, project, quatMultiply, rayAt, rayPlaneZ, screenRay, v3cross, v3norm, type Quat, type V3 } from './math3d';
import { pickRay, type Pick3D } from './picking';
import { buildTrack, playbackTimeline, sampleTrack, type BallPose, type PlaybackTrack, type Timeline } from './playback';
import { Renderer, type BallDraw, type DotDraw, type FrameState } from './scene';
import { ADDRESS_GAP, ballLook, contactPoint3, cuePose, hexRGBA, planRibbons, practiceStroke, restOrientation, type BallLook } from './scene-data';

export type { Pick3D } from './picking';

export type CameraPreset = 'overview' | 'player' | 'broadcast';

export interface Scene3DData {
  table: TableSpec;
  balls: Ball[];
  plan: ShotPlan | null;
  targetId: string | null;
  pocketId: PocketId | null;
  landing: Vec2 | null;
  heatmap: { cols: number; rows: number; values: Float32Array } | null;
  stroke: Stroke | null;
  clothRgb?: [number, number, number];
  /** Pockets at risk of a scratch under a small error (dashed rings). */
  riskPockets?: PocketId[];
}

/** Where things are on screen after a frame is drawn (client CSS px), for HTML labels in the scene. */
export interface FrameInfo {
  /** Cue ball centre and on-screen radius, or null when it is off screen / behind the camera. */
  cue: { x: number; y: number; r: number } | null;
  /**
   * Screen points along the plan's lines (aim, object-ball path, cue-ball path), balls and the cue
   * stick to keep clear; `w` weights a point (the stick counts triple: a label must never hide it).
   */
  avoid: { x: number; y: number; w?: number }[];
  /** The free part of the canvas (not under floating controls), client px. */
  free: { left: number; top: number; right: number; bottom: number };
  preset: CameraPreset | 'custom';
  /** Camera elevation (rad): π/2 = straight down. */
  pitch: number;
  playing: boolean;
  /** Every ball's centre and on-screen radius (client px), for number tags; off-screen balls are left out. */
  balls?: { id: string; x: number; y: number; r: number }[];
  /** The camera is moving (a transition, or the player orbiting/panning/zooming) or a ball is being dragged. */
  moving?: boolean;
}

export interface Table3DEvents {
  onTap?(p: Pick3D, ev: PointerEvent): void;
  onBallDrag?(id: string, pos: Vec2, phase: 'start' | 'move' | 'end'): void;
  onCameraChange?(preset: CameraPreset | 'custom'): void;
  /** After each drawn frame (camera moves, transitions, replays). */
  onFrame?(info: FrameInfo): void;
}

export interface Table3D {
  readonly canvas: HTMLCanvasElement;
  /** Cheap: stores the data, marks dirty and renders on the next animation frame. */
  setData(d: Scene3DData): void;
  setCamera(preset: CameraPreset, animate?: boolean): void;
  getCamera(): CameraPreset | 'custom';
  /** Replays the plan's simulated trajectories in real time (×1, capped at 4 s, tap to skip); `slow` at half speed. */
  playShot(plan: ShotPlan, opts?: { slow?: boolean }): Promise<void>;
  stopPlayback(): void;
  isPlaying(): boolean;
  pick(clientX: number, clientY: number): Pick3D;
  /** Table metres → client CSS px (getBoundingClientRect-based). z defaults to the bed (0). */
  toScreen(p: Vec2, z?: number): { x: number; y: number } | null;
  resize(): void;
  destroy(): void;
  /**
   * Optional extension: CSS-px insets covered by floating UI (e.g. the bottom sheet); presets frame
   * the table inside the remaining rectangle.
   */
  setInsets?(insets: { top?: number; right?: number; bottom?: number; left?: number }): void;
  /** Optional extension: true while a camera transition is running (for tests). */
  isAnimating?(): boolean;
}

export interface Table3DOptions {
  reducedMotion?: boolean;
  maxPixelRatio?: number;
}

const TAP_MAX_PX = 8;
const TAP_MAX_MS = 350;
const DOUBLE_TAP_MS = 320;
const TRANSITION_MS = 720;
const ORBIT_RAD_PER_PX = 0.0065;
const STRIKE_PRE_S = 0.5;
const HOLD_S = 3.5;
/** Idle practice strokes in Player view: this many, this long each, then the cue rests at address. */
const PRACTICE_STROKES = 3;
const PRACTICE_STROKE_S = 1.8;
/** Above this camera elevation the cue stick is hidden: from overhead it reads as a stray line. */
const CUE_MAX_PITCH = (70 * Math.PI) / 180;

interface DragState {
  id: string;
  pos: Vec2;
}

interface PlaybackState {
  plan: ShotPlan;
  tracks: Map<string, PlaybackTrack>;
  startQ: Map<string, Quat>;
  tl: Timeline;
  t0: number;
  pre: number;
  /** Real time (ms) at which the hold ends, once known. */
  holdUntil: number | null;
  resolve: () => void;
}

export function createTable3D(canvas: HTMLCanvasElement, events: Table3DEvents = {}, opts: Table3DOptions = {}): Table3D | null {
  let gl: WebGL2RenderingContext | null = null;
  try {
    gl = canvas.getContext('webgl2', { antialias: true, alpha: false, depth: true, stencil: false, premultipliedAlpha: true, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
  } catch {
    gl = null;
  }
  if (!gl) return null;
  let renderer: Renderer;
  try {
    renderer = new Renderer(gl);
  } catch (e) {
    console.warn('CueSight 3D table unavailable:', e);
    return null;
  }
  const GL = gl;
  const reduced = opts.reducedMotion ?? (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);
  const maxDpr = opts.maxPixelRatio ?? 2;
  canvas.style.touchAction = 'none';

  // -------------------------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------------------------
  let data: Scene3DData | null = null;
  let g: TableGeom | null = null;
  let looks = new Map<string, BallLook>();
  const orient = new Map<string, Quat>();
  let preset: CameraPreset | 'custom' = 'overview';
  let lastPreset: CameraPreset = 'overview';
  let orbit: Orbit | null = null;
  let anim: { from: Orbit; to: Orbit; t0: number; dur: number } | null = null;
  let insetsPx = { top: 0, right: 0, bottom: 0, left: 0 };
  let cssW = 1;
  let cssH = 1;
  let dpr = 1;
  let dirty = true;
  let raf = 0;
  let lost = false;
  let destroyed = false;
  let drag: DragState | null = null;
  let play: PlaybackState | null = null;
  let lastHeat: Scene3DData['heatmap'] = null;
  let lastCloth: string | undefined;
  /** Idle practice-stroke loop (Player view): when it started and for which stroke/cue position. */
  let loop: { t0: number; key: string } | null = null;
  let loopKey = '';
  /** Restarts the practice strokes when the stroke, the cue ball or the view changes. */
  function syncLoop(): void {
    const d0 = data;
    const st = d0?.stroke ?? d0?.plan?.stroke;
    const c = d0?.balls.find((b) => b.kind === 'cue');
    const key = preset === 'player' && st && c && d0?.plan ? `${st.power}|${st.side}|${st.vert}|${c.pos.x.toFixed(3)},${c.pos.y.toFixed(3)}|${d0.plan.targetId}>${d0.plan.pocketId}` : '';
    if (key === loopKey) return;
    loopKey = key;
    loop = key && !reduced ? { t0: now() + TRANSITION_MS, key } : null;
  }
  const looping = (t: number) => !!loop && t - loop.t0 < PRACTICE_STROKES * PRACTICE_STROKE_S * 1000;

  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const aspect = () => cssW / Math.max(1, cssH);
  const insetsFrac = (): Insets =>
    cssW > 1 && cssH > 1
      ? { top: insetsPx.top / cssH, bottom: insetsPx.bottom / cssH, left: insetsPx.left / cssW, right: insetsPx.right / cssW }
      : NO_INSETS;
  const overviewUp = (): Vec2 => (landscapeFrame(aspect(), insetsFrac()) ? { x: 0, y: 1 } : { x: 1, y: 0 });


  function schedule(): void {
    if (raf || lost || destroyed) return;
    raf = requestAnimationFrame(frame);
  }
  function markDirty(): void {
    dirty = true;
    schedule();
  }

  // -------------------------------------------------------------------------------------------
  // Camera
  // -------------------------------------------------------------------------------------------
  /** Cue ball, the cue-ball path direction (aim), the cue's own direction (squirt-corrected) and the ghost ball. */
  function cueAndAim(): { cue: Vec2; aim: Vec2; cueDir: Vec2; ghost: Vec2 | null } | null {
    const d0 = data;
    if (!d0) return null;
    const cue = d0.balls.find((b) => b.kind === 'cue');
    if (!cue) return null;
    if (d0.plan) return { cue: cue.pos, aim: d0.plan.aimDir, cueDir: d0.plan.cueDir ?? d0.plan.aimDir, ghost: d0.plan.ghost };
    const t = d0.targetId ? d0.balls.find((b) => b.id === d0.targetId) : undefined;
    if (t) {
      const d = { x: t.pos.x - cue.pos.x, y: t.pos.y - cue.pos.y };
      if (Math.hypot(d.x, d.y) > 1e-6) return { cue: cue.pos, aim: d, cueDir: d, ghost: t.pos };
    }
    const d = Math.hypot(cue.pos.x, cue.pos.y) > 0.05 ? { x: -cue.pos.x, y: -cue.pos.y } : { x: 1, y: 0 };
    return { cue: cue.pos, aim: d, cueDir: d, ghost: null };
  }

  /** What the Player view must keep in frame: the pocket, where the object ball goes, the ghost ball. */
  function playerKeep(): V3[] {
    const d0 = data;
    if (!d0 || !g) return [];
    const keep: V3[] = [];
    const plan = d0.plan;
    const pocketId = plan?.pocketId ?? d0.pocketId;
    const hole = pocketId ? g.holes.find((h) => h.id === pocketId) : undefined;
    if (hole) keep.push([hole.x, hole.y, 0]);
    if (plan) {
      keep.push([plan.ghost.x, plan.ghost.y, g.R]);
      const pts = plan.objectPath.points;
      if (pts.length) {
        const e = pts[pts.length - 1]!;
        keep.push([Math.max(-g.hx, Math.min(g.hx, e.x)), Math.max(-g.hy, Math.min(g.hy, e.y)), g.R]);
      }
    } else if (d0.targetId) {
      const t = d0.balls.find((b) => b.id === d0.targetId);
      if (t) keep.push([t.pos.x, t.pos.y, g.R]);
    }
    return keep;
  }

  function presetOrbit(p: CameraPreset): Orbit | null {
    if (!g) return null;
    const ins = insetsFrac();
    if (p === 'overview') return overviewOrbit(g, aspect(), ins);
    if (p === 'broadcast') return broadcastOrbit(g, aspect(), ins);
    const ca = cueAndAim();
    if (!ca) return broadcastOrbit(g, aspect(), ins);
    const st = data?.stroke ?? data?.plan?.stroke ?? { power: 4, side: 0, vert: 0 };
    const elevation = cuePose(g, ca.cue, ca.cueDir, st).elevation;
    return playerOrbit(g, ca.cue, ca.aim, ca.ghost, aspect(), { keep: playerKeep(), insets: ins, cueElevation: elevation });
  }

  function goTo(target: Orbit, animate: boolean): void {
    if (!orbit || !animate || reduced) {
      orbit = target;
      anim = null;
    } else {
      anim = { from: currentOrbit(), to: target, t0: now(), dur: TRANSITION_MS };
    }
    markDirty();
  }

  function currentOrbit(): Orbit {
    if (anim) {
      const u = (now() - anim.t0) / anim.dur;
      if (u >= 1) {
        orbit = anim.to;
        anim = null;
      } else return lerpOrbit(anim.from, anim.to, easeInOutCubic(u));
    }
    return orbit!;
  }

  function becomeCustom(): void {
    if (anim) {
      orbit = currentOrbit();
      anim = null;
    }
    if (preset !== 'custom') {
      preset = 'custom';
      events.onCameraChange?.('custom');
    }
  }

  function matrices(): CameraMatrices | null {
    if (!orbit) return null;
    // The inset shift keeps every view centred in the uncovered part of the canvas.
    return cameraMatrices(currentOrbit(), aspect(), insetShift(insetsFrac()));
  }

  // -------------------------------------------------------------------------------------------
  // Sizing
  // -------------------------------------------------------------------------------------------
  function measure(): void {
    const w = canvas.clientWidth || canvas.getBoundingClientRect().width;
    const h = canvas.clientHeight || canvas.getBoundingClientRect().height;
    cssW = Math.max(1, Math.round(w));
    cssH = Math.max(1, Math.round(h));
    dpr = Math.min(maxDpr, (typeof devicePixelRatio === 'number' && devicePixelRatio) || 1);
    const bw = Math.max(1, Math.round(cssW * dpr));
    const bh = Math.max(1, Math.round(cssH * dpr));
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
    }
  }

  function resize(): void {
    if (destroyed) return;
    measure();
    if (g && preset !== 'custom') {
      const o = presetOrbit(preset);
      if (o) goTo(o, false);
    }
    markDirty();
  }

  let ro: ResizeObserver | null = null;
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => resize());
    ro.observe(canvas);
  }
  measure();

  // -------------------------------------------------------------------------------------------
  // Data
  // -------------------------------------------------------------------------------------------
  function setData(d: Scene3DData): void {
    if (destroyed) return;
    const tableChanged = !data || data.table !== d.table;
    const prev = data;
    data = d;
    if (tableChanged) {
      renderer.setTable(d.table);
      g = renderer.geom ?? tableGeom(d.table);
    }
    const clothKey = d.clothRgb ? d.clothRgb.join(',') : undefined;
    if (tableChanged || clothKey !== lastCloth) {
      renderer.setCloth(d.clothRgb);
      lastCloth = clothKey;
    }
    if (d.heatmap !== lastHeat) {
      renderer.setHeatmap(d.heatmap);
      lastHeat = d.heatmap;
    }
    const up = overviewUp();
    const nl = new Map<string, BallLook>();
    for (const b of d.balls) {
      nl.set(b.id, ballLook(b, d.table));
      if (!orient.has(b.id)) orient.set(b.id, restOrientation(b.id, up));
    }
    looks = nl;
    uploadRibbons(true);
    syncLoop();
    // Camera follow-ups.
    if (!orbit || tableChanged) {
      if (preset === 'custom') {
        preset = lastPreset;
        events.onCameraChange?.(preset);
      }
      const o = presetOrbit(preset as CameraPreset);
      if (o) goTo(o, !!orbit && !tableChanged);
    } else if (preset === 'player') {
      const movedAim = !prev || moved(prev.plan?.ghost, d.plan?.ghost) || prev.targetId !== d.targetId || moved(cuePos(prev), cuePos(d));
      if (movedAim && !drag) {
        const o = presetOrbit('player');
        if (o) goTo(o, true);
      }
    }
    markDirty();
  }

  /** Ribbons depend on the data and on whether the target ring is wanted (not in Player view). */
  let ribbonsKey: string | null = null;
  function uploadRibbons(force = false): void {
    if (!data || !g) return;
    const ring = preset !== 'player';
    const ghostSolid = preset === 'overview';
    const key = `${ring}|${ghostSolid}`;
    if (!force && key === ribbonsKey) return;
    ribbonsKey = key;
    renderer.setRibbons(planRibbons(data, g, { targetRing: ring, ghostSolid }));
  }

  function cuePos(d: Scene3DData): Vec2 | undefined {
    return d.balls.find((b) => b.kind === 'cue')?.pos;
  }

  /** Moved by more than a millimetre (or appeared/disappeared)? */
  function moved(a: Vec2 | undefined, b: Vec2 | undefined): boolean {
    if (!a || !b) return a !== b;
    return Math.hypot(a.x - b.x, a.y - b.y) > 1e-3;
  }

  // -------------------------------------------------------------------------------------------
  // Frame building
  // -------------------------------------------------------------------------------------------
  const pose: BallPose = { x: 0, y: 0, z: 0, q: [0, 0, 0, 1], visible: true };

  function playbackTime(t: number): { phase: 'pre' | 'run' | 'hold' | 'done'; simT: number; pre: number } {
    const p = play!;
    const tau = (t - p.t0) / 1000;
    if (tau < p.pre) return { phase: 'pre', simT: 0, pre: tau };
    const simT = (tau - p.pre) * p.tl.rate;
    if (simT < p.tl.simEnd && p.holdUntil === null) return { phase: 'run', simT, pre: p.pre };
    if (p.holdUntil === null) p.holdUntil = t + HOLD_S * 1000 * (reduced ? 1.8 : 1);
    return { phase: t < p.holdUntil ? 'hold' : 'done', simT: p.tl.simEnd, pre: p.pre };
  }

  function buildFrame(cam: CameraMatrices, t: number): FrameState {
    const d = data!;
    const geo = g!;
    const R = geo.R;
    const balls: BallDraw[] = [];
    let phase: 'idle' | 'pre' | 'run' | 'hold' | 'done' = 'idle';
    let simT = 0;
    let preT = 0;
    if (play) {
      const pt = playbackTime(t);
      phase = pt.phase;
      simT = pt.simT;
      preT = pt.pre;
    }
    const playing = phase !== 'idle';
    for (const b of d.balls) {
      const look = looks.get(b.id) ?? ballLook(b, d.table);
      let x = b.pos.x;
      let y = b.pos.y;
      let z = R;
      let q = orient.get(b.id) ?? [0, 0, 0, 1];
      if (drag && drag.id === b.id) {
        x = drag.pos.x;
        y = drag.pos.y;
      }
      if (playing && play) {
        const tr = play.tracks.get(b.id);
        if (tr) {
          sampleTrack(tr, simT, R, pose);
          x = pose.x;
          y = pose.y;
          z = pose.z;
          q = quatMultiply(pose.q, play.startQ.get(b.id) ?? q);
        }
      }
      balls.push({ id: b.id, x, y, z, q, color: look.color, stripe: look.stripe, slot: look.slot, cueDots: look.cueDots, highlight: !playing && b.id === d.targetId && preset !== 'player', visible: true });
    }
    const showPlan = !playing;
    const dots: DotDraw[] = [];
    let cueModel: ReturnType<typeof mat4> | null = null;
    const plan = d.plan;
    if (showPlan && plan) {
      // Sized to the object ball on screen (half its diameter, at most 11 px): a fixed 11 px dot hid
      // half of a 10 px ball in the top view. Too small to read below a 6 px ball.
      const tb = d.balls.find((b) => b.id === plan.targetId);
      const diam = tb ? 2 * ballScreenRadius(cam, tb.pos, R) : 20;
      if (diam >= 6) dots.push({ p: contactPoint3(plan, R), size: Math.min(11, Math.max(4, 0.55 * diam)), color: hexRGBA(PALETTE.warn), ring: [1, 1, 1, 0.95], pull: 0.008 });
    }
    // Cue stick: along the cue's own direction (the squirt-corrected line, not the cue-ball path)
    // with the stroke's tip offset and pulled back by power. Hidden from overhead, where it would
    // read as a stray line; there the in-scene label carries power and spin instead. The strike
    // point is shown face-on in that label (a dot projected onto the back of the ball from a
    // raised eye lands below centre for a high hit, which reads as the opposite instruction).
    const ca = cueAndAim();
    const stroke = d.stroke ?? plan?.stroke ?? null;
    const cueBall = d.balls.find((b) => b.kind === 'cue');
    const overhead = preset === 'overview' || currentOrbit().pitch > CUE_MAX_PITCH;
    if (!overhead && ca && cueBall && (plan || d.targetId) && (phase === 'idle' || phase === 'pre' || (phase === 'run' && simT < 0.25 * (play?.tl.rate ?? 1)))) {
      const st: Stroke = stroke ?? { power: 4, side: 0, vert: 0 };
      // During playback the stick strikes from where the replayed shot starts.
      const pp = playing && play ? play.plan : null;
      const cpos = pp && pp.cuePath.points.length ? pp.cuePath.points[0]! : drag && drag.id === cueBall.id ? drag.pos : ca.cue;
      const cp = cuePose(geo, cpos, pp ? (pp.cueDir ?? pp.aimDir) : ca.cueDir, pp ? (d.stroke ?? pp.stroke) : st);
      // At rest the cue addresses the ball (tip ADDRESS_GAP behind the strike point); power shows as
      // the length of a few idle practice strokes, and of the back-swing (cp.gap) before a replay.
      let gap = ADDRESS_GAP;
      if (phase === 'pre') {
        const back = 0.3;
        if (preT < back) gap = ADDRESS_GAP + (cp.gap - ADDRESS_GAP) * easeOutCubic(preT / back);
        else {
          const u = Math.min(1, (preT - back) / (STRIKE_PRE_S - back));
          gap = cp.gap * (1 - u * u);
        }
      } else if (phase === 'run') gap = -0.03;
      else if (loop && looping(t) && t >= loop.t0) {
        const u = ((t - loop.t0) / 1000 / PRACTICE_STROKE_S) % 1;
        gap = ADDRESS_GAP + practiceStroke(st.power) * (0.5 - 0.5 * Math.cos(2 * Math.PI * u));
      }
      const tip: V3 = [cp.strike[0] + cp.back[0] * gap, cp.strike[1] + cp.back[1] * gap, cp.strike[2] + cp.back[2] * gap];
      const side = v3norm(v3cross([0, 0, 1], cp.back));
      const up = v3cross(cp.back, side);
      cueModel = mat4FromBasis(mat4(), cp.back, side, up, tip);
    }
    const pocketId = plan?.pocketId ?? d.pocketId;
    const hole = pocketId && showPlan ? geo.holes.find((h) => h.id === pocketId) : undefined;
    return {
      cam,
      width: canvas.width,
      height: canvas.height,
      dpr: canvas.width / Math.max(1, cssW),
      balls,
      ghost: showPlan && plan ? plan.ghost : null,
      dots,
      cue: cueModel,
      glow: hole ? { x: hole.x, y: hole.y, r: hole.r * 1.6, color: [0.91, 0.77, 0.42, 0.2] } : null,
      // During the replay the planned lines come back faint once the balls run (the strike itself shows
      // the bare table), so the run can be compared with the plan.
      ribbons: showPlan || (playing && phase !== 'pre'),
      ribbonsFaint: playing,
      heat: showPlan && !!d.heatmap,
    };
  }

  function frame(): void {
    raf = 0;
    if (destroyed || lost) return;
    const t = now();
    let animating = false;
    if (anim) animating = true;
    if (loop && looping(t)) animating = true;
    else if (loop) loop = null;
    if (play) {
      const pt = playbackTime(t);
      if (pt.phase === 'done') finishPlayback();
      else animating = true;
    }
    if (dirty || animating) {
      dirty = false;
      const cam = matrices();
      if (data && g && cam && cssW > 1 && cssH > 1) {
        uploadRibbons();
        renderer.draw(buildFrame(cam, t));
        if (events.onFrame) events.onFrame(frameInfo(cam));
      } else {
        GL.clearColor(0.027, 0.043, 0.078, 1);
        GL.clear(GL.COLOR_BUFFER_BIT);
      }
    }
    if (anim || play || loop) schedule();
  }

  /** On-screen radius (CSS px) of a ball at p. */
  function ballScreenRadius(cam: CameraMatrices, p: Vec2, R: number): number {
    const W = Math.max(1, cssW);
    const H = Math.max(1, cssH);
    const c = project(cam.vp, [p.x, p.y, R], W, H);
    const e = project(cam.vp, [p.x + cam.right[0] * R, p.y + cam.right[1] * R, R + cam.right[2] * R], W, H);
    return c && e ? Math.hypot(e.x - c.x, e.y - c.y) : 0;
  }

  /** Screen positions for HTML labels anchored in the scene. */
  function frameInfo(cam: CameraMatrices): FrameInfo {
    const r = canvas.getBoundingClientRect();
    const d = data!;
    const geo = g!;
    const W = Math.max(1, r.width);
    const H = Math.max(1, r.height);
    const scr = (x: number, y: number, z: number) => {
      const q = project(cam.vp, [x, y, z], W, H);
      return q ? { x: r.left + q.x, y: r.top + q.y } : null;
    };
    const cueB = d.balls.find((b) => b.kind === 'cue');
    let cue: FrameInfo['cue'] = null;
    if (cueB) {
      const p = drag && drag.id === cueB.id ? drag.pos : cueB.pos;
      const c = scr(p.x, p.y, geo.R);
      const e = scr(p.x + cam.right[0] * geo.R, p.y + cam.right[1] * geo.R, geo.R + cam.right[2] * geo.R);
      if (c && e) cue = { x: c.x, y: c.y, r: Math.hypot(e.x - c.x, e.y - c.y) };
    }
    const avoid: { x: number; y: number; w?: number }[] = [];
    const push = (x: number, y: number, z = 0) => {
      const q = scr(x, y, z);
      if (q) avoid.push(q);
    };
    const plan = d.plan;
    if (plan && cueB) {
      // Aim line (sampled), ghost, object-ball and cue-ball paths (decimated).
      for (let k = 0; k <= 8; k++) push(cueB.pos.x + (plan.ghost.x - cueB.pos.x) * (k / 8), cueB.pos.y + (plan.ghost.y - cueB.pos.y) * (k / 8));
      push(plan.ghost.x, plan.ghost.y, geo.R);
      for (const tr of [plan.objectPath, plan.cuePath]) {
        const pts = tr.points;
        const step = Math.max(1, Math.floor(pts.length / 16));
        for (let i = 0; i < pts.length; i += step) push(pts[i]!.x, pts[i]!.y);
        if (pts.length) push(pts[pts.length - 1]!.x, pts[pts.length - 1]!.y);
      }
    }
    // Balls weigh as much as the stick: a label must not hide a ball.
    for (const b of d.balls)
      if (b !== cueB) {
        const q = scr(b.pos.x, b.pos.y, geo.R);
        if (q) avoid.push({ x: q.x, y: q.y, w: 3 });
      }
    for (const h of geo.holes) push(h.x, h.y, 0);
    // The cue stick (tip at address → 1 m up the butt, including the practice strokes' reach), weighted
    // so a label never sits on it: it shows where the tip meets the ball.
    const ca = cueAndAim();
    if (ca && cueB && preset !== 'overview') {
      const st = d.stroke ?? plan?.stroke ?? { power: 4, side: 0, vert: 0 };
      const cp = cuePose(geo, ca.cue, ca.cueDir, st);
      for (let k = ADDRESS_GAP; k <= 1.0 + practiceStroke(st.power); k += 0.06) {
        const q = scr(cp.strike[0] + cp.back[0] * k, cp.strike[1] + cp.back[1] * k, cp.strike[2] + cp.back[2] * k);
        if (q) avoid.push({ x: q.x, y: q.y, w: 3 });
      }
    }
    const ballsOut: NonNullable<FrameInfo['balls']> = [];
    for (const b of d.balls) {
      const p = drag && drag.id === b.id ? drag.pos : b.pos;
      const c = scr(p.x, p.y, geo.R);
      const e = scr(p.x + cam.right[0] * geo.R, p.y + cam.right[1] * geo.R, geo.R + cam.right[2] * geo.R);
      if (c && e) ballsOut.push({ id: b.id, x: c.x, y: c.y, r: Math.hypot(e.x - c.x, e.y - c.y) });
    }
    return {
      cue,
      avoid,
      balls: ballsOut,
      free: { left: r.left + insetsPx.left, top: r.top + insetsPx.top, right: r.right - insetsPx.right, bottom: r.bottom - insetsPx.bottom },
      preset,
      pitch: currentOrbit().pitch,
      playing: play !== null,
      moving: anim !== null || drag !== null || mode === 'orbit' || mode === 'pan' || mode === 'pinch',
    };
  }

  // -------------------------------------------------------------------------------------------
  // Playback
  // -------------------------------------------------------------------------------------------
  function playShot(plan: ShotPlan, popts: { slow?: boolean } = {}): Promise<void> {
    if (play) finishPlayback();
    if (!g || !data) return Promise.resolve();
    const geo = g;
    const holes: Partial<Record<PocketId, { x: number; y: number }>> = {};
    for (const h of geo.holes) holes[h.id] = { x: h.x, y: h.y };
    const tracks = new Map<string, PlaybackTrack>();
    for (const tr of [plan.cuePath, plan.objectPath, ...plan.otherPaths]) if (tr.points.length > 0) tracks.set(tr.ballId, buildTrack(tr, geo.R, { holes, pocketDepth: 0.09 }));
    const startQ = new Map<string, Quat>();
    for (const b of data.balls) startQ.set(b.id, orient.get(b.id) ?? [0, 0, 0, 1]);
    const tl0 = playbackTimeline([...tracks.values()], 4);
    // Half speed: the same frames over twice the time (to watch the spin take, the contact, the bend).
    const tl = popts.slow ? { simEnd: tl0.simEnd, rate: tl0.rate / 2, duration: tl0.duration * 2 } : tl0;
    return new Promise<void>((resolve) => {
      play = { plan, tracks, startQ, tl, t0: now(), pre: reduced ? 0 : STRIKE_PRE_S, holdUntil: null, resolve };
      if (reduced) {
        // Jump straight to the end state.
        play.t0 = now() - (tl.duration + 0.001) * 1000;
      }
      markDirty();
    });
  }

  function skipPlayback(): void {
    if (!play) return;
    if (play.holdUntil !== null) {
      finishPlayback();
      return;
    }
    // Jump to the final positions and hold briefly.
    play.t0 = now() - (play.pre + play.tl.duration + 0.001) * 1000;
    play.holdUntil = now() + 650;
    markDirty();
  }

  function finishPlayback(): void {
    const p = play;
    if (!p) return;
    play = null;
    markDirty();
    p.resolve();
  }

  // -------------------------------------------------------------------------------------------
  // Picking & projection
  // -------------------------------------------------------------------------------------------
  function rayAtClient(clientX: number, clientY: number) {
    const cam = matrices();
    if (!cam) return null;
    const r = canvas.getBoundingClientRect();
    return { ray: screenRay(cam.invVP, clientX - r.left, clientY - r.top, Math.max(1, r.width), Math.max(1, r.height)), cam, rect: r };
  }

  function pick(clientX: number, clientY: number): Pick3D {
    if (!data || !g) return null;
    const rr = rayAtClient(clientX, clientY);
    if (!rr) return null;
    const R = g.R;
    const balls = data.balls.map((b) => {
      const p = drag && drag.id === b.id ? drag.pos : b.pos;
      return { id: b.id, x: p.x, y: p.y, z: R, r: R };
    });
    const pockets = data.table.pockets.map((p) => ({ id: p.id, x: p.mouthCenter.x - p.inward.x * 0.02, y: p.mouthCenter.y - p.inward.y * 0.02, r: (p.kind === 'corner' ? data!.table.cornerMouth : data!.table.sideMouth) * 0.75 }));
    return pickRay({ ray: rr.ray, balls, pockets, bedHalf: { x: g.hx, y: g.hy }, pxAtUnit: pixelAtUnit(rr.cam.fovY, Math.max(1, rr.rect.height)) });
  }

  function toScreen(p: Vec2, z = 0): { x: number; y: number } | null {
    const cam = matrices();
    if (!cam) return null;
    const r = canvas.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    const q = project(cam.vp, [p.x, p.y, z], r.width, r.height);
    return q ? { x: r.left + q.x, y: r.top + q.y } : null;
  }

  /** Point under the pointer on the plane z = h (table metres). */
  function planePoint(clientX: number, clientY: number, h: number): Vec2 | null {
    const rr = rayAtClient(clientX, clientY);
    if (!rr) return null;
    const t = rayPlaneZ(rr.ray, h);
    if (t === null) return null;
    const q = rayAt(rr.ray, t);
    return { x: q[0], y: q[1] };
  }

  // -------------------------------------------------------------------------------------------
  // Gestures
  // -------------------------------------------------------------------------------------------
  interface Ptr {
    x: number;
    y: number;
    sx: number;
    sy: number;
    t0: number;
  }
  const ptrs = new Map<number, Ptr>();
  type Mode = 'none' | 'pending' | 'orbit' | 'pan' | 'ball' | 'pinch';
  let mode: Mode = 'none';
  let pendingBall: string | null = null;
  let panButton = false;
  let pinch: { d0: number; dist0: number; mx: number; my: number } | null = null;
  let lastTap: { t: number; x: number; y: number; empty: boolean } | null = null;

  function onDown(e: PointerEvent): void {
    if (!data || !g) return;
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic events */
    }
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t0: now() });
    if (ptrs.size === 1) {
      mode = 'pending';
      panButton = e.button === 2 || e.shiftKey;
      const p = play ? null : pick(e.clientX, e.clientY);
      pendingBall = p && p.kind === 'ball' && !panButton ? p.id : null;
    } else if (ptrs.size === 2) {
      endBallDrag();
      mode = 'pinch';
      const [a, b] = [...ptrs.values()] as [Ptr, Ptr];
      pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, dist0: currentOrbit().dist, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
      becomeCustom();
    }
  }

  function onMove(e: PointerEvent): void {
    const p = ptrs.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    if (mode === 'pending' && Math.hypot(p.x - p.sx, p.y - p.sy) >= TAP_MAX_PX) {
      if (pendingBall && events.onBallDrag) {
        mode = 'ball';
        const pos = dragPos(e.clientX, e.clientY);
        if (pos) {
          drag = { id: pendingBall, pos };
          events.onBallDrag(pendingBall, pos, 'start');
        }
      } else {
        mode = panButton ? 'pan' : 'orbit';
        becomeCustom();
      }
    }
    if (mode === 'orbit') {
      const o = currentOrbit();
      orbit = clampUserOrbit({ ...o, yaw: o.yaw - dx * ORBIT_RAD_PER_PX, pitch: o.pitch + dy * ORBIT_RAD_PER_PX }, g!);
      markDirty();
    } else if (mode === 'pan') {
      panBy(dx, dy);
    } else if (mode === 'ball' && drag) {
      const pos = dragPos(e.clientX, e.clientY);
      if (pos) {
        drag.pos = pos;
        events.onBallDrag?.(drag.id, pos, 'move');
        markDirty();
      }
    } else if (mode === 'pinch' && pinch && ptrs.size >= 2) {
      const [a, b] = [...ptrs.values()] as [Ptr, Ptr];
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const o = currentOrbit();
      orbit = clampUserOrbit({ ...o, dist: (pinch.dist0 * pinch.d0) / d }, g!);
      panBy(mx - pinch.mx, my - pinch.my);
      pinch.mx = mx;
      pinch.my = my;
      markDirty();
    }
  }

  function dragPos(clientX: number, clientY: number): Vec2 | null {
    if (!g || !data) return null;
    const q = planePoint(clientX, clientY, g.R);
    return q ? clampToTable(data.table, q) : null;
  }

  function panBy(dx: number, dy: number): void {
    if (!g) return;
    const o = currentOrbit();
    const cam = cameraMatrices(o, aspect());
    const wpp = o.dist * pixelAtUnit(o.fovY, cssH);
    const rl = Math.hypot(cam.right[0], cam.right[1]) || 1;
    const ul = Math.hypot(cam.up[0], cam.up[1]) || 1;
    const k = 1 / Math.max(0.35, Math.sin(o.pitch));
    const tx = o.target[0] - (cam.right[0] / rl) * dx * wpp + (cam.up[0] / ul) * dy * wpp * k;
    const ty = o.target[1] - (cam.right[1] / rl) * dx * wpp + (cam.up[1] / ul) * dy * wpp * k;
    orbit = clampUserOrbit({ ...o, target: [tx, ty, o.target[2]] }, g);
    becomeCustom();
    markDirty();
  }

  function endBallDrag(): void {
    if (mode === 'ball' && drag) {
      const d = drag;
      drag = null;
      events.onBallDrag?.(d.id, d.pos, 'end');
      markDirty();
    }
    drag = null;
  }

  function onUp(e: PointerEvent): void {
    const p = ptrs.get(e.pointerId);
    if (!p) return;
    ptrs.delete(e.pointerId);
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    const wasMode = mode;
    if (wasMode === 'ball') endBallDrag();
    if (ptrs.size === 0) {
      mode = 'none';
      pinch = null;
    } else if (wasMode === 'pinch') {
      mode = 'none';
    }
    if (wasMode !== 'pending' || e.type === 'pointercancel') return;
    const moved = Math.hypot(e.clientX - p.sx, e.clientY - p.sy);
    if (moved >= TAP_MAX_PX || now() - p.t0 > TAP_MAX_MS) return;
    if (play) {
      skipPlayback();
      return;
    }
    const hit = pick(e.clientX, e.clientY);
    const empty = !hit || hit.kind === 'cloth';
    const t = now();
    if (empty && lastTap && lastTap.empty && t - lastTap.t < DOUBLE_TAP_MS && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) {
      lastTap = null;
      setCamera(lastPreset, true);
      return;
    }
    lastTap = { t, x: e.clientX, y: e.clientY, empty };
    events.onTap?.(hit, e);
  }

  function onWheel(e: WheelEvent): void {
    if (!g || !orbit) return;
    e.preventDefault();
    const k = e.ctrlKey ? 0.01 : 0.0015;
    const dyPx = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    becomeCustom();
    const o = currentOrbit();
    orbit = clampUserOrbit({ ...o, dist: o.dist * Math.exp(dyPx * k) }, g);
    markDirty();
  }

  const onContext = (e: Event) => e.preventDefault();
  const onLost = (e: Event) => {
    e.preventDefault();
    lost = true;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  };
  const onRestored = () => {
    lost = false;
    try {
      renderer.init();
      if (data) {
        renderer.setCloth(data.clothRgb);
        renderer.setHeatmap(data.heatmap);
        uploadRibbons(true);
      }
    } catch (err) {
      console.warn('CueSight 3D: context restore failed', err);
    }
    markDirty();
  };

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', onContext);
  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('webglcontextrestored', onRestored);

  // -------------------------------------------------------------------------------------------
  // API
  // -------------------------------------------------------------------------------------------
  function setCamera(p: CameraPreset, animate = true): void {
    const changed = preset !== p;
    preset = p;
    lastPreset = p;
    const o = presetOrbit(p);
    if (o) goTo(o, animate);
    syncLoop();
    if (changed) events.onCameraChange?.(p);
  }

  const api: Table3D = {
    canvas,
    setData,
    setCamera,
    getCamera: () => preset,
    playShot,
    stopPlayback: () => finishPlayback(),
    isPlaying: () => play !== null,
    pick,
    toScreen,
    resize,
    destroy(): void {
      if (destroyed) return;
      finishPlayback();
      destroyed = true;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      ro?.disconnect();
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('contextmenu', onContext);
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      renderer.dispose();
    },
    setInsets(ins): void {
      insetsPx = { top: ins.top ?? 0, right: ins.right ?? 0, bottom: ins.bottom ?? 0, left: ins.left ?? 0 };
      // Every preset frames itself in the free area (the Player view keeps the pocket clear of the controls).
      if (preset !== 'custom') {
        const o = presetOrbit(preset);
        if (o) goTo(o, true);
      }
      markDirty();
    },
    isAnimating: () => anim !== null && now() - anim.t0 < anim.dur,
  };
  return api;
}
