/**
 * Snap step 2 (feature 002 US2, FR-117…FR-121): what to draw on the player's table-level photo, in
 * image pixels, from the estimated camera pose and the shot plan. Pure and deterministic (no DOM), so
 * the geometry is unit-tested against the synthetic fixtures' ground-truth poses.
 *
 * World = table frame (metres, z up, bed at z = 0, ball centres at z = R). Lines "on the cloth" (aim
 * line, object-ball and cue-ball paths) are drawn at z = 0; spheres (cue, ghost, target) are their exact
 * silhouettes. Everything is clipped against a near plane in front of the camera, so a path that runs
 * behind the photographer is cut, never mirrored.
 */
import { describeSpin } from '../../core/shot/power';
import type { PocketId, ShotPlan, Stroke, TableSpec, Vec2, Vec3 } from '../../core/types';
import { projectBallOutline, strikePoint, type CameraPose } from '../../vision/player-view';

/** Cue-tip radius used to size the strike dot (a 13 mm tip). ASSUMPTION: typical pool tip. */
export const TIP_RADIUS_M = 0.0065;
/** Miscue limit as a fraction of R (the 001 planner clamps side² + vert² ≤ 0.25). */
export const MISCUE_FRAC = 0.5;
const NEAR = 0.03;

export interface GuideInput {
  pose: CameraPose;
  table: TableSpec;
  plan: ShotPlan;
  /** Cue-ball centre on the table (the plan's start). */
  cue: Vec2;
  /** Target (object) ball centre. */
  target: Vec2 | null;
  /** The stroke to show (normally plan.stroke). */
  stroke: Pick<Stroke, 'side' | 'vert' | 'power'>;
  /** Pockets the cue ball could drop into with a small error (scratch risk), ringed dashed. */
  riskPockets?: PocketId[];
}

export interface StrikeMark {
  /** Image px of the tip's contact point. */
  p: Vec2;
  /** Projected tip radius in px (≥ 1). */
  r: number;
  /** On the side of the ball the camera sees. */
  visible: boolean;
  inFrame: boolean;
}

/**
 * The strike point as coaches draw it: the cue ball's face seen straight along the cue, a flat disc
 * over the ball in the photo with the tip dot at (side·r, −vert·r) from its centre. Unlike the
 * projected `strike` (a point on the back of the ball seen from above, which drops below centre for
 * a high hit), "high" is always above centre here, so the picture agrees with the words.
 */
export interface StrikeFace {
  /** Centre and radius of the cue ball in the photo (px). */
  c: Vec2;
  r: number;
  /** The tip's contact point on the face (px) and its radius (px). */
  dot: Vec2;
  dotR: number;
  /** Miscue-limit ring radius (px). */
  miscueR: number;
}

/** Face-on strike mark for a cue ball drawn at centre c with radius r (pure). */
export function strikeFace(c: Vec2, r: number, side: number, vert: number): StrikeFace {
  const m = Math.hypot(side, vert);
  const k = m > MISCUE_FRAC * 1.8 ? (MISCUE_FRAC * 1.8) / m : 1;
  return { c, r, dot: { x: c.x + side * k * r, y: c.y - vert * k * r }, dotR: Math.max(2.5, (TIP_RADIUS_M / 0.028575) * r), miscueR: MISCUE_FRAC * r };
}

export interface PlayerGuide {
  /** Aim line on the cloth, cue ball → ghost ball (visible runs). */
  aim: Vec2[][];
  objectPath: Vec2[][];
  cuePath: Vec2[][];
  /** Silhouettes (closed polygons, empty when not drawable). */
  ghost: Vec2[];
  target: Vec2[];
  cueBall: Vec2[];
  /** Pocket mouth ring on the bed. */
  pocket: Vec2[][];
  /** Scratch-risk rings (one list of runs per risky pocket). */
  risk: Vec2[][][];
  pocketId: PocketId;
  /** Contact point on the object ball at ball-centre height. */
  contact: Vec2 | null;
  ghostCenter: Vec2 | null;
  cueCenter: Vec2 | null;
  /** Projected cue-ball radius at its centre (px), for the inset crop. */
  cueRadiusPx: number;
  /** Where the tip meets the ball in 3D, projected (location only: see `face` for display). */
  strike: StrikeMark | null;
  /** The strike point face-on over the cue ball (what is drawn). Null when the cue ball is not in the photo. */
  face: StrikeFace | null;
  /** Miscue-limit ring and centre cross on the cue ball's face (front-facing runs only). */
  miscue: Vec2[][];
  cross: Vec2[][];
  /** The cue's axis behind the strike point, toward the player (faint guide). */
  cueAxis: Vec2[][];
  inFrame: { cue: boolean; ghost: boolean; target: boolean; pocket: boolean };
  /** Player-facing notes on what is not visible and how to fix it (FR-119). */
  messages: string[];
}

// -------------------------------------------------------------------------------------------------
// Camera helpers
// -------------------------------------------------------------------------------------------------
function toCam(pose: CameraPose, p: Vec3): Vec3 {
  const R = pose.R;
  return {
    x: R[0]! * p.x + R[1]! * p.y + R[2]! * p.z + pose.t.x,
    y: R[3]! * p.x + R[4]! * p.y + R[5]! * p.z + pose.t.y,
    z: R[6]! * p.x + R[7]! * p.y + R[8]! * p.z + pose.t.z,
  };
}

function pix(pose: CameraPose, c: Vec3): Vec2 {
  return { x: (pose.f * c.x) / c.z + pose.cx, y: (pose.f * c.y) / c.z + pose.cy };
}

/** Camera centre in world coordinates: C = −Rᵀ t. */
export function cameraCenter(pose: CameraPose): Vec3 {
  const R = pose.R;
  const t = pose.t;
  return {
    x: -(R[0]! * t.x + R[3]! * t.y + R[6]! * t.z),
    y: -(R[1]! * t.x + R[4]! * t.y + R[7]! * t.z),
    z: -(R[2]! * t.x + R[5]! * t.y + R[8]! * t.z),
  };
}

export function inImage(pose: CameraPose, p: Vec2, margin = 0): boolean {
  return p.x >= -margin && p.y >= -margin && p.x <= pose.width + margin && p.y <= pose.height + margin;
}

/**
 * Projects a 3D polyline, clipped to the half-space in front of the camera (z_cam ≥ NEAR). Returns the
 * visible runs (each with ≥ 2 points). Long segments are subdivided (`maxSeg` metres) so the projected
 * curve stays exact near the clip plane; points for which `hidden` returns true (e.g. cloth behind a
 * ball as seen from the camera) split the run.
 */
export function projectPolyline(pose: CameraPose, pts: Vec3[], maxSeg = 0.05, hidden?: (p: Vec3) => boolean): Vec2[][] {
  const runs: Vec2[][] = [];
  let run: Vec2[] = [];
  const flush = () => {
    if (run.length >= 2) runs.push(run);
    run = [];
  };
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) / maxSeg));
    for (let k = 0; k < n; k++) {
      const p = lerp3(a, b, k / n);
      const q = lerp3(a, b, (k + 1) / n);
      if (hidden && (hidden(p) || hidden(q))) {
        flush();
        continue;
      }
      let ca = toCam(pose, p);
      let cb = toCam(pose, q);
      const ina = ca.z >= NEAR;
      const inb = cb.z >= NEAR;
      if (!ina && !inb) {
        flush();
        continue;
      }
      if (!ina) ca = clipNear(ca, cb);
      if (!inb) cb = clipNear(cb, ca);
      const pa = pix(pose, ca);
      if (!ina || run.length === 0) {
        if (!ina) flush();
        run.push(pa);
      }
      run.push(pix(pose, cb));
      if (!inb) flush();
    }
  }
  flush();
  return runs;
}

/** True when the segment camera → p passes through any of the spheres (centre, radius r) before p. */
export function occluded(C: Vec3, p: Vec3, centres: Vec3[], r: number): boolean {
  const dx = p.x - C.x;
  const dy = p.y - C.y;
  const dz = p.z - C.z;
  const L2 = dx * dx + dy * dy + dz * dz;
  for (const q of centres) {
    const fx = C.x - q.x;
    const fy = C.y - q.y;
    const fz = C.z - q.z;
    const b = fx * dx + fy * dy + fz * dz;
    const c = fx * fx + fy * fy + fz * fz - r * r;
    const disc = b * b - L2 * c;
    if (disc <= 0) continue;
    const t = (-b - Math.sqrt(disc)) / L2;
    if (t > 1e-6 && t < 1 - 1e-6) return true;
  }
  return false;
}

function lerp3(a: Vec3, b: Vec3, t: number): Vec3 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
}

/** Point on segment out→in where z = NEAR. */
function clipNear(out: Vec3, inside: Vec3): Vec3 {
  const t = (NEAR - out.z) / (inside.z - out.z);
  return lerp3(out, inside, t);
}

// -------------------------------------------------------------------------------------------------
// Guide
// -------------------------------------------------------------------------------------------------
const on = (p: Vec2, z = 0): Vec3 => ({ x: p.x, y: p.y, z });

/** Circle on the bed (z = 0) around `c`. */
function bedCircle(c: Vec2, r: number, n = 40): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i <= n; i++) {
    const a = (2 * Math.PI * i) / n;
    out.push({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a), z: 0 });
  }
  return out;
}

/**
 * Runs of a closed curve on the cue ball's surface that face the camera (P − C)·(P − c) < 0.
 * `pts` are world points on the sphere.
 */
function frontRuns(pose: CameraPose, C: Vec3, centre: Vec3, pts: Vec3[]): Vec2[][] {
  const runs: Vec2[][] = [];
  let run: Vec2[] = [];
  for (const p of pts) {
    const front = (p.x - C.x) * (p.x - centre.x) + (p.y - C.y) * (p.y - centre.y) + (p.z - C.z) * (p.z - centre.z) < 0;
    const c = toCam(pose, p);
    if (front && c.z > NEAR) run.push(pix(pose, c));
    else {
      if (run.length >= 2) runs.push(run);
      run = [];
    }
  }
  if (run.length >= 2) runs.push(run);
  return runs;
}

function centroid(poly: Vec2[]): Vec2 | null {
  if (!poly.length) return null;
  let x = 0;
  let y = 0;
  for (const p of poly) {
    x += p.x;
    y += p.y;
  }
  return { x: x / poly.length, y: y / poly.length };
}

/**
 * FR-119: the cue ball is (partly) in the photo but the strike point on its face is not, e.g. a draw
 * stroke on a cue ball cut by the bottom edge. Says where it went and which way to aim the phone.
 */
function strikeOffPhoto(pose: CameraPose, p: Vec2): string {
  const dx = p.x < 0 ? -p.x : Math.max(0, p.x - pose.width);
  const dy = p.y < 0 ? -p.y : Math.max(0, p.y - pose.height);
  const [where, fix] =
    dy >= dx
      ? p.y > pose.height
        ? ['below', 'aim the phone a little lower']
        : ['above', 'aim the phone a little higher']
      : p.x < 0
        ? ['left of', 'turn a little to the left']
        : ['right of', 'turn a little to the right'];
  return `The strike point is just ${where} the photo: ${fix} and retake. It is shown on the spin ball.`;
}

function polyInFrame(pose: CameraPose, poly: Vec2[]): boolean {
  return poly.length > 0 && poly.some((p) => inImage(pose, p));
}

export function buildPlayerGuide(i: GuideInput): PlayerGuide {
  const { pose, table, plan } = i;
  const R = table.ballRadius;
  const C = cameraCenter(pose);
  const cue3 = on(i.cue, R);
  // The cue itself points along the squirt-corrected direction (equal to aim without side spin).
  const cd = plan.cueDir ?? plan.aimDir;
  const cdL = Math.hypot(cd.x, cd.y) || 1;
  const cueDir = { x: cd.x / cdL, y: cd.y / cdL };

  // Lines on the cloth disappear where a real ball (cue, target) hides the cloth from the camera.
  const solid = [cue3, ...(i.target ? [on(i.target, R)] : [])];
  const hidden = (p: Vec3) => occluded(C, p, solid, R);
  // Aim line on the cloth: from under the cue ball to under the ghost ball.
  const aimRuns = projectPolyline(pose, [on(i.cue), on(plan.ghost)], 0.004, hidden);
  const obPts = plan.objectPath.points.map((p) => on(p));
  const cbPts = plan.cuePath.points.map((p) => on(p));
  const objectPath = obPts.length >= 2 ? projectPolyline(pose, obPts, 0.01, hidden) : [];
  const cuePath = cbPts.length >= 2 ? projectPolyline(pose, cbPts, 0.01, hidden) : [];

  const ghost = projectBallOutline(pose, on(plan.ghost, R), R);
  const target = i.target ? projectBallOutline(pose, on(i.target, R), R) : [];
  const cueBall = projectBallOutline(pose, cue3, R);

  const pk = table.pockets.find((p) => p.id === plan.pocketId)!;
  const mouth = pk.kind === 'corner' ? table.cornerMouth : table.sideMouth;
  // Hole centre a little behind the mouth line (pockets sit outside the cushion nose).
  const hole = { x: pk.mouthCenter.x - pk.inward.x * mouth * 0.25, y: pk.mouthCenter.y - pk.inward.y * mouth * 0.25 };
  const pocket = projectPolyline(pose, bedCircle(hole, mouth * 0.55));
  const risk = (i.riskPockets ?? [])
    .filter((id) => id !== plan.pocketId)
    .map((id) => {
      const rp = table.pockets.find((p) => p.id === id)!;
      const rm = rp.kind === 'corner' ? table.cornerMouth : table.sideMouth;
      return projectPolyline(pose, bedCircle({ x: rp.mouthCenter.x - rp.inward.x * rm * 0.25, y: rp.mouthCenter.y - rp.inward.y * rm * 0.25 }, rm * 0.6));
    });

  const cc = toCam(pose, { x: plan.contactPoint.x, y: plan.contactPoint.y, z: R });
  const contact = cc.z > NEAR ? pix(pose, cc) : null;
  const gc = toCam(pose, on(plan.ghost, R));
  const ghostCenter = gc.z > NEAR ? pix(pose, gc) : null;
  const ccam = toCam(pose, cue3);
  const cueCenter = ccam.z > NEAR ? pix(pose, ccam) : null;
  const dCue = Math.hypot(ccam.x, ccam.y, ccam.z);
  const cueRadiusPx = ccam.z > NEAR ? (pose.f * R) / Math.sqrt(Math.max(1e-9, dCue * dCue - R * R)) : 0;

  // Strike point and its marks on the ball's face.
  const side = i.stroke.side;
  const vert = i.stroke.vert;
  const sp = strikePoint(cue3, cueDir, side, vert, R);
  const spc = toCam(pose, sp);
  let strike: StrikeMark | null = null;
  if (spc.z > NEAR) {
    const p = pix(pose, spc);
    const visible = (sp.x - C.x) * (sp.x - cue3.x) + (sp.y - C.y) * (sp.y - cue3.y) + (sp.z - C.z) * (sp.z - cue3.z) < 0;
    strike = { p, r: Math.max(1, (pose.f * TIP_RADIUS_M) / spc.z), visible, inFrame: inImage(pose, p) };
  }
  const ring: Vec3[] = [];
  for (let k = 0; k <= 48; k++) {
    const a = (2 * Math.PI * k) / 48;
    ring.push(strikePoint(cue3, cueDir, MISCUE_FRAC * Math.cos(a), MISCUE_FRAC * Math.sin(a), R));
  }
  const miscue = frontRuns(pose, C, cue3, ring);
  const crossH: Vec3[] = [];
  const crossV: Vec3[] = [];
  for (let k = 0; k <= 16; k++) {
    const u = -MISCUE_FRAC + (2 * MISCUE_FRAC * k) / 16;
    crossH.push(strikePoint(cue3, cueDir, u, 0, R));
    crossV.push(strikePoint(cue3, cueDir, 0, u, R));
  }
  const cross = [...frontRuns(pose, C, cue3, crossH), ...frontRuns(pose, C, cue3, crossV)];
  // The cue: a level line from the strike point back toward the shooter along the cue's own
  // direction (squirt-corrected), 0.9 m long.
  const cueAxis = projectPolyline(pose, [sp, { x: sp.x - cueDir.x * 0.9, y: sp.y - cueDir.y * 0.9, z: sp.z + 0.04 }]);

  const inFrame = {
    cue: polyInFrame(pose, cueBall),
    ghost: polyInFrame(pose, ghost),
    target: target.length ? polyInFrame(pose, target) : false,
    pocket: pocket.some((r) => r.some((p) => inImage(pose, p))),
  };

  const face = inFrame.cue && cueCenter && cueRadiusPx > 0 ? strikeFace(cueCenter, cueRadiusPx, side, vert) : null;
  const messages: string[] = [];
  if (!inFrame.cue) messages.push('The cue ball is outside the photo. Step back a little so the cue ball is in the picture, then retake.');
  else if (strike && !strike.visible) messages.push('This photo is not from behind the cue ball. Crouch behind it, facing the shot, and retake. The strike point is shown on the spin ball.');
  else if (face && !inImage(pose, face.dot)) messages.push(strikeOffPhoto(pose, face.dot));
  if (!inFrame.ghost && !inFrame.target) messages.push('The target ball is out of the photo. Turn toward the shot and retake.');
  else if (!inFrame.pocket) messages.push('The pocket is out of the photo. Follow the orange line off the edge.');

  return {
    aim: aimRuns,
    objectPath,
    cuePath,
    ghost,
    target,
    cueBall,
    pocket,
    risk,
    pocketId: plan.pocketId,
    contact,
    ghostCenter,
    cueCenter: cueCenter ?? centroid(cueBall),
    cueRadiusPx,
    strike,
    face,
    miscue,
    cross,
    cueAxis,
    inFrame,
    messages,
  };
}

/** Confidence chip wording (data-model.md § PlayerGuide). */
export function confidenceLabel(c: number): { word: 'good' | 'fair' | 'low'; pct: number; text: string } {
  const pct = Math.round(Math.max(0, Math.min(1, c)) * 100);
  const word = c >= 0.8 ? 'good' : c >= 0.6 ? 'fair' : 'low';
  return { word, pct, text: `Fit: ${word} · ${pct}%` };
}

/** Scales a focal length between two photos of the same camera (focal px follows the long side). */
export function scaleFocal(focal: number, from: { width: number; height: number }, to: { width: number; height: number }): number {
  return (focal * Math.max(to.width, to.height)) / Math.max(1, Math.max(from.width, from.height));
}

/** Where to show the strike point in words, coach-style (e.g. "½ tip low"), via the 001 wording. */
export function strikeHeadline(stroke: Pick<Stroke, 'side' | 'vert'>, describe: (s: Pick<Stroke, 'side' | 'vert'>) => string): string {
  const d = describe(stroke);
  return d === 'centre ball' ? 'Strike dead centre' : `Strike ${d}`;
}

/**
 * Where to strike in words a player can follow without a diagram: "½ tip above centre",
 * "1 tip below centre, ¼ tip right", "dead centre" — the app's one spin vocabulary (describeSpin).
 */
export function strikeWords(stroke: Pick<Stroke, 'side' | 'vert'>): string {
  const d = describeSpin(stroke);
  return d === 'centre ball' ? 'dead centre' : d;
}

/**
 * Region of the player photo worth zooming onto (photo px): the cue ball, the ghost and target
 * balls, the contact point and the pocket, clipped to the photo. Null when there is nothing to frame.
 */
export function guideFocus(g: PlayerGuide, width: number, height: number): { x0: number; y0: number; x1: number; y1: number } | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const add = (p: Vec2) => {
    if (p.x < 0 || p.y < 0 || p.x > width || p.y > height) return;
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  };
  for (const poly of [g.cueBall, g.ghost, g.target]) for (const p of poly) add(p);
  if (g.contact) add(g.contact);
  for (const run of g.pocket) for (const p of run) add(p);
  if (!Number.isFinite(x0) || x1 - x0 < 4 || y1 - y0 < 4) return null;
  return { x0, y0, x1, y1 };
}

/** A plan the player can actually play: makeable, and the cue ball gets to the object ball. */
export function playable(plan: Pick<ShotPlan, 'makeable' | 'warnings'>): boolean {
  return plan.makeable && !plan.warnings.some((w) => w.code === 'cb-short');
}

/**
 * What the guide's how-to panel says when the shot cannot be played as planned: the reason first, and
 * the best other pocket to try — never a strike point or a power (Principle II).
 */
export function unplayableHeadline(plan: Pick<ShotPlan, 'makeable' | 'warnings' | 'alternatives'>): { title: string; reason: string; altPocketId: PocketId | null } {
  const short = plan.warnings.find((w) => w.code === 'cb-short');
  if (plan.makeable && short) return { title: 'Too soft to get there', reason: short.message, altPocketId: null };
  const w = plan.warnings.find((x) => x.code === 'not-makeable') ?? plan.warnings.find((x) => x.code === 'blocked-cue' || x.code === 'blocked-object');
  const reason = (w?.message ?? 'No clean path to this pocket.').replace(/^Not makeable: /, '').replace(/ Try the [^.]+\.$/, '');
  return { title: 'Not makeable', reason: reason.charAt(0).toUpperCase() + reason.slice(1), altPocketId: plan.alternatives[0]?.pocketId ?? null };
}
