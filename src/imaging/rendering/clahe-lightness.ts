import type { RgbaBackendInput } from '../engines/scanic-backend-contract';
import { adjustLabLightness, labLightness } from './lab-lightness';

/** Bounded 8×8 CLAHE on Lab L*; chroma and the input's black/highlight anchors are retained. */
export function applyClaheLightness(
  input: RgbaBackendInput,
  gray: Uint8Array<ArrayBuffer>,
  strength: number,
): void {
  if (strength <= 0) return;
  const { width, height } = input.dimensions;
  const columns = Math.min(8, width),
    rows = Math.min(8, height);
  const histograms = new Uint32Array(columns * rows * 256),
    counts = new Uint32Array(columns * rows);
  const lightness = new Uint8Array(width * height);
  let minimum = 255,
    maximum = 0;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const index = y * width + x,
        offset = index * 4;
      const value = Math.round(
        labLightness(
          input.pixels[offset] ?? 0,
          input.pixels[offset + 1] ?? 0,
          input.pixels[offset + 2] ?? 0,
        ),
      );
      lightness[index] = value;
      minimum = Math.min(minimum, value);
      maximum = Math.max(maximum, value);
      const tile =
        Math.min(rows - 1, Math.floor((y * rows) / height)) * columns +
        Math.min(columns - 1, Math.floor((x * columns) / width));
      histograms[tile * 256 + value] = (histograms[tile * 256 + value] ?? 0) + 1;
      counts[tile] = (counts[tile] ?? 0) + 1;
    }
  if (maximum - minimum < 2) return;
  const maps = new Uint8Array(histograms.length);
  for (let tile = 0; tile < counts.length; tile++) {
    const count = counts[tile] ?? 1,
      limit = Math.max(1, Math.ceil((2 * count) / 256));
    let excess = 0;
    for (let value = 0; value < 256; value++) {
      const index = tile * 256 + value;
      excess += Math.max(0, (histograms[index] ?? 0) - limit);
      histograms[index] = Math.min(limit, histograms[index] ?? 0);
    }
    const share = Math.floor(excess / 256),
      remainder = excess % 256;
    let cumulative = 0;
    for (let value = 0; value < 256; value++) {
      cumulative += (histograms[tile * 256 + value] ?? 0) + share + (value < remainder ? 1 : 0);
      maps[tile * 256 + value] = Math.round((cumulative / count) * 255);
    }
  }
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const gx = Math.max(0, Math.min(columns - 1, ((x + 0.5) * columns) / width - 0.5));
      const gy = Math.max(0, Math.min(rows - 1, ((y + 0.5) * rows) / height - 0.5));
      const left = Math.floor(gx),
        top = Math.floor(gy),
        right = Math.min(columns - 1, left + 1),
        bottom = Math.min(rows - 1, top + 1),
        dx = gx - left,
        dy = gy - top;
      const index = y * width + x,
        value = lightness[index] ?? 0;
      const mapped =
        ((maps[(top * columns + left) * 256 + value] ?? value) * (1 - dx) +
          (maps[(top * columns + right) * 256 + value] ?? value) * dx) *
          (1 - dy) +
        ((maps[(bottom * columns + left) * 256 + value] ?? value) * (1 - dx) +
          (maps[(bottom * columns + right) * 256 + value] ?? value) * dx) *
          dy;
      const delta =
        Math.max(-18, Math.min(18, mapped - value)) * strength * Math.min(1, value / 48);
      adjustLabLightness(input.pixels, index * 4, delta);
      gray[index] =
        ((input.pixels[index * 4] ?? 0) * 54 +
          (input.pixels[index * 4 + 1] ?? 0) * 183 +
          (input.pixels[index * 4 + 2] ?? 0) * 19) >>
        8;
    }
}
