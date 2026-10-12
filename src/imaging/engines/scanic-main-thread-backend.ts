import { Scanner } from 'scanic';

import { applyDocumentFilter } from '../rendering/document-filter';
import { warpPerspectiveRgba } from '../rendering/perspective-warp';
import { rotateOwnedRgba } from '../rendering/rgba-rotation';
import type { ClassicalBackend } from './scanic-backend-contract';
import { ScannerEngineError } from './scanner-engine-error';

/** Functional fallback for browsers that support DOM canvas but not worker OffscreenCanvas. */
export function createScanicMainThreadBackend(): ClassicalBackend {
  let scanner: Scanner | null = null;

  return {
    async initialize() {
      if (typeof ImageData === 'undefined' || typeof document === 'undefined') {
        throw new ScannerEngineError('unavailable');
      }
      scanner = new Scanner({
        detector: 'classical',
        mode: 'detect',
        output: 'imagedata',
        debug: false,
        maxProcessingDimension: 8192,
      });
      await scanner.initialize();
    },
    async detect(input) {
      if (scanner === null) throw new ScannerEngineError('unavailable');
      const image = new ImageData(input.pixels, input.dimensions.width, input.dimensions.height);
      const result = await scanner.scan(image, {
        detector: 'classical',
        mode: 'detect',
        output: 'imagedata',
        debug: false,
      });
      return { success: result.success, confidence: result.confidence, corners: result.corners };
    },
    warp(input, corners, rotation, filter) {
      const corrected = warpPerspectiveRgba(input, corners);
      const filtered = applyDocumentFilter(corrected, filter);
      return Promise.resolve(rotateOwnedRgba(filtered, rotation));
    },
    dispose() {
      scanner = null;
      return Promise.resolve();
    },
  };
}
