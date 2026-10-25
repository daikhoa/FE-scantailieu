import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';

await mkdir('.tmp-wasm', { recursive: true });
await build({
  stdin: {
    contents:
      "export {warpPerspectiveRgba} from './src/imaging/rendering/perspective-warp'; export {applyDocumentFilter} from './src/imaging/rendering/document-filter';",
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  outfile: '.tmp-wasm/web-raster.mjs',
  bundle: true,
  format: 'esm',
  platform: 'node',
});
const web = await import(pathToFileURL(resolve('.tmp-wasm/web-raster.mjs')));
const base = resolve('public/docscan-wasm/v4');
const manifest = JSON.parse(await readFile(`${base}/build.json`, 'utf8'));
const bytes = await readFile(`${base}/docscan.wasm`);
assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest.wasm_sha256);
const { default: factory } = await import(pathToFileURL(`${base}/docscan.mjs`));
const wasm = await factory({ wasmBinary: bytes });
const records = [];
const opencvRecords = [];
for (const kind of ['soft-text', 'color', 'noise', 'faint-structured']) {
  const width = 160,
    height = 224;
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const stroke = y % 20 >= 8 && y % 20 <= 10 && x > 12 && x < 140;
      const value =
        kind === 'soft-text'
          ? stroke
            ? 130
            : 225
          : kind === 'faint-structured'
            ? x % 16 < 2
              ? 200
              : 220
            : kind === 'noise'
              ? 215 + ((x * 13 + y * 7) % 7)
              : (x * 3 + y * 5) % 256;
      pixels.set(
        [
          value,
          kind === 'color' ? (value + 65) % 256 : value,
          kind === 'color' ? (value + 120) % 256 : value,
          255,
        ],
        i,
      );
    }
  for (const skew of [false, true])
    for (const filter of ['original', 'enhanced-color']) {
      const corners = skew
        ? [
            { x: 8, y: 12 },
            { x: 150, y: 4 },
            { x: 155, y: 215 },
            { x: 4, y: 207 },
          ]
        : [
            { x: 0, y: 0 },
            { x: width, y: 0 },
            { x: width, y: height },
            { x: 0, y: height },
          ];
      const source = { dimensions: { width, height }, pixels };
      const expected = web.applyDocumentFilter(
        web.warpPerspectiveRgba(source, corners, 3000),
        filter,
      );
      const pointer = wasm._malloc(pixels.length),
        points = wasm._malloc(64);
      try {
        wasm.HEAPU8.set(pixels, pointer);
        wasm.HEAPF64.set(
          corners.flatMap((p) => [p.x, p.y]),
          points / 8,
        );
        assert.equal(
          wasm._ds_wasm_process(pointer, width, height, points, filter === 'original' ? 0 : 2),
          0,
        );
        assert.deepEqual(
          { width: wasm._ds_wasm_width(), height: wasm._ds_wasm_height() },
          expected.dimensions,
        );
        const actual = wasm.HEAPU8.subarray(
          wasm._ds_wasm_output(),
          wasm._ds_wasm_output() + expected.pixels.length,
        );
        let maximum = 0,
          total = 0;
        for (let i = 0; i < actual.length; i++) {
          const delta = Math.abs(actual[i] - expected.pixels[i]);
          maximum = Math.max(maximum, delta);
          total += delta;
        }
        const mean = total / actual.length;
        // Native bilinear rounds half values differently. Branches in the bounded detail
        // kernel can magnify a 1-level difference, so retain both maximum and mean.
        assert.ok(
          maximum <= (filter === 'original' ? 1 : 14) && mean < 0.4,
          `${kind}/${skew}/${filter}: max=${maximum}, mean=${mean}`,
        );
        assert.equal(wasm._ds_wasm_process(pointer, width, height, points, 99), 1);
        assert.equal(wasm._ds_wasm_output(), 0);
        assert.equal(wasm._ds_wasm_process(pointer, 16385, height, points, 0), 1);
        records.push({ kind, skew, filter, dimensions: expected.dimensions, maximum, mean });
        assert.equal(wasm._ds_wasm_process_opencv(pointer, width, height, points, 0, 1), 0);
        const originalOpenCv = wasm.HEAPU8.slice(
          wasm._ds_wasm_output(),
          wasm._ds_wasm_output() + expected.pixels.length,
        );
        for (const preset of [0, 1, 2]) {
          assert.equal(
            wasm._ds_wasm_process_opencv(
              pointer,
              width,
              height,
              points,
              filter === 'original' ? 0 : 2,
              preset,
            ),
            0,
          );
          assert.deepEqual(
            { width: wasm._ds_wasm_width(), height: wasm._ds_wasm_height() },
            expected.dimensions,
          );
          const actualCv = wasm.HEAPU8.subarray(
            wasm._ds_wasm_output(),
            wasm._ds_wasm_output() + expected.pixels.length,
          );
          let clipped = 0;
          for (let i = 0; i < actualCv.length; i++)
            if (
              i % 4 !== 3 &&
              originalOpenCv[i] > 0 &&
              originalOpenCv[i] < 255 &&
              (actualCv[i] === 0 || actualCv[i] === 255)
            )
              clipped++;
          assert.equal(clipped, 0, 'OpenCV enhancement introduced clipped channels');
          opencvRecords.push({ kind, skew, filter, preset, clipped });
        }
        assert.equal(wasm._ds_wasm_process_opencv(pointer, width, height, points, 2, 99), 1);
        assert.equal(wasm._ds_wasm_output(), 0);
      } finally {
        wasm._ds_wasm_release();
        wasm._free(points);
        wasm._free(pointer);
      }
    }
}
await writeFile(
  '.tmp-wasm/parity-results.json',
  JSON.stringify(
    { wasmSha256: manifest.wasm_sha256, cases: records, opencvCases: opencvRecords },
    null,
    2,
  ),
);
console.log(
  `WASM raster parity: ${records.length} image/filter/crop cases passed; invalid requests release output.`,
);
console.log(
  `OpenCV: ${opencvRecords.length} crop/filter/preset cases passed, no newly clipped filter channels.`,
);
