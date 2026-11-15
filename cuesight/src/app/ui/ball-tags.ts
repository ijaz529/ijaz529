/**
 * Ball number tags for the 3D table's top view (design review round 2, item 9): from overhead a pool
 * ball is ~10 px and its number cannot be read, yet Snap's step 1 asks the player to check the layout.
 * A small glass tag with the number (or the colour's initial) sits up-right of each object ball while
 * the ball is drawn smaller than TAG_MAX_R; tags never take taps and are hidden from assistive tech
 * (the shot card's ball picker names every ball).
 */
import type { Ball } from '../../core/types';
import type { FrameInfo } from '../render3d';

/** Tags show while a ball's on-screen radius is below this (px). */
export const TAG_MAX_R = 14;

/** Standard pool set: solid colour → number (stripes are the number + 8). */
const POOL_NUMBER: Record<string, number> = { yellow: 1, blue: 2, red: 3, purple: 4, orange: 5, green: 6, maroon: 7, brown: 7, black: 8 };
/** Snooker colours, two letters where the initial is shared (blue, brown, black). */
const SNOOKER_TAG: Record<string, string> = { red: 'R', yellow: 'Y', green: 'G', brown: 'Br', blue: 'Bl', pink: 'P', black: 'Bk' };

/**
 * Text of a tag: the number for numbered balls; on a pool table a detected colour maps to its number
 * in the standard set ("yellow stripe" → 9, "black" → 8); snooker colours get a short name; nothing
 * for the cue ball or a ball vision could not name ("ball").
 */
export function tagText(b: Pick<Ball, 'kind' | 'label' | 'id'>, snooker = false): string {
  if (b.kind === 'cue') return '';
  const l = (b.label ?? b.id).trim().toLowerCase();
  if (/^\d+$/.test(l)) return l;
  const [word = '', mod] = l.split(/\s+/);
  // A ball vision could not name ('ball'): no letter (a "B" would read as blue, black or brown).
  if (word === 'ball') return '';
  if (snooker) return SNOOKER_TAG[word] ?? (word ? word.charAt(0).toUpperCase() : '');
  const n = POOL_NUMBER[word];
  if (n) return String(mod === 'stripe' && n !== 8 ? n + 8 : n);
  return word ? word.charAt(0).toUpperCase() : '';
}

export interface BallTags {
  update(info: FrameInfo | null, balls: readonly Ball[], show: boolean, snooker?: boolean): void;
  hide(): void;
}

export function createBallTags(host: HTMLElement): BallTags {
  const layer = document.createElement('div');
  layer.className = 'ball-tags';
  layer.setAttribute('aria-hidden', 'true');
  host.appendChild(layer);
  const els = new Map<string, HTMLElement>();
  const hide = () => {
    layer.hidden = true;
  };
  hide();
  return {
    hide,
    update(info, balls, show, snooker = false) {
      if (!show || !info || info.playing || !info.balls || info.preset !== 'overview') return hide();
      const hb = host.getBoundingClientRect();
      const seen = new Set<string>();
      let any = false;
      for (const s of info.balls) {
        const b = balls.find((x) => x.id === s.id);
        const text = b ? tagText(b, snooker) : '';
        if (!text || s.r >= TAG_MAX_R) continue;
        if (s.x < info.free.left || s.x > info.free.right || s.y < info.free.top || s.y > info.free.bottom) continue;
        seen.add(s.id);
        let el = els.get(s.id);
        if (!el) {
          el = document.createElement('span');
          el.className = 'ball-tag';
          layer.appendChild(el);
          els.set(s.id, el);
        }
        if (el.textContent !== text) el.textContent = text;
        el.hidden = false;
        el.style.transform = `translate(${Math.round(s.x - hb.left + s.r * 0.6)}px, ${Math.round(s.y - hb.top - s.r * 0.6 - 16)}px)`;
        any = true;
      }
      for (const [id, el] of els) if (!seen.has(id)) el.hidden = true;
      layer.hidden = !any;
    },
  };
}
