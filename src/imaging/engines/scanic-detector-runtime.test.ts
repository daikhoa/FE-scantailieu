import { describe, expect, it, vi } from 'vitest';
import type { DetectionOptions, ScannerResult } from 'scanic';

import { ScanicDetectorRuntime } from './scanic-detector-runtime';

const result = {
  success: true,
  message: 'document found',
  confidence: 0.91,
  output: null,
  corners: {
    topLeft: { x: 1, y: 1 },
    topRight: { x: 9, y: 1 },
    bottomRight: { x: 9, y: 9 },
    bottomLeft: { x: 1, y: 9 },
  },
  contour: null,
  debug: null,
  timings: [],
} satisfies ScannerResult;

function image(): ImageData {
  return { width: 10, height: 10 } as ImageData;
}

describe('Scanic detector runtime recovery', () => {
  it('uses the ML detector for normal document frames', async () => {
    const ml = {
      initialize: vi.fn(() => Promise.resolve()),
      scan: vi.fn(() => Promise.resolve(result)),
    };
    const createScanner = vi.fn<(options: DetectionOptions) => typeof ml>(() => ml);
    const runtime = new ScanicDetectorRuntime(createScanner);

    await runtime.initialize();

    await expect(runtime.scan(image())).resolves.toMatchObject({
      detector: 'ml',
      success: true,
    });
    expect(createScanner.mock.calls[0]?.[0]).toMatchObject({ detector: 'ml' });
  });

  it('retries a fresh ML scanner after one transient failure', async () => {
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

    await expect(runtime.scan(image())).resolves.toMatchObject({
      detector: 'ml',
      success: true,
    });
    expect(createScanner).toHaveBeenCalledTimes(2);
    expect(createScanner.mock.calls.map(([options]) => options.detector)).toEqual(['ml', 'ml']);
  });

  it('uses the classical detector only after two consecutive ML scanners fail', async () => {
    const broken = () => ({
      initialize: vi.fn(() => Promise.resolve()),
      scan: vi.fn(() => Promise.reject(new Error('ML failed'))),
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
    expect(createScanner.mock.calls.map(([options]) => options.detector)).toEqual([
      'ml',
      'ml',
      'classical',
    ]);
  });
});
