import { describe, expect, it } from 'vitest';
import { pathBlockers } from '../../../src/core/shot/obstruction';
import type { Ball } from '../../../src/core/types';
import { v2 } from '../../../src/core/vec';

const R = 0.028575;
const ball = (id: string, x: number, y: number): Ball => ({ id, kind: 'object', pos: v2(x, y) });

describe('path blockers', () => {
  it('finds balls within clearance of the swept path, nearest first', () => {
    const balls = [ball('far', 0.8, 0.01), ball('near', 0.3, -0.03), ball('clear', 0.5, 0.2), ball('behind', -0.2, 0)];
    const hits = pathBlockers(v2(0, 0), v2(1, 0), balls, 2 * R, []);
    expect(hits.map((b) => b.id)).toEqual(['near', 'far']);
  });
  it('honours ignore list and end-cap distance', () => {
    const balls = [ball('end', 1.05, 0), ball('x', 0.5, 0)];
    expect(pathBlockers(v2(0, 0), v2(1, 0), balls, 2 * R, ['x']).map((b) => b.id)).toEqual(['end']);
    expect(pathBlockers(v2(0, 0), v2(1, 0), [ball('past', 1.2, 0)], 2 * R, [])).toEqual([]);
  });
});
