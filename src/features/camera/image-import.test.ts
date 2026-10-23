import { afterEach, describe, expect, it, vi } from 'vitest';

import { MAX_ENCODED_INPUT_BYTES } from '../../imaging/codecs/browser-rgba-codec';
import { ImageImportError, importImage } from './image-import';

function png(width: number, height: number, type = 'image/png'): Blob {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return new Blob([bytes], { type });
}

function jpeg(width: number, height: number, type = 'image/jpeg'): Blob {
  const bytes = new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xe0,
    0x00,
    0x04,
    0x00,
    0x00,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    (height >>> 8) & 0xff,
    height & 0xff,
    (width >>> 8) & 0xff,
    width & 0xff,
    0x03,
    0x01,
    0x11,
    0x00,
    0x02,
    0x11,
    0x00,
    0x03,
    0x11,
    0x00,
  ]);
  return new Blob([bytes], { type });
}

function webp(width: number, height: number, type = 'image/webp'): Blob {
  const bytes = new Uint8Array(30);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  bytes.set([0x57, 0x45, 0x42, 0x50], 8);
  bytes.set([0x56, 0x50, 0x38, 0x58], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, 10, true);
  const storedWidth = width - 1;
  const storedHeight = height - 1;
  bytes.set([storedWidth & 0xff, (storedWidth >>> 8) & 0xff, storedWidth >>> 16], 24);
  bytes.set([storedHeight & 0xff, (storedHeight >>> 8) & 0xff, storedHeight >>> 16], 27);
  return new Blob([bytes], { type });
}

function bitmap(width: number, height: number) {
  return { width, height, close: vi.fn() };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('image import', () => {
  it.each([
    ['PNG', () => png(1200, 800), 'image/png'],
    ['JPEG', () => jpeg(1200, 800), 'image/jpeg'],
    ['WebP', () => webp(1200, 800), 'image/webp'],
    ['missing MIME with valid PNG signature', () => png(1200, 800, ''), 'image/png'],
  ])('validates %s bytes and preserves an immutable local blob', async (_name, make, type) => {
    const source = make();
    const decoded = bitmap(1200, 800);
    const create = vi.fn(() => Promise.resolve(decoded));
    vi.stubGlobal('createImageBitmap', create);

    const result = await importImage(source, new AbortController().signal);

    expect(result.original.dimensions).toEqual({ width: 1200, height: 800 });
    expect(result.original.blob.type).toBe(type);
    expect(result.original.blob.size).toBe(source.size);
    if (source.type !== '') expect(result.original.blob).toBe(source);
    expect(create).toHaveBeenCalledWith(result.original.blob, { imageOrientation: 'none' });
    expect(decoded.close).toHaveBeenCalledOnce();
  });

  it('rejects a MIME/signature mismatch before invoking the decoder', async () => {
    const create = vi.fn();
    vi.stubGlobal('createImageBitmap', create);

    await expect(
      importImage(png(20, 10, 'image/jpeg'), new AbortController().signal),
    ).rejects.toMatchObject({ code: 'invalid-file' });
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    [new Blob([], { type: 'image/png' }), 'invalid-file'],
    [new Blob(['heic'], { type: 'image/heic' }), 'invalid-file'],
    [png(0, 10), 'invalid-file'],
    [png(16385, 1), 'image-too-large'],
    [png(8001, 8000), 'image-too-large'],
  ])('rejects invalid or excessive input before decode', async (source, code) => {
    const create = vi.fn();
    vi.stubGlobal('createImageBitmap', create);

    await expect(importImage(source, new AbortController().signal)).rejects.toMatchObject({
      code,
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects an encoded file above the byte limit before reading it', async () => {
    const source = png(20, 10);
    Object.defineProperty(source, 'size', { value: MAX_ENCODED_INPUT_BYTES + 1 });
    const arrayBuffer = vi.spyOn(source, 'arrayBuffer');

    await expect(importImage(source, new AbortController().signal)).rejects.toMatchObject({
      code: 'too-large',
    });
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('accepts a 48MP photo larger than the old 64MiB limit without replacing original bytes', async () => {
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        getContext() {
          return null;
        }
      },
    );
    const source = jpeg(8000, 6000);
    Object.defineProperty(source, 'size', { value: 65 * 1024 * 1024 });
    const decoded = bitmap(8000, 6000);
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(() => Promise.resolve(decoded)),
    );
    const result = await importImage(source, new AbortController().signal);
    expect(result.original.blob).toBe(source);
    expect(result.original.dimensions).toEqual({ width: 8000, height: 6000 });
    expect(decoded.close).toHaveBeenCalledOnce();
  });

  it('rejects a decoder dimension mismatch and closes the bitmap', async () => {
    const decoded = bitmap(640, 480);
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(() => Promise.resolve(decoded)),
    );

    await expect(importImage(png(320, 240), new AbortController().signal)).rejects.toMatchObject({
      code: 'invalid-file',
    });
    expect(decoded.close).toHaveBeenCalledOnce();
  });

  it('accepts dimensions swapped by browser EXIF orientation and records decoded axes', async () => {
    const source = jpeg(1200, 800);
    const decoded = bitmap(800, 1200);
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(() => Promise.resolve(decoded)),
    );

    const result = await importImage(source, new AbortController().signal);

    expect(result.original.dimensions).toEqual({ width: 800, height: 1200 });
    expect(decoded.close).toHaveBeenCalledOnce();
  });

  it('closes a late bitmap and sanitizes cancellation', async () => {
    let resolveBitmap: ((value: ReturnType<typeof bitmap>) => void) | undefined;
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(
        () =>
          new Promise<ReturnType<typeof bitmap>>((resolve) => {
            resolveBitmap = resolve;
          }),
      ),
    );
    const controller = new AbortController();
    const job = importImage(png(20, 10), controller.signal);
    await vi.waitFor(() => {
      expect(resolveBitmap).toBeTypeOf('function');
    });
    controller.abort('private file name');
    const decoded = bitmap(20, 10);
    resolveBitmap?.(decoded);

    await expect(job).rejects.toMatchObject({
      name: 'AbortError',
      message: 'Image import cancelled.',
    });
    expect(decoded.close).toHaveBeenCalledOnce();
  });

  it('returns safe errors when decoding is unavailable or fails', async () => {
    vi.stubGlobal('createImageBitmap', undefined);
    await expect(importImage(png(20, 10), new AbortController().signal)).rejects.toEqual(
      new ImageImportError('unavailable'),
    );

    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(() => Promise.reject(new Error('private local file path'))),
    );
    await expect(importImage(png(20, 10), new AbortController().signal)).rejects.toMatchObject({
      name: 'ImageImportError',
      code: 'decode-failed',
      message: 'The image could not be decoded.',
    });
  });
});
