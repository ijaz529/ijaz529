import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { expect, test } from '@playwright/test';

/**
 * Size budget for the production build the e2e suite runs against (Constitution VII: a small bundle
 * loads fast on bar Wi-Fi). Initial JS = the scripts index.html loads; workers load on demand.
 */
const dist = fileURLToPath(new URL('../../dist/', import.meta.url));
const INITIAL_JS_GZIP_BUDGET = 250 * 1024;
const WORKERS_GZIP_BUDGET = 100 * 1024;

const gz = (file: string) => gzipSync(readFileSync(`${dist}${file}`), { level: 9 }).length;

test('initial JS stays under 250 KB gzip, workers under 100 KB @budget', async () => {
  const html = readFileSync(`${dist}index.html`, 'utf8');
  const scripts = [...html.matchAll(/<script[^>]+src="\.\/([^"]+\.js)"/g)].map((m) => m[1]!);
  const preloads = [...html.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="\.\/([^"]+\.js)"/g)].map((m) => m[1]!);
  expect(scripts.length).toBeGreaterThan(0);
  const initial = [...new Set([...scripts, ...preloads])].reduce((a, f) => a + gz(f), 0);
  const sw = readFileSync(`${dist}sw.js`, 'utf8');
  const workers = [...sw.matchAll(/"\.\/(assets\/[^"]+\.worker-[^"]+\.js)"/g)].map((m) => m[1]!);
  expect(workers.length).toBe(2);
  const workerBytes = workers.reduce((a, f) => a + gz(f), 0);
  test.info().annotations.push({ type: 'size', description: `initial JS ${(initial / 1024).toFixed(1)} KB gzip; workers ${(workerBytes / 1024).toFixed(1)} KB gzip` });
  expect(initial).toBeLessThan(INITIAL_JS_GZIP_BUDGET);
  expect(workerBytes).toBeLessThan(WORKERS_GZIP_BUDGET);
});
