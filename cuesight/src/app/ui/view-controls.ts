/**
 * Glass controls for the 3D table (feature 002 US1, FR-104/FR-108): a segmented camera pill
 * (Top · Player · Orbit — all three views are 3D), the active preset (or "Custom" after an orbit),
 * and Play shot / Skip in thumb reach.
 */
import { iconMarkup, type IconName } from './icons';

export type ViewPreset = 'overview' | 'player' | 'broadcast';

export interface ViewControlActions {
  preset(p: ViewPreset): void;
  play(): void;
  stop(): void;
  /** Slow-motion replays on/off (half speed: watch the contact, the spin take, the bend). */
  slow?(on: boolean): void;
}

const PRESETS: { id: ViewPreset; text: string; label: string; icon: IconName }[] = [
  { id: 'overview', text: 'Top', label: 'Overview: the whole table from above', icon: 'grid' },
  { id: 'player', text: 'Player', label: "Player view: low behind the cue ball, down the aim line", icon: 'eye' },
  { id: 'broadcast', text: 'Orbit', label: 'Broadcast (Orbit): a three-quarter view you can orbit', icon: 'rotate-3d' },
];

/**
 * When a replay ends on its own, the Skip button turns back into Play in place. A tap aimed at
 * "Skip" that lands just after that must not start the replay again, so Play ignores taps for this
 * long after a replay ends by itself (not after the player skipped it).
 */
export const REPLAY_TAP_GUARD_MS = 350;

export function buildViewControls(el: HTMLElement, actions: ViewControlActions) {
  el.innerHTML = `
    <div class="vc-presets glass" role="group" aria-label="Camera view">
      ${PRESETS.map((p) => `<button type="button" class="vc-btn" data-preset="${p.id}" aria-pressed="false" aria-label="${p.label}" title="${p.label}">${iconMarkup(p.icon, 20)}<span>${p.text}</span></button>`).join('')}
    </div>
    <span class="vc-custom" aria-live="polite"></span>
    <button type="button" class="vc-slow" data-act="slow" aria-pressed="false" aria-label="Slow-motion replay (half speed)" title="Replay at half speed" disabled><span aria-hidden="true">½×</span></button>
    <button type="button" class="vc-play" data-act="play" aria-label="Play shot" title="Play shot (replays the simulated shot)" disabled>${iconMarkup('play', 22)}<span>Play</span></button>`;
  const play = el.querySelector<HTMLButtonElement>('.vc-play')!;
  const slowBtn = el.querySelector<HTMLButtonElement>('.vc-slow')!;
  let slow = false;
  const custom = el.querySelector<HTMLElement>('.vc-custom')!;
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  let stoppedAt = -Infinity;
  let userStop = false;
  const skip = () => {
    userStop = true;
    actions.stop();
  };
  el.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (!b || b.disabled) return;
    if (b.dataset.preset) actions.preset(b.dataset.preset as ViewPreset);
    else if (b.dataset.act === 'play') {
      if (now() - stoppedAt >= REPLAY_TAP_GUARD_MS) actions.play();
    } else if (b.dataset.act === 'stop') skip();
    else if (b.dataset.act === 'slow') {
      slow = !slow;
      slowBtn.setAttribute('aria-pressed', String(slow));
      actions.slow?.(slow);
    }
  });
  let last = '';
  let wasPlaying: boolean | null = null;
  return {
    update(preset: ViewPreset | 'custom', canPlay: boolean, playing: boolean): void {
      const key = `${preset}|${canPlay}|${playing}`;
      if (key === last) return;
      last = key;
      el.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.preset === preset)));
      custom.textContent = preset === 'custom' ? 'Custom' : '';
      custom.title = preset === 'custom' ? 'Custom view: double-tap the cloth to go back' : '';
      custom.hidden = preset !== 'custom';
      play.disabled = !canPlay && !playing;
      slowBtn.disabled = !canPlay || playing;
      // Only rebuild the button's content when Play/Skip actually flips: replacing the icon under a
      // finger between pointerdown and pointerup would swallow that tap.
      if (playing === wasPlaying) return;
      if (wasPlaying && !playing && !userStop) stoppedAt = now();
      userStop = false;
      wasPlaying = playing;
      play.dataset.act = playing ? 'stop' : 'play';
      play.classList.toggle('playing', playing);
      play.setAttribute('aria-label', playing ? 'Skip the replay' : 'Play shot');
      play.innerHTML = playing ? `${iconMarkup('skip', 22)}<span>Skip</span>` : `${iconMarkup('play', 22)}<span>Play</span>`;
    },
    /** Skips the running replay on the player's request (the Skip button, or Escape). */
    skip,
  };
}
