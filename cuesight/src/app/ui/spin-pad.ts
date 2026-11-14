/**
 * Tip-position control: tap or drag on the cue-ball face (FR-018). The dashed ring is the miscue
 * limit (½ R); the hollow ring shows the recommended tip.
 */
import { clampTip } from '../../core/physics/strike';

export interface SpinPad {
  el: HTMLElement;
  set(side: number, vert: number, recommended?: { side: number; vert: number } | null): void;
}

const NS = 'http://www.w3.org/2000/svg';

export function createSpinPad(onChange: (side: number, vert: number) => void): SpinPad {
  const size = 132;
  const r = size / 2 - 6;
  const c = size / 2;
  const el = document.createElement('div');
  el.className = 'spin-pad';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('role', 'slider');
  svg.setAttribute('aria-label', 'Cue tip position: drag to set spin');
  svg.setAttribute('tabindex', '0');
  svg.innerHTML = `
    <circle cx="${c}" cy="${c}" r="${r}" fill="#f7f7f2" stroke="#888" stroke-width="2"/>
    <circle cx="${c}" cy="${c}" r="${r * 0.5}" fill="none" stroke="#b55" stroke-dasharray="4 4"/>
    <line x1="${c - r}" y1="${c}" x2="${c + r}" y2="${c}" stroke="#ccc"/>
    <line x1="${c}" y1="${c - r}" x2="${c}" y2="${c + r}" stroke="#ccc"/>
    <circle class="rec" r="10" fill="none" stroke="#0072B2" stroke-width="2.5" stroke-dasharray="3 2"/>
    <circle class="tip" r="10" fill="#0072B2" stroke="#fff" stroke-width="2"/>`;
  el.appendChild(svg);
  const tip = svg.querySelector('.tip') as SVGCircleElement;
  const rec = svg.querySelector('.rec') as SVGCircleElement;
  const place = (node: SVGCircleElement, side: number, vert: number) => {
    node.setAttribute('cx', String(c + side * r));
    node.setAttribute('cy', String(c - vert * r));
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
