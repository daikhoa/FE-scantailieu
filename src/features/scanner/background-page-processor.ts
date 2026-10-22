import type { CropRegion, EditRecipe, ImageAsset, RenderedVariant } from '../../domain/document';
import type { ScannerEngine } from '../../imaging/contracts/scanner-engine';
import type { RestorationWarning } from '../../imaging/restoration/restoration-types';
import type { LocalRestorationClient } from '../../imaging/restoration/local-restoration-client';
import { createScanicEngine } from '../../imaging/engines/scanic-classical-engine';
import { detectDocumentCrop } from '../editor/detect-document-crop';
import { importImage, type ImageImporter } from '../camera/image-import';
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
  readonly crop: CropRegion;
  readonly recipe: EditRecipe;
  readonly variant: RenderedVariant;
  readonly restoration?: PageRestorationState;
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
    try {
      await candidate.initialize(signal);
      checkAbort(signal, disposal.signal);
      engine = candidate;
      return candidate;
    } catch (error) {
      await candidate.dispose().catch(() => undefined);
      throw error;
    }
  };

  const process = async (
    source: ScanPageSource,
    signal: AbortSignal,
    liveDetection: LiveDetectionResult | null,
    processingOptions: PageProcessingOptions,
  ): Promise<ProcessedScanPage> => {
    checkAbort(signal, disposal.signal);
    const imported =
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
    const currentEngine = await readyEngine(signal);
    try {
      const liveCrop = mapLiveDetectionToCrop(liveDetection, imported.original.dimensions);
      const crop =
        liveCrop.kind === 'document'
          ? liveCrop
          : await detectDocumentCrop(
              currentEngine,
              frameSource,
              imported.original,
              signal,
              liveCrop,
            );
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
      let restoration: PageRestorationState = { kind: 'local' };
      if (restorationAnalyzer?.analyze !== undefined) {
        try {
          const roughVariant = await currentEngine.render(
            {
              original: imported.original,
              orientation: 0,
              recipe: {
                ...recipe,
                filter: {
                  mode: 'original',
                  presetVersion: 'classifier-rough-v1',
                  parameters: {},
                },
              },
              maximumOutputLongSide: 720,
              preserveOutputPixels: true,
              ...sourcePixels,
            },
            signal,
          );
          const roughSource =
            roughVariant.transientRgba === undefined
              ? roughVariant.image.blob
              : { kind: 'rgba-frame' as const, ...roughVariant.transientRgba };
          await restorationAnalyzer.analyze(roughSource, signal, {
            ...(processingOptions.analysisKey === undefined
              ? {}
              : { analysisKey: processingOptions.analysisKey }),
          });
          restoration = { kind: 'processing' };
        } catch (error) {
          if (error instanceof Error && error.name === 'AbortError') throw error;
          restoration = { kind: 'fallback', reason: 'failed' };
        }
      }
      checkAbort(signal, disposal.signal);
      const previewVariant = await currentEngine.render(
        {
          original: imported.original,
          orientation: 0,
          recipe,
          maximumOutputLongSide: 1600,
          preserveOutputPixels: false,
          ...sourcePixels,
        },
        signal,
      );
      checkAbort(signal, disposal.signal);
      processingOptions.onPreview?.({
        original: imported.original,
        crop,
        recipe,
        variant: previewVariant,
        restoration,
      });
      const variant = await currentEngine.render(
        {
          original: imported.original,
          orientation: 0,
          recipe,
          maximumOutputLongSide: 3000,
          preserveOutputPixels: true,
          ...sourcePixels,
        },
        signal,
      );
      checkAbort(signal, disposal.signal);
      return { original: imported.original, crop, recipe, variant, restoration };
    } catch (error) {
      if (!(error instanceof Error && error.name === 'AbortError')) {
        await releaseEngine().catch(() => undefined);
      }
      throw error;
    }
  };

  return {
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
