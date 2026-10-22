import type { FilterMode } from '../../domain/document';
import { analyzeDocumentQuality, type DocumentQualityProfile } from '../analysis/document-quality';
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

function enhancementAdjustment(
  source: number,
  localMean: number,
  edge: number,
  strength: number,
): number {
  if (strength === 0) return 0;
  const localDeviation = source - localMean;
  const darkDetailContrast = localDeviation < -5 ? (localDeviation + 5) * 0.34 : 0;
  const darkEdgeMagnitude = Math.max(0, -edge - 3);
  const sharpenedDarkEdge = -darkEdgeMagnitude * 1.05;

  // OCR benefits most from darker glyph edges. Keeping the adjustment non-positive avoids
  // the bright halos and clipped paper highlights produced by symmetric unsharp masking.
  return clamp((darkDetailContrast + sharpenedDarkEdge) * strength, -46, 0);
}

function localRadius(width: number, height: number): number {
  return Math.max(2, Math.min(48, Math.round(Math.min(width, height) / 32)));
}

function sauvolaThreshold(localMean: number, localStandardDeviation: number): number {
  const sensitivity = 0.18;
  const standardDeviationRange = 128;
  return localMean * (1 + sensitivity * (localStandardDeviation / standardDeviationRange - 1));
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

interface IlluminationGrid {
  readonly columns: number;
  readonly rows: number;
  readonly levels: Uint8Array<ArrayBuffer>;
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

function createIlluminationGrid(
  gray: Uint8Array<ArrayBuffer>,
  width: number,
  height: number,
): IlluminationGrid {
  const columns = Math.max(1, Math.min(16, width, Math.max(4, Math.round(width / 64))));
  const rows = Math.max(1, Math.min(16, height, Math.max(4, Math.round(height / 64))));
  const cellCount = columns * rows;
  const histograms = new Uint32Array(cellCount * 256);
  const counts = new Uint32Array(cellCount);
  const levels = new Uint8Array(cellCount);

  for (let y = 0; y < height; y += 1) {
    const gridY = Math.min(rows - 1, Math.floor((y * rows) / height));
    for (let x = 0; x < width; x += 1) {
      const gridX = Math.min(columns - 1, Math.floor((x * columns) / width));
      const cell = gridY * columns + gridX;
      const value = gray[y * width + x] ?? 0;
      histograms[cell * 256 + value] = (histograms[cell * 256 + value] ?? 0) + 1;
      counts[cell] = (counts[cell] ?? 0) + 1;
    }
  }

  for (let cell = 0; cell < cellCount; cell += 1) {
    const start = cell * 256;
    levels[cell] = histogramPercentile(
      histograms.subarray(start, start + 256),
      counts[cell] ?? 0,
      0.85,
    );
  }
  return { columns, rows, levels };
}

function interpolateIllumination(
  grid: IlluminationGrid,
  x: number,
  y: number,
  width: number,
  height: number,
): number {
  const gridX = ((x + 0.5) * grid.columns) / width - 0.5;
  const gridY = ((y + 0.5) * grid.rows) / height - 0.5;
  const left = Math.max(0, Math.min(grid.columns - 1, Math.floor(gridX)));
  const top = Math.max(0, Math.min(grid.rows - 1, Math.floor(gridY)));
  const right = Math.min(grid.columns - 1, left + 1);
  const bottom = Math.min(grid.rows - 1, top + 1);
  const horizontal = clamp(gridX - left, 0, 1);
  const vertical = clamp(gridY - top, 0, 1);
  const topValue =
    (grid.levels[top * grid.columns + left] ?? 0) * (1 - horizontal) +
    (grid.levels[top * grid.columns + right] ?? 0) * horizontal;
  const bottomValue =
    (grid.levels[bottom * grid.columns + left] ?? 0) * (1 - horizontal) +
    (grid.levels[bottom * grid.columns + right] ?? 0) * horizontal;
  return topValue * (1 - vertical) + bottomValue * vertical;
}

function normalizeIllumination(
  input: RgbaBackendInput,
  gray: Uint8Array<ArrayBuffer>,
  profile: DocumentQualityProfile,
): void {
  if (!profile.stages.normalizeIllumination) return;
  const { width, height } = input.dimensions;
  const illumination = createIlluminationGrid(gray, width, height);
  const paperLevel = profile.illumination.brightLevel;
  // A strong paper-shadow lift destroys dark artwork and colored covers. Color-rich pages still
  // receive mild illumination correction, while neutral paper keeps the stronger scan treatment.
  const maximumGain = profile.stages.protectColor ? 1.25 : 2.25;
  for (let y = 0, index = 0, offset = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1, index += 1, offset += 4) {
      const estimatedLight = Math.max(
        interpolateIllumination(illumination, x, y, width, height),
        32,
      );
      const requestedGain = clamp(paperLevel / estimatedLight, 1, maximumGain);
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
}

function normalizePaperTone(
  input: RgbaBackendInput,
  gray: Uint8Array<ArrayBuffer>,
  profile: DocumentQualityProfile,
): void {
  if (!profile.stages.normalizePaperTone) return;
  const paperLevel = Math.max(1, profile.illumination.brightLevel);
  const lift = Math.min(72, 238 - paperLevel);
  for (let index = 0, offset = 0; index < gray.length; index += 1, offset += 4) {
    const sourceLuminance = gray[index] ?? 0;
    const relativeTone = clamp(sourceLuminance / paperLevel, 0, 1);
    // Lift paper quadratically: bright background reaches clean white while dark glyphs receive
    // only a small adjustment and retain their local contrast for the sharpening stage.
    const adjustment = lift * relativeTone * relativeTone;
    const red = input.pixels[offset] ?? 0;
    const green = input.pixels[offset + 1] ?? 0;
    const blue = input.pixels[offset + 2] ?? 0;
    const boundedAdjustment = Math.max(0, Math.min(adjustment, 248 - Math.max(red, green, blue)));
    input.pixels[offset] = clampByte(red + boundedAdjustment);
    input.pixels[offset + 1] = clampByte(green + boundedAdjustment);
    input.pixels[offset + 2] = clampByte(blue + boundedAdjustment);
    gray[index] = clampByte(sourceLuminance + boundedAdjustment);
  }
}

function filterPixels(
  input: RgbaBackendInput,
  mode: Exclude<FilterMode, 'original'>,
): Uint8ClampedArray<ArrayBuffer> {
  const { width, height } = input.dimensions;
  const profile = analyzeDocumentQuality(input);
  const gray = createLuminance(input);
  normalizeIllumination(input, gray, profile);
  normalizePaperTone(input, gray, profile);
  const output = input.pixels;
  if (mode === 'ocr-color' && profile.stages.sharpen === 'none') return output;
  const columns = new Uint32Array(width);
  const squaredColumns = mode === 'black-and-white' ? new Float64Array(width) : null;
  const radius = localRadius(width, height);
  const sharpeningStrength =
    profile.stages.sharpen === 'none' ? 0 : profile.stages.sharpen === 'gentle' ? 0.55 : 1;
  let firstRow = 0;
  let lastRow = -1;

  for (let y = 0; y < height; y += 1) {
    const wantedFirstRow = Math.max(0, y - radius);
    const wantedLastRow = Math.min(height - 1, y + radius);
    while (lastRow < wantedLastRow) {
      lastRow += 1;
      const rowOffset = lastRow * width;
      for (let x = 0; x < width; x += 1) {
        const value = gray[rowOffset + x] ?? 0;
        columns[x] = (columns[x] ?? 0) + value;
        if (squaredColumns) squaredColumns[x] = (squaredColumns[x] ?? 0) + value * value;
      }
    }
    while (firstRow < wantedFirstRow) {
      const rowOffset = firstRow * width;
      for (let x = 0; x < width; x += 1) {
        const value = gray[rowOffset + x] ?? 0;
        columns[x] = (columns[x] ?? 0) - value;
        if (squaredColumns) squaredColumns[x] = (squaredColumns[x] ?? 0) - value * value;
      }
      firstRow += 1;
    }

    const rowCount = lastRow - firstRow + 1;
    let windowSum = 0;
    let squaredWindowSum = 0;
    for (let x = 0; x <= Math.min(width - 1, radius); x += 1) windowSum += columns[x] ?? 0;
    if (squaredColumns) {
      for (let x = 0; x <= Math.min(width - 1, radius); x += 1) {
        squaredWindowSum += squaredColumns[x] ?? 0;
      }
    }

    for (let x = 0; x < width; x += 1) {
      const firstColumn = Math.max(0, x - radius);
      const lastColumn = Math.min(width - 1, x + radius);
      const sampleCount = rowCount * (lastColumn - firstColumn + 1);
      const mean = windowSum / sampleCount;
      const pixelIndex = y * width + x;
      const offset = pixelIndex * 4;
      const sourceLuminance = gray[pixelIndex] ?? 0;
      let targetLuminance: number;
      if (squaredColumns) {
        const variance = Math.max(0, squaredWindowSum / sampleCount - mean * mean);
        const threshold = sauvolaThreshold(mean, Math.sqrt(variance));
        targetLuminance = sourceLuminance <= threshold ? 0 : 255;
      } else {
        const adjustment = enhancementAdjustment(
          sourceLuminance,
          mean,
          edgeDetail(gray, width, height, x, y, sourceLuminance),
          sharpeningStrength,
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
          Math.max(0, 248 - Math.max(red, green, blue)),
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
      if (squaredColumns) {
        if (leavingColumn >= 0) squaredWindowSum -= squaredColumns[leavingColumn] ?? 0;
        if (enteringColumn < width) squaredWindowSum += squaredColumns[enteringColumn] ?? 0;
      }
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
