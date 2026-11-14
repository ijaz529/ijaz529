/**
 * Shared domain types (see specs/001-realtime-shot-guide/data-model.md).
 * Units: SI (m, s, rad). Table frame origin = centre of playing surface, +x along long rail.
 */
import type { Vec2, Vec3 } from './vec';

export type { Vec2, Vec3 };

export type TablePresetId = 'pool9' | 'pool8' | 'pool7' | 'uk7' | 'snooker12';
export type PocketId = 'BL' | 'BM' | 'BR' | 'TL' | 'TM' | 'TR';

export interface TableDims {
  name: string;
  length: number;
  width: number;
  ballRadius: number;
  ballMass: number;
  cornerMouth: number;
  sideMouth: number;
  /** Nose → outer cloth edge, used by vision only. */
  cushionWidth: number;
  /** Cushion nose height above the bed, used by vision only. */
  cushionHeight: number;
}

export interface PocketSpec {
  id: PocketId;
  kind: 'corner' | 'side';
  /** Jaw points on the cushion-nose rectangle, ordered counter-clockwise around the table. */
  jawA: Vec2;
  jawB: Vec2;
  mouthCenter: Vec2;
  /** Unit vector from the pocket into the table (bisector). */
  inward: Vec2;
}

export interface Segment {
  a: Vec2;
  b: Vec2;
  /** Inward unit normal (points into the playing surface). */
  n: Vec2;
}

export interface TableSpec extends TableDims {
  id: TablePresetId;
  pockets: PocketSpec[];
  cushions: Segment[];
}

export interface BallFrictionModel {
  a: number;
  b: number;
  c: number;
}

export interface PhysicsParams {
  g: number;
  muSlide: number;
  muRoll: number;
  spinDecel: number;
  eBall: number;
  ballFriction: BallFrictionModel;
  cushionE0: number;
  cushionESlope: number;
  cushionEMin: number;
  muCushion: number;
  squirtMassRatio: number;
  dt: number;
  maxTime: number;
  pocketArrivalSpeed: number;
}

export type BallKind = 'cue' | 'object';

export interface Ball {
  id: string;
  kind: BallKind;
  pos: Vec2;
  label?: string;
  color?: string;
  stripe?: boolean;
  confidence?: number;
}

export interface TableLayout {
  table: TableSpec;
  balls: Ball[];
  source: 'camera' | 'virtual';
  frozen: boolean;
}

export interface Stroke {
  /** 1..10, fractional allowed. */
  power: number;
  /** Tip offset as a fraction of R; + = right english. */
  side: number;
  /** Tip offset as a fraction of R; + = follow (top), − = draw (bottom). */
  vert: number;
}

export interface ShotRequest {
  targetId: string;
  pocketId?: PocketId;
  stroke?: Stroke;
  landing?: Vec2;
}

export type SimEventKind = 'ball' | 'cushion' | 'jaw' | 'pocket' | 'roll' | 'stop';

export interface SimEvent {
  t: number;
  kind: SimEventKind;
  ballId: string;
  otherId?: string;
  pos: Vec2;
}

export interface Trajectory {
  ballId: string;
  points: Vec2[];
  events: SimEvent[];
  rest: Vec2 | null;
  pocket: PocketId | null;
}

export type WarningCode =
  | 'not-makeable'
  | 'blocked-cue'
  | 'blocked-object'
  | 'scratch'
  | 'too-soft'
  | 'kiss'
  | 'ob-missed'
  | 'thin-cut'
  | 'frozen'
  | 'miscue-risk';

export interface Warning {
  code: WarningCode;
  message: string;
  ballId?: string;
}

export type Difficulty = 'easy' | 'medium' | 'hard' | 'very hard';

export interface ShotPlan {
  targetId: string;
  pocketId: PocketId;
  makeable: boolean;
  ghost: Vec2;
  ghostUncorrected: Vec2;
  aimDir: Vec2;
  contactPoint: Vec2;
  obDir: Vec2;
  cutAngleDeg: number;
  /** Signed cut: + means the object ball goes to the left of the cue-ball line (CCW). */
  cutSide: 1 | -1 | 0;
  fraction: number;
  fractionLabel: string;
  throwDeg: number;
  throwShiftMm: number;
  squirtDeg: number;
  stroke: Stroke;
  strokeSource: 'player' | 'recommended' | 'default';
  minPower: number;
  cuePath: Trajectory;
  objectPath: Trajectory;
  otherPaths: Trajectory[];
  cueRest: Vec2 | null;
  obPocketed: boolean;
  scratch: boolean;
  windowHalfDeg: number;
  toleranceDeg: number;
  toleranceMm: number;
  difficulty: Difficulty;
  warnings: Warning[];
  tip: string;
  cbSpeedAtContact: number;
  obSpeed: number;
  /** Alternative pockets ranked by tolerance (for not-makeable or comparison). */
  alternatives: { pocketId: PocketId; toleranceDeg: number }[];
}

export interface ShotSuggestion {
  targetId: string;
  pocketId: PocketId;
  toleranceDeg: number;
  difficulty: Difficulty;
  score: number;
}

export interface Recommendation {
  stroke: Stroke;
  score: number;
  reachable: boolean;
  restError?: number;
  rest?: Vec2 | null;
  evaluated: number;
}
