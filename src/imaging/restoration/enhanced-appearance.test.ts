import { beforeEach, describe, expect, it, vi } from 'vitest';
const { predict } = vi.hoisted(() => ({ predict: vi.fn() }));
vi.mock('./gcnet-runtime', () => ({ predictIllumination: predict }));
import { applyFinalAppearance } from './enhanced-appearance';
import { applyDocumentFilter } from '../rendering/document-filter';

const raster = () => ({
  dimensions: { width: 4, height: 4 },
  pixels: new Uint8ClampedArray(64).fill(100).map((v, i) => (i % 4 === 3 ? 255 : v)),
});
beforeEach(() => {
  predict.mockReset();
});

describe('optional pretrained shadow filter', () => {
  it.each(['original', 'enhanced-color', 'grayscale'] as const)(
    'does not load the model for %s',
    async (mode) => {
      const input = raster(),
        expected = raster();
      applyDocumentFilter(expected, mode);
      const result = await applyFinalAppearance(input, mode);
      expect(result.pixels).toEqual(expected.pixels);
      expect(predict).not.toHaveBeenCalled();
    },
  );
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
