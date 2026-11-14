/**
 * Bottom sheet for the shot card on portrait phones (FR-126): a peek height that shows the headline
 * (target → pocket, cut, power, spin), and an expanded height just below the top bar. Drag the handle
 * (or swipe the peeked content up) to expand; tap the handle or press Escape to collapse. In landscape
 * or at ≥ 900 px wide the same element is a static side panel and the handle is hidden.
 *
 * The sheet changes its *height* (not a transform), so its content is a normal scroll container that
 * stays inside the viewport: anything in it can always be scrolled into view.
 */

export interface Sheet {
  expand(): void;
  collapse(): void;
  isExpanded(): boolean;
}

export const SIDE_PANEL_QUERY = '(orientation: landscape), (min-width: 900px)';

type State = 'peek' | 'expanded' | 'static';

export function createSheet(el: HTMLElement, opts: { peek?: number } = {}): Sheet {
  const root = document.documentElement;
  if (opts.peek) root.style.setProperty('--sheet-peek', `${Math.round(opts.peek)}px`);
  el.classList.add('sheet');

  let body = el.querySelector<HTMLElement>('.sheet-body');
  if (!body) {
    body = document.createElement('div');
    body.className = 'sheet-body';
    while (el.firstChild) body.appendChild(el.firstChild);
    el.appendChild(body);
  }
  if (!body.id) body.id = 'sheet-body';

  let handle = el.querySelector<HTMLButtonElement>('.sheet-handle');
  if (!handle) {
    handle = document.createElement('button');
    handle.type = 'button';
    handle.className = 'sheet-handle';
    handle.innerHTML = '<span class="grabber" aria-hidden="true"></span>';
    el.insertBefore(handle, el.firstChild);
  }
  handle.setAttribute('aria-controls', body.id);

  const mq = typeof matchMedia === 'function' ? matchMedia(SIDE_PANEL_QUERY) : null;
  let state: State = mq?.matches ? 'static' : 'peek';

  const apply = (next: State) => {
    state = next;
    el.dataset.sheet = next;
    el.style.removeProperty('height');
    const expanded = next !== 'peek';
    handle!.setAttribute('aria-expanded', String(expanded));
    handle!.setAttribute('aria-label', expanded ? 'Collapse shot details' : 'Expand shot details');
    handle!.tabIndex = next === 'static' ? -1 : 0;
    if (next === 'peek') body!.scrollTop = 0;
  };
  apply(state);
  mq?.addEventListener?.('change', () => apply(mq.matches ? 'static' : 'peek'));

  const toggle = () => {
    if (state === 'static') return;
    apply(state === 'peek' ? 'expanded' : 'peek');
  };

  // --- Dragging -------------------------------------------------------------------------------
  /** Height of the sheet in a given state, measured with transitions off (one forced layout). */
  const measure = (s: 'peek' | 'expanded'): number => {
    const prevState = el.dataset.sheet ?? '';
    const prevH = el.style.height;
    const hadDrag = el.classList.contains('dragging');
    el.classList.add('dragging');
    el.style.removeProperty('height');
    el.dataset.sheet = s;
    const h = el.getBoundingClientRect().height;
    el.dataset.sheet = prevState;
    el.style.height = prevH;
    if (!hadDrag) el.classList.remove('dragging');
    return h;
  };
  let drag: { id: number; y0: number; h0: number; t0: number; lo: number; hi: number; active: boolean; fromBody: boolean } | null = null;
  let suppressClick = false;

  const begin = (e: PointerEvent, fromBody: boolean) => {
    if (state === 'static' || e.button > 0) return;
    drag = { id: e.pointerId, y0: e.clientY, h0: el.getBoundingClientRect().height, t0: e.timeStamp, lo: 0, hi: 0, active: false, fromBody };
  };
  const move = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dy = e.clientY - drag.y0;
    if (!drag.active) {
      if (Math.abs(dy) < 8) return;
      // From the content, only an upward swipe on the peeked sheet starts a drag.
      if (drag.fromBody && !(state === 'peek' && dy < 0)) {
        drag = null;
        return;
      }
      drag.active = true;
      drag.lo = measure('peek');
      drag.hi = measure('expanded');
      el.classList.add('dragging');
      try {
        (e.target as Element).setPointerCapture?.(e.pointerId);
      } catch {
        /* capture is best-effort */
      }
    }
    const h = Math.max(drag.lo * 0.85, Math.min(drag.hi, drag.h0 - dy));
    el.style.height = `${h}px`;
  };
  const end = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    if (!d.active) return;
    suppressClick = true;
    window.setTimeout(() => (suppressClick = false), 0);
    el.classList.remove('dragging');
    const dt = Math.max(1, e.timeStamp - d.t0);
    const v = (e.clientY - d.y0) / dt; // px/ms, + = down
    const h = el.getBoundingClientRect().height;
    const mid = (d.lo + d.hi) / 2;
    if (v < -0.35) apply('expanded');
    else if (v > 0.35) apply('peek');
    else apply(h > mid ? 'expanded' : 'peek');
  };

  handle.addEventListener('pointerdown', (e) => {
    begin(e, false);
    // The handle is a dedicated drag target: keep receiving moves once the pointer leaves it.
    if (drag) {
      try {
        handle!.setPointerCapture(e.pointerId);
      } catch {
        /* capture is best-effort */
      }
    }
  });
  body.addEventListener('pointerdown', (e) => begin(e, true));
  for (const t of [handle, body]) {
    t.addEventListener('pointermove', move);
    t.addEventListener('pointerup', end);
    t.addEventListener('pointercancel', end);
  }
  handle.addEventListener('click', () => {
    if (suppressClick) return;
    toggle();
  });
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state === 'expanded') {
      apply('peek');
      handle!.focus();
    }
  });

  return {
    expand: () => state !== 'static' && apply('expanded'),
    collapse: () => state !== 'static' && apply('peek'),
    isExpanded: () => state !== 'peek',
  };
}
