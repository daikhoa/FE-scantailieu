import { describe, expect, it } from 'vitest';
import { analyzeDocumentQuality } from '../analysis/document-quality';
import { createAdaptiveRestorationPlan } from '../restoration/adaptive-restoration-plan';
import { applyDocumentFilter } from './document-filter';
import { applyClaheLightness } from './clahe-lightness';

function page(color = false) {
  const pixels = new Uint8ClampedArray(96 * 96 * 4);
  for (let y = 0; y < 96; y++)
    for (let x = 0; x < 96; x++) {
      const value = x % 12 === 0 && y > 10 ? 165 : 205;
      pixels.set(
        color && x > 65 && y > 65 ? [190, 45, 60, 255] : [value, value, value, 255],
        (y * 96 + x) * 4,
      );
    }
  return { dimensions: { width: 96, height: 96 }, pixels };
}
const scores = {
  shadow: 0,
  curved: 0,
  blur: 0.5,
  moire: 0,
  finger: 0,
  lowContrast: 0.9,
  colorDocument: 0.9,
};
describe('adaptive pixel pipeline', () => {
  it('runs bounded CLAHE while preserving red seals and faint text', () => {
    const input = page(true);
    const plan = createAdaptiveRestorationPlan(scores, analyzeDocumentQuality(input));
    applyDocumentFilter(input, 'ocr-color', plan);
    const seal = (80 * 96 + 80) * 4;
    expect((input.pixels[seal] ?? 0) - (input.pixels[seal + 1] ?? 0)).toBeGreaterThan(100);
    const text = (40 * 96 + 12) * 4,
      paper = (40 * 96 + 13) * 4;
    expect((input.pixels[paper] ?? 0) - (input.pixels[text] ?? 0)).toBeGreaterThan(20);
    expect(input.pixels[paper]).toBeLessThan(248);
  });
  it('leaves a uniform page unchanged under CLAHE', () => {
    const pixels = new Uint8ClampedArray(64 * 64 * 4).fill(210);
    for (let offset = 3; offset < pixels.length; offset += 4) pixels[offset] = 255;
    const original = pixels.slice();
    applyClaheLightness(
      { dimensions: { width: 64, height: 64 }, pixels },
      new Uint8Array(64 * 64),
      0.6,
    );
    expect(pixels).toEqual(original);
  });
});
