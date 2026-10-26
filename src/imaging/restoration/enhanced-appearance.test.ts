import { beforeEach, describe, expect, it, vi } from 'vitest';
const { predict } = vi.hoisted(() => ({ predict: vi.fn() }));
vi.mock('./gcnet-runtime', () => ({ predictIllumination: predict }));
import { applyFinalAppearance } from './enhanced-appearance';
import { applyDocumentFilter } from '../rendering/document-filter';
import { createShadowSample } from './shadow-field';

const raster = () => ({
  dimensions: { width: 4, height: 4 },
  pixels: new Uint8ClampedArray(64).fill(100).map((v, i) => (i % 4 === 3 ? 255 : v)),
});
const shadowedPage = () => {
  const width = 128,
    height = 192,
    pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      // A physical shadow attenuates ink as well as paper; constant ink on a gray
      // panel is deliberately a separate printed-fill protection regression.
      const level = y % 12 === 0 && x > 8 && x < 120 ? (x > 64 ? 9 : 20) : x > 64 ? 110 : 235;
      pixels.set([level, level, level, 255], (y * width + x) * 4);
    }
  return { dimensions: { width, height }, pixels };
};
beforeEach(() => {
  predict.mockReset();
});

describe('optional pretrained shadow filter', () => {
  it.each(['original', 'grayscale'] as const)('does not load the model for %s', async (mode) => {
    const input = raster(),
      expected = raster();
    applyDocumentFilter(expected, mode);
    const result = await applyFinalAppearance(input, mode);
    expect(result.pixels).toEqual(expected.pixels);
    expect(predict).not.toHaveBeenCalled();
  });
  it('skips inference and reports the lightweight default on an evenly lit page', async () => {
    const input = raster();
    const result = await applyFinalAppearance(input, 'enhanced-color');
    expect(result.enhancement).toBe('local');
    expect(result.pixels).toBe(input.pixels);
    expect(predict).not.toHaveBeenCalled();
  });
  it('uses learned illumination in the default without darkening the shadow globally', async () => {
    const input = shadowedPage();
    const sample = createShadowSample(input);
    predict.mockResolvedValue({ ...sample, data: new Float32Array(sample.data.length).fill(0.48) });
    const result = await applyFinalAppearance(input, 'enhanced-color');
    expect(predict).toHaveBeenCalledOnce();
    expect(result.enhancement).toBe('shadow-model');
    expect(result.pixels[(50 * 128 + 100) * 4]).toBeGreaterThan(190);
  });
  it('labels conservative fallback when inference fails, without claiming AI success', async () => {
    predict.mockRejectedValue(new Error('unavailable'));
    const input = shadowedPage();
    const result = await applyFinalAppearance(input, 'enhanced-color');
    expect(predict).toHaveBeenCalledOnce();
    expect(result.enhancement).toBe('model-unavailable');
    expect(result.enhancementFailure).toBe('runtime');
    expect(result.pixels[(50 * 128 + 100) * 4]).toBeGreaterThanOrEqual(110);
  });
  it('corrects illumination on the original buffer and preserves its dimensions', async () => {
    predict.mockResolvedValue({ width: 1, height: 1, data: new Float32Array([0.48, 0.48, 0.48]) });
    const input = raster();
    const result = await applyFinalAppearance(input, 'shadow-removal');
    expect(result).toBe(input);
    expect(result.pixels[0]).toBe(200);
    expect(result.dimensions).toEqual({ width: 4, height: 4 });
    expect(predict).toHaveBeenCalledOnce();
  });
  it('reports unavailable model rather than substituting a fake model result', async () => {
    predict.mockRejectedValue(new Error('unavailable'));
    const input = raster(),
      saved = input.pixels.slice();
    await expect(applyFinalAppearance(input, 'shadow-removal')).rejects.toThrow();
    expect(input.pixels).toEqual(saved);
  });
});
