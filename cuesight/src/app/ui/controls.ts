/**
 * Toolbar, stroke controls (power slider + spin pad + presets), suggestions list and settings sheet.
 * Built once; `update*` functions refresh values without recreating interactive elements.
 */
import type { PocketId, ShotSuggestion, Stroke, TablePresetId } from '../../core/types';
import { TABLE_PRESETS } from '../../core/table';
import { parseSettingsForm, SETTING_LIMITS, type Settings } from '../settings';
import type { AppState } from '../store';
import { DRILLS } from '../drills';
import { iconMarkup, type IconName } from './icons';
import { writeHtml } from './patch';
import { ballChip, marginText } from './shot-card';
import { createSpinPad } from './spin-pad';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export interface ToolbarActions {
  freeze(): void;
  calibrate(): void;
  swapAxes(): void;
  markCue(): void;
  suggest(): void;
  position(): void;
  zones(): void;
  clear(): void;
  addBall(): void;
  removeBall(): void;
  drill(id: string): void;
}

function button(label: string, action: string, title: string, ic: IconName): string {
  return `<button type="button" class="tool" data-action="${action}" title="${title}" aria-label="${title}">${iconMarkup(ic, 22)}<span class="tool-label">${label}</span></button>`;
}

export function buildToolbar(el: HTMLElement, actions: ToolbarActions) {
  // Phones show the primary tools and a More menu (the rest); wider screens show everything inline.
  el.innerHTML = `
    <div class="tools camera-only" role="group" aria-label="Camera tools">
      ${button('Freeze', 'freeze', 'Freeze the detected layout', 'snowflake')}
    </div>
    <div class="tools practice-only" role="group" aria-label="Practice table tools">
      <label class="drill tool" title="Practice layout">${iconMarkup('list', 22)}<span class="tool-label">Drill</span>
        <select data-action="drill" aria-label="Practice layout">${DRILLS.map((d) => `<option value="${d.id}">${d.name}</option>`).join('')}</select></label>
    </div>
    <div class="tools shared" role="group" aria-label="Shot tools">
      ${button('Suggest', 'suggest', 'Suggest the best shots', 'sparkles')}
      ${button('Position', 'position', 'Tap where the cue ball should stop', 'target')}
    </div>
    <button type="button" class="tool tool-more" aria-expanded="false" aria-controls="tools-more" title="More tools" aria-label="More tools">${iconMarkup('more', 22)}<span class="tool-label">More</span></button>
    <div class="tools more" id="tools-more" role="group" aria-label="More tools">
      <span class="camera-only">${button('Calibrate', 'calibrate', 'Tap the four corners of the cloth', 'crosshair')}${button('Rotate', 'swap', 'Swap long and short rails', 'swap')}${button('Cue ball', 'mark-cue', 'Tap the cue ball if it was not found', 'ball')}</span>
      <span class="practice-only">${button('Add', 'add', 'Add a ball', 'plus')}${button('Remove', 'remove', 'Remove the selected ball', 'minus')}</span>
      ${button('Zones', 'zones', 'Show good cue-ball zones for a next ball', 'grid')}
      ${button('Clear', 'clear', 'Clear the selection', 'close')}
    </div>`;
  const moreBtn = el.querySelector<HTMLButtonElement>('.tool-more')!;
  const setMore = (open: boolean) => {
    el.dataset.more = open ? 'open' : 'closed';
    moreBtn.setAttribute('aria-expanded', String(open));
  };
  setMore(false);
  moreBtn.addEventListener('click', () => setMore(el.dataset.more !== 'open'));
  document.addEventListener('pointerdown', (e) => {
    if (el.dataset.more === 'open' && !el.contains(e.target as Node)) setMore(false);
  });
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && el.dataset.more === 'open') {
      setMore(false);
      moreBtn.focus();
      e.stopPropagation();
    }
  });
  const map: Record<string, () => void> = {
    freeze: actions.freeze,
    calibrate: actions.calibrate,
    swap: actions.swapAxes,
    'mark-cue': actions.markCue,
    suggest: actions.suggest,
    position: actions.position,
    zones: actions.zones,
    clear: actions.clear,
    add: actions.addBall,
    remove: actions.removeBall,
  };
  el.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button[data-action]') as HTMLButtonElement | null;
    if (!b) return;
    if (b.closest('.tools.more')) setMore(false);
    map[b.dataset.action!]?.();
  });
  el.querySelector('select')!.addEventListener('change', (e) => actions.drill((e.target as HTMLSelectElement).value));
  // Fade the edges of the dock only where there is more to scroll to.
  const edges = () => {
    el.classList.toggle('more-left', el.scrollLeft > 2);
    el.classList.toggle('more-right', el.scrollLeft + el.clientWidth < el.scrollWidth - 2);
  };
  el.addEventListener('scroll', edges, { passive: true });
  if (typeof ResizeObserver === 'function') new ResizeObserver(edges).observe(el);
  return {
    update(s: AppState): void {
      if (el.dataset.mode !== s.mode) {
        el.dataset.mode = s.mode;
        requestAnimationFrame(edges);
      }
      const set = (a: string, on: boolean) => {
        const b = el.querySelector(`[data-action="${a}"]`);
        b?.classList.toggle('on', on);
        b?.setAttribute('aria-pressed', String(on));
      };
      set('freeze', !!s.frozen);
      const fr = el.querySelector<HTMLButtonElement>('[data-action="freeze"]')!;
      const want = s.frozen ? 'play' : 'snowflake';
      if (fr.dataset.icon !== want) {
        fr.dataset.icon = want;
        fr.innerHTML = `${iconMarkup(want, 22)}<span class="tool-label">${s.frozen ? 'Go live' : 'Freeze'}</span>`;
      }
      set('calibrate', s.interaction === 'calibrate' || !!s.manualCorners);
      set('mark-cue', s.interaction === 'mark-cue');
      set('position', s.interaction === 'position' || !!s.landing);
      set('zones', s.interaction === 'pick-next' || !!s.heatmap);
      set('suggest', !!s.suggestions);
    },
  };
}

export interface StrokeActions {
  power(p: number): void;
  spin(side: number, vert: number): void;
  preset(name: 'stun' | 'draw' | 'follow' | 'centre' | 'left' | 'right'): void;
  useRecommended(): void;
}

/**
 * Calls `fn` at most once per animation frame, with the latest value pushed, and at once on flush.
 * A fast slider drag fires several input events per frame and each one replans on the main thread
 * (a soft frozen-ball plan with its power advice costs 12–75 ms); only the last value of a frame
 * matters.
 */
export function perFrame<T>(fn: (v: T) => void, raf: (cb: () => void) => unknown = (cb) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(cb) : setTimeout(cb, 16))) {
  let pending: { v: T } | null = null;
  let scheduled = false;
  const run = () => {
    scheduled = false;
    const p = pending;
    pending = null;
    if (p) fn(p.v);
  };
  return {
    push(v: T): void {
      pending = { v };
      if (!scheduled) {
        scheduled = true;
        raf(run);
      }
    },
    flush: run,
  };
}

export function buildStrokeControls(el: HTMLElement, actions: StrokeActions) {
  el.innerHTML = `
    <section class="stroke" aria-labelledby="stroke-title">
      <div class="stroke-head"><h2 id="stroke-title">Your stroke</h2><button type="button" class="link" data-act="rec">${iconMarkup('refresh', 16)}Use recommended</button></div>
      <div class="stroke-body">
        <div class="power-box">
          <label for="power" class="power-label"><span>Power</span><span class="num"><output id="power-out">4</output><small>/10</small></span></label>
          <input id="power" type="range" min="1" max="10" step="0.5" value="4" aria-label="Power"/>
          <div class="presets" role="group" aria-label="Stroke presets">
            <button type="button" data-p="stun">Stun</button><button type="button" data-p="draw">Draw</button><button type="button" data-p="follow">Follow</button>
            <button type="button" data-p="left">Left</button><button type="button" data-p="centre">Centre</button><button type="button" data-p="right">Right</button>
          </div>
        </div>
        <div class="pad-slot"><span class="pad-caption">Drag the tip</span></div>
      </div>
    </section>`;
  const range = el.querySelector('#power') as HTMLInputElement;
  const out = el.querySelector('#power-out') as HTMLOutputElement;
  const fill = () => range.style.setProperty('--fill', `${((Number(range.value) - 1) / 9) * 100}%`);
  // The number follows the thumb at once; the replan runs at most once per frame (and at once when
  // the drag ends), so a fast drag does not plan every half step it passes.
  const send = perFrame((v: number) => actions.power(v));
  range.addEventListener('input', () => {
    out.value = range.value;
    fill();
    send.push(Number(range.value));
  });
  range.addEventListener('change', () => send.flush());
  const pad = createSpinPad((side, vert) => actions.spin(side, vert));
  el.querySelector('.pad-slot')!.prepend(pad.el);
  el.querySelectorAll<HTMLButtonElement>('[data-p]').forEach((b) => b.addEventListener('click', () => actions.preset(b.dataset.p as 'stun')));
  el.querySelector('[data-act="rec"]')!.addEventListener('click', actions.useRecommended);
  return {
    update(stroke: Stroke, mine: boolean, recommended: Stroke | null): void {
      if (document.activeElement !== range) {
        range.value = String(stroke.power);
        out.value = String(stroke.power);
        fill();
      }
      pad.set(stroke.side, stroke.vert, mine ? recommended : null);
      el.classList.toggle('mine', mine);
    },
  };
}

function ballLook(s: AppState, id: string): { color?: string; stripe?: boolean } {
  const balls = s.mode === 'practice' ? s.practice.balls : (s.frozen?.layout.balls ?? s.vision?.balls ?? []);
  const b = balls.find((x) => x.id === id);
  return b ? { ...(b.color ? { color: b.color } : {}), ...(b.stripe ? { stripe: true } : {}) } : {};
}

/** The suggestions each list element shows, read by its one delegated click listener. */
const shownSuggestions = new WeakMap<HTMLElement, { items: ShotSuggestion[]; pick: (x: ShotSuggestion) => void }>();

/**
 * The "Best shots" list. Runs on every store flush, so it only rewrites the list when what it shows
 * changed (focus on a suggestion survives a vision frame or a resize), and clicks go through one
 * delegated listener that reads the latest list.
 */
export function renderSuggestions(el: HTMLElement, s: AppState, labelOf: (id: string) => string, pocketName: (id: PocketId, targetId?: string) => string, pick: (x: ShotSuggestion) => void): void {
  if (!shownSuggestions.has(el)) {
    el.addEventListener('click', (e) => {
      const b = (e.target as Element | null)?.closest?.('button[data-i]') as HTMLButtonElement | null;
      const shown = shownSuggestions.get(el);
      const x = b && shown ? shown.items[Number(b.dataset.i)] : undefined;
      if (x) shown!.pick(x);
    });
  }
  shownSuggestions.set(el, { items: s.suggestions && !s.suggestions.pending ? s.suggestions.items : [], pick });
  if (!s.suggestions) {
    writeHtml(el, '');
    delete el.dataset.revealed;
    return;
  }
  if (s.suggestions.pending) {
    writeHtml(el, `<section class="suggest loading" aria-busy="true"><h2>${iconMarkup('sparkles', 16)}Best shots</h2><p class="loading-row"><span class="spinner" aria-hidden="true"></span> Finding the best shots…</p></section>`);
    revealOnce(el, 'pending');
    return;
  }
  if (!s.suggestions.items.length) {
    writeHtml(el, `<section class="suggest"><h2>${iconMarkup('sparkles', 16)}Best shots</h2><p class="none">${iconMarkup('info', 16)}No clean pot on this layout. Consider a safety or a bank.</p></section>`);
    return;
  }
  const html = `<section class="suggest" aria-labelledby="sugg-title"><h2 id="sugg-title">${iconMarkup('sparkles', 16)}Best shots</h2><ol>${s.suggestions.items
    .map((x, i) => {
      const look = ballLook(s, x.targetId);
      const label = labelOf(x.targetId);
      // The chip already shows a numbered ball's number: the text says it only to screen readers. The
      // margin is in mm of contact, the shot card's unit.
      const numbered = /^\d+$/.test(label);
      return `<li><button type="button" class="sugg" data-i="${i}"><span class="rank" aria-hidden="true">${i + 1}</span>${ballChip(label, look.color, look.stripe)}<span class="sugg-main">${numbered ? `<span class="sr-only">Ball ${esc(label)} </span>` : `<b>${esc(label)}</b> `}→ ${esc(pocketName(x.pocketId, x.targetId))}</span><span class="chip diff diff-${x.difficulty.replace(' ', '-')}">${x.difficulty} · ${esc(marginText(x))}</span>${iconMarkup('chevron-right', 18, 'go')}</button></li>`;
    })
    .join('')}</ol></section>`;
  writeHtml(el, html, (b) => (b as HTMLElement).dataset?.i ?? null);
  revealOnce(el, s.suggestions.items.map((x) => `${x.targetId}>${x.pocketId}`).join(','));
}

/** Scrolls `el` into view inside its scroll container when `key` changes (new content, not re-renders). */
export function revealOnce(el: HTMLElement, key: string): void {
  if (el.dataset.revealed === key) return;
  el.dataset.revealed = key;
  const scroller = el.closest<HTMLElement>('.sheet-body');
  if (!scroller) return;
  const top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 4;
  if (top < scroller.scrollTop || top > scroller.scrollTop + scroller.clientHeight - 40) scroller.scrollTop = Math.max(0, top);
}

export function buildSettings(dialog: HTMLDialogElement, get: () => Settings, apply: (s: Settings) => void): void {
  const presetOpts = (Object.keys(TABLE_PRESETS) as TablePresetId[]).map((id) => `<option value="${id}">${TABLE_PRESETS[id].name}</option>`).join('');
  const row = (label: string, control: string, icon?: IconName) =>
    `<label class="set-row">${icon ? `<span class="set-ic">${iconMarkup(icon, 18)}</span>` : ''}<span class="set-label">${label}</span>${control}</label>`;
  const sel = (name: string, opts: string) => `<span class="select-wrap"><select name="${name}">${opts}</select>${iconMarkup('chevron-down', 16)}</span>`;
  // Number fields are required and bounded like parseSettingsForm: an emptied field blocks Save.
  const num = (name: keyof typeof SETTING_LIMITS, mode: 'decimal' | 'numeric') => {
    const l = SETTING_LIMITS[name];
    return `<input name="${name}" type="number" min="${l.min}" max="${l.max}" step="${l.step}" inputmode="${mode}" required/>`;
  };
  dialog.setAttribute('aria-labelledby', 'settings-title');
  // Save is the form's only submit button, so Enter / Go in a field saves (implicit submission uses
  // the first submit button). The × and Cancel close the dialog without submitting or validating.
  dialog.innerHTML = `
    <form method="dialog" class="settings">
      <header class="dlg-head">
        <h2 id="settings-title">Settings</h2>
        <button type="button" data-dlg="cancel" class="icon-btn dlg-close" aria-label="Close settings">${iconMarkup('close', 20)}</button>
      </header>
      <div class="dlg-scroll">
        <p class="group-label">Table</p>
        <div class="group">
          ${row('Table', sel('table', presetOpts), 'ruler')}
          ${row('Cloth speed', sel('cloth', '<option value="fast">Fast (new cloth)</option><option value="normal">Normal</option><option value="slow">Slow (worn / humid)</option>'), 'layers')}
          ${row('Cushions', sel('cushions', '<option value="dead">Dead</option><option value="normal">Normal</option><option value="lively">Lively</option>'), 'swap')}
          ${row('Cushion width (cm)', num('cushionWidthCm', 'decimal'), 'width')}
        </div>
        <p class="group-label">Cue &amp; camera</p>
        <div class="group">
          ${row('Shaft', sel('shaft', '<option value="standard">Standard</option><option value="low-deflection">Low-deflection</option>'), 'cue')}
          ${row('Camera field of view (°)', num('fovDeg', 'numeric'), 'camera')}
        </div>
        <p class="group-label">Display</p>
        <div class="group">
          <label class="set-row toggle"><span class="set-ic">${iconMarkup('info', 18)}</span><span class="set-label">Show physics details</span><input name="showDetails" type="checkbox" role="switch"/><span class="switch" aria-hidden="true"></span></label>
          <label class="set-row toggle"><span class="set-ic">${iconMarkup('cube', 18)}</span><span class="set-label">3D table</span><input name="table3d" type="checkbox" role="switch"/><span class="switch" aria-hidden="true"></span></label>
        </div>
        <p class="privacy">${iconMarkup('lock', 16)}<span>Everything runs on this device. No video, image or data is uploaded.</span></p>
      </div>
      <footer class="dlg-actions"><button type="button" data-dlg="cancel" class="btn secondary">Cancel</button><button value="ok" type="submit" class="btn primary">Save</button></footer>
    </form>`;
  const form = dialog.querySelector('form')!;
  form.querySelectorAll<HTMLButtonElement>('[data-dlg="cancel"]').forEach((b) => b.addEventListener('click', () => dialog.close('cancel')));
  dialog.addEventListener('close', () => {
    if (dialog.returnValue !== 'ok') return;
    // Validated field by field: anything empty or out of range keeps the current setting.
    apply(parseSettingsForm(new FormData(form), get()));
  });
  const open = dialog.showModal.bind(dialog);
  dialog.showModal = () => {
    const s = get();
    // A close request (Esc, Android Back) keeps the previous returnValue in some engines: start clean
    // so dismissing never re-applies the last Save.
    dialog.returnValue = '';
    (form.elements.namedItem('table') as HTMLSelectElement).value = s.table;
    (form.elements.namedItem('cloth') as HTMLSelectElement).value = s.cloth;
    (form.elements.namedItem('cushions') as HTMLSelectElement).value = s.cushions;
    (form.elements.namedItem('shaft') as HTMLSelectElement).value = s.shaft;
    (form.elements.namedItem('cushionWidthCm') as HTMLInputElement).value = String(s.cushionWidthCm);
    (form.elements.namedItem('fovDeg') as HTMLInputElement).value = String(s.fovDeg);
    (form.elements.namedItem('showDetails') as HTMLInputElement).checked = s.showDetails;
    (form.elements.namedItem('table3d') as HTMLInputElement).checked = s.table3d;
    open();
  };
}
