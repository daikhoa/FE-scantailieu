import { SCANIC_ML_ASSET_BASE } from './scanic-ml-assets';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScanicWorkerRequest } from './scanic-worker-backend';
import type { renderDocscanRgba } from './docscan-raster';

const raster = vi.hoisted(() => ({ render: vi.fn<typeof renderDocscanRgba>() }));
vi.mock('@docscan/browser/internal/imaging/engines/docscan-raster', () => ({
  renderDocscanRgba: raster.render,
}));

const vendor = vi.hoisted(() => ({
  initialize: vi.fn(() => Promise.resolve()),
  scan: vi.fn(() => Promise.resolve({ success: false, corners: null, confidence: null })),
  options: [] as unknown[],
}));

vi.mock('scanic', () => ({
  Scanner: class {
    constructor(options: unknown) {
      vendor.options.push(options);
    }
    initialize = vendor.initialize;
    scan = vendor.scan;
  },
}));

class FakeImageData {
  constructor(
    readonly data: Uint8ClampedArray,
    readonly width: number,
    readonly height: number,
  ) {}
}

let receive: EventListenerOrEventListenerObject | null = null;
let response = vi.fn<(message: unknown, options?: StructuredSerializeOptions) => void>();

beforeEach(async () => {
  vi.resetModules();
  raster.render.mockReset();
  vendor.options = [];
  vendor.initialize.mockReset().mockResolvedValue(undefined);
  vendor.scan.mockReset().mockResolvedValue({ success: false, corners: null, confidence: null });
  receive = null;
  response = vi.fn<(message: unknown, options?: StructuredSerializeOptions) => void>();
  vi.stubGlobal('ImageData', FakeImageData);
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
  vi.spyOn(globalThis, 'postMessage').mockImplementation(response);
  vi.spyOn(globalThis, 'addEventListener').mockImplementation((type, listener) => {
    if (type === 'message') receive = listener;
  });
  await import('./scanic-classical.worker');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function send(request: ScanicWorkerRequest) {
  if (receive === null) throw new Error('Worker listener missing.');
  const event = new MessageEvent('message', { data: request });
  if (typeof receive === 'function') receive(event);
  else receive.handleEvent(event);
  await vi.waitFor(() => {
    expect(
      response.mock.calls.some(([message]) => {
        return (
          typeof message === 'object' &&
          message !== null &&
          'id' in message &&
          message.id === request.id
        );
      }),
    ).toBe(true);
  });
}

describe('Scanic document detector worker runtime', () => {
  it('uses the ML detector with no vendor DOM/image types in its reply', async () => {
    await send({ id: 1, operation: 'initialize' });
    expect(vendor.options).toEqual([
      {
        detector: 'ml',
        mode: 'detect',
        output: 'imagedata',
        debug: false,
        maxProcessingDimension: 8192,
        ml: {
          assetBaseUrl: SCANIC_ML_ASSET_BASE,
          numThreads: 1,
          minScore: 0.5,
          modelFetchTimeoutMs: 30_000,
        },
      },
    ]);
    const pixels = new Uint8ClampedArray(16);
    await send({
      id: 2,
      operation: 'detect',
      input: { dimensions: { width: 2, height: 2 }, pixels },
    });
    expect(vendor.scan).toHaveBeenCalledWith(new FakeImageData(pixels, 2, 2), {
      detector: 'ml',
      mode: 'detect',
      output: 'imagedata',
      debug: false,
      maxProcessingDimension: 8192,
      ml: {
        assetBaseUrl: SCANIC_ML_ASSET_BASE,
        numThreads: 1,
        minScore: 0.5,
        modelFetchTimeoutMs: 30_000,
        inputData: expect.any(Float32Array) as unknown,
      },
    });
    expect(response).toHaveBeenLastCalledWith({
      id: 2,
      kind: 'success',
      output: { success: false, corners: null, confidence: null, detector: 'ml' },
    });
  });

  it('reports ML failure without constructing a classical detector', async () => {
    await send({ id: 1, operation: 'initialize' });
    vendor.scan.mockRejectedValue(new Error('ML failed'));
    await send({
      id: 2,
      operation: 'detect',
      input: { dimensions: { width: 2, height: 2 }, pixels: new Uint8ClampedArray(16) },
    });
    expect(vendor.options).toEqual([expect.objectContaining({ detector: 'ml' })]);
    expect(vendor.scan).toHaveBeenCalledOnce();
    expect(response).toHaveBeenLastCalledWith({ id: 2, kind: 'failure', code: 'failed' });
  });

  it('delegates filter/rotation to the shared C++ adapter and transfers its owned output', async () => {
    await send({ id: 1, operation: 'initialize' });
    const pixels = new Uint8ClampedArray([
      10, 10, 10, 255, 20, 20, 20, 255, 30, 30, 30, 255, 40, 40, 40, 255, 50, 50, 50, 255, 60, 60,
      60, 255,
    ]);
    const nativeOutput = {
      dimensions: { width: 3, height: 2 },
      pixels: new Uint8ClampedArray(24).fill(255),
    };
    raster.render.mockResolvedValue({
      image: nativeOutput,
      reservedBytes: 16_777_216,
      inputPixelBytes: pixels.byteLength,
    });
    await send({
      id: 2,
      operation: 'warp',
      input: { dimensions: { width: 2, height: 3 }, pixels },
      corners: [
        { x: 0, y: 0 },
        { x: 2, y: 0 },
        { x: 2, y: 3 },
        { x: 0, y: 3 },
      ],
      rotation: 90,
      filter: 'black-and-white',
    });

    const call = response.mock.calls.at(-1);
    const message = call?.[0];
    expect(message).toMatchObject({
      id: 2,
      kind: 'success',
      output: { dimensions: { width: 3, height: 2 } },
    });
    const output =
      typeof message !== 'object' || message === null || !('output' in message)
        ? null
        : message.output;
    const responsePixels =
      typeof output === 'object' && output !== null && 'pixels' in output ? output.pixels : null;
    if (
      typeof output !== 'object' ||
      output === null ||
      !(responsePixels instanceof Uint8ClampedArray)
    ) {
      throw new Error('Expected a worker RGBA response.');
    }
    expect(raster.render).toHaveBeenCalledWith(
      { dimensions: { width: 2, height: 3 }, pixels },
      [
        { x: 0, y: 0 },
        { x: 2, y: 0 },
        { x: 2, y: 3 },
        { x: 0, y: 3 },
      ],
      'black-and-white',
      90,
      undefined,
      undefined,
    );
    expect(responsePixels).toBe(nativeOutput.pixels);
    expect(call?.[1]).toEqual({ transfer: [responsePixels.buffer] });
  });

  it.each(['OffscreenCanvas', 'ImageData'])('fails honestly without %s', async (capability) => {
    vi.stubGlobal(capability, undefined);
    await send({ id: 1, operation: 'initialize' });
    expect(response).toHaveBeenLastCalledWith({ id: 1, kind: 'failure', code: 'unavailable' });
    expect(vendor.options).toEqual([]);
  });

  it('sanitizes backend exceptions rather than returning a successful no-document result', async () => {
    await send({ id: 1, operation: 'initialize' });
    vendor.scan.mockRejectedValue(new Error('private vendor content'));
    await send({
      id: 2,
      operation: 'detect',
      input: { dimensions: { width: 2, height: 2 }, pixels: new Uint8ClampedArray(16) },
    });
    expect(vendor.scan).toHaveBeenCalledOnce();
    expect(response).toHaveBeenLastCalledWith({ id: 2, kind: 'failure', code: 'failed' });
  });

  it('sanitizes invalid warp requests', async () => {
    await send({ id: 1, operation: 'initialize' });
    await send({
      id: 2,
      operation: 'warp',
      input: { dimensions: { width: 2, height: 2 }, pixels: new Uint8ClampedArray(16) },
      corners: [
        { x: 0, y: 0 },
        { x: 2, y: 2 },
        { x: 2, y: 0 },
        { x: 0, y: 2 },
      ],
      rotation: 0,
      filter: 'original',
    });
    expect(response.mock.calls.at(-1)?.[0]).toEqual({
      id: 2,
      kind: 'failure',
      code: 'failed',
    });
  });
});
