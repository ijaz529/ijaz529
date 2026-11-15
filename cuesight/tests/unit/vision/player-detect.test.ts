/**
 * Player-photo detection (spec 002 R-24, task T133): cloth candidates of a table-level photo (any
 * colour, grey included), the cloth predicate, and ball circles on touching blobs and large blobs.
 */
import { describe, expect, it } from 'vitest';
import { makeTable } from '../../../src/core/table';
import { createFrame, rgbToHsv, type Frame } from '../../../src/vision/image';
import { buildEvidence, clothNoise, clothTest, findCandidates, getScratch, learnPlayerCloth, type Candidate } from '../../../src/vision/player-detect';
import { fixtureBalls, playerViewCamera, renderSyntheticTable, type RGB } from '../../../src/vision/synth/render';
import { isCloth, type ClothModel } from '../../../src/vision/table-detect';

const W = 480;
const H = 360;

/** Flat frame painted by `paint(x, y) → RGB` with a little deterministic noise. */
function paint(w: number, h: number, fn: (x: number, y: number) => RGB): Frame {
  const f = createFrame(w, h);
  let s = 99;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const c = fn(x + 0.5, y + 0.5);
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      const n = ((s >>> 24) % 5) - 2;
      const i = (y * w + x) * 4;
      f.data[i] = c[0] + n;
      f.data[i + 1] = c[1] + n;
      f.data[i + 2] = c[2] + n;
      f.data[i + 3] = 255;
    }
  return f;
}

const GREEN: RGB = [40, 130, 70];
const GREEN_MODEL: ClothModel = { hue: 140, sat: 0.69, val: 0.51, kind: 'chromatic' };

function circlesOf(frame: Frame, cloth: ClothModel) {
  const sc = getScratch(frame.width, frame.height);
  const ev = buildEvidence(frame, cloth, sc);
  return findCandidates(frame, sc, ev.comps, ev.nCracks);
}

const near = (cs: Candidate[], x: number, y: number, r: number) => cs.find((c) => Math.hypot(c.u - x, c.v - y) < Math.max(1.5, 0.08 * r) && Math.abs(c.r - r) < Math.max(1.2, 0.08 * r));

describe('clothTest', () => {
  it('is table-detect isCloth on 0..255 RGB, for chromatic and neutral models', () => {
    const models: ClothModel[] = [GREEN_MODEL, { hue: 215, sat: 0.6, val: 0.4, kind: 'chromatic' }, { hue: 0, sat: 0.11, val: 0.47, kind: 'neutral' }, { hue: 0, sat: 0.03, val: 0.6, kind: 'neutral' }];
    const hsv = [0, 0, 0];
    let s = 3;
    for (let k = 0; k < 4000; k++) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      const r = s & 255;
      const g = (s >>> 8) & 255;
      const b = (s >>> 16) & 255;
      rgbToHsv(r, g, b, hsv);
      for (const m of models) expect(clothTest(r, g, b, m), `${r},${g},${b} vs ${JSON.stringify(m)}`).toBe(isCloth(hsv[0]!, hsv[1]!, hsv[2]!, m));
    }
  });
});

describe('learnPlayerCloth', () => {
  const table = makeTable('pool9');
  const balls = fixtureBalls(table).balls;
  const shot = (o: { h: number; d: number; fov: number }, cloth?: RGB, floor?: RGB) =>
    renderSyntheticTable({
      table,
      balls,
      camera: playerViewCamera({ cue: balls[0]!.pos, aimAt: balls[1]!.pos, distance: o.d, height: o.h, fovDeg: o.fov, imageWidth: W, imageHeight: H, ballRadius: table.ballRadius }),
      width: W,
      height: H,
      ss: 1,
      ...(cloth ? { cloth } : {}),
      ...(floor ? { floor } : {}),
    });

  it('finds the green cloth even when the near rail fills the bottom of the photo (8 cm up, 1.2 m back)', () => {
    const f = shot({ h: 0.08, d: 1.2, fov: 40 });
    const pc = learnPlayerCloth(f, null, getScratch(W, H));
    expect(pc.models[0]?.kind).toBe('chromatic');
    expect(Math.abs(pc.models[0]!.hue - 140)).toBeLessThan(8);
    // The rail (hue ≈ 22°) is a candidate too, ranked below: its band holds no balls.
    expect(pc.models.some((m) => m.kind === 'chromatic' && Math.abs(m.hue - 22) < 10)).toBe(true);
  });

  it('reads a grey cloth as a neutral model, with or without a grey floor or a red one', () => {
    for (const floor of [undefined, [170, 40, 35] as RGB]) {
      const f = shot({ h: 0.3, d: 0.5, fov: 65 }, [110, 116, 124], floor);
      const pc = learnPlayerCloth(f, null, getScratch(W, H));
      expect(pc.models[0]?.kind).toBe('neutral');
      expect(pc.models[0]!.val).toBeGreaterThan(0.3);
      expect(pc.models[0]!.val).toBeLessThan(0.55);
      expect(pc.enclosed[0]).toBeGreaterThan(2);
    }
  });

  it('prefers a charcoal cloth\'s own model to a wider grey band that also swallows the room and the floor', () => {
    // The floor (70, 70, 75) gives an untinted grey mode whose value band also holds the charcoal cloth
    // and the dark room: one huge region, its holes the balls and hundreds of specks of brighter cloth.
    for (const o of [
      { h: 0.2, d: 0.75, fov: 40 },
      { h: 0.2, d: 0.3, fov: 65 },
    ]) {
      const pc = learnPlayerCloth(shot(o, [80, 86, 92]), null, getScratch(W, H));
      expect(pc.models[0]?.kind).toBe('neutral');
      expect(pc.models[0]!.sat, JSON.stringify(pc.models)).toBeGreaterThan(0.1); // the cloth's tint, not the floor's
    }
  });

  it('promotes the overview cloth only when this photo shows a plausible region of that colour', () => {
    const neutral: ClothModel = { hue: 0, sat: 0.06, val: 0.3, kind: 'neutral' };
    // Green cloth, grey floor: a neutral hint must not put the floor first.
    const g = learnPlayerCloth(shot({ h: 0.3, d: 0.5, fov: 65 }), neutral, getScratch(W, H));
    expect(g.models[0]?.kind).toBe('chromatic');
    // Grey cloth: the neutral hint agrees.
    const n = learnPlayerCloth(shot({ h: 0.3, d: 0.5, fov: 65 }, [110, 116, 124]), neutral, getScratch(W, H));
    expect(n.models[0]?.kind).toBe('neutral');
  });

  it('has no candidate in a black frame, and only hole-free surfaces in a plain wall', () => {
    const dark = learnPlayerCloth(createFrame(W, H), null, getScratch(W, H));
    expect(dark.models).toHaveLength(0);
    expect(dark.meanV).toBe(0);
    const wall = learnPlayerCloth(
      paint(W, H, () => [150, 120, 90]),
      null,
      getScratch(W, H),
    );
    expect(wall.enclosed.every((n) => n === 0)).toBe(true);
  });
});

describe('findCandidates', () => {
  it('splits two touching balls into their own circles (no huge circle through both arcs)', () => {
    // A white ball partly in front of a purple one, on green.
    const f = paint(W, H, (x, y) => {
      if (Math.hypot(x - 220, y - 200) < 40) return [235, 235, 228];
      if (Math.hypot(x - 175, y - 165) < 28) return [90, 30, 130];
      return GREEN;
    });
    const cs = circlesOf(f, GREEN_MODEL);
    expect(near(cs, 220, 200, 40), JSON.stringify(cs.map((c) => [c.u, c.v, c.r]))).toBeDefined();
    expect(near(cs, 175, 165, 28)).toBeDefined();
    for (const c of cs) expect(c.r).toBeLessThan(45);
  });

  it('finds small and large balls whose blobs merge into a large non-cloth region (rail band, room)', () => {
    // Room above y = 120, then cloth; a far ball (r 6) and the near cue ball (r 70, partly behind a
    // purple ball that reaches the room) touch the room from the cloth side.
    const f = paint(W, H, (x, y) => {
      if (Math.hypot(x - 300, y - 250) < 70) return [235, 235, 228];
      if (Math.hypot(x - 250, y - 160) < 45) return [90, 30, 130];
      if (Math.hypot(x - 100, y - 124) < 6) return [200, 25, 30];
      if (y < 120) return [30, 30, 34];
      return GREEN;
    });
    const cs = circlesOf(f, GREEN_MODEL);
    const dump = JSON.stringify(cs.map((c) => [Math.round(c.u), Math.round(c.v), Math.round(c.r)]));
    expect(near(cs, 300, 250, 70), dump).toBeDefined();
    expect(near(cs, 100, 124, 6), dump).toBeDefined();
    const cue = near(cs, 300, 250, 70)!;
    expect(cue.white).toBeGreaterThan(0.15);
  });
});

/** Flat green cloth with Gaussian sensor noise σ (deterministic). */
function noisyCloth(w: number, h: number, sigma: number, seed = 7): Frame {
  const f = createFrame(w, h);
  let s = seed;
  const gauss = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const u = (s + 1) / 4294967297;
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return Math.sqrt(-2 * Math.log(u)) * Math.cos((2 * Math.PI * s) / 4294967296);
  };
  for (let i = 0; i < w * h; i++) {
    for (let c = 0; c < 3; c++) f.data[i * 4 + c] = GREEN[c]! + sigma * gauss();
    f.data[i * 4 + 3] = 255;
  }
  return f;
}

/** A shaded ball: lit from the upper left (V from 1 down to `shade` of `rgb`). */
const shaded = (rgb: RGB, cx: number, cy: number, r: number, x: number, y: number, shade = 0.45): RGB => {
  const k = shade + (1 - shade) * Math.max(0, Math.min(1, 0.5 - (0.5 * (x - cx + (y - cy))) / (1.4 * r)));
  return [rgb[0] * k, rgb[1] * k, rgb[2] * k];
};

describe('findCandidates colour and exposure', () => {
  it('reads the cue ball as white when a nearer red ball covers part of it, or when no circle was found for that ball', () => {
    // The red ball (r 40) is in front of the cue ball (r 30): their pixels form one blob. The overlap is
    // the red ball's surface; the cue ball's colour comes from its own pixels.
    const f = paint(W, H, (x, y) => {
      if (Math.hypot(x - 250, y - 210) < 40) return [200, 25, 30];
      if (Math.hypot(x - 200, y - 180) < 30) return [240, 240, 232];
      return GREEN;
    });
    const cs = circlesOf(f, GREEN_MODEL);
    const cue = near(cs, 200, 180, 30);
    expect(cue, JSON.stringify(cs.map((c) => [Math.round(c.u), Math.round(c.v), Math.round(c.r)]))).toBeDefined();
    expect(cue!.col.satFrac).toBeLessThan(0.1);
    expect(cue!.col.whiteFrac).toBeGreaterThan(0.8);
    expect(cue!.white).toBeGreaterThan(0.15);
  });

  it('takes the exposure from the brightest ball, not the cloth: a light cloth is not over-exposed', () => {
    const LIGHT: RGB = [70, 140, 200];
    const model: ClothModel = { hue: 207, sat: 0.65, val: 0.78, kind: 'chromatic' };
    const scene = (gain: number) =>
      paint(W, H, (x, y) => {
        const c: RGB = Math.hypot(x - 240, y - 200) < 36 ? shaded([245, 245, 238], 240, 200, 36, x, y) : Math.hypot(x - 120, y - 150) < 20 ? shaded([200, 25, 30], 120, 150, 20, x, y) : LIGHT;
        return [c[0] * gain, c[1] * gain, c[2] * gain];
      });
    const exposure = (gain: number) => {
      const f = scene(gain);
      const sc = getScratch(W, H);
      const ev = buildEvidence(f, { ...model, val: model.val * gain }, sc);
      const info = { exposure: 0 };
      const cs = findCandidates(f, sc, ev.comps, ev.nCracks, { info });
      return { e: info.exposure, cue: near(cs, 240, 200, 36) };
    };
    const nominal = exposure(1);
    // Nominal (≈ 1) and never above, however bright the cloth: the light cloth does not raise it.
    expect(nominal.e).toBeGreaterThan(0.95);
    expect(nominal.e).toBeLessThanOrEqual(1);
    expect(nominal.cue!.white).toBeGreaterThan(0.15); // the shaded side is still white
    const under = exposure(0.6);
    expect(under.e).toBeGreaterThan(0.5);
    expect(under.e).toBeLessThan(0.75);
    expect(under.cue!.white).toBeGreaterThan(0.15);
  });
});

describe('sensor noise', () => {
  it('buildEvidence drops noise speckle inside the cloth (no cracks, no circles from it)', () => {
    const f = noisyCloth(W, H, 14);
    const sc = getScratch(W, H);
    const ev = buildEvidence(f, GREEN_MODEL, sc);
    expect(ev.mainArea).toBeGreaterThan(0.98 * W * H);
    expect(ev.nCracks).toBeLessThan(0.005 * W * H);
    expect(findCandidates(f, sc, ev.comps, ev.nCracks)).toHaveLength(0);
  });

  it('clothNoise reads the sensor σ off the cloth (smooth cloth ≈ 0)', () => {
    for (const sigma of [0, 3, 6, 10]) {
      const f = noisyCloth(W, H, sigma, 11 + sigma);
      const sc = getScratch(W, H);
      buildEvidence(f, GREEN_MODEL, sc);
      const est = clothNoise(f, sc);
      expect(est, `σ ${sigma}`).toBeGreaterThan(0.75 * sigma - 0.01);
      expect(est, `σ ${sigma}`).toBeLessThan(1.2 * sigma + 0.8);
    }
  });
});
