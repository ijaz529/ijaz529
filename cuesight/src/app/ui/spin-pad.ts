/**
 * Tip-position control: tap or drag on the cue-ball face (FR-018). The dashed ring is the miscue
 * limit (½ R); the hollow ring shows the recommended tip.
 */
import { MISCUE_LIMIT } from '../../core/physics/analytic';
import { clampTip } from '../../core/physics/strike';
import { describeSpin } from '../../core/shot/power';
import { sphereBody, sphereDefs } from './spin-ball';

export interface SpinPad {
  el: HTMLElement;
  set(side: number, vert: number, recommended?: { side: number; vert: number } | null): void;
}

const NS = 'http://www.w3.org/2000/svg';
let padId = 0;

/** The slider's value for assistive tech: tip offset from centre in % of the ball radius (0 … 50, the miscue limit), and its words. */
export function padValue(side: number, vert: number): { now: number; text: string } {
  return { now: Math.round(Math.min(MISCUE_LIMIT, Math.hypot(side, vert)) * 100), text: describeSpin({ side, vert }) };
}

export function createSpinPad(onChange: (side: number, vert: number) => void): SpinPad {
  const size = 132;
  const c = size / 2;
  const r = (46 / 100) * size; // the sphere body is drawn in a 0..100 box with radius 46
  const el = document.createElement('div');
  el.className = 'spin-pad';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('role', 'slider');
  svg.setAttribute('aria-label', 'Cue tip position: drag to set spin');
  // ARIA 1.2 requires a slider's value: the offset magnitude in % of R; the words say where.
  svg.setAttribute('aria-valuemin', '0');
  svg.setAttribute('aria-valuemax', String(Math.round(MISCUE_LIMIT * 100)));
  svg.setAttribute('aria-valuenow', '0');
  svg.setAttribute('aria-valuetext', 'centre ball');
  svg.setAttribute('tabindex', '0');
  const id = `pad${++padId}`;
  svg.innerHTML = `
    <g transform="scale(${size / 100})">${sphereDefs(id)}${sphereBody(id)}</g>
    <circle class="rec" r="10" fill="none" stroke="#0072B2" stroke-width="2.5" stroke-dasharray="3 2"/>
    <circle class="tip-shadow" r="11" fill="rgba(0,0,0,0.28)"/>
    <circle class="tip" r="10" fill="#0072B2" stroke="#fff" stroke-width="2.5"/>`;
  el.appendChild(svg);
  const tip = svg.querySelector('.tip') as SVGCircleElement;
  const tipShadow = svg.querySelector('.tip-shadow') as SVGCircleElement;
  const rec = svg.querySelector('.rec') as SVGCircleElement;
  const place = (node: SVGCircleElement, side: number, vert: number) => {
    node.setAttribute('cx', String(c + side * r));
    node.setAttribute('cy', String(c - vert * r));
    if (node === tip) {
      tipShadow.setAttribute('cx', String(c + side * r));
      tipShadow.setAttribute('cy', String(c - vert * r + 2));
      const v = padValue(side, vert);
      svg.setAttribute('aria-valuenow', String(v.now));
      svg.setAttribute('aria-valuetext', v.text);
    }
  };
  const fromEvent = (e: PointerEvent) => {
    const b = svg.getBoundingClientRect();
    const x = ((e.clientX - b.left) / b.width) * size;
    const y = ((e.clientY - b.top) / b.height) * size;
    const t = clampTip((x - c) / r, (c - y) / r);
    // Snap near the centre so "centre ball" is easy to hit.
    const side = Math.abs(t.side) < 0.03 ? 0 : t.side;
    const vert = Math.abs(t.vert) < 0.03 ? 0 : t.vert;
    place(tip, side, vert);
    onChange(Math.round(side * 100) / 100, Math.round(vert * 100) / 100);
  };
  let dragging = false;
  svg.addEventListener('pointerdown', (e) => {
    dragging = true;
    svg.setPointerCapture(e.pointerId);
    fromEvent(e);
  });
  svg.addEventListener('pointermove', (e) => dragging && fromEvent(e));
  svg.addEventListener('pointerup', () => (dragging = false));
  svg.addEventListener('keydown', (e) => {
    const cur = { side: (Number(tip.getAttribute('cx')) - c) / r, vert: (c - Number(tip.getAttribute('cy'))) / r };
    const step = 0.0625;
    const map: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    const d = map[e.key];
    if (!d) return;
    e.preventDefault();
    const t = clampTip(cur.side + d[0], cur.vert + d[1]);
    place(tip, t.side, t.vert);
    onChange(t.side, t.vert);
  });
  return {
    el,
    set(side, vert, recommended) {
      if (!dragging) place(tip, side, vert);
      if (recommended) {
        rec.style.display = '';
        place(rec, recommended.side, recommended.vert);
      } else rec.style.display = 'none';
    },
  };
}
