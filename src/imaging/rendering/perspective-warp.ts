import type { DocumentCorners, ImageDimensions } from '../../domain/document';
import type { RgbaBackendInput } from '../engines/scanic-backend-contract';
import { ScannerEngineError } from '../engines/scanner-engine-error';
import { isValidImageDimensions } from '../geometry/coordinates';
import { getProjectiveTransform, validateQuad } from '../geometry/quad';
import { MAX_WORKING_IMAGE_PIXELS, MAX_WORKING_IMAGE_SIDE } from '../working-image-limits';
import { resolveHighQualityOutputDimensions } from './output-resolution';

export interface RgbaImage {
  readonly dimensions: ImageDimensions;
  readonly pixels: Uint8ClampedArray<ArrayBuffer>;
}

function pixelOffset(width: number, x: number, y: number): number {
  return (y * width + x) * 4;
}

function sampleBilinear(
  input: RgbaBackendInput,
  sourceEdgeX: number,
  sourceEdgeY: number,
  output: Uint8ClampedArray<ArrayBuffer>,
  outputOffset: number,
): void {
  const sourceX = Math.max(0, Math.min(input.dimensions.width - 1, sourceEdgeX - 0.5));
  const sourceY = Math.max(0, Math.min(input.dimensions.height - 1, sourceEdgeY - 0.5));
  const left = Math.floor(sourceX);
  const top = Math.floor(sourceY);
  const right = Math.min(input.dimensions.width - 1, left + 1);
  const bottom = Math.min(input.dimensions.height - 1, top + 1);
  const horizontal = sourceX - left;
  const vertical = sourceY - top;
  const topLeftOffset = pixelOffset(input.dimensions.width, left, top);
  const topRightOffset = pixelOffset(input.dimensions.width, right, top);
  const bottomRightOffset = pixelOffset(input.dimensions.width, right, bottom);
  const bottomLeftOffset = pixelOffset(input.dimensions.width, left, bottom);
  const topLeftAlpha = (input.pixels[topLeftOffset + 3] ?? 0) / 255;
  const topRightAlpha = (input.pixels[topRightOffset + 3] ?? 0) / 255;
  const bottomRightAlpha = (input.pixels[bottomRightOffset + 3] ?? 0) / 255;
  const bottomLeftAlpha = (input.pixels[bottomLeftOffset + 3] ?? 0) / 255;
  const topLeftWeight = (1 - horizontal) * (1 - vertical) * topLeftAlpha;
  const topRightWeight = horizontal * (1 - vertical) * topRightAlpha;
  const bottomRightWeight = horizontal * vertical * bottomRightAlpha;
  const bottomLeftWeight = (1 - horizontal) * vertical * bottomLeftAlpha;
  const alpha = topLeftWeight + topRightWeight + bottomRightWeight + bottomLeftWeight;
  const red =
    (input.pixels[topLeftOffset] ?? 0) * topLeftWeight +
    (input.pixels[topRightOffset] ?? 0) * topRightWeight +
    (input.pixels[bottomRightOffset] ?? 0) * bottomRightWeight +
    (input.pixels[bottomLeftOffset] ?? 0) * bottomLeftWeight;
  const green =
    (input.pixels[topLeftOffset + 1] ?? 0) * topLeftWeight +
    (input.pixels[topRightOffset + 1] ?? 0) * topRightWeight +
    (input.pixels[bottomRightOffset + 1] ?? 0) * bottomRightWeight +
    (input.pixels[bottomLeftOffset + 1] ?? 0) * bottomLeftWeight;
  const blue =
    (input.pixels[topLeftOffset + 2] ?? 0) * topLeftWeight +
    (input.pixels[topRightOffset + 2] ?? 0) * topRightWeight +
    (input.pixels[bottomRightOffset + 2] ?? 0) * bottomRightWeight +
    (input.pixels[bottomLeftOffset + 2] ?? 0) * bottomLeftWeight;
  output[outputOffset] = alpha === 0 ? 0 : red / alpha;
  output[outputOffset + 1] = alpha === 0 ? 0 : green / alpha;
  output[outputOffset + 2] = alpha === 0 ? 0 : blue / alpha;
  output[outputOffset + 3] = alpha * 255;
}

function validateInput(
  input: RgbaBackendInput,
  corners: DocumentCorners,
  maximumOutputLongSide?: number,
): ImageDimensions {
  const [topLeft, topRight, bottomRight] = corners;
  const clockwiseTurn =
    (topRight.x - topLeft.x) * (bottomRight.y - topLeft.y) -
    (topRight.y - topLeft.y) * (bottomRight.x - topLeft.x);
  if (
    !isValidImageDimensions(input.dimensions) ||
    Math.max(input.dimensions.width, input.dimensions.height) > MAX_WORKING_IMAGE_SIDE ||
    input.dimensions.width * input.dimensions.height > MAX_WORKING_IMAGE_PIXELS ||
    input.pixels.byteLength !== input.dimensions.width * input.dimensions.height * 4 ||
    !validateQuad(corners, input.dimensions, 1).valid ||
    clockwiseTurn <= 0
  ) {
    throw new ScannerEngineError('invalid-input');
  }
  const output = resolveHighQualityOutputDimensions(
    corners,
    input.dimensions,
    maximumOutputLongSide,
  );
  if (
    Math.max(output.width, output.height) > MAX_WORKING_IMAGE_SIDE ||
    output.width * output.height > MAX_WORKING_IMAGE_PIXELS
  ) {
    throw new ScannerEngineError('out-of-memory');
  }
  return output;
}

/** Worker-safe inverse projective warp with bilinear, premultiplied-alpha sampling. */
export function warpPerspectiveRgba(
  input: RgbaBackendInput,
  corners: DocumentCorners,
  maximumOutputLongSide?: number,
): RgbaImage {
  const dimensions = validateInput(input, corners, maximumOutputLongSide);
  const transform = getProjectiveTransform(corners);
  if (transform === null) throw new ScannerEngineError('invalid-input');
  const pixels = new Uint8ClampedArray(dimensions.width * dimensions.height * 4);
  for (let y = 0; y < dimensions.height; y += 1) {
    const v = (y + 0.5) / dimensions.height;
    for (let x = 0; x < dimensions.width; x += 1) {
      const u = (x + 0.5) / dimensions.width;
      const denominator = transform.g * u + transform.h * v + 1;
      if (!Number.isFinite(denominator) || Math.abs(denominator) <= Number.EPSILON) {
        throw new ScannerEngineError('invalid-input');
      }
      const sourceEdgeX = (transform.a * u + transform.b * v + transform.c) / denominator;
      const sourceEdgeY = (transform.d * u + transform.e * v + transform.f) / denominator;
      sampleBilinear(input, sourceEdgeX, sourceEdgeY, pixels, pixelOffset(dimensions.width, x, y));
    }
  }
  return { dimensions, pixels };
}
