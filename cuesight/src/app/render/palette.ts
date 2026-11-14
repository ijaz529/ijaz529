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
  // Target ball: a white ring with a dark halo. Not yellow: that is the 1-ball's (and snooker's
  // yellow's) colour. Yellow stays for the landing spot only.
  target: '#FFFFFF',
  /** Target pocket: gold ring (a highlight on the rail, away from the balls). */
  pocket: '#E9C46A',
  other: '#CC79A7', // reddish purple, dash-dot
  landing: '#F0E442',
} as const;

/**
 * Midnight Felt surface colours for canvas drawing (rails, cloth, halos). These carry no plan
 * meaning; the plan colours above are unchanged.
 */
export const UI = {
  text: '#F4F6FB',
  halo: 'rgba(7,11,20,0.55)',
  haloStrong: 'rgba(7,11,20,0.88)',
  wood: '#4A2C18',
  woodHi: '#6E4426',
  woodLo: '#2C190D',
  cushion: '#0A5A41',
  cloth: '#0E6B4F',
  clothHi: '#16855F',
  clothLo: '#0A4F3A',
  pearl: '#F1E6C8',
  leather: '#141210',
  ivory: '#F6F3EA',
} as const;

export const DASH = {
  aim: [] as number[],
  object: [] as number[],
  cue: [10, 6],
  ghost: [3, 4],
  other: [8, 4, 2, 4],
};

/**
 * Smallest ball pick radius in CSS px on the 2D table, the mini-map and the camera overlay: a 44 px
 * touch target (Constitution: ≥ 44 CSS px targets) even where a ball is drawn a few px wide.
 */
export const HIT_RADIUS_PX = 22;

export function rgbCss(rgb: [number, number, number] | undefined, fallback = '#ddd'): string {
  if (!rgb) return fallback;
  return `rgb(${Math.round(rgb[0])},${Math.round(rgb[1])},${Math.round(rgb[2])})`;
}
