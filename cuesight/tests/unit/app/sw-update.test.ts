/**
 * The in-app update prompt (src/app/sw-update.ts). A new build's service worker waits instead of
 * taking over an open page (public/sw.js); the page offers "Reload" and only then tells it to take
 * over. End to end: tests/e2e/update.spec.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SKIP_WAITING, watchForUpdates, type ContainerLike, type RegistrationLike, type WorkerLike } from '../../../src/app/sw-update';

class FakeWorker extends EventTarget implements WorkerLike {
  messages: unknown[] = [];
  constructor(public state: string) {
    super();
  }
  postMessage(m: unknown): void {
    this.messages.push(m);
  }
  to(state: string): void {
    this.state = state;
    this.dispatchEvent(new Event('statechange'));
  }
}
class FakeReg extends EventTarget implements RegistrationLike {
  installing: FakeWorker | null = null;
  waiting: FakeWorker | null = null;
  found(w: FakeWorker): void {
    this.installing = w;
    this.dispatchEvent(new Event('updatefound'));
  }
}
class FakeContainer extends EventTarget implements ContainerLike {
  constructor(public controller: unknown) {
    super();
  }
  change(to: unknown): void {
    this.controller = to;
    this.dispatchEvent(new Event('controllerchange'));
  }
}

function setup(controller: unknown, reg = new FakeReg()) {
  const c = new FakeContainer(controller);
  const shown: string[] = [];
  const prompt = { show: () => shown.push('show'), hide: () => shown.push('hide') };
  const reload = vi.fn();
  const ctl = watchForUpdates(c, reg, prompt, reload);
  return { c, reg, shown, reload, ctl };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('service worker update prompt', () => {
  it('first visit: the first install is not an update, and its claim does not reload or prompt', () => {
    const { c, reg, shown, reload } = setup(null);
    const w = new FakeWorker('installing');
    reg.found(w);
    w.to('installed');
    w.to('activated');
    c.change(w);
    expect(shown).toEqual([]);
    expect(reload).not.toHaveBeenCalled();
  });

  it('a new build found while the page is open is offered, never applied on its own', () => {
    const { reg, shown, reload } = setup({});
    const w = new FakeWorker('installing');
    reg.found(w);
    expect(shown).toEqual([]);
    reg.installing = null;
    reg.waiting = w;
    w.to('installed');
    expect(shown).toEqual(['show']);
    expect(w.messages).toEqual([]);
    expect(reload).not.toHaveBeenCalled();
  });

  it('a build already waiting when the page starts is offered at once', () => {
    const reg = new FakeReg();
    reg.waiting = new FakeWorker('installed');
    const { shown } = setup({}, reg);
    expect(shown).toEqual(['show']);
  });

  it('Reload asks the waiting worker to take over, then reloads once it controls the page', () => {
    const reg = new FakeReg();
    const w = new FakeWorker('installed');
    reg.waiting = w;
    const { c, ctl, reload, shown } = setup({}, reg);
    ctl.accept();
    expect(w.messages).toEqual([SKIP_WAITING]);
    expect(shown.at(-1)).toBe('hide');
    expect(reload).not.toHaveBeenCalled();
    c.change(w);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('Reload still reloads if the takeover never arrives', () => {
    vi.useFakeTimers();
    const reg = new FakeReg();
    reg.waiting = new FakeWorker('installed');
    const { ctl, reload } = setup({}, reg);
    ctl.accept();
    vi.advanceTimersByTime(5000);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('another tab took the update: this page keeps its build and is offered the reload', () => {
    const { c, shown, reload, ctl } = setup({});
    c.change({});
    expect(reload).not.toHaveBeenCalled();
    expect(shown).toEqual(['show']);
    // Nothing is waiting any more: Reload just reloads.
    ctl.accept();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('Not now hides the prompt without touching the worker', () => {
    const reg = new FakeReg();
    const w = new FakeWorker('installed');
    reg.waiting = w;
    const { ctl, shown, reload } = setup({}, reg);
    ctl.dismiss();
    expect(shown).toEqual(['show', 'hide']);
    expect(w.messages).toEqual([]);
    expect(reload).not.toHaveBeenCalled();
  });
});
