import { describe, expect, it } from 'vitest';

import type { RgbaBackendInput } from '../engines/scanic-backend-contract';
import { applyDocumentFilter } from './document-filter';

function image(
  width: number,
  height: number,
  pixel: (x: number, y: number) => readonly [number, number, number, number],
): RgbaBackendInput {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      pixels.set(pixel(x, y), (y * width + x) * 4);
    }
  }
  return { dimensions: { width, height }, pixels };
}

function rgbaAt(input: RgbaBackendInput, x: number, y: number) {
  const offset = (y * input.dimensions.width + x) * 4;
  return Array.from(input.pixels.slice(offset, offset + 4));
}

function averageRed(input: RgbaBackendInput): number {
  let total = 0;
  const pixels = input.dimensions.width * input.dimensions.height;
  for (let index = 0; index < pixels; index += 1) total += input.pixels[index * 4] ?? 0;
  return total / pixels;
}

describe('document post-capture filters', () => {
  it('keeps the owned perspective output unchanged for the original preset', () => {
    const input = image(2, 1, (x) => (x === 0 ? [10, 20, 30, 40] : [50, 60, 70, 80]));

    expect(applyDocumentFilter(input, 'original')).toBe(input);
  });

  it('produces neutral grayscale pixels while preserving alpha', () => {
    const input = image(3, 1, (x) =>
      x === 0 ? [220, 90, 30, 255] : x === 1 ? [80, 80, 80, 128] : [240, 240, 240, 255],
    );

    const output = applyDocumentFilter(input, 'grayscale');

    for (let x = 0; x < 3; x += 1) {
      const [red, green, blue, alpha] = rgbaAt(output, x, 0);
      expect(red).toBe(green);
      expect(green).toBe(blue);
      expect(alpha).toBe(rgbaAt(input, x, 0)[3]);
    }
    expect(output).toBe(input);
  });

  it('normalizes uneven exposure while making dark text easier to distinguish', () => {
    const input = image(33, 33, (x, y) => {
      const paper = 110 + Math.round((x / 32) * 80);
      return x >= 14 && x <= 16 && y >= 6 && y <= 26
        ? [45, 45, 45, 255]
        : [paper, paper, paper, 255];
    });

    const paperBefore = rgbaAt(input, 13, 16)[0] ?? 0;
    const textBefore = rgbaAt(input, 15, 16)[0] ?? 0;
    const output = applyDocumentFilter(input, 'ocr-color');
    const paperAfter = rgbaAt(output, 13, 16)[0] ?? 0;
    const textAfter = rgbaAt(output, 15, 16)[0] ?? 0;

    expect(output).toBe(input);
    expect(paperAfter).toBeGreaterThan(paperBefore);
    expect(paperAfter - textAfter).toBeGreaterThan(paperBefore - textBefore);
  });

  it('flattens smooth page shadows while retaining dark text contrast', () => {
    const input = image(65, 65, (x, y) => {
      const paper = 100 + Math.round((x / 64) * 120);
      return x >= 31 && x <= 33 && y >= 10 && y <= 54
        ? [45, 45, 45, 255]
        : [paper, paper, paper, 255];
    });
    const shadowDifferenceBefore = (rgbaAt(input, 56, 8)[0] ?? 0) - (rgbaAt(input, 8, 8)[0] ?? 0);
    const textContrastBefore = (rgbaAt(input, 30, 32)[0] ?? 0) - (rgbaAt(input, 32, 32)[0] ?? 0);

    const output = applyDocumentFilter(input, 'ocr-color');
    const shadowDifferenceAfter = (rgbaAt(output, 56, 8)[0] ?? 0) - (rgbaAt(output, 8, 8)[0] ?? 0);
    const textContrastAfter = (rgbaAt(output, 30, 32)[0] ?? 0) - (rgbaAt(output, 32, 32)[0] ?? 0);

    expect(shadowDifferenceAfter).toBeLessThan(shadowDifferenceBefore * 0.6);
    expect(textContrastAfter).toBeGreaterThan(textContrastBefore);
  });

  it('does not turn a uniform midtone page into a bright page', () => {
    const input = image(17, 17, () => [168, 168, 168, 255]);

    const output = applyDocumentFilter(input, 'ocr-color');

    expect(rgbaAt(output, 8, 8)).toEqual([168, 168, 168, 255]);
  });

  it('protects bright paper from clipping while increasing text edge contrast', () => {
    const input = image(9, 9, (x) => (x === 4 ? [130, 130, 130, 255] : [245, 245, 245, 255]));
    const contrastBefore = 245 - 130;

    const output = applyDocumentFilter(input, 'ocr-color');
    const paper = rgbaAt(output, 0, 4)[0] ?? 0;
    const text = rgbaAt(output, 4, 4)[0] ?? 0;

    expect(paper).toBeGreaterThan(225);
    expect(paper).toBeLessThan(252);
    expect(paper - text).toBeGreaterThan(contrastBefore);
  });

  it('makes low-contrast thin text materially crisper without brightening the paper', () => {
    const input = image(31, 31, (x) => (x === 15 ? [175, 175, 175, 255] : [238, 238, 238, 255]));
    const exposureBefore = averageRed(input);
    const contrastBefore = 238 - 175;

    const output = applyDocumentFilter(input, 'ocr-color');
    const paper = rgbaAt(output, 4, 15)[0] ?? 0;
    const text = rgbaAt(output, 15, 15)[0] ?? 0;

    expect(paper).toBeLessThanOrEqual(238);
    expect(paper - text).toBeGreaterThanOrEqual(contrastBefore + 36);
    expect(averageRed(output)).toBeLessThanOrEqual(exposureBefore);
  });

  it('preserves color separation instead of washing saturated areas toward white', () => {
    const input = image(5, 5, () => [220, 150, 110, 255]);

    const output = applyDocumentFilter(input, 'ocr-color');
    const [red = 0, green = 0, blue = 0] = rgbaAt(output, 2, 2);

    expect(red).toBeLessThan(250);
    expect(red - blue).toBeGreaterThanOrEqual(100);
    expect(green - blue).toBeGreaterThanOrEqual(35);
  });

  it('uses a local threshold to create an opaque black-and-white page', () => {
    const input = image(9, 9, (x, y) => {
      const paper = 90 + x * 10;
      return x === 4 && y === 4 ? [10, 10, 10, 200] : [paper, paper, paper, 200];
    });

    const output = applyDocumentFilter(input, 'black-and-white');

    expect(rgbaAt(output, 4, 4)).toEqual([0, 0, 0, 200]);
    expect(rgbaAt(output, 4, 3)).toEqual([255, 255, 255, 200]);
    expect(new Set(output.pixels.filter((_, index) => index % 4 !== 3))).toEqual(new Set([0, 255]));
  });

  it('rejects malformed buffers and unknown runtime filter values', () => {
    const malformed = {
      dimensions: { width: 2, height: 2 },
      pixels: new Uint8ClampedArray(15),
    };

    expect(() => applyDocumentFilter(malformed, 'grayscale')).toThrow(
      expect.objectContaining({ code: 'invalid-input' }),
    );
    expect(() =>
      applyDocumentFilter(
        image(1, 1, () => [0, 0, 0, 255]),
        'sepia' as never,
      ),
    ).toThrow(expect.objectContaining({ code: 'invalid-input' }));
  });
});
