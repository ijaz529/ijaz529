/**
 * Fractional-aim glyph (FR-127): the object ball and the cue ball as seen from behind the cue ball,
 * overlapping by the hit fraction (1 = full ball, ½ = half-ball, 0 = thinnest edge hit).
 * The centre offset is 2R(1 − fraction): a cut to the left means the cue ball covers the right side
 * of the object ball.
 */

let uid = 0;

export type CutSide = 'left' | 'right' | 'straight';

/** Player-facing description of the overlap (the glyph's text equivalent). */
export function fractionText(fraction: number, cutSide: CutSide): string {
  const f = Math.max(0, Math.min(1, fraction));
  const pct = Math.round(f * 100);
  const what = pct >= 97 ? 'Full-ball hit' : `${pct}% ball overlap`;
  return cutSide === 'straight' || pct >= 97 ? `${what}, straight` : `${what}, cut to the ${cutSide}`;
}

/** Horizontal centre offset of the cue ball relative to the object ball, in ball radii (signed). */
export function glyphOffset(fraction: number, cutSide: CutSide): number {
  const f = Math.max(0, Math.min(1, fraction));
  const off = 2 * (1 - f);
  return cutSide === 'left' ? off : cutSide === 'right' ? -off : 0;
}

export function fractionGlyphSvg(fraction: number, cutSide: CutSide, id = `fg${++uid}`): string {
  const R = 13;
  const off = glyphOffset(fraction, cutSide) * R;
  const ob = { x: 32 - off / 2, y: 20 };
  const cb = { x: 32 + off / 2, y: 20 };
  const title = fractionText(fraction, cutSide);
  return `<svg class="fraction-glyph" viewBox="0 0 64 40" width="64" height="40" role="img" aria-label="${title}" focusable="false">
    <title>${title}</title>
    <defs>
      <radialGradient id="${id}-ob" cx="36%" cy="30%" r="80%"><stop offset="0" stop-color="#FFD27A"/><stop offset="0.55" stop-color="#E69F00"/><stop offset="1" stop-color="#8A5A00"/></radialGradient>
      <clipPath id="${id}-c"><circle cx="${cb.x.toFixed(2)}" cy="${cb.y}" r="${R}"/></clipPath>
    </defs>
    <circle cx="${ob.x.toFixed(2)}" cy="${ob.y}" r="${R}" fill="url(#${id}-ob)"/>
    <circle cx="${ob.x.toFixed(2)}" cy="${ob.y}" r="${R}" fill="#56B4E9" fill-opacity="0.85" clip-path="url(#${id}-c)"/>
    <circle cx="${cb.x.toFixed(2)}" cy="${cb.y}" r="${R - 0.6}" fill="rgba(255,255,255,0.12)" stroke="#FFFFFF" stroke-width="1.6" stroke-dasharray="2.4 2.2"/>
    <path d="M${cb.x.toFixed(2)} ${cb.y + R + 4}V${cb.y - R + 3}" stroke="#0072B2" stroke-width="2.4" stroke-linecap="round"/>
    <path d="M${cb.x.toFixed(2)} ${cb.y + R + 4}V${cb.y - R + 3}" stroke="#A8D8F5" stroke-width="0.9" stroke-linecap="round"/>
  </svg>`;
}

export function renderFractionGlyph(fraction: number, cutSide: CutSide): SVGSVGElement {
  const tpl = document.createElement('template');
  tpl.innerHTML = fractionGlyphSvg(fraction, cutSide);
  return tpl.content.firstElementChild as SVGSVGElement;
}
