/**
 * Package "plan-ui" (wave 2b): every place that draws or words a plan reads the merged core data
 * the same way — the cue stick along ShotPlan.cueDir (cueAimDir is the same vector), a faint labelled
 * stick line for side spin, the frozen-cue-ball conventions (no ghost ball, the stroke line from the
 * cue ball), the corner hanger's own object-ball path, the power meter's "only just drops" band and
 * frozen "no power" case, the headline warnings, the eighth-fraction labels, the snooker push-stroke
 * reason, the recommendation's honesty notes and the ball letters/colours for the new vision names.
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DRILLS } from '../../../src/app/drills';
import { createAnnouncer, planSentence } from '../../../src/app/announce';
import { DEFAULT_SETTINGS, physicsFor } from '../../../src/app/settings';
import { Overlay, type OverlayData } from '../../../src/app/render/overlay';
import { BALL_NEUTRAL, DASH, PALETTE, ballCss } from '../../../src/app/render/palette';
import { aimLine, isFrozenPlan, planLabel, stickDir, stickLine } from '../../../src/app/render/plan-draw';
import { TableView } from '../../../src/app/render/table-view';
import { tableGeom } from '../../../src/app/render3d/geom';
import { ballLook, cueAim, cuePose, frameGhost, parseColor, planRibbons, srgbToLinear } from '../../../src/app/render3d/scene-data';
import { drawGuide, focusMapping } from '../../../src/app/snap/draw';
import { aimLabelAnchor, buildPlayerGuide, guideFocus, inImage, playable, projectPolyline, unplayableHeadline, type PlayerGuide } from '../../../src/app/snap/guide';
import type { AppState } from '../../../src/app/store';
import { tagText } from '../../../src/app/ui/ball-tags';
import { PER_FRAME_MAX_MS, perFrame, renderSuggestions } from '../../../src/app/ui/controls';
import { meterMinPower, meterOptions, powerMeterSvg, powerText } from '../../../src/app/ui/power-meter';
import { planLabelContent } from '../../../src/app/ui/scene-labels';
import { NO_OTHER_POCKET, PICK_ANOTHER, ballChip, fractionTile, headlineWarning, recommendationContext, renderShotCard, type CardContext } from '../../../src/app/ui/shot-card';
import { DEFAULT_PHYSICS } from '../../../src/core/physics/params';
import { fractionOf } from '../../../src/core/shot/geometry';
import { planShot } from '../../../src/core/shot/planner';
import { makeTable } from '../../../src/core/table';
import type { Ball, PocketId, ShotPlan, Stroke, TableLayout, TableSpec, Vec2 } from '../../../src/core/types';
import { strikePoint, type CameraPose } from '../../../src/vision/player-view';
import { polyLength, recordingCanvas, sameDash, stubDocument, type TextRec } from './helpers/rec-canvas';

const table = makeTable('pool9');
const snooker = makeTable('snooker12');
const R = table.ballRadius;
const params = physicsFor(DEFAULT_SETTINGS);
const ball = (id: string, pos: Vec2, label = id, extra: Partial<Ball> = {}): Ball => ({ id, kind: id === 'cue' ? 'cue' : 'object', pos, label, ...extra });
const layoutOf = (balls: Ball[], t: TableSpec = table): TableLayout => ({ table: t, balls, source: 'virtual', frozen: false });
const drill = (id: string): TableLayout => layoutOf(DRILLS.find((d) => d.id === id)!.build(table));
const signedDeg = (a: Vec2, b: Vec2) => (Math.atan2(a.x * b.y - a.y * b.x, a.x * b.x + a.y * b.y) * 180) / Math.PI;
const unit = (v: Vec2) => {
  const l = Math.hypot(v.x, v.y);
  return { x: v.x / l, y: v.y / l };
};
const ctx = (over: Partial<CardContext> = {}): CardContext => ({ targetLabel: '1', pocketName: 'far right corner', status: null, recommendedPending: false, showDetails: false, hint: 'Tap the ball you want to pocket.', ...over });
function stubEl() {
  let html = '';
  const el = {
    dataset: {} as Record<string, string>,
    get innerHTML() {
      return html;
    },
    set innerHTML(v: string) {
      html = v;
    },
    closest: () => null,
    contains: () => false,
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener: () => {},
  };
  return el as unknown as HTMLElement;
}
const cardHtml = (plan: ShotPlan, over: Partial<CardContext> = {}) => {
  const el = stubEl();
  renderShotCard(el, plan, ctx(over));
  return el.innerHTML;
};

/** A cue ball frozen to the object ball, its line of centres pointing `offDeg` off the pocket mouth. */
function frozenLayout(pocketId: PocketId, ob: Vec2, offDeg = 0, t: TableSpec = table, obLabel = '1'): { lay: TableLayout; cue: Vec2; ob: Vec2 } {
  const pk = t.pockets.find((p) => p.id === pocketId)!;
  const a = Math.atan2(pk.mouthCenter.y - ob.y, pk.mouthCenter.x - ob.x) + (offDeg * Math.PI) / 180;
  const d = 2 * t.ballRadius + 0.0003;
  const cue = { x: ob.x - d * Math.cos(a), y: ob.y - d * Math.sin(a) };
  return { lay: layoutOf([ball('cue', cue, 'cue'), ball('b1', ob, obLabel)], t), cue, ob };
}
/** Side-spin layout: a long cut into TR. */
const squirtLay = layoutOf([ball('cue', { x: -0.5, y: -0.1 }, 'cue'), ball('b1', { x: 0.6, y: 0.3 }, '1')]);
const sidePlan = (side: number, vert = 0) => planShot(squirtLay, { targetId: 'b1', pocketId: 'TR', stroke: { power: 5, side, vert } }, params);

// ------------------------------------------------------------------------------------------------
// Canvas renderers under a recording context
// ------------------------------------------------------------------------------------------------
function drawTable(plan: ShotPlan, balls: Ball[], t: TableSpec = table, size = { w: 393, h: 700 }) {
  const rec = recordingCanvas(size.w, size.h);
  const view = new TableView(rec.canvas);
  view.draw({ table: t, balls, plan, targetId: plan.targetId, pocketId: plan.pocketId, landing: null, heatmap: null });
  return { ...rec, view };
}
const K = 220;
const H = [K, 0, 320, 0, -K, 240, 0, 0, 1];
function drawOverlay(plan: ShotPlan | null, balls: Ball[], t: TableSpec = table) {
  const rec = recordingCanvas(640, 480);
  const o = new Overlay(rec.canvas);
  const data: OverlayData = {
    table: t,
    calibration: { corners: [], H0: H, HR: H, focal: 500, focalSource: 'assumed', source: 'auto', camera: { x: 0, y: 0, z: 2 }, width: 640, height: 480 } as unknown as OverlayData['calibration'],
    balls,
    plan,
    targetId: plan?.targetId ?? null,
    pocketId: plan?.pocketId ?? null,
    calibTaps: [],
    showPlan: true,
  };
  o.draw(data, { toScreen: (p) => p, toFrame: (p) => p });
  return rec;
}
const ovPx = (p: Vec2) => ({ x: 320 + K * p.x, y: 240 - K * p.y });
const isColor = (c: string, hex: string) => c.toLowerCase() === hex.toLowerCase();

/** Top-down camera 3 m above the table centre (f = 500 px): everything is in the photo. */
const TOP: CameraPose = { R: [1, 0, 0, 0, -1, 0, 0, 0, -1], t: { x: 0, y: 0, z: 3 }, f: 500, cx: 640, cy: 360, width: 1280, height: 720 };

beforeEach(() => stubDocument());
afterEach(() => {
  delete (globalThis as { document?: unknown }).document;
});

describe('cue stick direction (w1-1): one vector, ShotPlan.cueDir; the drawn ball path stays aimDir', () => {
  it('cueAimDir is the same vector as cueDir, and the stick is aimDir turned by the squirt (pool and snooker)', () => {
    let withSquirt = 0;
    for (const t of [table, snooker]) {
      const lays = [layoutOf([ball('cue', { x: -0.5, y: -0.1 }, 'cue'), ball('b1', { x: 0.6, y: 0.3 }, '1')], t), layoutOf([ball('cue', { x: 0.2, y: -0.2 }, 'cue'), ball('b1', { x: -0.7, y: 0.25 }, '1')], t)];
      for (const lay of lays)
        for (const pocketId of ['TR', 'TL', 'BR'] as PocketId[])
          for (const side of [-0.45, -0.25, -0.1, -0.03, 0, 0.03, 0.1, 0.25, 0.45])
            for (const vert of [0, 0.3, -0.3]) {
              const p = planShot(lay, { targetId: 'b1', pocketId, stroke: { power: 5, side, vert } }, params);
              expect(p.cueAimDir).toBeDefined();
              expect(p.cueAimDir!.x).toBeCloseTo(p.cueDir.x, 12);
              expect(p.cueAimDir!.y).toBeCloseTo(p.cueDir.y, 12);
              const s = stickDir(p);
              expect(Math.hypot(s.x, s.y)).toBeCloseTo(1, 12);
              expect(s.x).toBeCloseTo(p.cueDir.x, 12);
              expect(s.y).toBeCloseTo(p.cueDir.y, 12);
              // Right english turns the stick clockwise of the ball path by the squirt angle.
              expect(signedDeg(p.aimDir, s)).toBeCloseTo(-p.squirtDeg, 6);
              if (side === 0) expect(p.squirtDeg).toBe(0);
              if (Math.abs(p.squirtDeg) >= 0.1) withSquirt++;
            }
    }
    expect(withSquirt).toBeGreaterThan(100);
  });

  it('3D: the cue stick is posed along stickDir while the camera and the aim line keep aimDir', () => {
    const g = tableGeom(table);
    const plan = sidePlan(0.4);
    expect(Math.abs(plan.squirtDeg)).toBeGreaterThan(1);
    const ca = cueAim({ balls: squirtLay.balls, plan, targetId: 'b1' })!;
    expect(ca.cueDir).toEqual(stickDir(plan));
    expect(ca.aim).toEqual(plan.aimDir);
    const pose = cuePose(g, ca.cue, ca.cueDir, plan.stroke);
    const back = unit({ x: pose.back[0], y: pose.back[1] });
    expect(back.x).toBeCloseTo(-stickDir(plan).x, 9);
    expect(back.y).toBeCloseTo(-stickDir(plan).y, 9);
    // The aim ribbon is still cue ball → ghost ball.
    const aim = planRibbons({ table, balls: squirtLay.balls, plan, targetId: 'b1', pocketId: 'TR', landing: null }, g).find((r) => r.key === 'aim')!;
    expect(aim.pts).toEqual([squirtLay.balls[0]!.pos, plan.ghost]);
  });

  it('Snap guide: the strike point and the cue axis follow stickDir, not the ball path', () => {
    const plan = sidePlan(0.4);
    const cue = squirtLay.balls[0]!.pos;
    const g = buildPlayerGuide({ pose: TOP, table, plan, cue, target: { x: 0.6, y: 0.3 }, stroke: plan.stroke });
    const c3 = { x: cue.x, y: cue.y, z: R };
    const s = stickDir(plan);
    const sp = strikePoint(c3, s, plan.stroke.side, plan.stroke.vert, R);
    const want = projectPolyline(TOP, [sp, { x: sp.x - s.x * 0.9, y: sp.y - s.y * 0.9, z: sp.z + 0.04 }]);
    expect(g.cueAxis).toEqual(want);
    // Along the ball path instead, the axis would end visibly elsewhere (≥ 1 px at 0.9 m).
    const a = plan.aimDir;
    const spA = strikePoint(c3, a, plan.stroke.side, plan.stroke.vert, R);
    const alt = projectPolyline(TOP, [spA, { x: spA.x - a.x * 0.9, y: spA.y - a.y * 0.9, z: spA.z + 0.04 }]);
    const end = (r: Vec2[][]) => r.at(-1)!.at(-1)!;
    expect(Math.hypot(end(alt).x - end(g.cueAxis).x, end(alt).y - end(g.cueAxis).y)).toBeGreaterThan(1);
  });
});

describe('faint cue-stick line for side spin (w1-2): dashed, labelled, never mistaken for the ball path', () => {
  const stickStrokes = (strokes: ReturnType<typeof recordingCanvas>['strokes']) => strokes.filter((s) => sameDash(s.dash, DASH.stick));
  it('the stick dash and colour are unlike every path style', () => {
    expect(DASH.stick).toBeDefined();
    for (const d of [DASH.cue, DASH.aim, DASH.object, DASH.other, DASH.ghost]) expect(sameDash(DASH.stick, d)).toBe(false);
    for (const c of [PALETTE.aim, PALETTE.object, PALETTE.cue, PALETTE.other]) expect(PALETTE.stick.toLowerCase()).not.toBe(c.toLowerCase());
  });

  it('2D table: drawn behind the cue ball along the stick direction when |squirt| ≥ 0.1°, with a "Cue stick" label', () => {
    const plan = sidePlan(0.4);
    const r = drawTable(plan, squirtLay.balls);
    const st = stickStrokes(r.strokes);
    expect(st.length).toBe(1);
    const [a, b] = [st[0]!.pts[0]!, st[0]!.pts.at(-1)!];
    const q = r.view.toCanvas(squirtLay.balls[0]!.pos);
    // Starts just behind the cue ball (not over it) and runs away from the shot.
    expect(Math.hypot(a.x - q.x, a.y - q.y)).toBeGreaterThan(R * r.view.scale);
    const want = r.view.toCanvas({ x: squirtLay.balls[0]!.pos.x - stickDir(plan).x, y: squirtLay.balls[0]!.pos.y - stickDir(plan).y });
    expect(signedDeg(unit({ x: b.x - a.x, y: b.y - a.y }), unit({ x: want.x - q.x, y: want.y - q.y }))).toBeCloseTo(0, 6);
    expect(polyLength(st[0]!.pts)).toBeGreaterThan(40);
    expect(r.texts.map((t) => t.text)).toContain('Cue stick');
    // No side spin: no stick line, no label.
    const centre = drawTable(sidePlan(0), squirtLay.balls);
    expect(stickStrokes(centre.strokes)).toHaveLength(0);
    expect(centre.texts.map((t) => t.text)).not.toContain('Cue stick');
  });

  it('camera overlay: the same line and label; none below 0.1° of squirt', () => {
    const plan = sidePlan(-0.35);
    const r = drawOverlay(plan, squirtLay.balls);
    const st = stickStrokes(r.strokes);
    expect(st.length).toBe(1);
    const a = st[0]!.pts[0]!;
    const b = st[0]!.pts.at(-1)!;
    const s = stickDir(plan);
    expect(signedDeg(unit({ x: b.x - a.x, y: b.y - a.y }), unit({ x: -s.x, y: s.y }))).toBeCloseTo(0, 6);
    expect(r.texts.map((t) => t.text)).toContain('Cue stick');
    const small = sidePlan(0.015);
    expect(Math.abs(small.squirtDeg)).toBeLessThan(0.1);
    expect(stickStrokes(drawOverlay(small, squirtLay.balls).strokes)).toHaveLength(0);
    expect(stickLine(small, squirtLay.balls[0]!.pos, R)).toBeNull();
  });

  it('no stick line for a shot with no stroke (not makeable)', () => {
    const blocked = planShot(drill('blocked'), { targetId: 'b5', pocketId: 'BM', stroke: { power: 5, side: 0.4, vert: 0 } }, params);
    expect(blocked.makeable).toBe(false);
    expect(stickLine(blocked, drill('blocked').balls.find((b) => b.kind === 'cue')!.pos, R)).toBeNull();
  });
});

describe('frozen cue ball (w1-4): no ghost ball, the stroke line drawn from the cue ball', () => {
  const { lay, cue } = frozenLayout('TR', { x: 0.87, y: 0.48 });
  const plan = planShot(lay, { targetId: 'b1', pocketId: 'TR' }, params);
  const side = planShot(frozenLayout('TR', { x: 0.87, y: 0.48 }, 8).lay, { targetId: 'b1', pocketId: 'TR' }, params);

  it('the fixture is a makeable frozen plan whose ghost is the cue ball', () => {
    expect(isFrozenPlan(plan)).toBe(true);
    expect(plan.makeable).toBe(true);
    expect(Math.hypot(plan.ghost.x - cue.x, plan.ghost.y - cue.y)).toBeLessThan(1e-9);
    expect(plan.cutAngleDeg).toBe(0);
    expect(plan.fractionLabel).toBe('full');
    expect(isFrozenPlan(sidePlan(0))).toBe(false);
  });

  it('aimLine: the stroke from the cue ball, past the object ball; no ghost', () => {
    const a = aimLine(plan, cue, R);
    expect(a.ghost).toBeNull();
    expect(a.from).toEqual(cue);
    const L = Math.hypot(a.to.x - a.from.x, a.to.y - a.from.y);
    expect(L).toBeGreaterThan(3 * R + 0.05);
    expect(signedDeg(plan.aimDir, unit({ x: a.to.x - a.from.x, y: a.to.y - a.from.y }))).toBeCloseTo(0, 9);
    const n = aimLine(sidePlan(0), squirtLay.balls[0]!.pos, R);
    expect(n.ghost).toEqual(sidePlan(0).ghost);
    expect(n.to).toEqual(sidePlan(0).ghost);
  });

  it('2D table: a visible blue stroke line along aimDir, no ghost ring on the cue ball, a "Frozen" label', () => {
    const r = drawTable(plan, lay.balls);
    const aim = r.strokes.filter((s) => isColor(s.color, PALETTE.aim));
    expect(aim.length).toBe(1);
    expect(polyLength(aim[0]!.pts)).toBeGreaterThan(3 * R * r.view.scale);
    expect(r.strokes.some((s) => sameDash(s.dash, DASH.ghost))).toBe(false);
    const label = r.texts.find((t) => t.text.startsWith('Frozen'));
    expect(label?.text).toMatch(/^Frozen · (straight through|stroke \d+° (left|right))$/);
    expect(r.texts.some((t) => /full/.test(t.text))).toBe(false);
    const turned = drawTable(side, frozenLayout('TR', { x: 0.87, y: 0.48 }, 8).lay.balls);
    expect(turned.texts.map((t) => t.text)).toContainEqual(expect.stringMatching(/^Frozen · stroke \d+° (left|right)$/));
  });

  it('camera overlay: the same, from the cue ball', () => {
    const r = drawOverlay(plan, lay.balls);
    const aim = r.strokes.filter((s) => isColor(s.color, PALETTE.aim));
    expect(aim.length).toBe(1);
    expect(aim[0]!.pts[0]).toEqual(ovPx(cue));
    expect(polyLength(aim[0]!.pts)).toBeGreaterThan(3 * R * K);
    expect(r.strokes.some((s) => sameDash(s.dash, DASH.ghost))).toBe(false);
    expect(r.texts.some((t) => t.text.startsWith('Frozen'))).toBe(true);
  });

  it('3D: the aim ribbon has length along aimDir and there is no ghost ring; the camera gets no ghost', () => {
    const g = tableGeom(table);
    for (const ghostSolid of [false, true]) {
      const rib = planRibbons({ table, balls: lay.balls, plan, targetId: 'b1', pocketId: 'TR', landing: null }, g, { ghostSolid });
      const aim = rib.find((x) => x.key === 'aim')!;
      expect(aim.pts[0]).toEqual(cue);
      expect(polyLength(aim.pts)).toBeGreaterThan(3 * R);
      expect(rib.some((x) => x.key === 'ghost')).toBe(false);
    }
    const ca = cueAim({ balls: lay.balls, plan, targetId: 'b1' })!;
    expect(ca.ghost).toBeNull();
    expect(ca.aim).toEqual(plan.aimDir);
  });

  it('Snap guide: a drawn stroke line, no ghost outline or centre', () => {
    const g = buildPlayerGuide({ pose: TOP, table, plan, cue, target: { x: 0.87, y: 0.48 }, stroke: plan.stroke });
    expect(g.ghost).toEqual([]);
    expect(g.ghostCenter).toBeNull();
    expect(g.aim.reduce((s, run) => s + polyLength(run), 0)).toBeGreaterThan(5);
    // A plain shot keeps its ghost ball.
    const n = buildPlayerGuide({ pose: TOP, table, plan: sidePlan(0), cue: squirtLay.balls[0]!.pos, target: { x: 0.6, y: 0.3 }, stroke: sidePlan(0).stroke });
    expect(n.ghost.length).toBeGreaterThan(0);
    expect(n.ghostCenter).not.toBeNull();
  });

  // The Snap HUD's own aim line is live-snap's snap/session.ts snapAimText (tested there, frozen
  // included); the words on the photo come from the guide (aimLabel) and match the 2D label.
  it('words: the card, the announcer and the Snap photo label say "frozen", never "0° cut, full-ball"', () => {
    const html = cardHtml(plan);
    expect(html).toContain('Frozen');
    expect(html).not.toMatch(/full(-|‑)?ball hit|full hit/);
    const s = planSentence(plan, { TR: 'far right corner' }, () => '1');
    expect(s).toMatch(/frozen/i);
    expect(s).not.toMatch(/cut 0 degrees|full-ball/);
    const g = buildPlayerGuide({ pose: TOP, table, plan, cue, target: { x: 0.87, y: 0.48 }, stroke: plan.stroke });
    expect(g.aimLabel!.text).toMatch(/^Frozen/);
    expect(g.aimLabel!.text).not.toMatch(/ghost ball|0° cut|full/);
  });
});

describe('corner hanger past the mouth line (w1-5): the object-ball path is objectPath, never ball → mouthHit', () => {
  const tr = table.pockets.find((p) => p.id === 'TR')!;
  const ob = { x: tr.mouthCenter.x - tr.inward.x * R * 0.8, y: tr.mouthCenter.y - tr.inward.y * R * 0.8 };
  const lay = layoutOf([ball('cue', { x: ob.x - 0.6, y: ob.y - 0.25 }, 'cue'), ball('b1', ob, '1')]);
  const plan = planShot(lay, { targetId: 'b1', pocketId: 'TR' }, params);
  it('the plan pots it with a real simulated path', () => {
    expect(plan.makeable).toBe(true);
    expect(plan.obPocketed).toBe(true);
    expect(plan.objectPath.points.length).toBeGreaterThan(1);
  });
  it('2D, overlay, 3D and Snap all draw the simulated objectPath from the ball', () => {
    const r = drawTable(plan, lay.balls);
    const ob2 = r.strokes.filter((s) => isColor(s.color, PALETTE.object));
    expect(ob2).toHaveLength(1);
    expect(ob2[0]!.pts).toEqual(plan.objectPath.points.map((p) => r.view.toCanvas(p)));
    const o = drawOverlay(plan, lay.balls).strokes.filter((s) => isColor(s.color, PALETTE.object));
    expect(o).toHaveLength(1);
    expect(o[0]!.pts).toEqual(plan.objectPath.points.map(ovPx));
    const rib = planRibbons({ table, balls: lay.balls, plan, targetId: 'b1', pocketId: 'TR', landing: null }, tableGeom(table)).find((x) => x.key === 'ob')!;
    expect(rib.pts[0]).toEqual(ob);
    // (Seen from straight above, the whole short path lies under the object ball itself, which the
    // guide leaves undrawn; without a target outline it is drawn from objectPath.)
    const g = buildPlayerGuide({ pose: TOP, table, plan, cue: lay.balls[0]!.pos, target: null, stroke: plan.stroke });
    expect(g.objectPath.flat()[0]).toEqual(projectPolyline(TOP, plan.objectPath.points.map((p) => ({ ...p, z: 0 })))[0]![0]);
  });
});

describe('power meter (w1-6): the "only just drops" band and the frozen "no power" case', () => {
  it('marks minPowerCapture..minPower with a dashed band and says it in words', () => {
    const svg = powerMeterSvg(3, 3.4, { capture: 2.8 });
    expect(svg).toMatch(/class="just-drops"[^>]*stroke-dasharray/);
    const text = powerText(3, 3.4, { capture: 2.8 });
    expect(text).toContain('Minimum 3.4');
    expect(text).toContain('from 2.8 it only just drops');
    // No band when the two minimums are the same or the capture figure is missing.
    expect(powerMeterSvg(3, 3.4, { capture: 3.4 })).not.toContain('just-drops');
    expect(powerMeterSvg(3, 3.4)).not.toContain('just-drops');
    expect(powerText(3, 3.4)).not.toContain('only just drops');
  });

  it('a plan card shows the band from the plan', () => {
    const plan = planShot(drill('cut30'), { targetId: 'b1', pocketId: 'TR', stroke: { power: 4, side: 0, vert: 0 } }, params);
    expect(plan.minPowerCapture!).toBeLessThan(plan.minPower - 0.05);
    const html = cardHtml(plan);
    expect(html).toContain('just-drops');
    expect(html).toContain('only just drops');
  });

  it('frozen, no power pots it (minPower 10.5): no "Needs more than full power" next to "harder throws it less"', () => {
    const lay = layoutOf([ball('cue', { x: -0.2960660046526003, y: -0.4506717941723339 }, 'cue'), ball('b1', { x: -0.25, y: -0.485 }, '1')]);
    const plan = planShot(lay, { targetId: 'b1', pocketId: 'BM', stroke: { power: 1, side: 0, vert: 0.4 } }, DEFAULT_PHYSICS);
    expect(isFrozenPlan(plan)).toBe(true);
    expect(plan.makeable).toBe(true);
    expect(plan.minPower).toBeGreaterThan(10);
    expect(plan.warnings.find((w) => w.code === 'too-soft')!.message).toMatch(/no power with this follow gets it in/);
    const html = cardHtml(plan, { showDetails: true });
    expect(html).not.toMatch(/Needs more than full power/);
    expect(html).not.toMatch(/<dt>Min power<\/dt><dd>&gt;10<\/dd>/);
    expect(html).toMatch(/<dt>Min power<\/dt><dd>none[^<]*<\/dd>/);
    expect(powerText(1, plan.minPower, { frozen: true })).not.toMatch(/more than full power/);
    expect(powerText(1, plan.minPower, { frozen: true })).toMatch(/no power gets it in with pace/i);
    expect(powerMeterSvg(1, plan.minPower, { frozen: true })).not.toContain('min-tick');
    // Not frozen, too far: still "more than full power" (the warnings say "even at full power").
    expect(powerText(5, 10.8)).toContain('Needs more than full power');
  });
});

describe('headline warnings (w1-8)', () => {
  it("'throw-uncompensable' is a headline warning, ranked with 'ob-missed'", () => {
    const plan = planShot(drill('cut30'), { targetId: 'b1', pocketId: 'TR', stroke: { power: 5, side: 0, vert: 0 } }, params);
    const w = { code: 'throw-uncompensable' as const, message: 'Throw pushes the ball into the rail at this speed and spin — use more pace or different spin.' };
    const p = { ...plan, warnings: [{ code: 'thin-cut' as const, message: 'Thin cut.' }, w] };
    expect(headlineWarning(p)).toEqual(w);
    const html = cardHtml(p);
    expect(html).toContain('class="head-warn warn-throw-uncompensable"');
    expect(html.split(w.message).length - 1).toBe(1);
  });
});

describe('eighth-fraction labels (w1-9)', () => {
  const plan = planShot(drill('cut30'), { targetId: 'b1', pocketId: 'TR', stroke: { power: 5, side: 0, vert: 0 } }, params);
  const thick = { ...plan, cutAngleDeg: 36.2, fractionLabel: 'thick ⅜', fractionPhrase: 'a touch thicker than ⅜-ball' };
  it('2D table and overlay labels use the card tile wording ("36° · ⅜+ ball"), never "thick ⅜ ball"', () => {
    const balls = drill('cut30').balls;
    for (const texts of [drawTable(thick, balls).texts, drawOverlay(thick, balls).texts]) {
      expect(texts.map((t) => t.text)).toContain(`36° · ${fractionTile(thick)}`);
      expect(texts.some((t) => /thick ⅜ ball|thin ⅛ ball/.test(t.text))).toBe(false);
    }
    expect(planLabel(thick, balls[0]!.pos)).toBe('36° · ⅜+ ball');
    expect(planLabel(plan, balls[0]!.pos)).toBe('30° · ½-ball hit');
  });
  it('every label from 0° to 89° stays short (≤ 18 characters: one line in a 375 px view)', () => {
    const p = planShot(drill('cut30'), { targetId: 'b1', pocketId: 'TR' }, params);
    for (let c = 0; c < 90; c += 0.25) {
      const t = planLabel({ ...p, cutAngleDeg: c, ...labelOf(c) }, drill('cut30').balls[0]!.pos);
      expect(t.length).toBeLessThanOrEqual(18);
    }
  });
});
const labelOf = (c: number) => {
  const f = fractionOf((c * Math.PI) / 180);
  return { fractionLabel: f.label, fractionPhrase: f.phrase, fraction: f.fraction };
};

describe('snooker: a ball touching the cue ball (w1-10) — the reason, not a generic failure', () => {
  const { lay } = frozenLayout('TR', { x: 0.9, y: 0.45 }, 0, snooker, 'red');
  const plan = planShot(lay, { targetId: 'b1', pocketId: 'TR' }, params);
  it('the plan is not makeable because of the push-stroke rule', () => {
    expect(plan.makeable).toBe(false);
    expect(plan.warnings.find((w) => w.code === 'not-makeable')!.message).toMatch(/push stroke/);
    expect(plan.alternatives).toEqual([]);
  });
  it('card: the reason leads, no "plus a little throw" hint and no "Try another pocket"', () => {
    const html = cardHtml(plan);
    expect(html).toMatch(/aria-label="Why it is not makeable">.*push stroke/s);
    expect(html).not.toContain('plus a little throw');
    expect(html).not.toContain('Try another pocket');
    expect(html).toContain('No other pocket is clear for this ball');
  });
  it('3D label, Snap guide panel and announcer name the touching ball', () => {
    const lc = planLabelContent(plan, { TR: 'far right corner' } as Record<PocketId, string>, { snooker: true });
    expect(lc).toEqual({ kind: 'warn', text: 'Not makeable · touching ball', sub: 'Play away from it (a push is a foul)' });
    expect(unplayableHeadline(plan).reason).toMatch(/push stroke/);
    expect(planSentence(plan, { TR: 'far right corner' }, () => 'red')).toMatch(/push stroke/);
    // Pool frozen-line: the geometry reason, and the generic frozen hint is not repeated either.
    const pool = planShot(frozenLayout('TR', { x: 0.9, y: 0.45 }, 30).lay, { targetId: 'b1', pocketId: 'TR' }, params);
    expect(pool.makeable).toBe(false);
    expect(cardHtml(pool)).not.toContain('plus a little throw');
    expect(planLabelContent(pool, { TR: 'far right corner' } as Record<PocketId, string>, {})).toMatchObject({ kind: 'warn', text: 'Not makeable · balls frozen together' });
  });
});

describe('ball letters and colours for the new vision names (w1-13): pink, brown and the neutral "ball"', () => {
  it('tags and chips: no letter for "ball"; Br/Bl/Bk tell brown, blue and black apart', () => {
    expect(tagText({ kind: 'object', label: 'ball', id: 'b3' })).toBe('');
    expect(tagText({ kind: 'object', label: 'ball', id: 'b3' }, true)).toBe('');
    expect(tagText({ kind: 'object', label: 'brown', id: 'x' }, true)).toBe('Br');
    expect(tagText({ kind: 'object', label: 'pink', id: 'x' }, true)).toBe('P');
    expect(ballChip('ball')).not.toContain('<i>');
    expect(ballChip('brown')).toContain('<i>Br</i>');
    expect(ballChip('blue')).toContain('<i>Bl</i>');
    expect(ballChip('black')).toContain('<i>Bk</i>');
    expect(ballChip('pink')).toContain('<i>P</i>');
    expect(ballChip('7')).toContain('<i>7</i>');
  });
  it('2D table: "ball" gets no letter, snooker brown "Br", pink "P", in their own colours', () => {
    const balls = [ball('cue', { x: -0.8, y: 0 }, 'cue'), ball('b1', { x: 0.2, y: 0.1 }, 'ball'), ball('b2', { x: 0.4, y: -0.2 }, 'brown'), ball('b3', { x: 0.6, y: 0.3 }, 'pink'), ball('b4', { x: -0.3, y: 0.3 }, 'blue')];
    const plan = planShot(layoutOf(balls, snooker), { targetId: 'b3', pocketId: 'TR' }, params);
    const r = drawTable(plan, balls, snooker, { w: 900, h: 1600 });
    const at = (id: string) => r.view.toCanvas(balls.find((b) => b.id === id)!.pos);
    const near = (id: string) => r.texts.filter((t) => Math.hypot(t.x - at(id).x, t.y - at(id).y) < 3).map((t) => t.text);
    expect(near('b1')).toEqual([]);
    expect(near('b2')).toEqual(['Br']);
    expect(near('b3')).toEqual(['P']);
    expect(near('b4')).toEqual(['Bl']);
    const fillsAt = (id: string) => r.fills.filter((f) => f.rect && Math.hypot(f.rect.x + f.rect.w / 2 - at(id).x, f.rect.y + f.rect.h / 2 - at(id).y) < 1).map((f) => f.color.toLowerCase());
    expect(fillsAt('b3')).toContain(ballCss(balls[3]!, true).toLowerCase());
    expect(fillsAt('b2')).toContain(ballCss(balls[2]!, true).toLowerCase());
    // The neutral "ball" with no measured colour is drawn neutral, not red.
    const rgb = parseColor(ballCss(balls[1]!, true))!;
    expect(Math.max(...rgb) - Math.min(...rgb)).toBeLessThan(0.08);
  });
  it('colours: canonical pink and brown; a detected colour is kept on a pool table', () => {
    const pink = parseColor(ballCss(ball('p', { x: 0, y: 0 }, 'pink'), true))!;
    expect(pink[0]).toBeGreaterThan(pink[1]! + 0.2);
    expect(pink[0]).toBeGreaterThan(0.8);
    const brown = parseColor(ballCss(ball('br', { x: 0, y: 0 }, 'brown'), true))!;
    expect(brown[0]).toBeGreaterThan(brown[2]!);
    expect(Math.max(...brown)).toBeLessThan(0.55);
    expect(ballCss(ball('x', { x: 0, y: 0 }, 'pink', { color: 'rgb(10,20,30)' }), false)).toBe('rgb(10,20,30)');
    // 3D: the same colours (linear light), and "ball" without a colour is neutral there too.
    const lin = (c: number[]) => c.map(srgbToLinear);
    expect(ballLook(ball('p', { x: 0, y: 0 }, 'pink'), snooker).color).toEqual(lin(pink));
    expect(ballLook(ball('p', { x: 0, y: 0 }, 'pink'), table).color).toEqual(lin(pink));
    expect(ballLook(ball('b', { x: 0, y: 0 }, 'brown'), table).color).toEqual(lin(brown));
    const n = ballLook(ball('n', { x: 0, y: 0 }, 'ball'), table).color;
    expect(Math.max(...n) - Math.min(...n)).toBeLessThan(0.05);
  });
});

describe('recommendation display (w1-7): speed-sensitive, cut-short search, risks not known', () => {
  const base = planShot(drill('cut30'), { targetId: 'b1', pocketId: 'TR' }, params, { recommended: { power: 5, side: 0, vert: -0.2 } as Stroke });
  it('the fixture is a recommended stroke', () => expect(base.strokeSource).toBe('recommended'));
  it('notes on the card, only for the recommended stroke', () => {
    const f = cardHtml(base, { fragile: true });
    expect(f).toContain('Speed-sensitive — small changes in pace may change the result.');
    expect(cardHtml(base, { searchCutShort: true })).toContain('Search cut short — the best stroke found in time.');
    expect(cardHtml(base, { risksUnknown: true })).toContain('Scratch risk from small errors not checked.');
    const plain = cardHtml(base, {});
    expect(plain).not.toMatch(/Speed-sensitive|cut short|not checked/);
    const mine = { ...base, strokeSource: 'player' as const };
    expect(cardHtml(mine, { fragile: true, searchCutShort: true, risksUnknown: true })).not.toMatch(/Speed-sensitive|cut short|not checked/);
  });
  it('recommendationContext: absent risks are "not known", never "safe"', () => {
    const rec = (over: Partial<NonNullable<AppState['recommended']>>): AppState['recommended'] => ({ key: 'k', stroke: base.stroke, pending: false, reachable: true, evaluated: 200, ...over });
    expect(recommendationContext(rec({ risks: [] }), base)).toEqual({ fragile: false, searchCutShort: false, risksUnknown: false });
    expect(recommendationContext(rec({}), base)).toEqual({ fragile: false, searchCutShort: false, risksUnknown: true });
    expect(recommendationContext(rec({ fragile: true, timedOut: true, nextQuality: 0.4 }), base)).toEqual({ fragile: true, searchCutShort: true, risksUnknown: true });
    expect(recommendationContext(rec({ pending: true }), base)).toEqual({});
    expect(recommendationContext(rec({ fragile: true }), { ...base, strokeSource: 'player' })).toEqual({});
    expect(recommendationContext(null, base)).toEqual({});
  });
});

describe('throw correction (w1-3): reads throwShiftDir when an older producer sets only that', () => {
  it('a thicker shift with outside english names outside english', () => {
    const plan = planShot(drill('cut30'), { targetId: 'b1', pocketId: 'TR', stroke: { power: 3, side: -0.25, vert: 0 } }, params);
    expect(plan.throwShiftDir).toBe(plan.throwAim);
    const old = { ...plan, throwAim: null, tip: '' };
    expect(cardHtml(old)).toMatch(/Outside english throws the object ball thin here, so the ghost ball is shifted [\d.]+ mm thicker\./);
  });
});


describe('power slider: at most one replan per frame (a soft frozen-ball replan costs 12–75 ms)', () => {
  it('perFrame keeps the last value of a frame and flushes at once when the drag ends', () => {
    const got: number[] = [];
    let cb: (() => void) | null = null;
    let frames = 0;
    const f = perFrame(
      (v: number) => got.push(v),
      (c) => {
        cb = c;
        frames++;
      },
    );
    f.push(1);
    f.push(1.5);
    f.push(2);
    expect(got).toEqual([]);
    expect(frames).toBe(1);
    cb!();
    expect(got).toEqual([2]);
    f.push(2.5);
    f.flush();
    expect(got).toEqual([2, 2.5]);
    cb!();
    expect(got).toEqual([2, 2.5]);
  });
});

// ================================================================================================
// Round 1 repairs (adversarial verification): the peek's frozen tile, the announcer's frozen hint,
// the blocked card's tip, the unnamed ball's words, chip letters/colours, the Snap photo's label
// without a ghost ball, the 3D frame's ghost, the meter options and the slider's coalescing.
// ================================================================================================
const speak = (plan: ShotPlan, label: string, names: Partial<Record<PocketId, string>> = { TR: 'far right corner' }) => {
  const el = { textContent: '' as string | null };
  const a = createAnnouncer(el, { set: (f) => (f(), 1), clear: () => {} });
  a.update(plan, false, names, () => label);
  return el.textContent ?? '';
};
/** What a screen reader reads of card markup: hidden spans and tags dropped. */
const srText = (html: string) =>
  html
    .replace(/<span hidden[^>]*>.*?<\/span>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ');

describe('r1 announcer (w1-10): a shot that is not makeable never ends with the generic frozen hint', () => {
  const touching = planShot(frozenLayout('TR', { x: 0.9, y: 0.45 }, 0, snooker, 'red').lay, { targetId: 'b1', pocketId: 'TR' }, params);
  const frozenLine = planShot(frozenLayout('TR', { x: 0.9, y: 0.45 }, 30).lay, { targetId: 'b1', pocketId: 'TR' }, params);
  it('snooker touching ball: the push-stroke reason, not "plus a little throw"', () => {
    const t = speak(touching, 'red');
    expect(t).toMatch(/push stroke/);
    expect(t).not.toMatch(/plus a little throw|line of centres/);
  });
  it('pool, frozen along a line that misses: the reason only', () => {
    expect(frozenLine.makeable).toBe(false);
    const t = speak(frozenLine, '1');
    expect(t).toMatch(/not makeable/);
    expect(t).not.toMatch(/plus a little throw/);
  });
  it('a makeable frozen shot still speaks its frozen warning', () => {
    const { lay } = frozenLayout('TR', { x: 0.87, y: 0.48 });
    const p = planShot(lay, { targetId: 'b1', pocketId: 'TR' }, params);
    expect(p.makeable).toBe(true);
    expect(speak(p, '1')).toContain(p.warnings.find((w) => w.code === 'frozen')!.message.replace(/\.$/, ''));
  });
});

describe('r1 card (w1-10): the blocked tip never repeats the warning, the frozen screen-reader text has no 0.0°', () => {
  it('blocked drill b1 → far right corner: "No other pocket is clear…" exactly once', () => {
    const p = planShot(drill('blocked'), { targetId: 'b1', pocketId: 'TR' }, params);
    expect(p.makeable).toBe(false);
    expect(p.alternatives).toEqual([]);
    const html = cardHtml(p);
    expect(html.split(NO_OTHER_POCKET).length - 1).toBe(1);
    expect(html).toContain(`data-testid="tip">${PICK_ANOTHER}<`);
  });
  it('snooker touching ball (no warning says it): the tip says it, once', () => {
    const p = planShot(frozenLayout('TR', { x: 0.9, y: 0.45 }, 0, snooker, 'red').lay, { targetId: 'b1', pocketId: 'TR' }, params);
    const html = cardHtml(p, { targetLabel: 'red' });
    expect(html.split(NO_OTHER_POCKET).length - 1).toBe(1);
    expect(html).toContain(`data-testid="tip">${NO_OTHER_POCKET}<`);
  });
  it('balls frozen together: no meaningless "0.0°" read aloud (the test id stays, hidden)', () => {
    const p = planShot(frozenLayout('TR', { x: 0.9, y: 0.45 }, 30).lay, { targetId: 'b1', pocketId: 'TR' }, params);
    const html = cardHtml(p);
    expect(html).toMatch(/<span hidden data-testid="cut">0\.0°<\/span>/);
    const sr = srText(html);
    expect(sr).toContain('Balls frozen together. No stroke: this shot is not makeable.');
    expect(sr).not.toMatch(/0\.0°/);
    // A plain not-makeable shot still says its cut.
    const thin = planShot(drill('blocked'), { targetId: 'b1', pocketId: 'BR' }, params);
    expect(srText(cardHtml(thin))).toMatch(/Cut 8\d\.\d°, /);
  });
});

describe('r1 words for a ball vision could not name ("ball")', () => {
  const plan = planShot(drill('cut30'), { targetId: 'b1', pocketId: 'TR' }, params);
  it('announcer and card title: "Unnamed ball", never "Ball ball"', () => {
    const s = planSentence(plan, { TR: 'far right corner' }, () => 'ball');
    expect(s).toMatch(/^Unnamed ball to the far right corner: /);
    expect(planSentence(plan, { TR: 'far right corner' }, () => '1')).toMatch(/^Ball 1 to the far right corner: /);
    const title = srText(cardHtml(plan, { targetLabel: 'ball' }));
    expect(title).not.toMatch(/Ball ball/i);
    expect(title).toContain('Unnamed ball');
  });
  it("ball picker: \"Unnamed ball\", and its chip is neutral grey, not the cue ball's ivory", () => {
    const el = stubEl();
    renderShotCard(el, null, ctx({ balls: [{ id: 'b3', label: 'ball' }, { id: 'b4', label: 'red', color: '#c81e1e' }] }));
    expect(el.innerHTML).not.toContain('aria-label="Ball ball"');
    expect(el.innerHTML).toContain('aria-label="Unnamed ball"');
    expect(ballChip('ball')).toContain(`--ball:${BALL_NEUTRAL}`);
    expect(ballChip('cue')).not.toContain(BALL_NEUTRAL);
  });
});

describe('r1 chip letters follow the table, as the 2D table and the 3D tags do', () => {
  it('pool: a colour-named vision ball shows its number; snooker: its letters; unknown table: the initial', () => {
    expect(ballChip('red', undefined, false, false)).toContain('<i>3</i>');
    expect(ballChip('yellow stripe', undefined, true, false)).toContain('<i>9</i>');
    expect(ballChip('black', undefined, false, false)).toContain('<i>8</i>');
    expect(ballChip('red', undefined, false, true)).toContain('<i>R</i>');
    expect(ballChip('blue', undefined, false, true)).toContain('<i>Bl</i>');
    expect(ballChip('ball', undefined, false, false)).not.toContain('<i>');
    expect(ballChip('red')).toContain('<i>R</i>');
    for (const label of ['red', 'yellow stripe', 'brown', 'pink', 'ball', '7'])
      for (const snk of [false, true]) {
        const t = tagText({ kind: 'object', label, id: 'x' }, snk);
        const chip = ballChip(label, undefined, false, snk);
        expect(chip.includes(`<i>${t}</i>`) || (!t && !chip.includes('<i>')), `${label} ${snk}`).toBe(true);
      }
  });
  it('the card and the suggestions list pass the table', () => {
    const plan = planShot(drill('cut30'), { targetId: 'b1', pocketId: 'TR' }, params);
    expect(cardHtml(plan, { targetLabel: 'red', snooker: false })).toContain('<i>3</i>');
    expect(cardHtml(plan, { targetLabel: 'red', snooker: true })).toContain('<i>R</i>');
    const el = stubEl();
    const state = { table: snooker, mode: 'practice', practice: { balls: [] }, suggestions: { pending: false, items: [{ targetId: 'b2', pocketId: 'TR', difficulty: 'easy', toleranceMm: 12 }] } } as unknown as AppState;
    renderSuggestions(el, state, () => 'blue', () => 'far right corner', () => {});
    expect(el.innerHTML).toContain('<i>Bl</i>');
    renderSuggestions(el, { ...state, table } as AppState, () => 'blue', () => 'far right corner', () => {});
    expect(el.innerHTML).toContain('<i>2</i>');
  });
});

describe('r1 peek: a frozen cut tile says "Frozen" and the stroke side even when the captions step aside', () => {
  it('the numeral row carries "Frozen" (sight only: the caption says it to screen readers) and the stroke side', () => {
    const p = planShot(frozenLayout('TR', { x: 0.87, y: 0.48 }, 8).lay, { targetId: 'b1', pocketId: 'TR' }, params);
    const html = cardHtml(p);
    const m = /<span class="fz-k" aria-hidden="true">Frozen<\/span><div class="v num" data-testid="cut">\d+°<\/div><span class="fz-side">([^<]+)<\/span>/.exec(html);
    expect(m, html).not.toBeNull();
    expect(m![1]).toMatch(/^stroke (left|right)$/);
    // (The ui.spec frozen layout: its line of centres points into the pocket, "stroke straight through it".)
    const straight = cardHtml(planShot(frozenLayout('TR', { x: 0.55, y: 0.18 }).lay, { targetId: 'b1', pocketId: 'TR' }, params));
    expect(straight).toContain('<span class="fz-side">straight</span>');
    // A plain cut has none.
    expect(cardHtml(sidePlan(0))).not.toMatch(/fz-k|fz-side/);
  });
});

describe('r1 Snap photo: a label on the photo even without a ghost ball', () => {
  const recGuide = (plan: ShotPlan, t: TableSpec, cue: Vec2, target: Vec2, makeable: boolean) => {
    const g = buildPlayerGuide({ pose: TOP, table: t, plan, cue, target, stroke: plan.stroke });
    const rec = recordingCanvas(1280, 720);
    rec.canvas.width = 1280;
    rec.canvas.height = 720;
    drawGuide(rec.canvas.getContext('2d')!, { toScreen: (p) => p, toFrame: (p) => p }, g, { showCuePath: true, makeable });
    return rec.texts.map((x) => x.text);
  };
  it('PlayerGuide.aimLabel: "Not makeable" at the cue ball for a frozen shot that cannot be played', () => {
    const { lay, cue, ob } = frozenLayout('TR', { x: 0.9, y: 0.45 }, 0, snooker, 'red');
    const p = planShot(lay, { targetId: 'b1', pocketId: 'TR' }, params);
    const g = buildPlayerGuide({ pose: TOP, table: snooker, plan: p, cue, target: ob, stroke: p.stroke });
    expect(g.ghost).toEqual([]);
    expect(g.aimLabel).toMatchObject({ text: 'Not makeable', warn: true });
    expect(Math.hypot(g.aimLabel!.at.x - g.cueCenter!.x, g.aimLabel!.at.y - g.cueCenter!.y)).toBeLessThan(1e-6);
    expect(g.aimLabel!.r).toBeCloseTo(g.cueRadiusPx, 6);
  });
  it("PlayerGuide.aimLabel: the frozen stroke in the 2D label's words, at the stroke line's end", () => {
    const { lay, cue, ob } = frozenLayout('TR', { x: 0.87, y: 0.48 }, 8);
    const p = planShot(lay, { targetId: 'b1', pocketId: 'TR' }, params);
    const g = buildPlayerGuide({ pose: TOP, table, plan: p, cue, target: ob, stroke: p.stroke });
    expect(g.aimLabel!.text).toBe(planLabel(p, cue));
    expect(g.aimLabel!.text).toMatch(/^Frozen · stroke \d+° (left|right)$/);
    expect(g.aimLabel!.warn).toBe(false);
    const end = aimLine(p, cue, R, { hx: table.length / 2, hy: table.width / 2 }).to;
    const want = projectPolyline(TOP, [
      { ...end, z: 0 },
      { x: end.x + 1e-4, y: end.y, z: 0 },
    ])[0]![0]!;
    expect(Math.hypot(g.aimLabel!.at.x - want.x, g.aimLabel!.at.y - want.y)).toBeLessThan(0.5);
    // A shot with a ghost ball keeps its label there (draw.ts: "Aim here"): no aimLabel.
    expect(buildPlayerGuide({ pose: TOP, table, plan: sidePlan(0), cue: squirtLay.balls[0]!.pos, target: { x: 0.6, y: 0.3 }, stroke: sidePlan(0).stroke }).aimLabel).toBeNull();
  });
  // (The drawGuide checks moved to 'r2 Snap photo' below: they now draw through real photo→canvas
  // mappings, so a recipe that leaves the anchor in photo px cannot pass them.)
  it('drawGuide (identity mapping) still labels a plain shot\'s ghost ball ("Aim here")', () => {
    const p = sidePlan(0);
    expect(recGuide(p, table, squirtLay.balls[0]!.pos, { x: 0.6, y: 0.3 }, true)).toContain('Aim here');
  });
});

describe('r2 Snap photo: the label without a ghost ball sits at its anchor on the CANVAS, not in photo px', () => {
  type Anchor = { x: number; y: number; r: number };
  type Mapping = { toScreen: (p: Vec2) => Vec2; toFrame: (p: Vec2) => Vec2; scale: number };
  /**
   * The photo→canvas mappings the app draws a 1280×720 photo with (snap/draw.ts PhotoCanvas: the
   * whole photo fitted, zoomed onto guideFocus, the strongest zoom onto the label's anchor `c`),
   * and the identity.
   */
  const mappingsFor = (g: PlayerGuide, c: Vec2 = g.aimLabel!.at): { name: string; W: number; H: number; m: Mapping }[] => {
    return [
      { name: 'identity 1280×720', W: 1280, H: 720, m: { toScreen: (p) => p, toFrame: (p) => p, scale: 1 } },
      { name: '1600×900, whole photo (×1.25)', W: 1600, H: 900, m: focusMapping(1280, 720, 1600, 900, null) },
      { name: '393×600, zoomed onto the shot', W: 393, H: 600, m: focusMapping(1280, 720, 393, 600, guideFocus(g, 1280, 720)) },
      { name: '1600×900, ×5 onto the anchor', W: 1600, H: 900, m: focusMapping(1280, 720, 1600, 900, { x0: c.x - 40, y0: c.y - 40, x1: c.x + 40, y1: c.y + 40 }) },
    ];
  };
  /** drawGuide on a recording canvas; `strikeNote` as the app passes it ("1/10 soft": power next to where to hit). */
  const drawOn = (g: PlayerGuide, W: number, H: number, m: Mapping, makeable: boolean, strikeNote?: string) => {
    const rec = recordingCanvas(W, H);
    rec.canvas.width = W;
    rec.canvas.height = H;
    drawGuide(rec.canvas.getContext('2d')!, m, g, { showCuePath: true, makeable, ...(strikeNote ? { strikeNote } : {}) });
    return rec;
  };
  /** The pill snap/draw.ts label() draws around a text: fillText at (x0 + 9, y0 + 13), 25 px high; the stub measures 7 px a glyph. */
  const pillOf = (t: TextRec) => ({ left: t.x - 9, top: t.y - 13, right: t.x - 9 + t.text.length * 7 + 18, bottom: t.y + 12 });
  const boxDist = (b: { left: number; top: number; right: number; bottom: number }, p: Vec2) => Math.hypot(Math.max(b.left - p.x, 0, p.x - b.right), Math.max(b.top - p.y, 0, p.y - b.bottom));
  /**
   * `text` is drawn next to the circle `a` the way placedLabel draws a label: the pill no more than
   * its 14 px gap (+6 px) outside the circle, and its one leader line ending on the circle's rim
   * (r + 2 from the centre), so both the centre and the radius must be canvas px. With the anchor
   * left in photo px the pill lands 100+ px away (verifier probe: 183–190 px off at ×1.25, pinned to
   * the right edge at 393 px wide).
   */
  function expectLabelAt(rec: ReturnType<typeof recordingCanvas>, text: string, a: Anchor, where: string): void {
    const t = rec.texts.find((x) => x.text === text);
    expect(t, `${where}: "${text}" is drawn`).toBeTruthy();
    const pill = pillOf(t!);
    expect(boxDist(pill, a), `${where}: the pill sits next to its anchor`).toBeLessThanOrEqual(a.r + 14 + 6);
    const leaders = rec.strokes.filter((s) => s.color === 'rgba(244,246,251,0.85)' && s.width === 1.25 && s.pts.length === 2 && boxDist(pill, s.pts[0]!) <= 3);
    expect(leaders.length, `${where}: one leader line from the pill`).toBe(1);
    const end = leaders[0]!.pts[1]!;
    expect(Math.hypot(end.x - a.x, end.y - a.y), `${where}: the leader ends on the anchor circle's rim`).toBeCloseTo(a.r + 2, 1);
  }
  /** Where the label of a plan with no ghost ball belongs on the canvas: its photo-px circle, mapped. */
  const wantAnchor = (g: PlayerGuide, m: Mapping): Anchor => ({ ...m.toScreen(g.aimLabel!.at), r: g.aimLabel!.r * m.scale });
  const touching = () => {
    const { lay, cue, ob } = frozenLayout('TR', { x: 0.9, y: 0.45 }, 0, snooker, 'red');
    const p = planShot(lay, { targetId: 'b1', pocketId: 'TR' }, params);
    return { p, g: buildPlayerGuide({ pose: TOP, table: snooker, plan: p, cue, target: ob, stroke: p.stroke }) };
  };
  const frozen8 = () => {
    const { lay, cue, ob } = frozenLayout('TR', { x: 0.87, y: 0.48 }, 8);
    const p = planShot(lay, { targetId: 'b1', pocketId: 'TR' }, params);
    return { p, g: buildPlayerGuide({ pose: TOP, table, plan: p, cue, target: ob, stroke: p.stroke }) };
  };

  it('aimLabelAnchor maps the photo-px circle through the canvas mapping: the centre by toScreen, the radius by its scale', () => {
    for (const { g } of [touching(), frozen8()]) {
      expect(g.ghost).toEqual([]);
      expect(g.aimLabel).not.toBeNull();
      for (const { name, m } of mappingsFor(g)) {
        const a = aimLabelAnchor(g.aimLabel!, m);
        const want = wantAnchor(g, m);
        expect(a.x, name).toBeCloseTo(want.x, 9);
        expect(a.y, name).toBeCloseTo(want.y, 9);
        expect(a.r, name).toBeCloseTo(want.r, 9);
        // Why it matters: off the identity, the photo-px point is nowhere near the canvas anchor.
        if (m.scale !== 1) expect(Math.hypot(g.aimLabel!.at.x - want.x, g.aimLabel!.at.y - want.y), name).toBeGreaterThan(100);
      }
    }
  });
  it('control: drawGuide places "Aim here" next to the ghost ball on the canvas under every mapping (the check is calibrated)', () => {
    const p = sidePlan(0);
    const g = buildPlayerGuide({ pose: TOP, table, plan: p, cue: squirtLay.balls[0]!.pos, target: { x: 0.6, y: 0.3 }, stroke: p.stroke });
    for (const { name, W, H, m } of mappingsFor(g, g.ghostCenter!)) {
      const pts = g.ghost.map((q) => m.toScreen(q));
      const c = { x: pts.reduce((s, q) => s + q.x, 0) / pts.length, y: pts.reduce((s, q) => s + q.y, 0) / pts.length };
      const r = pts.reduce((s, q) => s + Math.hypot(q.x - c.x, q.y - c.y), 0) / pts.length;
      expectLabelAt(drawOn(g, W, H, m, true), 'Aim here', { ...c, r }, name);
    }
  });
  // snap/draw.ts places PlayerGuide.aimLabel at aimLabelAnchor(g.aimLabel, m) and keeps it off the
  // strike label. A draw.ts that passes the photo-px `at`/`r` straight to placedLabel fails all three;
  // one that maps them but lets the label sit on the strike label fails the third.
  it('drawGuide writes "Not makeable" at the cue ball on the canvas for the snooker touching-ball plan', () => {
    const { p, g } = touching();
    expect(g.aimLabel!.text).toBe('Not makeable');
    for (const { name, W, H, m } of mappingsFor(g)) expectLabelAt(drawOn(g, W, H, m, playable(p)), 'Not makeable', wantAnchor(g, m), name);
  });
  it("drawGuide writes the frozen stroke's words at the stroke line's end on the canvas", () => {
    const { p, g } = frozen8();
    expect(g.aimLabel!.text).toMatch(/^Frozen · stroke \d+° (left|right)$/);
    for (const { name, W, H, m } of mappingsFor(g)) {
      const rec = drawOn(g, W, H, m, playable(p));
      expectLabelAt(rec, g.aimLabel!.text, wantAnchor(g, m), name);
      // The stroke's end is near the cue ball: its label must not sit on the strike label there.
      const aim = pillOf(rec.texts.find((x) => x.text === g.aimLabel!.text)!);
      const others = rec.texts.filter((x) => x.text !== g.aimLabel!.text);
      expect(others.some((x) => x.text.startsWith('Strike here')), `${name}: the strike label is drawn too`).toBe(true);
      for (const o of others) {
        const b = pillOf(o);
        const overlap = Math.min(aim.right, b.right) > Math.max(aim.left, b.left) && Math.min(aim.bottom, b.bottom) > Math.max(aim.top, b.top);
        expect(overlap, `${name}: "${g.aimLabel!.text}" is clear of "${o.text}"`).toBe(false);
      }
    }
  });

  // The committed Snap fixture's player photo (crouched 0.5 m behind the cue ball, 0.3 m up, aimed at
  // ball 1), with the cue ball frozen straight behind ball 1 toward the top-right corner, drawn as the
  // app draws it on a 412 × 523 phone canvas zoomed onto the shot: the stroke's end is right next to
  // the cue ball, so its label and the strike label compete for the same space.
  it("from the player's own viewpoint the frozen stroke's label stays clear of the strike label", () => {
    const fx = JSON.parse(readFileSync('tests/fixtures/snap-layout.json', 'utf8')) as { photos: { player: { pose: CameraPose } }; balls: { id: string; pos: Vec2 }[] };
    const pose = fx.photos.player.pose;
    const { lay, cue, ob } = frozenLayout('TR', fx.balls.find((b) => b.id === '1')!.pos);
    const p = planShot(lay, { targetId: 'b1', pocketId: 'TR' }, params);
    expect(playable(p)).toBe(true);
    const g = buildPlayerGuide({ pose, table, plan: p, cue, target: ob, stroke: p.stroke });
    expect(g.aimLabel!.text).toBe('Frozen · straight through');
    for (const [name, m, W, H] of [
      ['412×523 zoomed onto the shot', focusMapping(pose.width, pose.height, 412, 523, guideFocus(g, pose.width, pose.height)), 412, 523],
      ['412×523 whole photo', focusMapping(pose.width, pose.height, 412, 523, null), 412, 523],
      ['375×460 zoomed onto the shot', focusMapping(pose.width, pose.height, 375, 460, guideFocus(g, pose.width, pose.height)), 375, 460],
    ] as const) {
      const rec = drawOn(g, W, H, m, true, '1/10 soft');
      expectLabelAt(rec, g.aimLabel!.text, wantAnchor(g, m), name);
      const aim = pillOf(rec.texts.find((x) => x.text === g.aimLabel!.text)!);
      const strike = rec.texts.find((x) => x.text.startsWith('Strike here'));
      expect(strike, `${name}: the strike label is drawn`).toBeTruthy();
      const b = pillOf(strike!);
      const ov = { x: Math.min(aim.right, b.right) - Math.max(aim.left, b.left), y: Math.min(aim.bottom, b.bottom) - Math.max(aim.top, b.top) };
      expect(ov.x > 0 && ov.y > 0, `${name}: "${g.aimLabel!.text}" overlaps "${strike!.text}" by ${ov.x.toFixed(1)} × ${ov.y.toFixed(1)} px`).toBe(false);
    }
  });

  // A camera that sees only the middle 1.28 × 0.72 m of the table (f = 3000 px from 3 m).
  const NARROW: CameraPose = { ...TOP, f: 3000 };
  it('no label anchored off the photo: with the cue ball out of the photo a not-makeable plan has no aimLabel', () => {
    const { lay, cue, ob } = frozenLayout('TR', { x: 0.9, y: 0.45 }, 0, snooker, 'red');
    const p = planShot(lay, { targetId: 'b1', pocketId: 'TR' }, params);
    const g = buildPlayerGuide({ pose: NARROW, table: snooker, plan: p, cue, target: ob, stroke: p.stroke });
    expect(g.inFrame.cue).toBe(false);
    expect(g.aimLabel).toBeNull();
  });
  it("the stroke line's end off the photo: the frozen label anchors on the cue ball instead", () => {
    const { lay, cue, ob } = frozenLayout('TR', { x: 0.55, y: 0.2 });
    const p = planShot(lay, { targetId: 'b1', pocketId: 'TR' }, params);
    expect(playable(p)).toBe(true);
    const g = buildPlayerGuide({ pose: NARROW, table, plan: p, cue, target: ob, stroke: p.stroke });
    const end = aimLine(p, cue, R, { hx: table.length / 2, hy: table.width / 2 }).to;
    const endPx = projectPolyline(NARROW, [
      { ...end, z: 0 },
      { x: end.x + 1e-4, y: end.y, z: 0 },
    ])[0]?.[0];
    expect(endPx === undefined || !inImage(NARROW, endPx)).toBe(true);
    expect(inImage(NARROW, g.cueCenter!)).toBe(true);
    expect(g.aimLabel).toMatchObject({ text: planLabel(p, cue), warn: false });
    expect(Math.hypot(g.aimLabel!.at.x - g.cueCenter!.x, g.aimLabel!.at.y - g.cueCenter!.y)).toBeLessThan(1e-6);
    expect(g.aimLabel!.r).toBeCloseTo(g.cueRadiusPx, 6);
  });
});

describe('r1 3D frame: the ghost-ball sphere (FrameState.ghost) comes from frameGhost', () => {
  it("null for a frozen cue ball, the plan's ghost otherwise, null with the plan hidden", () => {
    const { lay, cue } = frozenLayout('TR', { x: 0.87, y: 0.48 });
    const frozen = planShot(lay, { targetId: 'b1', pocketId: 'TR' }, params);
    expect(frameGhost(frozen, cue, true)).toBeNull();
    const p = sidePlan(0);
    expect(frameGhost(p, squirtLay.balls[0]!.pos, true)).toEqual(p.ghost);
    expect(frameGhost(p, squirtLay.balls[0]!.pos, false)).toBeNull();
    expect(frameGhost(p, null, true)).toBeNull();
    expect(frameGhost(null, squirtLay.balls[0]!.pos, true)).toBeNull();
  });
  // createTable3D needs WebGL2 (no Node test can run it): the frame it draws must take its ghost ball
  // from frameGhost, never straight from plan.ghost (a sphere on top of a frozen cue ball).
  it('render3d/index.ts sets FrameState.ghost through frameGhost', () => {
    const src = readFileSync(new URL('../../../src/app/render3d/index.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/^\s*ghost: frameGhost\(plan(?: \?\? null)?, cueBall\?\.pos \?\? null, showPlan\),$/m);
    expect(src).not.toMatch(/ghost:[^\n]*plan\.ghost/);
  });
});

describe('r1 meter options: one helper for the card and the Snap HUD', () => {
  it('a plain plan: the capture band; frozen: no band and "no power" past 10; noWorkingPower counts too', () => {
    const plan = planShot(drill('cut30'), { targetId: 'b1', pocketId: 'TR', stroke: { power: 4, side: 0, vert: 0 } }, params);
    expect(meterOptions(plan)).toEqual({ frozen: false, capture: plan.minPowerCapture });
    const fz = planShot(frozenLayout('TR', { x: 0.87, y: 0.48 }).lay, { targetId: 'b1', pocketId: 'TR' }, params);
    expect(meterOptions(fz)).toEqual({ frozen: true });
    // The live-snap core adds ShotPlan.noWorkingPower: no power works, whatever the cause.
    const none = { ...plan, minPower: 10.5, noWorkingPower: 'other' as const };
    expect(meterOptions(none)).toEqual({ frozen: true });
    expect(powerText(3, meterMinPower(none), meterOptions(none))).toMatch(/No power gets it in with pace/);
    expect(powerText(3, meterMinPower(none), meterOptions(none))).not.toMatch(/more than full power/);
    expect(meterMinPower(none)).toBe(10.5);
    // The frozen power advice not worked out yet (live-snap's adviceSkipped): no minimum to show.
    expect(meterMinPower({ ...plan, adviceSkipped: true })).toBeNull();
    expect(meterMinPower({ ...plan, minPower: Number.NaN })).toBeNull();
    expect(meterMinPower(plan)).toBe(plan.minPower);
  });
});

describe('r1 power slider: never waits on a slow frame', () => {
  it('perFrame runs on the next frame or after PER_FRAME_MAX_MS, whichever comes first, once; pending() says a value waits', () => {
    const got: number[] = [];
    let frame: (() => void) | null = null;
    let timer: (() => void) | null = null;
    let ms = -1;
    const f = perFrame(
      (v: number) => got.push(v),
      (c) => {
        frame = c;
      },
      (c, t) => {
        timer = c;
        ms = t;
      },
    );
    expect(f.pending()).toBe(false);
    f.push(3);
    f.push(3.5);
    expect(f.pending()).toBe(true);
    expect(ms).toBe(PER_FRAME_MAX_MS);
    expect(PER_FRAME_MAX_MS).toBeLessThanOrEqual(50);
    timer!();
    expect(got).toEqual([3.5]);
    expect(f.pending()).toBe(false);
    frame!(); // the frame comes later: nothing more
    expect(got).toEqual([3.5]);
    f.push(4);
    frame!();
    timer!();
    expect(got).toEqual([3.5, 4]);
  });
});
