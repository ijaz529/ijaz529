import { makeTable } from '../../src/core/table';
import type { Ball, TableLayout, TablePresetId } from '../../src/core/types';
import type { Vec2 } from '../../src/core/vec';

export function layout(balls: Record<string, Vec2>, preset: TablePresetId = 'pool9'): TableLayout {
  const table = makeTable(preset);
  const list: Ball[] = Object.entries(balls).map(([id, pos]) => ({ id, kind: id === 'cue' ? 'cue' : 'object', pos, label: id }));
  return { table, balls: list, source: 'virtual', frozen: false };
}
