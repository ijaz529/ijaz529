import { defineConfig } from 'vite';
import { swPrecache } from './scripts/sw-precache';

export default defineConfig({
  base: './',
  plugins: [swPrecache()],
  worker: { format: 'es' },
  build: { target: 'es2022', sourcemap: true },
  server: { host: false },
});
