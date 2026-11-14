/**
 * 10-segment arc power gauge (FR-127). The numeral is drawn by the caller on top of the arc; the
 * gauge itself carries an accessible text equivalent ("Power 6 of 10, medium-firm").
 */
import { speedWord } from '../../core/shot/power';

/** Segment colour ramp: soft → medium → firm → power. Meaning is also carried by the numeral and word. */
const RAMP = ['#18A374', '#18A374', '#2FB59A', '#56B4E9', '#56B4E9', '#56B4E9', '#E9C46A', '#E69F00', '#E8822F', '#D55E00'];

const fmt = (n: number) => (Math.round(n * 10) / 10).toString();

/** Player-facing text equivalent of the gauge. */
export function powerText(power: number, minPower: number | null): string {
  const p = Math.max(0, Math.min(10, power));
  let s = `Power ${fmt(p)} of 10, ${speedWord(p)}`;
  if (minPower != null && Number.isFinite(minPower)) s += minPower > 10 ? '. Needs more than full power' : `. Minimum ${fmt(Math.max(1, minPower))}`;
  return s;
}

/** Fill level of segment `i` (0-based) for `power` in 0..10: 0, 0.5 or 1. */
export function segmentFill(i: number, power: number): number {
  const v = power - i;
  return v >= 0.75 ? 1 : v >= 0.25 ? 0.5 : 0;
}

/** SVG markup of the gauge (viewBox 0 0 100 58, a 180° arc). */
export function powerMeterSvg(power: number, minPower: number | null): string {
  const cx = 50;
  const cy = 52;
  const r = 40;
  const sw = 9;
  const gap = 2.6; // degrees between segments
  const seg = 180 / 10;
  const pt = (deg: number, rad = r) => {
    const a = (Math.PI * (180 + deg)) / 180;
    return `${(cx + rad * Math.cos(a)).toFixed(2)} ${(cy + rad * Math.sin(a)).toFixed(2)}`;
  };
  const arc = (d0: number, d1: number) => `M${pt(d0)}A${r} ${r} 0 0 1 ${pt(d1)}`;
  let out = '';
  for (let i = 0; i < 10; i++) {
    const d0 = i * seg + gap / 2;
    const d1 = (i + 1) * seg - gap / 2;
    const f = segmentFill(i, power);
    out += `<path d="${arc(d0, d1)}" stroke="rgba(255,255,255,0.1)" stroke-width="${sw}" fill="none"/>`;
    if (f > 0) out += `<path class="seg on" data-seg="${i + 1}" d="${arc(d0, f === 1 ? d1 : d0 + (d1 - d0) / 2)}" stroke="${RAMP[i]}" stroke-width="${sw}" fill="none"/>`;
  }
  if (minPower != null && Number.isFinite(minPower)) {
    const m = Math.max(0, Math.min(10, minPower));
    const deg = m * seg;
    const over = minPower > 10;
    out += `<path class="min-tick" d="M${pt(deg, r - sw / 2 - 3)}L${pt(deg, r + sw / 2 + 3)}" stroke="#070B14" stroke-width="4.5" stroke-linecap="round"/>`;
    out += `<path class="min-tick" d="M${pt(deg, r - sw / 2 - 3)}L${pt(deg, r + sw / 2 + 3)}" stroke="${over ? '#D55E00' : '#F4F6FB'}" stroke-width="2" stroke-linecap="round"/>`;
  }
  return `<svg class="gauge-svg" viewBox="0 0 100 58" width="100%" height="100%" aria-hidden="true" focusable="false">${out}</svg>`;
}

/** Inner markup of the gauge element (SVG + screen-reader text). */
export function powerMeterMarkup(power: number, minPower: number | null): string {
  return `${powerMeterSvg(power, minPower)}<span class="sr-only">${powerText(power, minPower)}</span>`;
}

export function renderPowerMeter(power: number, minPower: number | null): HTMLElement {
  const el = document.createElement('div');
  el.className = 'power-meter';
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', powerText(power, minPower));
  el.innerHTML = powerMeterSvg(power, minPower);
  return el;
}
