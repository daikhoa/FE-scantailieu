import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
const entry =
  "export {paperDocument} from './tests/fixtures/paper-documents';export {applyDocumentFilter} from './src/imaging/rendering/document-filter';export {restorePaperAppearance} from './src/imaging/rendering/paper-restoration';";
const bundle = async (baseline = false) => {
  const result = await build({
    stdin: { contents: entry, resolveDir: process.cwd(), loader: 'ts' },
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    plugins: baseline
      ? [
          {
            name: 'paper-v1-baseline',
            setup(b) {
              b.onLoad({ filter: /[/\\]paper-restoration\.ts$/ }, (args) => ({
                contents: execFileSync(
                  'git',
                  ['show', 'f331cf7:src/imaging/rendering/paper-restoration.ts'],
                  { encoding: 'utf8' },
                ),
                loader: 'ts',
                resolveDir: dirname(args.path),
              }));
            },
          },
        ]
      : [],
  });
  return import(
    'data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64')
  );
};
const web = await bundle(),
  before = await bundle(true);
const load = async (version) => {
  const base = resolve('public/docscan-wasm/' + version);
  const { default: factory } = await import(pathToFileURL(base + '/docscan.mjs'));
  return factory({ wasmBinary: await readFile(base + '/docscan.wasm') });
};
const native = await load('v7'),
  oldNative = await load('v6');
assert.equal(native._ds_wasm_process_opencv, undefined);
assert.equal(native._ds_wasm_process_opencv_owned, undefined);
const clone = (input) => ({ dimensions: input.dimensions, pixels: input.pixels.slice() });
const run = (module, input) => {
  const { width, height } = input.dimensions,
    pointer = module._malloc(input.pixels.length),
    points = module._malloc(64);
  assert.ok(pointer && points);
  try {
    module.HEAPU8.set(input.pixels, pointer);
    module.HEAPF64.set([0, 0, width, 0, width, height, 0, height], points / 8);
    assert.equal(module._ds_wasm_process_owned(pointer, width, height, points, 2), 0);
    assert.equal(module._ds_wasm_width(), width);
    assert.equal(module._ds_wasm_height(), height);
    return module.HEAPU8.slice(
      module._ds_wasm_output(),
      module._ds_wasm_output() + width * height * 4,
    );
  } finally {
    module._ds_wasm_release();
    module._free(points);
    module._free(pointer);
  }
};
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
const time = (fn) => {
  const t = [];
  for (let i = 0; i < 7; i++) {
    const start = performance.now();
    fn();
    if (i >= 2) t.push(performance.now() - start);
  }
  t.sort((a, b) => a - b);
  return Number(t[2].toFixed(3));
};
const pixel = (input, x, y) => input.pixels[(y * input.dimensions.width + x) * 4];
const ppm = async (path, input) => {
  const { width, height } = input.dimensions,
    rgb = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i++)
    for (let c = 0; c < 3; c++) rgb[i * 3 + c] = input.pixels[i * 4 + c];
  await writeFile(path, Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`), rgb]));
};
const output = resolve('.tmp-paper-v2/contracts');
await mkdir(output, { recursive: true });
const kinds = [
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
  'crease',
  'vertical-crease',
  'diagonal-crease',
  'faint-crease',
  'printed-band',
  'printed-column',
];
const records = [];
for (const kind of kinds) {
  const input = web.paperDocument(kind),
    policy = clone(input);
  web.restorePaperAppearance(policy);
  const old = before.applyDocumentFilter(clone(input), 'enhanced-color'),
    after = web.applyDocumentFilter(clone(input), 'enhanced-color');
  const parity = difference(after.pixels, run(native, input));
  assert.ok(parity.max <= 1 && parity.mean < 0.05, kind + ': parity ' + JSON.stringify(parity));
  const oldParity = difference(old.pixels, run(oldNative, input));
  assert.ok(oldParity.max <= 1 && oldParity.mean < 0.05, kind + ': invalid baseline');
  if (['colored', 'pastel', 'photo', 'inverse', 'flat', 'noisy', 'printed-column'].includes(kind))
    assert.equal(difference(input.pixels, policy.pixels).max, 0, kind + ': protected content');
  let shadow = null;
  if (['crease', 'vertical-crease', 'diagonal-crease', 'faint-crease'].includes(kind)) {
    const x = kind === 'vertical-crease' ? 190 : 12,
      y = kind === 'vertical-crease' ? 30 : kind === 'diagonal-crease' ? 212 : 250;
    shadow = { input: pixel(input, x, y), before: pixel(old, x, y), after: pixel(after, x, y) };
    assert.ok(shadow.after > 210 && shadow.after > shadow.before, kind + ': shadow remains');
  }
  if (kind === 'printed-band')
    for (let y = 242; y < 258; y++)
      for (let x = 40; x < 330; x++)
        for (let c = 0; c < 3; c++)
          assert.equal(policy.pixels[(y * 384 + x) * 4 + c], input.pixels[(y * 384 + x) * 4 + c]);
  assert.ok(
    policy.pixels.every((v, i) => (i % 4 === 3 ? v === 255 : v < 255)),
    'New clipping',
  );
  await ppm(`${output}/${kind}-input.ppm`, input);
  await ppm(`${output}/${kind}-policy.ppm`, policy);
  records.push({
    kind,
    parity,
    shadow,
    timingMs: {
      webBefore: time(() => before.applyDocumentFilter(clone(input), 'enhanced-color')),
      webAfter: time(() => web.applyDocumentFilter(clone(input), 'enhanced-color')),
      cppBefore: time(() => run(oldNative, input)),
      cppAfter: time(() => run(native, input)),
    },
  });
}
const high = web.paperDocument('crease', 1536, 2048),
  highAfter = web.applyDocumentFilter(clone(high), 'enhanced-color'),
  highParity = difference(highAfter.pixels, run(native, high));
assert.ok(highParity.max <= 1 && highParity.mean < 0.05, '3MP parity');
const highResolution = {
  dimensions: high.dimensions,
  parity: highParity,
  timingMs: {
    webBefore: time(() => before.applyDocumentFilter(clone(high), 'enhanced-color')),
    webAfter: time(() => web.applyDocumentFilter(clone(high), 'enhanced-color')),
    cppBefore: time(() => run(oldNative, high)),
    cppAfter: time(() => run(native, high)),
  },
};
for (let i = 0; i < 20; i++) run(native, web.paperDocument(i % 2 ? 'crease' : 'vertical-crease'));
await writeFile(`${output}/cases.txt`, kinds.join('\n') + '\n');
const manifest = JSON.parse(await readFile('public/docscan-wasm/v7/build.json', 'utf8'));
const report = {
  schema: 2,
  policy: 'paper-v2',
  baseline: 'f331cf7 / WASM v6',
  note: 'Desktop Node processing/copies; median of five warm runs after two warmups. Not phone heat, power or end-to-end codecs. Private photos excluded.',
  wasmSha256: manifest.wasm_sha256,
  wasmBytes: (await readFile('public/docscan-wasm/v7/docscan.wasm')).length,
  records,
  highResolution,
};
await writeFile('docs/paper-restoration-v2-results.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
