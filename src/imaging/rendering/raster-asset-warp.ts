import type { DocumentCorners, ImageAsset } from '../../domain/document';
import { validateRasterAsset } from '../codecs/browser-rgba-codec';
import { ScannerEngineError } from '../engines/scanner-engine-error';
import { warpPerspectiveRegions } from './region-perspective-warp';
import { decodeRasterBitmap } from '../codecs/decode-raster-bitmap';

/** Keep one native bitmap; read only small original-resolution regions into JS memory. */
export async function warpRasterAsset(
  asset: ImageAsset,
  corners: DocumentCorners,
  maximumOutputLongSide?: number,
) {
  validateRasterAsset(asset);
  let bitmap: ImageBitmap | null = null;
  let canvas: OffscreenCanvas | HTMLCanvasElement | null = null;
  try {
    bitmap = await decodeRasterBitmap(asset.blob, { imageOrientation: 'none' });
    if (bitmap.width !== asset.dimensions.width || bitmap.height !== asset.dimensions.height)
      throw new ScannerEngineError('invalid-input');
    canvas =
      typeof OffscreenCanvas === 'function'
        ? new OffscreenCanvas(1, 1)
        : document.createElement('canvas');
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (context === null) throw new ScannerEngineError('unavailable');
    const surface = canvas;
    const source = bitmap;
    return await warpPerspectiveRegions(
      asset.dimensions,
      corners,
      (region) => {
        surface.width = region.width;
        surface.height = region.height;
        context.drawImage(
          source,
          region.x,
          region.y,
          region.width,
          region.height,
          0,
          0,
          region.width,
          region.height,
        );
        return {
          dimensions: { width: region.width, height: region.height },
          pixels: context.getImageData(0, 0, region.width, region.height).data,
        };
      },
      maximumOutputLongSide,
    );
  } finally {
    if (canvas !== null) {
      canvas.width = 1;
      canvas.height = 1;
    }
    bitmap?.close();
  }
}
