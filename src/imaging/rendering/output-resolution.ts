import type { DocumentCorners, ImageDimensions } from '../../domain/document';
import { getOutputDimensions } from '../geometry/quad';

export const TARGET_SCAN_LONG_SIDE = 3000;

/** Preserve useful crop detail; cap the long side without enlarging a small crop. */
export function resolveHighQualityOutputDimensions(
  corners: DocumentCorners,
  source: ImageDimensions,
  maximumOutputLongSide?: number,
): ImageDimensions {
  const targetLongSide = maximumOutputLongSide ?? TARGET_SCAN_LONG_SIDE;
  const base = getOutputDimensions(corners, source);
  const baseLongSide = Math.max(base.width, base.height);
  const scale = Math.min(1, targetLongSide / baseLongSide);
  if (scale === 1) return base;
  return {
    width: Math.max(1, Math.floor(base.width * scale)),
    height: Math.max(1, Math.floor(base.height * scale)),
  };
}
