/**
 * The shot card: everything a player needs to play the shot, in player language (FR-010…FR-017,
 * FR-127). The first block (`.shot-head` + `.hero`) is the headline the bottom sheet shows at its peek
 * height: target → pocket, difficulty, cut, power and spin. Every 001 test id and text is kept.
 */
import { describeSpin, powerToSpeed, speedWord } from '../../core/shot/power';
import { squirtOffsetText, throwSentence } from '../../core/shot/coach';
import type { ShotPlan, WarningCode } from '../../core/types';
import { FRAGILE_PACE } from '../planner-client';
import type { AppState } from '../store';
import { fractionShort, fractionTile, frozenStroke, hasStroke, isFrozenPlan } from '../render/plan-draw';
import { BALL_NAMED, BALL_NEUTRAL } from '../render/palette';
import { tagText } from './ball-tags';
import { fractionGlyphSvg, type CutSide } from './fraction-glyph';
import { iconMarkup } from './icons';
import { writeHtml } from './patch';
import { meterMinPower, meterOptions, powerMeterSvg, powerText } from './power-meter';
import { spinBallSvg, spinText } from './spin-ball';

export { fractionShort, fractionTile } from '../render/plan-draw';

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
  /** A one-cushion bank is open for a shot that is not makeable (ShotPlan.bankOption): into this pocket, or with null the card's own. */
  bankOption?: { pocketName: string | null } | null;
  /** Balls that can be picked (object balls), for keyboard and screen-reader users. */
  balls?: { id: string; label: string; color?: string; stripe?: boolean }[];
  /** Pockets by name once a ball is picked. */
  pockets?: { id: string; name: string; selected: boolean }[];
  /** Cue ball → ghost-ball distance (m) and ball radius, to say the squirt aim as an offset. */
  cbDistance?: number;
  ballRadius?: number;
  /** Scratch risks of the recommended stroke under small errors (from the robustness probes). */
  risks?: { scratchIf: 'harder' | 'softer' | 'aim' | 'tip'; pocketName: string }[];
  /**
   * The recommendation behind a 'recommended' stroke (recommendationContext): no stroke was verified
   * against small speed errors (Recommendation.fragile), the search was cut short (timedOut), or its
   * scratch checks under small errors did not run (risks absent: "not known", never "safe").
   */
  fragile?: boolean;
  searchCutShort?: boolean;
  risksUnknown?: boolean;
  /**
   * The table's ball set, so a chip letters a colour-named ball as the 2D table and the 3D tags do
   * (pool: its number, snooker: R/Y/G/Br/Bl/P/Bk). Unknown (undefined): the colour's initial.
   */
  snooker?: boolean;
}

/** The card's notes on a recommendation, from store.recommended (empty unless the plan plays it). */
export function recommendationContext(rec: AppState['recommended'], plan: Pick<ShotPlan, 'strokeSource' | 'stroke'> | null): Pick<CardContext, 'fragile' | 'searchCutShort' | 'risksUnknown'> {
  if (!rec || rec.pending || !rec.stroke || !plan || plan.strokeSource !== 'recommended') return {};
  const same = rec.stroke.power === plan.stroke.power && rec.stroke.side === plan.stroke.side && rec.stroke.vert === plan.stroke.vert;
  if (!same) return {};
  return { fragile: rec.fragile === true, searchCutShort: rec.timedOut === true, risksUnknown: rec.risks === undefined };
}

/** Honesty notes on a recommended stroke (Principle II), in player words (fragile: the toast's own sentence). */
export const REC_NOTES = {
  fragile: FRAGILE_PACE,
  searchCutShort: 'Search cut short — the best stroke found in time.',
  risksUnknown: 'Scratch risk from small errors not checked.',
} as const;

/** The tip for a pocket that cannot be made and has no other pocket to offer (never "Try another pocket"). */
export const NO_OTHER_POCKET = 'No other pocket is clear for this ball: pick another ball or play a safety.';
/** The same tip when a warning on the card already says NO_OTHER_POCKET (the planner's blocked note). */
export const PICK_ANOTHER = 'Pick another ball, or tap Suggest a shot.';

/** A ball vision could not name: the neutral label 'ball' (or none). */
const unnamed = (label: string): boolean => {
  const l = label.trim().toLowerCase();
  return !l || l === 'ball';
};
/** How the card and the announcer name a ball: "Ball 3", "Ball red"; an unnamed one "Unnamed ball" (never "Ball ball"). */
export function ballWords(label: string): string {
  return unnamed(label) ? 'Unnamed ball' : `Ball ${label}`;
}

/** A row of ball buttons (the same flow as tapping a ball on the table). */
function ballPicker(balls: NonNullable<CardContext['balls']>, snooker?: boolean): string {
  if (!balls.length) return '';
  return `<div class="picker" role="group" aria-label="Pick the ball to pocket"><span class="picker-k">Or pick a ball</span><div class="picker-row">${balls
    .map((b) => `<button type="button" class="pick-ball" data-card-act="ball" data-id="${esc(b.id)}" aria-label="${esc(ballWords(b.label))}">${ballChip(b.label, b.color, b.stripe, snooker)}<span>${esc(b.label)}</span></button>`)
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
const HEADLINE_WARN: WarningCode[] = ['not-makeable', 'blocked-cue', 'blocked-object', 'cb-short', 'scratch', 'too-soft', 'kiss', 'throw-uncompensable', 'ob-missed', 'miscue-risk', 'frozen', 'thin-cut'];

/** The warning to headline (shown in the peek), or null. */
export function headlineWarning(plan: ShotPlan): ShotPlan['warnings'][number] | null {
  for (const code of HEADLINE_WARN) {
    const w = plan.warnings.find((x) => x.code === code);
    if (w) return w;
  }
  return null;
}

/**
 * Margin of error as the player feels it: millimetres of contact on the object ball; for a cue ball
 * frozen to it (no contact point to aim at) degrees of stroke angle, the margin the core rates it by.
 * None (the stroke on show misses as played, or no power works) is "±0 mm" / "±0°": short enough
 * that "very hard · ±0 mm" stays beside the title at 375 px.
 */
export function marginText(x: Pick<ShotPlan, 'toleranceMm'> & { toleranceDeg?: number; frozen?: boolean }): string {
  if (x.frozen) {
    const d = x.toleranceDeg ?? 0;
    return d > 0 ? `±${d >= 10 ? d.toFixed(0) : d.toFixed(1)}°` : '±0°';
  }
  const mm = x.toleranceMm;
  return mm > 0 ? `±${mm >= 10 ? mm.toFixed(0) : mm.toFixed(1)} mm` : '±0 mm';
}

/** The difficulty chip's words and its title (hover/long-press), for a makeable plan. */
function difficultyChip(plan: ShotPlan, frozen: boolean): { text: string; title: string } {
  const m = marginText({ ...plan, frozen });
  const text = `${plan.difficulty} · ${m}`;
  if (!((frozen ? plan.toleranceDeg : plan.toleranceMm) > 0))
    return {
      text,
      // (A frozen ball the core's probes put just outside the pocket can still drop in the full simulation.)
      title: plan.obPocketed ? 'No margin: at this speed no stroke sends it clearly inside the pocket, so a small error misses' : 'No margin: the stroke on show does not pot it as played (see the warning)',
    };
  if (frozen) return { text, title: `Stroke within ${m} of the angle shown (balls frozen: no contact point to aim at)` };
  return { text, title: `Hit the contact point within ${m} (aim ±${plan.toleranceDeg.toFixed(2)}°)` };
}

/** Two letters where colour names share an initial (blue, black, brown), as the ball tags write them. */
const CHIP_TWO: Record<string, string> = { blue: 'Bl', black: 'Bk', brown: 'Br' };

/**
 * The chip's letter: the number, nothing for a ball vision could not name ('ball'); with the table
 * known, the 3D tags' text (ball-tags.ts tagText: on a pool table a colour's number, "yellow stripe"
 * → 9; snooker R/Y/G/Br/Bl/P/Bk); with it unknown, the colour's initial (Bl/Bk/Br where shared).
 */
export function chipLetter(label: string, snooker?: boolean): string {
  if (/^\d+$/.test(label)) return label;
  const word = label.trim().toLowerCase().split(/\s+/)[0] ?? '';
  if (!word || word === 'ball') return '';
  if (snooker !== undefined) return tagText({ kind: 'object', label, id: label }, snooker);
  return CHIP_TWO[word] ?? word.charAt(0).toUpperCase();
}

/**
 * A tiny pool-ball chip: the ball colour, a white number disc, a band for stripes. An unnamed ball
 * without a colour is neutral grey (BALL_NEUTRAL, as on the 2D table), never the cue ball's ivory.
 */
export function ballChip(label: string, color?: string, stripe?: boolean, snooker?: boolean): string {
  const isCue = label === 'cue' || label === 'white' || label === 'white?';
  const short = isCue ? '' : chipLetter(label, snooker);
  const word = label.trim().toLowerCase().split(/\s+/)[0] ?? '';
  const bg = isCue ? '#F4F1E8' : (color ?? BALL_NAMED[word] ?? (unnamed(label) ? BALL_NEUTRAL : '#E9E6DC'));
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
    </div>${ctx.pockets?.length ? pocketPicker(ctx.pockets) : ballPicker(ctx.balls ?? [], ctx.snooker)}`,
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
  // The reason already says it: no thin-cut note, and no generic "frozen … plus a little throw" hint
  // next to a not-makeable reason (frozen-line geometry, or snooker's touching-ball rule).
  const notMakeable = plan.warnings.some((x) => x.code === 'not-makeable');
  const shown = ordered.filter((w, i) => !(notMakeable && (w.code === 'thin-cut' || w.code === 'frozen')) && ordered.findIndex((x) => x.message === w.message) === i);
  const chips = (list: typeof shown) => list.map((w) => `<li class="warn-chip warn-${w.code}">${iconMarkup('alert', 18)}<span>${esc(w.message)}</span></li>`).join('');
  const RISK_HOW = { harder: 'A little harder', softer: 'A little softer', tip: 'With the tip a little off', aim: 'With a small aim error' } as const;
  const riskChips = (ctx.risks ?? []).map((r) => `<li class="warn-chip warn-risk">${iconMarkup('alert', 18)}<span>Scratch risk: ${esc(RISK_HOW[r.scratchIf].toLowerCase())} and the cue ball goes in the ${esc(r.pocketName)}.</span></li>`).join('');
  // A shot that cannot happen as planned gets no stroke instructions (no power, no spin, no aim fixes).
  const noStroke = !hasStroke(plan);
  const frozen = isFrozenPlan(plan);
  // Makeable: the headline warning is already shown above the hero (.head-warn); the list below has
  // the others, so no warning appears twice.
  const warn = plan.makeable ? chips(shown.filter((w) => !head || w.message !== head.message)) + riskChips : '';
  // A margin exists only for a shot that can be made (the planner's value goes negative past 90°). A
  // frozen cue ball has no contact point to aim at: its margin is the stroke angle's (degrees).
  const margin = plan.makeable && plan.toleranceMm > 0;
  const diffChip = plan.makeable ? difficultyChip(plan, frozen) : null;
  const tipMm = ctx.ballRadius ? tipOffsetMm(p, ctx.ballRadius) : null;
  const src =
    plan.strokeSource === 'player'
      ? `<span class="badge">${iconMarkup('hand', 14)}your stroke</span>`
      : plan.strokeSource === 'recommended'
        ? `<span class="badge good">${iconMarkup('check', 14)}recommended for position</span>`
        : `<span class="badge">${ctx.recommendedPending ? '<span class="spinner" aria-hidden="true"></span> optimising position…' : 'basic stroke'}</span>`;
  // What the search could not vouch for (only for the recommended stroke being shown).
  const notes = plan.strokeSource === 'recommended' && !noStroke ? (['fragile', 'searchCutShort', 'risksUnknown'] as const).filter((k) => ctx[k]).map((k) => REC_NOTES[k]) : [];
  // Aim corrections the coaching tip does not already spell out.
  const corrections: string[] = [];
  const tipSquirt = plan.tip.includes('blue line');
  const tipThrow = /[Tt]hrow/.test(plan.tip);
  if (!noStroke && Math.abs(plan.squirtDeg) >= 0.1 && !tipSquirt) {
    const off = ctx.cbDistance && ctx.ballRadius ? squirtOffsetText(plan.squirtDeg, plan.stroke.side, ctx.cbDistance, ctx.ballRadius) : null;
    corrections.push(off ? `Squirt: aim the cue ${off} (${Math.abs(plan.squirtDeg).toFixed(1)}°)` : `Aim the cue ${Math.abs(plan.squirtDeg).toFixed(1)}° ${plan.squirtDeg > 0 ? 'right' : 'left'} of the blue line (squirt)`);
  }
  // The stroke's side names the cause: outside english for a thicker shift, no "side-spin" on a centre-ball hit.
  const throwAim = plan.throwAim ?? plan.throwShiftDir ?? null;
  if (!noStroke && Math.abs(plan.throwDeg) >= 0.1 && throwAim && !tipThrow) corrections.push(throwSentence({ ...plan, throwAim, side: p.side }));
  // The meter's minimum and its "only just drops" band (minPowerCapture..minPower); a frozen cue ball's
  // minimum moves with the power (its warning names the powers that work), so it gets no band, and
  // past 10 no power works ("No power gets it in with pace", never "more than full power").
  const minPower = meterMinPower(plan);
  const meterOpts = meterOptions(plan);
  // Frozen, the stroke angle off the line of centres plays the cut's part (no ghost ball, cut 0). At the
  // peek with a headline warning the tile's captions step aside (styles.css), so the numeral's own row
  // says it: "FROZEN" over "12° stroke left" (.fz-k is the caption again for sight only; .fz-side is
  // read there, where the line below it is hidden).
  const fz = frozen ? frozenStroke(plan, plan.ghost) : null;
  const frozenMsg = plan.warnings.find((w) => w.code === 'frozen')?.message ?? 'Frozen: the object ball goes along the line of centres.';
  // Not makeable and no other pocket: never "Try another pocket". When a warning shown on the card
  // already says so (the planner's blocked note), the tip says what to do instead, not the same again.
  const noAlt = !plan.makeable && plan.alternatives.length === 0;
  const tip = noAlt ? (shown.some((w) => w.message.includes(NO_OTHER_POCKET)) ? PICK_ANOTHER : NO_OTHER_POCKET) : plan.tip;
  const powerStr = power.toFixed(power % 1 ? 1 : 0);
  const phrase = plan.fractionPhrase ?? `${plan.fractionLabel}-ball`;
  const spinWords = describeSpin(p);
  // A stroke name with side ("Follow, right english", up to "Stun-run-through, right english") does
  // not fit the one-line tile at 375–393 px: it takes two lines there, the stroke and the side, and
  // the ball shrinks by a line (styles.css) so the tile keeps the hero's height.
  const sideName = plan.strokeName ? /^(.+), ((?:left|right) english)$/.exec(plan.strokeName) : null;
  const hero = plan.makeable
    ? `<div class="hero">
      ${
        fz
          ? `<div class="hero-stat cut frozen">
        <div class="k">Frozen</div>
        <div class="hero-main"><span class="fz-k" aria-hidden="true">Frozen</span><div class="v num" data-testid="cut">${fz.deg}°</div><span class="fz-side">${fz.side === 'straight' ? 'straight' : `stroke ${fz.side}`}</span></div>
        <div class="s" title="${esc(frozenMsg)}"><span class="t">${fz.side === 'straight' ? 'straight' : `stroke ${fz.side}`}</span><span class="sr-only"> (${fz.side === 'straight' ? 'stroke straight through the line of centres' : `stroke ${fz.deg}° ${fz.side} of the line of centres`}; no ghost ball)</span></div>
      </div>`
          : `<div class="hero-stat cut">
        <div class="k">Cut</div>
        <div class="hero-main"><div class="v num" data-testid="cut">${plan.cutAngleDeg.toFixed(1)}°</div></div>
        <div class="s" title="${esc(phrase)}">${fractionGlyphSvg(plan.fraction, cutSideOf(plan.cutSide))}<span class="t">${esc(fractionTile(plan))}</span>${fractionTile(plan) !== fractionShort(plan) ? `<span class="sr-only"> (${esc(phrase)})</span>` : ''}</div>
      </div>`
      }
      <div class="hero-stat power">
        <div class="k">Power</div>
        <div class="hero-main gauge-wrap">
          <div class="power-meter" role="img" aria-label="${esc(powerText(power, minPower, meterOpts))}">${powerMeterSvg(power, minPower, meterOpts)}</div>
          <div class="v num" data-testid="power">${powerStr}<small>/10</small></div>
        </div>
        <div class="s"><span class="t">${esc(speedWord(power))}</span></div>
      </div>
      <div class="hero-stat spin${sideName ? ' two' : ''}">
        <div class="k">Spin</div>
        <div class="hero-main"><div class="spin-ball" role="img" aria-label="${esc(spinText(p.side, p.vert))}">${spinBallSvg(p.side, p.vert, 42)}</div></div>
        <div class="s" title="${esc(spinWords)}">${sideName ? `<span class="t">${esc(sideName[1]!)},</span> <span class="t2">${esc(sideName[2]!)}</span>` : `<span class="t">${esc(plan.strokeName ?? spinWords)}</span>`}</div>
      </div>
    </div>
    <p class="strike-line">${iconMarkup('target', 14)}<span>${plan.strokeName ? `<b>${esc(plan.strokeName)}</b> · ` : ''}strike <span data-testid="spin">${esc(spinWords)}</span></span></p>`
    : `<div class="hero blocked">
      <ul class="warnings" aria-label="Why it is not makeable">${chips(shown)}</ul>
      <div class="blocked-acts">${ctx.altPocket ? `<button type="button" class="btn primary" data-card-act="alt" data-pocket="${esc(ctx.altPocket.id)}">${iconMarkup('target', 18)}<span>Try the ${esc(ctx.altPocket.name)}</span></button>` : ''}${ctx.bankOption ? `<button type="button" class="btn ${ctx.altPocket ? 'secondary' : 'primary'}" data-card-act="bank">${iconMarkup('swap', 18)}<span>${ctx.bankOption.pocketName ? `Bank it into the ${esc(ctx.bankOption.pocketName)}` : 'Bank it off a cushion'}</span></button>` : ''}<button type="button" class="btn secondary" data-card-act="suggest">${iconMarkup('sparkles', 18)}<span>Suggest a shot</span></button></div>
      <span class="sr-only">${frozen ? `Balls frozen together.<span hidden data-testid="cut">${plan.cutAngleDeg.toFixed(1)}°</span>` : `Cut <span data-testid="cut">${plan.cutAngleDeg.toFixed(1)}°</span>, ${esc(phrase)}.`} No stroke: this shot is not makeable.<span hidden data-testid="power">${powerStr}<small>/10</small></span><span hidden data-testid="spin">${esc(spinWords)}</span></span>
    </div>`;
  const html = `
  <article class="card shot${plan.makeable ? '' : ' not-makeable'}${head && plan.makeable ? ' has-warn' : ''}" data-testid="shot-card" aria-label="Shot plan">
    <header class="shot-head">
      <h2 class="title">${ballChip(ctx.targetLabel, ctx.targetColor, ctx.targetStripe, ctx.snooker)}<span class="sr-only">${unnamed(ctx.targetLabel) ? 'Unnamed ' : 'Ball '}</span><span class="target-label${/^\d+$/.test(ctx.targetLabel) ? ' sr-only' : ''}">${esc(ctx.targetLabel)}</span>${iconMarkup('arrow-right', 18, 'arrow')}<span class="pocket-name">${esc(ctx.pocketName)}</span></h2>
      <div class="chip diff diff-${diffClass}" title="${diffChip ? esc(diffChip.title) : 'Not makeable'}" data-testid="difficulty">${diffChip ? esc(diffChip.text) : `${iconMarkup('alert', 14)}not makeable`}</div>
    </header>
    ${head && plan.makeable ? `<p class="head-warn warn-${head.code}">${iconMarkup('alert', 16)}<span>${esc(head.message)}</span></p>` : ''}
    ${hero}
    <div class="meta">${noStroke ? '' : src}${ctx.speedRef && !noStroke ? `<span class="pace">${iconMarkup('gauge', 14)}<span>Pace: ${esc(ctx.speedRef)}</span></span>` : ''}${corrections.length ? `<p class="corr">${iconMarkup('info', 14)}<span>${corrections.map(esc).join(' · ')}</span></p>` : ''}${notes.length ? `<p class="rec-note">${iconMarkup('info', 14)}<span>${notes.map(esc).join(' ')}</span></p>` : ''}</div>
    ${warn ? `<ul class="warnings" aria-label="Warnings">${warn}</ul>` : ''}
    <figure class="coach">
      <span class="coach-icon">${iconMarkup('lightbulb', 18)}</span>
      <blockquote class="tip" data-testid="tip">${esc(tip)}</blockquote>
    </figure>
    ${pocketPicker(ctx.pockets ?? [])}
    ${
      ctx.showDetails
        ? `<dl class="details">
      <div><dt>Contact tolerance</dt><dd>${margin && !frozen ? `±${plan.toleranceMm.toFixed(1)} mm` : '—'}</dd></div>
      ${
        frozen
          ? `<div><dt>Stroke-angle tolerance</dt><dd>${plan.makeable && plan.toleranceDeg > 0 ? `±${plan.toleranceDeg.toFixed(1)}°` : '—'}</dd></div>`
          : `<div><dt>Aim tolerance</dt><dd>${margin && plan.toleranceDeg > 0 ? `±${plan.toleranceDeg.toFixed(2)}°` : '—'}</dd></div>`
      }
      ${tipMm && !noStroke ? `<div><dt>Tip offset</dt><dd>${esc(tipMm)}</dd></div>` : ''}
      <div><dt>Pocket window</dt><dd>±${plan.windowHalfDeg.toFixed(2)}°</dd></div>
      <div><dt>CB speed</dt><dd>${powerToSpeed(power).toFixed(1)} m/s</dd></div>
      <div><dt>CB speed at contact</dt><dd>${plan.cbSpeedAtContact.toFixed(2)} m/s</dd></div>
      <div><dt>OB speed</dt><dd>${plan.obSpeed.toFixed(2)} m/s</dd></div>
      <div><dt>Min power</dt><dd>${minPower === null ? '—' : minPower > 10 ? (meterOpts.frozen ? 'none' : '>10') : minPower.toFixed(1)}</dd></div>
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
