import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createBrowserRgbaCodec } from './browser-rgba-codec';

const dimensions = { width: 2, height: 2 };
const rgba = new Uint8ClampedArray([
  10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255, 100, 110, 120, 255,
]);

class FakeImageData {
  constructor(
    readonly data: Uint8ClampedArray,
    readonly width: number,
    readonly height: number,
  ) {}
}

class FakeContext {
  readonly drawImage = vi.fn();
  readonly putImageData = vi.fn();
  readonly getImageData = vi.fn(() => new FakeImageData(rgba, 2, 2));
}

class FakeOffscreenCanvas {
  static instances: FakeOffscreenCanvas[] = [];
  readonly context = new FakeContext();
  readonly convertToBlob = vi.fn(() =>
    Promise.resolve(new Blob(['encoded'], { type: 'image/png' })),
  );

  constructor(
    public width: number,
    public height: number,
  ) {
    FakeOffscreenCanvas.instances.push(this);
  }

  getContext() {
    return this.context;
  }
}

const bitmap = () => ({ width: 2, height: 2, close: vi.fn() });

beforeEach(() => {
  FakeOffscreenCanvas.instances = [];
  vi.stubGlobal('ImageData', FakeImageData);
  vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('browser RGBA codec', () => {
  it('decodes a bounded raster without duplicating ImageData and releases resources', async () => {
    const decoded = bitmap();
    const create = vi.fn(() => Promise.resolve(decoded));
    vi.stubGlobal('createImageBitmap', create);
    const codec = createBrowserRgbaCodec();
    const blob = new Blob(['jpeg'], { type: 'image/jpeg' });

    const result = await codec.decode({ blob, dimensions }, new AbortController().signal);

    expect(create).toHaveBeenCalledWith(blob, { imageOrientation: 'none' });
    expect(result).toEqual({ dimensions, pixels: rgba });
    expect(result.pixels).toBe(rgba);
    expect(decoded.close).toHaveBeenCalledOnce();
    const surface = FakeOffscreenCanvas.instances[0];
    expect(surface?.context.drawImage).toHaveBeenCalledWith(decoded, 0, 0);
    expect(surface).toMatchObject({ width: 1, height: 1 });
  });

  it('rejects unsupported or empty input before invoking the browser decoder', async () => {
    const create = vi.fn();
    vi.stubGlobal('createImageBitmap', create);
    const codec = createBrowserRgbaCodec();

    await expect(
      codec.decode(
        { blob: new Blob(['svg'], { type: 'image/svg+xml' }), dimensions },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'invalid-input' });
    await expect(
      codec.decode(
        { blob: new Blob([], { type: 'image/png' }), dimensions },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'invalid-input' });
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects decoded dimensions that do not match immutable asset metadata', async () => {
    const decoded = { width: 3, height: 2, close: vi.fn() };
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(() => Promise.resolve(decoded)),
    );
    const codec = createBrowserRgbaCodec();

    await expect(
      codec.decode(
        { blob: new Blob(['png'], { type: 'image/png' }), dimensions },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'invalid-input' });
    expect(decoded.close).toHaveBeenCalledOnce();
    expect(FakeOffscreenCanvas.instances).toHaveLength(0);
  });

  it('closes a late bitmap and returns a sanitized AbortError after cancellation', async () => {
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
    const codec = createBrowserRgbaCodec();
    const controller = new AbortController();
    const job = codec.decode(
      { blob: new Blob(['png'], { type: 'image/png' }), dimensions },
      controller.signal,
    );
    controller.abort('private document metadata');
    const decoded = bitmap();
    resolveBitmap?.(decoded);

    await expect(job).rejects.toMatchObject({
      name: 'AbortError',
      message: 'Scanner operation cancelled.',
    });
    expect(decoded.close).toHaveBeenCalledOnce();
  });

  it('encodes RGBA through an owned surface and validates the output blob', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn());
    const codec = createBrowserRgbaCodec();

    const sourcePixels = rgba.slice();
    const result = await codec.encode(
      { dimensions, pixels: sourcePixels },
      { type: 'image/png' },
      new AbortController().signal,
    );

    expect(result).toBeInstanceOf(Blob);
    expect(result.type).toBe('image/png');
    const surface = FakeOffscreenCanvas.instances[0];
    expect(surface?.context.putImageData).toHaveBeenCalledWith(expect.any(FakeImageData), 0, 0);
    const written = surface?.context.putImageData.mock.calls[0]?.[0] as FakeImageData | undefined;
    expect(written?.data).toBe(sourcePixels);
    expect(surface?.convertToBlob).toHaveBeenCalledWith({ type: 'image/png' });
    expect(surface).toMatchObject({ width: 1, height: 1 });
  });

  it('uses an HTML canvas fallback when OffscreenCanvas is unavailable', async () => {
    vi.stubGlobal('OffscreenCanvas', undefined);
    const context = new FakeContext();
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => context),
      toBlob: vi.fn((callback: BlobCallback) => {
        callback(new Blob(['encoded'], { type: 'image/png' }));
      }),
    };
    const createCanvas = vi
      .spyOn(document, 'createElement')
      .mockReturnValue(canvas as unknown as HTMLCanvasElement);
    const codec = createBrowserRgbaCodec();

    const result = await codec.encode(
      { dimensions, pixels: rgba.slice() },
      { type: 'image/png' },
      new AbortController().signal,
    );

    expect(result.type).toBe('image/png');
    expect(createCanvas).toHaveBeenCalledWith('canvas');
    expect(canvas.toBlob).toHaveBeenCalled();
    expect(canvas).toMatchObject({ width: 1, height: 1 });
  });
});
