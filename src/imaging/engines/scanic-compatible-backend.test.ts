import { describe, expect, it, vi } from 'vitest';

import type { ClassicalBackend } from './scanic-backend-contract';
import { ScannerEngineError } from './scanner-engine-error';
import { createCompatibleScanicBackend } from './scanic-compatible-backend';

function backend(initialize: ClassicalBackend['initialize']): ClassicalBackend {
  return {
    initialize: vi.fn(initialize),
    detect: vi.fn(() => Promise.resolve({ success: false, corners: null, confidence: null })),
    warp: vi.fn(() => Promise.reject(new Error('not used'))),
    dispose: vi.fn(() => Promise.resolve()),
  };
}

describe('compatible Scanic backend', () => {
  it('recreates the main-thread ML realm on failure too', async () => {
    const failed = backend(() => Promise.resolve());
    const recovered = backend(() => Promise.resolve());
    vi.mocked(failed.detect).mockRejectedValue(new ScannerEngineError('failed'));
    const createFallback = vi.fn().mockResolvedValueOnce(failed).mockResolvedValueOnce(recovered);
    const compatible = createCompatibleScanicBackend({
      createWorker: () => {
        throw new ScannerEngineError('unavailable');
      },
      createFallback,
    });
    await compatible.initialize();
    await compatible.detect({
      dimensions: { width: 1, height: 1 },
      pixels: new Uint8ClampedArray(4),
    });
    expect(failed.dispose).toHaveBeenCalledOnce();
    expect(recovered.detect).toHaveBeenCalledOnce();
    await compatible.dispose();
  });
  it('does not initialize a late fallback after disposal', async () => {
    const fallback = backend(() => Promise.resolve());
    let deliver: ((value: ClassicalBackend) => void) | undefined;
    const compatible = createCompatibleScanicBackend({
      createWorker: () => {
        throw new ScannerEngineError('unavailable');
      },
      createFallback: () =>
        new Promise((resolve) => {
          deliver = resolve;
        }),
    });
    const initialization = compatible.initialize();
    await vi.waitFor(() => {
      expect(deliver).toBeDefined();
    });
    await compatible.dispose();
    deliver?.(fallback);
    await expect(initialization).rejects.toMatchObject({ code: 'unavailable' });
    expect(fallback.initialize).not.toHaveBeenCalled();
    expect(fallback.dispose).toHaveBeenCalledOnce();
  });
  it('destroys a failed ML realm before retrying once in a fresh worker', async () => {
    const first = backend(() => Promise.resolve());
    const second = backend(() => Promise.resolve());
    vi.mocked(first.detect)
      .mockResolvedValueOnce({ success: false, corners: null, confidence: null })
      .mockRejectedValue(new ScannerEngineError('failed'));
    const createWorker = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const compatible = createCompatibleScanicBackend({ createWorker });
    await compatible.initialize();
    await compatible.detect({
      dimensions: { width: 1, height: 1 },
      pixels: new Uint8ClampedArray(4),
    });
    await compatible.detect({
      dimensions: { width: 1, height: 1 },
      pixels: new Uint8ClampedArray(4),
    });
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(createWorker).toHaveBeenCalledTimes(2);
    expect(second.detect).toHaveBeenCalledOnce();
    await compatible.dispose();
  });

  it('bounds retry to two ML workers when both fail', async () => {
    const first = backend(() => Promise.resolve());
    vi.mocked(first.detect)
      .mockResolvedValueOnce({ success: false, corners: null, confidence: null })
      .mockRejectedValue(new ScannerEngineError('failed'));
    const second = backend(() => Promise.resolve());
    vi.mocked(second.detect).mockRejectedValue(new ScannerEngineError('failed'));
    const createWorker = vi
      .fn<() => ClassicalBackend>()
      .mockReturnValueOnce(first)
      .mockReturnValue(second);
    const compatible = createCompatibleScanicBackend({ createWorker });
    await compatible.initialize();
    await compatible.detect({
      dimensions: { width: 1, height: 1 },
      pixels: new Uint8ClampedArray(4),
    });
    await expect(
      compatible.detect({ dimensions: { width: 1, height: 1 }, pixels: new Uint8ClampedArray(4) }),
    ).rejects.toMatchObject({ code: 'failed' });
    expect(createWorker).toHaveBeenCalledTimes(2);
    await compatible.dispose();
  });
  it('falls back to the DOM implementation when the worker lacks OffscreenCanvas', async () => {
    const worker = backend(() => Promise.reject(new ScannerEngineError('unavailable')));
    const fallback = backend(() => Promise.resolve());
    const createFallback = vi.fn(() => Promise.resolve(fallback));
    const compatible = createCompatibleScanicBackend({
      createWorker: () => worker,
      createFallback,
    });

    await compatible.initialize();
    await compatible.detect({
      dimensions: { width: 1, height: 1 },
      pixels: new Uint8ClampedArray(4),
    });
    await compatible.dispose();

    expect(worker.dispose).toHaveBeenCalledOnce();
    expect(createFallback).toHaveBeenCalledOnce();
    expect(fallback.initialize).toHaveBeenCalledOnce();
    expect(fallback.detect).toHaveBeenCalledOnce();
    expect(fallback.dispose).toHaveBeenCalledOnce();
  });

  it.each(['failed', 'timeout'] as const)(
    'tries the same ML fallback when worker startup reports %s',
    async (code) => {
      const worker = backend(() => Promise.reject(new ScannerEngineError(code)));
      const fallback = backend(() => Promise.resolve());
      const createFallback = vi.fn(() => Promise.resolve(fallback));
      const compatible = createCompatibleScanicBackend({
        createWorker: () => worker,
        createFallback,
      });
      await compatible.initialize();
      expect(worker.dispose).toHaveBeenCalledOnce();
      expect(createFallback).toHaveBeenCalledOnce();
      await compatible.dispose();
    },
  );

  it('falls back when the worker initializes but its first ML inference fails', async () => {
    const worker = backend(() => Promise.resolve());
    vi.mocked(worker.detect).mockRejectedValue(new ScannerEngineError('failed'));
    const fallback = backend(() => Promise.resolve());
    const createWorker = vi.fn(() => worker);
    const compatible = createCompatibleScanicBackend({
      createWorker,
      createFallback: () => Promise.resolve(fallback),
    });
    await compatible.initialize();
    const pixels = new Uint8ClampedArray([10, 20, 30, 255]);
    await expect(
      compatible.detect({ dimensions: { width: 1, height: 1 }, pixels }),
    ).resolves.toMatchObject({ success: false });
    expect(createWorker).toHaveBeenCalledOnce();
    expect(worker.dispose).toHaveBeenCalledOnce();
    expect(fallback.detect).toHaveBeenCalledWith({ dimensions: { width: 1, height: 1 }, pixels });
    await compatible.dispose();
  });

  it('propagates failure if both worker and compatible ML runtime fail', async () => {
    const worker = backend(() => Promise.reject(new ScannerEngineError('failed')));
    const fallback = backend(() => Promise.reject(new ScannerEngineError('failed')));
    const compatible = createCompatibleScanicBackend({
      createWorker: () => worker,
      createFallback: () => Promise.resolve(fallback),
    });
    await expect(compatible.initialize()).rejects.toMatchObject({ code: 'failed' });
    expect(worker.dispose).toHaveBeenCalledOnce();
    expect(fallback.dispose).toHaveBeenCalledOnce();
    await compatible.dispose();
  });
});
