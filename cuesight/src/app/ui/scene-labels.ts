/**
 * In-scene shot label (feature 002 US1/US3): a glass pill pinned next to the cue ball on the 3D
 * table with a leader line, answering "how hard, and where do I hit it" where the player is looking.
 *
 * - Top / Orbit views: the strike point face-on on a small cue ball (high is up, as coaches draw it),
 *   the power as n/10, a speed word and a 10-step bar, and the stroke in words.
 * - Player view: the strike point is drawn ON the cue ball itself (a face-on disc over the ball, the
 *   same mark as Snap's photo guide), so the label shrinks to the power and the stroke's name.
 * - A shot that cannot happen as planned gets no stroke: the label says why and what to try.
 *
 * It follows the cue ball every frame (camera moves, transitions), sits where it covers the fewest
 * plan lines and balls and never the cue stick, never takes taps (pointer-events: none) and is hidden
 * from assistive tech (the shot card and the live region say the same thing).
 */
import { advisePower, describeSpin, powerFigure, speedWord } from '../../core/shot/power';
import type { PocketId, ShotPlan, Stroke } from '../../core/types';
import { isFrozenPlan } from '../render/plan-draw';
import { BALL_AVOID_WEIGHT, type FrameInfo } from '../render3d';
import { strikeFace } from '../snap/guide';
import { iconMarkup } from './icons';
import { placeLabel, type Box, type LabelSide, type Pt } from './label-place';
import { spinBallSvg } from './spin-ball';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * 10-step power bar (filled to the power, half steps for .5). One hue (white → sky by intensity):
 * the plan's line colours (orange, blue, green) mean paths, not speeds.
 */
export function powerBarSvg(power: number, w = 112, h = 6): string {
  const gap = 2;
  const sw = (w - gap * 9) / 10;
  let out = '';
  for (let i = 0; i < 10; i++) {
    const x = i * (sw + gap);
    const v = power - i;
    const f = v >= 0.75 ? 1 : v >= 0.25 ? 0.5 : 0;
    out += `<rect x="${x.toFixed(1)}" y="0" width="${sw.toFixed(1)}" height="${h}" rx="1.5" fill="rgba(255,255,255,0.14)"/>`;
    if (f > 0) out += `<rect class="seg on" x="${x.toFixed(1)}" y="0" width="${(sw * f).toFixed(1)}" height="${h}" rx="1.5" fill="${powerRamp(i)}"/>`;
  }
  return `<svg class="power-bar" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true" focusable="false">${out}</svg>`;
}

/** Single-hue ramp for step i (0–9): from soft white to the accent sky. */
export function powerRamp(i: number): string {
  const t = Math.max(0, Math.min(1, i / 9));
  const mix = (a: number, b: number) => Math.round(a + (b - a) * t);
  return `rgb(${mix(214, 86)},${mix(226, 180)},${mix(240, 233)})`;
}

export type LabelContent =
  | { kind: 'stroke'; stroke: Pick<Stroke, 'power' | 'side' | 'vert'>; name?: string | null }
  | { kind: 'warn'; text: string; sub?: string };

/**
 * What the in-scene label says for a plan (main.ts calls it on every render): the stroke, or for a
 * shot that cannot happen as planned, why in a few words and what to try — the card's reason, never
 * a generic failure:
 * - a ball in the way; balls frozen together (pool: only the line of centres); snooker's touching
 *   ball (moving it is a push stroke, a foul: play away from it); otherwise "Not makeable";
 * - the cue ball stopping short, with the power the warning quotes (advisePower, a half step).
 * `pending`: a provisional stroke about to be replaced by the recommended one — say nothing yet.
 */
export function planLabelContent(p: ShotPlan | null, names: Partial<Record<PocketId, string>>, opts: { pending?: boolean; snooker?: boolean } = {}): LabelContent | null {
  if (!p) return null;
  if (opts.pending && p.strokeSource !== 'player' && p.makeable) return null;
  const alt = p.alternatives[0];
  const elsewhere = alt ? `Try the ${names[alt.pocketId] ?? alt.pocketId}` : 'Pick another ball or play a safety';
  if (!p.makeable) {
    const frozen = isFrozenPlan(p) && p.warnings.some((w) => w.code === 'not-makeable');
    if (frozen && opts.snooker) return { kind: 'warn', text: 'Not makeable · touching ball', sub: 'Play away from it (a push is a foul)' };
    if (frozen) return { kind: 'warn', text: 'Not makeable · balls frozen together', sub: elsewhere };
    const blocked = p.warnings.some((w) => w.code === 'blocked-cue' || w.code === 'blocked-object');
    return { kind: 'warn', text: blocked ? 'Not makeable · a ball is in the way' : 'Not makeable', sub: elsewhere };
  }
  if (p.warnings.some((w) => w.code === 'cb-short'))
    return { kind: 'warn', text: 'Too soft: the cue ball stops short', sub: p.minPower <= 10 ? `Use power ${powerFigure(advisePower(p.minPower))}+` : 'Too far even at full power' };
  return { kind: 'stroke', stroke: p.stroke, name: p.strokeName };
}

/** Inner markup of the label for a stroke; `compact` (Player view) drops the mini cue ball. */
export function shotLabelMarkup(stroke: Pick<Stroke, 'power' | 'side' | 'vert'>, opts: { compact?: boolean; name?: string | null; noBall?: boolean } = {}): string {
  const p = stroke.power;
  const pw = p.toFixed(p % 1 ? 1 : 0);
  const spin = describeSpin(stroke);
  const strike = opts.compact ? (opts.name ?? spin) : opts.name ? `${opts.name} · ${spin}` : spin;
  // On a small table view the mini ball goes (the words still say where to strike).
  if (opts.noBall && !opts.compact) opts = { ...opts, compact: true };
  return `${opts.compact ? '' : `<span class="sl-ball">${spinBallSvg(stroke.side, stroke.vert, 38, 'sl')}</span>`}
    <span class="sl-body">
      <span class="sl-power"><b class="num">${esc(pw)}</b><small>/10</small><span class="sl-word">${esc(speedWord(p))}</span></span>
      ${powerBarSvg(p, opts.compact ? 104 : 112)}
      <span class="sl-strike">${esc(strike)}</span>
    </span>`;
}

/** Markup for a shot that cannot be played as planned: the reason and what to try, no stroke. */
export function warnLabelMarkup(text: string, sub?: string): string {
  return `<span class="sl-warn-ic">${iconMarkup('alert', 18)}</span><span class="sl-body"><span class="sl-warn">${esc(text)}</span>${sub ? `<span class="sl-strike">${esc(sub)}</span>` : ''}</span>`;
}

/** The face-on strike disc drawn over the cue ball in Player view (SVG, viewBox −1…1). */
export function strikeFaceSvg(side: number, vert: number): string {
  // Computed at 100 px and scaled to the unit disc (strikeFace's minimum dot size is in px).
  const g = strikeFace({ x: 0, y: 0 }, 100, side, vert);
  const f = { dot: { x: g.dot.x / 100, y: g.dot.y / 100 }, dotR: g.dotR / 100, miscueR: g.miscueR / 100 };
  return `<svg viewBox="-1.08 -1.08 2.16 2.16" aria-hidden="true" focusable="false">
    <circle r="1" fill="rgba(246,243,234,0.86)" stroke="rgba(7,11,20,0.55)" stroke-width="0.07"/>
    <circle r="0.985" fill="none" stroke="#fff" stroke-width="0.03"/>
    <path d="M-1 0H1M0 -1V1" stroke="rgba(7,11,20,0.45)" stroke-width="0.022"/>
    <circle r="${f.miscueR}" fill="none" stroke="#D55E00" stroke-width="0.035" stroke-dasharray="0.07 0.07"/>
    <circle cx="${f.dot.x.toFixed(3)}" cy="${f.dot.y.toFixed(3)}" r="${(f.dotR + 0.06).toFixed(3)}" fill="rgba(7,11,20,0.5)"/>
    <circle class="tip-dot" cx="${f.dot.x.toFixed(3)}" cy="${f.dot.y.toFixed(3)}" r="${f.dotR.toFixed(3)}" fill="#0072B2" stroke="#fff" stroke-width="0.05"/>
    <circle cx="${f.dot.x.toFixed(3)}" cy="${f.dot.y.toFixed(3)}" r="0.035" fill="#fff"/>
  </svg>`;
}

export interface ShotLabel {
  /**
   * Called after every 3D frame; `content` null hides the label. `blocked`: screen rects of floating
   * controls over the table (Play, slow motion) the label must not slide under.
   */
  update(info: FrameInfo | null, content: LabelContent | null, show: boolean, blocked?: readonly Box[]): void;
  hide(): void;
  readonly el: HTMLElement;
}

/** A floating control's rect as one avoid point: its centre, half its diagonal, a ball's weight. */
export function blockedPoint(b: Box): Pt {
  return { x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2, w: BALL_AVOID_WEIGHT, r: Math.hypot(b.right - b.left, b.bottom - b.top) / 2 };
}

/** Below this on-screen radius (px) the strike disc over the ball is not drawn (the label keeps its mini ball). */
export const FACE_MIN_R = 14;

export function createShotLabel(host: HTMLElement): ShotLabel {
  const el = document.createElement('div');
  el.className = 'scene-label';
  el.setAttribute('aria-hidden', 'true');
  el.hidden = true;
  const lead = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  lead.setAttribute('class', 'scene-lead');
  lead.setAttribute('aria-hidden', 'true');
  lead.innerHTML = '<line x1="0" y1="0" x2="0" y2="0"/><circle r="2.5" cx="0" cy="0"/>';
  const line = lead.querySelector('line')!;
  const dot = lead.querySelector('circle')!;
  const face = document.createElement('div');
  face.className = 'strike-face';
  face.setAttribute('aria-hidden', 'true');
  face.hidden = true;
  host.append(face, lead, el);
  let key = '';
  let faceKey = '';
  let size = { w: 0, h: 0 };
  let lastSide: LabelSide | null = null;
  let lastPreset: FrameInfo['preset'] | null = null;

  const hide = () => {
    el.hidden = true;
    face.hidden = true;
    lead.style.display = 'none';
  };
  hide();
  return {
    el,
    hide,
    update(info, content, show, blocked = []) {
      if (!show || !info || !content || !info.cue || info.playing) return hide();
      const c = info.cue;
      const player = info.preset === 'player';
      // Player view: the strike point on the ball itself when the ball is big enough to read.
      const onBall = player && content.kind === 'stroke' && c.r >= FACE_MIN_R;
      const narrow = !onBall && (info.free.right - info.free.left < 340 || info.free.bottom - info.free.top < 420);
      const k = content.kind === 'stroke' ? `s|${content.stroke.power}|${content.stroke.side}|${content.stroke.vert}|${content.name ?? ''}|${onBall}|${narrow}` : `w|${content.text}|${content.sub ?? ''}`;
      if (k !== key) {
        key = k;
        el.innerHTML = content.kind === 'stroke' ? shotLabelMarkup(content.stroke, { compact: onBall, name: content.name ?? null, noBall: narrow }) : warnLabelMarkup(content.text, content.sub);
        el.classList.toggle('warn', content.kind === 'warn');
        el.classList.toggle('compact', onBall);
        el.classList.toggle('noball', narrow && content.kind === 'stroke');
        size = { w: 0, h: 0 };
      }
      const hb = host.getBoundingClientRect();
      if (onBall && content.kind === 'stroke') {
        const fk = `${content.stroke.side}|${content.stroke.vert}`;
        if (fk !== faceKey) {
          faceKey = fk;
          face.innerHTML = strikeFaceSvg(content.stroke.side, content.stroke.vert);
        }
        const r = c.r * 0.97;
        face.hidden = false;
        face.style.width = face.style.height = `${Math.round(2 * r)}px`;
        face.style.transform = `translate(${Math.round(c.x - hb.left - r)}px, ${Math.round(c.y - hb.top - r)}px)`;
      } else face.hidden = true;
      el.hidden = false;
      if (!size.w) {
        const r = el.getBoundingClientRect();
        size = { w: Math.ceil(r.width), h: Math.ceil(r.height) };
      }
      const free = { left: info.free.left + 6, top: info.free.top + 6, right: info.free.right - 6, bottom: info.free.bottom - 6 };
      if (c.x < free.left - c.r || c.x > free.right + c.r || c.y < free.top - c.r || c.y > free.bottom + c.r || free.right - free.left < size.w || free.bottom - free.top < size.h) {
        el.hidden = true;
        lead.style.display = 'none';
        return;
      }
      // Keep the previous side first to avoid flicker while the camera moves (within one view: a new
      // view starts from its own preference, so coming back to a view puts the label where it was). In
      // Player view the cue stick runs down from the ball: never below it.
      if (info.preset !== lastPreset) {
        lastPreset = info.preset;
        lastSide = null;
      }
      const prefer: LabelSide[] = player ? ['left', 'right', 'above-left', 'above-right', 'above'] : ['right', 'left', 'above-right', 'above-left', 'below-right', 'below-left', 'above', 'below'];
      // Hysteresis only while things move: at rest the label goes to the best side for this view, so
      // the same view always shows it in the same place.
      if (info.moving && lastSide && prefer.includes(lastSide)) prefer.splice(prefer.indexOf(lastSide), 1), prefer.unshift(lastSide);
      // Slides a few px where that keeps a ball's disc (or a line) clear.
      // A floating control counts like a ball (its centre and half its diagonal): the label must not
      // end up under Play or the slow-motion toggle while keeping clear of the balls.
      const avoid = blocked.length ? [...info.avoid, ...blocked.map(blockedPoint)] : info.avoid;
      const pl = placeLabel({ x: c.x, y: c.y, r: Math.max(6, c.r) }, size, avoid, free, { gap: 16, prefer, slide: true });
      lastSide = pl.side;
      el.style.transform = `translate(${Math.round(pl.x - hb.left)}px, ${Math.round(pl.y - hb.top)}px)`;
      // Leader: from the label edge to the cue ball's rim.
      const dx = pl.lead.x - c.x;
      const dy = pl.lead.y - c.y;
      const L = Math.hypot(dx, dy) || 1;
      const rim = { x: c.x + (dx / L) * Math.max(4, c.r + 2), y: c.y + (dy / L) * Math.max(4, c.r + 2) };
      lead.style.display = L > c.r + 6 ? 'block' : 'none';
      line.setAttribute('x1', String(Math.round(pl.lead.x - hb.left)));
      line.setAttribute('y1', String(Math.round(pl.lead.y - hb.top)));
      line.setAttribute('x2', String(Math.round(rim.x - hb.left)));
      line.setAttribute('y2', String(Math.round(rim.y - hb.top)));
      dot.setAttribute('cx', String(Math.round(rim.x - hb.left)));
      dot.setAttribute('cy', String(Math.round(rim.y - hb.top)));
    },
  };
}
