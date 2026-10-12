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

  it('does not hide a real worker failure behind a fallback', async () => {
    const worker = backend(() => Promise.reject(new ScannerEngineError('failed')));
    const createFallback = vi.fn(() => Promise.resolve(backend(() => Promise.resolve())));
    const compatible = createCompatibleScanicBackend({
      createWorker: () => worker,
      createFallback,
    });

    await expect(compatible.initialize()).rejects.toMatchObject({ code: 'failed' });
    expect(worker.dispose).toHaveBeenCalledOnce();
    expect(createFallback).not.toHaveBeenCalled();
  });
});
