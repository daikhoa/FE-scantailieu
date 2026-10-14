import { describe, expect, it, vi } from 'vitest';

import type { ScannerEngine } from '../../imaging/contracts/scanner-engine';
import type { ImageImporter } from '../camera/image-import';
import { createBackgroundPageProcessor } from './background-page-processor';

const FULL_FRAME_DETECTION = {
  kind: 'full-frame' as const,
  dimensions: { width: 600, height: 800 },
  reason: 'no-document' as const,
};

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
  const renderPage = vi.fn<ScannerEngine['render']>((request) =>
    Promise.resolve({
      recipeKey: 'ready-page',
      engineVersion: 'test',
      image: {
        blob: new Blob(['processed'], { type: 'image/png' }),
        dimensions: request.original.dimensions,
      },
      dewarp: { kind: 'not-requested' as const },
    }),
  );
  const engine: ScannerEngine = {
    lifecycle: { kind: 'uninitialized' },
    initialize: vi.fn(() => Promise.resolve()),
    detect: detectPage,
    render: renderPage,
    dispose: vi.fn(() => Promise.resolve()),
  };
  return { engine, detectPage, renderPage };
}

describe('background page processor', () => {
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
    });
    const firstStarted = vi.fn();
    const secondStarted = vi.fn();

    const firstResult = processor.enqueue(
      first,
      FULL_FRAME_DETECTION,
      new AbortController().signal,
      firstStarted,
    );
    const secondResult = processor.enqueue(
      second,
      FULL_FRAME_DETECTION,
      new AbortController().signal,
      secondStarted,
    );

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

  it('locks the live guide to the captured image and renders the default OCR page', async () => {
    const source = new Blob(['page'], { type: 'image/jpeg' });
    const { engine, detectPage, renderPage } = fakeEngine();
    const processor = createBackgroundPageProcessor({
      importer: () => Promise.resolve(imported(source)),
      engineFactory: () => engine,
    });

    const result = await processor.enqueue(
      source,
      {
        kind: 'document',
        dimensions: { width: 600, height: 800 },
        confidence: 0.95,
        corners: [
          { x: 30, y: 40 },
          { x: 570, y: 40 },
          { x: 570, y: 760 },
          { x: 30, y: 760 },
        ],
      },
      new AbortController().signal,
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
    expect(result.recipe).toEqual({
      version: 1,
      crop: result.crop,
      rotation: 0,
      dewarp: { mode: 'perspective-only' },
      filter: { mode: 'ocr-color', presetVersion: 'ocr-color-v3', parameters: {} },
    });
    expect(renderPage).toHaveBeenCalledWith(
      { original: result.original, orientation: 0, recipe: result.recipe },
      expect.any(AbortSignal),
    );
    expect(detectPage).not.toHaveBeenCalled();

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
    });
    const cancelledController = new AbortController();

    const firstResult = processor.enqueue(
      first,
      FULL_FRAME_DETECTION,
      new AbortController().signal,
    );
    const cancelledResult = processor.enqueue(
      cancelled,
      FULL_FRAME_DETECTION,
      cancelledController.signal,
    );
    const lastResult = processor.enqueue(last, FULL_FRAME_DETECTION, new AbortController().signal);
    cancelledController.abort();
    gate.resolve(imported(first));

    await expect(firstResult).resolves.toMatchObject({ original: { blob: first } });
    await expect(cancelledResult).rejects.toMatchObject({ name: 'AbortError' });
    await expect(lastResult).resolves.toMatchObject({ original: { blob: last } });
    expect(importer.mock.calls.map(([source]) => source)).toEqual([first, last]);

    await processor.dispose();
  });
});
