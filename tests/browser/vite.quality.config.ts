import { resolve } from 'node:path';
import { defineConfig, mergeConfig } from 'vite';
import base from '../../vite.config';

export default mergeConfig(
  base,
  defineConfig({
    build: {
      outDir: 'test-results/quality-dist',
      rollupOptions: {
        input: {
          pipeline: resolve('tests/browser/pipeline-smoke.html'),
          app: resolve('tests/browser/app-camera-reentry-smoke.html'),
        },
      },
    },
  }),
);
