/**
 * Toolbar, stroke controls (power slider + spin pad + presets), suggestions list and settings sheet.
 * Built once; `update*` functions refresh values without recreating interactive elements.
 */
import type { PocketId, ShotSuggestion, Stroke, TablePresetId } from '../../core/types';
import { TABLE_PRESETS } from '../../core/table';
import type { Settings } from '../settings';
import type { AppState } from '../store';
import { DRILLS } from '../drills';
import { createSpinPad } from './spin-pad';

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

function button(label: string, action: string, title: string): string {
  return `<button type="button" class="tool" data-action="${action}" title="${title}" aria-label="${title}">${label}</button>`;
}

export function buildToolbar(el: HTMLElement, actions: ToolbarActions) {
  el.innerHTML = `
    <div class="tools camera-only">
      ${button('⏸ Freeze', 'freeze', 'Freeze the detected layout')}
      ${button('⌖ Calibrate', 'calibrate', 'Tap the four corners of the cloth')}
      ${button('⇄ Rotate', 'swap', 'Swap long and short rails')}
      ${button('◯ Cue', 'mark-cue', 'Tap the cue ball if it was not found')}
    </div>
    <div class="tools practice-only">
      <label class="drill"><span class="sr-only">Drill</span>
        <select data-action="drill" aria-label="Practice layout">${DRILLS.map((d) => `<option value="${d.id}">${d.name}</option>`).join('')}</select></label>
      ${button('＋ Ball', 'add', 'Add a ball')}
      ${button('－ Ball', 'remove', 'Remove the selected ball')}
    </div>
    <div class="tools">
      ${button('★ Suggest', 'suggest', 'Suggest the best shots')}
      ${button('◎ Position', 'position', 'Tap where the cue ball should stop')}
      ${button('▦ Zones', 'zones', 'Show good cue-ball zones for a next ball')}
      ${button('✕ Clear', 'clear', 'Clear the selection')}
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
  return {
    update(s: AppState): void {
      el.dataset.mode = s.mode;
      const set = (a: string, on: boolean) => el.querySelector(`[data-action="${a}"]`)?.classList.toggle('on', on);
      set('freeze', !!s.frozen);
      el.querySelector<HTMLButtonElement>('[data-action="freeze"]')!.textContent = s.frozen ? '▶ Live' : '⏸ Freeze';
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
    <div class="stroke">
      <div class="stroke-head"><h2>Your stroke</h2><button type="button" class="link" data-act="rec">Use recommended</button></div>
      <div class="stroke-body">
        <div class="power-box">
          <label for="power">Power <output id="power-out">4</output>/10</label>
          <input id="power" type="range" min="1" max="10" step="0.5" value="4" aria-label="Power"/>
          <div class="presets">
            <button type="button" data-p="stun">Stun</button><button type="button" data-p="draw">Draw</button><button type="button" data-p="follow">Follow</button>
            <button type="button" data-p="left">Left</button><button type="button" data-p="centre">Centre</button><button type="button" data-p="right">Right</button>
          </div>
        </div>
        <div class="pad-slot"></div>
      </div>
    </div>`;
  const range = el.querySelector('#power') as HTMLInputElement;
  const out = el.querySelector('#power-out') as HTMLOutputElement;
  range.addEventListener('input', () => {
    out.value = range.value;
    actions.power(Number(range.value));
  });
  const pad = createSpinPad((side, vert) => actions.spin(side, vert));
  el.querySelector('.pad-slot')!.appendChild(pad.el);
  el.querySelectorAll<HTMLButtonElement>('[data-p]').forEach((b) => b.addEventListener('click', () => actions.preset(b.dataset.p as 'stun')));
  el.querySelector('[data-act="rec"]')!.addEventListener('click', actions.useRecommended);
  return {
    update(stroke: Stroke, mine: boolean, recommended: Stroke | null): void {
      if (document.activeElement !== range) {
        range.value = String(stroke.power);
        out.value = String(stroke.power);
      }
      pad.set(stroke.side, stroke.vert, mine ? recommended : null);
      el.classList.toggle('mine', mine);
    },
  };
}

export function renderSuggestions(el: HTMLElement, s: AppState, labelOf: (id: string) => string, pocketName: (id: PocketId) => string, pick: (x: ShotSuggestion) => void): void {
  if (!s.suggestions) {
    el.innerHTML = '';
    return;
  }
  if (s.suggestions.pending) {
    el.innerHTML = '<div class="suggest"><span class="spinner"></span> Finding the best shots…</div>';
    return;
  }
  if (!s.suggestions.items.length) {
    el.innerHTML = '<div class="suggest"><p>No clean pot on this layout — consider a safety or a bank.</p></div>';
    return;
  }
  el.innerHTML = `<div class="suggest"><h2>Best shots</h2><ol>${s.suggestions.items
    .map(
      (x, i) =>
        `<li><button type="button" data-i="${i}"><b>${labelOf(x.targetId)}</b> → ${pocketName(x.pocketId)} <span class="chip diff-${x.difficulty.replace(' ', '-')}">${x.difficulty} · ±${x.toleranceDeg.toFixed(2)}°</span></button></li>`,
    )
    .join('')}</ol></div>`;
  el.querySelectorAll<HTMLButtonElement>('button[data-i]').forEach((b) => b.addEventListener('click', () => pick(s.suggestions!.items[Number(b.dataset.i)]!)));
}

export function buildSettings(dialog: HTMLDialogElement, get: () => Settings, apply: (s: Settings) => void): void {
  const presetOpts = (Object.keys(TABLE_PRESETS) as TablePresetId[]).map((id) => `<option value="${id}">${TABLE_PRESETS[id].name}</option>`).join('');
  dialog.innerHTML = `
    <form method="dialog" class="settings">
      <h2>Settings</h2>
      <label>Table <select name="table">${presetOpts}</select></label>
      <label>Cloth speed <select name="cloth"><option value="fast">Fast (new cloth)</option><option value="normal">Normal</option><option value="slow">Slow (worn / humid)</option></select></label>
      <label>Cushions <select name="cushions"><option value="dead">Dead</option><option value="normal">Normal</option><option value="lively">Lively</option></select></label>
      <label>Shaft <select name="shaft"><option value="standard">Standard</option><option value="low-deflection">Low-deflection</option></select></label>
      <label>Cushion width (cm) <input name="cushionWidthCm" type="number" min="2" max="10" step="0.5"/></label>
      <label>Camera field of view (°) <input name="fovDeg" type="number" min="40" max="110" step="1"/></label>
      <label class="check"><input name="showDetails" type="checkbox"/> Show physics details</label>
      <p class="privacy">🔒 Everything runs on this device. No video, image or data is uploaded.</p>
      <div class="row"><button value="cancel" type="submit" class="secondary">Cancel</button><button value="ok" type="submit">Save</button></div>
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
    open();
  };
}
