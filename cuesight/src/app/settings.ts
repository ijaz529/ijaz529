/**
 * Player settings persisted per device (guarded localStorage — Principle V: nothing leaves the device).
 */
import { withPhysics } from '../core/physics/params';
import { makeTable } from '../core/table';
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

const KEY = 'cuesight.settings.v1';

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    /* storage unavailable (private mode) — defaults */
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

export function physicsFor(s: Settings): PhysicsParams {
  return withPhysics({
    muRoll: { fast: 0.007, normal: 0.01, slow: 0.014 }[s.cloth],
    cushionE0: { dead: 0.8, normal: 0.88, lively: 0.93 }[s.cushions],
    squirtMassRatio: s.shaft === 'standard' ? 23 : 35,
  });
}

export function tableFor(s: Settings): TableSpec {
  return makeTable(s.table, { cushionWidth: s.cushionWidthCm / 100 });
}
