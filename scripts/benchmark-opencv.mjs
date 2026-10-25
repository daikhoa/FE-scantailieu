import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';

// Test-only RGB inputs: use the existing quality sample generator, then Pillow's
// lossless PPM conversion. No browser/JPEG/color-management cost is timed here.
const root = resolve(process.argv[3] ?? '.tmp-opencv');
await mkdir(`${root}/outputs`, { recursive: true });
const base = resolve(process.argv[2] ?? 'public/docscan-wasm/v3');
const manifest = JSON.parse(await readFile(`${base}/build.json`, 'utf8'));
const { default: factory } = await import(pathToFileURL(`${base}/docscan.mjs`));
const module = await factory({ wasmBinary: await readFile(`${base}/docscan.wasm`) });
const profiles = [
  { name: 'custom', preset: null },
  { name: 'gentle', preset: 0 },
  { name: 'balanced', preset: 1 },
  { name: 'text', preset: 2 },
];
function measure(pixels, reference, width) {
  let changed = 0,
    newClipped = 0,
    total = 0,
    gradient = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const delta = Math.abs(pixels[i + c] - reference[i + c]);
      total += delta;
      if (delta) changed++;
      if (
        reference[i + c] > 0 &&
        reference[i + c] < 255 &&
        (pixels[i + c] === 0 || pixels[i + c] === 255)
      )
        newClipped++;
    }
    if ((i / 4) % width !== 0)
      gradient +=
        Math.abs(
          54 * pixels[i] +
            183 * pixels[i + 1] +
            19 * pixels[i + 2] -
            (54 * pixels[i - 4] + 183 * pixels[i - 3] + 19 * pixels[i - 2]),
        ) / 256;
  }
  return {
    meanAbsoluteRgbChange: total / ((pixels.length / 4) * 3),
    changedChannels: changed,
    newlyClippedChannels: newClipped,
    horizontalLuminanceGradient: gradient / (pixels.length / 4),
  };
}
const cases = [];
const annotations = JSON.parse(await readFile('.tmp-quality/samples/index.json', 'utf8'));
for (const file of (await readdir(`${root}/samples`)).filter((n) => n.endsWith('.ppm')).sort()) {
  const encoded = await readFile(`${root}/samples/${file}`);
  const header = /^P6\s+(\d+)\s+(\d+)\s+255\s/.exec(encoded.toString('latin1', 0, 80));
  assert.ok(header);
  const width = Number(header[1]),
    height = Number(header[2]);
  const rgb = encoded.subarray(header[0].length);
  assert.equal(rgb.length, width * height * 3);
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
    rgba[j] = rgb[i];
    rgba[j + 1] = rgb[i + 1];
    rgba[j + 2] = rgb[i + 2];
    rgba[j + 3] = 255;
  }
  const pointer = module._malloc(rgba.length),
    points = module._malloc(64);
  try {
    module.HEAPU8.set(rgba, pointer);
    const annotation = annotations.find((sample) => sample.name === file.slice(0, -4));
    const corners = annotation?.corners?.flatMap((p) => [p.x, p.y]) ?? [
      0,
      0,
      width,
      0,
      width,
      height,
      0,
      height,
    ];
    module.HEAPF64.set(corners, points / 8);
    const result = (preset, filter) => {
      const start = performance.now();
      const status =
        preset === null
          ? module._ds_wasm_process(pointer, width, height, points, filter)
          : module._ds_wasm_process_opencv(pointer, width, height, points, filter, preset);
      assert.equal(status, 0);
      return {
        pixels: module.HEAPU8.slice(
          module._ds_wasm_output(),
          module._ds_wasm_output() + module._ds_wasm_width() * module._ds_wasm_height() * 4,
        ),
        width: module._ds_wasm_width(),
        height: module._ds_wasm_height(),
        ms: performance.now() - start,
      };
    };
    const originals = { custom: result(null, 0), opencv: result(1, 0) };
    const originalRgb = new Uint8Array(originals.opencv.width * originals.opencv.height * 3);
    for (let i = 0, j = 0; i < originals.opencv.pixels.length; i += 4, j += 3)
      originalRgb.set(originals.opencv.pixels.subarray(i, i + 3), j);
    await writeFile(
      `${root}/outputs/${file.slice(0, -4)}-source.ppm`,
      Buffer.concat([
        Buffer.from(`P6\n${originals.opencv.width} ${originals.opencv.height}\n255\n`),
        originalRgb,
      ]),
    );
    for (const { name, preset } of profiles) {
      const output = result(preset, 2);
      const reference = preset === null ? originals.custom : originals.opencv;
      assert.equal(output.width, reference.width);
      assert.equal(output.height, reference.height);
      const metrics = measure(output.pixels, reference.pixels, output.width);
      assert.equal(metrics.newlyClippedChannels, 0);
      cases.push({
        sample: file,
        profile: name,
        dimensions: { width: output.width, height: output.height },
        kernelAndCopyMs: output.ms,
        ...metrics,
      });
      const bytes = new Uint8Array(output.width * output.height * 3);
      for (let i = 0, j = 0; i < output.pixels.length; i += 4, j += 3)
        bytes.set(output.pixels.subarray(i, i + 3), j);
      await writeFile(
        `${root}/outputs/${file.slice(0, -4)}-${name}.ppm`,
        Buffer.concat([Buffer.from(`P6\n${output.width} ${output.height}\n255\n`), bytes]),
      );
    }
  } finally {
    module._ds_wasm_release();
    module._free(points);
    module._free(pointer);
  }
}
await writeFile(
  `${root}/quality-results.json`,
  JSON.stringify(
    {
      schema: 1,
      wasmSha256: manifest.wasm_sha256,
      boundary:
        'Shared annotated document crop (full frame for synthetic); native WASM raster and copies only. No OCR/thermal score; single timings are observational.',
      cases,
    },
    null,
    2,
  ),
);
console.log(
  `Compared ${cases.length} sample/profile combinations; no newly clipped enhancement channels.`,
);
