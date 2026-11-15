/**
 * Package "plan-ui" (wave 2b): every place that draws or words a plan reads the merged core data
 * the same way — the cue stick along ShotPlan.cueDir (cueAimDir is the same vector), a faint labelled
 * stick line for side spin, the frozen-cue-ball conventions (no ghost ball, the stroke line from the
 * cue ball), the corner hanger's own object-ball path, the power meter's "only just drops" band and
 * frozen "no power" case, the headline warnings, the eighth-fraction labels, the snooker push-stroke
 * reason, the recommendation's honesty notes and the ball letters/colours for the new vision names.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DRILLS } from '../../../src/app/drills';
import { planSentence } from '../../../src/app/announce';
import { DEFAULT_SETTINGS, physicsFor } from '../../../src/app/settings';
import { Overlay, type OverlayData } from '../../../src/app/render/overlay';
import { DASH, PALETTE, ballCss } from '../../../src/app/render/palette';
import { aimLine, isFrozenPlan, planLabel, stickDir, stickLine } from '../../../src/app/render/plan-draw';
import { TableView } from '../../../src/app/render/table-view';
import { tableGeom } from '../../../src/app/render3d/geom';
import { ballLook, cueAim, cuePose, parseColor, planRibbons, srgbToLinear } from '../../../src/app/render3d/scene-data';
import { aimHudText, buildPlayerGuide, projectPolyline, unplayableHeadline } from '../../../src/app/snap/guide';
import type { AppState } from '../../../src/app/store';
import { tagText } from '../../../src/app/ui/ball-tags';
import { perFrame } from '../../../src/app/ui/controls';
import { powerMeterSvg, powerText } from '../../../src/app/ui/power-meter';
import { planLabelContent } from '../../../src/app/ui/scene-labels';
import { ballChip, fractionTile, headlineWarning, recommendationContext, renderShotCard, type CardContext } from '../../../src/app/ui/shot-card';
import { DEFAULT_PHYSICS } from '../../../src/core/physics/params';
import { fractionOf } from '../../../src/core/shot/geometry';
import { planShot } from '../../../src/core/shot/planner';
import { makeTable } from '../../../src/core/table';
import type { Ball, PocketId, ShotPlan, Stroke, TableLayout, TableSpec, Vec2 } from '../../../src/core/types';
import { strikePoint, type CameraPose } from '../../../src/vision/player-view';
import { polyLength, recordingCanvas, sameDash, stubDocument } from './helpers/rec-canvas';

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

  it('words: the card, the announcer and the Snap HUD say "frozen", never "0° cut, full-ball"', () => {
    const html = cardHtml(plan);
    expect(html).toContain('Frozen');
    expect(html).not.toMatch(/full(-|‑)?ball hit|full hit/);
    const s = planSentence(plan, { TR: 'far right corner' }, () => '1');
    expect(s).toMatch(/frozen/i);
    expect(s).not.toMatch(/cut 0 degrees|full-ball/);
    expect(aimHudText(plan)).toMatch(/^Frozen/);
    expect(aimHudText(plan)).not.toMatch(/ghost ball ·|0° cut/);
    expect(aimHudText(sidePlan(0))).toMatch(/^Aim at the ghost ball · \d+° cut, /);
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
