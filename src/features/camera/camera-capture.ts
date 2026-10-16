import { isValidImageDimensions } from '../../imaging/geometry/coordinates';
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

export class CameraCaptureError extends Error {
  override readonly name = 'CameraCaptureError';

  constructor(readonly code: CameraCaptureFailureCode) {
    super(SAFE_MESSAGES[code]);
  }
}

interface CameraCaptureOptions {
  readonly createCanvas?: () => HTMLCanvasElement;
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

export function createCameraCapture(options: CameraCaptureOptions = {}): CameraCapture {
  const createCanvas = options.createCanvas ?? browserCanvas;

  return {
    async capture(_stream, video, signal) {
      checkAbort(signal);
      if (
        video.readyState < HAVE_CURRENT_DATA ||
        !validDimensions(video.videoWidth, video.videoHeight)
      ) {
        throw new CameraCaptureError('invalid-input');
      }

      let canvas: HTMLCanvasElement | null = null;
      try {
        canvas = createCanvas();
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const context = canvas.getContext('2d', { alpha: false });
        if (context === null) throw new CameraCaptureError('unavailable');

        // Freeze the current high-resolution preview before the first await. Encoding may finish
        // later, but movement after the shutter press cannot change these captured pixels.
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
