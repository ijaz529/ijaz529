/**
 * 10-segment arc power gauge (FR-127). The numeral is drawn by the caller on top of the arc; the
 * gauge itself carries an accessible text equivalent ("Power 6 of 10, medium-firm").
 */
import { speedWord } from '../../core/shot/power';
import type { ShotPlan } from '../../core/types';
import { isFrozenPlan } from '../render/plan-draw';

/**
 * Segment colour ramp: one hue, soft white → accent sky by intensity (the plan's line colours — orange,
 * blue, green — mean paths, never speeds). Meaning is also carried by the numeral and the word.
 */
const RAMP = Array.from({ length: 10 }, (_, i) => {
  const t = i / 9;
  const mix = (a: number, b: number) => Math.round(a + (b - a) * t);
  return `rgb(${mix(214, 86)},${mix(226, 180)},${mix(240, 233)})`;
});

const fmt = (n: number) => (Math.round(n * 10) / 10).toString();

export interface MeterOptions {
  /**
   * ShotPlan.minPowerCapture: below it the object ball stops short; from it up to minPower it only
   * just drops (a dashed band on the arc, and said in words).
   */
  capture?: number | null;
  /**
   * A frozen cue ball: the minimum moves with the power (harder throws less), and minPower > 10 means
   * no power pots it with pace — never "more than full power" (the warning says harder won't help).
   */
  frozen?: boolean;
}

/**
 * Fields of a plan the meter reads. `noWorkingPower` / `adviceSkipped` are the live-snap core's
 * (ShotPlan.noWorkingPower: no power on the scale works, more power is not the answer;
 * ShotPlan.adviceSkipped: a frozen cue ball's power advice is not worked out yet), read when present.
 */
export type MeterPlan = Pick<ShotPlan, 'warnings' | 'minPower' | 'minPowerCapture'> & { noWorkingPower?: unknown; adviceSkipped?: boolean };

/**
 * The meter's options for a plan — one helper for the shot card and the Snap HUD, so the two never
 * word the same plan differently: a frozen cue ball (or any plan where no power works) has no band
 * and, past 10, "No power gets it in with pace"; any other plan gets its "only just drops" band.
 */
export function meterOptions(plan: MeterPlan): MeterOptions {
  const frozen = isFrozenPlan(plan) || !!plan.noWorkingPower;
  return { frozen, ...(!frozen && plan.minPowerCapture !== undefined ? { capture: plan.minPowerCapture } : {}) };
}

/** The minimum the meter marks: none while it is unknown (not finite, or the frozen advice still being worked out). */
export function meterMinPower(plan: MeterPlan): number | null {
  return Number.isFinite(plan.minPower) && !plan.adviceSkipped ? plan.minPower : null;
}

/** The "only just drops" band [from, to] in power units, or null when there is none to show. */
export function justDropsBand(minPower: number | null, opts: MeterOptions = {}): { from: number; to: number } | null {
  const cap = opts.capture;
  if (opts.frozen || minPower == null || cap == null || !Number.isFinite(minPower) || !Number.isFinite(cap)) return null;
  const from = Math.max(1, cap);
  const to = Math.min(10, minPower);
  return to - from >= 0.05 ? { from, to } : null;
}

/** Player-facing text equivalent of the gauge. */
export function powerText(power: number, minPower: number | null, opts: MeterOptions = {}): string {
  const p = Math.max(0, Math.min(10, power));
  let s = `Power ${fmt(p)} of 10, ${speedWord(p)}`;
  if (minPower != null && Number.isFinite(minPower)) {
    if (minPower > 10) s += opts.frozen ? '. No power gets it in with pace' : '. Needs more than full power for pace';
    else s += `. Minimum ${fmt(Math.max(1, minPower))}`;
    const band = justDropsBand(minPower, opts);
    if (band) s += `; from ${fmt(band.from)} it only just drops`;
  }
  return s;
}

/** Fill level of segment `i` (0-based) for `power` in 0..10: 0, 0.5 or 1. */
export function segmentFill(i: number, power: number): number {
  const v = power - i;
  return v >= 0.75 ? 1 : v >= 0.25 ? 0.5 : 0;
}

/** SVG markup of the gauge (viewBox 0 0 100 58, a 180° arc). */
export function powerMeterSvg(power: number, minPower: number | null, opts: MeterOptions = {}): string {
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
  // "Only just drops": a thin dashed arc just outside the segments (pattern, not colour, carries it).
  const band = justDropsBand(minPower, opts);
  if (band) {
    const rb = r + sw / 2 + 2.2;
    const bArc = `M${pt(band.from * seg, rb)}A${rb} ${rb} 0 0 1 ${pt(band.to * seg, rb)}`;
    out += `<path d="${bArc}" stroke="#070B14" stroke-width="3.6" fill="none"/>`;
    out += `<path class="just-drops" d="${bArc}" stroke="#F4F6FB" stroke-width="1.6" stroke-dasharray="2.2 1.8" fill="none"/>`;
  }
  // A frozen cue ball that no power pots: no minimum to mark (the warning names what works instead).
  if (minPower != null && Number.isFinite(minPower) && !(opts.frozen && minPower > 10)) {
    const m = Math.max(0, Math.min(10, minPower));
    const deg = m * seg;
    const over = minPower > 10;
    out += `<path class="min-tick" d="M${pt(deg, r - sw / 2 - 3)}L${pt(deg, r + sw / 2 + 3)}" stroke="#070B14" stroke-width="4.5" stroke-linecap="round"/>`;
    out += `<path class="min-tick" d="M${pt(deg, r - sw / 2 - 3)}L${pt(deg, r + sw / 2 + 3)}" stroke="${over ? '#D55E00' : '#F4F6FB'}" stroke-width="2" stroke-linecap="round"/>`;
  }
  return `<svg class="gauge-svg" viewBox="0 0 100 58" width="100%" height="100%" aria-hidden="true" focusable="false">${out}</svg>`;
}

/** Inner markup of the gauge element (SVG + screen-reader text). */
export function powerMeterMarkup(power: number, minPower: number | null, opts: MeterOptions = {}): string {
  return `${powerMeterSvg(power, minPower, opts)}<span class="sr-only">${powerText(power, minPower, opts)}</span>`;
}

export function renderPowerMeter(power: number, minPower: number | null, opts: MeterOptions = {}): HTMLElement {
  const el = document.createElement('div');
  el.className = 'power-meter';
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', powerText(power, minPower, opts));
  el.innerHTML = powerMeterSvg(power, minPower, opts);
  return el;
}
