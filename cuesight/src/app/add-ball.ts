/**
 * "Add ball" on a table the player edits by hand (the practice table, a Snap layout): the new ball
 * goes on the free spot nearest the middle of the table — on the cloth, with at least a ball's
 * radius of cloth between it and every other ball — so the toast can say where it is, and the
 * player drags it from there. Deterministic (never random): the same layout gives the same spot.
 *
 * A Snap layout's balls are named by vision ("8", "black", "yellow stripe", "ball"), so a ball the
 * player adds there gets the neutral 'ball' (no number or colour another ball could already carry:
 * two "8" tags looked like a detection error). The practice table numbers its balls by their ids,
 * so a new one there takes the first free number that no ball's tag already shows.
 */
import type { Ball, TableSpec, Vec2 } from '../core/types';
import { cueBall, objectBall } from './drills';
import { tagText } from './ui/ball-tags';

/** Grid step of the search (fraction of the ball radius): the spot is the nearest to ±R/4. */
const STEP_R = 0.25;
/** Centre distance to every other ball (in ball radii): one radius of cloth between them. */
const CLEAR_R = 3;

export const ADD_BALL_TOASTS = {
  centre: 'Ball added in the middle of the table. Drag it to where it is.',
  near: 'Ball added near the middle of the table. Drag it to where it is.',
  full: 'No free spot on the table for another ball.',
} as const;

/** The free spot nearest the table's centre (table metres), or null when there is none. */
export function freeSpotNearCentre(table: TableSpec, balls: readonly Ball[]): Vec2 | null {
  const R = table.ballRadius;
  const step = R * STEP_R;
  const lx = table.length / 2 - R;
  const ly = table.width / 2 - R;
  const clear2 = (CLEAR_R * R) ** 2;
  const nx = Math.floor(lx / step);
  const ny = Math.floor(ly / step);
  let best: Vec2 | null = null;
  let bestD = Infinity;
  // Rows and columns outward from the centre; on equal distance the first found wins (deterministic).
  for (let i = 0; i <= nx; i++)
    for (const sx of i === 0 ? [1] : [1, -1])
      for (let j = 0; j <= ny; j++)
        for (const sy of j === 0 ? [1] : [1, -1]) {
          const p = { x: sx * i * step, y: sy * j * step };
          const d = p.x * p.x + p.y * p.y;
          if (d >= bestD) continue;
          if (balls.every((b) => (b.pos.x - p.x) ** 2 + (b.pos.y - p.y) ** 2 >= clear2)) {
            best = p;
            bestD = d;
          }
        }
  return best;
}

export interface AddedBall {
  ball: Ball;
  /** It sits on the table's centre spot itself (the toast says "in the middle", else "near"). */
  atCentre: boolean;
}

/**
 * The ball "Add ball" puts on `balls`: the cue ball when there is none yet, else an object ball, on
 * freeSpotNearCentre. `neutral` (Snap): labelled 'ball', with no colour; otherwise numbered by its id.
 * Null when the table has no free spot.
 */
export function addBallTo(table: TableSpec, balls: readonly Ball[], opts: { neutral: boolean }): AddedBall | null {
  const p = freeSpotNearCentre(table, balls);
  if (!p) return null;
  // A fresh id, and (numbered) a number no ball's tag already shows ("black" shows 8 on a pool table).
  const used = new Set(balls.map((b) => b.id));
  const tags = new Set(balls.map((b) => tagText(b)));
  let n = 1;
  while (used.has(`b${n}`) || (!opts.neutral && tags.has(String(n)))) n++;
  const atCentre = p.x === 0 && p.y === 0;
  if (!balls.some((b) => b.kind === 'cue')) return { ball: { ...cueBall(p), id: used.has('cue') ? `cue${n}` : 'cue' }, atCentre };
  const ball: Ball = opts.neutral ? { id: `b${n}`, kind: 'object', pos: p, label: 'ball' } : objectBall(n, p);
  return { ball, atCentre };
}
