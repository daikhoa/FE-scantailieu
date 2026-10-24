// Kernel comparison against a frozen module from the prior revision; no OCR quality claims.
import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const baselinePath = resolve(process.argv[2] ?? '.tmp-quality/baseline-pixels.mjs');
const indexPath = resolve(process.argv[3] ?? '.tmp-quality/samples/index.json');
const reportPath = resolve(process.argv[4] ?? '.tmp-quality/quality-results.json');
const baseline = await import(pathToFileURL(baselinePath).href);
const bundled = await build({
  stdin: {
    contents:
      "export {applyDocumentFilter} from './src/imaging/rendering/document-filter'; export {warpPerspectiveRgba} from './src/imaging/rendering/perspective-warp';",
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
});
const current = await import(
  'data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64')
);
const samples = JSON.parse(await readFile(indexPath, 'utf8'));
const output = resolve(dirname(reportPath), 'comparisons');
await mkdir(output, { recursive: true });
async function ppm(path, frame) {
  const rgb = Buffer.alloc(frame.dimensions.width * frame.dimensions.height * 3);
  for (let pixel = 0; pixel < rgb.length / 3; pixel++)
    for (let c = 0; c < 3; c++) rgb[pixel * 3 + c] = frame.pixels[pixel * 4 + c];
  await writeFile(
    path,
    Buffer.concat([
      Buffer.from(`P6\n${frame.dimensions.width} ${frame.dimensions.height}\n255\n`),
      rgb,
    ]),
  );
}
const results = [];
for (const sample of samples) {
  const source = {
    dimensions: { width: sample.width, height: sample.height },
    pixels: new Uint8ClampedArray(await readFile(resolve(dirname(indexPath), sample.rgba))),
  };
  const crop = sample.corners ? current.warpPerspectiveRgba(source, sample.corners, 3000) : source;
  const before = baseline.applyDocumentFilter(
    { dimensions: crop.dimensions, pixels: crop.pixels.slice() },
    'enhanced-color',
  );
  const after = current.applyDocumentFilter(
    { dimensions: crop.dimensions, pixels: crop.pixels.slice() },
    'enhanced-color',
  );
  let changedPixels = 0,
    newClippedChannels = 0,
    brightenedChannels = 0,
    maxChange = 0,
    maxChannelDifferenceChange = 0;
  let beforeGradient = 0,
    afterGradient = 0;
  for (let offset = 0; offset < before.pixels.length; offset += 4) {
    let changed = false;
    for (let c = 0; c < 3; c++) {
      const a = before.pixels[offset + c],
        b = after.pixels[offset + c];
      maxChange = Math.max(maxChange, Math.abs(b - a));
      changed ||= a !== b;
      if (b > a) brightenedChannels++;
      if ((b === 0 && a !== 0) || (b === 255 && a !== 255)) newClippedChannels++;
    }
    if (changed) changedPixels++;
    maxChannelDifferenceChange = Math.max(
      maxChannelDifferenceChange,
      Math.abs(
        after.pixels[offset] -
          after.pixels[offset + 1] -
          (before.pixels[offset] - before.pixels[offset + 1]),
      ),
      Math.abs(
        after.pixels[offset + 1] -
          after.pixels[offset + 2] -
          (before.pixels[offset + 1] - before.pixels[offset + 2]),
      ),
    );
    if ((offset / 4) % crop.dimensions.width > 0) {
      beforeGradient += Math.abs(before.pixels[offset] - before.pixels[offset - 4]);
      afterGradient += Math.abs(after.pixels[offset] - after.pixels[offset - 4]);
    }
  }
  results.push({
    name: sample.name,
    dimensions: crop.dimensions,
    changedPixels,
    newClippedChannels,
    brightenedChannels,
    maxChannelChange: maxChange,
    maxChannelDifferenceChange,
    gradientBefore: beforeGradient,
    gradientAfter: afterGradient,
    provenance: sample.provenance,
  });
  await ppm(resolve(output, sample.name + '-before.ppm'), before);
  await ppm(resolve(output, sample.name + '-after.ppm'), after);
}
const report = {
  notes:
    'Isolated pixel kernel comparison: both filters measure the same final crop. Before is a frozen prior module. Gradient is a synthetic detail indicator, not OCR accuracy or a universal perceptual quality score. No changed resolution or codec.',
  results,
};
await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
process.stdout.write(
  JSON.stringify({
    samples: results.length,
    changed: results.filter((x) => x.changedPixels > 0).length,
    newClippedChannels: results.reduce((n, x) => n + x.newClippedChannels, 0),
    brightenedChannels: results.reduce((n, x) => n + x.brightenedChannels, 0),
    maxChannelDifferenceChange: Math.max(...results.map((x) => x.maxChannelDifferenceChange)),
  }) + '\n',
);
