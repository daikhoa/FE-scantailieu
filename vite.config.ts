import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { docscanAssets } from '@docscan/browser/vite';

export default defineConfig({
  // The SDK imports pdf-lib lazily; discover it before editing so Vite does not invalidate
  // the dependency graph and attempt to reload an unsaved phone document on first export.
  optimizeDeps: { include: ['pdf-lib'] },
  server: { proxy: { '/api': { target: 'http://127.0.0.1:8000', changeOrigin: false } } },
  preview: {
    host: '0.0.0.0',
    proxy: { '/api': { target: 'http://127.0.0.1:8000', changeOrigin: false } },
  },
  plugins: [react(), docscanAssets()],
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
          if (path.endsWith('/sdk-assets.ts')) return 'docscan-sdk-config';
        },
      },
    },
  },
});
