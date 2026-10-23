import { recordPipelineTiming } from '../../imaging/pipeline-timing';
import { renderAnalyzedPage } from '../../imaging/restoration/analyzed-page-renderer';
import type { LocalRestorationAnalysis } from '../../imaging/restoration/local-restoration-client';
import type { CropRegion, EditRecipe, ImageAsset, RenderedVariant } from '../../domain/document';
import type { ScannerEngine } from '../../imaging/contracts/scanner-engine';
import type { RestorationWarning } from '../../imaging/restoration/restoration-types';
import type { LocalRestorationClient } from '../../imaging/restoration/local-restoration-client';
import { createScanicEngine } from '../../imaging/engines/scanic-classical-engine';
import { detectDocumentCrop } from '../editor/detect-document-crop';
import { importImage, type ImageImporter, type ImportedImage } from '../camera/image-import';
import { mapLiveDetectionToCrop } from '../camera/live-capture-crop';
import type { LiveDetectionResult } from './detection-scheduler';
import type { CapturedRgbaFrame } from '../camera/camera-capture';
import { createBrowserRgbaCodec } from '../../imaging/codecs/browser-rgba-codec';
import type { RgbaImageCodec } from '../../imaging/codecs/rgba-image-codec';
import {
  createImageAssetFrameSource,
  type ImageAssetFrameSource,
} from './image-asset-frame-source';

export interface ProcessedScanPage {
  readonly original: ImageAsset;
  readonly originalPreview?: ImageAsset;
  readonly crop: CropRegion;
  readonly recipe: EditRecipe;
  readonly variant: RenderedVariant;
  readonly restoration?: PageRestorationState;
  readonly analysis?: LocalRestorationAnalysis;
}

export type PageRestorationState =
  | { readonly kind: 'local' }
  | { readonly kind: 'processing' }
  | {
      readonly kind: 'classified-local';
      readonly classifierModel: string;
      readonly warnings: readonly RestorationWarning[];
    }
  | {
      readonly kind: 'applied';
      readonly stages: readonly string[];
      readonly classifierModel: string;
      readonly provider: string;
      readonly warnings: readonly RestorationWarning[];
    }
  | {
      readonly kind: 'fallback';
      readonly reason: 'unavailable' | 'timeout' | 'failed';
    };

export interface BackgroundPageProcessor {
  warmup?(): Promise<void>;
  enqueue(
    source: ScanPageSource,
    signal: AbortSignal,
    onStart?: () => void,
    liveDetection?: LiveDetectionResult | null,
    options?: PageProcessingOptions,
  ): Promise<ProcessedScanPage>;
  dispose(): Promise<void>;
}

export interface PageProcessingOptions {
  readonly analysisKey?: string;
  readonly onOriginal?: (original: ImageAsset) => void;
  readonly onPreview?: (page: ProcessedScanPage) => void;
}

export type ScanPageSource = Blob | CapturedRgbaFrame;

interface BackgroundPageProcessorOptions {
  readonly importer?: ImageImporter;
  readonly engineFactory?: () => ScannerEngine;
  readonly frameSource?: ImageAssetFrameSource;
  readonly codec?: RgbaImageCodec;
  readonly restorationAnalyzer?: Pick<LocalRestorationClient, 'analyze'>;
}

export function createDefaultPageRecipe(crop: CropRegion): EditRecipe {
  return {
    version: 1,
    crop,
    rotation: 0,
    dewarp: { mode: 'perspective-only' },
    filter: { mode: 'ocr-color', presetVersion: 'ocr-color-v7', parameters: {} },
  };
}

function abortError(): Error {
  const error = new Error('Page processing cancelled.');
  error.name = 'AbortError';
  return error;
}

function checkAbort(signal: AbortSignal, disposal: AbortSignal): void {
  if (signal.aborted || disposal.aborted) throw abortError();
}

function linkedSignal(
  signal: AbortSignal,
  disposal: AbortSignal,
): {
  readonly signal: AbortSignal;
  readonly release: () => void;
} {
  const controller = new AbortController();
  const abort = () => {
    controller.abort();
  };
  signal.addEventListener('abort', abort, { once: true });
  disposal.addEventListener('abort', abort, { once: true });
  if (signal.aborted || disposal.aborted) abort();
  return {
    signal: controller.signal,
    release() {
      signal.removeEventListener('abort', abort);
      disposal.removeEventListener('abort', abort);
    },
  };
}

export function createBackgroundPageProcessor(
  options: BackgroundPageProcessorOptions = {},
): BackgroundPageProcessor {
  const importer = options.importer ?? importImage;
  const engineFactory = options.engineFactory ?? createScanicEngine;
  const frameSource = options.frameSource ?? createImageAssetFrameSource();
  const codec = options.codec ?? createBrowserRgbaCodec();
  const restorationAnalyzer = options.restorationAnalyzer;
  const disposal = new AbortController();
  let engine: ScannerEngine | null = null;
  let tail: Promise<unknown> = Promise.resolve();
  let disposePromise: Promise<void> | null = null;

  const releaseEngine = async () => {
    const current = engine;
    engine = null;
    if (current !== null) await current.dispose();
  };

  const readyEngine = async (signal: AbortSignal): Promise<ScannerEngine> => {
    checkAbort(signal, disposal.signal);
    if (engine?.lifecycle.kind === 'ready') return engine;
    await releaseEngine();
    const candidate = engineFactory();
    // Own bootstrap immediately so disposal can terminate a still-loading worker.
    engine = candidate;
    try {
      await candidate.initialize(signal);
      checkAbort(signal, disposal.signal);
      return candidate;
    } catch (error) {
      if (engine === candidate) await releaseEngine().catch(() => undefined);
      throw error;
    }
  };

  const process = async (
    source: ScanPageSource,
    signal: AbortSignal,
    liveDetection: LiveDetectionResult | null,
    processingOptions: PageProcessingOptions,
  ): Promise<ProcessedScanPage> => {
    const totalStarted = performance.now();
    checkAbort(signal, disposal.signal);
    const imported: ImportedImage =
      source instanceof Blob
        ? await importer(source, signal)
        : {
            original: {
              blob: await codec.encode(
                { dimensions: source.dimensions, pixels: source.pixels },
                { type: 'image/jpeg', quality: 0.97 },
                signal,
              ),
              dimensions: { ...source.dimensions },
            },
          };
    checkAbort(signal, disposal.signal);
    let currentEngine = await readyEngine(signal);
    processingOptions.onOriginal?.(imported.original);
    try {
      const liveCrop = mapLiveDetectionToCrop(liveDetection, imported.original.dimensions);
      // The live guide can be one or more video frames behind the shutter. Refine it against the
      // frozen capture so camera motion at press time cannot skew the perspective transform.
      const detectionStarted = performance.now();
      const crop = await detectDocumentCrop(
        currentEngine,
        frameSource,
        imported.original,
        signal,
        liveCrop,
        source instanceof Blob ? undefined : source,
      );
      const frozenDetection = performance.now() - detectionStarted;
      const recipe = createDefaultPageRecipe(crop);
      const sourcePixels =
        source instanceof Blob
          ? {}
          : {
              sourcePixels: {
                dimensions: source.dimensions,
                pixels: source.pixels,
              },
            };
      if (currentEngine.lifecycle.kind === 'failed') currentEngine = await readyEngine(signal);
      const output = await renderAnalyzedPage(currentEngine, imported.original, recipe, signal, {
        ...(restorationAnalyzer === undefined ? {} : { analyzer: restorationAnalyzer }),
        ...(processingOptions.analysisKey === undefined
          ? {}
          : { analysisKey: processingOptions.analysisKey }),
        ...sourcePixels,
      });
      checkAbort(signal, disposal.signal);
      recordPipelineTiming({
        frozenDetection,
        total: performance.now() - totalStarted,
        ...(source instanceof Blob ? {} : { capture: source.captureMs ?? 0 }),
      });
      return {
        original: imported.original,
        ...(imported.preview === undefined ? {} : { originalPreview: imported.preview }),
        crop,
        recipe,
        ...output,
      };
    } catch (error) {
      if (!(error instanceof Error && error.name === 'AbortError')) {
        await releaseEngine().catch(() => undefined);
      }
      throw error;
    }
  };

  return {
    warmup() {
      if (disposePromise !== null) return Promise.reject(abortError());
      const warming = tail.then(() => readyEngine(disposal.signal)).then(() => undefined);
      tail = warming.catch(() => undefined);
      return warming;
    },
    enqueue(source, signal, onStart, liveDetection = null, processingOptions = {}) {
      if (disposePromise !== null || disposal.signal.aborted) return Promise.reject(abortError());
      const result = tail.then(async () => {
        checkAbort(signal, disposal.signal);
        onStart?.();
        const linked = linkedSignal(signal, disposal.signal);
        try {
          return await process(source, linked.signal, liveDetection, processingOptions);
        } finally {
          linked.release();
        }
      });
      tail = result.catch(() => undefined);
      return result;
    },

    dispose() {
      if (disposePromise !== null) return disposePromise;
      disposal.abort();
      disposePromise = (async () => {
        await releaseEngine();
        await tail;
      })();
      return disposePromise;
    },
  };
}
