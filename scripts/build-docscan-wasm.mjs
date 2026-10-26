import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

// Rebuild algorithms only in the native project; publish a content-addressed browser artifact.
const args = process.argv.slice(2);
function option(name, fallback) {
  const at = args.indexOf(name);
  return at < 0 ? fallback : args[at + 1];
}
const native = resolve(option('--native-root', '../thuvien'));
const build = resolve(option('--build-dir', '.tmp-wasm/docscan'));
const cmake = option(
  '--cmake',
  process.platform === 'win32'
    ? 'C:/Program Files/Microsoft Visual Studio/2022/Community/Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe'
    : 'cmake',
);
const cache = await readFile(join(build, 'CMakeCache.txt'), 'utf8');
const configuredSource = cache.match(/^CMAKE_HOME_DIRECTORY:INTERNAL=(.+)$/m)?.[1]?.trim();
if (
  !configuredSource ||
  resolve(configuredSource).toLowerCase() !== join(native, 'wasm').toLowerCase()
)
  throw new Error('Configure the Emscripten build from the selected native-root/wasm first.');
const result = spawnSync(cmake, ['--build', build], { stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) throw new Error('C++ WebAssembly build failed');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const files = [
  'wasm/bridge.cpp',
  'wasm/CMakeLists.txt',
  'include/docscan/docscan.h',
  ...[
    'pixels.hpp',
    'geometry.cpp',
    'quality.cpp',
    'appearance-plan.cpp',
    'filters.cpp',
    'lab.hpp',
    'paper-restoration.hpp',
    'paper-restoration.cpp',
    'paper-field.hpp',
    'paper-field.cpp',
    'adaptive-enhancement.hpp',
    'adaptive-enhancement.cpp',
  ].map((file) => `src/${file}`),
];
const sources = Object.fromEntries(
  await Promise.all(files.map(async (file) => [file, hash(await readFile(join(native, file)))])),
);
const wasm = await readFile(join(build, 'docscan.wasm'));
const mjs = await readFile(join(build, 'docscan.mjs'));
const provenance = {
  schema: 2,
  browser_abi: 9,
  wasm_sha256: hash(wasm),
  module_sha256: hash(mjs),
  sources,
};
const version = `cpp-${hash(JSON.stringify(provenance)).slice(0, 12)}`;
const destination = resolve('public/docscan-wasm', version);
await mkdir(destination, { recursive: true });
await writeFile(join(destination, 'docscan.wasm'), wasm);
await writeFile(join(destination, 'docscan.mjs'), mjs);
await writeFile(
  join(destination, 'build.json'),
  JSON.stringify(
    {
      ...provenance,
      maximum_input_pixels: 50_000_000,
      maximum_output_side: 3000,
      maximum_patch_pixels: 1024 * 1024,
      maximum_wasm_bytes: 805306368,
      boundary:
        'browser codecs/inference -> native tiled geometry, analysis, filters, rotation -> browser encode/PDF',
    },
    null,
    2,
  ) + '\n',
);
await mkdir('vendor', { recursive: true });
await writeFile(
  'vendor/docscan-native.json',
  JSON.stringify({ base: `/docscan-wasm/${version}/` }, null, 2) + '\n',
);
console.log(`Published native browser artifact: ${version} (${wasm.length} WASM bytes).`);
