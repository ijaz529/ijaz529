/**
 * The shot card: everything a player needs to play the shot, in player language (FR-010…FR-017).
 */
import { describeSpin, powerToSpeed, speedWord } from '../../core/shot/power';
import type { ShotPlan } from '../../core/types';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function spinDiagram(side: number, vert: number, size = 56, ghost?: { side: number; vert: number }): string {
  const r = size / 2 - 3;
  const c = size / 2;
  const dot = (s: number, v: number, fill: string, stroke = '#111') => `<circle cx="${(c + s * r).toFixed(1)}" cy="${(c - v * r).toFixed(1)}" r="${(size / 11).toFixed(1)}" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`;
  return `<svg class="spin-mini" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true">
    <circle cx="${c}" cy="${c}" r="${r}" fill="#f7f7f2" stroke="#999"/>
    <circle cx="${c}" cy="${c}" r="${r * 0.5}" fill="none" stroke="#bbb" stroke-dasharray="2 3"/>
    <line x1="${c - r}" y1="${c}" x2="${c + r}" y2="${c}" stroke="#ddd"/><line x1="${c}" y1="${c - r}" x2="${c}" y2="${c + r}" stroke="#ddd"/>
    ${ghost ? dot(ghost.side, ghost.vert, 'none', '#0072B2') : ''}
    ${dot(side, vert, '#0072B2', '#fff')}
  </svg>`;
}

export interface CardContext {
  targetLabel: string;
  pocketName: string;
  status: string | null;
  recommendedPending: boolean;
  showDetails: boolean;
  hint: string;
}

export function renderShotCard(el: HTMLElement, plan: ShotPlan | null, ctx: CardContext): void {
  if (!plan) {
    el.innerHTML = `<div class="card empty"><p class="hint">${esc(ctx.hint)}</p>${ctx.status ? `<p class="sub">${esc(ctx.status)}</p>` : ''}</div>`;
    return;
  }
  const p = plan.stroke;
  const power = p.power;
  const word = speedWord(power);
  const diffClass = plan.makeable ? plan.difficulty.replace(' ', '-') : 'no';
  const warn = plan.warnings
    .filter((w) => w.code !== 'thin-cut' || !plan.warnings.some((x) => x.code === 'not-makeable'))
    .map((w) => `<li class="warn-${w.code}">⚠️ ${esc(w.message)}</li>`)
    .join('');
  const src =
    plan.strokeSource === 'player'
      ? '<span class="badge">your stroke</span>'
      : plan.strokeSource === 'recommended'
        ? '<span class="badge good">recommended for position</span>'
        : `<span class="badge">${ctx.recommendedPending ? '<span class="spinner"></span> optimising position…' : 'basic stroke'}</span>`;
  const corrections: string[] = [];
  if (Math.abs(plan.throwDeg) >= 0.1) corrections.push(`Throw ${Math.abs(plan.throwDeg).toFixed(1)}° → ghost ball ${plan.throwShiftMm.toFixed(1)} mm thinner`);
  if (Math.abs(plan.squirtDeg) >= 0.1) corrections.push(`Squirt: aim cue ${Math.abs(plan.squirtDeg).toFixed(1)}° ${plan.squirtDeg > 0 ? 'right' : 'left'}`);
  el.innerHTML = `
  <div class="card" data-testid="shot-card">
    <div class="card-head">
      <div class="title"><span class="ball-chip">${esc(ctx.targetLabel)}</span> → ${esc(ctx.pocketName)}</div>
      <div class="chip diff-${diffClass}" data-testid="difficulty">${plan.makeable ? `${esc(plan.difficulty)} · ±${plan.toleranceDeg.toFixed(2)}°` : 'not makeable'}</div>
    </div>
    <div class="stats">
      <div class="stat"><div class="k">Cut</div><div class="v" data-testid="cut">${plan.cutAngleDeg.toFixed(1)}°</div><div class="s">${esc(plan.fractionLabel)}-ball hit</div></div>
      <div class="stat"><div class="k">Power</div><div class="v" data-testid="power">${power.toFixed(power % 1 ? 1 : 0)}<small>/10</small></div>
        <div class="meter" aria-hidden="true"><i style="width:${power * 10}%"></i></div><div class="s">${esc(word)} · ${powerToSpeed(power).toFixed(1)} m/s</div></div>
      <div class="stat spin"><div class="k">Spin</div>${spinDiagram(p.side, p.vert)}<div class="s" data-testid="spin">${esc(describeSpin(p))}</div></div>
    </div>
    ${src}
    ${corrections.length ? `<p class="corr">${corrections.map(esc).join(' · ')}</p>` : ''}
    ${warn ? `<ul class="warnings" role="alert">${warn}</ul>` : ''}
    <p class="tip" data-testid="tip">💡 ${esc(plan.tip)}</p>
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
  </div>`;
}
