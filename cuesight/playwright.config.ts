import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const fakeVideo = fileURLToPath(new URL('./tests/fixtures/table.y4m', import.meta.url));

/** Specs that also run on the extra form factors (the feature 002 stages: 3D table, Snap, 2D fallback). */
const formFactorSpecs = /(practice3d|snap|fallback2d)\.spec\.ts$/;

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'off',
  },
  webServer: {
    command: 'npx vite preview --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: true,
    timeout: 60_000,
  },
  projects: [
    {
      name: 'chromium-phone',
      use: {
        ...devices['Pixel 7'],
        launchOptions: {
          args: [
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            `--use-file-for-fake-video-capture=${fakeVideo}`,
          ],
        },
      },
    },
    // Small phone and tablet layouts, emulated in Chromium (WebKit itself runs in
    // playwright.webkit.config.ts on macOS CI). deviceScaleFactor 1 keeps the software-rendered
    // (SwiftShader) 3D table fast enough for CI; the layout in CSS px is the device's.
    {
      name: 'chromium-iphone-se',
      testMatch: formFactorSpecs,
      use: { ...devices['iPhone SE (3rd gen)'], browserName: 'chromium', deviceScaleFactor: 1 },
    },
    {
      name: 'chromium-ipad',
      testMatch: formFactorSpecs,
      use: { ...devices['iPad (gen 7)'], browserName: 'chromium', deviceScaleFactor: 1 },
    },
  ],
});
