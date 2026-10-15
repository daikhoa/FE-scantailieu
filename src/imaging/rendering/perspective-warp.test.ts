import { describe, expect, it } from 'vitest';

import { ScannerEngineError } from '../engines/scanner-engine-error';
import { warpPerspectiveRgba } from './perspective-warp';

function opaqueGrid(width: number, height: number): Uint8ClampedArray<ArrayBuffer> {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      pixels[offset] = x * 40;
      pixels[offset + 1] = y * 40;
      pixels[offset + 2] = x + y;
      pixels[offset + 3] = 255;
    }
  }
  return pixels;
}

describe('warpPerspectiveRgba', () => {
  it('preserves an identity full-frame image byte-for-byte', () => {
    const pixels = opaqueGrid(2, 2);

    const result = warpPerspectiveRgba({ dimensions: { width: 2, height: 2 }, pixels }, [
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 2, y: 2 },
      { x: 0, y: 2 },
    ]);

    expect(result.dimensions).toEqual({ width: 2, height: 2 });
    expect(result.pixels).toEqual(pixels);
    expect(result.pixels).not.toBe(pixels);
  });

  it('crops using continuous image-edge coordinates', () => {
    const pixels = opaqueGrid(4, 4);

    const result = warpPerspectiveRgba({ dimensions: { width: 4, height: 4 }, pixels }, [
      { x: 1, y: 1 },
      { x: 3, y: 1 },
      { x: 3, y: 3 },
      { x: 1, y: 3 },
    ]);

    expect(result.dimensions).toEqual({ width: 2, height: 2 });
    expect([...result.pixels]).toEqual([
      40, 40, 2, 255, 80, 40, 3, 255, 40, 80, 3, 255, 80, 80, 4, 255,
    ]);
  });

  it('uses a perspective-derived ratio instead of forcing a paper preset', () => {
    const result = warpPerspectiveRgba(
      { dimensions: { width: 8, height: 6 }, pixels: opaqueGrid(8, 6) },
      [
        { x: 1, y: 1 },
        { x: 7, y: 0 },
        { x: 6, y: 5 },
        { x: 2, y: 4 },
      ],
    );

    expect(result.dimensions).toEqual({ width: 7, height: 5 });
    expect(result.pixels).toHaveLength(7 * 5 * 4);
  });

  it('rejects invalid geometry and mismatched pixel buffers', () => {
    expect(() =>
      warpPerspectiveRgba(
        { dimensions: { width: 2, height: 2 }, pixels: new Uint8ClampedArray(3) },
        [
          { x: 0, y: 0 },
          { x: 2, y: 0 },
          { x: 2, y: 2 },
          { x: 0, y: 2 },
        ],
      ),
    ).toThrow(new ScannerEngineError('invalid-input'));

    expect(() =>
      warpPerspectiveRgba({ dimensions: { width: 2, height: 2 }, pixels: opaqueGrid(2, 2) }, [
        { x: 0, y: 0 },
        { x: 2, y: 2 },
        { x: 2, y: 0 },
        { x: 0, y: 2 },
      ]),
    ).toThrow(new ScannerEngineError('invalid-input'));

    expect(() =>
      warpPerspectiveRgba({ dimensions: { width: 2, height: 2 }, pixels: opaqueGrid(2, 2) }, [
        { x: 0, y: 0 },
        { x: 0, y: 2 },
        { x: 2, y: 2 },
        { x: 2, y: 0 },
      ]),
    ).toThrow(new ScannerEngineError('invalid-input'));
  });

  it('interpolates transparent pixels in premultiplied-alpha space', () => {
    const pixels = new Uint8ClampedArray([
      255, 0, 0, 255, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0,
    ]);

    const result = warpPerspectiveRgba({ dimensions: { width: 2, height: 2 }, pixels }, [
      { x: 0.5, y: 0.5 },
      { x: 1.5, y: 0.5 },
      { x: 1.5, y: 1.5 },
      { x: 0.5, y: 1.5 },
    ]);

    expect(result.dimensions).toEqual({ width: 1, height: 1 });
    expect([...result.pixels]).toEqual([255, 0, 0, 64]);
  });
});
