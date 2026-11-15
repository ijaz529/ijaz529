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
  /** Simulated time (s) of each recorded point (recorded runs only). */
  times?: number[];
  /** Angular velocity ω (rad/s, world frame) at each recorded point, so replays can show slide and spin, not just rolling. */
  spins?: Vec3[];
}

export type WarningCode =
  | 'not-makeable'
  /** The cue ball stops before it reaches the object ball (the shot cannot happen at this power and spin). */
  | 'cb-short'
  | 'blocked-cue'
  | 'blocked-object'
  | 'scratch'
  | 'too-soft'
  | 'kiss'
  | 'ob-missed'
  | 'thin-cut'
  | 'frozen'
  | 'miscue-risk'
  /** The simulated ball misses because no aim with the ghost clear of the rail cancels the throw. */
  | 'throw-uncompensable';

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
  /** Unit direction the cue ball travels (cue ball → ghost ball): the line the app draws. */
  aimDir: Vec2;
  /** Same vector as cueDir (the name wave-1 consumers use); optional for older producers. */
  cueAimDir?: Vec2;
  contactPoint: Vec2;
  obDir: Vec2;
  cutAngleDeg: number;
  /** Signed cut: + means the object ball goes to the left of the cue-ball line (CCW). */
  cutSide: 1 | -1 | 0;
  fraction: number;
  /**
   * Coaching label (geometry.ts fractionOf): 'full' (≥ 97 % overlap), the nearest eighth ('⅞' … '⅛')
   * prefixed 'thin '/'thick ' when the cut is more than 1.5° off that eighth's own cut, or 'thin'
   * below 1/16 overlap. A frozen cue ball has cut 0, so 'full'.
   */
  fractionLabel: string;
  /** The same label in words, qualified by the same 1.5° rule ("a touch thinner than ½-ball"). */
  fractionPhrase: string;
  throwDeg: number;
  throwShiftMm: number;
  /**
   * Which way the throw-compensated ghost ball moved from the plain one (ghostUncorrected), as the
   * player aims it: 'thinner' (the usual cut-induced throw) or 'thicker' (outside english throws the
   * ball thin) on a cut, 'left'/'right' of full ball on a hit the fraction label calls "full"; null
   * when there is no shift (and for a frozen cue ball, which has no ghost ball).
   */
  throwAim: 'thinner' | 'thicker' | 'left' | 'right' | null;
  /** Same as throwAim, absent instead of null (the name an earlier wave-1 draft used). */
  throwShiftDir?: 'thinner' | 'thicker' | 'left' | 'right';
  squirtDeg: number;
  /**
   * Unit direction of the cue stick: aimDir rotated by the squirt correction (clockwise for right
   * english), so the ball squirts onto aimDir. Equal to aimDir without side spin. The app draws the
   * cue (3D cue, Snap strike point) along it; the drawn ball path stays aimDir.
   */
  cueDir: Vec2;
  stroke: Stroke;
  strokeSource: 'player' | 'recommended' | 'default';
  /**
   * Lowest power (analytic chain) at which the object ball reaches the pocket mouth with some pace
   * (≥ params.pocketArrivalSpeed); > 10: not even at full power (unchanged meaning). The minimum the
   * app shows; the cb-short / too-soft advice and the tip quote it rounded UP to a settable half
   * step (power.ts advisePower), so the figure they quote never triggers them.
   * Frozen cue ball: the stroke angle, and with it the minimum, changes with the power (harder
   * throws less, so the angle grows and the object ball gets less of the speed). It is the minimum
   * for the angle found at the played power, except when the played stroke is too soft: then the
   * stroke is re-planned at each half step above, and minPower is the lowest power (to ≈0.06) that
   * pots it with pace and keeps the cue ball up — advisePower of it is the first power the warning
   * quotes — or 10.5 when no power does (the warning then says so; harder won't help).
   */
  minPower: number;
  /**
   * Lowest power (analytic chain) at which the cue ball reaches the object ball and the object ball
   * just crosses the pocket's capture line (≤ minPower; > 10: not even at full power). Below it the
   * ball stops short; between it and minPower it only just drops. Optimistic: the chain ignores the
   * backspin a rolling cue ball gives the object ball, and the simulation needs ≈6 % more cue-ball
   * speed (median of 50 random pool9 layouts, up to 12 %). The position search starts here.
   * Always set by planShot. Frozen cue ball: for the stroke angle found at the played power, capped
   * at minPower when that is re-planned (see minPower).
   */
  minPowerCapture?: number;
  /** @deprecated Same as minPower (kept for consumers of an earlier draft). */
  minPowerSafe?: number;
  /**
   * Frozen cue ball, a stroke too soft at the played power, and no power on the scale pots it with
   * pace and keeps the cue ball up (minPower is then 10.5, and the too-soft warning says so): more
   * power is not the answer, so the app must not say "needs more than full power". 'throw': harder
   * throws it less (from some power on it misses for lack of throw); 'other': no power works for
   * another reason (it scratches, or never drops with pace). Absent otherwise.
   */
  noWorkingPower?: 'throw' | 'other';
  /**
   * True when the frozen power advice was skipped (PlanOptions.advice false, the default for a plan
   * with record: false): the too-soft warning then gives no power figure, minPower is the minimum
   * for the stroke angle at the played power and noWorkingPower is not known. Plan again with the
   * advice on (planner worker 'plan' message, contracts/worker-protocol-v2.md) before showing it as
   * final. Absent whenever nothing was skipped.
   */
  adviceSkipped?: boolean;
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
  /** The stroke as coaches name it ("Draw", "Stun", "Stop shot", "Follow, right english"); null when the cue ball stops short. */
  strokeName: string | null;
  cbSpeedAtContact: number;
  obSpeed: number;
  /** Object-ball speed (m/s) as it crosses into the pocket (0 when it does not drop). */
  obPocketSpeed: number;
  /** Alternative pockets ranked by tolerance (for not-makeable or comparison). */
  alternatives: { pocketId: PocketId; toleranceDeg: number }[];
}

export interface ShotSuggestion {
  targetId: string;
  pocketId: PocketId;
  toleranceDeg: number;
  /** Margin of error as contact on the object ball (mm), the unit the shot card uses. */
  toleranceMm: number;
  difficulty: Difficulty;
  score: number;
}

/**
 * A way the recommended stroke goes wrong under a small, typical error (the robustness probes): the
 * cue ball drops in `pocketId` if the stroke is played a little harder/softer, with the tip a little
 * off, or with a small aim error.
 */
export interface StrokeRisk {
  scratchIf: 'harder' | 'softer' | 'aim' | 'tip';
  pocketId: PocketId;
}

export interface Recommendation {
  stroke: Stroke;
  /**
   * Robust score: the worst of the nominal stroke and the same cue line mis-hit at ±6/±12 % of its
   * true speed, averaged half and half with the worst tip/aim/shaft mis-hit when those probes ran
   * (position.ts header); the nominal score when fragile; −Infinity only when no stroke pots the
   * ball. Includes the coaching penalties (a last-resort stroke, e.g. one the card calls too soft,
   * scores about 10 lower).
   */
  score: number;
  reachable: boolean;
  restError?: number;
  rest?: Vec2 | null;
  /** Simulations run: grid plans, half steps and robustness mis-hits (deterministic for a given layout, request and budget). */
  evaluated: number;
  /**
   * Cue-ball scratches seen when the chosen stroke was mis-hit in the robustness checks (speed, tip,
   * aim, shaft squirt). An array, empty when none scratched, whenever the stroke passed and all of
   * those checks ran (fragile unset). Absent when the evaluation budget ran out before the tip/aim
   * probes of a stroke that passed the speed check, and for a fragile stroke whose check found no
   * scratch or never ran; a fragile stroke's list holds the scratches its check found. Absent means
   * "not known", never "safe".
   */
  risks?: StrokeRisk[];
  /**
   * True when no stroke was verified against ±6/±12 % speed errors (every candidate checked scratched
   * or missed at some speed, or the evaluation budget ran out first): treat the stroke as possibly
   * speed-sensitive and say so. Overhits past full power can't be played and are never tested, so a
   * stroke near full power is verified against its underhits only.
   */
  fragile?: boolean;
  /** Next-shot quality (0..1) of the chosen stroke on the post-shot table (default objective only). */
  nextQuality?: number;
  /** The optional wall-clock safety cap (RecommendOptions.timeCapMs) cut the search short. */
  timedOut?: boolean;
}
