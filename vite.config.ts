import { SCANIC_ML_ASSET_BASE, SCANIC_ORT_VERSION } from './src/imaging/engines/scanic-ml-assets';
import { DOCSCAN_WASM_BASE } from './src/imaging/engines/docscan-assets';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const installedOrt = JSON.parse(
  readFileSync(resolve('node_modules/onnxruntime-web/package.json'), 'utf8'),
) as { version: string };
if (installedOrt.version !== SCANIC_ORT_VERSION)
  throw new Error('Update the versioned Scanic asset path when changing ONNX Runtime.');

// Scanic 1.6 bundles ORT 1.27 JS. Its optional minimal WASM is built with
// ORT 1.23.2; use our pinned matching CPU runtime rather than mixing ABIs.
const SCANIC_ML_ASSETS = {
  'doccornernet_lean.ort': resolve('node_modules/scanic-ml/dist/doccornernet_lean.ort'),
  'ort-wasm-simd-threaded.mjs': resolve(
    'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs',
  ),
  'ort-wasm-simd-threaded.wasm': resolve(
    'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm',
  ),
} as const;

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
        // Vite rejects source imports from public/ by default. This generated ES
        // module must retain its relative .wasm URL in development as in production.
        const rasterAssets = {
          'docscan.mjs': 'text/javascript; charset=utf-8',
          'docscan.wasm': 'application/wasm',
        } as const;
        for (const version of [
          'v1',
          'v2',
          'v3',
          'v4',
          'v5',
          'v6',
          'v7',
          'v8',
          DOCSCAN_WASM_BASE.split('/')[2],
        ])
          server.middlewares.use(`/docscan-wasm/${version}`, (request, response, next) => {
            const name = new URL(request.url ?? '/', 'http://localhost').pathname.slice(1);
            if (!Object.hasOwn(rasterAssets, name)) {
              next();
              return;
            }
            response.setHeader('Content-Type', rasterAssets[name as keyof typeof rasterAssets]);
            response.setHeader('Cache-Control', 'no-store');
            response.end(readFileSync(resolve(`public/docscan-wasm/${version}`, name)));
          });
        server.middlewares.use(SCANIC_ML_ASSET_BASE.slice(0, -1), (request, response, next) => {
          const fileName = new URL(request.url ?? '/', 'http://localhost').pathname.slice(1);
          if (!Object.hasOwn(SCANIC_ML_ASSETS, fileName)) {
            next();
            return;
          }
          response.setHeader('Content-Type', scanicMlContentType(fileName));
          response.setHeader('Cache-Control', 'no-store');
          response.end(readFileSync(SCANIC_ML_ASSETS[fileName as keyof typeof SCANIC_ML_ASSETS]));
        });
      },
      generateBundle() {
        for (const fileName of Object.keys(SCANIC_ML_ASSETS)) {
          this.emitFile({
            type: 'asset',
            fileName: `${SCANIC_ML_ASSET_BASE.slice(1)}${fileName}`,
            source: readFileSync(SCANIC_ML_ASSETS[fileName as keyof typeof SCANIC_ML_ASSETS]),
          });
        }
      },
    },
  ],
  // Scanic contains split ESM assets; the worker is created with type: 'module'.
  worker: {
    format: 'es',
    rollupOptions: {
      output: {
        // Shared config/error contracts must never be folded into a worker entry:
        // importing them from a lazy chunk would re-evaluate that entry in WebKit.
        manualChunks(id) {
          const path = id.replaceAll('\\', '/');
          if (path.endsWith('/shadow-runtime-error.ts')) return 'shadow-runtime-contract';
          if (path.endsWith('/scanic-ml-assets.ts')) return 'scanic-ml-config';
          if (path.endsWith('/docscan-assets.ts')) return 'docscan-config';
        },
      },
    },
  },
});
