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

function localRadius(width: number, height: number): number {
  return Math.max(2, Math.min(48, Math.round(Math.min(width, height) / 32)));
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

function filterPixels(
  input: RgbaBackendInput,
  mode: Exclude<FilterMode, 'original'>,
): Uint8ClampedArray<ArrayBuffer> {
  const { width, height } = input.dimensions;
  const gray = createLuminance(input);
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
        const normalized = clampByte(255 + sourceLuminance - mean);
        targetLuminance = clampByte(255 - (255 - normalized) * 1.35);
      }

      if (mode === 'ocr-color') {
        const adjustment = targetLuminance - sourceLuminance;
        output[offset] = clampByte((input.pixels[offset] ?? 0) + adjustment);
        output[offset + 1] = clampByte((input.pixels[offset + 1] ?? 0) + adjustment);
        output[offset + 2] = clampByte((input.pixels[offset + 2] ?? 0) + adjustment);
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
