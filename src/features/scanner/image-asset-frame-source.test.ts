import { describe, expect, it, vi } from 'vitest';

import { createImageAssetFrameSource } from './image-asset-frame-source';

const asset = {
  blob: new Blob(['image'], { type: 'image/png' }),
  dimensions: { width: 1600, height: 1200 },
};

function fixture() {
  const close = vi.fn();
  const bitmap = { width: 1600, height: 1200, close } as unknown as ImageBitmap;
  const drawImage = vi.fn();
  const getImageData = vi.fn((_x: number, _y: number, width: number, height: number) => ({
    data: new Uint8ClampedArray(width * height * 4).fill(120),
  }));
  const getContext = vi.fn(() => ({ drawImage, getImageData }));
  const canvas = { width: 0, height: 0, getContext } as unknown as HTMLCanvasElement;
  return { bitmap, close, drawImage, getImageData, canvas };
}

describe('image asset detection frame source', () => {
  it('decodes and downscales a validated asset without changing aspect ratio', async () => {
    const view = fixture();
    const createImageBitmap = vi.fn(() => Promise.resolve(view.bitmap));
    const source = createImageAssetFrameSource({
      maxSide: 800,
      createImageBitmap,
      createCanvas: () => view.canvas,
    });

    const frame = await source.create(asset, new AbortController().signal);

    expect(frame.dimensions).toEqual({ width: 800, height: 600 });
    expect(view.drawImage).toHaveBeenCalledWith(view.bitmap, 0, 0, 800, 600);
    expect(view.getImageData).toHaveBeenCalledWith(0, 0, 800, 600);
    expect(view.close).toHaveBeenCalledOnce();
    expect(view.canvas.width).toBe(1);
    expect(view.canvas.height).toBe(1);
    frame.close();
  });

  it('rejects a decoder dimension mismatch and always closes the bitmap', async () => {
    const view = fixture();
    Object.assign(view.bitmap, { width: 800, height: 600 });
    const source = createImageAssetFrameSource({
      createImageBitmap: () => Promise.resolve(view.bitmap),
      createCanvas: () => view.canvas,
    });

    await expect(source.create(asset, new AbortController().signal)).rejects.toMatchObject({
      code: 'invalid-input',
    });
    expect(view.close).toHaveBeenCalledOnce();
  });

  it('sanitizes cancellation before decode without exposing the abort reason', async () => {
    const controller = new AbortController();
    controller.abort('private image bytes');
    const createImageBitmap = vi.fn(() => Promise.resolve(fixture().bitmap));
    const source = createImageAssetFrameSource({ createImageBitmap });

    await expect(source.create(asset, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
      message: 'Image detection cancelled.',
    });
    expect(createImageBitmap).not.toHaveBeenCalled();
  });
});
