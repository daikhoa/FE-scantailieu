import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';

import { createImagePdf, PdfExportError } from './image-pdf';

const PNG_1X1 = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nVQAAAAASUVORK5CYII=',
  ),
  (character) => character.charCodeAt(0),
);

function page(width: number, height: number) {
  return {
    blob: new Blob([PNG_1X1], { type: 'image/png' }),
    dimensions: { width, height },
  };
}

describe('image PDF export', () => {
  it('creates valid pages in order while preserving every page aspect ratio', async () => {
    const output = await createImagePdf(
      [page(1000, 2000), page(2000, 1000)],
      new AbortController().signal,
    );
    const document = await PDFDocument.load(await output.arrayBuffer());
    const pages = document.getPages();

    expect(output.type).toBe('application/pdf');
    expect(pages).toHaveLength(2);
    expect(pages[0]?.getSize()).toEqual({ width: 240, height: 480 });
    expect(pages[1]?.getSize()).toEqual({ width: 480, height: 240 });
  });

  it('rejects an empty document and unsupported rendered image types', async () => {
    await expect(createImagePdf([], new AbortController().signal)).rejects.toEqual(
      new PdfExportError('invalid-input'),
    );
    await expect(
      createImagePdf(
        [
          {
            blob: new Blob(['webp'], { type: 'image/webp' }),
            dimensions: { width: 100, height: 100 },
          },
        ],
        new AbortController().signal,
      ),
    ).rejects.toEqual(new PdfExportError('invalid-input'));
  });

  it('cancels with a generic error without exposing the abort reason', async () => {
    const controller = new AbortController();
    controller.abort('private document name');

    await expect(createImagePdf([page(100, 100)], controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
      message: 'PDF export cancelled.',
    });
  });
});
