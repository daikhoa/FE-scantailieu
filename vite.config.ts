import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  // Scanic contains split ESM assets; the worker is created with type: 'module'.
  worker: { format: 'es' },
});
