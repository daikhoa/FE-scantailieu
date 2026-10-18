import type { DocumentCorners, ImageDimensions } from '../../domain/document';
import { getOutputDimensions } from '../geometry/quad';
import { MAX_WORKING_IMAGE_PIXELS, MAX_WORKING_IMAGE_SIDE } from '../working-image-limits';

export const TARGET_SCAN_LONG_SIDE = 3000;

/**
 * Keeps the geometry-derived aspect ratio while matching the APK's observed 3000 px quality
 * target. Enlargement is bounded by both the real source pixel budget and worker safety limits.
 */
export function resolveHighQualityOutputDimensions(
  corners: DocumentCorners,
  source: ImageDimensions,
): ImageDimensions {
  const base = getOutputDimensions(corners, source);
  const baseLongSide = Math.max(base.width, base.height);
  const sourceLongSide = Math.max(source.width, source.height);
  if (baseLongSide >= TARGET_SCAN_LONG_SIDE || sourceLongSide < TARGET_SCAN_LONG_SIDE) return base;

  const sourcePixelBudget = Math.min(MAX_WORKING_IMAGE_PIXELS, source.width * source.height);
  const scale = Math.min(
    TARGET_SCAN_LONG_SIDE / baseLongSide,
    MAX_WORKING_IMAGE_SIDE / baseLongSide,
    Math.sqrt(sourcePixelBudget / (base.width * base.height)),
  );
  if (scale <= 1) return base;

  return {
    width: Math.max(base.width, Math.floor(base.width * scale)),
    height: Math.max(base.height, Math.floor(base.height * scale)),
  };
}
