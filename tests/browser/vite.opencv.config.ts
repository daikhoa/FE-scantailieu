import process from 'node:process';

import { defineConfig, searchForWorkspaceRoot } from 'vite';

const runtimeDirectory = process.env.OPENCV_RUNTIME_DIR;
if (runtimeDirectory === undefined || runtimeDirectory.length === 0) {
  throw new Error('OPENCV_RUNTIME_DIR is required for the OpenCV browser spike.');
}

export default defineConfig({
  server: {
    fs: {
      allow: [searchForWorkspaceRoot(process.cwd()), runtimeDirectory],
    },
  },
});
