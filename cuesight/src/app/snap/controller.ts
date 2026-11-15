/**
 * Snap mode (feature 002 US2): the guided two-photo flow.
 *
 *  1. "Photograph the whole table" (camera still, or a photo from the library, or the bundled sample):
 *     the photo goes to the vision worker as a `still`; the detected layout appears on the 3D table
 *     (and over the photo), the player fixes it, then taps the target ball (+ an optional pocket) and
 *     gets the full shot card from the 001 planner.
 *  2. "Now crouch behind the cue ball": the table-level photo goes to the vision worker as
 *     `player-view`; with the camera pose the guide is drawn on the photo in perspective (aim line,
 *     ghost ball, object-ball path, pocket, and the strike dot on the cue ball's face) with the power
 *     and spin in words. When the fit fails, the reason is shown and two taps (cue ball, target ball)
 *     give the manual fallback.
 *
 * Photos are kept in memory only for this session and released on Start over / leaving Snap (FR-122);
 * a photo still decoding or loading then is dropped when it arrives.
 */
import { powerToSpeed, speedReference, speedWord } from '../../core/shot/power';
import type { Ball, PocketId, Vec2 } from '../../core/types';
import type { VisionResult } from '../../vision/pipeline';
import type { KnownBall, PlayerViewInput, PlayerViewResult } from '../../vision/player-view';
import { PROTOCOL_VERSION, type VisionOut } from '../../workers/protocol';
import { startCamera, stopCamera } from '../camera';
import { Overlay, type OverlayData } from '../render/overlay';
import { rgbCss } from '../render/palette';
import type { AppState } from '../store';
import { iconMarkup, type IconName } from '../ui/icons';
import { powerMeterSvg, powerText } from '../ui/power-meter';
import { spinBallSvg, spinText } from '../ui/spin-ball';
import { PhotoCanvas, drawGuide, drawTaps } from './draw';
import { buildPlayerGuide, confidenceLabel, guideFocus, playable, scaleFocal, strikeHeadline, strikeWords, unplayableHeadline, type PlayerGuide } from './guide';
import { decodePhoto, frameOf, loadSample, photoFromVideo, releasePhoto, type Photo } from './photo';
import { SNAP_MESSAGES, fitCheck, snapAimText, snapGuideInstruction, snapStage, visionFailedEvent, type SnapEvent, type SnapSession } from './session';

export const SAMPLE_PHOTOS = { table: './samples/snap-table.png', player: './samples/snap-player.png' } as const;

export interface SnapHost {
  state(): AppState;
  dispatch(e: SnapEvent): void;
  visionWorker(): Worker;
  toast(msg: string, ms?: number): void;
  selectBall(b: Ball): void;
  selectPocket(p: PocketId): void;
  /** Clear target/pocket/landing and re-plan (new layout). */
  resetSelection(): void;
  addBall(): void;
  removeBall(): void;
  toggleMarkCue(): void;
  expandSheet(): void;
  collapseSheet(): void;
  /** Re-measure the free stage area (the 3D table frames itself inside it). */
  layoutChanged(): void;
  /** Schedule a re-render (UI-only change). */
  refresh(): void;
  /** The pocket's name as the player sees it ("far right corner"). */
  pocketName?(id: PocketId): string;
  /** Pockets the shown stroke risks scratching in (from the recommendation's robustness probes). */
  riskPockets?(): PocketId[];
}

type Which = 'table' | 'player';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const btn = (id: string, text: string, ic: IconName, cls = 'secondary', extra = '') =>
  `<button type="button" class="btn ${cls}" data-act="${id}" ${extra}>${iconMarkup(ic, 18)}<span>${esc(text)}</span></button>`;
const iconBtn = (id: string, label: string, ic: IconName) => `<button type="button" class="icon-btn" data-act="${id}" aria-label="${esc(label)}" title="${esc(label)}">${iconMarkup(ic, 20)}</button>`;
const tool = (id: string, text: string, label: string, ic: IconName, extra = '') =>
  `<button type="button" class="tool" data-act="${id}" aria-label="${esc(label)}" title="${esc(label)}" ${extra}>${iconMarkup(ic, 22)}<span class="tool-label">${esc(text)}</span></button>`;

export function createSnapController(root: HTMLElement, host: SnapHost) {
  root.innerHTML = `
    <div class="snap-intro">
      <div class="snap-hero">
        <div>
          <h2 id="snap-title">Two photos.<br />One clear shot.</h2>
          <p class="lede">Photograph the table and pick your ball. Then crouch behind the cue ball and snap what you see: CueSight shows where to aim, where to strike and how hard.</p>
        </div>
        <ol class="steps">
          <li class="step"><span class="step-ic">${iconMarkup('image', 22)}</span><div><b>1 · The whole table</b><span>All four corners in view, from above or from the end.</span></div></li>
          <li class="step"><span class="step-ic">${iconMarkup('eye', 22)}</span><div><b>2 · Your view</b><span>At table level, behind the cue ball, facing the shot.</span></div></li>
        </ol>
        <div class="snap-actions">
          ${btn('take-table', 'Take photo', 'camera', 'primary', 'id="snap-take"')}
          ${btn('pick-table', 'Choose photo', 'image', 'secondary', 'id="snap-pick"')}
          <button type="button" class="btn ghost wide" data-act="sample">${iconMarkup('sparkles', 18)}<span>Try it with sample photos</span></button>
        </div>
        <p class="snap-note">${iconMarkup('lock', 16)}Photos stay on this device.</p>
      </div>
    </div>
    <header class="snap-top glass" id="snap-top">
      <div class="snap-top-row">
        <ol class="snap-progress" aria-label="Snap progress">
          <li class="sp-step" data-n="1"><span class="sp-dot" aria-hidden="true"></span><span class="sp-name">Table</span></li>
          <li class="sp-line" aria-hidden="true"></li>
          <li class="sp-step" data-n="2"><span class="sp-dot" aria-hidden="true"></span><span class="sp-name">Your view</span></li>
        </ol>
        <span class="snap-chip" id="snap-chip" hidden></span>
        <div class="snap-top-actions" id="snap-top-actions"></div>
      </div>
      <p class="snap-instr" id="snap-instr" role="status" aria-live="polite"></p>
      <button type="button" class="snap-notes" id="snap-notes" data-act="notes" aria-expanded="false" aria-controls="snap-warn" hidden></button>
      <ul class="snap-warn" id="snap-warn" hidden></ul>
      <div class="snap-cta" id="snap-cta"></div>
    </header>
    <div class="snap-photo" id="snap-photo">
      <canvas id="snap-canvas" aria-hidden="true"></canvas>
      <canvas id="snap-overlay" aria-label="Snap photo"></canvas>
      <span class="snap-fit" id="snap-fit" hidden></span>
      <div class="snap-busy" id="snap-busy" hidden><span class="spinner big" aria-hidden="true"></span><p></p></div>
      <button type="button" class="icon-btn snap-close" data-act="close-inspect" aria-label="Back to the table">${iconMarkup('close', 20)}</button>
      <button type="button" class="snap-zoom" data-act="zoom" aria-pressed="true" hidden>${iconMarkup('image', 16)}<span>Whole photo</span></button>
    </div>
    <div class="snap-cta-bar" id="snap-cta-bar"></div>
    <section class="snap-hud" id="snap-hud" aria-label="How to play it">
      <div class="hud-inset" data-mode="spin"><div class="hud-spin" id="hud-spin"></div></div>
      <div class="hud-body">
        <p class="hud-strike" id="hud-strike"></p>
        <div class="hud-power"><div class="power-meter" id="hud-meter" role="img"></div><div class="hud-power-txt"><span class="num" id="hud-power"></span><span id="hud-speed"></span></div></div>
        <p class="hud-aim" id="hud-aim"></p>
        <div class="hud-acts" id="hud-acts"></div>
      </div>
    </section>
    <div class="snap-dock" id="snap-dock" role="toolbar" aria-label="Fix the layout">
      <button type="button" class="tool snap-thumb" data-act="inspect" aria-label="Show the table photo with what was detected" title="Show the table photo"><canvas id="snap-thumb" aria-hidden="true"></canvas><span class="tool-label">Photo</span></button>
      ${tool('mark-cue', 'Cue ball', 'Tap the cue ball if it was not found', 'ball')}
      ${tool('add', 'Add', 'Add a ball', 'plus')}
      ${tool('remove', 'Remove', 'Remove the selected ball', 'minus')}
      ${tool('retake-table', 'Retake', 'Retake the table photo', 'camera')}
    </div>
    <input type="file" id="snap-file-table" accept="image/*" hidden />
    <input type="file" id="snap-file-table-cam" accept="image/*" capture="environment" hidden />
    <input type="file" id="snap-file-player" accept="image/*" hidden />
    <input type="file" id="snap-file-player-cam" accept="image/*" capture="environment" hidden />`;

  const $ = <T extends HTMLElement>(sel: string) => root.querySelector(sel) as T;
  const photoCanvas = new PhotoCanvas($<HTMLCanvasElement>('#snap-canvas'));
  const overlayCanvas = $<HTMLCanvasElement>('#snap-overlay');
  const overlay = new Overlay(overlayCanvas);
  const thumbCanvas = $<HTMLCanvasElement>('#snap-thumb');
  const busy = $<HTMLElement>('#snap-busy');
  const fitEl = $<HTMLElement>('#snap-fit');
  const top = $<HTMLElement>('#snap-top');
  const chip = $<HTMLElement>('#snap-chip');
  const instr = $<HTMLElement>('#snap-instr');
  const warnEl = $<HTMLElement>('#snap-warn');
  const notesBtn = $<HTMLButtonElement>('#snap-notes');
  let notesOpen = false;
  // The next action (Take photo / Choose…) lives at the bottom of the screen, in thumb reach while
  // crouched one-handed; the old slot in the top card stays empty.
  const cta = $<HTMLElement>('#snap-cta-bar');
  const zoomBtn = $<HTMLButtonElement>('.snap-zoom');
  let zoomed = true;
  const topActions = $<HTMLElement>('#snap-top-actions');
  const hudStrike = $<HTMLElement>('#hud-strike');
  const hudMeter = $<HTMLElement>('#hud-meter');
  const hudPower = $<HTMLElement>('#hud-power');
  const hudSpeed = $<HTMLElement>('#hud-speed');
  const hudAim = $<HTMLElement>('#hud-aim');
  const hudSpin = $<HTMLElement>('#hud-spin');
  const hudActs = $<HTMLElement>('#hud-acts');
  // The guide's "how to play it" lives at the top of the shot sheet (its peek on a phone, the top of
  // the side panel in landscape), so the photo gets the rest of the screen.
  const hudEl = $<HTMLElement>('#snap-hud');
  document.getElementById('sheet-body')?.prepend(hudEl);
  hudEl.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-hud-pocket]');
    if (b?.dataset.hudPocket) host.selectPocket(b.dataset.hudPocket as PocketId);
  });
  const files: Record<string, HTMLInputElement> = {
    'table': $('#snap-file-table'),
    'table-cam': $('#snap-file-table-cam'),
    'player': $('#snap-file-player'),
    'player-cam': $('#snap-file-player-cam'),
  };

  // Camera capture sheet (outside the view so it can cover the whole screen).
  const cam = document.createElement('div');
  cam.className = 'snap-cam';
  cam.hidden = true;
  cam.setAttribute('role', 'dialog');
  cam.setAttribute('aria-modal', 'true');
  cam.setAttribute('aria-label', 'Camera');
  cam.innerHTML = `
    <video playsinline muted autoplay></video>
    <div class="cam-frame" aria-hidden="true"></div>
    <p class="cam-hint glass"></p>
    <div class="cam-msg glass" hidden><p></p><div class="row">${btn('cam-pick', 'Choose photo', 'image', 'primary')}</div></div>
    <div class="cam-bar">
      <button type="button" class="icon-btn cam-close" data-act="cam-close" aria-label="Cancel">${iconMarkup('close', 22)}</button>
      <button type="button" class="cam-shutter" data-act="cam-shoot" aria-label="Take the photo"><span></span></button>
      <button type="button" class="icon-btn" data-act="cam-pick" aria-label="Choose from your photos">${iconMarkup('image', 22)}</button>
    </div>`;
  document.body.appendChild(cam);
  const camVideo = cam.querySelector('video')!;
  const camHint = cam.querySelector<HTMLElement>('.cam-hint')!;
  const camMsg = cam.querySelector<HTMLElement>('.cam-msg')!;
  let camWhich: Which = 'table';
  let camOpen = false;

  // Session-local data (pixels never enter the store).
  let overviewPhoto: Photo | null = null;
  let playerPhoto: Photo | null = null;
  /**
   * Photo intake generation (FR-122): every new photo and every Start over / leaving Snap starts a new
   * one. A photo that finishes decoding (or loading) after its generation ended belongs to a session
   * that is gone (or was replaced by a newer photo): it is released, never adopted.
   */
  let intake = 0;
  let rgbById = new Map<string, [number, number, number]>();
  /** The request in flight; a player-view fit remembers the target it is for and whether it came from taps. */
  let pending: { id: number; kind: 'still' | 'player-view'; targetId?: string | null; manual?: boolean } | null = null;
  let nextId = 1_000_000;
  let inspect = false;
  let lastDrawKey = '';
  let lastThumbKey = '';
  let guide: PlayerGuide | null = null;
  /** The layout the current player-photo fit was made against. */
  let fittedLayout = '';
  /** The target a quiet re-fit was last started for (see render, step 'guide'). */
  let refitFor: string | null = null;
  const S = () => host.state();
  const snap = (): SnapSession => S().snap;

  // -------------------------------------------------------------------------------------------
  // Photos in
  // -------------------------------------------------------------------------------------------
  function take(which: Which): void {
    if (typeof navigator.mediaDevices?.getUserMedia === 'function' && window.isSecureContext !== false) void openCamera(which);
    else files[`${which}-cam`]!.click();
  }
  function pick(which: Which): void {
    files[which]!.click();
  }
  for (const [key, input] of Object.entries(files)) {
    input.addEventListener('change', () => {
      const f = input.files?.[0];
      input.value = '';
      if (f) void onFile(key.startsWith('player') ? 'player' : 'table', f);
    });
  }

  async function onFile(which: Which, f: Blob): Promise<void> {
    const gen = ++intake;
    try {
      adopt(gen, which, await decodePhoto(f, 'library'));
    } catch {
      if (gen === intake) host.toast(SNAP_MESSAGES.decode);
    }
  }

  async function useSample(which: Which): Promise<void> {
    const gen = ++intake;
    try {
      adopt(gen, which, await loadSample(which === 'table' ? SAMPLE_PHOTOS.table : SAMPLE_PHOTOS.player));
    } catch {
      if (gen === intake) host.toast("The sample photos aren't available offline yet.");
    }
  }

  /** Takes a decoded photo into the session it was started in, or drops it when that session ended. */
  function adopt(gen: number, which: Which, p: Photo): void {
    if (gen !== intake || S().mode !== 'snap') return releasePhoto(p);
    if (which === 'table') setOverview(p);
    else setPlayer(p);
  }

  async function openCamera(which: Which): Promise<void> {
    camWhich = which;
    camOpen = true;
    cam.hidden = false;
    cam.dataset.which = which;
    camMsg.hidden = true;
    camHint.textContent = which === 'table' ? 'Fit all four corners of the cloth in the frame.' : 'Crouch behind the cue ball at table level, facing the shot. Keep the cue ball and the target in view.';
    document.body.classList.add('cam-open');
    try {
      await startCamera(camVideo);
      if (!camOpen) stopCamera(camVideo);
    } catch (e) {
      const name = (e as { name?: string })?.name ?? '';
      camMsg.hidden = false;
      camMsg.querySelector('p')!.textContent =
        name === 'NotAllowedError' || name === 'SecurityError'
          ? 'Camera access is off for CueSight. Choose a photo you took instead, or allow the camera in Settings.'
          : name === 'NotFoundError' || name === 'OverconstrainedError'
            ? 'No camera was found. Choose a photo instead.'
            : 'The camera could not start. Choose a photo instead.';
    }
  }
  function closeCamera(): void {
    camOpen = false;
    stopCamera(camVideo);
    cam.hidden = true;
    document.body.classList.remove('cam-open');
  }
  cam.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
    if (a === 'cam-close') closeCamera();
    else if (a === 'cam-pick') {
      closeCamera();
      pick(camWhich);
    } else if (a === 'cam-shoot') {
      const p = photoFromVideo(camVideo);
      if (!p) return;
      closeCamera();
      adopt(++intake, camWhich, p); // newer than any photo still decoding
    }
  });
  cam.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeCamera();
  });

  // -------------------------------------------------------------------------------------------
  // Vision requests
  // -------------------------------------------------------------------------------------------
  function setOverview(p: Photo): void {
    overviewPhoto = p;
    playerPhoto = null;
    guide = null;
    inspect = false;
    rgbById = new Map();
    host.dispatch({ type: 'overview-photo', photo: { width: p.width, height: p.height, source: p.source } });
    host.resetSelection();
    runStill(null);
  }

  function runStill(corners: Vec2[] | null): void {
    if (!overviewPhoto) return;
    const frame = frameOf(overviewPhoto);
    const id = ++nextId;
    pending = { id, kind: 'still' };
    // Snap's own settings, never Live's: the corners tapped on this photo (or none), and no rail swap
    // (Live's "Rotate" fixes the live camera's view; a still is detected from the photo alone). The
    // field of view in Settings is the lens hint for this photo too (StillOptions.fovDeg).
    host.visionWorker().postMessage({ v: PROTOCOL_VERSION, type: 'still', id, frame, opts: { manualCorners: corners, swapAxes: false, fovDeg: S().settings.fovDeg } }, [frame.data.buffer]);
  }

  function knownBalls(): KnownBall[] {
    return (snap().layout ?? []).map((b) => {
      const rgb = rgbById.get(b.id);
      return { id: b.id, pos: b.pos, isCue: b.kind === 'cue', ...(rgb ? { rgb } : {}) };
    });
  }

  function setPlayer(p: Photo): void {
    const s = S();
    const cue = snap().layout?.find((b) => b.kind === 'cue');
    const why = !snap().layout || !cue ? SNAP_MESSAGES.noCue : !s.targetId || !s.plan ? 'Pick the ball you want to pocket first.' : null;
    if (why) {
      releasePhoto(p); // not taken: nothing keeps its pixels
      return host.toast(why);
    }
    playerPhoto = p;
    guide = null;
    inspect = false;
    host.dispatch({ type: 'player-photo', photo: { width: p.width, height: p.height, source: p.source } });
    host.collapseSheet();
    runPlayerView();
  }

  /** Posts the player-view fit; false when there is nothing to fit (no photo, layout or cue ball). */
  function runPlayerView(taps?: { cue: Vec2; target: Vec2 }): boolean {
    const s = S();
    const sn = snap();
    if (!playerPhoto || !sn.layout) return false;
    const cue = sn.layout.find((b) => b.kind === 'cue');
    if (!cue) {
      host.toast(SNAP_MESSAGES.noCue);
      return false;
    }
    const vis = sn.overview?.vision;
    const frame = frameOf(playerPhoto);
    const input: PlayerViewInput = {
      frame,
      table: s.table,
      balls: knownBalls(),
      cueId: cue.id,
      ...(s.targetId ? { targetId: s.targetId } : {}),
      // Same phone for both photos (the usual case): the overview's focal length is a strong prior.
      ...(vis?.calibration && vis.calibration.focalSource === 'estimated' && overviewPhoto ? { focalPx: scaleFocal(vis.calibration.focal, overviewPhoto, playerPhoto) } : {}),
      ...(vis?.cloth ? { clothHint: vis.cloth } : {}),
      ...(taps ? { manualTaps: taps } : {}),
    };
    const id = ++nextId;
    pending = { id, kind: 'player-view', targetId: s.targetId, manual: !!taps };
    fittedLayout = layoutKey(sn.layout);
    host.visionWorker().postMessage({ v: PROTOCOL_VERSION, type: 'player-view', id, input }, [frame.data.buffer]);
    return true;
  }

  /** Vision replies addressed to Snap; returns false when the message is not ours. */
  function onVision(m: VisionOut): boolean {
    if (m.type === 'result') return false;
    if (m.type === 'error') {
      if (m.id === undefined || !pending || m.id !== pending.id) return m.id !== undefined && m.id > 1_000_000;
      const kind = pending.kind;
      pending = null;
      console.warn('snap vision error', m.message);
      // Detection itself failed on this photo (not "no table"): say that, with the ways on.
      host.dispatch(kind === 'still' ? { type: 'overview-failed', message: SNAP_MESSAGES.detectionStopped } : { type: 'player-failed', message: "I couldn't line up this photo. Tap the cue ball, then your target." });
      return true;
    }
    if (!pending || m.id !== pending.id) return true; // stale reply for an older photo
    const req = pending;
    pending = null;
    if (m.type === 'still') onStill(m.result);
    else onPlayerView(m.result, req.targetId ?? null, !!req.manual);
    return true;
  }

  /**
   * The vision worker failed (did not load, crashed): the request waiting on it will never be answered,
   * so it fails now instead of spinning. The next photo or tap creates a new worker (host.visionWorker).
   * `loaded`: the failed worker had answered at least once.
   */
  function visionFailed(loaded: boolean): void {
    if (!pending) return;
    const kind = pending.kind;
    pending = null;
    host.dispatch(visionFailedEvent(kind, loaded));
  }

  function onStill(r: VisionResult): void {
    rgbById = new Map(r.balls.map((b) => [b.id, b.rgb]));
    const balls: Ball[] = r.balls.map((b) => ({
      id: b.id,
      kind: b.isCue ? 'cue' : 'object',
      pos: b.pos,
      label: b.isCue ? 'cue' : b.label,
      color: rgbCss(b.rgb),
      stripe: b.label.includes('stripe'),
      confidence: b.confidence,
    }));
    host.dispatch({ type: 'overview-result', vision: r, balls });
    host.resetSelection();
    if (snap().step === 'review') {
      // The top card already says what to do next (and the chip how many balls were found): a toast
      // repeating it covered the bottom rail and pockets.
      if (!balls.length) host.toast(SNAP_MESSAGES.noBalls, 3200);
      host.layoutChanged();
    }
  }

  function onPlayerView(r: PlayerViewResult, targetId: string | null, manual: boolean): void {
    refitFor = null;
    host.dispatch({ type: 'player-result', result: r, targetId, manual });
  }

  // -------------------------------------------------------------------------------------------
  // Interaction
  // -------------------------------------------------------------------------------------------
  root.addEventListener('click', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!el || !root.contains(el) || (el as HTMLButtonElement).disabled) return;
    switch (el.dataset.act) {
      case 'take-table':
      case 'retake-table':
        return take('table');
      case 'pick-table':
        return pick('table');
      case 'sample':
        return void useSample('table');
      case 'take-player':
        return take('player');
      case 'pick-player':
        return pick('player');
      case 'sample-player':
        return void useSample('player');
      case 'corners':
        inspect = false;
        return host.dispatch({ type: 'start-corners' });
      case 'cancel-corners':
        return host.dispatch({ type: 'cancel-corners' });
      case 'start-over':
        return startOver();
      case 'edit-layout':
        inspect = false;
        host.dispatch({ type: 'edit-layout' });
        return host.layoutChanged();
      case 'back-to-guide': {
        if (!playerPhoto) return;
        // The fit used the layout as it was; if the player fixed the layout since, fit again.
        if (layoutKey(snap().layout) !== fittedLayout) {
          host.dispatch({ type: 'player-photo', photo: { width: playerPhoto.width, height: playerPhoto.height, source: playerPhoto.source } });
          return runPlayerView();
        }
        return host.dispatch({ type: 'back-to-guide' });
      }
      case 'manual':
        return host.dispatch({ type: 'start-manual' });
      case 'retry-auto':
        host.dispatch({ type: 'player-photo', photo: { width: playerPhoto!.width, height: playerPhoto!.height, source: playerPhoto!.source } });
        return runPlayerView();
      case 'inspect':
        inspect = !inspect;
        lastDrawKey = '';
        return host.refresh();
      case 'close-inspect':
        inspect = false;
        lastDrawKey = '';
        return host.refresh();
      case 'mark-cue':
        return host.toggleMarkCue();
      case 'add':
        return host.addBall();
      case 'remove':
        return host.removeBall();
      case 'show-card':
        return host.expandSheet();
      case 'zoom':
        zoomed = !zoomed;
        lastDrawKey = '';
        return host.refresh();
      case 'notes':
        notesOpen = !notesOpen;
        return host.refresh();
    }
  });

  overlayCanvas.addEventListener('click', (e) => {
    const sn = snap();
    if (sn.step === 'corners') {
      const p = photoCanvas.toPhoto(e.clientX, e.clientY);
      if (!p) return;
      host.dispatch({ type: 'corner-tap', p });
      const after = snap();
      if (after.step === 'overview-processing' && after.corners) runStill(after.corners);
      return;
    }
    if (sn.step === 'manual-taps') {
      const p = photoCanvas.toPhoto(e.clientX, e.clientY);
      if (!p) return;
      host.dispatch({ type: 'manual-tap', p });
      const after = snap();
      if (after.step === 'player-processing' && after.taps.cue && after.taps.target) runPlayerView({ cue: after.taps.cue, target: after.taps.target });
      return;
    }
    if (sn.step === 'review' && inspect) {
      const r = overlayCanvas.getBoundingClientRect();
      const hit = Overlay.hitTest({ x: e.clientX - r.left, y: e.clientY - r.top }, overlayData(), photoCanvas.map);
      if (hit.ball) host.selectBall(hit.ball);
      else if (hit.pocket) host.selectPocket(hit.pocket);
    }
  });

  function startOver(): void {
    intake++; // a photo still decoding now belongs to an ended session
    for (const p of [overviewPhoto, playerPhoto]) if (p) releasePhoto(p);
    overviewPhoto = null;
    playerPhoto = null;
    guide = null;
    inspect = false;
    root.dataset.inspect = 'false';
    pending = null;
    rgbById = new Map();
    releasePixels();
    host.dispatch({ type: 'reset' });
    host.resetSelection();
  }

  /**
   * FR-122: drops every copy of the photos' pixels the page still holds, at once (not on the next
   * render, which never comes after leaving Snap): the photo canvas and its reference, the detection
   * overlay and the table-photo thumbnail. A zero-size canvas also frees its backing store.
   */
  function releasePixels(): void {
    photoCanvas.photo = null;
    photoCanvas.focus = null;
    for (const c of [photoCanvas.canvas, overlayCanvas, thumbCanvas]) {
      c.width = 0;
      c.height = 0;
    }
    lastDrawKey = '';
    lastThumbKey = '';
  }

  /** Leaving Snap: release every photo (FR-122). */
  function leave(): void {
    if (camOpen) closeCamera();
    startOver();
  }

  // -------------------------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------------------------
  function overlayData(): OverlayData {
    const s = S();
    return {
      table: s.table,
      calibration: snap().overview?.vision?.calibration ?? null,
      balls: snap().layout ?? [],
      plan: s.plan,
      targetId: s.targetId,
      pocketId: s.pocketId,
      calibTaps: snap().step === 'corners' ? snap().cornerTaps : [],
      showPlan: true,
    };
  }

  function setChip(text: string | null, tone: 'ok' | 'warn' | 'bad' | 'info' = 'info', ic: IconName = 'check'): void {
    chip.hidden = !text;
    if (!text) return;
    chip.dataset.tone = tone;
    const key = `${tone}|${text}`;
    if (chip.dataset.key !== key) {
      chip.dataset.key = key;
      chip.innerHTML = `${iconMarkup(ic, 14)}<span>${esc(text)}</span>`;
    }
  }
  function setHtml(el: HTMLElement, html: string): void {
    if (el.dataset.html !== html) {
      el.dataset.html = html;
      el.innerHTML = html;
    }
  }
  /** Writes only on change (the HUD is refreshed on every render). */
  function setText(el: HTMLElement, text: string): void {
    if (el.textContent !== text) el.textContent = text;
  }
  function setAttr(el: HTMLElement, name: string, value: string): void {
    if (el.getAttribute(name) !== value) el.setAttribute(name, value);
  }
  function setInstr(text: string, ic: IconName = 'info', tone: 'info' | 'warn' = 'info'): void {
    setHtml(instr, text ? `${iconMarkup(ic, 18)}<span>${esc(text)}</span>` : '');
    instr.dataset.tone = tone;
  }

  /**
   * Publishes the top card's and the HUD's heights as CSS variables, synchronously, so the photo and the
   * 3D table are laid out for this render (no one-frame lag). Returns true when a height changed.
   */
  let heights = '';
  function syncHeights(): boolean {
    const hud = hudEl;
    const th = Math.round(top.getBoundingClientRect().height);
    const hh = Math.round(hud.getBoundingClientRect().height);
    const key = `${th},${hh}`;
    if (key === heights) return false;
    heights = key;
    const rs = document.documentElement.style;
    if (th > 0) rs.setProperty('--snap-top-h', `${th}px`);
    if (hh > 0) rs.setProperty('--snap-hud-h', `${hh}px`);
    host.layoutChanged();
    return true;
  }

  function render(s: AppState): void {
    const sn = s.snap;
    const step = sn.step;
    root.dataset.step = step;
    root.dataset.inspect = String(inspect && step === 'review');
    const stage = snapStage(step);
    root.querySelectorAll<HTMLElement>('.sp-step').forEach((li) => {
      const n = Number(li.dataset.n);
      const state = n < stage || (n === 1 && step === 'review' && !!s.plan) ? 'done' : n === stage ? 'active' : 'todo';
      li.dataset.state = state;
      if (state === 'active') li.setAttribute('aria-current', 'step');
      else li.removeAttribute('aria-current');
      const dot = li.querySelector<HTMLElement>('.sp-dot')!;
      setHtml(dot, state === 'done' ? iconMarkup('check', 14) : String(n));
    });

    const warnings: string[] = [];
    let fit: { word: ReturnType<typeof confidenceLabel>['word'] | 'checking'; text: string } | null = null;
    let ctaHtml = '';
    let actions = iconBtn('start-over', 'Start over', 'refresh');
    let busyText = '';
    const vis = sn.overview?.vision;
    const layout = sn.layout ?? [];
    const hasCue = layout.some((b) => b.kind === 'cue');
    switch (step) {
      case 'intro':
        setChip(null);
        setInstr('');
        actions = '';
        break;
      case 'overview-processing':
        setChip(null);
        setInstr('Finding the table and the balls…', 'sparkles');
        busyText = 'Finding the table and the balls…';
        break;
      case 'overview-error':
        setChip(null);
        setInstr(sn.error ?? SNAP_MESSAGES.noTable, 'alert', 'warn');
        ctaHtml = btn('corners', 'Tap the 4 corners', 'crosshair', 'primary');
        actions = iconBtn('retake-table', 'Retake the table photo', 'camera') + iconBtn('pick-table', 'Choose another photo', 'image') + iconBtn('start-over', 'Start over', 'refresh');
        break;
      case 'corners':
        setChip(`Corner ${Math.min(4, sn.cornerTaps.length + 1)} of 4`, 'info', 'crosshair');
        setInstr('Tap the four corners where the cloth meets the rails, in any order.', 'crosshair');
        ctaHtml = btn('cancel-corners', 'Cancel', 'close');
        break;
      case 'review': {
        const q = vis?.quality ?? 0;
        setChip(`${layout.length} ball${layout.length === 1 ? '' : 's'} · ${vis?.calibration?.source === 'manual' ? 'your corners' : q >= 0.8 ? 'good' : q >= 0.55 ? 'fair' : 'check it'}`, q >= 0.55 || vis?.calibration?.source === 'manual' ? 'ok' : 'warn', q >= 0.55 ? 'check' : 'alert');
        if (inspect) setInstr('Tap a ball on the photo to pick it. Close the photo to fix the layout on the table.', 'hand');
        else if (!hasCue) setInstr(SNAP_MESSAGES.noCue, 'alert', 'warn');
        else if (s.interaction === 'mark-cue') setInstr('Tap the cue ball.', 'ball');
        else if (!s.targetId) setInstr('Check the layout (drag a ball to fix it), then tap the ball you want to pocket.', 'hand');
        else if (!s.plan) setInstr('Waiting for the plan…', 'sparkles');
        else {
          setInstr('Now crouch behind the cue ball at table level, facing the shot, and take a photo.', 'eye');
          ctaHtml =
            btn('take-player', 'Take photo', 'camera', 'primary', 'id="snap-take-player" aria-label="Take the player-view photo"') +
            btn('pick-player', sn.overview?.source === 'sample' || (sn.player?.result && playerPhoto) ? 'Choose' : 'Choose photo', 'image', 'secondary', 'id="snap-pick-player" aria-label="Choose the player-view photo"');
          if (sn.player?.result && playerPhoto) ctaHtml += btn('back-to-guide', 'Your view', 'eye', 'ghost', 'aria-label="Back to the guide on your photo"');
          else if (sn.overview?.source === 'sample') ctaHtml += btn('sample-player', 'Sample', 'sparkles', 'ghost', 'aria-label="Use the sample player-view photo"');
        }
        if (sn.error && !inspect) warnings.push(sn.error);
        break;
      }
      case 'player-processing':
        setChip(null);
        setInstr('Lining up your photo with the table…', 'sparkles');
        busyText = 'Lining up your view…';
        break;
      case 'guide': {
        const r = sn.player?.result;
        setChip(null);
        // The fit's confidence is about the target it was made for (FR-116): a new target is fitted
        // again on the same photo (quietly, the guide stays up), or, after a two-tap fit, tapped again.
        const fc = fitCheck(sn, s.targetId);
        if (fc === 'refit' && !pending && refitFor !== s.targetId) {
          refitFor = s.targetId; // one attempt per target change (never a retry loop from render)
          if (runPlayerView()) host.dispatch({ type: 'refit' });
        } else if (fc === 'taps') host.dispatch({ type: 'start-manual' });
        fit = fc === 'current' ? confidenceLabel(r?.confidence ?? 0) : fc === 'checking' ? { word: 'checking', text: 'Fit: checking…' } : null;
        // The how-to (strike, power, aim) is in the sheet's peek right under the photo: the top card
        // is one row, so the photo gets the screen.
        // A frozen cue ball has no ghost ball: aim the stroke (the planner's frozen warning and tip).
        setInstr(s.plan ? (playable(s.plan) ? snapGuideInstruction(s.plan, strikeWords) : 'This shot cannot be played as planned.') : 'Pick a target ball to see the guide.', 'target');
        if (r?.reason) warnings.push(r.reason);
        if (guide) warnings.push(...guide.messages);
        actions = iconBtn('take-player', 'New player photo', 'camera') + iconBtn('edit-layout', 'Edit the layout', 'layers') + iconBtn('start-over', 'Start over', 'refresh');
        break;
      }
      case 'manual-taps': {
        setChip(null);
        const tl = s.targetId ? (sn.layout?.find((b) => b.id === s.targetId)?.label ?? '') : '';
        const tname = !tl ? 'target ball' : /^\d+$/.test(tl) ? `${tl}-ball (your target)` : `${tl} ball (your target)`;
        const tapText = !sn.taps.cue ? 'Tap the centre of the cue ball in your photo.' : `Now tap the centre of the ${tname}.`;
        setInstr(tapText, 'hand');
        if (sn.error) warnings.push(`${sn.error} Next time, include a rail or a pocket and the target ball in the photo.`);
        actions = iconBtn('take-player', 'Retake the player-view photo', 'camera') + iconBtn('pick-player', 'Choose another player-view photo', 'image') + iconBtn('edit-layout', 'Edit the layout', 'layers') + iconBtn('start-over', 'Start over', 'refresh');
        break;
      }
    }
    setHtml(topActions, actions);
    setHtml(cta, ctaHtml);
    syncHeights();
    setHtml(warnEl, warnings.map((w) => `<li class="warn-chip">${iconMarkup('alert', 16)}<span>${esc(w)}</span></li>`).join(''));
    // In the guide, notes about the photo fold into one banner (tap to read), so they never squeeze it.
    const fold = step === 'guide' && warnings.length > 0;
    if (!fold) notesOpen = false;
    notesBtn.hidden = !fold;
    if (fold) {
      setHtml(notesBtn, `${iconMarkup('alert', 16)}<span>${warnings.length} note${warnings.length === 1 ? '' : 's'} about this photo</span>${iconMarkup(notesOpen ? 'chevron-up' : 'chevron-down', 16, 'chev')}`);
      notesBtn.setAttribute('aria-expanded', String(notesOpen));
    }
    warnEl.hidden = warnings.length === 0 || (fold && !notesOpen);
    busy.hidden = !busyText;
    if (busyText) busy.querySelector('p')!.textContent = busyText;
    // Dock state.
    const dock = root.querySelector<HTMLElement>('#snap-dock')!;
    dock.querySelector('[data-act="mark-cue"]')?.setAttribute('aria-pressed', String(s.interaction === 'mark-cue'));
    dock.querySelector('[data-act="inspect"]')?.setAttribute('aria-pressed', String(inspect));
    drawStage(s);
    // Every render: the plan can change without a redraw of the photo (the worker's power advice).
    renderHud(s, guide);
    drawThumb(s);
    // Fit confidence (FR-116): a chip on the photo's top-left corner.
    const pr = fit ? photoCanvas.photoRect() : null;
    fitEl.hidden = !fit || !pr;
    if (fit && pr) {
      fitEl.dataset.tone = fit.word === 'good' ? 'ok' : fit.word === 'fair' ? 'warn' : fit.word === 'checking' ? 'info' : 'bad';
      setHtml(fitEl, `${iconMarkup(fit.word === 'good' ? 'check' : fit.word === 'checking' ? 'sparkles' : 'alert', 14)}<span>${esc(fit.text)}</span>`);
      fitEl.style.left = `${Math.round(pr.x + 8)}px`;
      fitEl.style.top = `${Math.round(pr.y + 8)}px`;
    }
    // The photo check's close button sits on the photo's own corner, not above the letterbox.
    const closeBtn = root.querySelector<HTMLElement>('.snap-close')!;
    const cr = inspect && step === 'review' ? photoCanvas.photoRect() : null;
    if (cr) {
      closeBtn.style.top = `${Math.round(cr.y + 8)}px`;
      closeBtn.style.left = `${Math.round(cr.x + cr.w - 52)}px`;
      closeBtn.style.right = 'auto';
    } else {
      closeBtn.style.removeProperty('top');
      closeBtn.style.removeProperty('left');
      closeBtn.style.removeProperty('right');
    }
  }

  function photoFor(step: SnapSession['step']): Photo | null {
    if (step === 'player-processing' || step === 'guide' || step === 'manual-taps') return playerPhoto;
    if (step === 'overview-processing' || step === 'overview-error' || step === 'corners' || (step === 'review' && inspect)) return overviewPhoto;
    return null;
  }

  function drawStage(s: AppState): void {
    const sn = s.snap;
    const photo = photoFor(sn.step);
    const r = photoCanvas.canvas.getBoundingClientRect();
    const key = [sn.step, inspect, zoomed, photo ? `${photo.width}x${photo.height}:${photo === playerPhoto ? 'p' : 'o'}` : '-', Math.round(r.width), Math.round(r.height), s.plan ? `${s.plan.targetId}>${s.plan.pocketId}:${s.plan.stroke.side},${s.plan.stroke.vert},${s.plan.stroke.power}:${s.plan.ghost.x.toFixed(4)},${s.plan.ghost.y.toFixed(4)}` : 'noplan', s.targetId, s.pocketId, sn.cornerTaps.length, JSON.stringify(sn.taps), sn.player?.result?.ms ?? 0, layoutKey(sn.layout)].join('|');
    if (key === lastDrawKey) return;
    lastDrawKey = key;
    photoCanvas.photo = photo;
    guide = null;
    const processing = sn.step === 'overview-processing' || sn.step === 'player-processing';
    if (!photo || r.width < 2 || r.height < 2) {
      photoCanvas.draw();
      clearOverlay();
      return;
    }
    if (sn.step === 'guide' && s.plan && sn.player?.result?.pose && sn.layout) {
      const cue = sn.layout.find((b) => b.kind === 'cue');
      const tgt = sn.layout.find((b) => b.id === s.plan!.targetId);
      if (cue) {
        // Every other ball can hide part of a line from the camera: that part is drawn dashed, marked "hidden".
        const others = sn.layout.filter((b) => b !== cue && b !== tgt).map((b) => b.pos);
        guide = buildPlayerGuide({ pose: sn.player.result.pose, table: s.table, plan: s.plan, cue: cue.pos, target: tgt?.pos ?? null, stroke: s.plan.stroke, riskPockets: host.riskPockets?.() ?? [], others });
      }
    }
    const g = guide;
    // Zoom onto the shot (cue ball, ghost, target, pocket) so the balls are big enough to read.
    photoCanvas.focus = g && zoomed && photo ? guideFocus(g, photo.width, photo.height) : null;
    // The table photo check: zoom onto the detected table (its corners), not the room around it.
    const corners = sn.overview?.vision?.calibration?.corners;
    if (!g && photo === overviewPhoto && sn.step === 'review' && inspect && corners?.length) {
      const xs = corners.map((p) => p.x);
      const ys = corners.map((p) => p.y);
      photoCanvas.focus = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
    }
    zoomBtn.hidden = !g;
    zoomBtn.setAttribute('aria-pressed', String(zoomed));
    zoomBtn.querySelector('span')!.textContent = zoomed ? 'Whole photo' : 'Zoom to shot';
    zoomBtn.setAttribute('aria-label', zoomed ? 'Show the whole photo' : 'Zoom to the shot');
    const st = s.plan?.stroke;
    const note = st ? `${st.power.toFixed(st.power % 1 ? 1 : 0)}/10 ${speedWord(st.power)}` : undefined;
    // Labels keep clear of the zoom button floating over the photo.
    const zb = zoomBtn.getBoundingClientRect();
    const avoidRects = g && zb.width > 0 ? [{ left: zb.left - r.left - 4, top: zb.top - r.top - 4, right: zb.right - r.left + 4, bottom: zb.bottom - r.top + 4 }] : [];
    // ... and of the fit-confidence pill in the photo's top-left corner.
    if (g) {
      const fr = fitEl.hidden ? null : fitEl.getBoundingClientRect();
      avoidRects.push(fr && fr.width > 0 ? { left: fr.left - r.left - 4, top: fr.top - r.top - 4, right: fr.right - r.left + 4, bottom: fr.bottom - r.top + 4 } : { left: 0, top: 0, right: 176, bottom: 50 });
    }
    photoCanvas.draw(
      g
        ? (c, m) => drawGuide(c, m, g, { showCuePath: true, makeable: s.plan ? playable(s.plan) : true, clip: photoCanvas.photoRect(), avoidRects, ...(note ? { strikeNote: note } : {}) })
        : sn.step === 'manual-taps'
          ? (c, m) => drawTaps(c, m, sn.taps)
          : undefined,
      processing ? 0.35 : 0,
    );
    // The overview photo gets the 001 AR overlay (outline, pockets, balls, plan).
    const showOverlay = photo === overviewPhoto && !processing;
    // Detection rings stay on the photo (never over the letterbox).
    const pr = photoCanvas.photoRect();
    overlayCanvas.style.clipPath = pr ? `inset(${Math.max(0, pr.y)}px ${Math.max(0, r.width - pr.x - pr.w)}px ${Math.max(0, r.height - pr.y - pr.h)}px ${Math.max(0, pr.x)}px round 14px)` : '';
    if (showOverlay) {
      overlay.draw(overlayData(), photoCanvas.map);
    } else clearOverlay();
  }

  function clearOverlay(): void {
    const c = overlayCanvas.getContext('2d')!;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  }

  function renderHud(s: AppState, g: PlayerGuide | null): void {
    const plan = s.plan;
    if (!plan || s.snap.step !== 'guide') return;
    const st = plan.stroke;
    hudEl.classList.toggle('unplayable', !playable(plan));
    if (!playable(plan)) {
      // No strike point, no power: the reason, and what to try instead.
      const u = unplayableHeadline(plan);
      setText(hudStrike, u.title);
      setText(hudAim, u.reason);
      setHtml(hudMeter, '');
      setHtml(hudPower, '');
      setText(hudSpeed, '');
      setHtml(hudSpin, `<span class="hud-no">${iconMarkup('alert', 40)}</span>`);
      setAttr(hudSpin, 'aria-label', u.title);
      const alt = u.altPocketId;
      setHtml(hudActs, alt ? `<button type="button" class="btn primary" data-hud-pocket="${esc(alt)}">${iconMarkup('target', 18)}<span>Try the ${esc(host.pocketName?.(alt) ?? alt)}</span></button>` : '');
      return;
    }
    setHtml(hudActs, '');
    setText(hudStrike, strikeHeadline(st, strikeWords));
    // No minimum on the meter when none is known yet (the worker's power advice is on its way) or when
    // no power works with this tip (minPower 10.5 is then not "more than full power": the warning says why).
    const minPower = Number.isFinite(plan.minPower) && !plan.noWorkingPower && !plan.adviceSkipped ? plan.minPower : null;
    setAttr(hudMeter, 'aria-label', powerText(st.power, minPower));
    setHtml(hudMeter, powerMeterSvg(st.power, minPower));
    setHtml(hudPower, `${esc(st.power.toFixed(st.power % 1 ? 1 : 0))}<small>/10</small>`);
    const ref = speedReference(plan.obPocketSpeed, s.table.length, s.params);
    setText(hudSpeed, ref ? `${speedWord(st.power)} · ${ref}` : `${speedWord(st.power)} · ${powerToSpeed(st.power).toFixed(1)} m/s`);
    const layout = s.snap.layout ?? [];
    setText(hudAim, snapAimText(plan, layout.find((b) => b.kind === 'cue')?.pos ?? null, layout.find((b) => b.id === plan.targetId)?.pos ?? null));
    // The cue ball's face, drawn flat as coaches do (never a photo crop: from a raised camera a
    // high strike point lands below the visible centre and reads as the opposite instruction).
    void g;
    setAttr(hudSpin, 'role', 'img');
    setAttr(hudSpin, 'aria-label', spinText(st.side, st.vert));
    setHtml(hudSpin, spinBallSvg(st.side, st.vert, 72, 'hud'));
  }

  function drawThumb(s: AppState): void {
    if (s.snap.step !== 'review' || !overviewPhoto) return;
    const r = thumbCanvas.getBoundingClientRect();
    const key = `${overviewPhoto.width}x${overviewPhoto.height}|${Math.round(r.width)}x${Math.round(r.height)}|${layoutKey(s.snap.layout)}`;
    if (key === lastThumbKey || r.width < 2) return;
    lastThumbKey = key;
    const dpr = Math.min(3, globalThis.devicePixelRatio || 1);
    thumbCanvas.width = Math.round(r.width * dpr);
    thumbCanvas.height = Math.round(r.height * dpr);
    const c = thumbCanvas.getContext('2d')!;
    const sc = Math.max(thumbCanvas.width / overviewPhoto.width, thumbCanvas.height / overviewPhoto.height);
    const w = overviewPhoto.width * sc;
    const h = overviewPhoto.height * sc;
    c.drawImage(overviewPhoto.canvas, (thumbCanvas.width - w) / 2, (thumbCanvas.height - h) / 2, w, h);
  }

  function layoutKey(balls: Ball[] | null): string {
    return (balls ?? []).map((b) => `${b.id}:${b.kind[0]}:${Math.round(b.pos.x * 500)},${Math.round(b.pos.y * 500)}`).join(';');
  }

  // Keep the stage measurements fresh (the 3D table frames itself between the top card and the dock).
  const hud = hudEl;
  const measure = () => {
    if (syncHeights()) host.refresh();
  };
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(measure);
    ro.observe(top);
    ro.observe(hud);
    ro.observe(cta);
  }

  return {
    render,
    onVision,
    visionFailed,
    leave,
    take,
    pick,
    useSample,
    isBusy: () => pending !== null,
    /** For tests: photo px → page px on the visible Snap photo. */
    photoToScreen: (p: Vec2) => photoCanvas.toClient(p),
    guide: () => guide,
    photos: () => ({ overview: overviewPhoto ? { width: overviewPhoto.width, height: overviewPhoto.height } : null, player: playerPhoto ? { width: playerPhoto.width, height: playerPhoto.height } : null }),
    /** The free stage rect between the top card and the dock (client px), for the 3D insets. */
    stageBounds(): { top: number; bottom: number } | null {
      const dock = root.querySelector<HTMLElement>('#snap-dock')!;
      const t = top.getBoundingClientRect();
      const d = dock.getBoundingClientRect();
      const b = cta.getBoundingClientRect();
      if (t.height < 1 && d.height < 1) return null;
      let bottom = d.height > 0 ? d.top : root.getBoundingClientRect().bottom;
      if (b.height > 0) bottom = Math.min(bottom, b.top);
      return { top: t.bottom, bottom };
    },
  };
}

export type SnapController = ReturnType<typeof createSnapController>;
