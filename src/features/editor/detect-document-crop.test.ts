import { describe, expect, it, vi } from 'vitest';

import type { ImageAsset } from '../../domain/document';
import type { ScannerEngine, ScannerFrame } from '../../imaging/contracts/scanner-engine';
import type { ImageAssetFrameSource } from '../scanner/image-asset-frame-source';
import { detectDocumentCrop } from './detect-document-crop';

const original: ImageAsset = {
  blob: new Blob(['image'], { type: 'image/png' }),
  dimensions: { width: 2000, height: 3000 },
};

function dependencies(result: Awaited<ReturnType<ScannerEngine['detect']>>) {
  const close = vi.fn();
  const frame: ScannerFrame = { dimensions: { width: 400, height: 600 }, close };
  const create = vi.fn<ImageAssetFrameSource['create']>(() => Promise.resolve(frame));
  const source: ImageAssetFrameSource = { create };
  const engine = { detect: vi.fn(() => Promise.resolve(result)) } as Pick<ScannerEngine, 'detect'>;
  return { source, engine, close, create };
}

describe('post-capture document detection', () => {
  it('uses a bounded aligned preview for detection and returns corners in original pixels', async () => {
    const preview: ImageAsset = {
      blob: new Blob(['preview'], { type: 'image/png' }),
      dimensions: { width: 800, height: 1200 },
    };
    const fixture = dependencies({
      kind: 'document',
      dimensions: { width: 400, height: 600 },
      confidence: 0.9,
      corners: [
        { x: 20, y: 30 },
        { x: 380, y: 30 },
        { x: 380, y: 570 },
        { x: 20, y: 570 },
      ],
    });
    const signal = new AbortController().signal;
    const crop = await detectDocumentCrop(
      fixture.engine,
      fixture.source,
      original,
      signal,
      { kind: 'full-frame' },
      undefined,
      preview,
    );
    expect(fixture.create).toHaveBeenCalledWith(preview, signal);
    expect(crop).toMatchObject({
      kind: 'document',
      corners: [
        { x: 100, y: 150 },
        { x: 1900, y: 150 },
        { x: 1900, y: 2850 },
        { x: 100, y: 2850 },
      ],
    });
    expect(fixture.close).toHaveBeenCalledOnce();
  });

  it('falls back to the original if preview decoding fails, without hiding cancellation', async () => {
    const preview: ImageAsset = {
      blob: new Blob(['preview'], { type: 'image/png' }),
      dimensions: { width: 800, height: 1200 },
    };
    const fixture = dependencies({
      kind: 'full-frame',
      dimensions: { width: 400, height: 600 },
      reason: 'no-document',
    });
    const create = fixture.create;
    const frame = { dimensions: { width: 400, height: 600 }, close: fixture.close };
    create.mockRejectedValueOnce(new Error('Preview decode failed')).mockResolvedValueOnce(frame);
    const signal = new AbortController().signal;
    await detectDocumentCrop(
      fixture.engine,
      fixture.source,
      original,
      signal,
      { kind: 'full-frame' },
      undefined,
      preview,
    );
    expect(create.mock.calls.map((call) => call[0])).toEqual([preview, original]);
    const abort = new DOMException('Cancelled', 'AbortError');
    create.mockClear().mockRejectedValueOnce(abort);
    await expect(
      detectDocumentCrop(
        fixture.engine,
        fixture.source,
        original,
        signal,
        { kind: 'full-frame' },
        undefined,
        preview,
      ),
    ).rejects.toBe(abort);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('ignores previews with different axes or a lossy encoding', async () => {
    for (const preview of [
      {
        blob: new Blob(['preview'], { type: 'image/png' }),
        dimensions: { width: 1200, height: 800 },
      },
      {
        blob: new Blob(['preview'], { type: 'image/jpeg' }),
        dimensions: { width: 800, height: 1200 },
      },
    ]) {
      const fixture = dependencies({
        kind: 'full-frame',
        dimensions: { width: 400, height: 600 },
        reason: 'no-document',
      });
      const signal = new AbortController().signal;
      await detectDocumentCrop(
        fixture.engine,
        fixture.source,
        original,
        signal,
        { kind: 'full-frame' },
        undefined,
        preview,
      );
      expect(fixture.create).toHaveBeenCalledWith(original, signal);
    }
  });
  it('uses the last live ML corners when frozen-frame ML throws and releases the frame', async () => {
    const fixture = dependencies({
      kind: 'full-frame',
      dimensions: { width: 400, height: 600 },
      reason: 'no-document',
    });
    fixture.engine.detect = vi.fn(() => Promise.reject(new Error('ML runtime failed')));
    const fallback = {
      kind: 'document' as const,
      corners: [
        { x: 100, y: 100 },
        { x: 1900, y: 100 },
        { x: 1900, y: 2900 },
        { x: 100, y: 2900 },
      ] as const,
    };
    await expect(
      detectDocumentCrop(
        fixture.engine,
        fixture.source,
        original,
        new AbortController().signal,
        fallback,
      ),
    ).resolves.toBe(fallback);
    expect(fixture.close).toHaveBeenCalledOnce();
  });
  it('maps Scanic preview corners back to exact original image coordinates', async () => {
    const fixture = dependencies({
      kind: 'document',
      dimensions: { width: 400, height: 600 },
      confidence: 0.9,
      corners: [
        { x: 20, y: 30 },
        { x: 380, y: 40 },
        { x: 370, y: 570 },
        { x: 30, y: 560 },
      ],
    });

    await expect(
      detectDocumentCrop(fixture.engine, fixture.source, original, new AbortController().signal),
    ).resolves.toEqual({
      kind: 'document',
      corners: [
        { x: 100, y: 150 },
        { x: 1900, y: 200 },
        { x: 1850, y: 2850 },
        { x: 150, y: 2800 },
      ],
    });
    expect(fixture.close).toHaveBeenCalledOnce();
  });

  it('keeps the full image when Scanic is not confident', async () => {
    const fixture = dependencies({
      kind: 'full-frame',
      dimensions: { width: 400, height: 600 },
      reason: 'low-confidence',
    });

    await expect(
      detectDocumentCrop(fixture.engine, fixture.source, original, new AbortController().signal),
    ).resolves.toEqual({ kind: 'full-frame' });
    expect(fixture.close).toHaveBeenCalledOnce();
  });

  it('uses the frozen live crop when post-capture detection is not confident', async () => {
    const fixture = dependencies({
      kind: 'full-frame',
      dimensions: { width: 400, height: 600 },
      reason: 'low-confidence',
    });
    const fallback = {
      kind: 'document' as const,
      corners: [
        { x: 80, y: 120 },
        { x: 1920, y: 100 },
        { x: 1880, y: 2900 },
        { x: 100, y: 2880 },
      ] as const,
    };

    await expect(
      detectDocumentCrop(
        fixture.engine,
        fixture.source,
        original,
        new AbortController().signal,
        fallback,
      ),
    ).resolves.toBe(fallback);
    expect(fixture.close).toHaveBeenCalledOnce();
  });

  it('prefers a confident post-capture crop over the frozen live crop', async () => {
    const fixture = dependencies({
      kind: 'document',
      dimensions: { width: 400, height: 600 },
      confidence: 0.9,
      corners: [
        { x: 20, y: 30 },
        { x: 380, y: 40 },
        { x: 370, y: 570 },
        { x: 30, y: 560 },
      ],
    });

    await expect(
      detectDocumentCrop(fixture.engine, fixture.source, original, new AbortController().signal, {
        kind: 'document',
        corners: [
          { x: 0, y: 0 },
          { x: 2000, y: 0 },
          { x: 2000, y: 3000 },
          { x: 0, y: 3000 },
        ],
      }),
    ).resolves.toEqual({
      kind: 'document',
      corners: [
        { x: 100, y: 150 },
        { x: 1900, y: 200 },
        { x: 1850, y: 2850 },
        { x: 150, y: 2800 },
      ],
    });
  });

  it('keeps full-frame on invalid frozen coordinates and still releases the frame', async () => {
    const fixture = dependencies({
      kind: 'full-frame',
      dimensions: { width: 401, height: 600 },
      reason: 'no-document',
    });

    await expect(
      detectDocumentCrop(fixture.engine, fixture.source, original, new AbortController().signal),
    ).resolves.toEqual({ kind: 'full-frame' });
    expect(fixture.close).toHaveBeenCalledOnce();
  });
});
