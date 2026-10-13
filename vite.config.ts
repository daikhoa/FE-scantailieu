import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SCANIC_ML_ASSETS = [
  'doccornernet_lean.ort',
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.wasm',
] as const;
const SCANIC_ML_ASSET_DIRECTORY = resolve('node_modules/scanic-ml/dist');

function scanicMlContentType(fileName: string): string {
  if (fileName.endsWith('.wasm')) return 'application/wasm';
  if (fileName.endsWith('.mjs')) return 'text/javascript; charset=utf-8';
  return 'application/octet-stream';
}

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'self-host-scanic-ml',
      configureServer(server) {
        server.middlewares.use('/scanic-ml', (request, response, next) => {
          const fileName = new URL(request.url ?? '/', 'http://localhost').pathname.slice(1);
          if (!SCANIC_ML_ASSETS.includes(fileName as (typeof SCANIC_ML_ASSETS)[number])) {
            next();
            return;
          }
          response.setHeader('Content-Type', scanicMlContentType(fileName));
          response.setHeader('Cache-Control', 'no-store');
          response.end(readFileSync(resolve(SCANIC_ML_ASSET_DIRECTORY, fileName)));
        });
      },
      generateBundle() {
        for (const fileName of SCANIC_ML_ASSETS) {
          this.emitFile({
            type: 'asset',
            fileName: `scanic-ml/${fileName}`,
            source: readFileSync(resolve(SCANIC_ML_ASSET_DIRECTORY, fileName)),
          });
        }
      },
    },
  ],
  // Scanic contains split ESM assets; the worker is created with type: 'module'.
  worker: { format: 'es' },
});
