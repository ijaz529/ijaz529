/**
 * The shot card: everything a player needs to play the shot, in player language (FR-010…FR-017,
 * FR-127). The first block (`.shot-head` + `.hero`) is the headline the bottom sheet shows at its peek
 * height: target → pocket, difficulty, cut, power and spin. Every 001 test id and text is kept.
 */
import { describeSpin, powerToSpeed, speedWord } from '../../core/shot/power';
import type { ShotPlan } from '../../core/types';
import { fractionGlyphSvg, type CutSide } from './fraction-glyph';
import { iconMarkup } from './icons';
import { powerMeterSvg, powerText } from './power-meter';
import { spinBallSvg, spinText } from './spin-ball';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Small static spin diagram (kept for callers of the 001 API); now the shaded cue ball. */
export function spinDiagram(side: number, vert: number, size = 56, _ghost?: { side: number; vert: number }): string {
  return spinBallSvg(side, vert, size);
}

export interface CardContext {
  targetLabel: string;
  pocketName: string;
  status: string | null;
  recommendedPending: boolean;
  showDetails: boolean;
  hint: string;
  /** Optional look of the target ball for the headline chip. */
  targetColor?: string;
  targetStripe?: boolean;
}

/** A tiny pool-ball chip: the ball colour, a white number disc, a band for stripes. */
export function ballChip(label: string, color?: string, stripe?: boolean): string {
  const isCue = label === 'cue' || label === 'white' || label === 'white?';
  const short = /^\d+$/.test(label) ? label : isCue ? '' : label.charAt(0).toUpperCase();
  const bg = isCue ? '#F4F1E8' : (color ?? '#E9E6DC');
  const style = stripe ? `--ball:${esc(bg)};background:#F4F1E8` : `--ball:${esc(bg)};background:${esc(bg)}`;
  return `<span class="ball-chip${stripe ? ' stripe' : ''}${isCue ? ' cue' : ''}" style="${style}" aria-hidden="true">${short ? `<i>${esc(short)}</i>` : ''}</span>`;
}

const cutSideOf = (s: ShotPlan['cutSide']): CutSide => (s > 0 ? 'left' : s < 0 ? 'right' : 'straight');

export function renderShotCard(el: HTMLElement, plan: ShotPlan | null, ctx: CardContext): void {
  if (!plan) {
    delete el.dataset.shot;
    el.innerHTML = `<div class="card empty">
      <span class="empty-icon">${iconMarkup('hand', 26)}</span>
      <div class="empty-text"><p class="hint">${esc(ctx.hint)}</p>${ctx.status ? `<p class="sub">${esc(ctx.status)}</p>` : ''}</div>
    </div>`;
    return;
  }
  const p = plan.stroke;
  const power = p.power;
  const word = speedWord(power);
  const diffClass = plan.makeable ? plan.difficulty.replace(' ', '-') : 'no';
  const warn = plan.warnings
    .filter((w) => w.code !== 'thin-cut' || !plan.warnings.some((x) => x.code === 'not-makeable'))
    .map((w) => `<li class="warn-chip warn-${w.code}">${iconMarkup('alert', 18)}<span>${esc(w.message)}</span></li>`)
    .join('');
  const src =
    plan.strokeSource === 'player'
      ? `<span class="badge">${iconMarkup('hand', 14)}your stroke</span>`
      : plan.strokeSource === 'recommended'
        ? `<span class="badge good">${iconMarkup('check', 14)}recommended for position</span>`
        : `<span class="badge">${ctx.recommendedPending ? '<span class="spinner" aria-hidden="true"></span> optimising position…' : 'basic stroke'}</span>`;
  const corrections: string[] = [];
  if (Math.abs(plan.throwDeg) >= 0.1) corrections.push(`Throw ${Math.abs(plan.throwDeg).toFixed(1)}° → ghost ball ${plan.throwShiftMm.toFixed(1)} mm thinner`);
  if (Math.abs(plan.squirtDeg) >= 0.1) corrections.push(`Squirt: aim cue ${Math.abs(plan.squirtDeg).toFixed(1)}° ${plan.squirtDeg > 0 ? 'right' : 'left'}`);
  const minPower = Number.isFinite(plan.minPower) ? plan.minPower : null;
  const powerStr = power.toFixed(power % 1 ? 1 : 0);
  el.innerHTML = `
  <article class="card shot${plan.makeable ? '' : ' not-makeable'}" data-testid="shot-card" aria-label="Shot plan">
    <header class="shot-head">
      <h2 class="title">${ballChip(ctx.targetLabel, ctx.targetColor, ctx.targetStripe)}<span class="sr-only">Ball </span><span class="target-label${/^\d+$/.test(ctx.targetLabel) ? ' sr-only' : ''}">${esc(ctx.targetLabel)}</span>${iconMarkup('arrow-right', 18, 'arrow')}<span class="pocket-name">${esc(ctx.pocketName)}</span></h2>
      <div class="chip diff diff-${diffClass}" data-testid="difficulty">${plan.makeable ? `${esc(plan.difficulty)} · ±${plan.toleranceDeg.toFixed(2)}°` : `${iconMarkup('alert', 14)}not makeable`}</div>
    </header>
    <div class="hero">
      <div class="hero-stat cut">
        <div class="k">Cut</div>
        <div class="hero-main"><div class="v num" data-testid="cut">${plan.cutAngleDeg.toFixed(1)}°</div></div>
        <div class="s">${fractionGlyphSvg(plan.fraction, cutSideOf(plan.cutSide))}<span>${esc(plan.fractionLabel)}-ball hit</span></div>
      </div>
      <div class="hero-stat power">
        <div class="k">Power</div>
        <div class="hero-main gauge-wrap">
          <div class="power-meter" role="img" aria-label="${esc(powerText(power, minPower))}">${powerMeterSvg(power, minPower)}</div>
          <div class="v num" data-testid="power">${powerStr}<small>/10</small></div>
        </div>
        <div class="s">${esc(word)} · ${powerToSpeed(power).toFixed(1)} m/s</div>
      </div>
      <div class="hero-stat spin">
        <div class="k">Spin</div>
        <div class="hero-main"><div class="spin-ball" role="img" aria-label="${esc(spinText(p.side, p.vert))}">${spinBallSvg(p.side, p.vert, 46)}</div></div>
        <div class="s" data-testid="spin">${esc(describeSpin(p))}</div>
      </div>
    </div>
    <div class="meta">${src}${corrections.length ? `<p class="corr">${iconMarkup('info', 14)}<span>${corrections.map(esc).join(' · ')}</span></p>` : ''}</div>
    ${warn ? `<ul class="warnings" role="alert">${warn}</ul>` : ''}
    <figure class="coach">
      <span class="coach-icon">${iconMarkup('lightbulb', 18)}</span>
      <blockquote class="tip" data-testid="tip">${esc(plan.tip)}</blockquote>
    </figure>
    ${
      ctx.showDetails
        ? `<dl class="details">
      <div><dt>Contact tolerance</dt><dd>±${plan.toleranceMm.toFixed(1)} mm</dd></div>
      <div><dt>Pocket window</dt><dd>±${plan.windowHalfDeg.toFixed(2)}°</dd></div>
      <div><dt>CB speed at contact</dt><dd>${plan.cbSpeedAtContact.toFixed(2)} m/s</dd></div>
      <div><dt>OB speed</dt><dd>${plan.obSpeed.toFixed(2)} m/s</dd></div>
      <div><dt>Min power</dt><dd>${plan.minPower > 10 ? '>10' : plan.minPower.toFixed(1)}</dd></div>
    </dl>`
        : ''
    }
  </article>`;
  // A new target or pocket: bring the headline back into view inside the sheet/panel.
  const key = `${plan.targetId}>${plan.pocketId}`;
  if (el.dataset.shot !== key) {
    el.dataset.shot = key;
    const scroller = el.closest<HTMLElement>('.sheet-body');
    if (scroller) {
      const top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 4;
      if (top < scroller.scrollTop) scroller.scrollTop = Math.max(0, top);
    }
  }
}
