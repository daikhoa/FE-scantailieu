import type { RgbaBackendInput } from '../../imaging/engines/scanic-backend-contract';
import type { CropRegion, ImageAsset } from '../../domain/document';
import type { ScannerEngine } from '../../imaging/contracts/scanner-engine';
import { ScannerEngineError } from '../../imaging/engines/scanner-engine-error';
import { scaleCorners } from '../../imaging/geometry/coordinates';
import type { ImageAssetFrameSource } from '../scanner/image-asset-frame-source';

export async function detectDocumentCrop(
  engine: Pick<ScannerEngine, 'detect'>,
  source: ImageAssetFrameSource,
  original: ImageAsset,
  signal: AbortSignal,
  fallback: CropRegion = { kind: 'full-frame' },
  sourcePixels?: RgbaBackendInput,
): Promise<CropRegion> {
  try {
    const frame = await (sourcePixels === undefined
      ? source.create(original, signal)
      : source.create(original, signal, sourcePixels));
    try {
      const result = await engine.detect(frame, signal);
      if (
        result.dimensions.width !== frame.dimensions.width ||
        result.dimensions.height !== frame.dimensions.height
      ) {
        throw new ScannerEngineError('failed');
      }
      if (result.kind === 'full-frame') return fallback;
      return {
        kind: 'document',
        corners: scaleCorners(result.corners, result.dimensions, original.dimensions),
      };
    } finally {
      frame.close();
    }
  } catch (error) {
    if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
    return fallback;
  }
}
