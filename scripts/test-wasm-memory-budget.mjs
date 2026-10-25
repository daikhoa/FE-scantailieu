// Reproduce an allocation-limited browser without changing image resolution.
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const version = process.argv[2] ?? 'v6';
await mkdir('.tmp-wasm-ios', { recursive: true });
const base = resolve(`public/docscan-wasm/${version}`);
const { default: factory } = await import(pathToFileURL(`${base}/docscan.mjs`));
const width = 8064,
  height = 6048;
const source = new Uint8Array(width * height * 4);
for (let i = 0; i < source.length; i += 4) source.set([220, 215, 210, 255], i);
const successCeiling = 320 * 1024 * 1024;
let ceiling = successCeiling;
const originalGrow = WebAssembly.Memory.prototype.grow;
const records = [];
try {
  WebAssembly.Memory.prototype.grow = function (pages) {
    if (this.buffer.byteLength + pages * 65536 > ceiling)
      throw new RangeError('Test memory budget');
    return originalGrow.call(this, pages);
  };
  for (const engine of ['cpp', 'opencv']) {
    const module = await factory();
    const pointer = module._malloc(source.length),
      points = module._malloc(64);
    assert.ok(pointer && points);
    try {
      module.HEAPU8.set(source, pointer);
      module.HEAPF64.set([0, 0, width, 0, width, height, 0, height], points / 8);
      const custom = module._ds_wasm_process_owned ?? module._ds_wasm_process;
      const opencv = module._ds_wasm_process_opencv_owned ?? module._ds_wasm_process_opencv;
      const status =
        engine === 'cpp'
          ? custom(pointer, width, height, points, 2)
          : opencv(pointer, width, height, points, 2, 1);
      records.push({ engine, status, reservedBytes: module.HEAPU8.buffer.byteLength });
      assert.equal(status, 0, `${engine}: 48MP must process under ${ceiling} byte WASM budget`);
      assert.equal(module._ds_wasm_width(), 3000);
      assert.equal(module._ds_wasm_height(), 2250);
      assert.ok(module._ds_wasm_output() > 0);
    } finally {
      module._ds_wasm_release();
      module._free(points);
      module._free(pointer);
    }
  }
  // A real allocation failure must be reported as OOM, not generic processing failure.
  ceiling = 210 * 1024 * 1024;
  const lowMemory = await factory();
  const pointer = lowMemory._malloc(source.length),
    points = lowMemory._malloc(64);
  assert.ok(pointer && points);
  try {
    lowMemory.HEAPU8.set(source, pointer);
    lowMemory.HEAPF64.set([0, 0, width, 0, width, height, 0, height], points / 8);
    assert.equal(lowMemory._ds_wasm_process_owned(pointer, width, height, points, 2), 8);
    assert.equal(lowMemory._ds_wasm_output(), 0);
  } finally {
    lowMemory._ds_wasm_release();
    lowMemory._free(points);
    lowMemory._free(pointer);
  }
} finally {
  WebAssembly.Memory.prototype.grow = originalGrow;
}
await writeFile(
  '.tmp-wasm-ios/memory-budget.json',
  JSON.stringify(
    { version, ceiling: successCeiling, width, height, records, lowMemoryStatus: 8 },
    null,
    2,
  ) + '\n',
);
console.log(JSON.stringify({ version, ceiling: successCeiling, records, lowMemoryStatus: 8 }));
