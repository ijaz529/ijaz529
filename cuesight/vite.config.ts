import { defineConfig } from 'vite';
import { swPrecache } from './scripts/sw-precache';

export default defineConfig({
  base: './',
  plugins: [swPrecache()],
  worker: { format: 'es' },
  // No source maps: dist is what the PWA serves and what `cap sync` copies into the iOS app bundle.
  build: { target: 'es2022', sourcemap: false },
  server: { host: false },
});
