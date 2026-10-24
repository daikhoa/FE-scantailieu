import { describe, expect, it, vi } from 'vitest';

import type { ScannerEngine } from '../../imaging/contracts/scanner-engine';
import type { LocalRestorationClient } from '../../imaging/restoration/local-restoration-client';
import type { ImageImporter } from '../camera/image-import';
import { createBackgroundPageProcessor } from './background-page-processor';
import type { ImageAssetFrameSource } from './image-asset-frame-source';

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

function imported(source: Blob) {
  return {
    original: {
      blob: source,
      dimensions: { width: 1200, height: 1600 },
    },
  };
}

function fakeEngine() {
  const detectPage = vi.fn<ScannerEngine['detect']>(() =>
    Promise.resolve({
      kind: 'document' as const,
      dimensions: { width: 600, height: 800 },
      confidence: 0.95,
      corners: [
        { x: 30, y: 40 },
        { x: 570, y: 40 },
        { x: 570, y: 760 },
        { x: 30, y: 760 },
      ],
    }),
  );
  const renderPage = vi.fn<ScannerEngine['render']>((request) => {
    const rough = request.maximumOutputLongSide === 720;
    const outputDimensions = rough ? { width: 540, height: 720 } : request.original.dimensions;
    return Promise.resolve({
      recipeKey: 'ready-page',
      engineVersion: 'test',
      image: {
        blob: new Blob(['processed'], { type: 'image/png' }),
        dimensions: outputDimensions,
      },
      ...(rough
        ? {
            transientRgba: {
              dimensions: outputDimensions,
              pixels: new Uint8ClampedArray(outputDimensions.width * outputDimensions.height * 4),
            },
          }
        : {}),
      dewarp: { kind: 'not-requested' as const },
    });
  });
  const engine: ScannerEngine = {
    lifecycle: { kind: 'uninitialized' },
    initialize: vi.fn(() => Promise.resolve()),
    detect: detectPage,
    render: renderPage,
    dispose: vi.fn(() => Promise.resolve()),
  };
  return { engine, detectPage, renderPage };
}

function fakeFrameSource(): ImageAssetFrameSource {
  return {
    create: vi.fn(() =>
      Promise.resolve({ dimensions: { width: 600, height: 800 }, close: vi.fn() }),
    ),
  };
}

describe('background page processor', () => {
  it('drains queued pages before releasing its engine and can process another page afterward', async () => {
    const importing = deferred<ReturnType<typeof imported>>();
    const first = new Blob(['first'], { type: 'image/jpeg' });
    const second = new Blob(['second'], { type: 'image/jpeg' });
    const third = new Blob(['third'], { type: 'image/jpeg' });
    const engines: ScannerEngine[] = [];
    const retired: ScannerEngine[] = [];
    const processor = createBackgroundPageProcessor({
      importer: (source) =>
        source === first ? importing.promise : Promise.resolve(imported(source)),
      frameSource: fakeFrameSource(),
      engineFactory: () => {
        const { engine } = fakeEngine();
        let ready = false;
        Object.defineProperty(engine, 'lifecycle', {
          get: () => ({ kind: ready ? 'ready' : 'uninitialized' }),
        });
        engine.initialize = vi.fn(() => {
          ready = true;
          return Promise.resolve();
        });
        engine.dispose = vi.fn(() => {
          ready = false;
          retired.push(engine);
          return Promise.resolve();
        });
        engines.push(engine);
        return engine;
      },
    });
    try {
      const firstPage = processor.enqueue(first, new AbortController().signal);
      const secondPage = processor.enqueue(second, new AbortController().signal);
      if (processor.releaseWhenIdle === undefined) throw new Error('Missing idle release.');
      const releasing = processor.releaseWhenIdle();
      expect(engines).toHaveLength(0);
      importing.resolve(imported(first));
      const results = await Promise.all([firstPage, secondPage]);
      await releasing;
      expect(results.map((page) => page.original.blob)).toEqual([first, second]);
      expect(engines).toHaveLength(1);
      expect(retired).toEqual([engines[0]]);
      const next = await processor.enqueue(third, new AbortController().signal);
      expect(next.original.blob).toBe(third);
      expect(engines).toHaveLength(2);
    } finally {
      await processor.dispose();
    }
    await expect(processor.releaseWhenIdle()).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('owns and terminates an engine that is still initializing on disposal', async () => {
    const initializing = deferred<undefined>();
    const { engine } = fakeEngine();
    const initialize = vi.fn(() => initializing.promise);
    const dispose = vi.fn(() => {
      initializing.resolve(undefined);
      return Promise.resolve();
    });
    engine.initialize = initialize;
    engine.dispose = dispose;
    const processor = createBackgroundPageProcessor({ engineFactory: () => engine });
    if (processor.warmup === undefined) throw new Error('Warmup must be available.');
    const warming = processor.warmup().catch((error: unknown) => error);
    await vi.waitFor(() => {
      expect(initialize).toHaveBeenCalledOnce();
    });
    const disposing = processor.dispose();
    expect(dispose).toHaveBeenCalledOnce();
    await expect(warming).resolves.toMatchObject({ name: 'AbortError' });
    await disposing;
  });

  it('processes captured pages one at a time in capture order', async () => {
    const firstImport = deferred<ReturnType<typeof imported>>();
    const first = new Blob(['first'], { type: 'image/jpeg' });
    const second = new Blob(['second'], { type: 'image/jpeg' });
    const importer = vi.fn<ImageImporter>((source) =>
      source === first ? firstImport.promise : Promise.resolve(imported(source)),
    );
    const processor = createBackgroundPageProcessor({
      importer,
      engineFactory: () => fakeEngine().engine,
      frameSource: fakeFrameSource(),
    });
    const firstStarted = vi.fn();
    const secondStarted = vi.fn();

    const firstResult = processor.enqueue(first, new AbortController().signal, firstStarted);
    const secondResult = processor.enqueue(second, new AbortController().signal, secondStarted);

    await vi.waitFor(() => {
      expect(firstStarted).toHaveBeenCalledOnce();
    });
    expect(secondStarted).not.toHaveBeenCalled();
    expect(importer).toHaveBeenCalledTimes(1);

    firstImport.resolve(imported(first));
    await expect(firstResult).resolves.toMatchObject({ original: { blob: first } });
    await expect(secondResult).resolves.toMatchObject({ original: { blob: second } });
    expect(secondStarted).toHaveBeenCalledOnce();
    expect(importer.mock.calls.map(([source]) => source)).toEqual([first, second]);

    await processor.dispose();
  });

  it('detects the crop again on the frozen captured image before rendering', async () => {
    const source = new Blob(['page'], { type: 'image/jpeg' });
    const { engine, detectPage, renderPage } = fakeEngine();
    const processor = createBackgroundPageProcessor({
      importer: () => Promise.resolve(imported(source)),
      engineFactory: () => engine,
      frameSource: fakeFrameSource(),
    });

    const result = await processor.enqueue(source, new AbortController().signal);

    expect(result.crop).toEqual({
      kind: 'document',
      corners: [
        { x: 60, y: 80 },
        { x: 1140, y: 80 },
        { x: 1140, y: 1520 },
        { x: 60, y: 1520 },
      ],
    });
    expect(result.recipe).toEqual({
      version: 1,
      crop: result.crop,
      rotation: 0,
      dewarp: { mode: 'perspective-only' },
      filter: { mode: 'enhanced-color', presetVersion: 'enhanced-color-v1', parameters: {} },
    });
    expect(renderPage).toHaveBeenCalledWith(
      {
        original: result.original,
        orientation: 0,
        recipe: result.recipe,
        maximumOutputLongSide: 3000,
        preserveOutputPixels: false,
        createThumbnail: true,
      },
      expect.any(AbortSignal),
    );
    expect(detectPage).toHaveBeenCalledOnce();

    await processor.dispose();
  });

  it('passes freshly captured RGBA pixels directly to render without importing them again', async () => {
    const { engine, renderPage } = fakeEngine();
    const encoded = new Blob(['durable'], { type: 'image/jpeg' });
    const encode = vi.fn(() => Promise.resolve(encoded));
    const importer = vi.fn<ImageImporter>();
    const source = {
      kind: 'rgba-frame' as const,
      dimensions: { width: 2, height: 2 },
      pixels: new Uint8ClampedArray(16),
    };
    const processor = createBackgroundPageProcessor({
      importer,
      engineFactory: () => engine,
      frameSource: fakeFrameSource(),
      codec: { decode: vi.fn(), encode },
    });

    const result = await processor.enqueue(source, new AbortController().signal, undefined, {
      kind: 'full-frame',
      dimensions: source.dimensions,
      reason: 'no-document',
    });

    expect(importer).not.toHaveBeenCalled();
    expect(encode).toHaveBeenCalledWith(
      { dimensions: source.dimensions, pixels: source.pixels },
      { type: 'image/jpeg', quality: 0.97 },
      expect.any(AbortSignal),
    );
    expect(result.original.blob).toBe(encoded);
    expect(renderPage.mock.calls[0]?.[0].sourcePixels).toEqual({
      dimensions: source.dimensions,
      pixels: source.pixels,
    });

    await processor.dispose();
  });

  it('refines the live corners on the frozen captured image before perspective rendering', async () => {
    const source = new Blob(['page'], { type: 'image/jpeg' });
    const { engine, detectPage, renderPage } = fakeEngine();
    const processor = createBackgroundPageProcessor({
      importer: () => Promise.resolve(imported(source)),
      engineFactory: () => engine,
      frameSource: fakeFrameSource(),
    });
    const liveDetection = {
      kind: 'document' as const,
      dimensions: { width: 600, height: 800 },
      confidence: 0.94,
      corners: [
        { x: 30, y: 40 },
        { x: 570, y: 40 },
        { x: 570, y: 760 },
        { x: 30, y: 760 },
      ] as const,
    };

    const result = await processor.enqueue(
      source,
      new AbortController().signal,
      undefined,
      liveDetection,
    );

    expect(result.crop).toEqual({
      kind: 'document',
      corners: [
        { x: 60, y: 80 },
        { x: 1140, y: 80 },
        { x: 1140, y: 1520 },
        { x: 60, y: 1520 },
      ],
    });
    expect(detectPage).toHaveBeenCalledOnce();
    expect(renderPage).toHaveBeenCalledTimes(1);
    expect(renderPage.mock.calls[0]?.[0].recipe.crop).toEqual(result.crop);
    expect(renderPage.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);

    await processor.dispose();
  });

  it('classifies a raw 720 crop then renders the final once without a 1600 preview', async () => {
    const source = new Blob(['page'], { type: 'image/jpeg' });
    const { engine, renderPage } = fakeEngine();
    const analyze = vi.fn<NonNullable<LocalRestorationClient['analyze']>>(() =>
      Promise.resolve({
        kind: 'analysis' as const,
        stages: ['deshadow' as const, 'appearance' as const],
        classifierModel: 'classifier@test',
        warnings: [],
        protectColor: false,
      }),
    );
    const onPreview = vi.fn();
    const processor = createBackgroundPageProcessor({
      importer: () => Promise.resolve(imported(source)),
      engineFactory: () => engine,
      frameSource: fakeFrameSource(),
      restorationAnalyzer: { analyze },
    });

    const result = await processor.enqueue(source, new AbortController().signal, undefined, null, {
      analysisKey: 'page-1',
      onPreview,
    });

    expect(analyze).toHaveBeenCalledOnce();
    const roughSource = analyze.mock.calls[0]?.[0];
    if (roughSource === undefined || roughSource instanceof Blob) {
      throw new Error('Expected a transferred rough RGBA crop.');
    }
    expect(roughSource).toMatchObject({
      kind: 'rgba-frame',
      dimensions: { width: 540, height: 720 },
    });
    expect(roughSource.pixels).toBeInstanceOf(Uint8ClampedArray);
    expect(analyze.mock.calls[0]?.[2]).toEqual({ analysisKey: 'page-1' });
    const roughRenderOrder = renderPage.mock.invocationCallOrder[0];
    const analysisOrder = analyze.mock.invocationCallOrder[0];
    const previewRenderOrder = renderPage.mock.invocationCallOrder[1];
    if (
      roughRenderOrder === undefined ||
      analysisOrder === undefined ||
      previewRenderOrder === undefined
    ) {
      throw new Error('Expected ordered rough, analysis and preview operations.');
    }
    expect(roughRenderOrder).toBeLessThan(analysisOrder);
    expect(analysisOrder).toBeLessThan(previewRenderOrder);
    expect(renderPage).toHaveBeenCalledTimes(2);
    expect(renderPage.mock.calls[0]?.[0]).toMatchObject({
      maximumOutputLongSide: 720,
      preserveOutputPixels: true,
      recipe: { filter: { mode: 'original' } },
    });
    expect(renderPage.mock.calls[1]?.[0]).toMatchObject({
      maximumOutputLongSide: 3000,
      preserveOutputPixels: false,
      analysis: {
        kind: 'analysis',
        stages: ['deshadow', 'appearance'],
        classifierModel: 'classifier@test',
        warnings: [],
        protectColor: false,
      },
    });
    expect(onPreview).not.toHaveBeenCalled();
    expect(result.restoration).toMatchObject({
      kind: 'applied',
      classifierModel: 'classifier@test',
    });

    await processor.dispose();
  });

  it('skips a cancelled queued page without blocking the following page', async () => {
    const gate = deferred<ReturnType<typeof imported>>();
    const first = new Blob(['first'], { type: 'image/jpeg' });
    const cancelled = new Blob(['cancelled'], { type: 'image/jpeg' });
    const last = new Blob(['last'], { type: 'image/jpeg' });
    const importer = vi.fn<ImageImporter>((source) =>
      source === first ? gate.promise : Promise.resolve(imported(source)),
    );
    const processor = createBackgroundPageProcessor({
      importer,
      engineFactory: () => fakeEngine().engine,
      frameSource: fakeFrameSource(),
    });
    const cancelledController = new AbortController();

    const firstResult = processor.enqueue(first, new AbortController().signal);
    const cancelledResult = processor.enqueue(cancelled, cancelledController.signal);
    const lastResult = processor.enqueue(last, new AbortController().signal);
    cancelledController.abort();
    gate.resolve(imported(first));

    await expect(firstResult).resolves.toMatchObject({ original: { blob: first } });
    await expect(cancelledResult).rejects.toMatchObject({ name: 'AbortError' });
    await expect(lastResult).resolves.toMatchObject({ original: { blob: last } });
    expect(importer.mock.calls.map(([source]) => source)).toEqual([first, last]);

    await processor.dispose();
  });
});
