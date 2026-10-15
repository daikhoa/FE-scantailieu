import { isValidImageDimensions } from '../../imaging/geometry/coordinates';
import { MAX_ENCODED_INPUT_BYTES } from '../../imaging/codecs/browser-rgba-codec';
import {
  MAX_WORKING_IMAGE_PIXELS,
  MAX_WORKING_IMAGE_SIDE,
} from '../../imaging/working-image-limits';

export type CameraCaptureFailureCode = 'unavailable' | 'invalid-input' | 'failed';

const SAFE_MESSAGES: Readonly<Record<CameraCaptureFailureCode, string>> = {
  unavailable: 'Camera capture is unavailable.',
  'invalid-input': 'Camera frame dimensions are invalid.',
  failed: 'Camera capture failed.',
};
const HAVE_CURRENT_DATA = 2;
const OUTPUT_TYPE = 'image/png';
const SUPPORTED_PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export class CameraCaptureError extends Error {
  override readonly name = 'CameraCaptureError';

  constructor(readonly code: CameraCaptureFailureCode) {
    super(SAFE_MESSAGES[code]);
  }
}

interface CameraCaptureOptions {
  readonly createCanvas?: () => HTMLCanvasElement;
  readonly createStillPhotoCapture?: (track: MediaStreamTrack) => StillPhotoCapture | null;
}

interface PhotoDimensionRange {
  readonly min: number;
  readonly max: number;
}

interface PhotoCapabilities {
  readonly imageWidth?: PhotoDimensionRange;
  readonly imageHeight?: PhotoDimensionRange;
}

interface PhotoSettings {
  readonly imageWidth: number;
  readonly imageHeight: number;
}

interface StillPhotoCapture {
  getPhotoCapabilities?(): Promise<PhotoCapabilities>;
  takePhoto(settings?: PhotoSettings): Promise<Blob>;
}

export interface CameraCapture {
  capture(stream: MediaStream, video: HTMLVideoElement, signal: AbortSignal): Promise<Blob>;
}

function abortError(): Error {
  const error = new Error('Camera capture cancelled.');
  error.name = 'AbortError';
  return error;
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function browserCanvas(): HTMLCanvasElement {
  if (typeof document === 'undefined') throw new CameraCaptureError('unavailable');
  return document.createElement('canvas');
}

function browserStillPhotoCapture(track: MediaStreamTrack): StillPhotoCapture | null {
  const constructor: unknown = Reflect.get(globalThis, 'ImageCapture');
  if (typeof constructor !== 'function') return null;
  try {
    return Reflect.construct(constructor, [track]) as StillPhotoCapture;
  } catch {
    return null;
  }
}

function validDimensions(width: number, height: number): boolean {
  const dimensions = { width, height };
  return (
    isValidImageDimensions(dimensions) &&
    Math.max(width, height) <= MAX_WORKING_IMAGE_SIDE &&
    width * height <= MAX_WORKING_IMAGE_PIXELS
  );
}

function canvasBlob(canvas: HTMLCanvasElement, signal: AbortSignal): Promise<Blob> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      action();
    };
    const onAbort = () => {
      finish(() => {
        reject(abortError());
      });
    };
    signal.addEventListener('abort', onAbort, { once: true });
    canvas.toBlob(
      (blob) => {
        finish(() => {
          if (blob === null || blob.size <= 0 || blob.type !== OUTPUT_TYPE) {
            reject(new CameraCaptureError('failed'));
          } else {
            resolve(blob);
          }
        });
      },
      OUTPUT_TYPE,
      undefined,
    );
  });
}

function safePhotoSettings(capabilities: PhotoCapabilities): PhotoSettings | undefined {
  const width = capabilities.imageWidth;
  const height = capabilities.imageHeight;
  if (
    width === undefined ||
    height === undefined ||
    !Number.isFinite(width.min) ||
    !Number.isFinite(width.max) ||
    !Number.isFinite(height.min) ||
    !Number.isFinite(height.max) ||
    width.min <= 0 ||
    height.min <= 0 ||
    width.max < width.min ||
    height.max < height.min
  ) {
    return undefined;
  }
  const scale = Math.min(
    1,
    MAX_WORKING_IMAGE_SIDE / Math.max(width.max, height.max),
    Math.sqrt(MAX_WORKING_IMAGE_PIXELS / (width.max * height.max)),
  );
  const imageWidth = Math.max(Math.ceil(width.min), Math.floor(width.max * scale));
  const imageHeight = Math.max(Math.ceil(height.min), Math.floor(height.max * scale));
  return validDimensions(imageWidth, imageHeight) ? { imageWidth, imageHeight } : undefined;
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      action();
    };
    const onAbort = () => {
      finish(() => {
        reject(abortError());
      });
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    operation.then(
      (value) => {
        finish(() => {
          resolve(value);
        });
      },
      (error: unknown) => {
        finish(() => {
          reject(error instanceof Error ? error : new CameraCaptureError('failed'));
        });
      },
    );
  });
}

function validPhotoBlob(blob: Blob): boolean {
  return (
    blob.size > 0 && blob.size <= MAX_ENCODED_INPUT_BYTES && SUPPORTED_PHOTO_TYPES.has(blob.type)
  );
}

async function captureStillPhoto(
  stream: MediaStream,
  signal: AbortSignal,
  createCapture: (track: MediaStreamTrack) => StillPhotoCapture | null,
): Promise<Blob | null> {
  let track: MediaStreamTrack | undefined;
  try {
    track = stream.getVideoTracks()[0];
  } catch {
    return null;
  }
  if (track === undefined) return null;
  const capture = createCapture(track);
  if (capture === null) return null;
  let settings: PhotoSettings | undefined;
  if (capture.getPhotoCapabilities !== undefined) {
    try {
      settings = safePhotoSettings(await abortable(capture.getPhotoCapabilities(), signal));
    } catch {
      if (signal.aborted) throw abortError();
      settings = undefined;
    }
  }
  checkAbort(signal);
  try {
    const blob = await abortable(
      settings === undefined ? capture.takePhoto() : capture.takePhoto(settings),
      signal,
    );
    checkAbort(signal);
    return validPhotoBlob(blob) ? blob : null;
  } catch {
    if (signal.aborted) throw abortError();
    return null;
  }
}

export function createCameraCapture(options: CameraCaptureOptions = {}): CameraCapture {
  const createCanvas = options.createCanvas ?? browserCanvas;
  const createStillPhotoCapture = options.createStillPhotoCapture ?? browserStillPhotoCapture;

  return {
    async capture(stream, video, signal) {
      checkAbort(signal);
      if (
        video.readyState < HAVE_CURRENT_DATA ||
        !validDimensions(video.videoWidth, video.videoHeight)
      ) {
        throw new CameraCaptureError('invalid-input');
      }

      const stillPhoto = await captureStillPhoto(stream, signal, createStillPhotoCapture);
      if (stillPhoto !== null) return stillPhoto;

      let canvas: HTMLCanvasElement | null = null;
      try {
        canvas = createCanvas();
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const context = canvas.getContext('2d', { alpha: false });
        if (context === null) throw new CameraCaptureError('unavailable');
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        checkAbort(signal);
        return await canvasBlob(canvas, signal);
      } catch (error) {
        if (signal.aborted) throw abortError();
        if (error instanceof CameraCaptureError) throw error;
        throw new CameraCaptureError('failed');
      } finally {
        if (canvas !== null) {
          canvas.width = 1;
          canvas.height = 1;
        }
      }
    },
  };
}
