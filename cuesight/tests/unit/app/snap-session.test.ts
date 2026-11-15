/**
 * Snap session (src/app/snap/session.ts) against the merged vision:
 *  - a table photo cut off by the border gives no table (table-detect returns null for a truncated
 *    view): the overview result goes to 'overview-error' and says the whole table must be in the photo;
 *  - four tapped corners the still pipeline refuses say why (VisionResult.reason), not "no table";
 *  - the guide's aim words for a frozen cue ball (no ghost ball, no cut);
 *  - the 3D cloth colour of a grey (neutral) cloth model is grey, not red.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, physicsFor } from '../../../src/app/settings';
import { CALIBRATION_MESSAGES } from '../../../src/app/live-logic';
import { clothRgbOf } from '../../../src/app/snap/photo';
import { detectionUsable, initialSnap, playerFailAction, retakeInstruction, snapAimText, snapGuideInstruction, snapReducer, SNAP_MESSAGES, tapsOffered, type SnapEvent, type SnapSession } from '../../../src/app/snap/session';
import { planShot } from '../../../src/core/shot/planner';
import { describeSpin } from '../../../src/core/shot/power';
import { makeTable } from '../../../src/core/table';
import type { Ball, TableLayout } from '../../../src/core/types';
import type { VisionResult } from '../../../src/vision/pipeline';
import { BALL_COLORS, renderSyntheticTable, type SynthCamera } from '../../../src/vision/synth/render';
import { processStill } from '../../../src/workers/vision.worker';
import { PLAYER_VIEW_REASONS } from '../../../src/vision/player-view';

const table = makeTable('pool9');
const photo = { width: 960, height: 540, source: 'library' as const };
const synthBalls = [
  { pos: { x: -0.7, y: -0.1 }, color: BALL_COLORS.cue! },
  { pos: { x: 0.3, y: 0.15 }, color: BALL_COLORS.yellow! },
  { pos: { x: -0.25, y: 0.4 }, color: BALL_COLORS.red! },
  { pos: { x: 0.95, y: -0.05 }, color: BALL_COLORS.blue! },
];
const still = (camera: SynthCamera, manualCorners: { x: number; y: number }[] | null = null): VisionResult =>
  processStill(renderSyntheticTable({ table, balls: synthBalls, camera, width: photo.width, height: photo.height }), { table, fovDeg: camera.fovDeg, manualCorners: null, swapAxes: false }, { manualCorners, swapAxes: false });
const ballsOf = (r: VisionResult): Ball[] => r.balls.map((b) => ({ id: b.id, kind: b.isCue ? 'cue' : 'object', pos: b.pos, label: b.label }));
const run = (events: SnapEvent[], s: SnapSession = initialSnap()) => events.reduce(snapReducer, s);

describe('a table photo cut off by the border (spec 002 FR-111, critic 12)', () => {
  // The whole table from a corner (the sample photo's camera), and three photos that cut it off.
  const whole: SynthCamera = { pos: { x: -2.25, y: -1.5, z: 1.8 }, target: { x: 0.15, y: 0.05, z: 0 }, fovDeg: 66 };
  const cut: [string, SynthCamera][] = [
    ['the far end cut off', { pos: { x: -1.6, y: -1.0, z: 1.4 }, target: { x: 0.5, y: 0.05, z: 0 }, fovDeg: 60 }],
    ['too close, from above', { pos: { x: 0, y: 0, z: 1.3 }, target: { x: 0, y: 0, z: 0 }, fovDeg: 60 }],
    ['half the table, from the side', { pos: { x: -0.3, y: -1.2, z: 1.2 }, target: { x: 0.4, y: 0.1, z: 0 }, fovDeg: 60 }],
  ];

  it('the whole table: a usable detection, the layout step', () => {
    const r = still(whole);
    expect(detectionUsable(r)).toBe(true);
    const s = run([{ type: 'overview-photo', photo }, { type: 'overview-result', vision: r, balls: ballsOf(r) }]);
    expect(s.step).toBe('review');
    expect(s.error).toBeNull();
  });

  it.each(cut)('%s: no table, so the error step says the whole table must be in the photo', (_name, camera) => {
    const r = still(camera);
    expect(r.calibration).toBeNull(); // the merged vision refuses a truncated view (no border-hugging quad)
    expect(detectionUsable(r)).toBe(false);
    const s = run([{ type: 'overview-photo', photo }, { type: 'overview-result', vision: r, balls: ballsOf(r) }]);
    expect(s.step).toBe('overview-error');
    expect(s.layout).toBeNull();
    expect(s.error).toBe(SNAP_MESSAGES.noTable);
    // True and actionable whatever the cause: what the photo needs, and how to get it.
    expect(s.error).toContain('The whole table must be in the photo — step back or turn the phone');
    // The four-corner fallback is offered only for corners that are in the photo.
    expect(s.error).toMatch(/all four corners .*in view\? Tap them/i);
  });

  it('detectionUsable: a calibration is the table; a table without balls is still a layout to fix', () => {
    const base = { status: 'locked', balls: [], quality: 0.9, cloth: null, ms: 1 } as unknown as VisionResult;
    expect(detectionUsable({ ...base, calibration: null })).toBe(false);
    expect(detectionUsable({ ...base, calibration: {} as VisionResult['calibration'] })).toBe(true);
    const s = run([{ type: 'overview-photo', photo }, { type: 'overview-result', vision: { ...base, calibration: {} as VisionResult['calibration'] }, balls: [] }]);
    expect(s.step).toBe('review');
    expect(s.error).toBe(SNAP_MESSAGES.noBalls);
  });
});

describe('four tapped corners the still pipeline refuses say why (VisionResult.reason)', () => {
  const corners = [
    { x: 100, y: 100 },
    { x: 800, y: 110 },
    { x: 850, y: 450 },
    { x: 60, y: 440 },
  ];
  const tapped = (vision: VisionResult) => {
    let s = run([{ type: 'overview-photo', photo }, { type: 'overview-result', vision: { ...vision, calibration: null }, balls: [] }, { type: 'start-corners' }]);
    for (const p of corners) s = snapReducer(s, { type: 'corner-tap', p });
    expect(s.step).toBe('overview-processing');
    return snapReducer(s, { type: 'overview-result', vision, balls: [] });
  };
  const result = (o: Partial<VisionResult>): VisionResult => ({ status: 'searching', calibration: null, balls: [], quality: 0, cloth: null, ms: 1, ...o }) as VisionResult;

  it('four taps that cannot be a table outline are refused before the photo is processed again, in Live’s words', () => {
    // Verifier r1: the still pipeline answers such taps 'cloth-unknown', so Snap said "Couldn’t tell
    // the cloth…" where Live (live-logic cornersPlausible) says "Those four taps aren’t the cloth
    // corners". The same check now runs on Snap's taps (photo px), before any still is sent.
    expect(SNAP_MESSAGES.badCorners).toBe(CALIBRATION_MESSAGES.badQuad);
    const bad = {
      'three on one rail': [
        { x: 100, y: 100 },
        { x: 450, y: 105 },
        { x: 800, y: 110 },
        { x: 60, y: 440 },
      ],
      'two on one spot': [
        { x: 100, y: 100 },
        { x: 105, y: 102 },
        { x: 850, y: 450 },
        { x: 60, y: 440 },
      ],
      'a sliver': [
        { x: 100, y: 100 },
        { x: 800, y: 110 },
        { x: 800, y: 125 },
        { x: 100, y: 118 },
      ],
    };
    for (const [what, taps] of Object.entries(bad)) {
      let s = run([{ type: 'overview-photo', photo }, { type: 'overview-result', vision: result({}), balls: [] }, { type: 'start-corners' }]);
      for (const p of taps) s = snapReducer(s, { type: 'corner-tap', p });
      expect(s.step, what).toBe('overview-error');
      expect(s.error, what).toBe(SNAP_MESSAGES.badCorners);
      expect(s.corners, what).toBeNull(); // nothing for the controller to send (runStill needs corners)
      expect(s.cornerTaps, what).toEqual([]);
      // "Tap the 4 corners" again starts a fresh set.
      expect(snapReducer(s, { type: 'start-corners' })).toMatchObject({ step: 'corners', cornerTaps: [], error: null });
    }
    // A real outline, in any tap order, is sent as before.
    let s = run([{ type: 'overview-photo', photo }, { type: 'overview-result', vision: result({}), balls: [] }, { type: 'start-corners' }]);
    for (const p of [corners[0]!, corners[2]!, corners[1]!, corners[3]!]) s = snapReducer(s, { type: 'corner-tap', p });
    expect(s.step).toBe('overview-processing');
    expect(s.corners).toHaveLength(4);
  });

  it("'bad-quad': the taps cannot be the cloth corners — tap them again", () => {
    const s = tapped(result({ reason: 'bad-quad', cloth: { hue: 140, sat: 0.6, val: 0.5 } }));
    expect(s.step).toBe('overview-error');
    expect(s.error).toBe(SNAP_MESSAGES.badCorners);
    expect(s.error).toBe('Those four taps aren’t the cloth corners — tap them again.');
  });

  it("'cloth-unknown': the cloth could not be told from its surroundings", () => {
    const s = tapped(result({ reason: 'cloth-unknown' }));
    expect(s.step).toBe('overview-error');
    expect(s.error).toBe(SNAP_MESSAGES.clothUnknown);
    expect(s.error).toMatch(/^Couldn’t tell the cloth from its surroundings/);
  });

  it("'moved' on a still (the quad is not mostly cloth): the layout opens, with a note to check it", () => {
    const s = tapped(result({ status: 'unstable', reason: 'moved', calibration: { source: 'manual' } as VisionResult['calibration'], balls: [] }));
    expect(s.step).toBe('review');
    expect(s.error).toBe(SNAP_MESSAGES.cornersLoose);
    expect(s.error).not.toMatch(/phone moved/i); // nothing moved: it is one photo
  });

  it('a reason from the real still pipeline: four taps on the floor, outside the table', () => {
    const camera: SynthCamera = { pos: { x: -2.25, y: -1.5, z: 1.8 }, target: { x: 0.15, y: 0.05, z: 0 }, fovDeg: 66 };
    const floor = [
      { x: 5, y: 5 },
      { x: 120, y: 8 },
      { x: 118, y: 90 },
      { x: 8, y: 88 },
    ];
    const r = still(camera, floor);
    expect(r.reason).toBeDefined();
    let s = run([{ type: 'overview-photo', photo }, { type: 'overview-result', vision: { ...r, calibration: null, reason: undefined } as VisionResult, balls: [] }, { type: 'start-corners' }]);
    for (const p of floor) s = snapReducer(s, { type: 'corner-tap', p });
    s = snapReducer(s, { type: 'overview-result', vision: r, balls: ballsOf(r) });
    expect([SNAP_MESSAGES.badCorners, SNAP_MESSAGES.clothUnknown, SNAP_MESSAGES.cornersLoose]).toContain(s.error);
    expect(s.error).not.toBe(SNAP_MESSAGES.noTable);
  });
});

describe('the guide for a frozen cue ball: aim the stroke, not a ghost ball (merge appChanges, controller HUD)', () => {
  const params = physicsFor(DEFAULT_SETTINGS);
  const R = table.ballRadius;
  const ob = { x: -0.1891063642501831, y: 0.25098126053810116 };
  const lay = (cue: { x: number; y: number }): TableLayout => ({
    table,
    balls: [
      { id: 'cue', kind: 'cue', pos: cue, label: 'cue' },
      { id: 'b1', kind: 'object', pos: ob, label: '1' },
    ],
    source: 'camera',
    frozen: true,
  });

  it('a frozen plan names the stroke angle off the line of centres, never "ghost ball" or a cut', () => {
    const cue = { x: -0.2451160266459315, y: 0.23962167347191393 };
    const plan = planShot(lay(cue), { targetId: 'b1', stroke: { power: 4, side: 0, vert: 0 } }, params);
    expect(plan.warnings.some((w) => w.code === 'frozen')).toBe(true);
    const aim = snapAimText(plan, cue, ob);
    expect(aim).not.toMatch(/ghost|cut/i);
    expect(aim).toMatch(/^Frozen: stroke (\d+° to the (left|right) of|straight through) the line of centres$/);
    // The same angle and side as the planner's own frozen warning.
    const w = plan.warnings.find((x) => x.code === 'frozen')!.message;
    const m = /stroke (\d+)° to the (left|right)/.exec(w);
    if (m) expect(aim).toBe(`Frozen: stroke ${m[1]}° to the ${m[2]} of the line of centres`);
    else expect(aim).toBe('Frozen: stroke straight through the line of centres');
    expect(snapGuideInstruction(plan, describeSpin)).toBe(`Frozen balls: aim the stroke, not a ghost ball. Strike ${describeSpin(plan.stroke)} (the blue dot on the ball's face).`);
  });

  it('both sides of the line of centres', () => {
    // Frozen cue balls around the 1, each aimed at the pocket the planner picks: some need a stroke
    // to the left, some to the right, and the words follow the planner's warning every time.
    const seen = new Set<string>();
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * 2 * Math.PI;
      const cue = { x: ob.x + 2 * R * Math.cos(a), y: ob.y + 2 * R * Math.sin(a) };
      const plan = planShot(lay(cue), { targetId: 'b1', stroke: { power: 5, side: 0, vert: 0 } }, params);
      if (!plan.makeable) continue;
      const w = plan.warnings.find((x) => x.code === 'frozen')?.message ?? '';
      const m = /stroke (\d+)° to the (left|right)/.exec(w);
      if (!m) continue;
      seen.add(m[2]!);
      expect(snapAimText(plan, cue, ob), w).toBe(`Frozen: stroke ${m[1]}° to the ${m[2]} of the line of centres`);
    }
    expect([...seen].sort()).toEqual(['left', 'right']);
  });

  it('a plan with a ghost ball keeps the ghost-ball words', () => {
    const cue = { x: -0.9, y: -0.1 };
    const plan = planShot(lay(cue), { targetId: 'b1', pocketId: 'TR', stroke: { power: 4, side: 0, vert: 0 } }, params);
    expect(plan.warnings.some((w) => w.code === 'frozen')).toBe(false);
    expect(snapAimText(plan, cue, ob)).toBe(`Aim at the ghost ball · ${plan.cutAngleDeg.toFixed(0)}° cut, ${plan.fractionPhrase.replace(/-/g, '‑')}`);
    expect(snapGuideInstruction(plan, describeSpin)).toBe(`Aim at the ghost ball. Strike ${describeSpin(plan.stroke)} (the blue dot on the ball's face).`);
  });
});

describe('clothRgbOf: the 3D cloth colour from the table photo’s cloth model', () => {
  it('a grey (neutral) cloth is grey, whatever its stored hue and saturation (hue 0 is meaningless there)', () => {
    const grey = clothRgbOf({ hue: 0, sat: 0.12, val: 0.5, kind: 'neutral' })!;
    expect(Math.max(...grey) - Math.min(...grey)).toBeLessThanOrEqual(1);
    // Before: hue 0 with some saturation rendered a red cloth.
    const asChromatic = clothRgbOf({ hue: 0, sat: 0.12, val: 0.5 })!;
    expect(asChromatic[0]).toBeGreaterThan(asChromatic[1] + 5);
  });
  it('a chromatic cloth keeps its hue (green stays green, blue stays blue)', () => {
    const green = clothRgbOf({ hue: 140, sat: 0.6, val: 0.5, kind: 'chromatic' })!;
    expect(green[1]).toBeGreaterThan(green[0]);
    expect(green[1]).toBeGreaterThan(green[2]);
    const blue = clothRgbOf({ hue: 215, sat: 0.6, val: 0.5 })!;
    expect(blue[2]).toBeGreaterThan(blue[0]);
    expect(clothRgbOf(null)).toBeUndefined();
  });
});

describe('a failed player-photo fit says what to do next (PLAYER_VIEW_REASONS)', () => {
  it('maps every reason: moved → retake the table photo; dark, grainy, no cloth → better photo (taps: see tapsOffered); the rest → two taps', () => {
    const want: Record<keyof typeof PLAYER_VIEW_REASONS, string> = {
      moved: 'retake-table',
      dark: 'retake-light',
      noisy: 'retake-light',
      noCloth: 'retake-light',
      tooFewBalls: 'taps',
      noCue: 'taps',
      noFit: 'taps',
      notBehind: 'taps',
    };
    for (const k of Object.keys(PLAYER_VIEW_REASONS) as (keyof typeof PLAYER_VIEW_REASONS)[]) {
      expect(playerFailAction(PLAYER_VIEW_REASONS[k]), k).toBe(want[k]);
    }
    expect(playerFailAction(null)).toBe('taps');
    expect(playerFailAction(SNAP_MESSAGES.detectionStoppedPlayer)).toBe('taps');
  });

  it("'moved': the two-tap fallback does not draw a guide from the old layout", () => {
    const layout: Ball[] = [
      { id: 'cue', kind: 'cue', pos: { x: -0.5, y: 0 } },
      { id: 'b1', kind: 'object', pos: { x: 0.3, y: 0.1 } },
    ];
    let s: SnapSession = { ...initialSnap(), step: 'manual-taps', layout, player: { width: 960, height: 720, result: null } as unknown as SnapSession['player'], error: PLAYER_VIEW_REASONS.moved, taps: {} };
    s = snapReducer(s, { type: 'manual-tap', p: { x: 100, y: 100 } });
    s = snapReducer(s, { type: 'manual-tap', p: { x: 200, y: 200 } });
    expect(s.step).toBe('manual-taps');
    expect(s.taps).toEqual({});
    let t: SnapSession = { ...s, error: PLAYER_VIEW_REASONS.noFit };
    t = snapReducer(t, { type: 'manual-tap', p: { x: 100, y: 100 } });
    t = snapReducer(t, { type: 'manual-tap', p: { x: 200, y: 200 } });
    expect(t.step).toBe('player-processing');
  });
  it('dark or grainy: the better photo is the instruction, the taps are offered once; no cloth in view: no taps (release verification: the player looped)', () => {
    // A dark (×0.15) or grainy (σ 20–28) photo whose two-tap fit failed with the same reason said
    // "Tap the centre of the cue ball" again, and the no-cloth photo (a wall, the floor) asked for a tap
    // on a cue ball that was not in it.
    const layout: Ball[] = [
      { id: 'cue', kind: 'cue', pos: { x: -0.5, y: 0 } },
      { id: 'b1', kind: 'object', pos: { x: 0.3, y: 0.1 } },
    ];
    const player = { width: 960, height: 720, result: null } as unknown as NonNullable<SnapSession['player']>;
    const failed = (reason: string, manual: boolean): SnapSession => ({ ...initialSnap(), step: 'manual-taps', layout, player: { ...player, manual }, error: reason, taps: {} });
    const twoTaps = (s: SnapSession) => snapReducer(snapReducer(s, { type: 'manual-tap', p: { x: 100, y: 100 } }), { type: 'manual-tap', p: { x: 200, y: 200 } });
    for (const reason of [PLAYER_VIEW_REASONS.dark, PLAYER_VIEW_REASONS.noisy]) {
      // First failure (automatic fit): the taps are offered and run the fit.
      expect(tapsOffered(failed(reason, false)), reason).toBe(true);
      expect(twoTaps(failed(reason, false)).step, reason).toBe('player-processing');
      // The two-tap fit failed for the same reason: the taps did not help; they are not offered again.
      const afterTaps = snapReducer({ ...failed(reason, false), step: 'player-processing', taps: { cue: { x: 1, y: 1 }, target: { x: 2, y: 2 } } }, { type: 'player-result', result: { ok: false, pose: null, confidence: 0, residualPx: Infinity, matched: [], reason, ms: 1 }, targetId: 'b1', manual: true });
      expect(afterTaps.step, reason).toBe('manual-taps');
      expect(tapsOffered(afterTaps), reason).toBe(false);
      expect(twoTaps(afterTaps).step, reason).toBe('manual-taps');
      expect(twoTaps(afterTaps).taps, reason).toEqual({});
    }
    // No cloth in view: no table, so no cue ball to tap.
    expect(tapsOffered(failed(PLAYER_VIEW_REASONS.noCloth, false))).toBe(false);
    expect(twoTaps(failed(PLAYER_VIEW_REASONS.noCloth, false)).step).toBe('manual-taps');
    // The reasons the taps fix keep them, also after a two-tap fit that failed (the player may tap again).
    for (const reason of [PLAYER_VIEW_REASONS.noFit, PLAYER_VIEW_REASONS.noCue, PLAYER_VIEW_REASONS.tooFewBalls, SNAP_MESSAGES.detectionStoppedPlayer]) {
      expect(tapsOffered(failed(reason, true)), reason).toBe(true);
    }
    expect(tapsOffered(failed(PLAYER_VIEW_REASONS.moved, false))).toBe(false);
    // The instruction names what the better photo needs.
    expect(retakeInstruction(PLAYER_VIEW_REASONS.dark)).toBe('Retake your photo with more light on the table.');
    expect(retakeInstruction(PLAYER_VIEW_REASONS.noisy)).toBe('Retake your photo with more light on the table, holding the phone steady.');
    expect(retakeInstruction(PLAYER_VIEW_REASONS.noCloth)).toBe('Retake your photo with the table’s cloth in view, aimed along your shot.');
  });
});
