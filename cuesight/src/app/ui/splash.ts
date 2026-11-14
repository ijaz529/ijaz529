/**
 * Branded splash (FR-131): the inline `#splash` in index.html shows the mark and wordmark while the app
 * loads; this fades it out after the first render. It is pointer-transparent the whole time.
 */
export function hideSplash(): void {
  const el = document.getElementById('splash');
  if (!el || el.classList.contains('splash-out')) return;
  const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  el.classList.add('splash-out');
  window.setTimeout(() => el.remove(), reduce ? 0 : 420);
}
