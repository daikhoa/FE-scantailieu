import { describe, expect, it } from 'vitest';
import { applyDocumentFilter } from './document-filter';
import { restorePaperAppearance } from './paper-restoration';

import { paperDocument } from '../../../tests/fixtures/paper-documents';

function red(input: ReturnType<typeof paperDocument>, x: number, y: number) {
  return input.pixels[(y * input.dimensions.width + x) * 4] ?? 0;
}

describe('color-aware paper restoration', () => {
  it('flattens a supported paper shadow while retaining dark strokes', () => {
    const input = paperDocument(),
      before = input.pixels.slice();
    restorePaperAppearance(input);
    expect(red(input, 12, 30)).toBeGreaterThan(215);
    expect(Math.abs(red(input, 12, 30) - red(input, 370, 30))).toBeLessThan(18);
    expect(red(input, 12, 30) - red(input, 16, 30)).toBeGreaterThan(160);
    expect(input.pixels[3]).toBe(before[3]);
  });
  it.each(['colored', 'pastel', 'photo', 'inverse', 'flat', 'noisy'] as const)(
    'preserves ambiguous %s content',
    (kind) => {
      const input = paperDocument(kind),
        before = input.pixels.slice();
      restorePaperAppearance(input);
      expect(input.pixels.every((v, i) => v === before[i])).toBe(true);
    },
  );
  it.each(['gray-panel', 'gray-sidebar', 'color-panel'] as const)(
    'preserves printed %s regions',
    (kind) => {
      const input = paperDocument(kind),
        original = input.pixels.slice();
      restorePaperAppearance(input);
      let maximumChange = 0;
      const first = kind === 'gray-sidebar' ? 12 : 144,
        last = kind === 'gray-sidebar' ? 85 : 240;
      for (let y = 180; y < 330; y++)
        for (let x = first; x < last; x++)
          for (let c = 0; c < 3; c++) {
            const at = (y * 384 + x) * 4 + c;
            maximumChange = Math.max(
              maximumChange,
              Math.abs((input.pixels[at] ?? 0) - (original[at] ?? 0)),
            );
          }
      expect(maximumChange).toBe(0);
      if (kind !== 'gray-sidebar') expect(red(input, 12, 30)).toBeGreaterThan(210);
    },
  );
  it('protects dark colored ink even when the surrounding paper is restored', () => {
    const input = paperDocument();
    for (let y = 210; y < 270; y++)
      for (let x = 150; x < 230; x++) input.pixels.set([45, 22, 30, 255], (y * 384 + x) * 4);
    restorePaperAppearance(input);
    expect(
      Array.from(input.pixels.slice((240 * 384 + 190) * 4, (240 * 384 + 190) * 4 + 4)),
    ).toEqual([45, 22, 30, 255]);
  });
  it('restores supported warm illumination without clipping', () => {
    const input = paperDocument('warm');
    restorePaperAppearance(input);
    expect(red(input, 12, 30)).toBeGreaterThan(210);
    expect(input.pixels.every((v, i) => i % 4 === 3 || v < 255)).toBe(true);
  });
  it('keeps the original high-resolution raster and restores scaled strokes', () => {
    const input = paperDocument('white', 1536, 2048);
    const pixels = input.pixels;
    restorePaperAppearance(input);
    expect(input.pixels).toBe(pixels);
    expect(input.dimensions).toEqual({ width: 1536, height: 2048 });
    expect(red(input, 48, 120)).toBeGreaterThan(210);
  });
  it.each(['crease', 'vertical-crease', 'diagonal-crease', 'faint-crease'] as const)(
    'removes a narrow %s without darkening its paper',
    (kind) => {
      const input = paperDocument(kind);
      const x = kind === 'vertical-crease' ? 190 : 12,
        y = kind === 'vertical-crease' ? 30 : kind === 'diagonal-crease' ? 212 : 250;
      const before = red(input, x, y);
      applyDocumentFilter(input, 'enhanced-color');
      expect(red(input, x, y)).toBeGreaterThan(210);
      expect(red(input, x, y)).toBeGreaterThan(before);
    },
  );
  it('preserves a printed gray band with ordinary dark ink', () => {
    const input = paperDocument('printed-band'),
      before = input.pixels.slice();
    restorePaperAppearance(input);
    let maximum = 0;
    for (let y = 242; y < 258; y++)
      for (let x = 40; x < 330; x++)
        for (let c = 0; c < 3; c++) {
          const at = (y * 384 + x) * 4 + c;
          maximum = Math.max(maximum, Math.abs((input.pixels[at] ?? 0) - (before[at] ?? 0)));
        }
    expect(maximum).toBe(0);
  });
  it('preserves a vertical printed gray band', () => {
    const input = paperDocument('printed-column'),
      before = input.pixels.slice();
    restorePaperAppearance(input);
    expect(input.pixels.every((v, i) => v === before[i])).toBe(true);
  });
  it('preserves a dark colored graphic crossing a crease', () => {
    const input = paperDocument('crease');
    for (let y = 240; y < 260; y++)
      for (let x = 120; x < 180; x++) input.pixels.set([42, 22, 30, 255], (y * 384 + x) * 4);
    restorePaperAppearance(input);
    expect(
      Array.from(input.pixels.slice((250 * 384 + 150) * 4, (250 * 384 + 150) * 4 + 4)),
    ).toEqual([42, 22, 30, 255]);
  });
  it('retains partial alpha and deterministic output', () => {
    const a = paperDocument(),
      b = paperDocument();
    a.pixels.set([80, 90, 100, 128], (100 * 384 + 100) * 4);
    b.pixels.set([80, 90, 100, 128], (100 * 384 + 100) * 4);
    restorePaperAppearance(a);
    restorePaperAppearance(b);
    expect(a.pixels.every((v, i) => v === b.pixels[i])).toBe(true);
    expect(Array.from(a.pixels.slice((100 * 384 + 100) * 4, (100 * 384 + 100) * 4 + 4))).toEqual([
      80, 90, 100, 128,
    ]);
  });
});
