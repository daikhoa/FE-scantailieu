import { describe, expect, it } from 'vitest';
import { applyShadowField, createShadowSample } from './shadow-field';

const raster = (rgba = [80, 120, 160, 255]) => ({
  dimensions: { width: 2, height: 2 },
  pixels: new Uint8ClampedArray([...rgba, ...rgba, ...rgba, ...rgba]),
});

describe('pretrained illumination boundary', () => {
  it('bounds inference to 384 pixels with dimensions divisible by 32', () => {
    const input = {
      dimensions: { width: 3000, height: 4000 },
      pixels: new Uint8ClampedArray(48_000_000),
    };
    const sample = createShadowSample(input);
    expect(sample.width).toBe(288);
    expect(sample.height).toBe(384);
    expect(sample.data.length).toBe(288 * 384 * 3);
  });

  it('uses BGR planar values in 0..1 and composites alpha on white', () => {
    const sample = createShadowSample(raster([64, 128, 192, 255]));
    const plane = sample.width * sample.height;
    expect(sample.data[0]).toBeCloseTo(192 / 255);
    expect(sample.data[plane]).toBeCloseTo(128 / 255);
    expect(sample.data[plane * 2]).toBeCloseTo(64 / 255);
    expect(createShadowSample(raster([0, 0, 0, 0])).data[0]).toBe(1);
  });

  it('applies BGR illumination to the original owned pixels without changing geometry', () => {
    const input = raster();
    const pixels = input.pixels;
    applyShadowField(input, { width: 1, height: 1, data: new Float32Array([0.8, 0.6, 0.4]) });
    expect(input.pixels).toBe(pixels);
    expect(input.dimensions).toEqual({ width: 2, height: 2 });
    expect([...pixels.slice(0, 4)]).toEqual([192, 192, 192, 255]);
  });

  it('never darkens a bright region or changes hidden/partial pixels', () => {
    const input = raster([100, 120, 140, 128]);
    const before = input.pixels.slice();
    applyShadowField(input, { width: 1, height: 1, data: new Float32Array([1, 1, 1]) });
    expect(input.pixels).toEqual(before);
    const opaque = raster();
    const saved = opaque.pixels.slice();
    applyShadowField(opaque, { width: 1, height: 1, data: new Float32Array([1, 1, 1]) });
    expect(opaque.pixels).toEqual(saved);
  });

  it.each([NaN, Infinity, 0, -1, 2])(
    'rejects invalid illumination %s before modifying pixels',
    (value) => {
      const input = raster();
      const before = input.pixels.slice();
      expect(() => { applyShadowField(input, { width: 1, height: 1, data: new Float32Array([1, value, 1]) }); },
      ).toThrow();
      expect(input.pixels).toEqual(before);
    },
  );

  it('rejects mismatched or excessive tensor dimensions', () => {
    expect(() => { applyShadowField(raster(), { width: 2, height: 2, data: new Float32Array(3) }); },
    ).toThrow();
    expect(() =>
      createShadowSample({ ...raster(), dimensions: { width: 0, height: 2 } }),
    ).toThrow();
  });
});
