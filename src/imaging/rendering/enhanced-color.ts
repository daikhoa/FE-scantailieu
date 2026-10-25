import type { DocumentQualityProfile } from '../analysis/document-quality';
import type { RgbaBackendInput } from '../engines/scanic-backend-contract';

/** Shared RGB contrast plus bounded ink detail; consumes pixels with only three row buffers. */
export function enhanceColorContrast(
  input: RgbaBackendInput,
  brightness: Pick<DocumentQualityProfile['brightness'], 'darkPercentile' | 'brightPercentile'>,
  detail?: Pick<DocumentQualityProfile['detail'], 'edgeScore' | 'periodicRatio'>,
  color?: DocumentQualityProfile['color'],
): void {
  const { darkPercentile, brightPercentile } = brightness;
  // A nearly flat surface has no reliable black/white reference to stretch.
  const stretch = brightPercentile - darkPercentile >= 32;
  const range = brightPercentile - darkPercentile;
  // Sparse, faint neutral strokes have edge evidence but much less high-frequency
  // energy than grain. Keep paper fixed; avoid stretching a noisy/colored field.
  const faintInk =
    !stretch &&
    range >= 8 &&
    color?.kind === 'mostly-neutral' &&
    detail !== undefined &&
    detail.edgeScore >= 0.3 &&
    detail.edgeScore <= range * 0.18 &&
    (detail.periodicRatio ?? 0) < 0.18;
  const black = Math.max(0, Math.min(40, darkPercentile - 8));
  const white = Math.max(215, Math.min(255, brightPercentile + 8));
  const blackTarget = black * 0.35;
  const whiteTarget = white + (255 - white) * 0.65;
  const curve = new Uint8Array(256);
  for (let value = 1; value < 255; value += 1) {
    if (!stretch) {
      curve[value] = faintInk
        ? Math.max(
            1,
            Math.round(value - Math.min(12, Math.max(0, brightPercentile - value) * 0.35)),
          )
        : value;
      continue;
    }
    let mapped: number;
    if (value < black) mapped = (value * blackTarget) / black;
    else if (value <= white)
      mapped = blackTarget + ((value - black) * (whiteTarget - blackTarget)) / (white - black);
    else mapped = whiteTarget + ((value - white) * (255 - whiteTarget)) / (255 - white);
    // Soft toe/shoulder retain existing extremes without introducing clipped pixels.
    curve[value] = Math.max(1, Math.min(254, Math.round(mapped)));
  }
  curve[255] = 255;
  const { width, height } = input.dimensions;
  const pixels = input.pixels;
  const sharpen =
    width >= 3 &&
    height >= 3 &&
    (detail?.edgeScore ?? 0) < 42 &&
    (detail?.periodicRatio ?? 0) < 0.25;
  if (!sharpen) {
    if (!stretch && !faintInk) return;
    for (let offset = 0; offset < pixels.length; offset += 4) {
      if (pixels[offset + 3] === 0) continue;
      pixels[offset] = curve[pixels[offset] ?? 0] ?? 0;
      pixels[offset + 1] = curve[pixels[offset + 1] ?? 0] ?? 0;
      pixels[offset + 2] = curve[pixels[offset + 2] ?? 0] ?? 0;
    }
    return;
  }
  const mapRow = (y: number, row: Uint8Array) => {
    let uniformLevel = -1;
    for (let x = 0, offset = y * width * 4; x < width; x++, offset += 4) {
      if (pixels[offset + 3] !== 0) {
        pixels[offset] = curve[pixels[offset] ?? 0] ?? 0;
        pixels[offset + 1] = curve[pixels[offset + 1] ?? 0] ?? 0;
        pixels[offset + 2] = curve[pixels[offset + 2] ?? 0] ?? 0;
      }
      row[x] =
        (54 * (pixels[offset] ?? 0) +
          183 * (pixels[offset + 1] ?? 0) +
          19 * (pixels[offset + 2] ?? 0)) >>
        8;
      if (x === 0) uniformLevel = row[x] ?? 0;
      else if (row[x] !== uniformLevel) uniformLevel = -1;
    }
    return uniformLevel;
  };
  let previous = new Uint8Array(width),
    current = new Uint8Array(width),
    next = new Uint8Array(width);
  let previousLevel = mapRow(0, previous),
    currentLevel = mapRow(1, current),
    nextLevel = mapRow(2, next);
  for (let y = 1; y < height - 1; y++) {
    const uniformRows =
      currentLevel >= 0 && previousLevel === currentLevel && nextLevel === currentLevel;
    if (!uniformRows) {
      for (let x = 1, offset = (y * width + 1) * 4; x < width - 1; x++, offset += 4) {
        const center = current[x] ?? 0,
          left = current[x - 1] ?? center,
          right = current[x + 1] ?? center,
          top = previous[x] ?? center,
          bottom = next[x] ?? center;
        const darkDetail = (left + right + top + bottom) / 4 - center;
        if (darkDetail <= 6 || darkDetail >= 48) continue;
        // A stroke continues along at least one axis; isolated grain does not.
        if (
          Math.min(
            Math.max(Math.abs(left - center), Math.abs(right - center)),
            Math.max(Math.abs(top - center), Math.abs(bottom - center)),
          ) > 8
        )
          continue;
        // Partial/hidden pixels must never create visible strokes in adjacent opaque ink.
        if (
          pixels[offset + 3] !== 255 ||
          pixels[offset - 1] !== 255 ||
          pixels[offset + 7] !== 255 ||
          pixels[offset - width * 4 + 3] !== 255 ||
          pixels[offset + width * 4 + 3] !== 255
        )
          continue;
        const red = pixels[offset] ?? 0,
          green = pixels[offset + 1] ?? 0,
          blue = pixels[offset + 2] ?? 0;
        const minimum = Math.min(red, green, blue),
          maximum = Math.max(red, green, blue);
        const strength =
          0.65 * Math.min(1, (48 - darkDetail) / 16) * (maximum - minimum > 48 ? 0.35 : 1);
        // Darken ink only: no bright paper halos, no channel clipping or hue shifts.
        const adjustment = Math.round(
          Math.max(0, Math.min(12, minimum - 1, (darkDetail - 6) * strength)),
        );
        pixels[offset] = red - adjustment;
        pixels[offset + 1] = green - adjustment;
        pixels[offset + 2] = blue - adjustment;
      }
    }
    const reusable = previous;
    previous = current;
    current = next;
    next = reusable;
    previousLevel = currentLevel;
    currentLevel = nextLevel;
    if (y + 2 < height) nextLevel = mapRow(y + 2, next);
  }
}
