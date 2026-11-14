/**
 * Okabe–Ito colour-blind-safe palette with redundant line styles (research.md R-14, FR-024).
 */
export const PALETTE = {
  aim: '#0072B2', // blue, solid
  object: '#E69F00', // orange, solid
  cue: '#56B4E9', // sky, dashed
  ghost: '#FFFFFF', // white, dotted
  warn: '#D55E00', // vermillion
  ok: '#009E73', // bluish green
  target: '#F0E442', // yellow ring
  other: '#CC79A7', // reddish purple, dash-dot
  landing: '#F0E442',
} as const;

export const DASH = {
  aim: [] as number[],
  object: [] as number[],
  cue: [10, 6],
  ghost: [3, 4],
  other: [8, 4, 2, 4],
};

export function rgbCss(rgb: [number, number, number] | undefined, fallback = '#ddd'): string {
  if (!rgb) return fallback;
  return `rgb(${Math.round(rgb[0])},${Math.round(rgb[1])},${Math.round(rgb[2])})`;
}
