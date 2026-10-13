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

  it('normalizes uneven paper lighting while keeping dark text darker', () => {
    const input = image(9, 9, (x, y) => {
      const paper = 80 + x * 12;
      return x === 2 && y === 4 ? [20, 20, 20, 255] : [paper, paper, paper, 255];
    });

    const darkPaperBefore = rgbaAt(input, 0, 0)[0] ?? -1;
    const lightPaperBefore = rgbaAt(input, 8, 0)[0] ?? -1;
    const output = applyDocumentFilter(input, 'ocr-color');

    expect(output).toBe(input);
    expect(rgbaAt(output, 0, 0)[0]).toBeGreaterThan(darkPaperBefore);
    expect(rgbaAt(output, 8, 0)[0]).toBeGreaterThanOrEqual(lightPaperBefore);
    expect(rgbaAt(output, 2, 4)[0]).toBeLessThan(rgbaAt(output, 2, 3)[0] ?? -1);
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
