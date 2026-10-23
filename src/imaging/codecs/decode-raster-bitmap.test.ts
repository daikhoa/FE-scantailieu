import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeRasterBitmap } from './decode-raster-bitmap';

class DecoderWorker {
  static latest: DecoderWorker | undefined;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  terminate = vi.fn();
  postMessage = vi.fn();
  constructor() {
    DecoderWorker.latest = this;
  }
}
function latestWorker(): DecoderWorker {
  const worker = DecoderWorker.latest;
  if (worker === undefined) throw new Error('Missing decoder worker.');
  return worker;
}
afterEach(() => {
  vi.unstubAllGlobals();
  DecoderWorker.latest = undefined;
});
describe('native/HEIF decoder routing', () => {
  it('uses native decoding without creating a HEIF worker when supported', async () => {
    const bitmap = { close: vi.fn() };
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(() => Promise.resolve(bitmap)),
    );
    vi.stubGlobal('Worker', DecoderWorker);
    await expect(decodeRasterBitmap(new Blob(['photo'], { type: 'image/heic' }))).resolves.toBe(
      bitmap,
    );
    expect(DecoderWorker.latest).toBeUndefined();
  });
  it('terminates the fallback worker on success and on cancellation', async () => {
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(() => Promise.reject(new Error('Unsupported HEIF'))),
    );
    vi.stubGlobal('Worker', DecoderWorker);
    const signal = new AbortController();
    const first = decodeRasterBitmap(
      new Blob(['photo'], { type: 'image/heic' }),
      {},
      signal.signal,
    );
    await vi.waitFor(() => {
      expect(DecoderWorker.latest).toBeDefined();
    });
    const worker = DecoderWorker.latest;
    if (worker === undefined) throw new Error('Missing HEIF worker.');
    const bitmap = { close: vi.fn() };
    worker.onmessage?.(new MessageEvent('message', { data: { bitmap } }));
    await expect(first).resolves.toBe(bitmap);
    expect(worker.terminate).toHaveBeenCalledOnce();
    DecoderWorker.latest = undefined;
    const second = decodeRasterBitmap(
      new Blob(['photo'], { type: 'image/heif' }),
      {},
      signal.signal,
    );
    const cancelled = second.catch((error: unknown) => error);
    await vi.waitFor(() => {
      expect(DecoderWorker.latest).toBeDefined();
    });
    const pending = latestWorker();
    signal.abort();
    await expect(cancelled).resolves.toMatchObject({ name: 'AbortError' });
    expect(pending.terminate).toHaveBeenCalledOnce();
    const lateBitmap = { close: vi.fn() };
    pending.onmessage?.(new MessageEvent('message', { data: { bitmap: lateBitmap } }));
    expect(lateBitmap.close).toHaveBeenCalledOnce();
  });
  it('fails clearly when native HEIF decoding and workers are unavailable', async () => {
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(() => Promise.reject(new Error('Unsupported HEIF'))),
    );
    vi.stubGlobal('Worker', undefined);
    await expect(decodeRasterBitmap(new Blob(['photo'], { type: 'image/heic' }))).rejects.toThrow(
      'requires worker support',
    );
  });
});
