import { describe, expect, it } from 'vitest';

import type { RgbaBackendInput } from '../engines/scanic-backend-contract';
import { rotateOwnedRgba } from './rgba-rotation';

function image(): RgbaBackendInput {
  return {
    dimensions: { width: 2, height: 3 },
    pixels: new Uint8ClampedArray([
      1, 0, 0, 255, 2, 0, 0, 255, 3, 0, 0, 255, 4, 0, 0, 255, 5, 0, 0, 255, 6, 0, 0, 255,
    ]),
  };
}

function redChannel(input: RgbaBackendInput): number[] {
  return Array.from({ length: input.dimensions.width * input.dimensions.height }, (_, index) => {
    return input.pixels[index * 4] ?? -1;
  });
}

describe('rotateOwnedRgba', () => {
  it('reuses the owned input for a zero-degree rotation', () => {
    const input = image();
    expect(rotateOwnedRgba(input, 0)).toBe(input);
  });

  it.each([
    [90, { width: 3, height: 2 }, [5, 3, 1, 6, 4, 2]],
    [180, { width: 2, height: 3 }, [6, 5, 4, 3, 2, 1]],
    [270, { width: 3, height: 2 }, [2, 4, 6, 1, 3, 5]],
  ] as const)('rotates pixels %i degrees clockwise', (rotation, dimensions, expected) => {
    const result = rotateOwnedRgba(image(), rotation);

    expect(result.dimensions).toEqual(dimensions);
    expect(redChannel(result)).toEqual(expected);
  });

  it('rejects malformed RGBA storage', () => {
    expect(() =>
      rotateOwnedRgba(
        { dimensions: { width: 2, height: 3 }, pixels: new Uint8ClampedArray(23) },
        90,
      ),
    ).toThrow(expect.objectContaining({ code: 'invalid-input' }));
  });
});
