import { afterEach, describe, expect, it, vi } from 'vitest';
import { warpRasterAsset } from './raster-asset-warp';

afterEach(() => {
  vi.unstubAllGlobals();
});
const asset = {
  blob: new Blob(['photo'], { type: 'image/jpeg' }),
  dimensions: { width: 640, height: 480 },
};
const corners = [
  { x: 0, y: 0 },
  { x: 640, y: 0 },
  { x: 640, y: 480 },
  { x: 0, y: 480 },
] as const;
describe('encoded raster cleanup', () => {
  it('closes the native bitmap if its dimensions differ from the original metadata', async () => {
    const bitmap = { width: 1, height: 1, close: vi.fn() };
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(() => Promise.resolve(bitmap)),
    );
    await expect(warpRasterAsset(asset, corners, 3000)).rejects.toMatchObject({
      code: 'invalid-input',
    });
    expect(bitmap.close).toHaveBeenCalledOnce();
  });
  it('releases the bounded canvas and native bitmap when readback fails', async () => {
    const bitmap = { ...asset.dimensions, close: vi.fn() };
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(() => Promise.resolve(bitmap)),
    );
    class Surface {
      static instances: Surface[] = [];
      constructor(
        public width: number,
        public height: number,
      ) {
        Surface.instances.push(this);
      }
      getContext() {
        return {
          drawImage: vi.fn(),
          getImageData: () => {
            throw new Error('readback failed');
          },
        };
      }
    }
    vi.stubGlobal('OffscreenCanvas', Surface);
    await expect(warpRasterAsset(asset, corners, 3000)).rejects.toThrow('readback failed');
    expect(bitmap.close).toHaveBeenCalledOnce();
    expect(Surface.instances[0]).toEqual(expect.objectContaining({ width: 1, height: 1 }));
  });
});
