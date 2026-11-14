/**
 * Hand-written inline SVG icons (feature 002, US3). 24 px grid, 1.75 px round strokes, `currentColor`.
 * No icon package and no network: every glyph is a few path commands defined here.
 */

export type IconName =
  | 'play'
  | 'pause'
  | 'camera'
  | 'camera-off'
  | 'image'
  | 'aperture'
  | 'target'
  | 'crosshair'
  | 'cube'
  | 'layers'
  | 'sparkles'
  | 'settings'
  | 'info'
  | 'close'
  | 'check'
  | 'chevron-up'
  | 'chevron-down'
  | 'chevron-right'
  | 'refresh'
  | 'snowflake'
  | 'hand'
  | 'ruler'
  | 'cue'
  | 'ball'
  | 'eye'
  | 'rotate-3d'
  | 'upload'
  | 'plus'
  | 'minus'
  | 'arrow-right'
  | 'alert'
  | 'lock'
  | 'lightbulb'
  | 'list'
  | 'grid'
  | 'swap'
  | 'flag';

/** A gear outline: 8 rounded teeth, computed once (still hand-made geometry, no package). */
function gearPath(): string {
  const teeth = 8;
  const rOut = 9.25;
  const rIn = 7.1;
  const pts: string[] = [];
  for (let i = 0; i < teeth; i++) {
    const a0 = (i / teeth) * Math.PI * 2;
    const step = (Math.PI * 2) / teeth;
    const seq: [number, number][] = [
      [a0 - step * 0.5, rIn],
      [a0 - step * 0.2, rIn],
      [a0 - step * 0.13, rOut],
      [a0 + step * 0.13, rOut],
      [a0 + step * 0.2, rIn],
    ];
    for (const [a, r] of seq) pts.push(`${(12 + r * Math.cos(a)).toFixed(2)} ${(12 + r * Math.sin(a)).toFixed(2)}`);
  }
  return `M${pts.join('L')}Z`;
}

const PATHS: Record<IconName, string> = {
  play: '<path d="M8 5.6v12.8a.9.9 0 0 0 1.37.77l10.2-6.4a.9.9 0 0 0 0-1.54L9.37 4.83A.9.9 0 0 0 8 5.6z"/>',
  pause: '<rect x="6.5" y="5" width="3.6" height="14" rx="1.1"/><rect x="13.9" y="5" width="3.6" height="14" rx="1.1"/>',
  camera:
    '<path d="M3.5 9a2.5 2.5 0 0 1 2.5-2.5h1.8l1.5-2h5.4l1.5 2H18A2.5 2.5 0 0 1 20.5 9v8.5A2.5 2.5 0 0 1 18 20H6a2.5 2.5 0 0 1-2.5-2.5z"/><circle cx="12" cy="13" r="3.6"/>',
  'camera-off':
    '<path d="M9.2 4.5h5.4l1.5 2H18A2.5 2.5 0 0 1 20.5 9v7.7M18 20H6a2.5 2.5 0 0 1-2.5-2.5V9A2.5 2.5 0 0 1 6 6.5"/><path d="M10 10.4a3.6 3.6 0 0 0 5 5"/><path d="M3 3l18 18"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.6"/><circle cx="9" cy="9.6" r="1.7"/><path d="M20.5 15.2l-4.4-4.4-8.9 8.7"/>',
  aperture:
    '<circle cx="12" cy="12" r="8.75"/><path d="M14.3 3.6l-5.6 9.7M20.4 10.4H9.2M17.9 18.4l-5.6-9.7M9.7 20.4l5.6-9.7M3.6 13.6h11.2M6.1 5.6l5.6 9.7"/>',
  target: '<circle cx="12" cy="12" r="8.75"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.4"/>',
  crosshair: '<circle cx="12" cy="12" r="7.5"/><path d="M12 2.5v5M12 16.5v5M2.5 12h5M16.5 12h5"/>',
  cube: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/>',
  layers: '<path d="M12 3.5l9 4.6-9 4.6-9-4.6z"/><path d="M3 12.2l9 4.6 9-4.6"/><path d="M3 16.2l9 4.6 9-4.6"/>',
  sparkles:
    '<path d="M10 3.5l1.55 4.3a2 2 0 0 0 1.2 1.2L17 10.5l-4.25 1.5a2 2 0 0 0-1.2 1.2L10 17.5l-1.55-4.3a2 2 0 0 0-1.2-1.2L3 10.5l4.25-1.5a2 2 0 0 0 1.2-1.2z"/><path d="M18.5 14.5v5M16 17h5"/><path d="M18 3.5v3M16.5 5h3"/>',
  settings: `<path d="${gearPath()}"/><circle cx="12" cy="12" r="3.1"/>`,
  info: '<circle cx="12" cy="12" r="8.75"/><path d="M12 11v5.5"/><path d="M12 7.6v.15"/>',
  close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  'chevron-up': '<path d="M6 15l6-6 6 6"/>',
  'chevron-down': '<path d="M6 9l6 6 6-6"/>',
  'chevron-right': '<path d="M9 6l6 6-6 6"/>',
  refresh: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.6 4.4v4.1h-4.1"/>',
  snowflake:
    '<path d="M12 2.8v18.4M4 7.4l16 9.2M4 16.6l16-9.2"/><path d="M9.6 4.4L12 6.3l2.4-1.9M9.6 19.6L12 17.7l2.4 1.9M4.5 10.4l2.9-1-.5-3M19.5 13.6l-2.9 1 .5 3M4.5 13.6l2.9 1-.5 3M19.5 10.4l-2.9-1 .5-3"/>',
  hand:
    '<path d="M9 11.5V5.2a1.6 1.6 0 0 1 3.2 0v5.6"/><path d="M12.2 10.3V9.1a1.6 1.6 0 0 1 3.2 0v2"/><path d="M15.4 10.6a1.6 1.6 0 0 1 3.2 0v4.2a6.2 6.2 0 0 1-6.2 6.2h-.8a6 6 0 0 1-4.7-2.3l-2.5-3.2a1.6 1.6 0 0 1 2.4-2.1L9 15.2"/>',
  ruler:
    '<path d="M3.6 15.6L15.6 3.6a1.4 1.4 0 0 1 2 0l2.8 2.8a1.4 1.4 0 0 1 0 2L8.4 20.4a1.4 1.4 0 0 1-2 0l-2.8-2.8a1.4 1.4 0 0 1 0-2z"/><path d="M7.5 11.7l2 2M10.5 8.7l1.4 1.4M13.5 5.7l2 2"/>',
  cue: '<path d="M3.5 20.5l10.6-10.6"/><path d="M15.3 8.7l.9-.9"/><circle cx="18.6" cy="5.4" r="2.4"/>',
  ball: '<circle cx="12" cy="12" r="8.75"/><circle cx="12" cy="12" r="3.4"/><path d="M7.4 8.6a5.4 5.4 0 0 1 2.6-2.4"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  'rotate-3d':
    '<ellipse cx="12" cy="12" rx="3.6" ry="8.75"/><path d="M17.4 8C19.9 9 21.5 10.4 21.5 12c0 3-4.3 5.5-9.5 5.5S2.5 15 2.5 12c0-1.7 1.3-3.2 3.5-4.2"/><path d="M14.6 15.6l-2.3 1.9 2.1 2.1"/>',
  upload: '<path d="M12 15.5V4.5M7.5 9L12 4.5 16.5 9"/><path d="M4.5 14.5v3a2.5 2.5 0 0 0 2.5 2.5h10a2.5 2.5 0 0 0 2.5-2.5v-3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  'arrow-right': '<path d="M4.5 12h15M13.5 6l6 6-6 6"/>',
  alert:
    '<path d="M10.3 4.3L2.8 17.4a2 2 0 0 0 1.7 3h15a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0z"/><path d="M12 9.5v4.4M12 17.1v.15"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2.6"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/><path d="M12 14.6v2"/>',
  lightbulb:
    '<path d="M9.2 18h5.6M10.2 21h3.6"/><path d="M12 3a6 6 0 0 0-3.6 10.8c.7.5 1 1.3 1 2.1v.1h5.2v-.1c0-.8.4-1.6 1-2.1A6 6 0 0 0 12 3z"/>',
  list: '<path d="M9 6.5h11M9 12h11M9 17.5h11"/><path d="M4.5 6.5h.2M4.5 12h.2M4.5 17.5h.2"/>',
  grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.6"/>',
  swap: '<path d="M4 8.5h15l-3.5-3.5"/><path d="M20 15.5H5l3.5 3.5"/>',
  flag: '<path d="M5.5 21V4"/><path d="M5.5 4.5h11l-2.2 4 2.2 4h-11"/>',
};

export const ICON_NAMES = Object.keys(PATHS) as IconName[];

/** Raw markup for `innerHTML` templates. */
export function iconMarkup(name: IconName, size = 24, cls = ''): string {
  const body = PATHS[name] ?? PATHS.info;
  return `<svg class="icon icon-${name}${cls ? ` ${cls}` : ''}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
}

/** A fresh `<svg>` element for the named icon. */
export function icon(name: IconName, size = 24): SVGSVGElement {
  const tpl = document.createElement('template');
  tpl.innerHTML = iconMarkup(name, size);
  return tpl.content.firstElementChild as SVGSVGElement;
}

/** Replaces every `[data-icon]` placeholder under `root` with its SVG (once). */
export function hydrateIcons(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('[data-icon]').forEach((el) => {
    if (el.dataset.iconDone) return;
    const name = el.dataset.icon as IconName;
    if (!(name in PATHS)) return;
    const size = Number(el.dataset.iconSize) || 24;
    el.insertAdjacentHTML('afterbegin', iconMarkup(name, size));
    el.dataset.iconDone = '1';
  });
}
