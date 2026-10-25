import type { DocumentCorners, ImageDimensions, Point } from '../../domain/document';
import type { RgbaBackendInput } from '../engines/scanic-backend-contract';
import { ScannerEngineError } from '../engines/scanner-engine-error';
import { getProjectiveTransform, validateQuad } from '../geometry/quad';
import { MAX_WORKING_IMAGE_PIXELS, MAX_WORKING_IMAGE_SIDE } from '../working-image-limits';
import { resolveHighQualityOutputDimensions } from './output-resolution';
import { isFullFrameCopy, isOpaqueRgba, sampleBilinear, type RgbaImage } from './perspective-warp';

export const MAX_REGION_PIXELS = 1024 * 1024;
export const MAX_REGION_SIDE = 4096;
export interface PixelRegion extends ImageDimensions {
  readonly x: number;
  readonly y: number;
}

function validatePatch(patch: RgbaBackendInput, region: PixelRegion): void {
  if (
    patch.dimensions.width !== region.width ||
    patch.dimensions.height !== region.height ||
    patch.pixels.length !== region.width * region.height * 4
  )
    throw new ScannerEngineError('invalid-input');
}

/** Read original pixels in bounded regions; never resize/re-encode the source. */
export async function warpPerspectiveRegions(
  source: ImageDimensions,
  corners: DocumentCorners,
  read: (region: PixelRegion) => RgbaBackendInput,
  maximumOutputLongSide?: number,
): Promise<RgbaImage> {
  if (!validateQuad(corners, source, 1).valid) throw new ScannerEngineError('invalid-input');
  const dimensions = resolveHighQualityOutputDimensions(corners, source, maximumOutputLongSide);
  if (
    Math.max(dimensions.width, dimensions.height) > MAX_WORKING_IMAGE_SIDE ||
    dimensions.width * dimensions.height > MAX_WORKING_IMAGE_PIXELS
  )
    throw new ScannerEngineError('out-of-memory');
  const transform = getProjectiveTransform(corners);
  if (transform === null) throw new ScannerEngineError('invalid-input');
  const project = (x: number, y: number): Point => {
    const u = (x + 0.5) / dimensions.width;
    const v = (y + 0.5) / dimensions.height;
    const denominator = transform.g * u + transform.h * v + 1;
    if (!Number.isFinite(denominator) || Math.abs(denominator) <= Number.EPSILON)
      throw new ScannerEngineError('invalid-input');
    return {
      x: (transform.a * u + transform.b * v + transform.c) / denominator,
      y: (transform.d * u + transform.e * v + transform.f) / denominator,
    };
  };
  const pixels = new Uint8ClampedArray(dimensions.width * dimensions.height * 4);
  const fullFrameCopy = isFullFrameCopy(corners, source, dimensions);
  const tile = (x: number, y: number, width: number, height: number): void => {
    if (fullFrameCopy) {
      const region = { x, y, width, height };
      const patch = read(region);
      validatePatch(patch, region);
      // Transparent input retains the existing premultiplied-alpha sampler.
      if (isOpaqueRgba(patch.pixels)) {
        for (let row = 0; row < height; row++)
          pixels.set(
            patch.pixels.subarray(row * width * 4, (row + 1) * width * 4),
            ((y + row) * dimensions.width + x) * 4,
          );
        return;
      }
    }
    const bounds = [
      project(x, y),
      project(x + width - 1, y),
      project(x, y + height - 1),
      project(x + width - 1, y + height - 1),
    ];
    // Include both neighbours used by bilinear sampling at every output edge.
    const left = Math.max(
      0,
      Math.min(source.width - 1, Math.floor(Math.min(...bounds.map((p) => p.x)) - 0.5)),
    );
    const top = Math.max(
      0,
      Math.min(source.height - 1, Math.floor(Math.min(...bounds.map((p) => p.y)) - 0.5)),
    );
    const right = Math.min(
      source.width,
      Math.max(left + 1, Math.ceil(Math.max(...bounds.map((p) => p.x)) - 0.5) + 2),
    );
    const bottom = Math.min(
      source.height,
      Math.max(top + 1, Math.ceil(Math.max(...bounds.map((p) => p.y)) - 0.5) + 2),
    );
    const region = { x: left, y: top, width: right - left, height: bottom - top };
    if (
      region.width * region.height > MAX_REGION_PIXELS ||
      Math.max(region.width, region.height) > MAX_REGION_SIDE
    ) {
      if (width >= height && width > 1) {
        const half = Math.floor(width / 2);
        tile(x, y, half, height);
        tile(x + half, y, width - half, height);
      } else if (height > 1) {
        const half = Math.floor(height / 2);
        tile(x, y, width, half);
        tile(x, y + half, width, height - half);
      } else throw new ScannerEngineError('invalid-input');
      return;
    }
    const patch = read(region);
    validatePatch(patch, region);
    for (let row = y; row < y + height; row++)
      for (let column = x; column < x + width; column++) {
        const point = project(column, row);
        sampleBilinear(
          patch,
          point.x - left,
          point.y - top,
          pixels,
          (row * dimensions.width + column) * 4,
        );
      }
  };
  for (let y = 0; y < dimensions.height; y += 256) {
    for (let x = 0; x < dimensions.width; x += 256)
      tile(x, y, Math.min(256, dimensions.width - x), Math.min(256, dimensions.height - y));
    // The DOM fallback shares the UI thread; allow navigation/realm disposal between strips.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
  return { dimensions, pixels };
}
