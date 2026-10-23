import type { ProcessingFailure } from '../../domain/document';
import type { ScannerFrame } from '../../imaging/contracts/scanner-engine';
import { createOneShotScannerFrame } from '../../imaging/engines/scanic-classical-engine';
import { isValidImageDimensions } from '../../imaging/geometry/coordinates';
import {
  MAX_WORKING_IMAGE_PIXELS,
  MAX_WORKING_IMAGE_SIDE,
} from '../../imaging/working-image-limits';

export type PreviewFrameFailureCode = Extract<
  ProcessingFailure['code'],
  'unavailable' | 'invalid-input' | 'failed'
>;

const SAFE_MESSAGES: Readonly<Record<PreviewFrameFailureCode, string>> = {
  unavailable: 'Preview frame capture is unavailable.',
  'invalid-input': 'Preview frame dimensions are invalid.',
  failed: 'Preview frame capture failed.',
};

const DEFAULT_MAX_SIDE = 960;
const HAVE_CURRENT_DATA = 2;

export class PreviewFrameError extends Error {
  override readonly name = 'PreviewFrameError';

  constructor(readonly code: PreviewFrameFailureCode) {
    super(SAFE_MESSAGES[code]);
  }
}

export interface VideoFrameSource {
  /** Returns an owned RGBA frame; the caller must close it exactly as required by ScannerFrame. */
  capture(video: HTMLVideoElement, signal: AbortSignal): ScannerFrame;
  /** Idempotently releases the reusable canvas backing store. */
  dispose(): void;
}

export interface VideoFrameSourceOptions {
  /** Longest output edge. Preview frames are never upscaled. */
  readonly maxSide?: number;
  readonly createCanvas?: () => HTMLCanvasElement;
}

function abortError(): Error {
  const error = new Error('Preview frame capture cancelled.');
  error.name = 'AbortError';
  return error;
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function browserCanvas(): HTMLCanvasElement {
  if (typeof document === 'undefined') throw new PreviewFrameError('unavailable');
  return document.createElement('canvas');
}

function outputDimensions(width: number, height: number, maxSide: number) {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export function createVideoFrameSource(options: VideoFrameSourceOptions = {}): VideoFrameSource {
  const maxSide = options.maxSide ?? DEFAULT_MAX_SIDE;
  const maximumSafeSquareSide = Math.floor(Math.sqrt(MAX_WORKING_IMAGE_PIXELS));
  if (
    !Number.isSafeInteger(maxSide) ||
    maxSide < 1 ||
    maxSide > Math.min(MAX_WORKING_IMAGE_SIDE, maximumSafeSquareSide)
  ) {
    throw new RangeError('Invalid preview frame maximum side.');
  }

  const createCanvas = options.createCanvas ?? browserCanvas;
  let canvas: HTMLCanvasElement | null = null;
  let context: CanvasRenderingContext2D | null = null;
  let disposed = false;

  return {
    capture(video, signal) {
      checkAbort(signal);
      if (disposed) throw new PreviewFrameError('unavailable');
      if (video.readyState < HAVE_CURRENT_DATA) throw new PreviewFrameError('unavailable');
      const sourceDimensions = { width: video.videoWidth, height: video.videoHeight };
      if (!isValidImageDimensions(sourceDimensions)) {
        throw new PreviewFrameError('invalid-input');
      }
      const dimensions = outputDimensions(sourceDimensions.width, sourceDimensions.height, maxSide);

      try {
        if (canvas === null) {
          canvas = createCanvas();
          context = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
          if (context === null) throw new PreviewFrameError('unavailable');
        }
        const activeContext = context;
        if (activeContext === null) throw new PreviewFrameError('unavailable');
        if (canvas.width !== dimensions.width) canvas.width = dimensions.width;
        if (canvas.height !== dimensions.height) canvas.height = dimensions.height;
        activeContext.drawImage(video, 0, 0, dimensions.width, dimensions.height);
        checkAbort(signal);
        const pixels = activeContext.getImageData(0, 0, dimensions.width, dimensions.height).data;
        checkAbort(signal);
        return createOneShotScannerFrame(dimensions, pixels);
      } catch (error) {
        if (signal.aborted) throw abortError();
        if (error instanceof PreviewFrameError) throw error;
        throw new PreviewFrameError('failed');
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      context = null;
      if (canvas !== null) {
        canvas.width = 0;
        canvas.height = 0;
        canvas = null;
      }
    },
  };
}
