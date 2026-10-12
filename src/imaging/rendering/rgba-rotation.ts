import type { QuarterTurn } from '../../domain/document';
import type { RgbaBackendInput } from '../engines/scanic-backend-contract';
import { ScannerEngineError } from '../engines/scanner-engine-error';
import { isValidImageDimensions, rotateDimensions } from '../geometry/coordinates';
import { MAX_WORKING_IMAGE_PIXELS, MAX_WORKING_IMAGE_SIDE } from '../working-image-limits';

function validate(input: RgbaBackendInput): void {
  if (
    !isValidImageDimensions(input.dimensions) ||
    Math.max(input.dimensions.width, input.dimensions.height) > MAX_WORKING_IMAGE_SIDE ||
    input.dimensions.width * input.dimensions.height > MAX_WORKING_IMAGE_PIXELS ||
    !(input.pixels instanceof Uint8ClampedArray) ||
    !(input.pixels.buffer instanceof ArrayBuffer) ||
    input.pixels.byteLength !== input.dimensions.width * input.dimensions.height * 4
  ) {
    throw new ScannerEngineError('invalid-input');
  }
}

/** Consumes worker-owned storage; a zero turn returns it without an unnecessary full-frame copy. */
export function rotateOwnedRgba(input: RgbaBackendInput, rotation: QuarterTurn): RgbaBackendInput {
  validate(input);
  if (rotation === 0) return input;
  const dimensions = rotateDimensions(input.dimensions, rotation);
  const pixels = new Uint8ClampedArray(input.pixels.byteLength);
  for (let y = 0; y < input.dimensions.height; y += 1) {
    for (let x = 0; x < input.dimensions.width; x += 1) {
      let destinationX: number;
      let destinationY: number;
      if (rotation === 90) {
        destinationX = input.dimensions.height - 1 - y;
        destinationY = x;
      } else if (rotation === 180) {
        destinationX = input.dimensions.width - 1 - x;
        destinationY = input.dimensions.height - 1 - y;
      } else {
        destinationX = y;
        destinationY = input.dimensions.width - 1 - x;
      }
      const sourceOffset = (y * input.dimensions.width + x) * 4;
      const destinationOffset = (destinationY * dimensions.width + destinationX) * 4;
      pixels[destinationOffset] = input.pixels[sourceOffset] ?? 0;
      pixels[destinationOffset + 1] = input.pixels[sourceOffset + 1] ?? 0;
      pixels[destinationOffset + 2] = input.pixels[sourceOffset + 2] ?? 0;
      pixels[destinationOffset + 3] = input.pixels[sourceOffset + 3] ?? 0;
    }
  }
  return { dimensions, pixels };
}
