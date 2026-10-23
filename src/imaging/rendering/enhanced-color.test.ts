import { describe, expect, it } from 'vitest';
import type { FilterMode } from '../../domain/document';
import { applyDocumentFilter } from './document-filter';

function patches(colors: readonly (readonly [number, number, number, number])[]) {
  return {
    dimensions: { width: colors.length, height: 1 },
    pixels: new Uint8ClampedArray(colors.flatMap((color) => [...color])),
  };
}

describe('enhanced color preset', () => {
  const mode = 'enhanced-color' as FilterMode;

  it('restores contrast in a hazy color cover while retaining its colored ink', () => {
    const input = patches([
      [55, 55, 55, 255],
      [225, 225, 225, 255],
      [190, 75, 85, 255],
      [65, 115, 190, 255],
    ]);
    const result = applyDocumentFilter(input, mode);
    expect(result).toBe(input);
    expect(result.pixels[0]).toBeLessThan(40);
    expect(result.pixels[4]).toBeGreaterThan(235);
    expect((result.pixels[4] ?? 0) - (result.pixels[0] ?? 0)).toBeGreaterThan(195);
    expect((result.pixels[8] ?? 0) - (result.pixels[9] ?? 0)).toBeGreaterThan(115);
    expect((result.pixels[14] ?? 0) - (result.pixels[12] ?? 0)).toBeGreaterThan(125);
  });

  it('keeps a flat neutral or colored surface unchanged', () => {
    for (const color of [
      [180, 180, 180, 255],
      [60, 100, 180, 255],
    ] as const) {
      const input = patches(Array.from({ length: 32 }, () => color));
      const before = input.pixels.slice();
      applyDocumentFilter(input, mode);
      expect(input.pixels).toEqual(before);
    }
  });

  it('preserves tonal ordering, white highlights and deep blacks without new clipping', () => {
    const input = patches(Array.from({ length: 256 }, (_, value) => [value, value, value, 255]));
    applyDocumentFilter(input, mode);
    expect(Array.from(input.pixels.slice(0, 4))).toEqual([0, 0, 0, 255]);
    expect(Array.from(input.pixels.slice(-4))).toEqual([255, 255, 255, 255]);
    for (let value = 1; value < 255; value += 1) {
      const offset = value * 4;
      expect(input.pixels[offset]).toBeGreaterThan(0);
      expect(input.pixels[offset]).toBeLessThan(255);
      expect(input.pixels[offset]).toBeGreaterThanOrEqual(input.pixels[offset - 4] ?? 0);
      expect(input.pixels[offset]).toBe(input.pixels[offset + 1]);
      expect(input.pixels[offset]).toBe(input.pixels[offset + 2]);
    }
  });

  it('leaves transparent samples and alpha unchanged', () => {
    const input = patches([
      [55, 55, 55, 255],
      [225, 225, 225, 255],
      [30, 80, 140, 0],
    ]);
    applyDocumentFilter(input, mode);
    expect(Array.from(input.pixels.slice(-4))).toEqual([30, 80, 140, 0]);
  });

  it('retains visible faint marks at both tonal extremes and preserves partial alpha', () => {
    const input = patches([
      [55, 55, 55, 255],
      [225, 225, 225, 255],
      [20, 20, 20, 255],
      [30, 30, 30, 255],
      [235, 235, 235, 255],
      [245, 245, 245, 255],
      [80, 120, 170, 128],
    ]);
    applyDocumentFilter(input, mode);
    expect((input.pixels[12] ?? 0) - (input.pixels[8] ?? 0)).toBeGreaterThanOrEqual(3);
    expect((input.pixels[20] ?? 0) - (input.pixels[16] ?? 0)).toBeGreaterThanOrEqual(3);
    expect(input.pixels[27]).toBe(128);
    expect(input.pixels[26]).toBeGreaterThan(input.pixels[25] ?? 0);
    expect(input.pixels[25]).toBeGreaterThan(input.pixels[24] ?? 0);
  });
});
