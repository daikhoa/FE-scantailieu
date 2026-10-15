import type { FilterMode } from '../../domain/document';
import type { RgbaBackendInput } from '../engines/scanic-backend-contract';
import { ScannerEngineError } from '../engines/scanner-engine-error';
import { isValidImageDimensions } from '../geometry/coordinates';
import { MAX_WORKING_IMAGE_PIXELS, MAX_WORKING_IMAGE_SIDE } from '../working-image-limits';
import type { RgbaImage } from './perspective-warp';

const FILTER_MODES: readonly FilterMode[] = [
  'original',
  'ocr-color',
  'grayscale',
  'black-and-white',
];

function validateInput(input: RgbaBackendInput, mode: FilterMode): void {
  const { width, height } = input.dimensions;
  if (
    !FILTER_MODES.includes(mode) ||
    !isValidImageDimensions(input.dimensions) ||
    Math.max(width, height) > MAX_WORKING_IMAGE_SIDE ||
    width * height > MAX_WORKING_IMAGE_PIXELS ||
    !(input.pixels instanceof Uint8ClampedArray) ||
    !(input.pixels.buffer instanceof ArrayBuffer) ||
    input.pixels.byteLength !== width * height * 4
  ) {
    throw new ScannerEngineError('invalid-input');
  }
}

function luminance(red: number, green: number, blue: number, alpha: number): number {
  const opaque = (54 * red + 183 * green + 19 * blue) >> 8;
  return Math.round((opaque * alpha + 255 * (255 - alpha)) / 255);
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function edgeDetail(
  gray: Uint8Array<ArrayBuffer>,
  width: number,
  height: number,
  x: number,
  y: number,
  source: number,
): number {
  const left = gray[y * width + Math.max(0, x - 1)] ?? source;
  const right = gray[y * width + Math.min(width - 1, x + 1)] ?? source;
  const top = gray[Math.max(0, y - 1) * width + x] ?? source;
  const bottom = gray[Math.min(height - 1, y + 1) * width + x] ?? source;
  return source - (left + right + top + bottom) / 4;
}

function enhancementAdjustment(source: number, localMean: number, edge: number): number {
  const localDeviation = source - localMean;
  const darkDetailContrast = localDeviation < -5 ? (localDeviation + 5) * 0.34 : 0;
  const darkEdgeMagnitude = Math.max(0, -edge - 3);
  const sharpenedDarkEdge = -darkEdgeMagnitude * 1.05;

  // OCR benefits most from darker glyph edges. Keeping the adjustment non-positive avoids
  // the bright halos and clipped paper highlights produced by symmetric unsharp masking.
  return clamp(darkDetailContrast + sharpenedDarkEdge, -46, 0);
}

function localRadius(width: number, height: number): number {
  return Math.max(2, Math.min(48, Math.round(Math.min(width, height) / 32)));
}

function illuminationRadius(width: number, height: number): number {
  return Math.max(6, Math.min(96, Math.round(Math.min(width, height) / 10)));
}

function createLuminance(input: RgbaBackendInput): Uint8Array<ArrayBuffer> {
  const output = new Uint8Array(input.dimensions.width * input.dimensions.height);
  for (let index = 0, offset = 0; index < output.length; index += 1, offset += 4) {
    output[index] = luminance(
      input.pixels[offset] ?? 0,
      input.pixels[offset + 1] ?? 0,
      input.pixels[offset + 2] ?? 0,
      input.pixels[offset + 3] ?? 0,
    );
  }
  return output;
}

function createBoxMean(
  gray: Uint8Array<ArrayBuffer>,
  width: number,
  height: number,
  radius: number,
): Uint8Array<ArrayBuffer> {
  const mean = new Uint8Array(gray.length);
  const columns = new Uint32Array(width);
  let firstRow = 0;
  let lastRow = -1;

  for (let y = 0; y < height; y += 1) {
    const wantedFirstRow = Math.max(0, y - radius);
    const wantedLastRow = Math.min(height - 1, y + radius);
    while (lastRow < wantedLastRow) {
      lastRow += 1;
      const rowOffset = lastRow * width;
      for (let x = 0; x < width; x += 1) {
        columns[x] = (columns[x] ?? 0) + (gray[rowOffset + x] ?? 0);
      }
    }
    while (firstRow < wantedFirstRow) {
      const rowOffset = firstRow * width;
      for (let x = 0; x < width; x += 1) {
        columns[x] = (columns[x] ?? 0) - (gray[rowOffset + x] ?? 0);
      }
      firstRow += 1;
    }

    const rowCount = lastRow - firstRow + 1;
    let windowSum = 0;
    for (let x = 0; x <= Math.min(width - 1, radius); x += 1) windowSum += columns[x] ?? 0;
    for (let x = 0; x < width; x += 1) {
      const firstColumn = Math.max(0, x - radius);
      const lastColumn = Math.min(width - 1, x + radius);
      mean[y * width + x] = Math.round(windowSum / (rowCount * (lastColumn - firstColumn + 1)));
      const leavingColumn = x - radius;
      const enteringColumn = x + radius + 1;
      if (leavingColumn >= 0) windowSum -= columns[leavingColumn] ?? 0;
      if (enteringColumn < width) windowSum += columns[enteringColumn] ?? 0;
    }
  }
  return mean;
}

function histogramPercentile(
  histogram: Uint32Array<ArrayBuffer>,
  count: number,
  ratio: number,
): number {
  const target = Math.ceil(count * ratio);
  let seen = 0;
  for (let value = 0; value < histogram.length; value += 1) {
    seen += histogram[value] ?? 0;
    if (seen >= target) return value;
  }
  return 255;
}

function normalizeIllumination(input: RgbaBackendInput, gray: Uint8Array<ArrayBuffer>): void {
  const { width, height } = input.dimensions;
  const background = createBoxMean(gray, width, height, illuminationRadius(width, height));
  const histogram = new Uint32Array(256);
  for (const value of background) histogram[value] = (histogram[value] ?? 0) + 1;
  const darkBackground = histogramPercentile(histogram, background.length, 0.1);
  const paperLevel = histogramPercentile(histogram, background.length, 0.9);

  // Only correct a measurable illumination gradient. This leaves intentionally tinted or
  // uniformly exposed pages unchanged and avoids amplifying sensor noise in very dark regions.
  if (paperLevel - darkBackground < 18) return;
  for (let index = 0, offset = 0; index < gray.length; index += 1, offset += 4) {
    const estimatedLight = Math.max(background[index] ?? 0, 32);
    const requestedGain = clamp(paperLevel / estimatedLight, 1, 2.25);
    const maximumChannel = Math.max(
      input.pixels[offset] ?? 0,
      input.pixels[offset + 1] ?? 0,
      input.pixels[offset + 2] ?? 0,
    );
    const gain = maximumChannel === 0 ? 1 : Math.min(requestedGain, 248 / maximumChannel);
    if (gain <= 1) continue;
    input.pixels[offset] = clampByte((input.pixels[offset] ?? 0) * gain);
    input.pixels[offset + 1] = clampByte((input.pixels[offset + 1] ?? 0) * gain);
    input.pixels[offset + 2] = clampByte((input.pixels[offset + 2] ?? 0) * gain);
    gray[index] = clampByte((gray[index] ?? 0) * gain);
  }
}

function filterPixels(
  input: RgbaBackendInput,
  mode: Exclude<FilterMode, 'original'>,
): Uint8ClampedArray<ArrayBuffer> {
  const { width, height } = input.dimensions;
  const gray = createLuminance(input);
  normalizeIllumination(input, gray);
  const output = input.pixels;
  const columns = new Uint32Array(width);
  const radius = localRadius(width, height);
  let firstRow = 0;
  let lastRow = -1;

  for (let y = 0; y < height; y += 1) {
    const wantedFirstRow = Math.max(0, y - radius);
    const wantedLastRow = Math.min(height - 1, y + radius);
    while (lastRow < wantedLastRow) {
      lastRow += 1;
      const rowOffset = lastRow * width;
      for (let x = 0; x < width; x += 1) {
        columns[x] = (columns[x] ?? 0) + (gray[rowOffset + x] ?? 0);
      }
    }
    while (firstRow < wantedFirstRow) {
      const rowOffset = firstRow * width;
      for (let x = 0; x < width; x += 1) {
        columns[x] = (columns[x] ?? 0) - (gray[rowOffset + x] ?? 0);
      }
      firstRow += 1;
    }

    const rowCount = lastRow - firstRow + 1;
    let windowSum = 0;
    for (let x = 0; x <= Math.min(width - 1, radius); x += 1) windowSum += columns[x] ?? 0;

    for (let x = 0; x < width; x += 1) {
      const firstColumn = Math.max(0, x - radius);
      const lastColumn = Math.min(width - 1, x + radius);
      const mean = windowSum / (rowCount * (lastColumn - firstColumn + 1));
      const pixelIndex = y * width + x;
      const offset = pixelIndex * 4;
      const sourceLuminance = gray[pixelIndex] ?? 0;
      let targetLuminance: number;
      if (mode === 'black-and-white') {
        targetLuminance = sourceLuminance < mean * 0.85 ? 0 : 255;
      } else {
        const adjustment = enhancementAdjustment(
          sourceLuminance,
          mean,
          edgeDetail(gray, width, height, x, y, sourceLuminance),
        );
        targetLuminance = clampByte(sourceLuminance + adjustment);
      }

      if (mode === 'ocr-color') {
        const red = input.pixels[offset] ?? 0;
        const green = input.pixels[offset + 1] ?? 0;
        const blue = input.pixels[offset + 2] ?? 0;
        const adjustment = clamp(
          targetLuminance - sourceLuminance,
          -Math.min(red, green, blue),
          248 - Math.max(red, green, blue),
        );
        output[offset] = clampByte(red + adjustment);
        output[offset + 1] = clampByte(green + adjustment);
        output[offset + 2] = clampByte(blue + adjustment);
      } else {
        output[offset] = targetLuminance;
        output[offset + 1] = targetLuminance;
        output[offset + 2] = targetLuminance;
      }
      output[offset + 3] = input.pixels[offset + 3] ?? 0;

      const leavingColumn = x - radius;
      const enteringColumn = x + radius + 1;
      if (leavingColumn >= 0) windowSum -= columns[leavingColumn] ?? 0;
      if (enteringColumn < width) windowSum += columns[enteringColumn] ?? 0;
    }
  }
  return output;
}

/** Worker-safe document enhancement. Consumes and reuses the caller-owned pixel buffer. */
export function applyDocumentFilter(input: RgbaBackendInput, mode: FilterMode): RgbaImage {
  validateInput(input, mode);
  if (mode === 'original') return input;
  filterPixels(input, mode);
  return input;
}
