import { describe, expect, it } from 'vitest';
import type { FilterMode } from '../../domain/document';
import { applyDocumentFilter } from './document-filter';
import { enhanceColorContrast } from './enhanced-color';

function softLines(color = false) {
  const width = 32,
    height = 16;
  const pixels = new Uint8ClampedArray(width * height * 4);
  const levels = [230, 230, 220, 170, 100, 80, 100, 170, 220];
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const value = levels[x] ?? 230;
      pixels.set(
        color ? [value + 10, value, value - 10, 255] : [value, value, value, 255],
        (y * width + x) * 4,
      );
    }
  return { dimensions: { width, height }, pixels };
}

function patches(colors: readonly (readonly [number, number, number, number])[]) {
  return {
    dimensions: { width: colors.length, height: 1 },
    pixels: new Uint8ClampedArray(colors.flatMap((color) => [...color])),
  };
}

describe('enhanced color preset', () => {
  const mode = 'enhanced-color' as FilterMode;

  it('clarifies soft ink edges without brightening surrounding paper or clipping ink', () => {
    const input = softLines();
    const before = input.pixels.slice();
    enhanceColorContrast(input, { darkPercentile: 0, brightPercentile: 255 });
    const edge = (8 * 32 + 4) * 4;
    expect(input.pixels[edge]).toBeLessThan(100);
    expect(input.pixels[edge]).toBeGreaterThanOrEqual(88);
    for (let offset = 0; offset < before.length; offset += 4) {
      expect(input.pixels[offset]).toBeLessThanOrEqual(before[offset] ?? 0);
      expect(input.pixels[offset]).toBeGreaterThan(0);
      expect(input.pixels[offset + 3]).toBe(255);
    }
  });

  it('retains channel differences when clarifying colored ink', () => {
    const input = softLines(true);
    enhanceColorContrast(input, { darkPercentile: 0, brightPercentile: 255 });
    const offset = (8 * 32 + 4) * 4;
    expect(input.pixels[offset + 1]).toBeLessThan(100);
    expect((input.pixels[offset] ?? 0) - (input.pixels[offset + 1] ?? 0)).toBe(10);
    expect((input.pixels[offset + 1] ?? 0) - (input.pixels[offset + 2] ?? 0)).toBe(10);
  });

  it('leaves already crisp strokes and periodic textures unchanged by the detail stage', () => {
    const crisp = softLines();
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 32; x++) {
        const value = x < 16 ? 20 : 230;
        crisp.pixels.set([value, value, value, 255], (y * 32 + x) * 4);
      }
    const before = crisp.pixels.slice();
    enhanceColorContrast(crisp, { darkPercentile: 0, brightPercentile: 255 });
    expect(crisp.pixels).toEqual(before);
    const periodic = softLines();
    const original = periodic.pixels.slice();
    enhanceColorContrast(
      periodic,
      { darkPercentile: 0, brightPercentile: 255 },
      { edgeScore: 12, periodicRatio: 1 },
    );
    expect(periodic.pixels).toEqual(original);
  });

  it('does not create strokes alongside transparent or partially transparent samples', () => {
    for (const alpha of [0, 128]) {
      const input = softLines();
      for (let y = 0; y < 16; y++) input.pixels[(y * 32 + 3) * 4 + 3] = alpha;
      enhanceColorContrast(input, { darkPercentile: 0, brightPercentile: 255 });
      expect(input.pixels[(8 * 32 + 4) * 4]).toBe(100);
      expect(input.pixels[(8 * 32 + 3) * 4 + 3]).toBe(alpha);
    }
  });

  it('does not amplify low-amplitude paper noise or isolated dark specks', () => {
    const input = softLines();
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 32; x++) {
        const value = 210 + ((x + y) % 2 === 0 ? 3 : -3);
        input.pixels.set([value, value, value, 255], (y * 32 + x) * 4);
      }
    input.pixels.set([170, 170, 170, 255], (8 * 32 + 16) * 4);
    const before = input.pixels.slice();
    enhanceColorContrast(input, { darkPercentile: 0, brightPercentile: 255 });
    expect(input.pixels).toEqual(before);
  });

  it('can clarify faint ink even when the page has too little tonal range to stretch', () => {
    const input = softLines();
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 32; x++) {
        const value = x === 8 ? 200 : 220;
        input.pixels.set([value, value, value, 255], (y * 32 + x) * 4);
      }
    enhanceColorContrast(input, { darkPercentile: 200, brightPercentile: 220 });
    expect(input.pixels[(8 * 32 + 8) * 4]).toBeLessThan(200);
    expect(input.pixels[(8 * 32 + 9) * 4]).toBe(220);
  });

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
