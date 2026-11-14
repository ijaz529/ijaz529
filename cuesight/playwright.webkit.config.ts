/**
 * WebKit / iPhone end-to-end run (spec 002, US4 FR-135): the same tests/e2e suite as the Chromium
 * config, in Playwright's WebKit with the iPhone 15 device profile (the engine inside the iOS app's
 * WKWebView and iOS Safari).
 *
 *   npx playwright install webkit          (once; on Linux also `--with-deps`)
 *   npm run e2e:webkit                     (= vite build && playwright test -c playwright.webkit.config.ts)
 *
 * The live-camera spec is skipped: it needs Chromium's fake y4m capture device, and WebKit has no
 * equivalent. Tag any other Chromium-only test with "@chromium-only" in its title to skip it here.
 */
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  grepInvert: /live camera|@chromium-only/,
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report/webkit' }]]
    : [['list']],
  outputDir: 'test-results/webkit',
  use: {
    baseURL: 'http://localhost:4173',
    trace: process.env.CI ? 'retain-on-failure' : 'off',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npx vite preview --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  projects: [
    {
      name: 'webkit-iphone',
      use: { ...devices['iPhone 15'], browserName: 'webkit' },
    },
  ],
});
