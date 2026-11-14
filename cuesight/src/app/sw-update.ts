/**
 * Service-worker registration and the in-app update prompt (PWA builds only; the iOS app bundles its
 * assets and registers no service worker).
 *
 * public/sw.js never takes over an open page by itself: the page creates its planner and vision
 * workers and loads the Snap sample photos lazily, by the hashed file names of the build it was
 * loaded with. When a new build's worker is installed and waiting, the page offers "Reload";
 * accepting tells that worker to take over ('skip-waiting') and reloads once it controls the page.
 * If another tab took the update, this page keeps working on its own build (the new worker keeps the
 * older build's cache while such pages are open) and is offered the reload too.
 */
import { iconMarkup } from './ui/icons';

export interface WorkerLike {
  readonly state: string;
  postMessage(message: unknown): void;
  addEventListener(type: 'statechange', listener: () => void): void;
}
export interface RegistrationLike {
  readonly installing: WorkerLike | null;
  readonly waiting: WorkerLike | null;
  addEventListener(type: 'updatefound', listener: () => void): void;
}
export interface ContainerLike {
  readonly controller: unknown;
  addEventListener(type: 'controllerchange', listener: () => void): void;
}
export interface UpdatePrompt {
  show(): void;
  hide(): void;
}
export interface UpdateControl {
  /** "Reload": switch to the new build. */
  accept(): void;
  /** "Not now": hide the prompt; the new build starts once every tab of this one is closed. */
  dismiss(): void;
}

/** The message public/sw.js answers with skipWaiting(). */
export const SKIP_WAITING = { type: 'skip-waiting' } as const;
/** Reload anyway if the waiting worker has not taken over by then (it may have been replaced). */
const TAKEOVER_TIMEOUT_MS = 4000;

export function watchForUpdates(container: ContainerLike, reg: RegistrationLike, prompt: UpdatePrompt, reload: () => void): UpdateControl {
  // On the first visit nothing controls the page: the first install is not an update.
  let controlled = !!container.controller;
  let accepted = false;
  let reloaded = false;
  const doReload = () => {
    if (reloaded) return;
    reloaded = true;
    reload();
  };
  const offer = () => {
    if (!accepted) prompt.show();
  };
  const track = (w: WorkerLike | null) => {
    if (!w) return;
    const check = () => {
      if (w.state === 'installed' && container.controller) offer();
    };
    check();
    w.addEventListener('statechange', check);
  };
  if (reg.waiting && controlled) offer();
  track(reg.installing);
  reg.addEventListener('updatefound', () => track(reg.installing));
  container.addEventListener('controllerchange', () => {
    if (accepted) return doReload();
    if (!controlled) {
      controlled = true; // the first install claimed this page
      return;
    }
    offer(); // another tab took the update; this page still runs its own build
  });
  return {
    accept() {
      accepted = true;
      prompt.hide();
      const w = reg.waiting;
      if (!w) return doReload(); // already active (another tab took it): just reload
      w.postMessage(SKIP_WAITING);
      setTimeout(doReload, TAKEOVER_TIMEOUT_MS);
    },
    dismiss() {
      prompt.hide();
    },
  };
}

/** The prompt: a toast with Reload and Not now, above the stage (regular toasts may briefly cover it). */
export function createUpdatePrompt(stage: HTMLElement, onReload: () => void, onLater: () => void): UpdatePrompt {
  let el: HTMLElement | null = null;
  return {
    show() {
      if (el) return;
      el = document.createElement('div');
      el.className = 'toast update-toast';
      el.setAttribute('role', 'status');
      el.style.cssText = 'pointer-events:auto;display:flex;align-items:center;gap:10px;padding:6px 6px 6px 16px;text-align:start';
      el.innerHTML =
        '<span>A new version of CueSight is ready.</span>' +
        `<button type="button" class="btn primary" data-update="reload">${iconMarkup('refresh', 18)}<span>Reload</span></button>` +
        `<button type="button" class="icon-btn" data-update="later" aria-label="Not now" title="Not now">${iconMarkup('close', 18)}</button>`;
      el.addEventListener('click', (e) => {
        const b = (e.target as HTMLElement).closest<HTMLElement>('[data-update]');
        if (b) (b.dataset.update === 'reload' ? onReload : onLater)();
      });
      stage.insertBefore(el, stage.querySelector('#toast'));
    },
    hide() {
      el?.remove();
      el = null;
    },
  };
}

/** Registers ./sw.js and wires the update prompt into `stage`. */
export function registerServiceWorker(container: ServiceWorkerContainer, stage: HTMLElement, reload = () => location.reload()): void {
  container
    .register('./sw.js')
    .then((reg) => {
      let ctl: UpdateControl | null = null;
      const prompt = createUpdatePrompt(
        stage,
        () => ctl?.accept(),
        () => ctl?.dismiss(),
      );
      ctl = watchForUpdates(container, reg, prompt, reload);
    })
    .catch(() => undefined);
}
