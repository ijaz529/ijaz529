/**
 * Wave 2b integration: a frozen cue ball's stroke is worded by five readers from two packages —
 * the core's 'frozen' warning (card chip, announcer), the card's cut tile and the 2D / photo label
 * (plan-ui: render/plan-draw.ts frozenStroke), and the Snap HUD aim line (live-snap:
 * snap/session.ts snapAimText). They must give the same degrees and the same side for every layout
 * (Principle VI: no contradictions between card, HUD, voice and labels).
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, physicsFor } from '../../../src/app/settings';
import { frozenStroke, planLabel } from '../../../src/app/render/plan-draw';
import { snapAimText } from '../../../src/app/snap/session';
import { renderShotCard, type CardContext } from '../../../src/app/ui/shot-card';
import { planShot } from '../../../src/core/shot/planner';
import { makeTable } from '../../../src/core/table';
import type { Ball, PocketId, ShotPlan, Stroke, TableSpec, Vec2 } from '../../../src/core/types';

const params = physicsFor(DEFAULT_SETTINGS);
const ctx: CardContext = { targetLabel: '1', pocketName: 'far right corner', status: null, recommendedPending: false, showDetails: false, hint: '' };
function cardHtml(plan: ShotPlan): string {
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
  renderShotCard(el as unknown as HTMLElement, plan, ctx);
  return html;
}

type Words = { deg: number; side: 'left' | 'right' | 'straight' };
const fromWarning = (plan: ShotPlan): Words | null => {
  const w = plan.warnings.find((x) => x.code === 'frozen')?.message ?? '';
  const m = /stroke (\d+)° to the (left|right) of it/.exec(w);
  if (m) return { deg: Number(m[1]), side: m[2] as 'left' | 'right' };
  return /stroke straight through it/.test(w) ? { deg: 0, side: 'straight' } : null;
};
const fromLabel = (text: string): Words | null => {
  const m = /^Frozen · (?:stroke (\d+)° (left|right)|straight through)$/.exec(text);
  return m ? (m[1] ? { deg: Number(m[1]), side: m[2] as 'left' | 'right' } : { deg: 0, side: 'straight' }) : null;
};
const fromHud = (text: string): Words | null => {
  const m = /^Frozen: stroke (?:(\d+)° to the (left|right) of|straight through) the line of centres$/.exec(text);
  return m ? (m[1] ? { deg: Number(m[1]), side: m[2] as 'left' | 'right' } : { deg: 0, side: 'straight' }) : null;
};
const fromTile = (html: string): Words | null => {
  // The cut tile of a frozen plan: "N°" in the number row and "stroke left/right" or "straight".
  const v = /data-testid="cut">(\d+)°</.exec(html);
  const s = /<span class="fz-side">(stroke left|stroke right|straight)<\/span>/.exec(html);
  if (!v || !s) return null;
  return s[1] === 'straight' ? { deg: Number(v[1]), side: 'straight' } : { deg: Number(v[1]), side: s[1] === 'stroke left' ? 'left' : 'right' };
};

describe('frozen cue ball: one stroke angle and side on the card, the labels, the Snap HUD and the voice', () => {
  const cases: { t: TableSpec; ob: Vec2; stroke: Stroke }[] = [];
  for (const id of ['pool9', 'snooker12'] as const) {
    const t = makeTable(id);
    for (const ob of [
      { x: 0.55, y: 0.25 },
      { x: -0.3, y: -0.2 },
    ])
      for (const stroke of [
        { power: 4, side: 0, vert: 0 },
        { power: 2, side: 0, vert: -0.3 },
      ])
        cases.push({ t, ob, stroke });
  }

  it('the same degrees and side from all four readers, all round the object ball and near each pocket line', () => {
    let compared = 0;
    const sides = new Set<string>();
    const check = (t: TableSpec, ob: Vec2, a: number, stroke: Stroke, pocketId: PocketId | undefined, where: string) => {
      const d = 2 * t.ballRadius + 0.0003;
      const cue = { x: ob.x - d * Math.cos(a), y: ob.y - d * Math.sin(a) };
      const balls: Ball[] = [
        { id: 'cue', kind: 'cue', pos: cue, label: 'cue' },
        { id: 'b1', kind: 'object', pos: ob, label: t.id === 'snooker12' ? 'black' : '1' },
      ];
      const plan = planShot({ table: t, balls, source: 'virtual', frozen: false }, { targetId: 'b1', ...(pocketId ? { pocketId } : {}), stroke }, params);
      const core = fromWarning(plan);
      if (!plan.makeable || !core) return;
      expect(frozenStroke(plan, cue), where).toEqual(core);
      expect(fromLabel(planLabel(plan, cue)), where).toEqual(core);
      expect(fromHud(snapAimText(plan, cue, ob)), where).toEqual(core);
      expect(fromTile(cardHtml(plan)), where).toEqual(core);
      sides.add(core.side);
      compared++;
    };
    for (const { t, ob, stroke } of cases) {
      // The cue ball all round the object ball, the planner picking the pocket.
      for (let k = 0; k < 72; k++) check(t, ob, (k / 72) * 2 * Math.PI, stroke, undefined, `${t.id} ob ${ob.x},${ob.y} k ${k} ${JSON.stringify(stroke)}`);
      // Lines of centres at and near each pocket: straight through, and small strokes either way.
      for (const pk of t.pockets)
        for (const off of [-12, -3, -0.3, 0, 0.3, 3, 12]) {
          const a = Math.atan2(pk.mouthCenter.y - ob.y, pk.mouthCenter.x - ob.x) + (off * Math.PI) / 180;
          check(t, ob, a, stroke, pk.id, `${t.id} ob ${ob.x},${ob.y} ${pk.id} off ${off}° ${JSON.stringify(stroke)}`);
        }
    }
    // Enough makeable frozen plans, with strokes both ways and straight through among them.
    expect(compared).toBeGreaterThan(150);
    expect([...sides].sort()).toEqual(['left', 'right', 'straight']);
  });
});
