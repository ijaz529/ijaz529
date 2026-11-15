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
  it('never names a pocket on the wrong side, never calls a corner behind the player "far" (any table, any position and facing)', () => {
    // Wave-2 review: the collision fallback re-ranked all four corners by depth and screen x, so two
    // corners on the player's left could come out "near left" and "near right", and a corner behind
    // the player "far left corner".
    for (const preset of ['pool9', 'pool8', 'pool7', 'snooker12'] as const) {
      const t = makeTable(preset);
      let seed = 7;
      const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
      for (let k = 0; k < 4000; k++) {
        const from = { x: (rnd() * 2 - 1) * (t.length / 2 - 0.03), y: (rnd() * 2 - 1) * (t.width / 2 - 0.03) };
        const a = rnd() * Math.PI * 2;
        const f = { x: Math.cos(a), y: Math.sin(a) };
        const n = shooterPocketNames(t.pockets, from, f);
        const list = t.pockets.map((p) => n[p.id as PocketId]!);
        const at = `${preset} ${JSON.stringify(from)} ${a.toFixed(3)}: ${list.join(', ')}`;
        expect(new Set(list).size, at).toBe(6);
        for (const p of t.pockets) {
          const dx = p.mouthCenter.x - from.x;
          const dy = p.mouthCenter.y - from.y;
          const ahead = dx * f.x + dy * f.y;
          const right = dx * f.y - dy * f.x;
          const bearing = Math.abs((Math.atan2(right, ahead) * 180) / Math.PI);
          const name = n[p.id as PocketId]!;
          if (/\bright\b/.test(name)) expect(right, `${p.id} "${name}" is on the left · ${at}`).toBeGreaterThanOrEqual(0);
          if (/\bleft\b/.test(name)) expect(right, `${p.id} "${name}" is on the right · ${at}`).toBeLessThan(0);
          if (/^far .* corner$/.test(name)) expect(bearing, `${p.id} "${name}" is behind · ${at}`).toBeLessThan(90);
          if (/ahead/.test(name)) expect(bearing, `${p.id} "${name}" · ${at}`).toBeLessThanOrEqual(10);
          if (/behind/.test(name)) expect(bearing, `${p.id} "${name}" · ${at}`).toBeGreaterThanOrEqual(170);
        }
      }
    }
  });
  it('from a camera outside the table (Snap: the player photo is taken from behind the rail), facing the table', () => {
    let seed = 3;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let k = 0; k < 4000; k++) {
      // Up to 0.8 m beyond the cushions, looking at a point on the bed (the balls in the photo).
      const ang = rnd() * Math.PI * 2;
      const from = { x: Math.cos(ang) * (table.length / 2 + 0.05 + rnd() * 0.8), y: Math.sin(ang) * (table.width / 2 + 0.05 + rnd() * 0.8) };
      const look = { x: (rnd() * 2 - 1) * (table.length / 2 - 0.05), y: (rnd() * 2 - 1) * (table.width / 2 - 0.05) };
      const a = Math.atan2(look.y - from.y, look.x - from.x);
      const f = { x: Math.cos(a), y: Math.sin(a) };
      const n = shooterPocketNames(table.pockets, from, f);
      const list = table.pockets.map((p) => n[p.id as PocketId]!);
      const at = `${JSON.stringify(from)} ${a.toFixed(3)}: ${list.join(', ')}`;
      expect(new Set(list).size, at).toBe(6);
      for (const p of table.pockets) {
        const right = (p.mouthCenter.x - from.x) * f.y - (p.mouthCenter.y - from.y) * f.x;
        const name = n[p.id as PocketId]!;
        if (/\bright\b/.test(name)) expect(right, `${p.id} "${name}" · ${at}`).toBeGreaterThanOrEqual(0);
        if (/\bleft\b/.test(name)) expect(right, `${p.id} "${name}" · ${at}`).toBeLessThan(0);
      }
    }
  });
  it('stays unique when the position or facing is not a number (a degenerate pose)', () => {
    for (const [from, facing] of [
      [{ x: NaN, y: 0 }, { x: 1, y: 0 }],
      [{ x: 0, y: 0 }, { x: NaN, y: NaN }],
      [{ x: Infinity, y: 0 }, { x: 0, y: 1 }],
    ] as const) {
      const n = shooterPocketNames(table.pockets, from, facing);
      const list = table.pockets.map((p) => n[p.id as PocketId]);
      expect(list.every(Boolean)).toBe(true);
      expect(new Set(list).size, list.join(', ')).toBe(6);
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
