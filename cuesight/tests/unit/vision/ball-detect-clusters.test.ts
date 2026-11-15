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
  POSES,
  SNOOKER_POSES,
  calibrationSet,
  chroma420,
  cueIndex,
  detectWith,
  errStats,
  exclusiveShare,
  fmt,
  gain,
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
  log: string[];
}

/** Run `frame` of `sc` under every calibration of `cals`; misses beyond `allow` and the accuracy bounds are failures. */
function sweep(sc: SynthScene, frame: Frame, cals: ReturnType<typeof calibrationSet>, allow: number): Tally {
  const t: Tally = { bad: [], phantoms: [], far: [], wrongCue: [], log: [] };
  for (const c of cals) {
    const r = detectWith(sc, frame, c);
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
  // Reds and the cue ball only. On video the pack's chroma is one sample per 2×2 block, about one
  // sample per ball radius here (2.5–3 image px): the mask of the end and corner views does not
  // resolve the pack (known limit: a few reds lost or misplaced, medians 14–20 mm). Measured, per
  // view over these 10 calibrations × 2 encodings (replicated 4:2:0 and the 8-bit YUV round trip):
  // calibrations with a phantom, this detector / wave-1 / previous fix: overhead 0 / 1 / 9, side
  // 1 / 4 / 10, end 3 / 14 / 18, corner 18 / 12 / 20 (in the corner view the pack's mask is so coarse
  // that a misplaced red matches no ball: known limit). Overhead holds every criterion.
  const cals = (sc: SynthScene) => calibrationSet(sc, [[0.3, 8, 51000]]);
  const maxPhantomCals: Record<Pose, number> = { overhead: 0, side: 1, end: 3, corner: 18 };
  it.each(ALL_POSES)('%s view', (pose) => {
    const sc = snookerPack(SNOOKER_POSES[pose]);
    const f = render(sc);
    let withPhantom = 0;
    const log: string[] = [];
    const strict: string[] = [];
    for (const [nm, frame] of [
      ['4:2:0', chroma420(f)],
      ['YUV', yuv420(f)],
    ] as const) {
      const t = sweep(sc, frame, cals(sc), pose === 'overhead' ? 0 : 6);
      const ph = new Set([...t.phantoms, ...t.far].map((p) => p.split(':')[0]));
      withPhantom += ph.size;
      log.push(`${nm}:`, ...t.log);
      if (pose === 'overhead') strict.push(...t.bad.map((b) => `${nm} ${b}`), ...[...t.phantoms, ...t.far].map((b) => `${nm} ${b}`));
      expect(t.wrongCue, t.wrongCue.join('\n')).toEqual([]);
    }
    console.log(`snooker pack ${pose} on video:\n  ${log.join('\n  ')}\n  calibrations with a phantom: ${withPhantom} of 20`);
    expect(strict, strict.join('\n')).toEqual([]);
    expect(withPhantom).toBeLessThanOrEqual(maxPhantomCals[pose]);
  }, 180_000);
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
  // Over these cameras plus the corner and side views (racks × encodings × auto/exact: 72 runs) the
  // previous fix flagged an object ball in 13 (stripes of the 15-ball rack in the end view under its
  // auto and exact calibrations among them), the wave-1 detector in 3, this one in none.
  const cams: Record<string, SynthCamera> = {
    end: POSES.end!,
    endFar: { pos: { x: -3.6, y: 0.0, z: 1.9 }, target: { x: 0.2, y: 0, z: 0 }, fovDeg: 66 },
    endFar2: { pos: { x: -3.4, y: 0.0, z: 1.8 }, target: { x: 0.2, y: 0, z: 0 }, fovDeg: 66 },
    endFar3: { pos: { x: -3.8, y: 0.1, z: 2.0 }, target: { x: 0.2, y: 0, z: 0 }, fovDeg: 66 },
    endFar4: { pos: { x: -3.6, y: 0.0, z: 1.9 }, target: { x: 0.2, y: 0, z: 0 }, fovDeg: 60 },
    cornerFar: { pos: { x: -3.2, y: -2.2, z: 2.0 }, target: { x: 0.15, y: 0.05, z: 0 }, fovDeg: 66 },
    sideFar: { pos: { x: 0.2, y: -3.0, z: 2.2 }, target: { x: 0, y: 0.08, z: 0 }, fovDeg: 68 },
  };
  it.each(Object.keys(cams))('%s camera: the flagged cue is the real cue ball or none (9- and 15-ball racks, RGB and YUV 4:2:0, auto and exact)', (cn) => {
    const wrong: string[] = [];
    let real = 0;
    for (const n of [9, 15] as const) {
      const sc = rack(n, cams[cn]!);
      const f = render(sc);
      for (const [nm, frame] of [
        ['RGB', f],
        ['YUV', yuv420(f)],
      ] as const)
        for (const c of calibrationSet(sc, [])) {
          const r = detectWith(sc, frame, c);
          const ci = cueIndex(r);
          if (ci === 0) real++;
          else if (ci !== -1) wrong.push(`${n}-ball ${nm} ${c.name}: ${ci} (${r.balls.map((b) => `${b.label}:${b.white.toFixed(2)}`).join(' ')})`);
        }
    }
    console.log(`${cn}: real cue flagged in ${real} of 8`);
    expect(wrong, wrong.join('\n')).toEqual([]);
  }, 120_000);
});
