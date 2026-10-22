import { describe, expect, it, vi } from 'vitest';

import { ScanicDetectorRuntime } from './scanic-detector-runtime';

const result = {
  success: true,
  confidence: 0.91,
  corners: [
    { x: 1, y: 1 },
    { x: 9, y: 1 },
    { x: 9, y: 9 },
    { x: 1, y: 9 },
  ],
};

function image(): ImageData {
  return { width: 10, height: 10 } as ImageData;
}

describe('Scanic detector runtime recovery', () => {
  it('retries a fresh ML scanner after one transient failure instead of degrading immediately', async () => {
    const failedMl = {
      initialize: vi.fn(() => Promise.resolve()),
      scan: vi.fn(() => Promise.reject(new Error('transient'))),
    };
    const recoveredMl = {
      initialize: vi.fn(() => Promise.resolve()),
      scan: vi.fn(() => Promise.resolve(result)),
    };
    const createScanner = vi.fn().mockReturnValueOnce(failedMl).mockReturnValueOnce(recoveredMl);
    const runtime = new ScanicDetectorRuntime(createScanner);

    await runtime.initialize();

    await expect(runtime.scan(image())).resolves.toMatchObject({ detector: 'ml', success: true });
    expect(createScanner).toHaveBeenCalledTimes(2);
  });

  it('uses the classical detector only after two consecutive ML scanners fail', async () => {
    const broken = () => ({
      initialize: vi.fn(() => Promise.resolve()),
      scan: vi.fn(() => Promise.reject(new Error('ml failed'))),
    });
    const classical = {
      initialize: vi.fn(() => Promise.resolve()),
      scan: vi.fn(() => Promise.resolve(result)),
    };
    const createScanner = vi
      .fn()
      .mockReturnValueOnce(broken())
      .mockReturnValueOnce(broken())
      .mockReturnValueOnce(classical);
    const runtime = new ScanicDetectorRuntime(createScanner);

    await runtime.initialize();

    await expect(runtime.scan(image())).resolves.toMatchObject({
      detector: 'classical',
      success: true,
    });
    expect(createScanner).toHaveBeenCalledTimes(3);
  });
});
