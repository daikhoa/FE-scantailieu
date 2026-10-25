import { refinePaperBackground } from './paper-background-field';
import type { RgbaBackendInput } from '../engines/scanic-backend-contract';

const BINS = 64;
const MAX_GRID_SIDE = 24;

function luma(input: RgbaBackendInput, x: number, y: number): number {
  const at = (y * input.dimensions.width + x) * 4;
  if (input.pixels[at + 3] !== 255) return 0;
  return (
    (54 * (input.pixels[at] ?? 0) +
      183 * (input.pixels[at + 1] ?? 0) +
      19 * (input.pixels[at + 2] ?? 0)) >>
    8
  );
}
function quantile(histogram: Uint32Array, start: number, count: number, ratio: number): number {
  const wanted = Math.max(1, Math.ceil(count * ratio));
  let seen = 0;
  for (let bin = 0; bin < BINS; bin++) {
    seen += histogram[start + bin] ?? 0;
    if (seen >= wanted) return Math.min(255, bin * 4 + 2);
  }
  return 255;
}
function percentile(values: number[], ratio: number): number {
  return values[Math.max(0, Math.ceil(values.length * ratio) - 1)] ?? 0;
}
function strokeAt(
  input: RgbaBackendInput,
  x: number,
  y: number,
  radius: number,
  center: number,
): boolean {
  const { width, height } = input.dimensions;
  const left = luma(input, Math.max(0, x - radius), y),
    right = luma(input, Math.min(width - 1, x + radius), y);
  const top = luma(input, x, Math.max(0, y - radius)),
    bottom = luma(input, x, Math.min(height - 1, y + radius));
  return (left - center > 8 && right - center > 8) || (top - center > 8 && bottom - center > 8);
}

/** Bounded paper evidence; uncertain artwork/paper is left to the existing filter. */
export function restorePaperAppearance(input: RgbaBackendInput): void {
  const { width, height } = input.dimensions;
  if (Math.min(width, height) < 192) return;
  let columns = Math.min(MAX_GRID_SIDE, Math.max(4, Math.ceil(width / 48)));
  let rows = Math.min(MAX_GRID_SIDE, Math.max(4, Math.ceil(height / 48)));
  const count = columns * rows,
    stride = Math.max(1, Math.ceil(Math.max(width, height) / 512));
  const radius = Math.max(2, Math.min(8, Math.round(Math.max(width, height) / 400)));
  const histograms = new Uint32Array(count * BINS),
    samples = new Uint32Array(count);
  for (let y = 0; y < height; y += stride)
    for (let x = 0; x < width; x += stride) {
      const at = (y * width + x) * 4;
      if (input.pixels[at + 3] !== 255) continue;
      const cell = Math.floor((y * rows) / height) * columns + Math.floor((x * columns) / width);
      const bin = luma(input, x, y) >> 2;
      histograms[cell * BINS + bin] = (histograms[cell * BINS + bin] ?? 0) + 1;
      samples[cell] = (samples[cell] ?? 0) + 1;
    }
  const levels = new Float64Array(count),
    spreads = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    levels[i] = quantile(histograms, i * BINS, samples[i] ?? 0, 0.85);
    spreads[i] = (levels[i] ?? 0) - quantile(histograms, i * BINS, samples[i] ?? 0, 0.6);
  }
  let background = new Float64Array(count * 3);
  const ink = new Float64Array(count * 3);
  const strokeMeans = new Float64Array(count);
  const backgrounds = new Uint32Array(count),
    dark = new Uint32Array(count),
    strokes = new Uint32Array(count);
  for (let y = 0; y < height; y += stride)
    for (let x = 0; x < width; x += stride) {
      const at = (y * width + x) * 4;
      if (input.pixels[at + 3] !== 255) continue;
      const cell = Math.floor((y * rows) / height) * columns + Math.floor((x * columns) / width);
      const value = luma(input, x, y),
        level = levels[cell] ?? 255;
      if (Math.abs(value - level) <= 6) {
        backgrounds[cell] = (backgrounds[cell] ?? 0) + 1;
        for (let c = 0; c < 3; c++)
          background[cell * 3 + c] = (background[cell * 3 + c] ?? 0) + (input.pixels[at + c] ?? 0);
      }
      if (value < level * 0.78) {
        dark[cell] = (dark[cell] ?? 0) + 1;
        for (let c = 0; c < 3; c++)
          ink[cell * 3 + c] = (ink[cell * 3 + c] ?? 0) + (input.pixels[at + c] ?? 0);
        if (strokeAt(input, x, y, radius, value)) {
          strokes[cell] = (strokes[cell] ?? 0) + 1;
          strokeMeans[cell] = (strokeMeans[cell] ?? 0) + value;
        }
      }
    }
  const eligible = new Uint8Array(count),
    text = new Uint8Array(count),
    neutral = new Uint8Array(count);
  const paperLevels: number[] = [];
  for (let i = 0; i < count; i++) {
    const n = backgrounds[i] ?? 0,
      d = dark[i] ?? 0,
      total = samples[i] ?? 0;
    for (let c = 0; c < 3; c++) background[i * 3 + c] = n ? (background[i * 3 + c] ?? 0) / n : 255;
    if (n < 8 || total === 0) continue;
    const r = background[i * 3] ?? 0,
      g = background[i * 3 + 1] ?? 0,
      b = background[i * 3 + 2] ?? 0;
    const maximum = Math.max(r, g, b),
      minimum = Math.min(r, g, b);
    neutral[i] = maximum - minimum <= maximum * 0.06 ? 1 : 0;
    if (
      (levels[i] ?? 0) < 90 ||
      (levels[i] ?? 0) > 252 ||
      (spreads[i] ?? 0) > 20 ||
      maximum - minimum > maximum * 0.22 ||
      d / total > 0.35
    )
      continue;
    eligible[i] = 1;
    if (
      d < 3 ||
      d / total < 0.008 ||
      (strokes[i] ?? 0) / total < 0.003 ||
      (strokes[i] ?? 0) / total > 0.18
    )
      continue;
    // Illumination tints both paper and black ink. Printed colored paper usually
    // tints the background alone; do not whiten that just because it is dark.
    const ir = (ink[i * 3] ?? 0) / d / Math.max(1, r),
      ig = (ink[i * 3 + 1] ?? 0) / d / Math.max(1, g),
      ib = (ink[i * 3 + 2] ?? 0) / d / Math.max(1, b);
    const mean = (ir + ig + ib) / 3;
    if (mean > 0.03 ? Math.max(ir, ig, ib) - Math.min(ir, ig, ib) > mean * 0.18 : neutral[i] !== 1)
      continue;
    text[i] = 1;
    paperLevels.push(levels[i] ?? 0);
  }
  if (paperLevels.length < Math.max(4, count * 0.08)) return;
  paperLevels.sort((a, b) => a - b);
  const bright = percentile(paperLevels, 0.9),
    low = percentile(paperLevels, 0.1);
  if (bright < 170) return;
  let anchors = 0;
  for (let i = 0; i < count; i++)
    if (text[i] === 1 && neutral[i] === 1 && (levels[i] ?? 0) >= bright - 12) anchors++;
  if (anchors < 2) return;
  const supported = new Uint8Array(count),
    queue: number[] = [];
  let connected = new Uint8Array(count);
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < columns; x++) {
      const i = y * columns + x;
      if (eligible[i] !== 1) continue;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          const xx = x + dx,
            yy = y + dy;
          if (xx >= 0 && xx < columns && yy >= 0 && yy < rows && text[yy * columns + xx] === 1)
            supported[i] = 1;
        }
      if (text[i] === 1 && neutral[i] === 1 && (levels[i] ?? 0) >= bright - 12) {
        connected[i] = 1;
        queue.push(i);
      }
    }
  for (const i of queue) {
    const x = i % columns,
      y = Math.floor(i / columns);
    for (const j of [
      x > 0 ? i - 1 : -1,
      x + 1 < columns ? i + 1 : -1,
      y > 0 ? i - columns : -1,
      y + 1 < rows ? i + columns : -1,
    ]) {
      if (j < 0 || supported[j] !== 1 || connected[j] === 1) continue;
      if (
        Math.abs((levels[i] ?? 0) - (levels[j] ?? 0)) >
        Math.max(14, Math.max(levels[i] ?? 0, levels[j] ?? 0) * 0.14)
      )
        continue;
      connected[j] = 1;
      queue.push(j);
    }
  }
  for (let i = 0; i < count; i++)
    strokeMeans[i] = (strokes[i] ?? 0) > 0 ? (strokeMeans[i] ?? 0) / (strokes[i] ?? 1) : 255;
  const fine = refinePaperBackground(input, { columns, rows, background, connected }, strokeMeans);
  if (bright - low < 24 && !fine.hasNarrowShadow) return;
  ({ columns, rows, background, connected } = fine);
  const target = Math.max(232, Math.min(245, bright));
  const sample = (i: number, c: number) =>
    connected[i] === 1 ? (background[i * 3 + c] ?? 255) : 0;
  // Interpolate vertically once per grid column, then horizontally per pixel.
  // Avoid allocating a closure or a full-resolution float background per pixel.
  const rowBackground = new Float64Array(columns * 3),
    rowStrength = new Float64Array(columns);
  const columnLeft = new Uint8Array(width),
    columnFraction = new Float64Array(width);
  for (let x = 0; x < width; x++) {
    const gx = Math.max(0, Math.min(columns - 1, ((x + 0.5) * columns) / width - 0.5));
    columnLeft[x] = Math.floor(gx);
    columnFraction[x] = gx - Math.floor(gx);
  }
  // Read original neighbors, including rows already written in-place.
  const ringRows = radius * 2 + 1,
    original = new Uint8Array(ringRows * width);
  const rememberRow = (y: number) => {
    for (let x = 0; x < width; x++) original[(y % ringRows) * width + x] = luma(input, x, y);
  };
  for (let y = 0; y <= Math.min(radius, height - 1); y++) rememberRow(y);
  const grayAt = (x: number, y: number) =>
    original[
      (Math.max(0, Math.min(height - 1, y)) % ringRows) * width +
        Math.max(0, Math.min(width - 1, x))
    ] ?? 0;
  for (let y = 0; y < height; y++) {
    if (y > 0 && y + radius < height) rememberRow(y + radius);
    const gy = Math.max(0, Math.min(rows - 1, ((y + 0.5) * rows) / height - 0.5));
    const top = Math.floor(gy),
      bottom = Math.min(rows - 1, top + 1),
      fy = gy - top;
    for (let column = 0; column < columns; column++) {
      const a = top * columns + column,
        b = bottom * columns + column;
      rowStrength[column] = (connected[a] ?? 0) * (1 - fy) + (connected[b] ?? 0) * fy;
      for (let c = 0; c < 3; c++)
        rowBackground[column * 3 + c] = sample(a, c) * (1 - fy) + sample(b, c) * fy;
    }
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4;
      if (input.pixels[at + 3] !== 255) continue;
      const left = columnLeft[x] ?? 0,
        right = Math.min(columns - 1, left + 1),
        fx = columnFraction[x] ?? 0;
      const strength = (rowStrength[left] ?? 0) * (1 - fx) + (rowStrength[right] ?? 0) * fx;
      if (strength === 0) continue;
      const br = Math.max(
          1,
          ((rowBackground[left * 3] ?? 0) * (1 - fx) + (rowBackground[right * 3] ?? 0) * fx) /
            strength,
        ),
        bg = Math.max(
          1,
          ((rowBackground[left * 3 + 1] ?? 0) * (1 - fx) +
            (rowBackground[right * 3 + 1] ?? 0) * fx) /
            strength,
        ),
        bb = Math.max(
          1,
          ((rowBackground[left * 3 + 2] ?? 0) * (1 - fx) +
            (rowBackground[right * 3 + 2] ?? 0) * fx) /
            strength,
        );
      const r = input.pixels[at] ?? 0,
        g = input.pixels[at + 1] ?? 0,
        b = input.pixels[at + 2] ?? 0;
      const rr = r / br,
        rg = g / bg,
        rb = b / bb,
        mean = (rr + rg + rb) / 3;
      if (Math.max(rr, rg, rb) - Math.min(rr, rg, rb) > mean * 0.1 + 0.003) continue;
      const value = (54 * r + 183 * g + 19 * b) >> 8,
        paper = (54 * br + 183 * bg + 19 * bb) / 256;
      if (
        value < paper * 0.8 &&
        !(
          (grayAt(x - radius, y) > value + 8 && grayAt(x + radius, y) > value + 8) ||
          (grayAt(x, y - radius) > value + 8 && grayAt(x, y + radius) > value + 8)
        )
      )
        continue;
      const inkProtection = 1 - 0.35 * (1 - Math.min(1, value / paper));
      const dr = r * (Math.max(0.8, Math.min(1.9, (target / br) * inkProtection)) - 1);
      const dg = g * (Math.max(0.8, Math.min(1.9, (target / bg) * inkProtection)) - 1);
      const db = b * (Math.max(0.8, Math.min(1.9, (target / bb) * inkProtection)) - 1);
      const limit = Math.min(
        1,
        dr > 0 ? Math.max(0, 254 - r) / dr : 1,
        dg > 0 ? Math.max(0, 254 - g) / dg : 1,
        db > 0 ? Math.max(0, 254 - b) / db : 1,
      );
      input.pixels[at] = r + Math.round(dr * limit * strength);
      input.pixels[at + 1] = g + Math.round(dg * limit * strength);
      input.pixels[at + 2] = b + Math.round(db * limit * strength);
    }
  }
}
