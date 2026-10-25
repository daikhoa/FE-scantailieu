import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';

const root = resolve('.tmp-opencv-tune');
await mkdir(`${root}/outputs`, { recursive: true });
const manifest = JSON.parse(await readFile(`${root}/samples/index.json`, 'utf8'));
const versions = [];
for (const [name, directory] of [
  ['before', 'public/docscan-wasm/v2'],
  ['after', 'public/docscan-wasm/v3'],
]) {
  const base = resolve(directory);
  const started = performance.now();
  const { default: factory } = await import(pathToFileURL(`${base}/docscan.mjs`));
  const module = await factory({ wasmBinary: await readFile(`${base}/docscan.wasm`) });
  const metadata = JSON.parse(await readFile(`${base}/build.json`, 'utf8'));
  versions.push({ name, module, hash: metadata.wasm_sha256, setupMs: performance.now() - started });
}
function runRaster(version, rgba, width, height, preset) {
  const m = version.module;
  const pointer = m._malloc(rgba.length),
    points = m._malloc(64);
  try {
    const start = performance.now();
    m.HEAPU8.set(rgba, pointer);
    m.HEAPF64.set([0, 0, width, 0, width, height, 0, height], points / 8);
    assert.equal(m._ds_wasm_process_opencv(pointer, width, height, points, 2, preset), 0);
    const outputWidth = m._ds_wasm_width(),
      outputHeight = m._ds_wasm_height();
    const output = m.HEAPU8.slice(
      m._ds_wasm_output(),
      m._ds_wasm_output() + outputWidth * outputHeight * 4,
    );
    const ms = performance.now() - start;
    return {
      pixels: output,
      width: outputWidth,
      height: outputHeight,
      ms,
      reservedBytes: m.HEAPU8.buffer.byteLength,
    };
  } finally {
    m._ds_wasm_release();
    m._free(points);
    m._free(pointer);
  }
}
function metrics(output, source, mask, cleanPaper) {
  let paper = 0,
    ink = 0,
    paperSquares = 0,
    paperCount = 0,
    inkCount = 0,
    clipped = 0,
    colorError = 0;
  for (let i = 0; i < mask.length; i++) {
    const at = i * 4;
    const y = (54 * output[at] + 183 * output[at + 1] + 19 * output[at + 2]) / 256;
    if (mask[i] === 1) {
      paper += y;
      paperSquares += y * y;
      paperCount++;
    }
    if (mask[i] === 2) {
      ink += y;
      inkCount++;
    }
    colorError = Math.max(
      colorError,
      Math.abs(output[at] - output[at + 1] - (source[at] - source[at + 1])),
      Math.abs(output[at + 1] - output[at + 2] - (source[at + 1] - source[at + 2])),
    );
    for (let c = 0; c < 3; c++)
      if (
        source[at + c] > 0 &&
        source[at + c] < 255 &&
        (output[at + c] === 0 || output[at + c] === 255)
      )
        clipped++;
  }
  const mean = paper / paperCount,
    deviation = Math.sqrt(Math.max(0, paperSquares / paperCount - mean * mean));
  return {
    paperMean: mean,
    paperStd: deviation,
    paperRmse: Math.sqrt(deviation ** 2 + (mean - cleanPaper) ** 2),
    inkContrast: mean - ink / inkCount,
    newClipped: clipped,
    maxChannelDifferenceChange: colorError,
  };
}
const records = [];
const firstRaster = [];
for (const sample of manifest) {
  if (process.argv.includes('--development') && sample.split !== 'development') continue;
  const input = await readFile(`${root}/samples/${sample.rgba}`),
    mask = await readFile(`${root}/samples/${sample.mask}`);
  for (const preset of [0, 1, 2]) {
    for (const version of versions) {
      const output = runRaster(version, input, sample.width, sample.height, preset);
      if (!firstRaster.some((row) => row.version === version.name))
        firstRaster.push({ version: version.name, sample: sample.name, preset, ms: output.ms });
      assert.equal(output.width, sample.width);
      assert.equal(output.height, sample.height);
      const measured = metrics(output.pixels, input, mask, sample.cleanPaper);
      assert.equal(measured.newClipped, 0);
      if (version.name === 'after') assert.equal(measured.maxChannelDifferenceChange, 0);
      records.push({
        sample: sample.name,
        kind: sample.kind,
        split: sample.split,
        preset,
        version: version.name,
        ...measured,
      });
      if (preset === 1) {
        const rgb = Buffer.alloc(output.width * output.height * 3);
        for (let i = 0, j = 0; i < output.pixels.length; i += 4, j += 3)
          rgb.set(output.pixels.subarray(i, i + 3), j);
        await writeFile(
          `${root}/outputs/${sample.name}-${version.name}.ppm`,
          Buffer.concat([Buffer.from(`P6\n${output.width} ${output.height}\n255\n`), rgb]),
        );
      }
    }
  }
}
for (const sample of manifest) {
  const before = records.find(
    (r) => r.sample === sample.name && r.preset === 1 && r.version === 'before',
  );
  const after = records.find(
    (r) => r.sample === sample.name && r.preset === 1 && r.version === 'after',
  );
  if (!before || !after) continue;
  if (['shadow', 'uneven', 'underexposed'].includes(sample.kind)) {
    assert.ok(
      after.paperRmse < before.paperRmse * 0.65,
      `${sample.name}: paper correction regressed`,
    );
    assert.ok(after.inkContrast >= before.inkContrast, `${sample.name}: ink contrast regressed`);
  }
  if (sample.kind === 'faint') assert.ok(after.inkContrast > before.inkContrast * 1.15);
  if (sample.kind === 'noisy') assert.ok(after.paperStd <= before.paperStd * 1.05);
  if (sample.kind === 'crisp') assert.ok(Math.abs(after.paperMean - sample.cleanPaper) <= 3);
}
// Alternating order, one warmup per module/size. Report raw observations and median.
const timing = [];
for (const [width, height] of [
  [960, 720],
  [3000, 2250],
]) {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4,
        value = y % 70 < 4 && x > 30 && x < width - 30 ? 80 : 230;
      rgba.set([value, value, value, 255], at);
    }
  for (const v of versions) runRaster(v, rgba, width, height, 1);
  for (let repeat = 0; repeat < 6; repeat++)
    for (const v of repeat % 2 ? [...versions].reverse() : versions) {
      const out = runRaster(v, rgba, width, height, 1);
      timing.push({
        version: v.name,
        width,
        height,
        repeat,
        ms: out.ms,
        reservedBytes: out.reservedBytes,
      });
    }
}
await writeFile(
  `${root}/results.json`,
  JSON.stringify(
    {
      schema: 1,
      boundary:
        'Node WASM, same pixels/crop, warp+filter+RGBA copies; no decode/PNG/PDF/OCR/thermal measurement',
      versions: versions.map(({ name, hash, setupMs }) => ({ name, hash, setupMs })),
      firstRaster,
      quality: records,
      timing,
    },
    null,
    2,
  ),
);
for (const sample of manifest.filter((s) => s.split === 'development')) {
  const rows = records.filter((r) => r.sample === sample.name && r.preset === 1);
  console.log(
    sample.kind,
    rows
      .map(
        (r) =>
          `${r.version}: paper=${r.paperMean.toFixed(1)} sd=${r.paperStd.toFixed(1)} contrast=${r.inkContrast.toFixed(1)} rmse=${r.paperRmse.toFixed(1)}`,
      )
      .join(' | '),
  );
}
for (const [width, height] of [
  [960, 720],
  [3000, 2250],
])
  for (const v of versions) {
    const times = timing
      .filter((t) => t.width === width && t.version === v.name)
      .map((t) => t.ms)
      .sort((a, b) => a - b);
    console.log(
      `${width}x${height}/${v.name}: median ${((times[2] + times[3]) / 2).toFixed(1)} ms`,
    );
  }
