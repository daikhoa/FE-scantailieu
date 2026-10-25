// Pass a frozen prior Web bundle exporting warpPerspectiveRgba/applyDocumentFilter.
// Measures raster operations only: no decode, PNG/PDF, network, UI, or native DLL.
import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const baselinePath = resolve(process.argv[2] ?? '.tmp-audit-20261025/web-before.mjs');
const reportPath = resolve(process.argv[3] ?? '.tmp-audit-20261025/refinement-results.json');
const before = await import(pathToFileURL(baselinePath));
const bundle = await build({
  stdin: {
    contents:
      "export {warpPerspectiveRgba} from './src/imaging/rendering/perspective-warp'; export {applyDocumentFilter} from './src/imaging/rendering/document-filter';",
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
});
const after = await import(
  'data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64')
);
const versions = { before, after };
const native = {};
const metadata = {};
for (const [name, version] of [
  ['before', 'v3'],
  ['after', 'v4'],
]) {
  const base = resolve(`public/docscan-wasm/${version}`);
  const { default: factory } = await import(pathToFileURL(`${base}/docscan.mjs`));
  native[name] = await factory({ wasmBinary: await readFile(`${base}/docscan.wasm`) });
  metadata[name] = JSON.parse(await readFile(`${base}/build.json`, 'utf8'));
}
function corners(w, h, skew = false) {
  return skew
    ? [
        { x: w * 0.05, y: h * 0.04 },
        { x: w * 0.96, y: h * 0.02 },
        { x: w * 0.98, y: h * 0.96 },
        { x: w * 0.03, y: h * 0.97 },
      ]
    : [
        { x: 0, y: 0 },
        { x: w, y: 0 },
        { x: w, y: h },
        { x: 0, y: h },
      ];
}
function webRun(api, input, points, filter) {
  const started = performance.now();
  const result = api.applyDocumentFilter(api.warpPerspectiveRgba(input, points, 3000), filter);
  return { pixels: result.pixels, dimensions: result.dimensions, ms: performance.now() - started };
}
function nativeRun(module, input, points, filter, opencv) {
  const ptr = module._malloc(input.pixels.length),
    quad = module._malloc(64);
  try {
    const started = performance.now();
    module.HEAPU8.set(input.pixels, ptr);
    module.HEAPF64.set(
      points.flatMap((p) => [p.x, p.y]),
      quad / 8,
    );
    const { width, height } = input.dimensions;
    const code = filter === 'original' ? 0 : 2;
    assert.equal(
      opencv
        ? module._ds_wasm_process_opencv(ptr, width, height, quad, code, 1)
        : module._ds_wasm_process(ptr, width, height, quad, code),
      0,
    );
    const dimensions = { width: module._ds_wasm_width(), height: module._ds_wasm_height() };
    const result = module.HEAPU8.slice(
      module._ds_wasm_output(),
      module._ds_wasm_output() + dimensions.width * dimensions.height * 4,
    );
    return {
      pixels: result,
      dimensions,
      ms: performance.now() - started,
      reservedBytes: module.HEAPU8.buffer.byteLength,
    };
  } finally {
    module._ds_wasm_release();
    module._free(quad);
    module._free(ptr);
  }
}
function difference(a, b) {
  assert.equal(a.length, b.length);
  let max = 0,
    sum = 0,
    changed = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    max = Math.max(max, d);
    sum += d;
    if (d) changed++;
  }
  return { max, mean: sum / a.length, changed };
}
function median(a) {
  const s = [...a].sort((x, y) => x - y);
  return (s[2] + s[3]) / 2;
}
const timings = [];
for (const [width, height] of [
  [960, 720],
  [3000, 2250],
]) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const value = y % 32 < 3 && x % 140 > 16 ? 100 : 225;
      pixels.set([value, value, value, 255], (y * width + x) * 4);
    }
  const input = { dimensions: { width, height }, pixels },
    points = corners(width, height);
  for (const engine of ['web', 'cpp', 'opencv'])
    for (const filter of ['original', 'enhanced-color']) {
      const run = (name) =>
        engine === 'web'
          ? webRun(versions[name], input, points, filter)
          : nativeRun(native[name], input, points, filter, engine === 'opencv');
      const old = run('before'),
        current = run('after');
      assert.deepEqual(old.dimensions, current.dimensions);
      const delta = difference(old.pixels, current.pixels);
      if (filter === 'original') assert.equal(delta.max, 0);
      const samples = { before: [], after: [] };
      for (let i = 0; i < 6; i++)
        for (const name of i % 2 ? ['after', 'before'] : ['before', 'after'])
          samples[name].push(run(name).ms);
      timings.push({
        width,
        height,
        engine,
        filter,
        beforeMs: median(samples.before),
        afterMs: median(samples.after),
        samples,
        delta,
        ...(engine === 'web'
          ? {}
          : { beforeReservedBytes: old.reservedBytes, afterReservedBytes: current.reservedBytes }),
      });
    }
}
const quality = [];
for (const indexPath of [
  '.tmp-quality/samples/index.json',
  '.tmp-opencv-tune/samples/index.json',
]) {
  const samples = JSON.parse(await readFile(indexPath, 'utf8'));
  for (const sample of samples) {
    const pixels = new Uint8ClampedArray(await readFile(resolve(dirname(indexPath), sample.rgba)));
    const input = { dimensions: { width: sample.width, height: sample.height }, pixels };
    const points = sample.corners ?? corners(sample.width, sample.height);
    const old = webRun(before, input, points, 'enhanced-color'),
      current = webRun(after, input, points, 'enhanced-color');
    const delta = difference(old.pixels, current.pixels);
    const record = { name: sample.name, delta };
    if (sample.mask) {
      const mask = await readFile(resolve(dirname(indexPath), sample.mask));
      const measure = (output) => {
        let paper = 0,
          ink = 0,
          np = 0,
          ni = 0;
        for (let i = 0; i < mask.length; i++) {
          const y = (54 * output[i * 4] + 183 * output[i * 4 + 1] + 19 * output[i * 4 + 2]) / 256;
          if (mask[i] === 1) {
            paper += y;
            np++;
          }
          if (mask[i] === 2) {
            ink += y;
            ni++;
          }
        }
        return { paper: paper / np, ink: ink / ni, contrast: paper / np - ink / ni };
      };
      record.before = measure(old.pixels);
      record.after = measure(current.pixels);
    }
    quality.push(record);
  }
}
// Full-frame optimization must not change skewed or resized geometry.
const geometry = [];
for (const [width, height] of [
  [91, 137],
  [3200, 2400],
]) {
  const pixels = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let i = 0; i < pixels.length; i += 4) pixels[i] = (i * 13) % 251;
  const input = { dimensions: { width, height }, pixels };
  for (const skew of [false, true]) {
    const a = webRun(before, input, corners(width, height, skew), 'original');
    const b = webRun(after, input, corners(width, height, skew), 'original');
    assert.deepEqual(a.dimensions, b.dimensions);
    const delta = difference(a.pixels, b.pixels);
    assert.equal(delta.max, 0);
    geometry.push({ width, height, skew, delta });
  }
}
const report = {
  boundary:
    'Node desktop; warm raster; native includes heap input/output copy, excludes malloc/free; not phone/DLL/end-to-end/peak RAM',
  baselineWebCommit: 'ac792f610ddab8688e0a56cc18c126e9e4b52210',
  wasm: metadata,
  timings,
  quality,
  geometry,
};
await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
console.log(
  JSON.stringify(
    {
      timings: timings.map(({ samples, ...row }) => row),
      changedQuality: quality.filter((r) => r.delta.changed),
      geometryCases: geometry.length,
    },
    null,
    2,
  ),
);
