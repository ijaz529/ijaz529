/**
 * Touching clusters beyond ball-detect-edge's 16 scenes (spec 001 SC-003 and edge cases; Constitution
 * II, III): the mirrored snooker corner view, 3-ball rows end-on in the corner view, snooker packs on
 * 4:2:0 video, packs under exposure, cloth noise and a moved lamp, and which ball is flagged as the cue
 * beside a rack. Calibrations: the table detector's (auto), the camera's exact one, and exact corners
 * jittered as calibration error (ball-detect-helpers JITTER, or the subset named per test).
 */
import { describe, expect, it } from 'vitest';
import type { SynthCamera, SynthScene } from '../../../src/vision/synth/render';
import type { Frame } from '../../../src/vision/image';
import {
  ALL_POSES,
  C,
  POSES,
  R9,
  SNOOKER_POSES,
  bilinear420,
  calibrationSet,
  chroma420,
  cueIndex,
  detectWith,
  errStats,
  exclusiveShare,
  fmt,
  gain,
  mk,
  nearestTruth,
  rack,
  render,
  rowAt,
  snookerPack,
  yuv420,
  type Pose,
} from './ball-detect-helpers';

interface Tally {
  /** Per calibration: the failures of the test criterion (phantoms listed apart). */
  bad: string[];
  /** Phantoms next to the cluster (within 0.3 m of a ball). */
  phantoms: string[];
  /** Phantoms far from every ball (a pocket throat misplaced by the calibration error). */
  far: string[];
  /** Wrong cue: an object ball or a phantom flagged as the cue. */
  wrongCue: string[];
  /** Visible balls (at least 25 % of their outline their own, given `share`) not found, over all calibrations. */
  visMiss: string[];
  log: string[];
}

/** Run `frame` of `sc` under every calibration of `cals`; misses beyond `allow` and the accuracy bounds are failures. */
function sweep(sc: SynthScene, frame: Frame, cals: ReturnType<typeof calibrationSet>, allow: number, share: number[] = []): Tally {
  const t: Tally = { bad: [], phantoms: [], far: [], wrongCue: [], visMiss: [], log: [] };
  for (const c of cals) {
    const r = detectWith(sc, frame, c);
    for (let i = 0; i < share.length; i++) if (share[i]! >= 0.25 && r.match[i]!.det < 0) t.visMiss.push(`${c.name}: #${i} (${share[i]!.toFixed(2)})`);
    const found = r.match.map((_, i) => i).filter((i) => r.match[i]!.det >= 0);
    const s = errStats(r, found);
    const missed = sc.balls.length - found.length;
    const line = `${c.name}: ${r.balls.length}/${sc.balls.length}, errors mm ${fmt(errStats(r).mm)}`;
    t.log.push(line);
    for (const i of r.fp) (nearestTruth(sc, r.balls[i]!) < 0.3 ? t.phantoms : t.far).push(`${c.name}: phantom ${r.balls[i]!.label} at (${r.balls[i]!.pos.x.toFixed(3)}, ${r.balls[i]!.pos.y.toFixed(3)})`);
    const ci = cueIndex(r);
    if (ci !== 0 && ci !== -1) t.wrongCue.push(`${c.name}: cue = ${ci} (${r.balls.map((b) => `${b.label}:${b.white.toFixed(2)}`).join(' ')})`);
    const fail: string[] = [];
    if (missed > allow) fail.push(`${missed} missed > ${allow}`);
    if (s.median > 10) fail.push(`median ${s.median.toFixed(1)} mm`);
    if (s.p95 > (missed ? 30 : 25)) fail.push(`p95 ${s.p95.toFixed(1)} mm`);
    if (fail.length) t.bad.push(`${c.name}: ${fail.join(', ')} (${line})`);
  }
  return t;
}

const strictOf = (bad: string[]) => bad.filter((b) => b.startsWith('auto') || b.startsWith('exact'));

describe('touching clusters, more views', () => {
  it('snooker pack, mirrored corner view (camera at +y): no phantom, every visible ball, under auto, exact and 60 jittered calibrations', () => {
    // The corner view mirrored about the long axis. The previous fix put a phantom red on this pack
    // under the camera's EXACT calibration (median 13.1 mm) and in 14 of these 62 calibrations; the
    // wave-1 detector in 11. Six balls are under 15 % of their outline (as in the corner view: the same
    // allowance of 3). Known limit: 6 of the jittered calibrations reach a median of 10.0–11.9 mm. A pocket
    // hole misplaced by ±1 px corners can read as a dark ball 0.97 m from the pack: that is the pocket
    // throat's mask, counted apart (at most 1 of 62).
    const camera: SynthCamera = { pos: { x: -3.0, y: 2.0, z: 2.2 }, target: { x: 0.2, y: -0.05, z: 0 }, fovDeg: 66 };
    const sc = snookerPack(camera);
    const share = exclusiveShare(sc);
    expect(share.filter((v) => v < 0.15).length, share.map((v) => v.toFixed(2)).join(' ')).toBeGreaterThanOrEqual(3);
    const t = sweep(sc, render(sc), calibrationSet(sc), 3);
    console.log(`snooker pack, mirrored corner:\n  ${t.log.join('\n  ')}\n  failing: ${t.bad.length}, far phantoms: ${t.far.length}\n  ${[...t.bad, ...t.far].join('\n  ')}`);
    expect(t.phantoms, t.phantoms.join('\n')).toEqual([]);
    expect(t.far.length, t.far.join('\n')).toBeLessThanOrEqual(1);
    expect(strictOf(t.bad), t.bad.join('\n')).toEqual([]);
    expect(t.bad.length, t.bad.join('\n')).toBeLessThanOrEqual(6);
  }, 180_000);

  it.each([
    [0.3, 0.1],
    [0.5, -0.2],
  ])('corner view, a 3-ball row end-on through (%s, %s): all three balls, no phantom, under auto, exact and 60 jittered calibrations', (x, y) => {
    // The middle ball shows 18–26 % of its outline (two slivers beside the front ball). The previous
    // fix chose the silhouette size of a ≤ 4-ball cluster by a 1–2-cell cost difference and lost it in
    // 46 (0.3, 0.1) and 17 (0.5, −0.2) of these 62 calibrations, the auto one included; the wave-1
    // detector in 3 and 6.
    const sc = rowAt(POSES.corner!, x, y);
    const t = sweep(sc, render(sc), calibrationSet(sc), 0);
    console.log(`row (${x}, ${y}) end-on, corner view:\n  ${t.log.join('\n  ')}`);
    expect(t.phantoms, t.phantoms.join('\n')).toEqual([]);
    expect(t.far, t.far.join('\n')).toEqual([]);
    expect(t.bad, t.bad.join('\n')).toEqual([]);
  }, 180_000);

  it('end view, the 3-ball row: all three balls under ±1 px corner jitter (seeds 82000–82011)', () => {
    // Seed 82001 cost the previous fix the middle ball (an independent verification seed).
    const sc = rack(3, POSES.end!);
    const t = sweep(sc, render(sc), calibrationSet(sc, [[1, 12, 82000]]), 0);
    expect([...t.phantoms, ...t.far, ...t.bad], t.log.join('\n')).toEqual([]);
  }, 120_000);
});

describe('snooker packs on 4:2:0 video (no coloured single ball: the frame dilation is unknown)', () => {
  // Reds and the cue ball only, under the 62 calibrations, with the three ways video chroma reaches
  // the detector: replicated per 2×2 block, the 8-bit YUV round trip, and upsampled bilinearly (a GPU's
  // YUV → RGB conversion). The pack's chroma is one sample per 2×2 block, about one sample per ball
  // radius here (2.5–3 image px): the masks of the end, corner and mirrored corner views do not resolve
  // the pack (known limit: reds misplaced by 25–40 mm, medians 15–18 mm, against 17–20 mm for the
  // wave-1 detector). Bounds per view, summed over the three encodings: phantoms next to the pack and
  // visible balls (≥ 25 % of their outline) missed, each at most the wave-1 detector's on the same
  // runs. Measured (wave-1 / previous fix / this detector), phantoms: end 141 / 148 / 119, side
  // 21 / 49 / 7, corner 199 / 194 / 151, overhead 42 / 121 / 1, mirrored corner 211 / 198 / 167;
  // visible misses: end 271 / 179 / 236, side 134 / 5 / 9, corner 4 / 0 / 0, overhead 6 / 6 / 0,
  // mirrored corner 8 / 0 / 0. The overhead view holds every criterion on replicated and YUV chroma.
  const WAVE1: Record<string, { phantoms: number; visMiss: number }> = {
    end: { phantoms: 141, visMiss: 271 },
    side: { phantoms: 21, visMiss: 134 },
    corner: { phantoms: 199, visMiss: 4 },
    overhead: { phantoms: 42, visMiss: 6 },
    mirror: { phantoms: 211, visMiss: 8 },
  };
  const cameras: Record<string, SynthCamera> = { ...SNOOKER_POSES, mirror: { pos: { x: -3.0, y: 2.0, z: 2.2 }, target: { x: 0.2, y: -0.05, z: 0 }, fovDeg: 66 } };
  it.each(Object.keys(WAVE1))('%s view', (pose) => {
    const sc = snookerPack(cameras[pose]!);
    const f = render(sc);
    const share = exclusiveShare(sc);
    const cals = calibrationSet(sc);
    let phantoms = 0;
    let far = 0;
    let visMiss = 0;
    const log: string[] = [];
    const strict: string[] = [];
    const wrong: string[] = [];
    for (const [nm, frame] of [
      ['4:2:0', chroma420(f)],
      ['YUV', yuv420(f)],
      ['bilinear', bilinear420(f)],
    ] as const) {
      const t = sweep(sc, frame, cals, pose === 'overhead' ? 0 : 6, share);
      phantoms += t.phantoms.length;
      far += t.far.length;
      visMiss += t.visMiss.length;
      log.push(`${nm}: phantoms ${t.phantoms.length} (far ${t.far.length}), visible missed ${t.visMiss.length}`, ...t.phantoms.slice(0, 8), ...t.visMiss.slice(0, 8));
      if (pose === 'overhead' && nm !== 'bilinear') strict.push(...t.bad.map((b) => `${nm} ${b}`), ...[...t.phantoms, ...t.far].map((b) => `${nm} ${b}`));
      wrong.push(...t.wrongCue.map((w) => `${nm} ${w}`));
    }
    console.log(`snooker pack ${pose} on video (62 calibrations × 3 encodings): phantoms ${phantoms} (wave-1 ${WAVE1[pose]!.phantoms}), visible missed ${visMiss} (wave-1 ${WAVE1[pose]!.visMiss})\n  ${log.join('\n  ')}`);
    expect(wrong, wrong.join('\n')).toEqual([]);
    expect(strict, strict.join('\n')).toEqual([]);
    expect(phantoms).toBeLessThanOrEqual(WAVE1[pose]!.phantoms);
    // No pocket-hole phantom far from the pack in any of these runs (as for the wave-1 detector).
    expect(far).toBe(0);
    expect(visMiss).toBeLessThanOrEqual(WAVE1[pose]!.visMiss);
  }, 240_000);
});

describe('packs under exposure, cloth noise and a moved lamp (sharp frames)', () => {
  // Never a phantom and never an object ball flagged as the cue, under any perturbation; in the side
  // and overhead views every visible ball (none is under 15 % of its outline there). The end and corner
  // views lose the same hidden balls as unperturbed, plus, measured, a visible one in a few frames
  // (15-ball end at gain 1.25: the far row's green and black read as too little of themselves, as
  // in wave-1).
  const kinds: [string, (p: Pose, e: Partial<SynthScene>) => SynthScene, Partial<Record<Pose, number>>][] = [
    ['9-ball diamond', (p, e) => rack(9, POSES[p]!, e), { end: 1, corner: 1 }],
    ['15-ball triangle', (p, e) => rack(15, POSES[p]!, e), { end: 3, corner: 3 }],
    ['snooker 15-red pack', (p, e) => snookerPack(SNOOKER_POSES[p], e), { end: 3, corner: 3 }],
  ];
  const variants: [string, Partial<SynthScene>, number][] = [
    ['gain 0.7', {}, 0.7],
    ['gain 1.25', {}, 1.25],
    ['cloth noise 0.04', { noise: 0.04 }, 1],
    ['cloth noise 0.08', { noise: 0.08 }, 1],
    ['lamp moved', { light: { x: 0.6, y: 0.3, z: 1.3 } }, 1],
  ];
  for (const [name, build, hidden] of kinds)
    it.each(ALL_POSES)(`${name}, %s view`, (pose) => {
      const phantoms: string[] = [];
      const wrong: string[] = [];
      const missed: string[] = [];
      for (const [vn, extra, g] of variants) {
        const sc = build(pose, extra);
        let f = render(sc, `${name}-${pose}-${JSON.stringify(extra)}`);
        if (g !== 1) f = gain(f, g);
        const t = sweep(sc, f, calibrationSet(sc, [[0.3, 6, 41000]]), hidden[pose] ?? 0);
        phantoms.push(...[...t.phantoms, ...t.far].map((p) => `${vn} ${p}`));
        wrong.push(...t.wrongCue.map((p) => `${vn} ${p}`));
        if (pose === 'side' || pose === 'overhead') missed.push(...t.bad.map((p) => `${vn} ${p}`));
        else console.log(`${name} ${pose} ${vn}: ${t.bad.length} of ${t.log.length} over the allowance or accuracy\n  ${t.bad.join('\n  ')}`);
      }
      expect(phantoms, phantoms.join('\n')).toEqual([]);
      expect(wrong, wrong.join('\n')).toEqual([]);
      expect(missed, missed.join('\n')).toEqual([]);
    }, 180_000);
});

describe('cue ball beside a rack', () => {
  // A stripe in the back row of a rack shows only its caps (its band hidden behind the nearer balls)
  // and reads whiter than the real cue ball, whose camera side is in shade: it may never be flagged.
  // Such a ball is walled in on opposite sides by its neighbours (the only way a band, which reaches the
  // rim at two opposite points, can be out of sight), so its whiteness is no evidence against the real
  // cue ball, which is chosen among the other candidates. Per camera (9- and 15-ball racks, RGB and YUV
  // 4:2:0, auto, exact and 12 jittered calibrations at ±0.3 px: 56 runs), the real cue is flagged at
  // least as often as by the wave-1 detector (end 38, endFar 43, endFar2 30, endFar3 50, endFar4 41,
  // cornerFar 55, sideFar 51; it also flagged an object ball in 27 runs), never an object ball. The
  // previous fix flagged the real cue in 30 / 48 / 31 / 39 / 45 / 54 / 55; this one in 56 / 56 / 42 /
  // 56 / 56 / 56 / 55.
  const cams: Record<string, [SynthCamera, number]> = {
    end: [POSES.end!, 38],
    endFar: [{ pos: { x: -3.6, y: 0.0, z: 1.9 }, target: { x: 0.2, y: 0, z: 0 }, fovDeg: 66 }, 43],
    endFar2: [{ pos: { x: -3.4, y: 0.0, z: 1.8 }, target: { x: 0.2, y: 0, z: 0 }, fovDeg: 66 }, 30],
    endFar3: [{ pos: { x: -3.8, y: 0.1, z: 2.0 }, target: { x: 0.2, y: 0, z: 0 }, fovDeg: 66 }, 50],
    endFar4: [{ pos: { x: -3.6, y: 0.0, z: 1.9 }, target: { x: 0.2, y: 0, z: 0 }, fovDeg: 60 }, 41],
    cornerFar: [{ pos: { x: -3.2, y: -2.2, z: 2.0 }, target: { x: 0.15, y: 0.05, z: 0 }, fovDeg: 66 }, 55],
    sideFar: [{ pos: { x: 0.2, y: -3.0, z: 2.2 }, target: { x: 0, y: 0.08, z: 0 }, fovDeg: 68 }, 51],
  };
  it.each(Object.keys(cams))('%s camera: the flagged cue is the real cue ball or none, and the real one at least as often as wave-1 (9- and 15-ball racks, RGB and YUV 4:2:0, auto, exact and 12 jittered calibrations)', (cn) => {
    const [cam, floor] = cams[cn]!;
    const wrong: string[] = [];
    let real = 0;
    let runs = 0;
    for (const n of [9, 15] as const) {
      const sc = rack(n, cam);
      const f = render(sc);
      for (const [nm, frame] of [
        ['RGB', f],
        ['YUV', yuv420(f)],
      ] as const)
        for (const c of calibrationSet(sc, [[0.3, 12, 61000]])) {
          const r = detectWith(sc, frame, c);
          const ci = cueIndex(r);
          runs++;
          if (ci === 0) real++;
          else if (ci !== -1) wrong.push(`${n}-ball ${nm} ${c.name}: ${ci} (${r.balls.map((b) => `${b.label}:${b.white.toFixed(2)}`).join(' ')})`);
        }
    }
    console.log(`${cn}: real cue flagged in ${real} of ${runs} (wave-1 ${floor})`);
    expect(wrong, wrong.join('\n')).toEqual([]);
    expect(real).toBeGreaterThanOrEqual(floor);
  }, 180_000);
});

describe('cue ball partly behind an object ball, stripes on the table', () => {
  // The cue ball 2.05 R behind a maroon (solid or stripe) on the line of sight, offset sideways by
  // 0.6, 1 or 1.4 R (20–40 % of its silhouette hidden), with five stripes and two solids elsewhere (a
  // green stripe on green cloth among them). Hidden on one side only, its rim shows on the other: no
  // band could be out of sight, so its whiteness counts. The previous fix withheld every partly hidden
  // white ball when any other ball was white-ish and flagged no cue in 42 (RGB) and 47 (YUV) of the 108
  // end-view runs; the wave-1 detector flags the real cue in 108, 108, 108, 108, 108 and 107 of 108
  // (end RGB, end YUV, side, corner); so does this one. Never an object ball.
  const R = R9;
  const OTHERS = [
    { pos: { x: -0.9, y: -0.35 }, color: C.yellow!, stripe: true },
    { pos: { x: 0.85, y: -0.3 }, color: C.blue!, stripe: true },
    { pos: { x: 0.95, y: 0.35 }, color: C.red!, stripe: true },
    { pos: { x: -0.7, y: 0.4 }, color: C.purple! },
    { pos: { x: 0.0, y: 0.38 }, color: C.green!, stripe: true },
    { pos: { x: -0.05, y: -0.38 }, color: C.orange! },
  ];
  const FLOOR: Record<string, number> = { 'end RGB': 108, 'end YUV': 107, 'side RGB': 108, 'side YUV': 108, 'corner RGB': 108, 'corner YUV': 108 };
  it.each(['end', 'side', 'corner'] as Pose[])('%s view: the real cue ball is flagged as often as by wave-1 (RGB and YUV, auto, exact and 4 jittered calibrations)', (pose) => {
    const cam = POSES[pose]!;
    const wrong: string[] = [];
    const real: Record<string, number> = { RGB: 0, YUV: 0 };
    const none: string[] = [];
    for (const [cx, cy] of [
      [-0.3, 0.2],
      [0.2, -0.15],
      [0.5, 0.3],
    ] as const)
      for (const off of [0.6, 1.0, 1.4])
        for (const stripe of [false, true]) {
          const a = Math.atan2(cam.pos.y - cy, cam.pos.x - cx);
          const front = { x: cx + 2.05 * R * Math.cos(a) - off * R * Math.sin(a), y: cy + 2.05 * R * Math.sin(a) + off * R * Math.cos(a) };
          const sc = mk('pool9', cam, [{ pos: { x: cx, y: cy }, color: C.cue! }, { pos: front, color: C.maroon!, ...(stripe ? { stripe: true } : {}) }, ...OTHERS]);
          const f = render(sc);
          for (const [nm, frame] of [
            ['RGB', f],
            ['YUV', yuv420(f)],
          ] as const)
            for (const c of calibrationSet(sc, [[0.3, 4, 98000]])) {
              const r = detectWith(sc, frame, c);
              const ci = cueIndex(r);
              const tag = `(${cx}, ${cy}) off ${off}${stripe ? ' stripe' : ''} ${nm} ${c.name}`;
              if (ci === 0) real[nm]!++;
              else if (ci === -1) none.push(tag);
              else wrong.push(`${tag}: ${ci} (${r.balls.map((b) => `${b.label}:${b.white.toFixed(2)}`).join(' ')})`);
            }
        }
    console.log(`${pose}: real cue flagged RGB ${real.RGB} / 108, YUV ${real.YUV} / 108; none in ${none.join(', ') || '-'}`);
    expect(wrong, wrong.join('\n')).toEqual([]);
    expect(real.RGB).toBeGreaterThanOrEqual(FLOOR[`${pose} RGB`]!);
    expect(real.YUV).toBeGreaterThanOrEqual(FLOOR[`${pose} YUV`]!);
  }, 180_000);
});

describe('cue ball frozen between two touching object balls, a green stripe on the green cloth elsewhere', () => {
  // The cue ball touching a red and a blue on a line at 0°, 45° and 90° to the view, at two spots, with
  // five more balls elsewhere, among them a green stripe whose band vanishes into the cloth (in every
  // 8-ball game): it reads white-ish. Each neighbour hides a rim arc of the cue ball, the two arcs
  // opposite, but its rim against the cloth between them on both sides leaves any band in view, so its
  // whiteness counts. The release candidate called it ambiguous and, with the green stripe white-ish,
  // flagged no cue in 127 of 324 runs (lines at 45° and 90°: 24 of 36 per encoding); Live then asked for
  // taps. Floor per view, encoding and angle: the wave-1 detector's count under the same calibrations
  // (auto, exact, 4 jittered at ±0.3 px). Along the view (0°) the cue ball hides behind the nearer ball
  // and what decides is the cluster count and its visible whiteness (wave-1 there: RGB 10–12 of 12,
  // video 0–10).
  const R = R9;
  const OTHERS = [
    { pos: { x: 0.55, y: -0.3 }, color: C.green!, stripe: true },
    { pos: { x: -0.2, y: 0.42 }, color: C.yellow! },
    { pos: { x: 0.9, y: 0.25 }, color: C.purple! },
    { pos: { x: 1.0, y: -0.35 }, color: C.black! },
    { pos: { x: -0.85, y: -0.4 }, color: C.orange!, stripe: true },
  ];
  const FLOOR: Record<string, Record<string, number>> = {
    end: { 'RGB 0': 10, 'YUV 0': 1, 'bilinear 0': 0, 'RGB 45': 12, 'YUV 45': 12, 'bilinear 45': 10, 'RGB 90': 12, 'YUV 90': 12, 'bilinear 90': 12 },
    side: { 'RGB 0': 12, 'YUV 0': 10, 'bilinear 0': 9, 'RGB 45': 12, 'YUV 45': 12, 'bilinear 45': 12, 'RGB 90': 12, 'YUV 90': 12, 'bilinear 90': 12 },
    corner: { 'RGB 0': 10, 'YUV 0': 4, 'bilinear 0': 1, 'RGB 45': 12, 'YUV 45': 12, 'bilinear 45': 12, 'RGB 90': 12, 'YUV 90': 12, 'bilinear 90': 12 },
  };
  it.each(['end', 'side', 'corner'] as Pose[])('%s view: the real cue ball is flagged at least as often as by wave-1, never an object ball (RGB, YUV 4:2:0 and bilinear 4:2:0; auto, exact and 4 jittered calibrations)', (pose) => {
    const cam = POSES[pose]!;
    const wrong: string[] = [];
    const real: Record<string, number> = {};
    const none: string[] = [];
    for (const ang of [0, 45, 90])
      for (const cx of [-0.5, 0.2]) {
        const cue = { x: cx, y: 0.05 };
        const a = Math.atan2(cue.y - cam.pos.y, cue.x - cam.pos.x) + (ang * Math.PI) / 180;
        const g = 2 * R + 0.0002;
        const sc = mk('pool9', cam, [
          { pos: cue, color: C.cue! },
          { pos: { x: cue.x - g * Math.cos(a), y: cue.y - g * Math.sin(a) }, color: C.red! },
          { pos: { x: cue.x + g * Math.cos(a), y: cue.y + g * Math.sin(a) }, color: C.blue! },
          ...OTHERS,
        ]);
        const f = render(sc);
        for (const [nm, frame] of [
          ['RGB', f],
          ['YUV', yuv420(f)],
          ['bilinear', bilinear420(f)],
        ] as const)
          for (const c of calibrationSet(sc, [[0.3, 4, 99000]])) {
            const r = detectWith(sc, frame, c);
            const ci = cueIndex(r);
            const key = `${nm} ${ang}`;
            real[key] ??= 0;
            const tag = `${ang}° at x ${cx} ${nm} ${c.name}`;
            if (ci === 0) real[key]!++;
            else if (ci === -1) none.push(tag);
            else wrong.push(`${tag}: ${ci} (${r.balls.map((b) => `${b.label}:${b.white.toFixed(2)}`).join(' ')})`);
          }
      }
    console.log(`${pose}: real cue flagged ${Object.entries(real).map(([k, v]) => `${k}° ${v}/12 (wave-1 ${FLOOR[pose]![k]})`).join(', ')}; none in ${none.join(', ') || '-'}`);
    expect(wrong, wrong.join('\n')).toEqual([]);
    const short = Object.entries(FLOOR[pose]!)
      .filter(([k, v]) => real[k]! < v)
      .map(([k, v]) => `${k}°: ${real[k]} < ${v}`);
    expect(short, short.join('\n')).toEqual([]);
  }, 180_000);
});
