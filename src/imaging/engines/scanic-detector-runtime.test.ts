import { SCANIC_ML_ASSET_BASE } from './scanic-ml-assets';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  return { width: 10, height: 10, data: new Uint8ClampedArray(400) } as ImageData;
}

afterEach(() => vi.unstubAllGlobals());
beforeEach(() => {
  vi.stubGlobal(
    'OffscreenCanvas',
    class {
      getContext() {
        return {
          putImageData: vi.fn(),
          clearRect: vi.fn(),
          drawImage: vi.fn(),
          getImageData: () => ({ data: new Uint8ClampedArray(224 * 224 * 4) }),
        };
      }
    },
  );
});

describe('Scanic detector runtime recovery', () => {
  it.each(['offscreen', 'dom'] as const)(
    'reuses two %s canvases and one normalized input across repeated detections',
    async (surface) => {
      const rgba = new Uint8ClampedArray(224 * 224 * 4);
      for (let offset = 0; offset < rgba.length; offset += 4) rgba.set([20, 40, 60, 255], offset);
      const context = {
        putImageData: vi.fn(),
        clearRect: vi.fn(),
        drawImage: vi.fn(),
        getImageData: vi.fn(() => ({ data: rgba })),
        imageSmoothingEnabled: false,
        imageSmoothingQuality: 'low',
      };
      const allocated: { width: number; height: number }[] = [];
      class Canvas {
        constructor(
          public width: number,
          public height: number,
        ) {
          allocated.push(this);
        }
        getContext() {
          return context;
        }
      }
      vi.stubGlobal('OffscreenCanvas', surface === 'offscreen' ? Canvas : undefined);
      const canvasDocument: { createElement: (tag: 'canvas') => HTMLCanvasElement } = document;
      const createElement = canvasDocument.createElement.bind(document);
      vi.spyOn(canvasDocument, 'createElement').mockImplementation(() => {
        const element = createElement('canvas');
        allocated.push(element);
        Object.defineProperty(element, 'getContext', { value: () => context });
        return element;
      });
      const inputs = new Set<Float32Array>();
      const scanner = {
        initialize: vi.fn(() => Promise.resolve()),
        scan: vi.fn((_image: ImageData, options: DetectionOptions) => {
          const input = (options.ml as { inputData?: Float32Array }).inputData;
          expect(input).toBeInstanceOf(Float32Array);
          if (input === undefined) throw new Error('Missing prepared model input.');
          expect(input).toHaveLength(224 * 224 * 3);
          expect(input[0]).toBeCloseTo((20 / 255 - 0.485) / 0.229);
          expect(input[1]).toBeCloseTo((40 / 255 - 0.456) / 0.224);
          expect(input[2]).toBeCloseTo((60 / 255 - 0.406) / 0.225);
          inputs.add(input);
          return Promise.resolve(result);
        }),
      };
      const runtime = new ScanicDetectorRuntime(() => scanner);
      await runtime.initialize();
      for (let frame = 0; frame < 30; frame++) await runtime.scan(image());
      expect(allocated).toHaveLength(2);
      expect(inputs.size).toBe(1);
      expect(context.drawImage).toHaveBeenCalledTimes(30);
      expect(context.clearRect).toHaveBeenCalledTimes(30);
      expect(context.imageSmoothingQuality).toBe('medium');
    },
  );

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
    expect(createScanner.mock.calls[0]?.[0]).toMatchObject({
      detector: 'ml',
      ml: { numThreads: 1, assetBaseUrl: SCANIC_ML_ASSET_BASE },
    });
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
