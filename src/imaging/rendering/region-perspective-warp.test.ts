import { describe, expect, it } from 'vitest';
import type { DocumentCorners } from '../../domain/document';
import { warpPerspectiveRgba } from './perspective-warp';
import { warpPerspectiveRegions, MAX_REGION_PIXELS } from './region-perspective-warp';

describe('region perspective rendering', () => {
  it.each([false, true])(
    'matches original bilinear sampling, including alpha (skew=%s)',
    async (skew) => {
      const width = 480,
        height = 360;
      const pixels = new Uint8ClampedArray(width * height * 4);
      for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 31 + Math.floor(i / 17)) % 256;
      const corners: DocumentCorners = skew
        ? [
            { x: 20, y: 5 },
            { x: 470, y: 45 },
            { x: 400, y: 355 },
            { x: 5, y: 300 },
          ]
        : [
            { x: 0, y: 0 },
            { x: width, y: 0 },
            { x: width, y: height },
            { x: 0, y: height },
          ];
      const expected = warpPerspectiveRgba({ dimensions: { width, height }, pixels }, corners, 400);
      let calls = 0;
      const actual = await warpPerspectiveRegions(
        { width, height },
        corners,
        (region) => {
          calls++;
          const patch = new Uint8ClampedArray(region.width * region.height * 4);
          for (let y = 0; y < region.height; y++)
            patch.set(
              pixels.subarray(
                ((y + region.y) * width + region.x) * 4,
                ((y + region.y) * width + region.x + region.width) * 4,
              ),
              y * region.width * 4,
            );
          return { dimensions: region, pixels: patch };
        },
        400,
      );
      expect(actual.dimensions).toEqual(expected.dimensions);
      expect(calls).toBeGreaterThan(1);
      let maximumDifference = 0;
      for (let i = 0; i < actual.pixels.length; i++)
        maximumDifference = Math.max(
          maximumDifference,
          Math.abs((actual.pixels[i] ?? 0) - (expected.pixels[i] ?? 0)),
        );
      expect(maximumDifference).toBeLessThanOrEqual(1);
    },
  );

  it('accepts a 48MP original while bounding every read and keeping final resolution', async () => {
    const dimensions = { width: 8000, height: 6000 };
    let largestRead = 0;
    const result = await warpPerspectiveRegions(
      dimensions,
      [
        { x: 0, y: 0 },
        { x: 8000, y: 0 },
        { x: 8000, y: 6000 },
        { x: 0, y: 6000 },
      ],
      (region) => {
        largestRead = Math.max(largestRead, region.width * region.height);
        return {
          dimensions: region,
          pixels: new Uint8ClampedArray(region.width * region.height * 4).fill(255),
        };
      },
      3000,
    );
    expect(result.dimensions).toEqual({ width: 3000, height: 2250 });
    expect(largestRead).toBeLessThanOrEqual(MAX_REGION_PIXELS);
    expect(result.pixels.every((value) => value === 255)).toBe(true);
  });
  it('bounds both dimensions of reads for a skinny, strongly skewed original', async () => {
    const dimensions = { width: 16000, height: 400 };
    let calls = 0;
    const result = await warpPerspectiveRegions(
      dimensions,
      [
        { x: 0, y: 0 },
        { x: 16000, y: 100 },
        { x: 15000, y: 400 },
        { x: 100, y: 300 },
      ],
      (region) => {
        calls++;
        expect(region.width).toBeLessThanOrEqual(4096);
        expect(region.height).toBeLessThanOrEqual(4096);
        expect(region.width * region.height).toBeLessThanOrEqual(MAX_REGION_PIXELS);
        return {
          dimensions: region,
          pixels: new Uint8ClampedArray(region.width * region.height * 4).fill(255),
        };
      },
      3000,
    );
    expect(calls).toBeGreaterThan(1);
    expect(Math.max(result.dimensions.width, result.dimensions.height)).toBe(3000);
    expect(result.pixels.every((value) => value === 255)).toBe(true);
  });
});
