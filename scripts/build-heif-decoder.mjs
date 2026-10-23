// Rebuild only when updating the pinned HEIF dependency or the primary-image patch.
import { build } from 'esbuild';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = process.cwd();
const packageRoot = resolve(root, 'node_modules/heic-to');
const metadata = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'));
if (metadata.version !== '1.6.6') throw new Error('Review the HEIF patch before upgrading.');
let worker = await readFile(resolve(packageRoot, 'src/worker.js'), 'utf8');
const selection = 'const image = data[0]';
if (worker.split(selection).length !== 2) throw new Error('Unexpected HEIF worker source.');
worker = worker.replace(
  selection,
  `const primary = data.filter(image => image.is_primary());
    if (primary.length !== 1) throw new Error('HEIF primary image not found');
    const image = primary[0]`,
);
worker = worker.replace('LIB_HEIF_PATH', JSON.stringify('./lib/libheif-without-unsafe-eval.js'));
const workerBuild = await build({
  stdin: { contents: worker, resolveDir: resolve(packageRoot, 'src'), loader: 'js' },
  bundle: true,
  minify: true,
  target: 'es2022',
  platform: 'browser',
  external: ['fs', 'path', 'crypto'],
  write: false,
});
const source = await readFile(resolve(packageRoot, 'src/index.js'), 'utf8');
const decoder = await build({
  stdin: { contents: source, resolveDir: resolve(packageRoot, 'src'), loader: 'js' },
  bundle: true,
  minify: true,
  target: 'es2022',
  platform: 'browser',
  format: 'esm',
  define: { WORKER_FILE_CONTENT: JSON.stringify(workerBuild.outputFiles[0].text) },
  banner: {
    js: '/*! heic-to 1.6.6 + primary-image selection patch; LGPL-3.0-or-later. Source and licenses: /licenses/ */',
  },
  write: false,
});
await mkdir(resolve(root, 'public/vendor/heif'), { recursive: true });
await writeFile(
  resolve(root, 'public/vendor/heif/decoder-1.6.6-primary-v1.js'),
  decoder.outputFiles[0].contents,
);
console.log('Built optional HEIF decoder with unique-primary selection.');
