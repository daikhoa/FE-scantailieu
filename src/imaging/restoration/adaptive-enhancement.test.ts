import { describe, expect, it } from 'vitest';
import { analyzeEnhancement, applyEnhancement } from './adaptive-enhancement';
import { createShadowSample } from './shadow-field';

function page(kind: 'shadow' | 'gray-fill' | 'color' | 'flat') {
  const width = 384,
    height = 512;
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const level =
        kind === 'shadow' && x > width / 2
          ? 110
          : kind === 'gray-fill' && y > 170 && y < 350
            ? 110
            : 235;
      const ink = kind !== 'flat' && y % 25 < 4 && x > 28 && x < width - 28;
      const value = ink ? (kind === 'shadow' && x > width / 2 ? 14 : 30) : level;
      const at = (y * width + x) * 4;
      pixels[at] = kind === 'color' && !ink ? 130 : value;
      pixels[at + 1] = kind === 'color' && !ink ? 180 : value;
      pixels[at + 2] = kind === 'color' && !ink ? 65 : value;
      pixels[at + 3] = 255;
    }
  return { dimensions: { width, height }, pixels };
}

function fieldFor(input: ReturnType<typeof page>, grayFill = false) {
  const sample = createShadowSample(input);
  const data = new Float32Array(sample.data.length);
  const plane = sample.width * sample.height;
  for (let y = 0; y < sample.height; y++)
    for (let x = 0; x < sample.width; x++)
      for (let c = 0; c < 3; c++)
        data[c * plane + y * sample.width + x] = grayFill
          ? y / sample.height > 170 / 512 && y / sample.height < 350 / 512
            ? 110 / 255
            : 235 / 255
          : x >= sample.width / 2
            ? 110 / 255
            : 235 / 255;
  return { ...sample, data };
}

describe('adaptive enhanced-color', () => {
  it('keeps rounded inference sizes bounded at camera aspect ratios', () => {
    const sample = createShadowSample({
      dimensions: { width: 1019, height: 1382 },
      pixels: new Uint8ClampedArray(1019 * 1382 * 4),
    });
    expect(sample.height).toBe(384);
    expect(() => analyzeEnhancement(sample)).not.toThrow();
  });
  it('requests the model for broad paper shadows, not an evenly lit colored surface', () => {
    expect(analyzeEnhancement(createShadowSample(page('shadow'))).needsModel).toBe(true);
    expect(analyzeEnhancement(createShadowSample(page('color'))).needsModel).toBe(false);
    expect(analyzeEnhancement(createShadowSample(page('flat'))).needsModel).toBe(false);
  });
  it('removes a wide shadow while preserving output dimensions and existing dark marks', () => {
    const input = page('shadow'),
      pixels = input.pixels;
    const plan = analyzeEnhancement(createShadowSample(input), fieldFor(input));
    applyEnhancement(input, plan);
    expect(input.pixels).toBe(pixels);
    expect(input.dimensions).toEqual({ width: 384, height: 512 });
    expect(input.pixels[(110 * 384 + 300) * 4]).toBeGreaterThan(210);
    expect(input.pixels[(100 * 384 + 300) * 4]).toBeLessThan(45);
  });
  it('does not erase a printed gray fill even when the model mistakes it for shade', () => {
    const input = page('gray-fill');
    applyEnhancement(input, analyzeEnhancement(createShadowSample(input), fieldFor(input, true)));
    expect(input.pixels[(260 * 384 + 190) * 4]).toBeLessThan(125);
    expect(input.pixels[(250 * 384 + 190) * 4]).toBeLessThan(35);
  });
  it('preserves green artwork and darkens thin ink without a global contrast curve', () => {
    const input = page('color');
    applyEnhancement(input, analyzeEnhancement(createShadowSample(input)));
    expect([...input.pixels.slice((110 * 384 + 190) * 4, (110 * 384 + 190) * 4 + 3)]).toEqual([
      130, 180, 65,
    ]);
    expect(input.pixels[(100 * 384 + 190) * 4]).toBeLessThanOrEqual(30);
  });
  it('leaves hidden pixels and a flat noise-free surface unchanged', () => {
    const input = page('flat');
    input.pixels[3] = 0;
    const saved = input.pixels.slice();
    applyEnhancement(input, analyzeEnhancement(createShadowSample(input)));
    expect(input.pixels.every((value, index) => value === saved[index])).toBe(true);
  });
  it('rejects a corrupt field before touching pixels', () => {
    const input = page('shadow'),
      saved = input.pixels.slice(),
      field = fieldFor(input);
    field.data[field.data.length - 1] = NaN;
    expect(() => analyzeEnhancement(createShadowSample(input), field)).toThrow();
    expect(input.pixels.every((value, index) => value === saved[index])).toBe(true);
  });
  it('protects faint regular lines while keeping dark text enhancement available', () => {
    const input = page('flat');
    for (let y = 0; y < 512; y += 16)
      for (let x = 0; x < 384; x++) input.pixels.set([155, 155, 155, 255], (y * 384 + x) * 4);
    const before = input.pixels.slice();
    applyEnhancement(input, analyzeEnhancement(createShadowSample(input), undefined, 0.5));
    expect(input.pixels[(16 * 384 + 190) * 4]).toBeGreaterThanOrEqual(
      before[(16 * 384 + 190) * 4] ?? 0,
    );
  });
});
