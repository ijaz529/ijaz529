/**
 * Practice-table layouts that demonstrate the core physics (quickstart Q1–Q5).
 */
import { pocketWindow } from '../core/shot/pocket-window';
import { clampToTable, pocketById } from '../core/table';
import type { Ball, TableSpec } from '../core/types';
import { add, angleOf, fromAngle, rad, scale, sub, v2, type Vec2 } from '../core/vec';

const SOLIDS = ['#e8b90f', '#1f4fb4', '#c8231c', '#5c2a86', '#ef6c13', '#1b7a3c', '#7c1f2a', '#151515'];
const NUMBERS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15'];

export function objectBall(n: number, pos: Vec2): Ball {
  const i = (n - 1) % 8;
  return { id: `b${n}`, kind: 'object', pos, label: NUMBERS[n - 1] ?? String(n), color: n === 8 ? SOLIDS[7] : SOLIDS[i], stripe: n > 8 };
}
export const cueBall = (pos: Vec2): Ball => ({ id: 'cue', kind: 'cue', pos, label: 'cue' });

function cutShot(table: TableSpec, ob: Vec2, pocket: 'TR' | 'BR' | 'TM', cutDeg: number, dist: number): Ball[] {
  const w = pocketWindow(ob, pocketById(table, pocket), table.ballRadius);
  const ghost = sub(ob, scale(w.dir, 2 * table.ballRadius));
  const cue = sub(ghost, scale(fromAngle(angleOf(w.dir) + rad(cutDeg)), dist));
  return [cueBall(clampToTable(table, cue)), objectBall(1, ob)];
}

export const DRILLS: { id: string; name: string; build: (t: TableSpec) => Ball[] }[] = [
  {
    id: 'cut30',
    name: '30° cut (tangent line & 30° rule)',
    build: (t) => [...cutShot(t, v2(t.length * 0.16, t.width * 0.12), 'TR', 30, t.length * 0.3), objectBall(2, v2(-t.length * 0.25, -t.width * 0.2))],
  },
  {
    id: 'straight',
    name: 'Straight-in (stop, draw, follow)',
    build: (t) => {
      const p = pocketById(t, 'TR');
      return [cueBall(add(p.mouthCenter, scale(p.inward, 0.95))), objectBall(1, add(p.mouthCenter, scale(p.inward, 0.45)))];
    },
  },
  {
    id: 'rail',
    name: 'Ball on the rail',
    build: (t) => [cueBall(v2(-t.length * 0.05, t.width * 0.05)), objectBall(9, v2(t.length * 0.28, t.width / 2 - t.ballRadius - 0.002))],
  },
  {
    id: 'blocked',
    name: 'Blocked path (find another shot)',
    build: (t) => {
      const b = cutShot(t, v2(t.length * 0.16, t.width * 0.12), 'TR', 15, t.length * 0.35);
      const mid = v2((b[0]!.pos.x + b[1]!.pos.x) / 2, (b[0]!.pos.y + b[1]!.pos.y) / 2);
      return [...b, objectBall(5, mid), objectBall(3, v2(-t.length * 0.3, t.width * 0.3))];
    },
  },
  {
    id: 'scratch',
    name: 'Scratch danger (control the cue ball)',
    build: (t) => {
      const p = pocketById(t, 'TR');
      return [cueBall(add(p.mouthCenter, scale(p.inward, 0.6))), objectBall(7, add(p.mouthCenter, scale(p.inward, 0.25)))];
    },
  },
  {
    id: 'nine',
    name: '9-ball runout layout',
    build: (t) => {
      const L = t.length;
      const W = t.width;
      const pos: [number, number][] = [
        [0.1, 0.2],
        [0.35, -0.3],
        [-0.2, 0.35],
        [0.42, 0.38],
        [-0.38, -0.3],
        [0.05, -0.12],
        [0.3, 0.05],
        [-0.42, 0.1],
        [0.44, -0.4],
      ];
      return [cueBall(v2(-0.1 * L, -0.05 * W)), ...pos.map(([x, y], i) => objectBall(i + 1, v2(x * L, y * W)))];
    },
  },
];
