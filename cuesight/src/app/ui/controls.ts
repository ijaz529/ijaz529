/**
 * Toolbar, stroke controls (power slider + spin pad + presets), suggestions list and settings sheet.
 * Built once; `update*` functions refresh values without recreating interactive elements.
 */
import type { PocketId, ShotSuggestion, Stroke, TablePresetId } from '../../core/types';
import { TABLE_PRESETS } from '../../core/table';
import type { Settings } from '../settings';
import type { AppState } from '../store';
import { DRILLS } from '../drills';
import { iconMarkup, type IconName } from './icons';
import { ballChip } from './shot-card';
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
  el.innerHTML = `
    <div class="tools camera-only" role="group" aria-label="Camera tools">
      ${button('Freeze', 'freeze', 'Freeze the detected layout', 'snowflake')}
      ${button('Calibrate', 'calibrate', 'Tap the four corners of the cloth', 'crosshair')}
      ${button('Rotate', 'swap', 'Swap long and short rails', 'swap')}
      ${button('Cue ball', 'mark-cue', 'Tap the cue ball if it was not found', 'ball')}
    </div>
    <div class="tools practice-only" role="group" aria-label="Practice table tools">
      <label class="drill">${iconMarkup('list', 20)}<span class="sr-only">Drill</span>
        <select data-action="drill" aria-label="Practice layout">${DRILLS.map((d) => `<option value="${d.id}">${d.name}</option>`).join('')}</select>${iconMarkup('chevron-down', 16, 'drill-chev')}</label>
      ${button('Add', 'add', 'Add a ball', 'plus')}
      ${button('Remove', 'remove', 'Remove the selected ball', 'minus')}
    </div>
    <div class="tools shared" role="group" aria-label="Shot tools">
      ${button('Suggest', 'suggest', 'Suggest the best shots', 'sparkles')}
      ${button('Position', 'position', 'Tap where the cue ball should stop', 'target')}
      ${button('Zones', 'zones', 'Show good cue-ball zones for a next ball', 'grid')}
      ${button('Clear', 'clear', 'Clear the selection', 'close')}
    </div>`;
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
    if (b) map[b.dataset.action!]?.();
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
  range.addEventListener('input', () => {
    out.value = range.value;
    fill();
    actions.power(Number(range.value));
  });
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

export function renderSuggestions(el: HTMLElement, s: AppState, labelOf: (id: string) => string, pocketName: (id: PocketId) => string, pick: (x: ShotSuggestion) => void): void {
  if (!s.suggestions) {
    el.innerHTML = '';
    delete el.dataset.revealed;
    return;
  }
  if (s.suggestions.pending) {
    el.innerHTML = `<section class="suggest loading" aria-busy="true"><h2>${iconMarkup('sparkles', 16)}Best shots</h2><p class="loading-row"><span class="spinner" aria-hidden="true"></span> Finding the best shots…</p></section>`;
    revealOnce(el, 'pending');
    return;
  }
  if (!s.suggestions.items.length) {
    el.innerHTML = `<section class="suggest"><h2>${iconMarkup('sparkles', 16)}Best shots</h2><p class="none">${iconMarkup('info', 16)}No clean pot on this layout. Consider a safety or a bank.</p></section>`;
    return;
  }
  el.innerHTML = `<section class="suggest" aria-labelledby="sugg-title"><h2 id="sugg-title">${iconMarkup('sparkles', 16)}Best shots</h2><ol>${s.suggestions.items
    .map((x, i) => {
      const look = ballLook(s, x.targetId);
      const label = labelOf(x.targetId);
      return `<li><button type="button" class="sugg" data-i="${i}"><span class="rank" aria-hidden="true">${i + 1}</span>${ballChip(label, look.color, look.stripe)}<span class="sugg-main"><b>${esc(label)}</b> → ${esc(pocketName(x.pocketId))}</span><span class="chip diff diff-${x.difficulty.replace(' ', '-')}">${x.difficulty} · ±${x.toleranceDeg.toFixed(2)}°</span>${iconMarkup('chevron-right', 18, 'go')}</button></li>`;
    })
    .join('')}</ol></section>`;
  el.querySelectorAll<HTMLButtonElement>('button[data-i]').forEach((b) => b.addEventListener('click', () => pick(s.suggestions!.items[Number(b.dataset.i)]!)));
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
  dialog.setAttribute('aria-labelledby', 'settings-title');
  dialog.innerHTML = `
    <form method="dialog" class="settings">
      <header class="dlg-head">
        <h2 id="settings-title">Settings</h2>
        <button value="cancel" type="submit" class="icon-btn dlg-close" aria-label="Close settings">${iconMarkup('close', 20)}</button>
      </header>
      <div class="dlg-scroll">
        <p class="group-label">Table</p>
        <div class="group">
          ${row('Table', sel('table', presetOpts), 'ruler')}
          ${row('Cloth speed', sel('cloth', '<option value="fast">Fast (new cloth)</option><option value="normal">Normal</option><option value="slow">Slow (worn / humid)</option>'), 'layers')}
          ${row('Cushions', sel('cushions', '<option value="dead">Dead</option><option value="normal">Normal</option><option value="lively">Lively</option>'), 'swap')}
          ${row('Cushion width (cm)', '<input name="cushionWidthCm" type="number" min="2" max="10" step="0.5" inputmode="decimal"/>', 'ruler')}
        </div>
        <p class="group-label">Cue &amp; camera</p>
        <div class="group">
          ${row('Shaft', sel('shaft', '<option value="standard">Standard</option><option value="low-deflection">Low-deflection</option>'), 'cue')}
          ${row('Camera field of view (°)', '<input name="fovDeg" type="number" min="40" max="110" step="1" inputmode="numeric"/>', 'camera')}
        </div>
        <p class="group-label">Display</p>
        <div class="group">
          <label class="set-row toggle"><span class="set-ic">${iconMarkup('info', 18)}</span><span class="set-label">Show physics details</span><input name="showDetails" type="checkbox" role="switch"/><span class="switch" aria-hidden="true"></span></label>
          <label class="set-row toggle"><span class="set-ic">${iconMarkup('cube', 18)}</span><span class="set-label">3D table</span><input name="table3d" type="checkbox" role="switch"/><span class="switch" aria-hidden="true"></span></label>
        </div>
        <p class="privacy">${iconMarkup('lock', 16)}<span>Everything runs on this device. No video, image or data is uploaded.</span></p>
      </div>
      <footer class="dlg-actions"><button value="cancel" type="submit" class="btn secondary">Cancel</button><button value="ok" type="submit" class="btn primary">Save</button></footer>
    </form>`;
  const form = dialog.querySelector('form')!;
  dialog.addEventListener('close', () => {
    if (dialog.returnValue !== 'ok') return;
    const fd = new FormData(form);
    apply({
      table: fd.get('table') as TablePresetId,
      cloth: fd.get('cloth') as Settings['cloth'],
      cushions: fd.get('cushions') as Settings['cushions'],
      shaft: fd.get('shaft') as Settings['shaft'],
      cushionWidthCm: Number(fd.get('cushionWidthCm')),
      fovDeg: Number(fd.get('fovDeg')),
      showDetails: fd.get('showDetails') === 'on',
      table3d: fd.get('table3d') === 'on',
    });
  });
  const open = dialog.showModal.bind(dialog);
  dialog.showModal = () => {
    const s = get();
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
