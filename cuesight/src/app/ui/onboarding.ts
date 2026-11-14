/**
 * First-run hint (FR-128): "Tap a ball to plan a shot" plus one line per mode. It never blocks the
 * table: the card is pointer-transparent and goes away on the first tap anywhere (or on "Got it" from
 * the keyboard). The dismissal is remembered on the device (guarded localStorage).
 */
import { iconMarkup } from './icons';

export const ONBOARDING_KEY = 'cuesight.onboarded';

function seen(): boolean {
  try {
    return localStorage.getItem(ONBOARDING_KEY) === '1';
  } catch {
    return false;
  }
}

function remember(): void {
  try {
    localStorage.setItem(ONBOARDING_KEY, '1');
  } catch {
    /* storage unavailable (private mode): the hint will show again next time */
  }
}

/** Shows the hint inside `host` (the stage) unless it was dismissed before. Returns the card or null. */
export function mountOnboarding(host: HTMLElement): HTMLElement | null {
  if (seen()) return null;
  const card = document.createElement('aside');
  card.className = 'onboard glass';
  card.setAttribute('aria-labelledby', 'onboard-title');
  card.innerHTML = `
    <div class="onboard-head">
      <span class="onboard-icon">${iconMarkup('hand', 22)}</span>
      <div>
        <p class="onboard-title" id="onboard-title">Tap a ball to plan a shot</p>
        <p class="onboard-sub">Then tap a pocket, or let CueSight pick the best one.</p>
      </div>
    </div>
    <ul class="onboard-modes">
      <li>${iconMarkup('camera', 16)}<span><b>Live</b> aims through your camera</span></li>
      <li>${iconMarkup('aperture', 16)}<span><b>Snap</b> uses two photos: table, then your view</span></li>
      <li>${iconMarkup('cube', 16)}<span><b>Practice</b> plans on a virtual table</span></li>
    </ul>
    <button type="button" class="onboard-ok">Got it</button>`;
  host.appendChild(card);
  let gone = false;
  const dismiss = () => {
    if (gone) return;
    gone = true;
    remember();
    window.removeEventListener('pointerdown', onDown, true);
    card.classList.add('leaving');
    const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.setTimeout(() => card.remove(), reduce ? 0 : 220);
  };
  const onDown = () => dismiss();
  // Any first tap dismisses the hint and still reaches the table underneath.
  window.addEventListener('pointerdown', onDown, true);
  card.querySelector('.onboard-ok')!.addEventListener('click', dismiss);
  return card;
}
