/**
 * Impulse-based collision responses operating in place on structure-of-arrays ball state.
 * No allocation (Constitution IV).
 *
 * Ball–ball: normal impulse with restitution + Coulomb friction impulse at the contact limited by the
 * "stick" condition (relative slip brought to zero): Jt = min(μ(v_rel)·Jn, m·|u_t|/7).
 * This reproduces cut- and spin-induced throw [Alciatore TP A.14] and spin transfer.
 *
 * Ball–cushion (and jaw points): rigid-body impulse at an equatorial contact r = −R·n̂.
 *  - Normal: speed-dependent restitution on the horizontal normal speed, v_n' = −e_c(|v_n|)·v_n.
 *  - Friction: Coulomb (μc) on the full 3-D contact slip — horizontal u_t = (v + ω×r)·t̂ and vertical
 *    u_z = (ω×r)_z. The sticking impulse (−u_t/(7/2), −u_z/(5/2)) (per unit mass; 7/2 = 1 + R²m/I for
 *    the horizontal slip, 5/2 = R²m/I for the vertical one because the ball cannot move vertically)
 *    is scaled into the cone |P_f| ≤ μc·Jn. r × P_f updates ωx, ωy and ωz, so the rail changes
 *    top/back spin as well as side spin: a rolling ball loses most of its topspin at the rail.
 *    This is the impulse structure of Han (2005, "Dynamics in carom and three cushion billiards",
 *    J. Mech. Sci. Tech. 19(4)) — the "han_2005" cushion model in pooltool (params.ts [P]) — with the
 *    contact taken at the equator. Scaling the sticking impulse (rather than applying μc·Jn along
 *    −û) keeps every impact dissipative by construction.
 *  - Compared with review ports of Han 2005 and of Mathavan, Jackson & Parkin (2010, "A theoretical
 *    analysis of billiard ball dynamics under cushion impacts") at the same e_c and μc: head-on
 *    natural roll comes off at ≈0.58 of the arrival speed (Han ≈0.54, Mathavan ≈0.51); a 45°
 *    roll-in leaves ≈32° off the rail (Han ≈31°, Mathavan ≈36°). Rail paths are therefore
 *    uncertain by a few degrees and ~10 % in post-rail speed, not exact.
 * ASSUMPTION: the elevated cushion contact (nose ≈1.27R, WPA 62.5–64.5 % of the ball diameter) is not
 * modelled geometrically; its downward push is what keeps the ball on the bed (no v_z) while the
 * vertical friction acts, which holds while μc < tan θ ≈ 0.28. Cloth friction during the impact
 * (part of Mathavan's model) is ignored.
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

/**
 * Closing speed (m/s) below which a contact is treated as resting, not colliding. Far below any
 * physically meaningful speed; it stops round-off-level "collisions" from repeating at t = 0.
 */
export const APPROACH_EPS = 1e-9;

/** Resolve a collision between balls i and j (centres ~2R apart). Equal masses assumed. */
export function resolveBallBall(s: BallArrays, i: number, j: number, R: number, params: PhysicsParams): void {
  let nx = s.px[j]! - s.px[i]!;
  let ny = s.py[j]! - s.py[i]!;
  const d = Math.sqrt(nx * nx + ny * ny) || 1;
  nx /= d;
  ny /= d;
  const vrn = (s.vx[i]! - s.vx[j]!) * nx + (s.vy[i]! - s.vy[j]!) * ny;
  if (vrn <= APPROACH_EPS) return; // separating or resting
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
  const U = Math.sqrt(ux * ux + uy * uy + uz * uz);

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
 * Used for cushion segments and jaw points. See the file header for the model.
 */
export function resolveCushion(s: BallArrays, i: number, nx: number, ny: number, R: number, params: PhysicsParams): void {
  const vx = s.vx[i]!;
  const vy = s.vy[i]!;
  const wx = s.wx[i]!;
  const wy = s.wy[i]!;
  const wz = s.wz[i]!;
  const vn = vx * nx + vy * ny;
  if (vn >= -APPROACH_EPS) return; // separating or resting against it
  const e = Math.max(params.cushionEMin, params.cushionE0 - params.cushionESlope * -vn);
  const Jn = (1 + e) * -vn; // per unit mass
  // Contact r = −R·n; ω × r for r = (rx, ry, 0) = (−ωz·ry, ωz·rx, ωx·ry − ωy·rx).
  const rx = -R * nx;
  const ry = -R * ny;
  const tx = -ny;
  const ty = nx;
  const ut = (vx - wz * ry) * tx + (vy + wz * rx) * ty; // horizontal slip along t̂
  const uz = wx * ry - wy * rx; // vertical slip: top/back spin against the rail
  // Sticking impulse, scaled into the Coulomb cone μc·Jn.
  let Pt = -ut / 3.5;
  let Pz = -uz / 2.5;
  const Pf = Math.sqrt(Pt * Pt + Pz * Pz);
  const cap = params.muCushion * Jn;
  if (Pf > cap) {
    const k = cap / Pf;
    Pt *= k;
    Pz *= k;
  }
  const Px = Jn * nx + Pt * tx;
  const Py = Jn * ny + Pt * ty;
  s.vx[i] = vx + Px;
  s.vy[i] = vy + Py;
  // Δω = (r × P)/I with P = (Px, Py, Pz): r × P = (ry·Pz, −rx·Pz, rx·Py − ry·Px). Pz itself is taken
  // up by the bed (no vertical motion).
  const invI = 1 / (0.4 * R * R);
  s.wx[i] = wx + ry * Pz * invI;
  s.wy[i] = wy - rx * Pz * invI;
  s.wz[i] = wz + (rx * Py - ry * Px) * invI;
}
