/**
 * Player settings persisted per device (guarded localStorage — Principle V: nothing leaves the device).
 * Everything read back (from storage or from the settings form) is validated field by field: a bad
 * value keeps the current setting (or the default), so e.g. an emptied number field can never be
 * saved as 0 (FOV 0 → no balls found) and a stale store heals on launch.
 */
import { withPhysics } from '../core/physics/params';
import { makeTable, TABLE_PRESETS } from '../core/table';
import type { PhysicsParams, TablePresetId, TableSpec } from '../core/types';

export interface Settings {
  table: TablePresetId;
  cloth: 'fast' | 'normal' | 'slow';
  cushions: 'dead' | 'normal' | 'lively';
  shaft: 'standard' | 'low-deflection';
  cushionWidthCm: number;
  fovDeg: number;
  showDetails: boolean;
  /** Practice/Snap table in 3D (WebGL2); off = the 2D table (feature 002 FR-110). */
  table3d: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  table: 'pool9',
  cloth: 'normal',
  cushions: 'normal',
  shaft: 'standard',
  cushionWidthCm: 5,
  fovDeg: 65,
  showDetails: false,
  table3d: true,
};

/** Accepted range of the number settings (the settings inputs use the same min/max/step). */
export const SETTING_LIMITS = {
  /** Cushion nose to rail top, cm: 2…10 covers pool and snooker rails. */
  cushionWidthCm: { min: 2, max: 10, step: 0.5 },
  /** Horizontal camera field of view, degrees: phone main cameras are ~60–80°, ultra-wide ~110°. */
  fovDeg: { min: 40, max: 110, step: 1 },
} as const;

const CHOICES = {
  cloth: ['fast', 'normal', 'slow'],
  cushions: ['dead', 'normal', 'lively'],
  shaft: ['standard', 'low-deflection'],
} as const;

type NumberKey = keyof typeof SETTING_LIMITS;

function numberOr(v: unknown, key: NumberKey, fallback: number): number {
  // An empty field reads as '' (Number('') is 0): only a real, in-range number is accepted.
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  const { min, max } = SETTING_LIMITS[key];
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

function choiceOr<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

const tableOr = (v: unknown, fallback: TablePresetId): TablePresetId => (typeof v === 'string' && Object.prototype.hasOwnProperty.call(TABLE_PRESETS, v) ? (v as TablePresetId) : fallback);

/** Field-by-field validation of a stored (untrusted) settings object; invalid fields take `base`'s value. */
export function sanitizeSettings(raw: unknown, base: Settings = DEFAULT_SETTINGS): Settings {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    table: tableOr(o.table, base.table),
    cloth: choiceOr(o.cloth, CHOICES.cloth, base.cloth),
    cushions: choiceOr(o.cushions, CHOICES.cushions, base.cushions),
    shaft: choiceOr(o.shaft, CHOICES.shaft, base.shaft),
    cushionWidthCm: numberOr(o.cushionWidthCm, 'cushionWidthCm', base.cushionWidthCm),
    fovDeg: numberOr(o.fovDeg, 'fovDeg', base.fovDeg),
    showDetails: typeof o.showDetails === 'boolean' ? o.showDetails : base.showDetails,
    table3d: typeof o.table3d === 'boolean' ? o.table3d : base.table3d,
  };
}

/**
 * The settings form on Save → settings. `fd` is the form's FormData (fields are strings, a checked
 * switch is 'on'); an empty, non-numeric or out-of-range number and an unknown choice keep `current`.
 */
export function parseSettingsForm(fd: { get(name: string): unknown }, current: Settings): Settings {
  const str = (k: string) => {
    const v = fd.get(k);
    return typeof v === 'string' ? v : undefined;
  };
  return {
    table: tableOr(str('table'), current.table),
    cloth: choiceOr(str('cloth'), CHOICES.cloth, current.cloth),
    cushions: choiceOr(str('cushions'), CHOICES.cushions, current.cushions),
    shaft: choiceOr(str('shaft'), CHOICES.shaft, current.shaft),
    cushionWidthCm: numberOr(str('cushionWidthCm'), 'cushionWidthCm', current.cushionWidthCm),
    fovDeg: numberOr(str('fovDeg'), 'fovDeg', current.fovDeg),
    showDetails: str('showDetails') === 'on',
    table3d: str('table3d') === 'on',
  };
}

const KEY = 'cuesight.settings.v1';

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return sanitizeSettings(JSON.parse(raw));
  } catch {
    /* storage unavailable (private mode) or a corrupt entry — defaults */
  }
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

/**
 * Cloth, cushion and shaft presets → physics parameters (Constitution Principle I: sourced or ASSUMPTION).
 * - muRoll: rolling resistance 0.005 (fast cloth) … 0.015 (slow cloth) [A][P] (params.ts). ASSUMPTION:
 *   the three presets sit inside that range at 0.007 / 0.01 / 0.014 (new cloth / typical / worn or humid).
 * - cushionE0: cushion restitution, typical 0.75–0.9 (params.ts, ASSUMPTION fitted to that range).
 *   ASSUMPTION: dead / normal / lively = 0.8 / 0.88 / 0.9; lively is the top of the cited range (not
 *   beyond it), the speed-dependent fall-off (cushionESlope) is unchanged.
 * - squirtMassRatio: ≈23 standard shaft, ≈35 low-deflection [A TP A.31] (params.ts).
 */
export function physicsFor(s: Settings): PhysicsParams {
  return withPhysics({
    muRoll: { fast: 0.007, normal: 0.01, slow: 0.014 }[s.cloth],
    cushionE0: { dead: 0.8, normal: 0.88, lively: 0.9 }[s.cushions],
    squirtMassRatio: s.shaft === 'standard' ? 23 : 35,
  });
}

export function tableFor(s: Settings): TableSpec {
  return makeTable(s.table, { cushionWidth: s.cushionWidthCm / 100 });
}
