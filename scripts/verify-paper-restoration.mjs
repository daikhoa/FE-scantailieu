import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Deterministic policy fixtures; no private documents or network access.
const result = await build({
  stdin: {
    contents:
      "export {paperDocument} from './tests/fixtures/paper-documents'; export {applyDocumentFilter} from './src/imaging/rendering/document-filter'; export {restorePaperAppearance} from './src/imaging/rendering/paper-restoration'; export {enhanceColorContrast} from './src/imaging/rendering/enhanced-color'; export {analyzeDocumentQuality} from './src/imaging/analysis/document-quality';",
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
});
const web = await import(
  'data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64')
);
const load = async (version) => {
  const base = resolve('public/docscan-wasm/' + version);
  const { default: factory } = await import(pathToFileURL(base + '/docscan.mjs'));
  return factory({ wasmBinary: await readFile(base + '/docscan.wasm') });
};
const oldNative = await load('v5'),
  native = await load('v6');
const clone = (input) => ({ dimensions: input.dimensions, pixels: input.pixels.slice() });
const beforeWeb = (input) => {
  const q = web.analyzeDocumentQuality(input);
  web.enhanceColorContrast(input, q.brightness, q.detail, q.color);
  return input;
};
const runNative = (module, engine, input) => {
  const { width, height } = input.dimensions,
    pointer = module._malloc(input.pixels.length),
    points = module._malloc(64);
  assert.ok(pointer && points);
  try {
    module.HEAPU8.set(input.pixels, pointer);
    module.HEAPF64.set([0, 0, width, 0, width, height, 0, height], points / 8);
    const status =
      engine === 'cpp'
        ? module._ds_wasm_process_owned(pointer, width, height, points, 2)
        : module._ds_wasm_process_opencv_owned(pointer, width, height, points, 2, 1);
    assert.equal(status, 0, engine);
    assert.equal(module._ds_wasm_width(), width);
    assert.equal(module._ds_wasm_height(), height);
    return new Uint8Array(
      module.HEAPU8.slice(module._ds_wasm_output(), module._ds_wasm_output() + width * height * 4),
    );
  } finally {
    module._ds_wasm_release();
    module._free(points);
    module._free(pointer);
  }
};
const pixel = (input, x, y) => input.pixels[(y * input.dimensions.width + x) * 4];
const stats = (input) => ({
  leftPaper: pixel(input, 12, 30),
  rightPaper: pixel(input, 370, 30),
  ink: pixel(input, 16, 30),
});
const difference = (a, b) => {
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
};
const median = (a) => a.sort((x, y) => x - y)[Math.floor(a.length / 2)];
const time = (fn) => {
  const times = [];
  for (let i = 0; i < 7; i++) {
    const t = performance.now();
    fn();
    if (i >= 2) times.push(performance.now() - t);
  }
  return Number(median(times).toFixed(3));
};
const ppm = async (path, input) => {
  const { width, height } = input.dimensions,
    rgb = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i++)
    for (let c = 0; c < 3; c++) rgb[i * 3 + c] = input.pixels[i * 4 + c];
  await writeFile(path, Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`), rgb]));
};
const output = resolve('.tmp-paper-v1/contracts');
await mkdir(output, { recursive: true });
const records = [];
for (const kind of [
  'white',
  'warm',
  'colored',
  'pastel',
  'gray-panel',
  'gray-sidebar',
  'color-panel',
  'photo',
  'inverse',
  'flat',
  'noisy',
]) {
  const input = web.paperDocument(kind),
    policy = clone(input);
  web.restorePaperAppearance(policy);
  await ppm(`${output}/${kind}-input.ppm`, input);
  await ppm(`${output}/${kind}-policy.ppm`, policy);
  const before = beforeWeb(clone(input)),
    after = web.applyDocumentFilter(clone(input), 'enhanced-color'),
    cpp = runNative(native, 'cpp', input),
    opencv = runNative(native, 'opencv', input),
    oldCv = runNative(oldNative, 'opencv', input);
  const parity = difference(after.pixels, cpp);
  assert.ok(
    parity.max <= 1 && parity.mean < 0.05,
    `${kind}: JS/native parity ${JSON.stringify(parity)}`,
  );
  if (['colored', 'pastel', 'photo', 'inverse', 'flat', 'noisy'].includes(kind))
    assert.equal(
      difference(input.pixels, policy.pixels).max,
      0,
      kind + ': ambiguous content changed',
    );
  if (['white', 'warm'].includes(kind)) {
    assert.ok(pixel(policy, 12, 30) > 210);
    assert.ok(Math.abs(pixel(policy, 12, 30) - pixel(policy, 370, 30)) < 20);
    assert.ok(pixel(policy, 12, 30) - pixel(policy, 16, 30) > 160);
    assert.ok(opencv[(30 * 384 + 12) * 4] > 200, 'OpenCV supported paper remains dark');
    assert.ok(
      Math.abs(opencv[(30 * 384 + 12) * 4] - opencv[(30 * 384 + 370) * 4]) <=
        Math.abs(oldCv[(30 * 384 + 12) * 4] - oldCv[(30 * 384 + 370) * 4]),
      'OpenCV paper uniformity regressed',
    );
  }
  // Protected printed panel stays unchanged by the paper policy.
  if (kind === 'gray-panel')
    for (let y = 180; y < 330; y++)
      for (let x = 144; x < 240; x++)
        for (let c = 0; c < 3; c++)
          assert.equal(policy.pixels[(y * 384 + x) * 4 + c], input.pixels[(y * 384 + x) * 4 + c]);
  assert.ok(
    policy.pixels.every((v, i) => (i % 4 === 3 ? v === 255 : v < 255)),
    'Policy introduced channel clipping',
  );
  await ppm(`${output}/${kind}-web.ppm`, after);
  await ppm(`${output}/${kind}-opencv.ppm`, { dimensions: input.dimensions, pixels: opencv });
  records.push({
    kind,
    parity,
    paperPolicy: stats(policy),
    webBefore: stats(before),
    webAfter: stats(after),
    opencvBefore: stats({ dimensions: input.dimensions, pixels: oldCv }),
    opencvAfter: stats({ dimensions: input.dimensions, pixels: opencv }),
    timingMs: {
      webBefore: time(() => beforeWeb(clone(input))),
      webAfter: time(() => web.applyDocumentFilter(clone(input), 'enhanced-color')),
      cpp: time(() => runNative(native, 'cpp', input)),
      opencv: time(() => runNative(native, 'opencv', input)),
      opencvBefore: time(() => runNative(oldNative, 'opencv', input)),
      cppBefore: time(() => runNative(oldNative, 'cpp', input)),
    },
  });
}
const highResolution = web.paperDocument('white', 1536, 2048);
const highAfter = web.applyDocumentFilter(clone(highResolution), 'enhanced-color');
const highParity = difference(highAfter.pixels, runNative(native, 'cpp', highResolution));
assert.ok(highParity.max <= 1 && highParity.mean < 0.05, 'High-resolution parity');
const highResolutionRecord = {
  dimensions: highResolution.dimensions,
  parity: highParity,
  timingMs: {
    webBefore: time(() => beforeWeb(clone(highResolution))),
    webAfter: time(() => web.applyDocumentFilter(clone(highResolution), 'enhanced-color')),
    cpp: time(() => runNative(native, 'cpp', highResolution)),
    opencv: time(() => runNative(native, 'opencv', highResolution)),
  },
};
// Re-run without retaining native outputs: exercise resource cleanup, not a simulated engine.
for (const engine of ['cpp', 'opencv'])
  for (let i = 0; i < 20; i++)
    runNative(native, engine, web.paperDocument(i % 2 ? 'warm' : 'gray-panel'));
await writeFile(`${output}/cases.txt`, records.map((r) => r.kind).join('\n') + '\n');
const report = {
  schema: 1,
  policy: 'paper-v1',
  note: 'Synthetic exact-reference fixtures, single desktop Node process; median of five warm runs after two warmups. Not phone heat/power or universal image quality.',
  wasmSha256: JSON.parse(await readFile(resolve('public/docscan-wasm/v6/build.json'), 'utf8'))
    .wasm_sha256,
  records,
  highResolution: highResolutionRecord,
};
await writeFile('docs/paper-restoration-v1-results.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
