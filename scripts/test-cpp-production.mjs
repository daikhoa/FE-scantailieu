import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

// Exercise the shipped C++ binary, including tiled source reads and failure cleanup.
const currentBase = JSON.parse(await readFile('vendor/docscan-native.json', 'utf8')).base;
assert.ok(currentBase, 'generated library asset path');
const base = resolve(process.argv[2] ?? `public${currentBase}`);
if (!process.argv[2]) {
  const manifest = JSON.parse(await readFile(`${base}/build.json`, 'utf8'));
  const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
  assert.equal(digest(await readFile(`${base}/docscan.wasm`)), manifest.wasm_sha256);
  assert.equal(digest(await readFile(`${base}/docscan.mjs`)), manifest.module_sha256);
}
const { default: factory } = await import(pathToFileURL(`${base}/docscan.mjs`));
const module = await factory({ wasmBinary: await readFile(`${base}/docscan.wasm`) });
assert.equal(typeof module._ds_wasm_begin, 'function', 'production tiled ABI is required');
const width = 127,
  height = 193;
const source = new Uint8ClampedArray(width * height * 4);
for (let i = 0; i < source.length; i += 4)
  source.set([(i / 4) % 251, (i / 4) % 173, (i / 4) % 97, 255], i);
const points = module._malloc(64);
function begin(corners, maximum = 3000, w = width, h = height) {
  module.HEAPF64.set(corners, points / 8);
  return module._ds_wasm_begin(points, w, h, maximum);
}
function writePatches(input = source, sourceWidth = width) {
  const count = module._ds_wasm_patch_count();
  assert.ok(count > 0);
  for (let index = 0; index < count; index++) {
    const at = module._ds_wasm_patch(index);
    const [x, y, w, h] = Array.from(new Int32Array(module.HEAPU8.buffer, at, 4));
    assert.ok(w * h <= 1024 * 1024 && w <= 4096 && h <= 4096);
    const patch = new Uint8Array(w * h * 4);
    for (let row = 0; row < h; row++)
      patch.set(
        input.subarray(((y + row) * sourceWidth + x) * 4, ((y + row) * sourceWidth + x + w) * 4),
        row * w * 4,
      );
    const pointer = module._malloc(patch.length);
    try {
      module.HEAPU8.set(patch, pointer);
      assert.equal(module._ds_wasm_write_patch(pointer, index), 0);
    } finally {
      module._free(pointer);
    }
  }
}
function output() {
  const length = module._ds_wasm_width() * module._ds_wasm_height() * 4;
  return module.HEAPU8.slice(module._ds_wasm_output(), module._ds_wasm_output() + length);
}
try {
  assert.equal(begin([0, 0, width, 0, width, height, 0, height]), 0);
  assert.notEqual(module._ds_wasm_finish(0, 0, 0, 0, 0), 0, 'incomplete source cannot succeed');
  assert.equal(begin([0, 0, width, 0, width, height, 0, height]), 0);
  writePatches();
  assert.equal(module._ds_wasm_prepare(0, 0), 0);
  assert.equal(module._ds_wasm_finish(0, 0, 0, 0, 0), 0);
  assert.equal(module._ds_wasm_width(), width, 'full-frame output width');
  assert.equal(module._ds_wasm_height(), height, 'full-frame output height');
  assert.ok(
    output().every((value, index) => value === source[index]),
    'original full-frame preserves every byte',
  );
  for (const filter of [0, 1, 2, 3, 4]) {
    assert.equal(begin([7, 9, 120, 5, 123, 182, 4, 187], 96), 0);
    writePatches();
    assert.equal(module._ds_wasm_prepare(filter, 0), 0);
    assert.equal(module._ds_wasm_finish(filter, 90, 0, 0, 0), 0);
    assert.equal(module._ds_wasm_width(), 96);
    assert.ok(module._ds_wasm_height() <= 96);
    const pixels = output();
    assert.ok(pixels.length > 0);
    if (filter === 3 || filter === 4)
      for (let i = 0; i < pixels.length; i += 4) {
        assert.equal(pixels[i], pixels[i + 1]);
        assert.equal(pixels[i], pixels[i + 2]);
        if (filter === 4) assert.ok(pixels[i] === 0 || pixels[i] === 255);
      }
    module._ds_wasm_release();
  }
  // Freeze the approved default's pixels during this migration, including color/gray protection.
  const legacyBase = resolve('public/docscan-wasm/v8');
  const legacyFactory = (await import(pathToFileURL(`${legacyBase}/docscan.mjs`))).default;
  const legacy = await legacyFactory({ wasmBinary: await readFile(`${legacyBase}/docscan.wasm`) });
  for (const kind of ['shadow', 'gray', 'green', 'grid']) {
    const w = 384,
      h = 512;
    const pixels = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const dark = kind === 'shadow' && x >= w / 2;
        const paper = dark || (kind === 'gray' && y > 170 && y < 350) ? 110 : 235;
        const ink = y % 25 < 4 && x > 28 && x < w - 28;
        const value = ink ? (dark ? 14 : 30) : paper;
        pixels.set(
          kind === 'green' && !ink ? [130, 180, 65, 255] : [value, value, value, 255],
          (y * w + x) * 4,
        );
      }
    assert.equal(begin([0, 0, w, 0, w, h, 0, h], 3000, w, h), 0);
    writePatches(pixels, w);
    assert.equal(module._ds_wasm_prepare(2, 0), 0);
    const fw = module._ds_wasm_sample_width(),
      fh = module._ds_wasm_sample_height();
    const field = new Float32Array(fw * fh * 3);
    for (let c = 0; c < 3; c++)
      for (let y = 0; y < fh; y++)
        for (let x = 0; x < fw; x++)
          field[c * fw * fh + y * fw + x] =
            ((kind === 'shadow' && x >= fw / 2) ||
            (kind === 'gray' && y / fh > 170 / h && y / fh < 350 / h)
              ? 110
              : 235) / 255;
    const light = module._malloc(field.byteLength),
      oldLight = legacy._malloc(field.byteLength),
      oldPixels = legacy._malloc(pixels.byteLength);
    try {
      module.HEAPU8.set(new Uint8Array(field.buffer), light);
      legacy.HEAPU8.set(new Uint8Array(field.buffer), oldLight);
      legacy.HEAPU8.set(pixels, oldPixels);
      assert.equal(module._ds_wasm_finish(2, 0, light, fw, fh), 0);
      assert.equal(legacy._ds_wasm_enhance_owned(oldPixels, w, h, oldLight, fw, fh), 0);
      const actual = output(),
        at = legacy._ds_wasm_output();
      assert.ok(
        actual.every((value, index) => value === legacy.HEAPU8[at + index]),
        `${kind}: production default matches approved C++ v8 pixels`,
      );
    } finally {
      module._free(light);
      module._ds_wasm_release();
      legacy._ds_wasm_release();
      legacy._free(oldLight);
      legacy._free(oldPixels);
    }
  }
  assert.equal(begin([0, 0, 8064, 0, 8064, 6048, 0, 6048], 3000, 8064, 6048), 0);
  assert.ok(
    module.HEAPU8.buffer.byteLength <= 128 * 1024 * 1024,
    '48MP does not allocate a full source RGBA heap',
  );
  assert.ok(module._ds_wasm_patch_count() > 100, '48MP uses bounded patches');
  for (let i = 0; i < module._ds_wasm_patch_count(); i++) {
    const at = module._ds_wasm_patch(i);
    const [, , w, h] = new Int32Array(module.HEAPU8.buffer, at, 4);
    assert.ok(w * h <= 1024 * 1024);
  }
  assert.notEqual(begin([0, 0, 0, 0, 10, 10, 0, 10]), 0);
  assert.equal(module._ds_wasm_output(), 0, 'failure releases previous output');
} finally {
  module._ds_wasm_release();
  module._free(points);
}
console.log(
  'C++ production: tiled input, original bytes, filters/rotation/preview, four v8 pixel controls, 48MP bounds and failure cleanup passed.',
);
