import { describe, expect, it } from 'vitest';

import type { RgbaBackendInput } from '../engines/scanic-backend-contract';
import { analyzeDocumentQuality } from './document-quality';

function image(
  width: number,
  height: number,
  pixel: (x: number, y: number) => readonly [number, number, number, number],
): RgbaBackendInput {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) pixels.set(pixel(x, y), (y * width + x) * 4);
  }
  return { dimensions: { width, height }, pixels };
}

describe('document quality analyzer', () => {
  it('leaves a uniformly exposed neutral page on the cheap path', () => {
    const profile = analyzeDocumentQuality(image(64, 64, () => [210, 210, 210, 255]));

    expect(profile.illumination.kind).toBe('uniform');
    expect(profile.color.kind).toBe('mostly-neutral');
    expect(profile.stages.normalizeIllumination).toBe(false);
    expect(profile.stages.protectColor).toBe(false);
  });

  it('routes a smooth shadow through illumination normalization', () => {
    const profile = analyzeDocumentQuality(
      image(96, 64, (x) => {
        const paper = 90 + Math.round((x / 95) * 140);
        return [paper, paper, paper, 255];
      }),
    );

    expect(profile.illumination.kind).toBe('uneven');
    expect(profile.illumination.range).toBeGreaterThanOrEqual(18);
    expect(profile.stages.normalizeIllumination).toBe(true);
  });

  it('protects color-rich document regions from aggressive finishing', () => {
    const profile = analyzeDocumentQuality(
      image(64, 64, (x, y) => ((x + y) % 2 === 0 ? [230, 70, 35, 255] : [40, 150, 220, 255])),
    );

    expect(profile.color.kind).toBe('color-rich');
    expect(profile.color.saturatedRatio).toBeGreaterThan(0.5);
    expect(profile.stages.protectColor).toBe(true);
    expect(profile.stages.sharpen).not.toBe('strong');
  });

  it('does not sharpen an already high-detail black-and-white pattern', () => {
    const profile = analyzeDocumentQuality(
      image(64, 64, (x, y) => ((x + y) % 2 === 0 ? [20, 20, 20, 255] : [240, 240, 240, 255])),
    );

    expect(profile.detail.kind).toBe('high');
    expect(profile.stages.sharpen).toBe('none');
  });

  it('rejects malformed pixel storage', () => {
    expect(() =>
      analyzeDocumentQuality({
        dimensions: { width: 4, height: 4 },
        pixels: new Uint8ClampedArray(63),
      }),
    ).toThrow(expect.objectContaining({ code: 'invalid-input' }));
  });
});
