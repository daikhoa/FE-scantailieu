import type { CropRegion, EditRecipe, ImageAsset, RenderedVariant } from '../../domain/document';
import type { ScannerEngine } from '../../imaging/contracts/scanner-engine';
import { createScanicEngine } from '../../imaging/engines/scanic-classical-engine';
import { detectDocumentCrop } from '../editor/detect-document-crop';
import { importImage, type ImageImporter } from '../camera/image-import';
import {
  createImageAssetFrameSource,
  type ImageAssetFrameSource,
} from './image-asset-frame-source';

export interface ProcessedScanPage {
  readonly original: ImageAsset;
  readonly crop: CropRegion;
  readonly recipe: EditRecipe;
  readonly variant: RenderedVariant;
}

export interface BackgroundPageProcessor {
  enqueue(source: Blob, signal: AbortSignal, onStart?: () => void): Promise<ProcessedScanPage>;
  dispose(): Promise<void>;
}

interface BackgroundPageProcessorOptions {
  readonly importer?: ImageImporter;
  readonly engineFactory?: () => ScannerEngine;
  readonly frameSource?: ImageAssetFrameSource;
}

export function createDefaultPageRecipe(crop: CropRegion): EditRecipe {
  return {
    version: 1,
    crop,
    rotation: 0,
    dewarp: { mode: 'perspective-only' },
    filter: { mode: 'ocr-color', presetVersion: 'ocr-color-v4', parameters: {} },
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

  const process = async (source: Blob, signal: AbortSignal): Promise<ProcessedScanPage> => {
    checkAbort(signal, disposal.signal);
    const imported = await importer(source, signal);
    checkAbort(signal, disposal.signal);
    const currentEngine = await readyEngine(signal);
    try {
      const crop = await detectDocumentCrop(currentEngine, frameSource, imported.original, signal);
      const recipe = createDefaultPageRecipe(crop);
      const variant = await currentEngine.render(
        { original: imported.original, orientation: 0, recipe },
        signal,
      );
      checkAbort(signal, disposal.signal);
      return { original: imported.original, crop, recipe, variant };
    } catch (error) {
      if (!(error instanceof Error && error.name === 'AbortError')) {
        await releaseEngine().catch(() => undefined);
      }
      throw error;
    }
  };

  return {
    enqueue(source, signal, onStart) {
      if (disposePromise !== null || disposal.signal.aborted) return Promise.reject(abortError());
      const result = tail.then(async () => {
        checkAbort(signal, disposal.signal);
        onStart?.();
        const linked = linkedSignal(signal, disposal.signal);
        try {
          return await process(source, linked.signal);
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
