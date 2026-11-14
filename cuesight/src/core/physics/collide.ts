/**
 * Impulse-based collision responses operating in place on structure-of-arrays ball state.
 * No allocation (Constitution IV).
 *
 * Ball–ball: normal impulse with restitution + Coulomb friction impulse at the contact limited by the
 * "stick" condition (relative slip brought to zero): Jt = min(μ(v_rel)·Jn, m·|u_t|/7).
 * This reproduces cut- and spin-induced throw [Alciatore TP A.14] and spin transfer.
 *
 * Ball–cushion (and jaw points): speed-dependent restitution + friction at an equatorial contact,
 * Jt = min(μc·Jn, (2/7)·m·|u_t|), which changes the rebound angle with running/reverse english.
 * ASSUMPTION: the elevated cushion contact (≈1.27R) is not modelled.
 */
import type { PhysicsParams } from '../types';
import { ballFriction } from './analytic';

export interface BallArrays {
  px: Float64Array;
  py: Float64Array;
  vx: Float64Array;
  vy: Float64Array;
  wx: Float64Array;
  wy: Float64Array;
  wz: Float64Array;
}

/** Resolve a collision between balls i and j (centres ~2R apart). Equal masses assumed. */
export function resolveBallBall(s: BallArrays, i: number, j: number, R: number, params: PhysicsParams): void {
  let nx = s.px[j]! - s.px[i]!;
  let ny = s.py[j]! - s.py[i]!;
  const d = Math.hypot(nx, ny) || 1;
  nx /= d;
  ny /= d;
  const vrn = (s.vx[i]! - s.vx[j]!) * nx + (s.vy[i]! - s.vy[j]!) * ny;
  if (vrn <= 0) return; // separating
  // Per unit mass (m cancels for equal masses).
  const Jn = ((1 + params.eBall) / 2) * vrn;

  // Contact point velocities: c = v + ω × r, with r_i = R·n, r_j = −R·n.
  // ω × r for r = (rx, ry, 0): (−ωz·ry, ωz·rx, ωx·ry − ωy·rx)
  const rix = R * nx;
  const riy = R * ny;
  const cix = s.vx[i]! - s.wz[i]! * riy;
  const ciy = s.vy[i]! + s.wz[i]! * rix;
  const ciz = s.wx[i]! * riy - s.wy[i]! * rix;
  const cjx = s.vx[j]! + s.wz[j]! * riy;
  const cjy = s.vy[j]! - s.wz[j]! * rix;
  const cjz = -(s.wx[j]! * riy - s.wy[j]! * rix);
  let ux = cix - cjx;
  let uy = ciy - cjy;
  const uz = ciz - cjz;
  const un = ux * nx + uy * ny;
  ux -= un * nx;
  uy -= un * ny;
  const U = Math.hypot(ux, uy, uz);

  let tx = 0;
  let ty = 0;
  let tz = 0;
  let Jt = 0;
  if (U > 1e-9) {
    const mu = ballFriction(U, params.ballFriction);
    Jt = Math.min(mu * Jn, U / 7);
    tx = ux / U;
    ty = uy / U;
    tz = uz / U;
  }
  // Impulse on i: P = −Jn·n − Jt·t̂ ; on j: +Jn·n + Jt·t̂ (per unit mass).
  const Pix = -Jn * nx - Jt * tx;
  const Piy = -Jn * ny - Jt * ty;
  const Piz = -Jt * tz;
  s.vx[i] = s.vx[i]! + Pix;
  s.vy[i] = s.vy[i]! + Piy;
  s.vx[j] = s.vx[j]! - Pix;
  s.vy[j] = s.vy[j]! - Piy;
  // Angular: Δω = (r × P)/I, I/m = 2/5·R². r × P for r=(rx,ry,0): (ry·Pz, −rx·Pz, rx·Py − ry·Px)
  const invI = 1 / (0.4 * R * R);
  s.wx[i] = s.wx[i]! + riy * Piz * invI;
  s.wy[i] = s.wy[i]! - rix * Piz * invI;
  s.wz[i] = s.wz[i]! + (rix * Piy - riy * Pix) * invI;
  // For j: r_j = −r_i and P_j = −P_i, so r_j × P_j = r_i × P_i.
  s.wx[j] = s.wx[j]! + riy * Piz * invI;
  s.wy[j] = s.wy[j]! - rix * Piz * invI;
  s.wz[j] = s.wz[j]! + (rix * Piy - riy * Pix) * invI;
}

/**
 * Resolve ball i against a rigid boundary with inward unit normal (nx, ny) at an equatorial contact.
 * Used for cushion segments and jaw points.
 */
export function resolveCushion(s: BallArrays, i: number, nx: number, ny: number, R: number, params: PhysicsParams): void {
  const vn = s.vx[i]! * nx + s.vy[i]! * ny;
  if (vn >= 0) return;
  const e = Math.max(params.cushionEMin, params.cushionE0 - params.cushionESlope * Math.abs(vn));
  const Jn = (1 + e) * -vn; // per unit mass
  // Contact r = −R·n. Contact velocity tangential (horizontal) component along t̂ = (−ny, nx).
  const rx = -R * nx;
  const ry = -R * ny;
  const cx = s.vx[i]! - s.wz[i]! * ry;
  const cy = s.vy[i]! + s.wz[i]! * rx;
  const tx = -ny;
  const ty = nx;
  const ut = cx * tx + cy * ty;
  const Jt = -Math.sign(ut) * Math.min(params.muCushion * Jn, (2 / 7) * Math.abs(ut));
  const Px = Jn * nx + Jt * tx;
  const Py = Jn * ny + Jt * ty;
  s.vx[i] = s.vx[i]! + Px;
  s.vy[i] = s.vy[i]! + Py;
  const invI = 1 / (0.4 * R * R);
  s.wz[i] = s.wz[i]! + (rx * Py - ry * Px) * invI;
}
