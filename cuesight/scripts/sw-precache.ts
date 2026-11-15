/**
 * Build-time precache manifest for the service worker (Constitution V: the app MUST work offline
 * after the first load).
 *
 * The hashed JS/CSS chunks and the worker scripts are requested before the service worker controls
 * the page on a first visit, so "cache on first fetch" never sees them, and the Snap sample photos
 * may never be fetched online at all. This Vite plugin writes the list of every built file (the
 * bundle plus the copied public files, minus source maps) into dist/sw.js, replacing the
 * `BUILD_ASSETS` / `BUILD_ID` placeholders in public/sw.js, so the worker precaches the whole app
 * when it installs. It then checks the written dist/sw.js against the files on disk and fails the
 * build if a placeholder survived or a file is missing from the list. Build-only; nothing here ships
 * to the browser except the list itself.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Plugin } from 'vite';

export const ASSETS_PLACEHOLDER = 'const BUILD_ASSETS = [];';
export const ID_PLACEHOLDER = "const BUILD_ID = 'dev';";

const posix = (f: string) => f.split('\\').join('/');

/**
 * Files worth precaching: everything built except source maps, the HTML shell, the worker itself and
 * dotfiles (e.g. a stray .DS_Store copied from public/).
 */
export function precacheList(files: string[]): string[] {
  return [...new Set(files.map(posix))]
    .filter((f) => !f.endsWith('.map') && f !== 'index.html' && f !== 'sw.js' && !f.split('/').some((s) => s.startsWith('.')))
    .sort()
    .map((f) => `./${f}`);
}

/**
 * A short id that changes whenever any built file name, the HTML shell or (with `content`, see
 * contentDigest) any file's bytes change: the service worker's cache name. It is also what makes
 * dist/sw.js differ between deploys, and the browser only installs a new worker when that file changes.
 */
export function buildId(list: string[], shell = '', content = ''): string {
  return createHash('sha256').update(list.join('\n')).update('\0').update(shell).update('\0').update(content).digest('hex').slice(0, 10);
}

/**
 * A hash of the bytes of every listed file under `dir`. The bundle's names are content-hashed, but the
 * public files (Snap sample photos, manifest, icons) keep their names when they change. A file that is
 * not on disk is skipped here (verifyPrecache reports it).
 */
export function contentDigest(dir: string, list: string[]): string {
  const h = createHash('sha256');
  for (const f of list) {
    const p = join(dir, f.replace(/^\.\//, ''));
    h.update(f).update('\0').update(existsSync(p) ? readFileSync(p) : '').update('\0');
  }
  return h.digest('hex');
}

/** Replaces both placeholders in the service worker source; throws if either is missing. */
export function injectPrecache(swSource: string, list: string[], shell = '', content = ''): string {
  if (!swSource.includes(ASSETS_PLACEHOLDER) || !swSource.includes(ID_PLACEHOLDER)) {
    throw new Error(`sw.js must contain "${ASSETS_PLACEHOLDER}" and "${ID_PLACEHOLDER}"`);
  }
  return swSource
    .replace(ASSETS_PLACEHOLDER, `const BUILD_ASSETS = ${JSON.stringify(list)};`)
    .replace(ID_PLACEHOLDER, `const BUILD_ID = '${buildId(list, shell, content)}';`);
}

/** The precache list written into a built sw.js ([] if there is none). */
export function listedAssets(swSource: string): string[] {
  const m = /const BUILD_ASSETS = (\[[^\]]*\]);/.exec(swSource);
  return m ? (JSON.parse(m[1]!) as string[]) : [];
}

/**
 * Problems with a built sw.js, given every file in the output directory (relative paths): a
 * placeholder left in place, a built file that is not precached, or a precached file that does not
 * exist (the install would fail). Empty when the service worker matches the build exactly.
 */
export function verifyPrecache(swSource: string, outFiles: string[]): string[] {
  const problems: string[] = [];
  if (swSource.includes(ASSETS_PLACEHOLDER) || swSource.includes(ID_PLACEHOLDER)) {
    problems.push('sw.js still has its BUILD_ASSETS / BUILD_ID placeholder: the precache list was never written');
  }
  const listed = new Set(listedAssets(swSource));
  const expected = precacheList(outFiles);
  for (const f of expected) if (!listed.has(f)) problems.push(`${f} is built but not precached by sw.js`);
  const onDisk = new Set(expected);
  for (const f of listed) if (!onDisk.has(f)) problems.push(`${f} is precached by sw.js but was not built`);
  return problems;
}

function walk(dir: string, base = dir): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p, base) : [relative(base, p).split(sep).join('/')];
  });
}

export function swPrecache(): Plugin {
  let outDir = 'dist';
  let publicDir = '';
  let emptied = true;
  let files: string[] = [];
  let shell = '';
  return {
    name: 'cuesight-sw-precache',
    apply: 'build',
    // After Vite's own HTML plugin, so index.html is in the bundle.
    enforce: 'post',
    configResolved(c) {
      outDir = resolve(c.root, c.build.outDir);
      publicDir = c.build.copyPublicDir ? c.publicDir : '';
      const rel = relative(c.root, outDir);
      // Vite empties outDir by default only when it is inside the project root.
      emptied = c.build.emptyOutDir ?? (!rel.startsWith('..') && !isAbsolute(rel));
    },
    generateBundle(_opts, bundle) {
      files = Object.keys(bundle);
      const html = bundle['index.html'];
      shell = html && html.type === 'asset' ? String(html.source) : '';
    },
    closeBundle() {
      if (!files.length) return; // the build failed before emitting anything
      const sw = resolve(outDir, 'sw.js');
      if (!existsSync(sw)) throw new Error(`${sw} is missing: public/sw.js must be copied into the build (offline support)`);
      const list = precacheList([...files, ...walk(publicDir)]);
      const written = injectPrecache(readFileSync(sw, 'utf8'), list, shell, contentDigest(outDir, list));
      writeFileSync(sw, written);
      // Guard: the worker must list exactly the files on disk. In an outDir that was not emptied, files
      // left over from an earlier build are ignored (they are not this build's).
      const ours = new Set(list);
      const onDisk = walk(outDir).filter((f) => emptied || ours.has(`./${f}`));
      const problems = verifyPrecache(written, onDisk);
      if (problems.length) throw new Error(`dist/sw.js does not match the build:\n  ${problems.join('\n  ')}`);
    },
  };
}
