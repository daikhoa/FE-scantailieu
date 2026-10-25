import { describe, expect, it, vi } from 'vitest';
import type { DocumentCorners, EditRecipe } from '../../domain/document';
import type { RgbaImageCodec } from '../codecs/rgba-image-codec';
import {
  createRgbaScannerFrame,
  createOneShotScannerFrame,
  createScanicClassicalEngine,
  type ClassicalBackend,
} from './scanic-classical-engine';

const dimensions = { width: 20, height: 10 };
const corners: DocumentCorners = [
  { x: 1, y: 1 },
  { x: 19, y: 1 },
  { x: 19, y: 9 },
  { x: 1, y: 9 },
];
const documentResult = {
  success: true,
  confidence: 0.8,
  corners: {
    topLeft: corners[0],
    topRight: corners[1],
    bottomRight: corners[2],
    bottomLeft: corners[3],
  },
};
const noDocument = { success: false, corners: null, confidence: null };
const signal = () => new AbortController().signal;
const frame = () => createRgbaScannerFrame(dimensions, new Uint8ClampedArray(800));

function deferred<T>() {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return {
    promise,
    resolve(value: T) {
      if (resolve === undefined) throw new Error('Deferred was not initialized.');
      resolve(value);
    },
  };
}

function fakeBackend(): ClassicalBackend {
  return {
    initialize: vi.fn(() => Promise.resolve()),
    detect: vi.fn(() => Promise.resolve(noDocument)),
    warp: vi.fn(() => Promise.reject(new Error('Warp is not configured for this test.'))),
    dispose: vi.fn(() => Promise.resolve()),
  };
}

function fakeCodec(): RgbaImageCodec {
  return {
    decode: vi.fn(() =>
      Promise.resolve({ dimensions, pixels: new Uint8ClampedArray(800).fill(7) }),
    ),
    encode: vi.fn(() => Promise.resolve(new Blob(['rendered'], { type: 'image/png' }))),
  };
}

async function ready(backend = fakeBackend()) {
  const engine = createScanicClassicalEngine({ createBackend: () => backend });
  await engine.initialize(signal());
  return { engine, backend };
}

describe('Scanic RGBA frames', () => {
  it('hands newly captured pixels directly to the backend once, without source copies', async () => {
    const pixels = new Uint8ClampedArray(800);
    const input = createOneShotScannerFrame(dimensions, pixels);
    const { engine, backend } = await ready();
    await engine.detect(input, signal());
    const detect = vi.mocked(backend.detect);
    expect(detect.mock.calls.at(-1)?.[0].pixels === pixels).toBe(true);
    await expect(engine.detect(input, signal())).rejects.toMatchObject({ code: 'invalid-input' });
    input.close();
    await engine.dispose();
  });

  it('renders a 48MP encoded original through the asset backend without full RGBA decoding', async () => {
    const backend = fakeBackend();
    const codec = fakeCodec();
    const decode = vi.spyOn(codec, 'decode');
    const warpAsset = vi.fn<NonNullable<ClassicalBackend['warpAsset']>>(() =>
      Promise.resolve({ dimensions, pixels: new Uint8ClampedArray(800) }),
    );
    backend.warpAsset = warpAsset;
    const engine = createScanicClassicalEngine({ createBackend: () => backend, codec });
    await engine.initialize(signal());
    const original = {
      blob: new Blob(['photo'], { type: 'image/jpeg' }),
      dimensions: { width: 8000, height: 6000 },
    };
    const recipe: EditRecipe = {
      version: 1,
      crop: { kind: 'full-frame' },
      rotation: 0,
      dewarp: { mode: 'perspective-only' },
      filter: { mode: 'original', presetVersion: 'original-v1', parameters: {} },
    };
    await engine.render(
      { original, orientation: 0, recipe, maximumOutputLongSide: 3000 },
      signal(),
    );
    expect(decode).not.toHaveBeenCalled();
    expect(warpAsset).toHaveBeenCalledWith(
      expect.objectContaining({ asset: original, maximumOutputLongSide: 3000 }),
    );
    await engine.dispose();
  });

  it('still bounds raw RGBA frames even when byte length matches oversized dimensions', () => {
    expect(() =>
      createRgbaScannerFrame({ width: 8193, height: 1 }, new Uint8ClampedArray(8193 * 4)),
    ).toThrow();
  });

  it.each([
    [{ width: 0, height: 10 }, 0],
    [{ width: 1.5, height: 10 }, 60],
    [{ width: 20, height: 10 }, 799],
    [{ width: 20, height: 10 }, 801],
    [{ width: 8193, height: 1 }, 0],
    [{ width: 8192, height: 8192 }, 0],
  ])('rejects invalid, mismatched or excessive frame storage (%j)', (size, byteLength) => {
    expect(() => createRgbaScannerFrame(size, new Uint8ClampedArray(byteLength))).toThrow();
  });

  it('copies caller pixels and dimensions and remains reusable until idempotently closed', async () => {
    const size = { ...dimensions };
    const pixels = new Uint8ClampedArray(800).fill(7);
    const input = createRgbaScannerFrame(size, pixels);
    pixels.fill(99);
    size.width = 4;
    const observed: number[] = [];
    const backend = fakeBackend();
    backend.detect = (image) => {
      if (image.dimensions.width === 20) {
        observed.push(image.pixels[0] ?? -1);
        image.pixels.fill(100);
      }
      return Promise.resolve(noDocument);
    };
    const { engine } = await ready(backend);
    await engine.detect(input, signal());
    await engine.detect(input, signal());
    expect(observed).toEqual([7, 7]);
    expect(input.dimensions).toEqual(dimensions);
    input.close();
    input.close();
    await expect(engine.detect(input, signal())).rejects.toMatchObject({ code: 'invalid-input' });
    expect(engine.lifecycle.kind).toBe('ready');
    await engine.dispose();
  });

  it('rejects foreign opaque handles without closing or poisoning them', async () => {
    const { engine } = await ready();
    const close = vi.fn();
    await expect(engine.detect({ dimensions, close }, signal())).rejects.toMatchObject({
      code: 'invalid-input',
    });
    expect(close).not.toHaveBeenCalled();
    expect(engine.lifecycle.kind).toBe('ready');
    await engine.dispose();
  });
});

describe('Scanic classical lifecycle', () => {
  it('warms the detector with a realistic model input instead of an 8 px frame', async () => {
    const backend = fakeBackend();
    const engine = createScanicClassicalEngine({ createBackend: () => backend });

    await engine.initialize(signal());

    expect(backend.detect).toHaveBeenCalledOnce();
    const warmupFrame = vi.mocked(backend.detect).mock.calls[0]?.[0];

    expect(warmupFrame?.dimensions).toEqual({ width: 224, height: 224 });
    expect(warmupFrame?.pixels).toBeInstanceOf(Uint8ClampedArray);
    expect(warmupFrame?.pixels.byteLength).toBe(224 * 224 * 4);
    await engine.dispose();
  });

  it('does not report ready when upstream initialization resolves but detection warmup fails', async () => {
    const backend = fakeBackend();
    backend.detect = () => Promise.reject(new Error('private upstream diagnostics'));
    const engine = createScanicClassicalEngine({ createBackend: () => backend });
    expect(engine.lifecycle.kind).toBe('uninitialized');
    const initialization = engine.initialize(signal());
    expect(engine.lifecycle.kind).toBe('initializing');
    await expect(initialization).rejects.toMatchObject({ code: 'failed' });
    expect(engine.lifecycle).toEqual({ kind: 'failed', error: { code: 'failed' } });
    expect(backend.dispose).toHaveBeenCalledOnce();
    await engine.dispose();
  });

  it('validates successful warmup output rather than accepting malformed success', async () => {
    const backend = fakeBackend();
    backend.detect = () => Promise.resolve({ success: true, confidence: 1, corners: null });
    const engine = createScanicClassicalEngine({ createBackend: () => backend });
    await expect(engine.initialize(signal())).rejects.toMatchObject({ code: 'failed' });
    expect(engine.lifecycle.kind).toBe('failed');
    await engine.dispose();
  });

  it('rejects detect/render before initialization and initialization after disposal', async () => {
    const engine = createScanicClassicalEngine({ createBackend: fakeBackend });
    const input = frame();
    await expect(engine.detect(input, signal())).rejects.toMatchObject({ code: 'unavailable' });
    await engine.dispose();
    await expect(engine.initialize(signal())).rejects.toMatchObject({ code: 'unavailable' });
    expect(engine.lifecycle.kind).toBe('disposed');
    input.close();
  });

  it('requires an explicit valid confidence threshold', () => {
    for (const minimumConfidence of [-1, 2, Number.NaN]) {
      expect(() => createScanicClassicalEngine({ minimumConfidence })).toThrow();
    }
    for (const mlMinimumConfidence of [-1, 2, Number.NaN]) {
      expect(() => createScanicClassicalEngine({ mlMinimumConfidence })).toThrow();
    }
  });

  it('rejects pre-aborted initialization without allocating a backend', async () => {
    const createBackend = vi.fn(fakeBackend);
    const engine = createScanicClassicalEngine({ createBackend });
    const controller = new AbortController();
    controller.abort('private reason');
    await expect(engine.initialize(controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(createBackend).not.toHaveBeenCalled();
    expect(engine.lifecycle.kind).toBe('uninitialized');
    await engine.dispose();
  });

  it('cleans cancelled initialization and allows a fresh attempt', async () => {
    const entered = deferred<undefined>();
    const pending = deferred<undefined>();
    const backend = fakeBackend();
    backend.initialize = () => {
      entered.resolve(undefined);
      return pending.promise;
    };
    const engine = createScanicClassicalEngine({ createBackend: () => backend });
    const controller = new AbortController();
    const job = engine.initialize(controller.signal);
    const rejected = expect(job).rejects.toMatchObject({ name: 'AbortError' });
    await entered.promise;
    controller.abort();
    pending.resolve(undefined);
    await rejected;
    expect(backend.dispose).toHaveBeenCalledOnce();
    expect(engine.lifecycle.kind).toBe('uninitialized');
    backend.initialize = () => Promise.resolve();
    await engine.initialize(signal());
    expect(engine.lifecycle.kind).toBe('ready');
    await engine.dispose();
  });
});

describe('Scanic result boundary', () => {
  it.each([
    { ...documentResult.corners, topLeft: { x: -1, y: 1 } },
    { ...documentResult.corners, bottomRight: { x: 21, y: 9 } },
    { ...documentResult.corners, bottomLeft: corners[0] },
    { ...documentResult.corners, topRight: corners[2], bottomRight: corners[1] },
    { topLeft: corners[0], topRight: corners[3], bottomRight: corners[2], bottomLeft: corners[1] },
  ])(
    'continues detection after an unusable ML prediction instead of restarting the runtime (%j)',
    async (prediction) => {
      const { engine, backend } = await ready();
      const detect = vi
        .fn()
        .mockResolvedValueOnce({ ...documentResult, detector: 'ml', corners: prediction })
        .mockResolvedValueOnce({ ...documentResult, detector: 'ml' });
      backend.detect = detect;
      const input = frame();
      try {
        await expect(engine.detect(input, signal())).resolves.toMatchObject({
          kind: 'full-frame',
          reason: 'low-confidence',
        });
        expect(engine.lifecycle.kind).toBe('ready');
        expect(backend.dispose).not.toHaveBeenCalled();
        await expect(engine.detect(input, signal())).resolves.toMatchObject({ kind: 'document' });
      } finally {
        input.close();
        await engine.dispose();
      }
    },
  );

  it('keeps full frame for a high-score quadrilateral smaller than two percent of the image', async () => {
    const { engine, backend } = await ready();
    backend.detect = () =>
      Promise.resolve({
        ...documentResult,
        confidence: 0.99,
        detector: 'ml',
        corners: {
          topLeft: { x: 1, y: 1 },
          topRight: { x: 2, y: 1 },
          bottomRight: { x: 2, y: 2 },
          bottomLeft: { x: 1, y: 2 },
        },
      });
    const input = frame();
    await expect(engine.detect(input, signal())).resolves.toMatchObject({
      kind: 'full-frame',
      reason: 'low-confidence',
    });
    input.close();
    await engine.dispose();
  });
  it('maps validated corners in the input frame coordinates', async () => {
    const { engine, backend } = await ready();
    backend.detect = () => Promise.resolve(documentResult);
    const input = frame();
    const result = await engine.detect(input, signal());
    expect(result).toEqual({ kind: 'document', dimensions, corners, confidence: 0.8 });
    // No vendor object is borrowed by the result.
    expect(result.kind === 'document' && result.corners[0]).not.toBe(
      documentResult.corners.topLeft,
    );
    input.close();
    await engine.dispose();
  });

  it('accepts an ML result at the independently calibrated ML threshold', async () => {
    const { engine, backend } = await ready();
    backend.detect = () => Promise.resolve({ ...documentResult, detector: 'ml', confidence: 0.6 });
    const input = frame();
    await expect(engine.detect(input, signal())).resolves.toEqual({
      kind: 'document',
      dimensions,
      corners,
      confidence: 0.6,
    });
    input.close();
    await engine.dispose();
  });

  it('keeps the full frame when ML reports a bounded score below its threshold', async () => {
    const { engine, backend } = await ready();
    backend.detect = () =>
      Promise.resolve({ success: false, corners: null, confidence: 0.4, detector: 'ml' });
    const input = frame();
    await expect(engine.detect(input, signal())).resolves.toEqual({
      kind: 'full-frame',
      dimensions,
      reason: 'low-confidence',
    });
    input.close();
    await engine.dispose();
  });

  it.each([
    [noDocument, 'no-document'],
    [{ ...documentResult, confidence: 0.59 }, 'low-confidence'],
    [{ ...documentResult, confidence: 0.664 }, 'low-confidence'],
  ])('keeps the full frame on uncertain detection', async (output, reason) => {
    const { engine, backend } = await ready();
    backend.detect = () => Promise.resolve(output);
    const input = frame();
    await expect(engine.detect(input, signal())).resolves.toEqual({
      kind: 'full-frame',
      dimensions,
      reason,
    });
    input.close();
    await engine.dispose();
  });

  it.each([
    null,
    {},
    { success: 'yes' },
    { ...documentResult, confidence: null },
    { ...documentResult, confidence: Number.NaN },
    { ...documentResult, confidence: 1.01 },
    { ...documentResult, corners: null },
    { ...documentResult, confidence: 0.1, corners: null },
    { ...documentResult, corners: { ...documentResult.corners, topLeft: { x: -1, y: 1 } } },
    { ...documentResult, corners: { ...documentResult.corners, topLeft: { x: Infinity, y: 1 } } },
    { ...documentResult, corners: { ...documentResult.corners, bottomLeft: corners[0] } },
    {
      ...documentResult,
      corners: { ...documentResult.corners, topRight: corners[2], bottomRight: corners[1] },
    },
    { success: false, corners: documentResult.corners, confidence: 0.1 },
    {
      ...documentResult,
      corners: { ...documentResult.corners, topRight: corners[3], bottomLeft: corners[1] },
    },
  ])('reports malformed upstream results as failure (%j)', async (output) => {
    const { engine, backend } = await ready();
    backend.detect = () => Promise.resolve(output);
    const input = frame();
    await expect(engine.detect(input, signal())).rejects.toMatchObject({ code: 'failed' });
    expect(engine.lifecycle.kind).toBe('failed');
    input.close();
    await engine.dispose();
  });
});

describe('Scanic serialized work, cancellation and cleanup', () => {
  it('returns the rough crop as pixels without an intermediate JPEG encode', async () => {
    const codec = fakeCodec(),
      backend = fakeBackend();
    const raw = { dimensions, pixels: new Uint8ClampedArray(800) };
    backend.warp = () => Promise.resolve(raw);
    const engine = createScanicClassicalEngine({ createBackend: () => backend, codec });
    await engine.initialize(signal());
    const recipe: EditRecipe = {
      version: 1,
      crop: { kind: 'full-frame' },
      rotation: 0,
      dewarp: { mode: 'perspective-only' },
      filter: { mode: 'original', presetVersion: 'rough', parameters: {} },
    };
    await expect(
      engine.renderPixels?.(
        {
          original: { blob: new Blob(['source'], { type: 'image/jpeg' }), dimensions },
          orientation: 0,
          recipe,
          maximumOutputLongSide: 720,
        },
        signal(),
      ),
    ).resolves.toBe(raw);
    expect(vi.mocked(codec).encode.mock.calls).toHaveLength(0);
    await engine.dispose();
  });
  it('shares initialization-failure cleanup with a concurrent dispose', async () => {
    const cleanupStarted = deferred<undefined>();
    const cleanupRelease = deferred<undefined>();
    const backend = fakeBackend();
    backend.initialize = () => Promise.reject(new Error('private initialization failure'));
    backend.dispose = vi.fn(() => {
      cleanupStarted.resolve(undefined);
      return cleanupRelease.promise;
    });
    const engine = createScanicClassicalEngine({ createBackend: () => backend });
    const initialization = engine.initialize(signal());
    const rejected = expect(initialization).rejects.toMatchObject({ name: 'AbortError' });
    await cleanupStarted.promise;

    const disposal = engine.dispose();
    expect(backend.dispose).toHaveBeenCalledOnce();
    cleanupRelease.resolve(undefined);
    await Promise.all([rejected, disposal]);

    expect(backend.dispose).toHaveBeenCalledOnce();
    expect(engine.lifecycle.kind).toBe('disposed');
  });

  it('shares detection-failure cleanup with a concurrent dispose', async () => {
    const { engine, backend } = await ready();
    const cleanupStarted = deferred<undefined>();
    const cleanupRelease = deferred<undefined>();
    backend.detect = () => Promise.reject(new Error('private detection failure'));
    backend.dispose = vi.fn(() => {
      cleanupStarted.resolve(undefined);
      return cleanupRelease.promise;
    });
    const input = frame();
    const detection = engine.detect(input, signal());
    const rejected = expect(detection).rejects.toMatchObject({ name: 'AbortError' });
    await cleanupStarted.promise;

    const disposal = engine.dispose();
    expect(backend.dispose).toHaveBeenCalledOnce();
    cleanupRelease.resolve(undefined);
    await Promise.all([rejected, disposal]);

    expect(backend.dispose).toHaveBeenCalledOnce();
    expect(engine.lifecycle.kind).toBe('disposed');
    input.close();
  });

  it('records a backend failure when caller cancellation happens during cleanup', async () => {
    const { engine, backend } = await ready();
    const controller = new AbortController();
    backend.detect = () => Promise.reject(new Error('private detection failure'));
    backend.dispose = vi.fn(() => {
      controller.abort('private cancellation reason');
      return Promise.resolve();
    });
    const input = frame();

    await expect(engine.detect(input, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });

    expect(backend.dispose).toHaveBeenCalledOnce();
    expect(engine.lifecycle).toEqual({ kind: 'failed', error: { code: 'failed' } });
    await expect(engine.detect(input, signal())).rejects.toMatchObject({ code: 'unavailable' });
    input.close();
    await engine.dispose();
  });

  it('serializes two jobs, bounds backlog and releases frame borrows', async () => {
    const { engine, backend } = await ready();
    const entered = deferred<undefined>();
    const pending = deferred<unknown>();
    let active = 0;
    let maxActive = 0;
    backend.detect = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      entered.resolve(undefined);
      const result = await pending.promise;
      active--;
      return result;
    };
    const input = frame();
    const first = engine.detect(input, signal());
    const second = engine.detect(input, signal());
    await entered.promise;
    expect(() => {
      input.close();
    }).toThrow();
    await expect(engine.detect(input, signal())).rejects.toMatchObject({ code: 'unavailable' });
    pending.resolve(noDocument);
    await Promise.all([first, second]);
    expect(maxActive).toBe(1);
    input.close();
    await engine.dispose();
  });

  it('checks signals at entry and after backend work without returning partial success', async () => {
    const { engine, backend } = await ready();
    const input = frame();
    const before = new AbortController();
    before.abort();
    await expect(engine.detect(input, before.signal)).rejects.toMatchObject({ name: 'AbortError' });
    const controller = new AbortController();
    backend.detect = () => {
      controller.abort('secret reason');
      return Promise.resolve(documentResult);
    };
    await expect(engine.detect(input, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(engine.lifecycle.kind).toBe('ready');
    input.close();
    await engine.dispose();
  });

  it('checks queued cancellation before backend execution', async () => {
    const { engine, backend } = await ready();
    const pending = deferred<unknown>();
    backend.detect = vi.fn(() => pending.promise);
    const input = frame();
    const first = engine.detect(input, signal());
    const controller = new AbortController();
    const second = engine.detect(input, controller.signal);
    const rejected = expect(second).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    pending.resolve(noDocument);
    await first;
    await rejected;
    expect(backend.detect).toHaveBeenCalledOnce();
    input.close();
    await engine.dispose();
  });

  it('settles in-flight work and idempotently disposes its backend', async () => {
    const { engine, backend } = await ready();
    const entered = deferred<undefined>();
    const pending = deferred<unknown>();
    backend.detect = () => {
      entered.resolve(undefined);
      return pending.promise;
    };
    backend.dispose = vi.fn(() => {
      pending.resolve(documentResult);
      return Promise.resolve();
    });
    const input = frame();
    const job = engine.detect(input, signal());
    const rejected = expect(job).rejects.toMatchObject({ name: 'AbortError' });
    await entered.promise;
    const disposal = engine.dispose();
    expect(engine.lifecycle.kind).toBe('disposing');
    expect(engine.dispose()).toBe(disposal);
    await disposal;
    await rejected;
    expect(engine.lifecycle.kind).toBe('disposed');
    expect(backend.dispose).toHaveBeenCalledOnce();
    input.close();
  });

  it('does not conceal backend cleanup failure as disposed', async () => {
    const { engine, backend } = await ready();
    backend.dispose = () => Promise.reject(new Error('private cleanup error'));
    await expect(engine.dispose()).rejects.toMatchObject({ code: 'failed' });
    expect(engine.lifecycle.kind).toBe('failed');
  });

  it('renders the original filter through decode, perspective warp, rotation and high-quality JPEG encode', async () => {
    const recipe: EditRecipe = {
      version: 1,
      crop: { kind: 'full-frame' },
      rotation: 90,
      dewarp: { mode: 'perspective-only' },
      filter: { mode: 'original', presetVersion: '1', parameters: {} },
    };
    const request = {
      original: { blob: new Blob(['original'], { type: 'image/png' }), dimensions },
      orientation: 0 as const,
      recipe,
      preserveOutputPixels: true,
    };
    const backend = fakeBackend();
    const codec = fakeCodec();
    const decode = vi.spyOn(codec, 'decode');
    const encode = vi.spyOn(codec, 'encode');
    const warped = {
      dimensions: { width: 10, height: 20 },
      pixels: new Uint8ClampedArray(800).fill(9),
    };
    const warp = vi.fn(() => Promise.resolve(warped));
    backend.warp = warp;
    const engine = createScanicClassicalEngine({ createBackend: () => backend, codec });
    await engine.initialize(signal());

    const result = await engine.render(request, signal());

    expect(decode).toHaveBeenCalledWith(request.original, expect.any(AbortSignal));
    expect(warp).toHaveBeenCalledWith(
      expect.objectContaining({ dimensions }),
      [
        { x: 0, y: 0 },
        { x: 20, y: 0 },
        { x: 20, y: 10 },
        { x: 0, y: 10 },
      ],
      90,
      'original',
    );
    expect(encode).toHaveBeenCalledWith(
      warped,
      { type: 'image/jpeg', quality: 0.96 },
      expect.any(AbortSignal),
    );
    expect(result.recipeKey).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result).toMatchObject({
      engineVersion: 'scanic-1.6.0+ml-only-perspective-v2-filter-v12-paper-v2',
      image: { dimensions: warped.dimensions },
      dewarp: { kind: 'not-requested' },
    });
    expect(result.image.blob.type).toBe('image/png');
    expect(result.transientRgba).toBe(warped);
    expect(engine.lifecycle.kind).toBe('ready');
    await engine.dispose();
  });

  it('reports an honest perspective fallback for auto dewarp', async () => {
    const codec = fakeCodec();
    const backend = fakeBackend();
    const warp = vi.fn((input) => Promise.resolve(input));
    backend.warp = warp;
    const engine = createScanicClassicalEngine({ createBackend: () => backend, codec });
    await engine.initialize(signal());
    const request = {
      original: { blob: new Blob(['original'], { type: 'image/png' }), dimensions },
      orientation: 0 as const,
      recipe: {
        version: 1,
        crop: { kind: 'document' as const, corners },
        rotation: 0 as const,
        dewarp: { mode: 'auto' as const, policyVersion: 'dewarp-v1' },
        filter: { mode: 'original' as const, presetVersion: '1', parameters: {} },
      },
    };

    await expect(engine.render(request, signal())).resolves.toMatchObject({
      dewarp: { kind: 'fallback', reason: 'unavailable' },
    });
    expect(warp).toHaveBeenCalledWith(expect.anything(), corners, 0, 'original');
    await engine.dispose();
  });

  it.each(['ocr-color', 'enhanced-color'] as const)(
    'passes %s to the worker and honors cancellation',
    async (mode) => {
      const codec = fakeCodec();
      const decode = vi.spyOn(codec, 'decode');
      const backend = fakeBackend();
      backend.warp = vi.fn((input) => Promise.resolve(input));
      const engine = createScanicClassicalEngine({ createBackend: () => backend, codec });
      await engine.initialize(signal());
      const request = {
        original: { blob: new Blob(['original'], { type: 'image/png' }), dimensions },
        orientation: 0 as const,
        recipe: {
          version: 1,
          crop: { kind: 'full-frame' as const },
          rotation: 0 as const,
          dewarp: { mode: 'perspective-only' as const },
          filter: { mode, presetVersion: '1', parameters: {} },
        },
      };

      await expect(engine.render(request, signal())).resolves.toBeDefined();
      expect(decode).toHaveBeenCalledOnce();
      expect(backend.warp).toHaveBeenCalledWith(expect.anything(), expect.anything(), 0, mode);
      const controller = new AbortController();
      controller.abort('private document metadata');
      await expect(engine.render(request, controller.signal)).rejects.toMatchObject({
        name: 'AbortError',
        message: 'Scanner operation cancelled.',
      });
      await engine.dispose();
    },
  );

  it('rejects unknown runtime filters before decoding', async () => {
    const codec = fakeCodec();
    const decode = vi.spyOn(codec, 'decode');
    const backend = fakeBackend();
    const engine = createScanicClassicalEngine({ createBackend: () => backend, codec });
    await engine.initialize(signal());
    const request = {
      original: { blob: new Blob(['original'], { type: 'image/png' }), dimensions },
      orientation: 0 as const,
      recipe: {
        version: 1,
        crop: { kind: 'full-frame' as const },
        rotation: 0 as const,
        dewarp: { mode: 'perspective-only' as const },
        filter: { mode: 'sepia' as never, presetVersion: '1', parameters: {} },
      },
    };

    await expect(engine.render(request, signal())).rejects.toMatchObject({ code: 'invalid-input' });
    expect(decode).not.toHaveBeenCalled();
    expect(backend.warp).not.toHaveBeenCalled();
    await engine.dispose();
  });

  it('rejects unsupported raster input before hashing or decoding', async () => {
    const codec = fakeCodec();
    const decode = vi.spyOn(codec, 'decode');
    const backend = fakeBackend();
    const warp = vi.spyOn(backend, 'warp');
    const engine = createScanicClassicalEngine({ createBackend: () => backend, codec });
    await engine.initialize(signal());
    const request = {
      original: { blob: new Blob(['<svg/>'], { type: 'image/svg+xml' }), dimensions },
      orientation: 0 as const,
      recipe: {
        version: 1,
        crop: { kind: 'full-frame' as const },
        rotation: 0 as const,
        dewarp: { mode: 'perspective-only' as const },
        filter: { mode: 'original' as const, presetVersion: '1', parameters: {} },
      },
    };

    await expect(engine.render(request, signal())).rejects.toMatchObject({
      code: 'invalid-input',
    });
    expect(decode).not.toHaveBeenCalled();
    expect(warp).not.toHaveBeenCalled();
    expect(engine.lifecycle.kind).toBe('ready');
    await engine.dispose();
  });

  it('rejects captured pixels that do not exactly match the durable original', async () => {
    const codec = fakeCodec();
    const decode = vi.spyOn(codec, 'decode');
    const backend = fakeBackend();
    const warp = vi.spyOn(backend, 'warp');
    const engine = createScanicClassicalEngine({ createBackend: () => backend, codec });
    await engine.initialize(signal());
    const request = {
      original: { blob: new Blob(['original'], { type: 'image/png' }), dimensions },
      sourcePixels: {
        dimensions: { width: 19, height: 10 },
        pixels: new Uint8ClampedArray(19 * 10 * 4),
      },
      orientation: 0 as const,
      recipe: {
        version: 1,
        crop: { kind: 'full-frame' as const },
        rotation: 0 as const,
        dewarp: { mode: 'perspective-only' as const },
        filter: { mode: 'original' as const, presetVersion: '1', parameters: {} },
      },
    };

    await expect(engine.render(request, signal())).rejects.toMatchObject({
      code: 'invalid-input',
    });
    expect(decode).not.toHaveBeenCalled();
    expect(warp).not.toHaveBeenCalled();
    expect(engine.lifecycle.kind).toBe('ready');
    await engine.dispose();
  });

  it('fails closed and disposes the backend when perspective rendering fails', async () => {
    const codec = fakeCodec();
    const backend = fakeBackend();
    backend.warp = () => Promise.reject(new Error('private image data'));
    const engine = createScanicClassicalEngine({ createBackend: () => backend, codec });
    await engine.initialize(signal());
    const request = {
      original: { blob: new Blob(['original'], { type: 'image/png' }), dimensions },
      orientation: 0 as const,
      recipe: {
        version: 1,
        crop: { kind: 'full-frame' as const },
        rotation: 0 as const,
        dewarp: { mode: 'perspective-only' as const },
        filter: { mode: 'original' as const, presetVersion: '1', parameters: {} },
      },
    };

    await expect(engine.render(request, signal())).rejects.toMatchObject({ code: 'failed' });
    expect(backend.dispose).toHaveBeenCalledOnce();
    expect(engine.lifecycle).toEqual({ kind: 'failed', error: { code: 'failed' } });
    await engine.dispose();
  });
});
