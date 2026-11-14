/**
 * Build-time precache manifest for the service worker (Constitution V: the app MUST work offline
 * after the first load).
 *
 * The hashed JS/CSS chunks and the worker scripts are requested before the service worker controls
 * the page on a first visit, so "cache on first fetch" never sees them. This Vite plugin writes the
 * list of built files into dist/sw.js (replacing the `BUILD_ASSETS` / `BUILD_ID` placeholders in
 * public/sw.js) so the worker precaches the whole app when it installs. Build-only; nothing here
 * ships to the browser except the list itself.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';

export const ASSETS_PLACEHOLDER = 'const BUILD_ASSETS = [];';
export const ID_PLACEHOLDER = "const BUILD_ID = 'dev';";

/** Files from the bundle worth precaching: everything except source maps and the HTML shell. */
export function precacheList(files: string[]): string[] {
  return [...new Set(files)]
    .filter((f) => !f.endsWith('.map') && f !== 'index.html' && f !== 'sw.js')
    .sort()
    .map((f) => `./${f}`);
}

/**
 * A short id that changes whenever any built file name (and so, with hashed names, its content) or
 * the HTML shell changes: the service worker's cache name, so every deploy gets a fresh cache.
 */
export function buildId(list: string[], shell = ''): string {
  return createHash('sha256').update(list.join('\n')).update('\0').update(shell).digest('hex').slice(0, 10);
}

/** Replaces both placeholders in the service worker source; throws if either is missing. */
export function injectPrecache(swSource: string, list: string[], shell = ''): string {
  if (!swSource.includes(ASSETS_PLACEHOLDER) || !swSource.includes(ID_PLACEHOLDER)) {
    throw new Error(`sw.js must contain "${ASSETS_PLACEHOLDER}" and "${ID_PLACEHOLDER}"`);
  }
  return swSource
    .replace(ASSETS_PLACEHOLDER, `const BUILD_ASSETS = ${JSON.stringify(list)};`)
    .replace(ID_PLACEHOLDER, `const BUILD_ID = '${buildId(list, shell)}';`);
}

export function swPrecache(): Plugin {
  let outDir = 'dist';
  let files: string[] = [];
  let shell = '';
  return {
    name: 'cuesight-sw-precache',
    apply: 'build',
    // After Vite's own HTML plugin, so index.html is in the bundle.
    enforce: 'post',
    configResolved(c) {
      outDir = resolve(c.root, c.build.outDir);
    },
    generateBundle(_opts, bundle) {
      files = Object.keys(bundle);
      const html = bundle['index.html'];
      shell = html && html.type === 'asset' ? String(html.source) : '';
    },
    closeBundle() {
      const sw = resolve(outDir, 'sw.js');
      if (!existsSync(sw) || !files.length) return;
      writeFileSync(sw, injectPrecache(readFileSync(sw, 'utf8'), precacheList(files), shell));
    },
  };
}
