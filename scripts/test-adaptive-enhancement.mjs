import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const work = '.tmp-adaptive-parity';
await mkdir(work, { recursive: true });
await build({
  stdin: {
    contents:
      "export {analyzeEnhancement,applyEnhancement} from './src/imaging/restoration/adaptive-enhancement';export {createShadowSample} from './src/imaging/restoration/shadow-field';",
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: `${work}/web.mjs`,
});
const web = await import(pathToFileURL(resolve(`${work}/web.mjs`)));
const base = resolve('public/docscan-wasm/v8');
const manifest = JSON.parse(await readFile(`${base}/build.json`, 'utf8'));
const binary = await readFile(`${base}/docscan.wasm`);
assert.equal(createHash('sha256').update(binary).digest('hex'), manifest.wasm_sha256);
const { default: factory } = await import(pathToFileURL(`${base}/docscan.mjs`));
const wasm = await factory({ wasmBinary: binary });
const width = 384,
  height = 512;
for (const kind of ['shadow', 'gray', 'green', 'grid']) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const paper =
        kind === 'shadow' && x > width / 2
          ? 110
          : kind === 'gray' && y > 170 && y < 350
            ? 110
            : 235;
      const line = y % 25 < 4 && x > 28 && x < width - 28;
      const value = line ? (kind === 'shadow' && x > width / 2 ? 14 : 30) : paper;
      pixels.set(
        kind === 'green' && !line ? [130, 180, 65, 255] : [value, value, value, 255],
        (y * width + x) * 4,
      );
    }
  const source = pixels.slice(),
    input = { dimensions: { width, height }, pixels },
    sample = web.createShadowSample(input),
    plane = sample.width * sample.height;
  const field =
    kind === 'shadow' || kind === 'gray'
      ? { ...sample, data: new Float32Array(sample.data.length) }
      : undefined;
  if (field)
    for (let c = 0; c < 3; c++)
      for (let y = 0; y < sample.height; y++)
        for (let x = 0; x < sample.width; x++) {
          const dark =
            kind === 'gray'
              ? y / sample.height > 170 / 512 && y / sample.height < 350 / 512
              : x >= sample.width / 2;
          field.data[c * plane + y * sample.width + x] = (dark ? 110 : 235) / 255;
        }
  // The production periodic detector reports regular grid pages above this threshold.
  web.applyEnhancement(input, web.analyzeEnhancement(sample, field, kind === 'grid' ? 0.5 : 0));
  let pointer = 0,
    light = 0;
  try {
    pointer = wasm._malloc(source.byteLength);
    assert.ok(pointer);
    if (field) {
      light = wasm._malloc(field.data.byteLength);
      assert.ok(light);
      wasm.HEAPU8.set(new Uint8Array(field.data.buffer), light);
    }
    wasm.HEAPU8.set(source, pointer);
    assert.equal(
      wasm._ds_wasm_enhance_owned(
        pointer,
        width,
        height,
        light,
        field?.width ?? 0,
        field?.height ?? 0,
      ),
      0,
    );
    const actual = wasm.HEAPU8.slice(
      wasm._ds_wasm_output(),
      wasm._ds_wasm_output() + pixels.length,
    );
    let maximum = 0;
    for (let i = 0; i < actual.length; i++)
      maximum = Math.max(maximum, Math.abs(actual[i] - pixels[i]));
    assert.ok(maximum <= 1, `${kind}: ${maximum}`);
    await writeFile(`${work}/${kind}-source.rgba`, source);
    await writeFile(`${work}/${kind}-expected.rgba`, pixels);
    assert.equal(wasm._ds_wasm_enhance_owned(pointer, 3001, height, 0, 0, 0), 1);
    assert.equal(wasm._ds_wasm_output(), 0);
    if (field) {
      wasm.HEAPU8.set(source, pointer);
      new DataView(wasm.HEAPU8.buffer).setFloat32(light, NaN, true);
      assert.notEqual(
        wasm._ds_wasm_enhance_owned(pointer, width, height, light, field.width, field.height),
        0,
      );
      assert.equal(wasm._ds_wasm_output(), 0);
    }
    console.log(`${kind}: maximum channel delta ${maximum}; invalid inputs release output`);
  } finally {
    wasm._ds_wasm_release();
    if (light) wasm._free(light);
    if (pointer) wasm._free(pointer);
  }
}
