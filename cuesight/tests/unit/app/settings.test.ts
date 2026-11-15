/**
 * Player settings (package "ui"): what is read back from storage and from the settings form is
 * validated field by field, so a bad value (an emptied number field saved as 0 → FOV 0 → no balls
 * found; a stale or hand-edited store) never reaches the planner or the vision pipeline. The physics
 * presets stay inside the ranges params.ts cites.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as settings from '../../../src/app/settings';
import { DEFAULT_SETTINGS, loadSettings, physicsFor, saveSettings, type Settings } from '../../../src/app/settings';

type Store = { getItem(k: string): string | null; setItem(k: string, v: string): void };
const g = globalThis as unknown as { localStorage?: Store };
function stubStorage(init: Record<string, string> = {}): Record<string, string> {
  const data = { ...init };
  g.localStorage = { getItem: (k) => (k in data ? data[k]! : null), setItem: (k, v) => void (data[k] = v) };
  return data;
}
afterEach(() => {
  delete g.localStorage;
});

const KEY = 'cuesight.settings.v1';
/** A FormData-like source (the dialog's form): every field is a string, a checkbox is 'on' or absent. */
const form = (o: Record<string, string>) => ({ get: (k: string) => (k in o ? o[k]! : null) });
const formOf = (s: Settings, over: Record<string, string | null> = {}) => {
  const o: Record<string, string> = {
    table: s.table,
    cloth: s.cloth,
    cushions: s.cushions,
    shaft: s.shaft,
    cushionWidthCm: String(s.cushionWidthCm),
    fovDeg: String(s.fovDeg),
    ...(s.showDetails ? { showDetails: 'on' } : {}),
    ...(s.table3d ? { table3d: 'on' } : {}),
  };
  for (const [k, v] of Object.entries(over)) {
    if (v === null) delete o[k];
    else o[k] = v;
  }
  return form(o);
};

describe('loadSettings validates what it reads back', () => {
  it('heals a stored FOV of 0, a non-numeric cushion width and an unknown table to the defaults', () => {
    stubStorage({ [KEY]: JSON.stringify({ fovDeg: 0, cushionWidthCm: 'x', table: 'bogus', cloth: 'fast' }) });
    const s = loadSettings();
    expect(s.fovDeg).toBe(DEFAULT_SETTINGS.fovDeg);
    expect(s.cushionWidthCm).toBe(DEFAULT_SETTINGS.cushionWidthCm);
    expect(s.table).toBe(DEFAULT_SETTINGS.table);
    // Valid fields are kept.
    expect(s.cloth).toBe('fast');
  });
  it('rejects out-of-range numbers, unknown enum values and non-boolean switches field by field', () => {
    stubStorage({
      [KEY]: JSON.stringify({ fovDeg: 500, cushionWidthCm: 1, cushions: 'bouncy', shaft: 'carbon', showDetails: 'yes', table3d: false, table: 'snooker12' }),
    });
    const s = loadSettings();
    expect(s).toEqual({ ...DEFAULT_SETTINGS, table: 'snooker12', table3d: false });
  });
  it('falls back to the defaults for a corrupt or non-object store, and round-trips a valid one', () => {
    for (const raw of ['{', 'null', '[1,2]', '"x"', '42']) {
      stubStorage({ [KEY]: raw });
      expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
    }
    const data = stubStorage();
    const mine: Settings = { ...DEFAULT_SETTINGS, table: 'pool8', cushionWidthCm: 6, fovDeg: 72, showDetails: true };
    saveSettings(mine);
    expect(JSON.parse(data[KEY]!)).toEqual(mine);
    expect(loadSettings()).toEqual(mine);
  });
  it('uses the defaults when storage is unavailable', () => {
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });
});

describe('parseSettingsForm (the settings dialog on Save)', () => {
  const parse = (settings as unknown as { parseSettingsForm?: (fd: { get(k: string): string | null }, cur: Settings) => Settings }).parseSettingsForm;
  const current: Settings = { ...DEFAULT_SETTINGS, fovDeg: 70, cushionWidthCm: 4.5 };

  it('exists', () => {
    expect(typeof parse).toBe('function');
  });
  it('keeps the current value for an emptied or invalid number field (never saves 0)', () => {
    expect(parse!(formOf(current, { fovDeg: '' }), current).fovDeg).toBe(70);
    expect(parse!(formOf(current, { fovDeg: null }), current).fovDeg).toBe(70);
    expect(parse!(formOf(current, { cushionWidthCm: '' }), current).cushionWidthCm).toBe(4.5);
    expect(parse!(formOf(current, { cushionWidthCm: 'abc' }), current).cushionWidthCm).toBe(4.5);
    // Out of the field's range (the input's min/max): rejected, not clamped to a surprising value.
    expect(parse!(formOf(current, { fovDeg: '0' }), current).fovDeg).toBe(70);
    expect(parse!(formOf(current, { fovDeg: '111' }), current).fovDeg).toBe(70);
    expect(parse!(formOf(current, { cushionWidthCm: '11' }), current).cushionWidthCm).toBe(4.5);
  });
  it('accepts valid values: 6 cm cushions, FOV 40…110, every select and both switches', () => {
    const s = parse!(formOf(current, { cushionWidthCm: '6', fovDeg: '40', table: 'snooker12', cloth: 'slow', cushions: 'dead', shaft: 'low-deflection', showDetails: 'on', table3d: null }), current);
    expect(s).toEqual({ table: 'snooker12', cloth: 'slow', cushions: 'dead', shaft: 'low-deflection', cushionWidthCm: 6, fovDeg: 40, showDetails: true, table3d: false });
    expect(parse!(formOf(current, { fovDeg: '110' }), current).fovDeg).toBe(110);
  });
  it('keeps the current choice for an unknown select value', () => {
    expect(parse!(formOf(current, { table: 'bogus', cloth: '' }), current)).toEqual(current);
  });
  it('limits match the inputs the dialog draws', () => {
    const limits = (settings as unknown as { SETTING_LIMITS?: Record<string, { min: number; max: number }> }).SETTING_LIMITS;
    expect(limits).toEqual({ cushionWidthCm: { min: 2, max: 10, step: 0.5 }, fovDeg: { min: 40, max: 110, step: 1 } });
  });
});

describe('physics presets stay inside the ranges params.ts cites', () => {
  const all = (['fast', 'normal', 'slow'] as const).flatMap((cloth) =>
    (['dead', 'normal', 'lively'] as const).flatMap((cushions) => (['standard', 'low-deflection'] as const).map((shaft) => physicsFor({ ...DEFAULT_SETTINGS, cloth, cushions, shaft }))),
  );
  it('rolling resistance 0.005…0.015 [A][P] and cushion restitution e0 0.75…0.9', () => {
    for (const p of all) {
      expect(p.muRoll).toBeGreaterThanOrEqual(0.005);
      expect(p.muRoll).toBeLessThanOrEqual(0.015);
      expect(p.cushionE0).toBeGreaterThanOrEqual(0.75);
      expect(p.cushionE0).toBeLessThanOrEqual(0.9);
    }
  });
  it('the presets are ordered: faster cloth rolls further, livelier cushions bounce more', () => {
    const p = (o: Partial<Settings>) => physicsFor({ ...DEFAULT_SETTINGS, ...o });
    expect(p({ cloth: 'fast' }).muRoll).toBeLessThan(p({ cloth: 'normal' }).muRoll);
    expect(p({ cloth: 'normal' }).muRoll).toBeLessThan(p({ cloth: 'slow' }).muRoll);
    expect(p({ cushions: 'dead' }).cushionE0).toBeLessThan(p({ cushions: 'normal' }).cushionE0);
    expect(p({ cushions: 'normal' }).cushionE0).toBeLessThan(p({ cushions: 'lively' }).cushionE0);
    expect(p({ shaft: 'standard' }).squirtMassRatio).toBeLessThan(p({ shaft: 'low-deflection' }).squirtMassRatio);
  });
});
