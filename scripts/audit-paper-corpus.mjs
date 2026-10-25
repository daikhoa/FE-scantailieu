import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import assert from 'node:assert/strict';
const bundled = await build({
  stdin: {
    contents:
      "export {restorePaperAppearance} from './src/imaging/rendering/paper-restoration'; export {warpPerspectiveRgba} from './src/imaging/rendering/perspective-warp';",
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
});
const api = await import(
  'data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64')
);
const index = resolve(process.argv[2]),
  root = dirname(index),
  records = [];
for (const sample of JSON.parse(await readFile(index, 'utf8'))) {
  const bytes = await readFile(resolve(root, sample.rgba));
  assert.equal(bytes.length, sample.width * sample.height * 4);
  let input = {
    dimensions: { width: sample.width, height: sample.height },
    pixels: new Uint8ClampedArray(bytes),
  };
  if (sample.corners) input = api.warpPerspectiveRgba(input, sample.corners, 3000);
  const before = input.pixels.slice(),
    t = performance.now();
  api.restorePaperAppearance(input);
  const ms = performance.now() - t;
  const masks = sample.mask ? await readFile(resolve(root, sample.mask)) : null;
  let changed = 0,
    max = 0,
    clipped = 0;
  const paper = [[], []],
    ink = [[], []];
  for (let i = 0; i < before.length; i += 4) {
    let delta = 0;
    for (let c = 0; c < 3; c++) {
      delta = Math.max(delta, Math.abs(input.pixels[i + c] - before[i + c]));
      if (input.pixels[i + c] === 255 && before[i + c] < 255) clipped++;
    }
    if (delta) changed++;
    max = Math.max(max, delta);
    assert.equal(input.pixels[i + 3], before[i + 3]);
    if (masks) {
      const set = masks[i / 4] === 1 ? paper : masks[i / 4] === 2 ? ink : null;
      if (set) {
        set[0].push((54 * before[i] + 183 * before[i + 1] + 19 * before[i + 2]) / 256);
        set[1].push(
          (54 * input.pixels[i] + 183 * input.pixels[i + 1] + 19 * input.pixels[i + 2]) / 256,
        );
      }
    }
  }
  assert.equal(clipped, 0, 'New clipping ' + sample.name);
  const stats = (a) => {
    if (!a.length) return null;
    a.sort((a, b) => a - b);
    let sum = 0;
    for (const v of a) sum += v;
    return {
      mean: sum / a.length,
      p10: a[Math.floor(a.length * 0.1)],
      p90: a[Math.floor(a.length * 0.9)],
    };
  };
  records.push({
    name: sample.name,
    kind: sample.kind ?? sample.provenance,
    dimensions: input.dimensions,
    changedFraction: changed / (before.length / 4),
    maximumDelta: max,
    newlyClippedChannels: clipped,
    ms,
    paperBefore: stats(paper[0]),
    paperAfter: stats(paper[1]),
    inkBefore: stats(ink[0]),
    inkAfter: stats(ink[1]),
  });
}
await mkdir(dirname(resolve(process.argv[3])), { recursive: true });
await writeFile(
  process.argv[3],
  JSON.stringify(
    {
      policy: 'paper-v1',
      note: 'Additional restoration stage only. Unpaired real samples have no objective quality score; synthetic masks allow paper/ink statistics. Desktop timing is informational.',
      records,
    },
    null,
    2,
  ) + '\n',
);
console.log({
  samples: records.length,
  corrected: records.filter((r) => r.changedFraction > 0).map((r) => r.name),
});
