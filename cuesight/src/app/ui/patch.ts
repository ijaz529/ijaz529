/**
 * Markup writes that leave unchanged UI alone. The store re-renders on every flush (vision frames,
 * resizes, recommendations); rewriting `innerHTML` each time destroys the focused control and makes
 * a screen reader lose its place. `writeHtml` writes only when the markup differs from the last
 * write, and when it must rewrite while focus is inside, it moves focus back to the control with
 * the same key (e.g. the same suggestion, the same pocket button).
 */
const written = new WeakMap<HTMLElement, string>();

export function writeHtml(el: HTMLElement, html: string, focusKey?: (e: Element) => string | null): boolean {
  if (written.get(el) === html) return false;
  const active = typeof document !== 'undefined' ? document.activeElement : null;
  const key = active && focusKey && el.contains(active) ? focusKey(active) : null;
  el.innerHTML = html;
  written.set(el, html);
  if (key !== null) {
    const again = Array.from(el.querySelectorAll<HTMLElement>('button, [tabindex]')).find((b) => focusKey!(b) === key);
    again?.focus({ preventScroll: true });
  }
  return true;
}
