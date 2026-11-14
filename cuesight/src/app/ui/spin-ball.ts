/**
 * Shaded cue-ball sphere with the tip dot and the miscue ring (FR-127): replaces the flat spin
 * diagram. The tip offsets are fractions of the ball radius as seen from behind the cue ball
 * (side + = right, vert + = up).
 */
import { describeSpin } from '../../core/shot/power';

let uid = 0;

/** Text equivalent of a tip position. */
export function spinText(side: number, vert: number): string {
  return `Cue tip: ${describeSpin({ side, vert })}`;
}

/** Reusable <defs> for a shaded ivory sphere; `id` must be unique in the document. */
export function sphereDefs(id: string): string {
  return `<defs>
    <radialGradient id="${id}-base" cx="38%" cy="32%" r="78%">
      <stop offset="0" stop-color="#FFFFFF"/><stop offset="0.38" stop-color="#F3F0E6"/>
      <stop offset="0.78" stop-color="#CFC9B9"/><stop offset="1" stop-color="#8F8A7C"/>
    </radialGradient>
    <radialGradient id="${id}-spec" cx="34%" cy="27%" r="22%">
      <stop offset="0" stop-color="#FFFFFF" stop-opacity="0.95"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/>
    </radialGradient>
    <clipPath id="${id}-clip"><circle cx="50" cy="50" r="46"/></clipPath>
  </defs>`;
}

/** The ivory sphere body (viewBox 0 0 100 100, radius 46), with crosshair and miscue ring. */
export function sphereBody(id: string): string {
  return `<circle cx="50" cy="50" r="46" fill="url(#${id}-base)"/>
    <g clip-path="url(#${id}-clip)" stroke="rgba(15,23,42,0.16)" stroke-width="1">
      <path d="M4 50h92M50 4v92"/>
    </g>
    <circle class="miscue" cx="50" cy="50" r="23" fill="none" stroke="#D55E00" stroke-opacity="0.75" stroke-width="1.6" stroke-dasharray="3.2 3.2"/>
    <circle cx="50" cy="50" r="46" fill="url(#${id}-spec)"/>
    <circle cx="50" cy="50" r="45.5" fill="none" stroke="rgba(0,0,0,0.35)" stroke-width="1"/>`;
}

/** SVG markup of the spin ball; `side`/`vert` are clamped to the ball face. */
export function spinBallSvg(side: number, vert: number, size = 56, id = `sb${++uid}`): string {
  const m = Math.hypot(side, vert);
  const k = m > 0.92 ? 0.92 / m : 1;
  const x = 50 + side * k * 46;
  const y = 50 - vert * k * 46;
  return `<svg class="spin-ball-svg" viewBox="0 0 100 100" width="${size}" height="${size}" aria-hidden="true" focusable="false">
    ${sphereDefs(id)}${sphereBody(id)}
    <circle cx="${x.toFixed(1)}" cy="${(y + 1.6).toFixed(1)}" r="8.5" fill="rgba(0,0,0,0.25)"/>
    <circle class="tip-dot" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="8" fill="#0072B2" stroke="#FFFFFF" stroke-width="2.6"/>
  </svg>`;
}

export function renderSpinBall(side: number, vert: number, size = 56): HTMLElement {
  const el = document.createElement('div');
  el.className = 'spin-ball';
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', spinText(side, vert));
  el.innerHTML = spinBallSvg(side, vert, size);
  return el;
}
