import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, resolve, join } from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const root = resolve(dirname(require.resolve('@docscan/browser')), '..');
const metadata = JSON.parse(await readFile(join(root, 'assets.json'), 'utf8'));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
for (const [file, expected] of Object.entries(metadata.sources))
  assert.equal(hash(await readFile(join(root, file))), expected, `SDK source ${file}`);
for (const [file, expected] of Object.entries(metadata.assets))
  assert.equal(hash(await readFile(join(root, 'assets', file))), expected, `SDK asset ${file}`);
assert.ok(metadata.assets['models/gcnet-2eb69a0a.onnx']);
assert.ok(metadata.assets['ort/doccornernet_lean.ort']);
assert.ok(metadata.assets['models/document-defects.onnx']);
assert.ok(metadata.assets['cpp/docscan.wasm']);
assert.ok(metadata.assets['ort/ort-wasm-simd-threaded.wasm']);
assert.ok((await readdir(join(root, 'licenses'))).length > 2);
const modules = Object.keys(metadata.sources).filter((file) => file.endsWith('.ts'));
for (const file of modules) {
  const source = await readFile(join(root, file), 'utf8');
  assert.ok(
    !source.includes('camscanner2') && !source.includes('../../../src/'),
    `No app source dependency: ${file}`,
  );
}
const config = await readFile(join(root, 'src/sdk-assets.ts'), 'utf8');
assert.ok(config.includes(metadata.base), 'asset paths belong to the package');
console.log(
  `Portable SDK ${metadata.id}: ${modules.length} source modules and ${Object.keys(metadata.assets).length} owned assets verified; no web source dependency.`,
);
