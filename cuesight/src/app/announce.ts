/**
 * Screen-reader announcements of the plan (polite live region, Principle VI): one sentence for the
 * shot the player will actually play, and each warning once, when it first appears.
 *
 * The sentence waits for the recommended stroke (no "Power 4.5, centre ball" for a provisional
 * default that the card then replaces with "6/10, ½ tip below centre"), is re-spoken when the stroke
 * itself changes (target, pocket, source, power or tip), and is debounced so dragging a slider speaks
 * once, at the value the player settles on.
 */
import { describeSpin, speedWord } from '../core/shot/power';
import type { PocketId, ShotPlan } from '../core/types';
import { isFrozenPlan } from './render/plan-draw';

export const ANNOUNCE_DEBOUNCE_MS = 600;

/** The plan in one or two sentences, in the card's words. */
export function planSentence(p: ShotPlan, names: Partial<Record<PocketId, string>>, labelOf: (id: string) => string): string {
  const ball = `Ball ${labelOf(p.targetId)}`;
  const pocket = names[p.pocketId] ?? p.pocketId;
  if (!p.makeable) {
    const why = p.warnings.find((w) => w.code === 'not-makeable' || w.code === 'blocked-cue' || w.code === 'blocked-object');
    const alt = p.alternatives[0];
    return `${ball} to the ${pocket} is not makeable${why ? `: ${why.message.replace(/^Not makeable: /, '').replace(/\.$/, '')}` : ''}.${alt && !why?.message.includes('Try the') ? ` Try the ${names[alt.pocketId] ?? alt.pocketId}.` : ''}`;
  }
  const short = p.warnings.find((w) => w.code === 'cb-short');
  if (short) return `${ball} to the ${pocket}: ${short.message}`;
  const pw = Math.round(p.stroke.power * 10) / 10;
  // A frozen cue ball has no cut or ghost ball (the core's cut 0 / 'full' are conventions): the
  // 'frozen' warning, spoken next, says which way to stroke.
  const aim = isFrozenPlan(p) ? 'frozen to the cue ball, no ghost ball' : `cut ${p.cutAngleDeg.toFixed(0)} degrees, ${p.fractionPhrase}`;
  return `${ball} to the ${pocket}: ${aim}.${p.strokeName ? ` ${p.strokeName}.` : ''} Power ${pw} of 10, ${speedWord(p.stroke.power)}. Strike ${describeSpin(p.stroke)}.`;
}

export interface Announcer {
  /** Call on every render with the current plan (null clears) and whether a recommendation is pending. */
  update(plan: ShotPlan | null, pending: boolean, names: Partial<Record<PocketId, string>>, labelOf: (id: string) => string): void;
}

export function createAnnouncer(el: { textContent: string | null }, timers: { set: (f: () => void, ms: number) => number; clear: (id: number) => void } = { set: (f, ms) => window.setTimeout(f, ms), clear: (id) => window.clearTimeout(id) }): Announcer {
  let spokenKey = '';
  let spokenWarnings = new Set<string>();
  let timer = 0;
  let queuedKey = '';
  return {
    update(p, pending, names, labelOf) {
      if (!p) {
        if (timer) timers.clear(timer);
        timer = 0;
        spokenKey = '';
        queuedKey = '';
        spokenWarnings = new Set();
        return;
      }
      // A provisional stroke is about to be replaced by the recommended one: say nothing yet.
      if (pending && p.strokeSource !== 'player') return;
      const shot = `${p.targetId}>${p.pocketId}`;
      const key = `${shot}|${p.strokeSource}|${p.stroke.power}|${p.stroke.side}|${p.stroke.vert}|${p.makeable}`;
      if (key === spokenKey || key === queuedKey) return;
      queuedKey = key;
      if (timer) timers.clear(timer);
      const sentence = planSentence(p, names, labelOf);
      // The sentence already says why a shot is not makeable or too soft; speed hints do not apply to it.
      const skip = new Set<string>(['not-makeable', 'cb-short', ...(p.makeable ? [] : ['too-soft', 'thin-cut', 'ob-missed'])]);
      const warnings = p.warnings.filter((w) => !skip.has(w.code));
      timer = timers.set(() => {
        timer = 0;
        if (!spokenKey.startsWith(`${shot}|`)) spokenWarnings = new Set();
        spokenKey = key;
        queuedKey = '';
        const parts = [sentence];
        for (const w of warnings) {
          if (spokenWarnings.has(w.code)) continue;
          spokenWarnings.add(w.code);
          // The sentence already says why it is not makeable / too soft.
          if (!sentence.includes(w.message.replace(/\.$/, ''))) parts.push(w.message);
        }
        el.textContent = parts.join(' ');
      }, ANNOUNCE_DEBOUNCE_MS);
    },
  };
}
