/**
 * Bottom sheet for the shot card on portrait phones (FR-126): a peek height that shows the headline
 * (target → pocket, cut, power, spin), a medium detent (about half the screen: the headline and the
 * stroke controls, with the table re-framed above it so the path can be watched while power and spin
 * change), and an expanded height just below the top bar. Drag the handle (or swipe the peeked
 * content up) between them; tap the handle to step peek → medium → expanded → peek; Escape
 * collapses. In landscape or at ≥ 900 px wide the same element is a static side panel and the
 * handle is hidden. The state is mirrored on <body data-sheet> so the stage can follow it.
 *
 * The sheet changes its *height* (not a transform), so its content is a normal scroll container that
 * stays inside the viewport: anything in it can always be scrolled into view.
 */

export interface Sheet {
  expand(): void;
  /** The medium detent (headline + stroke controls). */
  medium(): void;
  collapse(): void;
  /** Fully expanded, or a static side panel. */
  isExpanded(): boolean;
  state(): 'peek' | 'medium' | 'expanded' | 'static';
  /** Called after every state change. */
  onChange?: (s: 'peek' | 'medium' | 'expanded' | 'static') => void;
}

export const SIDE_PANEL_QUERY = '(orientation: landscape), (min-width: 900px)';

type State = 'peek' | 'medium' | 'expanded' | 'static';

const LABELS: Record<Exclude<State, 'static'>, string> = {
  peek: 'Expand shot details',
  medium: 'Show all shot details',
  expanded: 'Collapse shot details',
};

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
  let state: State | null = null;

  let api: Sheet;
  const apply = (next: State) => {
    const changed = next !== state;
    state = next;
    el.dataset.sheet = next;
    document.body.dataset.sheet = next;
    el.style.removeProperty('height');
    const expanded = next !== 'peek';
    handle!.setAttribute('aria-expanded', String(expanded));
    handle!.setAttribute('aria-label', next === 'static' ? 'Shot details' : LABELS[next]);
    handle!.tabIndex = next === 'static' ? -1 : 0;
    if (next === 'peek' || next === 'medium') body!.scrollTop = 0;
    if (changed) api?.onChange?.(next);
  };
  apply(mq?.matches ? 'static' : 'peek');
  mq?.addEventListener?.('change', () => apply(mq.matches ? 'static' : 'peek'));

  const toggle = () => {
    if (state === 'static') return;
    apply(state === 'peek' ? 'medium' : state === 'medium' ? 'expanded' : 'peek');
  };

  // --- Dragging -------------------------------------------------------------------------------
  /** Height of the sheet in a given state, measured with transitions off (one forced layout). */
  const measure = (s: 'peek' | 'medium' | 'expanded'): number => {
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
  let drag: { id: number; y0: number; h0: number; t0: number; lo: number; mid: number; hi: number; active: boolean; fromBody: boolean } | null = null;
  let suppressClick = false;

  const begin = (e: PointerEvent, fromBody: boolean) => {
    if (state === 'static' || e.button > 0) return;
    drag = { id: e.pointerId, y0: e.clientY, h0: el.getBoundingClientRect().height, t0: e.timeStamp, lo: 0, mid: 0, hi: 0, active: false, fromBody };
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
      drag.mid = measure('medium');
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
    // Snap to the nearest detent; a flick goes one detent further in its direction.
    const stops: [Exclude<State, 'static'>, number][] = [
      ['peek', d.lo],
      ['medium', d.mid],
      ['expanded', d.hi],
    ];
    let i = 0;
    for (let k = 1; k < stops.length; k++) if (Math.abs(stops[k]![1] - h) < Math.abs(stops[i]![1] - h)) i = k;
    if (v < -0.35 && stops[i]![1] <= h + 4) i = Math.min(2, i + 1);
    else if (v > 0.35 && stops[i]![1] >= h - 4) i = Math.max(0, i - 1);
    apply(stops[i]![0]);
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
    if (e.key === 'Escape' && (state === 'expanded' || state === 'medium')) {
      apply('peek');
      handle!.focus();
    }
  });

  api = {
    expand: () => void (state !== 'static' && apply('expanded')),
    medium: () => void (state !== 'static' && apply('medium')),
    collapse: () => void (state !== 'static' && apply('peek')),
    isExpanded: () => state === 'expanded' || state === 'static',
    state: () => state!,
  };
  return api;
}
