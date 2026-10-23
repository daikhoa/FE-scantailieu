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

  it('propagates ML failure without ever constructing a classical detector', async () => {
    const scanner = {
      initialize: vi.fn(() => Promise.resolve()),
      scan: vi.fn(() => Promise.reject(new Error('ML failed'))),
    };
    const createScanner = vi.fn(() => scanner);
    const runtime = new ScanicDetectorRuntime(createScanner);
    await runtime.initialize();
    await expect(runtime.scan(image())).rejects.toThrow('ML failed');
    expect(createScanner).toHaveBeenCalledOnce();
    expect(createScanner.mock.calls[0]).toEqual([expect.objectContaining({ detector: 'ml' })]);
  });
});
