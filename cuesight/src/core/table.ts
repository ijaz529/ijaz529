/**
 * Table presets and derived pocket/cushion geometry.
 *
 * Playing-surface dimensions are cushion-nose to cushion-nose (WPA / WPBSA nominal sizes).
 * Pocket mouths are nominal "between the jaws" widths; real tables vary ±5 mm, so every value is
 * overridable (FR-028).
 */
import type { PocketSpec, Segment, TableDims, TablePresetId, TableSpec } from './types';
import { norm, v2, type Vec2 } from './vec';

const IN = 0.0254;

export const TABLE_PRESETS: Record<TablePresetId, TableDims> = {
  pool9: {
    name: '9-ft pool',
    length: 2.54,
    width: 1.27,
    ballRadius: 0.05715 / 2,
    ballMass: 0.17,
    cornerMouth: 4.5 * IN, // WPA 4.5"–4.625"
    sideMouth: 5.0 * IN, // WPA 5"–5.125"
    cushionWidth: 0.05,
    cushionHeight: 0.635 * 0.05715,
  },
  pool8: {
    name: '8-ft pool',
    length: 2.235,
    width: 1.118,
    ballRadius: 0.05715 / 2,
    ballMass: 0.17,
    cornerMouth: 4.625 * IN,
    sideMouth: 5.125 * IN,
    cushionWidth: 0.05,
    cushionHeight: 0.635 * 0.05715,
  },
  pool7: {
    name: '7-ft bar box',
    length: 1.981,
    width: 0.991,
    ballRadius: 0.05715 / 2,
    ballMass: 0.17,
    cornerMouth: 4.625 * IN,
    sideMouth: 5.125 * IN,
    cushionWidth: 0.05,
    cushionHeight: 0.635 * 0.05715,
  },
  uk7: {
    // ASSUMPTION: single 2" ball size (UK cue ball is often 1⅞"); pocket sizes approximate.
    name: 'UK 7-ft pool',
    length: 1.829,
    width: 0.914,
    ballRadius: 0.0508 / 2,
    ballMass: 0.14,
    cornerMouth: 0.089,
    sideMouth: 0.095,
    cushionWidth: 0.045,
    cushionHeight: 0.635 * 0.0508,
  },
  snooker12: {
    // WPBSA: 11'8½" × 5'10" bed, 52.5 mm balls. Pocket openings approximate (templates vary).
    name: '12-ft snooker',
    length: 3.569,
    width: 1.778,
    ballRadius: 0.0525 / 2,
    ballMass: 0.142,
    cornerMouth: 0.086,
    sideMouth: 0.105,
    cushionWidth: 0.05,
    cushionHeight: 0.635 * 0.0525,
  },
};

export function makeTable(preset: TablePresetId, overrides: Partial<TableDims> = {}): TableSpec {
  const d: TableDims = { ...TABLE_PRESETS[preset], ...overrides };
  const hx = d.length / 2;
  const hy = d.width / 2;
  const g = d.cornerMouth / Math.SQRT2;
  const s = d.sideMouth / 2;

  const pocket = (id: PocketSpec['id'], kind: PocketSpec['kind'], a: Vec2, b: Vec2, inward: Vec2): PocketSpec => ({
    id,
    kind,
    jawA: a,
    jawB: b,
    mouthCenter: v2((a.x + b.x) / 2, (a.y + b.y) / 2),
    inward: norm(inward),
  });

  // Jaws ordered counter-clockwise around the boundary (bottom rail L→R, right rail B→T, ...).
  const pockets: PocketSpec[] = [
    pocket('BL', 'corner', v2(-hx, -hy + g), v2(-hx + g, -hy), v2(1, 1)),
    pocket('BM', 'side', v2(-s, -hy), v2(s, -hy), v2(0, 1)),
    pocket('BR', 'corner', v2(hx - g, -hy), v2(hx, -hy + g), v2(-1, 1)),
    pocket('TR', 'corner', v2(hx, hy - g), v2(hx - g, hy), v2(-1, -1)),
    pocket('TM', 'side', v2(s, hy), v2(-s, hy), v2(0, -1)),
    pocket('TL', 'corner', v2(-hx + g, hy), v2(-hx, hy - g), v2(1, -1)),
  ];
  const P = Object.fromEntries(pockets.map((p) => [p.id, p])) as Record<PocketSpec['id'], PocketSpec>;
  const seg = (a: Vec2, b: Vec2, n: Vec2): Segment => ({ a, b, n });
  const cushions: Segment[] = [
    seg(P.BL.jawB, P.BM.jawA, v2(0, 1)),
    seg(P.BM.jawB, P.BR.jawA, v2(0, 1)),
    seg(P.BR.jawB, P.TR.jawA, v2(-1, 0)),
    seg(P.TR.jawB, P.TM.jawA, v2(0, -1)),
    seg(P.TM.jawB, P.TL.jawA, v2(0, -1)),
    seg(P.TL.jawB, P.BL.jawA, v2(1, 0)),
  ];
  return { ...d, id: preset, pockets, cushions };
}

/** Keep a ball centre on the playing surface (at least R from every cushion line). */
export function clampToTable(table: TableSpec, p: Vec2): Vec2 {
  const mx = table.length / 2 - table.ballRadius;
  const my = table.width / 2 - table.ballRadius;
  return v2(Math.max(-mx, Math.min(mx, p.x)), Math.max(-my, Math.min(my, p.y)));
}

export function pocketById(table: TableSpec, id: PocketSpec['id']): PocketSpec {
  const p = table.pockets.find((q) => q.id === id);
  if (!p) throw new Error(`Unknown pocket ${id}`);
  return p;
}

export const POCKET_NAMES: Record<PocketSpec['id'], string> = {
  BL: 'bottom-left corner',
  BM: 'bottom side',
  BR: 'bottom-right corner',
  TL: 'top-left corner',
  TM: 'top side',
  TR: 'top-right corner',
};
