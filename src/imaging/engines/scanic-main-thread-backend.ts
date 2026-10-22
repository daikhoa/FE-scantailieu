import { applyDocumentFilter } from '../rendering/document-filter';
import { warpPerspectiveRgba } from '../rendering/perspective-warp';
import { rotateOwnedRgba } from '../rendering/rgba-rotation';
import type { ClassicalBackend } from './scanic-backend-contract';
import { ScanicDetectorRuntime } from './scanic-detector-runtime';
import { ScannerEngineError } from './scanner-engine-error';

/** Functional fallback for browsers that support DOM canvas but not worker OffscreenCanvas. */
export function createScanicMainThreadBackend(): ClassicalBackend {
  let detector: ScanicDetectorRuntime | null = null;

  return {
    async initialize() {
      if (typeof ImageData === 'undefined' || typeof document === 'undefined') {
        throw new ScannerEngineError('unavailable');
      }
      detector = new ScanicDetectorRuntime();
      await detector.initialize();
    },
    async detect(input) {
      if (detector === null) throw new ScannerEngineError('unavailable');
      const image = new ImageData(input.pixels, input.dimensions.width, input.dimensions.height);
      const result = await detector.scan(image);
      return {
        success: result.success,
        confidence: result.confidence,
        corners: result.corners,
        detector: result.detector,
      };
    },
    warp(input, corners, rotation, filter, maximumOutputLongSide) {
      const corrected = warpPerspectiveRgba(input, corners, maximumOutputLongSide);
      const filtered = applyDocumentFilter(corrected, filter);
      return Promise.resolve(rotateOwnedRgba(filtered, rotation));
    },
    dispose() {
      detector = null;
      return Promise.resolve();
    },
  };
}
