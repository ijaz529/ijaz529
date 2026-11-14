/**
 * The shot card: everything a player needs to play the shot, in player language (FR-010…FR-017,
 * FR-127). The first block (`.shot-head` + `.hero`) is the headline the bottom sheet shows at its peek
 * height: target → pocket, difficulty, cut, power and spin. Every 001 test id and text is kept.
 */
import { describeSpin, powerToSpeed, speedWord } from '../../core/shot/power';
import { squirtOffsetText, throwSentence } from '../../core/shot/coach';
import type { ShotPlan, WarningCode } from '../../core/types';
import { fractionGlyphSvg, type CutSide } from './fraction-glyph';
import { iconMarkup } from './icons';
import { writeHtml } from './patch';
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
  /** Pace in player terms (e.g. "pocket speed + 2 diamonds"), from core speedReference(). */
  speedRef?: string | null;
  /** Name of the best other pocket, offered when this one is not makeable. */
  altPocket?: { id: string; name: string } | null;
  /** Balls that can be picked (object balls), for keyboard and screen-reader users. */
  balls?: { id: string; label: string; color?: string; stripe?: boolean }[];
  /** Pockets by name once a ball is picked. */
  pockets?: { id: string; name: string; selected: boolean }[];
  /** Cue ball → ghost-ball distance (m) and ball radius, to say the squirt aim as an offset. */
  cbDistance?: number;
  ballRadius?: number;
  /** Scratch risks of the recommended stroke under small errors (from the robustness probes). */
  risks?: { scratchIf: 'harder' | 'softer' | 'aim' | 'tip'; pocketName: string }[];
}

/** A row of ball buttons (the same flow as tapping a ball on the table). */
function ballPicker(balls: NonNullable<CardContext['balls']>): string {
  if (!balls.length) return '';
  return `<div class="picker" role="group" aria-label="Pick the ball to pocket"><span class="picker-k">Or pick a ball</span><div class="picker-row">${balls
    .map((b) => `<button type="button" class="pick-ball" data-card-act="ball" data-id="${esc(b.id)}" aria-label="Ball ${esc(b.label)}">${ballChip(b.label, b.color, b.stripe)}<span>${esc(b.label)}</span></button>`)
    .join('')}</div></div>`;
}

/**
 * Reading order of pocket names as the player sees them: ahead/far first, then beside, then
 * near/behind; left before right. Keeps keyboard focus order equal to the visual rows.
 */
export function pocketOrder(name: string): number {
  const depth = /ahead|^far /.test(name) ? 0 : /^far side/.test(name) ? 0 : /on your|^(left|right) side/.test(name) ? 1 : /behind|^near/.test(name) ? 2 : 1;
  const side = /left/.test(name) ? 0 : /right/.test(name) ? 2 : 1;
  return depth * 3 + side;
}

/** Pocket buttons by name (the chosen one pressed), in visual order. */
function pocketPicker(pockets: NonNullable<CardContext['pockets']>): string {
  if (!pockets.length) return '';
  return `<div class="picker" role="group" aria-label="Choose the pocket"><span class="picker-k">Pocket</span><div class="picker-row">${[...pockets]
    .sort((a, b) => pocketOrder(a.name) - pocketOrder(b.name))
    .map((p) => `<button type="button" class="pick-pocket" data-card-act="pocket" data-pocket="${esc(p.id)}" aria-pressed="${p.selected}">${esc(p.name)}</button>`)
    .join('')}</div></div>`;
}

/** Warnings serious enough to show at the sheet's resting height, most serious first. */
const HEADLINE_WARN: WarningCode[] = ['not-makeable', 'blocked-cue', 'blocked-object', 'cb-short', 'scratch', 'too-soft', 'kiss', 'ob-missed', 'miscue-risk', 'frozen', 'thin-cut'];

/** The warning to headline (shown in the peek), or null. */
export function headlineWarning(plan: ShotPlan): ShotPlan['warnings'][number] | null {
  for (const code of HEADLINE_WARN) {
    const w = plan.warnings.find((x) => x.code === code);
    if (w) return w;
  }
  return null;
}

/** Short hero line for the fractional aim: "½-ball hit", or "thicker than ⅜-ball" when qualified. */
export function fractionShort(plan: Pick<ShotPlan, 'fractionLabel' | 'fractionPhrase'>): string {
  const phrase = plan.fractionPhrase ?? `${plan.fractionLabel}-ball`;
  // A non-breaking hyphen keeps "⅜-ball" together in the narrow hero column.
  if (phrase.startsWith('a touch ')) return phrase.slice('a touch '.length).replace('-ball', '\u2011ball');
  return phrase === 'a thin hit' ? 'thin hit' : `${phrase} hit`;
}

/**
 * The fractional aim in a hero tile (one short line): "½-ball hit" on the label, "⅜+ ball" when a
 * touch thicker, "⅝− ball" when a touch thinner, "thin hit". The full phrase is in the title/details.
 */
export function fractionTile(plan: Pick<ShotPlan, 'fractionLabel' | 'fractionPhrase'>): string {
  const phrase = plan.fractionPhrase ?? `${plan.fractionLabel}-ball`;
  const m = /^a touch (thicker|thinner) than (.+)-ball$/.exec(phrase);
  if (m) return `${m[2]}${m[1] === 'thicker' ? '+' : '\u2212'} ball`;
  return phrase === 'a thin hit' ? 'thin hit' : `${phrase} hit`;
}

/** Margin of error as the player feels it: millimetres of contact on the object ball. */
export function marginText(plan: Pick<ShotPlan, 'toleranceMm'>): string {
  const mm = plan.toleranceMm;
  return `±${mm >= 10 ? mm.toFixed(0) : mm.toFixed(1)} mm`;
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

/** Key of a card control, to keep keyboard focus on it across a re-render (same pocket, same ball). */
const cardFocusKey = (e: Element): string | null => {
  const d = (e as HTMLElement).dataset;
  return d?.cardAct ? `${d.cardAct}:${d.pocket ?? d.id ?? ''}` : null;
};

/** Where to strike in millimetres from the centre ("11 mm below centre, 7 mm right"), or null. */
export function tipOffsetMm(stroke: { side: number; vert: number }, ballRadius: number): string | null {
  if (!(ballRadius > 0)) return null;
  const mm = (f: number) => Math.round(Math.abs(f) * ballRadius * 1000);
  const parts: string[] = [];
  if (mm(stroke.vert) >= 1) parts.push(`${mm(stroke.vert)} mm ${stroke.vert > 0 ? 'above' : 'below'} centre`);
  if (mm(stroke.side) >= 1) parts.push(`${mm(stroke.side)} mm ${stroke.side > 0 ? 'right' : 'left'}`);
  return parts.length ? parts.join(', ') : 'centre';
}

/** Last plan and context drawn into each card element (the store re-renders on every flush). */
const drawn = new WeakMap<HTMLElement, { plan: ShotPlan | null; ctx: string }>();

/**
 * Draws the shot card. Runs on every store flush, so it returns early when the plan (same object)
 * and the context are unchanged: rebuilding the markup would drop keyboard focus and a screen
 * reader's place. When it does redraw, focus stays on the same pocket or ball button.
 */
export function renderShotCard(el: HTMLElement, plan: ShotPlan | null, ctx: CardContext): void {
  const ctxKey = JSON.stringify(ctx);
  const last = drawn.get(el);
  if (last && last.plan === plan && last.ctx === ctxKey) return;
  drawn.set(el, { plan, ctx: ctxKey });
  if (!plan) {
    delete el.dataset.shot;
    writeHtml(
      el,
      `<div class="card empty">
      <span class="empty-icon">${iconMarkup('hand', 26)}</span>
      <div class="empty-text"><p class="hint">${esc(ctx.hint)}</p>${ctx.status ? `<p class="sub">${esc(ctx.status)}</p>` : ''}</div>
    </div>${ctx.pockets?.length ? pocketPicker(ctx.pockets) : ballPicker(ctx.balls ?? [])}`,
      cardFocusKey,
    );
    return;
  }
  const p = plan.stroke;
  const power = p.power;
  const diffClass = plan.makeable ? plan.difficulty.replace(' ', '-') : 'no';
  const head = headlineWarning(plan);
  // Not makeable: every reason leads the card once (in the hero), and nothing below repeats it.
  const ordered = [...plan.warnings].sort((a, b) => {
    const ra = HEADLINE_WARN.indexOf(a.code);
    const rb = HEADLINE_WARN.indexOf(b.code);
    return (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb);
  });
  const shown = ordered.filter((w, i) => (w.code !== 'thin-cut' || !plan.warnings.some((x) => x.code === 'not-makeable')) && ordered.findIndex((x) => x.message === w.message) === i);
  const chips = (list: typeof shown) => list.map((w) => `<li class="warn-chip warn-${w.code}">${iconMarkup('alert', 18)}<span>${esc(w.message)}</span></li>`).join('');
  const RISK_HOW = { harder: 'A little harder', softer: 'A little softer', tip: 'With the tip a little off', aim: 'With a small aim error' } as const;
  const riskChips = (ctx.risks ?? []).map((r) => `<li class="warn-chip warn-risk">${iconMarkup('alert', 18)}<span>Scratch risk: ${esc(RISK_HOW[r.scratchIf].toLowerCase())} and the cue ball goes in the ${esc(r.pocketName)}.</span></li>`).join('');
  // A shot that cannot happen as planned gets no stroke instructions (no power, no spin, no aim fixes).
  const noStroke = !plan.makeable || plan.warnings.some((w) => w.code === 'cb-short');
  // Makeable: the headline warning is already shown above the hero (.head-warn); the list below has
  // the others, so no warning appears twice.
  const warn = plan.makeable ? chips(shown.filter((w) => !head || w.message !== head.message)) + riskChips : '';
  // A margin exists only for a shot that can be made (the planner's value goes negative past 90°).
  const margin = plan.makeable && plan.toleranceMm > 0;
  const tipMm = ctx.ballRadius ? tipOffsetMm(p, ctx.ballRadius) : null;
  const src =
    plan.strokeSource === 'player'
      ? `<span class="badge">${iconMarkup('hand', 14)}your stroke</span>`
      : plan.strokeSource === 'recommended'
        ? `<span class="badge good">${iconMarkup('check', 14)}recommended for position</span>`
        : `<span class="badge">${ctx.recommendedPending ? '<span class="spinner" aria-hidden="true"></span> optimising position…' : 'basic stroke'}</span>`;
  // Aim corrections the coaching tip does not already spell out.
  const corrections: string[] = [];
  const tipSquirt = plan.tip.includes('blue line');
  const tipThrow = /[Tt]hrow/.test(plan.tip);
  if (!noStroke && Math.abs(plan.squirtDeg) >= 0.1 && !tipSquirt) {
    const off = ctx.cbDistance && ctx.ballRadius ? squirtOffsetText(plan.squirtDeg, plan.stroke.side, ctx.cbDistance, ctx.ballRadius) : null;
    corrections.push(off ? `Squirt: aim the cue ${off} (${Math.abs(plan.squirtDeg).toFixed(1)}°)` : `Aim the cue ${Math.abs(plan.squirtDeg).toFixed(1)}° ${plan.squirtDeg > 0 ? 'right' : 'left'} of the blue line (squirt)`);
  }
  if (!noStroke && Math.abs(plan.throwDeg) >= 0.1 && plan.throwAim && !tipThrow) corrections.push(throwSentence(plan).replace(/ \(the ghost ball shown is already moved\)\.$/, '.'));
  const minPower = Number.isFinite(plan.minPower) ? plan.minPower : null;
  const powerStr = power.toFixed(power % 1 ? 1 : 0);
  const phrase = plan.fractionPhrase ?? `${plan.fractionLabel}-ball`;
  const spinWords = describeSpin(p);
  const hero = plan.makeable
    ? `<div class="hero">
      <div class="hero-stat cut">
        <div class="k">Cut</div>
        <div class="hero-main"><div class="v num" data-testid="cut">${plan.cutAngleDeg.toFixed(1)}°</div></div>
        <div class="s" title="${esc(phrase)}">${fractionGlyphSvg(plan.fraction, cutSideOf(plan.cutSide))}<span class="t">${esc(fractionTile(plan))}</span>${fractionTile(plan) !== fractionShort(plan) ? `<span class="sr-only"> (${esc(phrase)})</span>` : ''}</div>
      </div>
      <div class="hero-stat power">
        <div class="k">Power</div>
        <div class="hero-main gauge-wrap">
          <div class="power-meter" role="img" aria-label="${esc(powerText(power, minPower))}">${powerMeterSvg(power, minPower)}</div>
          <div class="v num" data-testid="power">${powerStr}<small>/10</small></div>
        </div>
        <div class="s"><span class="t">${esc(speedWord(power))}</span></div>
      </div>
      <div class="hero-stat spin">
        <div class="k">Spin</div>
        <div class="hero-main"><div class="spin-ball" role="img" aria-label="${esc(spinText(p.side, p.vert))}">${spinBallSvg(p.side, p.vert, 42)}</div></div>
        <div class="s" title="${esc(spinWords)}"><span class="t">${esc(plan.strokeName ?? spinWords)}</span></div>
      </div>
    </div>
    <p class="strike-line">${iconMarkup('target', 14)}<span>${plan.strokeName ? `<b>${esc(plan.strokeName)}</b> · ` : ''}strike <span data-testid="spin">${esc(spinWords)}</span></span></p>`
    : `<div class="hero blocked">
      <ul class="warnings" aria-label="Why it is not makeable">${chips(shown)}</ul>
      <div class="blocked-acts">${ctx.altPocket ? `<button type="button" class="btn primary" data-card-act="alt" data-pocket="${esc(ctx.altPocket.id)}">${iconMarkup('target', 18)}<span>Try the ${esc(ctx.altPocket.name)}</span></button>` : ''}<button type="button" class="btn secondary" data-card-act="suggest">${iconMarkup('sparkles', 18)}<span>Suggest a shot</span></button></div>
      <span class="sr-only">Cut <span data-testid="cut">${plan.cutAngleDeg.toFixed(1)}°</span>, ${esc(phrase)}. No stroke: this shot is not makeable.<span hidden data-testid="power">${powerStr}<small>/10</small></span><span hidden data-testid="spin">${esc(spinWords)}</span></span>
    </div>`;
  const html = `
  <article class="card shot${plan.makeable ? '' : ' not-makeable'}${head && plan.makeable ? ' has-warn' : ''}" data-testid="shot-card" aria-label="Shot plan">
    <header class="shot-head">
      <h2 class="title">${ballChip(ctx.targetLabel, ctx.targetColor, ctx.targetStripe)}<span class="sr-only">Ball </span><span class="target-label${/^\d+$/.test(ctx.targetLabel) ? ' sr-only' : ''}">${esc(ctx.targetLabel)}</span>${iconMarkup('arrow-right', 18, 'arrow')}<span class="pocket-name">${esc(ctx.pocketName)}</span></h2>
      <div class="chip diff diff-${diffClass}" title="${plan.makeable ? `Hit the contact point within ${esc(marginText(plan))} (aim ±${plan.toleranceDeg.toFixed(2)}°)` : 'Not makeable'}" data-testid="difficulty">${plan.makeable ? `${esc(plan.difficulty)} · ${esc(marginText(plan))}` : `${iconMarkup('alert', 14)}not makeable`}</div>
    </header>
    ${head && plan.makeable ? `<p class="head-warn warn-${head.code}">${iconMarkup('alert', 16)}<span>${esc(head.message)}</span></p>` : ''}
    ${hero}
    <div class="meta">${noStroke ? '' : src}${ctx.speedRef && !noStroke ? `<span class="pace">${iconMarkup('gauge', 14)}<span>Pace: ${esc(ctx.speedRef)}</span></span>` : ''}${corrections.length ? `<p class="corr">${iconMarkup('info', 14)}<span>${corrections.map(esc).join(' · ')}</span></p>` : ''}</div>
    ${warn ? `<ul class="warnings" aria-label="Warnings">${warn}</ul>` : ''}
    <figure class="coach">
      <span class="coach-icon">${iconMarkup('lightbulb', 18)}</span>
      <blockquote class="tip" data-testid="tip">${esc(plan.tip)}</blockquote>
    </figure>
    ${pocketPicker(ctx.pockets ?? [])}
    ${
      ctx.showDetails
        ? `<dl class="details">
      <div><dt>Contact tolerance</dt><dd>${margin ? `±${plan.toleranceMm.toFixed(1)} mm` : '—'}</dd></div>
      <div><dt>Aim tolerance</dt><dd>${margin && plan.toleranceDeg > 0 ? `±${plan.toleranceDeg.toFixed(2)}°` : '—'}</dd></div>
      ${tipMm && !noStroke ? `<div><dt>Tip offset</dt><dd>${esc(tipMm)}</dd></div>` : ''}
      <div><dt>Pocket window</dt><dd>±${plan.windowHalfDeg.toFixed(2)}°</dd></div>
      <div><dt>CB speed</dt><dd>${powerToSpeed(power).toFixed(1)} m/s</dd></div>
      <div><dt>CB speed at contact</dt><dd>${plan.cbSpeedAtContact.toFixed(2)} m/s</dd></div>
      <div><dt>OB speed</dt><dd>${plan.obSpeed.toFixed(2)} m/s</dd></div>
      <div><dt>Min power</dt><dd>${plan.minPower > 10 ? '>10' : plan.minPower.toFixed(1)}</dd></div>
    </dl>`
        : ''
    }
  </article>`;
  writeHtml(el, html, cardFocusKey);
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
