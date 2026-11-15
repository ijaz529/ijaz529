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
  /**
   * The cue stick behind the cue ball (side spin only): a faint off-white, long-dashed and labelled
   * "Cue stick", so it is never read as a ball path (those are blue, orange, sky and purple).
   */
  stick: '#F4F6FB',
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
  /** Long dashes: unlike the cue-ball path's [10, 6] and every other line. */
  stick: [18, 7],
};

/** Opacity of the cue-stick line (faint: a guide, not a path). */
export const STICK_ALPHA = 0.6;

/**
 * Smallest ball pick radius in CSS px on the 2D table, the mini-map and the camera overlay: a 44 px
 * touch target (Constitution: ≥ 44 CSS px targets) even where a ball is drawn a few px wide.
 */
export const HIT_RADIUS_PX = 22;

export function rgbCss(rgb: [number, number, number] | undefined, fallback = '#ddd'): string {
  if (!rgb) return fallback;
  return `rgb(${Math.round(rgb[0])},${Math.round(rgb[1])},${Math.round(rgb[2])})`;
}

// ---------------------------------------------------------------------------------------------
// Ball colours (2D table, mini-map; the 3D table reads the same tables)
// ---------------------------------------------------------------------------------------------
/** Pool and detected colour names → sRGB hex. */
export const BALL_NAMED: Readonly<Record<string, string>> = {
  white: '#f2eee4',
  yellow: '#f2b705',
  blue: '#1e4fb5',
  red: '#c81e1e',
  purple: '#4b2a83',
  orange: '#f06a12',
  green: '#0f7a3d',
  maroon: '#7a1e2b',
  brown: '#6b3a1e',
  pink: '#f08fb0',
  black: '#121212',
};
/** Snooker uses slightly different (deeper) tones than pool sets. */
export const BALL_SNOOKER: Readonly<Record<string, string>> = {
  red: '#b3141b',
  yellow: '#f2c230',
  green: '#0e7a43',
  brown: '#6b3a1e',
  blue: '#1f4fb5',
  pink: '#f08fb0',
  black: '#111111',
};
/**
 * A ball vision could not name (the neutral label 'ball', no measured colour): mid grey, so it
 * never reads as a red or any other ball it may not be.
 */
export const BALL_NEUTRAL = '#9a9a9a';

/**
 * Fill colour of a ball: the cue ball ivory; a named snooker ball its set colour; otherwise the
 * measured (or practice-set) colour, then the colour of its name, then neutral grey.
 */
export function ballCss(b: { kind: string; label?: string; color?: string }, snooker: boolean): string {
  if (b.kind === 'cue') return UI.ivory;
  const word = (b.label ?? '').trim().toLowerCase().split(/\s+/)[0] ?? '';
  if (snooker && BALL_SNOOKER[word]) return BALL_SNOOKER[word]!;
  return b.color ?? BALL_NAMED[word] ?? BALL_NEUTRAL;
}
