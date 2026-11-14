/**
 * Screenshot tour for the iOS Simulator smoke test (VITE_CUESIGHT_TOUR=1 builds only; dynamically
 * imported, so it is not in normal bundles). Each step sets up a screen, waits for it to settle and
 * logs `[CueSight] tour <step>`; scripts/ios-sim-smoke.sh screenshots after every marker.
 */
import type { CueSightHook } from './main';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function until(cond: () => boolean, timeoutMs = 20_000): Promise<boolean> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) return false;
    await sleep(150);
  }
  return true;
}

export async function runTour(h: CueSightHook): Promise<void> {
  const mark = async (step: string, holdMs = 3200) => {
    console.info(`[CueSight] tour ${step}`);
    await sleep(holdMs);
  };
  const S = h.state;
  try {
    await sleep(1500);
    // The first-run hint would sit on every screenshot: dismiss it like a player would.
    document.querySelector<HTMLButtonElement>('.onboard-ok')?.click();
    // Practice: the 3D table.
    h.setMode('practice');
    await sleep(900);
    await mark('practice-3d');
    const target = S.practice.balls.find((b) => b.kind !== 'cue');
    if (target) h.selectBall(target.id);
    await until(() => !!S.plan && !!S.recommended && !S.recommended.pending, 15_000);
    await sleep(600);
    await mark('practice-plan');
    h.setCamera('player');
    await sleep(1200);
    await mark('practice-player-view');
    h.setCamera('broadcast');
    await sleep(1200);
    await mark('practice-broadcast');
    void h.playShot();
    await sleep(900);
    await mark('practice-play-shot', 2500);
    h.setCamera('overview');
    // Snap: the two-photo guide with the bundled sample photos.
    h.setMode('snap');
    await sleep(800);
    await mark('snap-intro');
    await h.snap.useSamples();
    await until(() => S.snap.step === 'review' || S.snap.step === 'overview-error', 30_000);
    await sleep(900);
    await mark('snap-table');
    // The sample player photo was taken for the ball nearest (0.3, 0.15) m (the yellow 1).
    const sTarget = S.snap.layout
      ?.filter((b) => b.kind !== 'cue')
      .reduce<(typeof S.practice.balls)[number] | null>((a, b) => (!a || Math.hypot(b.pos.x - 0.3, b.pos.y - 0.15) < Math.hypot(a.pos.x - 0.3, a.pos.y - 0.15) ? b : a), null);
    if (sTarget) h.selectBall(sTarget.id);
    await until(() => !!S.plan, 10_000);
    await sleep(1200);
    await mark('snap-plan');
    await h.snap.useSamplePlayer();
    await until(() => S.snap.step === 'guide' || S.snap.step === 'manual-taps', 30_000);
    await sleep(900);
    await mark('snap-guide');
    // Live: the Simulator has no camera, so this shows the camera fallback.
    h.setMode('camera');
    await sleep(2500);
    await mark('live');
    h.setMode('practice');
    await sleep(800);
  } catch (e) {
    console.warn('[CueSight] tour error', e);
  }
  console.info('[CueSight] tour done');
}
