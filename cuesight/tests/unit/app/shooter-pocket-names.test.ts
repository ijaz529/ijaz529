/**
 * Pocket names from the shooter's position (Practice, and Snap once the player's photo is lined up):
 * by bearing, so a pocket dead ahead is "ahead", one to the right says "right", and pockets behind the
 * player are "near" (judge-coach round 2, item 1: the dead-ahead pocket in the straight-in drill was
 * called "far left corner").
 */
import { describe, expect, it } from 'vitest';
import { DRILLS } from '../../../src/app/drills';
import { shooterPocketNames } from '../../../src/app/pocket-names';
import { makeTable } from '../../../src/core/table';
import type { PocketId } from '../../../src/core/types';

const table = makeTable('pool9');
const names = (drill: string, targetId = 'b1') => {
  const balls = DRILLS.find((d) => d.id === drill)!.build(table);
  const cue = balls.find((b) => b.kind === 'cue')!.pos;
  const t = balls.find((b) => b.id === targetId)!.pos;
  return shooterPocketNames(table.pockets, cue, { x: t.x - cue.x, y: t.y - cue.y });
};

describe('shooter-frame pocket names', () => {
  it('straight-in drill: the pocket dead ahead is "ahead", the one at 90° right says right, the ones behind-left say left, never far', () => {
    const n = names('straight');
    expect(n.TR).toContain('ahead');
    expect(n.BR).toContain('right');
    expect(n.BL).toMatch(/near left|behind/);
    expect(n.TL).toContain('left');
    for (const id of ['TL', 'BL', 'BM'] as const) expect(n[id]).not.toContain('far');
  });
  it('30° cut: the corner ahead and to the right says right', () => {
    const n = names('cut30');
    expect(n.TR).toContain('right');
    expect(n.TR).not.toContain('left');
  });
  it('the scratch hanger and the rail drill name the pocket being played sensibly', () => {
    expect(names('scratch', 'b7').TR).toContain('ahead');
    expect(names('rail', 'b9').TR).toMatch(/far|ahead/);
  });
  it('names are unique and complete from any position and facing', () => {
    let seed = 11;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let k = 0; k < 2000; k++) {
      const from = { x: (rnd() * 2 - 1) * (table.length / 2 - 0.03), y: (rnd() * 2 - 1) * (table.width / 2 - 0.03) };
      const a = rnd() * Math.PI * 2;
      const n = shooterPocketNames(table.pockets, from, { x: Math.cos(a), y: Math.sin(a) });
      const list = table.pockets.map((p) => n[p.id as PocketId]);
      expect(list.every(Boolean)).toBe(true);
      expect(new Set(list).size, `${JSON.stringify(from)} ${a.toFixed(2)}: ${list.join(', ')}`).toBe(6);
    }
  });
  it('looking down the length between two corners, they split left and right instead of both "ahead"', () => {
    const n = shooterPocketNames(table.pockets, { x: table.length / 2 - 0.05, y: 0 }, { x: -1, y: 0 });
    expect(n.TL).not.toBe(n.BL);
    expect([n.TL, n.BL].sort()).toEqual(['far left corner', 'far right corner']);
    // The two corners at the player's own end are beside them.
    expect([n.TR, n.BR].sort()).toEqual(['corner on your left', 'corner on your right']);
  });
});
