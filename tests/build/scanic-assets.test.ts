// @vitest-environment node
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { expect, it } from 'vitest';
import { SCANIC_ML_ASSET_BASE } from '../../src/imaging/engines/scanic-ml-assets';

it('serves the matching installed ONNX loader/WASM pair and the unchanged corner model', async () => {
  const server = await createServer({
    configFile: resolve('vite.config.ts'),
    logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0, strictPort: false },
  });
  try {
    await server.listen();
    const address = server.httpServer?.address();
    if (address === null || typeof address !== 'object') throw new Error('No test server address.');
    for (const [fileName, installedFile, contentType] of [
      [
        'ort-wasm-simd-threaded.mjs',
        'onnxruntime-web/dist/ort-wasm-simd-threaded.mjs',
        'text/javascript',
      ],
      [
        'ort-wasm-simd-threaded.wasm',
        'onnxruntime-web/dist/ort-wasm-simd-threaded.wasm',
        'application/wasm',
      ],
      ['doccornernet_lean.ort', 'scanic-ml/dist/doccornernet_lean.ort', 'application/octet-stream'],
    ] as const) {
      const response = await fetch(
        `http://127.0.0.1:${address.port}${SCANIC_ML_ASSET_BASE}${fileName}`,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain(contentType);
      const servedHash = createHash('sha256')
        .update(new Uint8Array(await response.arrayBuffer()))
        .digest('hex');
      const expectedHash = createHash('sha256')
        .update(await readFile(resolve('node_modules', installedFile)))
        .digest('hex');
      expect(servedHash).toBe(expectedHash);
    }
  } finally {
    await server.close();
  }
}, 20_000);
