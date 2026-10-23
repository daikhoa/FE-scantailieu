import { afterEach, describe, expect, it, vi } from 'vitest';
import { createImagePreview } from './image-preview';
afterEach(() => {
  vi.unstubAllGlobals();
});
describe('separate original display preview', () => {
  it('creates a bounded PNG display asset and releases its canvas without changing the source', async () => {
    const drawImage = vi.fn();
    const encoded = new Blob(['preview'], { type: 'image/png' });
    class Surface {
      static instances: Surface[] = [];
      constructor(
        public width: number,
        public height: number,
      ) {
        Surface.instances.push(this);
      }
      getContext() {
        return { drawImage };
      }
      convertToBlob() {
        return Promise.resolve(encoded);
      }
    }
    vi.stubGlobal('OffscreenCanvas', Surface);
    const bitmap = { width: 8000, height: 6000, close: vi.fn() } as unknown as ImageBitmap;
    const result = await createImagePreview(bitmap);
    expect(result).toEqual({ blob: encoded, dimensions: { width: 1280, height: 960 } });
    expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 1280, 960);
    expect(Surface.instances[0]).toMatchObject({ width: 1, height: 1 });
    expect(bitmap.width).toBe(8000);
    expect(bitmap.height).toBe(6000);
  });
});
