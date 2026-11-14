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
  pocketId: PocketId;
  /** Contact point on the object ball at ball-centre height. */
  contact: Vec2 | null;
  ghostCenter: Vec2 | null;
  cueCenter: Vec2 | null;
  /** Projected cue-ball radius at its centre (px), for the inset crop. */
  cueRadiusPx: number;
  strike: StrikeMark | null;
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

function polyInFrame(pose: CameraPose, poly: Vec2[]): boolean {
  return poly.length > 0 && poly.some((p) => inImage(pose, p));
}

export function buildPlayerGuide(i: GuideInput): PlayerGuide {
  const { pose, table, plan } = i;
  const R = table.ballRadius;
  const C = cameraCenter(pose);
  const cue3 = on(i.cue, R);
  const aimL = Math.hypot(plan.aimDir.x, plan.aimDir.y) || 1;
  const aim = { x: plan.aimDir.x / aimL, y: plan.aimDir.y / aimL };

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
  const sp = strikePoint(cue3, aim, side, vert, R);
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
    ring.push(strikePoint(cue3, aim, MISCUE_FRAC * Math.cos(a), MISCUE_FRAC * Math.sin(a), R));
  }
  const miscue = frontRuns(pose, C, cue3, ring);
  const crossH: Vec3[] = [];
  const crossV: Vec3[] = [];
  for (let k = 0; k <= 16; k++) {
    const u = -MISCUE_FRAC + (2 * MISCUE_FRAC * k) / 16;
    crossH.push(strikePoint(cue3, aim, u, 0, R));
    crossV.push(strikePoint(cue3, aim, 0, u, R));
  }
  const cross = [...frontRuns(pose, C, cue3, crossH), ...frontRuns(pose, C, cue3, crossV)];
  // The cue: a level line from the strike point back toward the shooter, 0.9 m long.
  const cueAxis = projectPolyline(pose, [sp, { x: sp.x - aim.x * 0.9, y: sp.y - aim.y * 0.9, z: sp.z + 0.04 }]);

  const inFrame = {
    cue: polyInFrame(pose, cueBall),
    ghost: polyInFrame(pose, ghost),
    target: target.length ? polyInFrame(pose, target) : false,
    pocket: pocket.some((r) => r.some((p) => inImage(pose, p))),
  };

  const messages: string[] = [];
  if (!inFrame.cue) messages.push('The cue ball is outside the photo. Step back a little so the cue ball is in the picture, then retake.');
  else if (strike && !strike.inFrame) messages.push('Your strike point is cut off at the edge of the photo. It is shown on the spin ball.');
  else if (strike && !strike.visible) messages.push('From here the strike point is on the far side of the cue ball. Move behind the cue ball. It is shown on the spin ball.');
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
    pocketId: plan.pocketId,
    contact,
    ghostCenter,
    cueCenter: cueCenter ?? centroid(cueBall),
    cueRadiusPx,
    strike,
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
