import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocscanModule } from './docscan-module';
import type { DocumentCorners } from '../../domain/document';
import { renderDocscanRegions, renderDocscanRgba } from './docscan-raster';
import { renderDocscanAsset } from './docscan-asset';

const dependencies = vi.hoisted(() => ({ load: vi.fn(), predict: vi.fn(), decode: vi.fn() }));
vi.mock('@docscan/browser/internal/imaging/codecs/decode-raster-bitmap', () => ({
  decodeRasterBitmap: dependencies.decode,
}));
vi.mock('@docscan/browser/internal/imaging/engines/docscan-module', () => ({
  loadDocscanModule: dependencies.load,
}));
vi.mock('@docscan/browser/internal/imaging/restoration/gcnet-runtime', () => ({
  predictIllumination: dependencies.predict,
}));

const dimensions = { width: 2, height: 2 };
const corners: DocumentCorners = [
  { x: 0, y: 0 },
  { x: 2, y: 0 },
  { x: 2, y: 2 },
  { x: 0, y: 2 },
];
function nativeModule(needsModel = false) {
  const heap = new ArrayBuffer(1024 * 1024);
  const live = new Set<number>();
  let next = 4096;
  const module: DocscanModule = {
    _ds_wasm_refine_corners: () => {
      throw new Error('Raster rendering must keep the selected crop.');
    },
    _ds_wasm_confirm_corners: () => {
      throw new Error('Raster rendering must not redetect the document.');
    },
    HEAPU8: new Uint8Array(heap),
    HEAPF64: new Float64Array(heap),
    _malloc(bytes) {
      const pointer = next;
      next += Math.ceil(bytes / 8) * 8;
      live.add(pointer);
      return pointer;
    },
    _free(pointer) {
      expect(live.delete(pointer)).toBe(true);
    },
    _ds_wasm_release: vi.fn(),
    _ds_wasm_begin: vi.fn(() => 0),
    _ds_wasm_patch_count: () => 1,
    _ds_wasm_patch: () => 64,
    _ds_wasm_write_patch: vi.fn(() => 0),
    _ds_wasm_prepare: vi.fn(() => 0),
    _ds_wasm_needs_model: () => Number(needsModel),
    _ds_wasm_sample: () => 128,
    _ds_wasm_sample_width: () => 32,
    _ds_wasm_sample_height: () => 32,
    _ds_wasm_finish: vi.fn(() => 0),
    _ds_wasm_width: () => 2,
    _ds_wasm_height: () => 2,
    _ds_wasm_output: () => 32,
  };
  new Int32Array(heap, 64, 4).set([0, 0, 2, 2]);
  module.HEAPU8.fill(77, 32, 48);
  return { module, live };
}
beforeEach(() => {
  vi.clearAllMocks();
});
describe('production C++ browser boundary', () => {
  it('releases decoded source and patch memory before shadow inference without resizing output', async () => {
    const { module, live } = nativeModule(true);
    dependencies.load.mockResolvedValue(module);
    const bitmap = { width: 2, height: 2, close: vi.fn() };
    dependencies.decode.mockResolvedValue(bitmap);
    const canvas = document.createElement('canvas');
    vi.spyOn(canvas, 'getContext').mockReturnValue({
      drawImage: vi.fn(),
      getImageData: () => ({ data: new Uint8ClampedArray(16) }),
    } as unknown as CanvasRenderingContext2D);
    const create = vi.spyOn(document, 'createElement').mockReturnValue(canvas);
    dependencies.predict.mockImplementation((sample: unknown) => {
      expect(bitmap.close).toHaveBeenCalledOnce();
      expect(canvas.width).toBe(1);
      expect(canvas.height).toBe(1);
      expect(live.size).toBe(1); // only the small corner buffer remains
      return Promise.resolve(sample);
    });
    try {
      const result = await renderDocscanAsset(
        { blob: new Blob(['source'], { type: 'image/jpeg' }), dimensions },
        corners,
        'shadow-removal',
        0,
      );
      expect(result.image.dimensions).toEqual(dimensions);
      expect(bitmap.close).toHaveBeenCalledOnce();
      expect(live.size).toBe(0);
    } finally {
      create.mockRestore();
    }
  });
  it('uses native regions, filter and rotation without mutating source pixels', async () => {
    const { module, live } = nativeModule();
    dependencies.load.mockResolvedValue(module);
    const pixels = new Uint8ClampedArray(16).fill(123);
    const result = await renderDocscanRgba({ dimensions, pixels }, corners, 'grayscale', 90, 1600);
    expect(module._ds_wasm_begin).toHaveBeenCalledWith(expect.any(Number), 2, 2, 1600);
    expect(module._ds_wasm_prepare).toHaveBeenCalledWith(3, 0);
    expect(module._ds_wasm_finish).toHaveBeenCalledWith(3, 90, 0, 0, 0);
    expect([...result.image.pixels]).toEqual(Array(16).fill(77));
    expect(pixels.every((value) => value === 123)).toBe(true);
    expect(live.size).toBe(0);
    expect(dependencies.predict).not.toHaveBeenCalled();
  });
  it('keeps model fallback metadata and can run the next page after model failure', async () => {
    const { module, live } = nativeModule(true);
    dependencies.load.mockResolvedValue(module);
    dependencies.predict.mockRejectedValue(new Error('runtime unavailable'));
    const input = { dimensions, pixels: new Uint8ClampedArray(16) };
    const result = await renderDocscanRgba(input, corners, 'enhanced-color', 0);
    expect(result.image.enhancement).toBe('model-unavailable');
    expect(result.image.enhancementFailure).toBe('runtime');
    expect(live.size).toBe(0);
    dependencies.predict.mockImplementation(
      (sample: { width: number; height: number; data: Float32Array }) =>
        Promise.resolve({
          ...sample,
          data: sample.data.fill(1),
        }),
    );
    const retry = await renderDocscanRgba(input, corners, 'enhanced-color', 0);
    expect(retry.image.enhancement).toBe('shadow-model');
    expect(live.size).toBe(0);
  });
  it('rejects malformed source patches, releases the page and permits retry', async () => {
    const { module, live } = nativeModule();
    dependencies.load.mockResolvedValue(module);
    await expect(
      renderDocscanRegions(
        dimensions,
        corners,
        () => ({ dimensions, pixels: new Uint8ClampedArray(15) }),
        'original',
        0,
      ),
    ).rejects.toMatchObject({ code: 'invalid-input' });
    expect(live.size).toBe(0);
    expect(module._ds_wasm_release).toHaveBeenCalledOnce();
    await expect(
      renderDocscanRgba({ dimensions, pixels: new Uint8ClampedArray(16) }, corners, 'original', 0),
    ).resolves.toHaveProperty('image');
  });
  it('propagates native allocation failure and clears owned allocations', async () => {
    const { module, live } = nativeModule();
    dependencies.load.mockResolvedValue(module);
    vi.mocked(module._ds_wasm_write_patch).mockReturnValue(8);
    await expect(
      renderDocscanRgba({ dimensions, pixels: new Uint8ClampedArray(16) }, corners, 'original', 0),
    ).rejects.toMatchObject({ code: 'out-of-memory' });
    expect(live.size).toBe(0);
  });
  it('rejects a second page while the owned native page awaits inference', async () => {
    const { module } = nativeModule(true);
    dependencies.load.mockResolvedValue(module);
    let rejectInference: ((error: Error) => void) | undefined;
    dependencies.predict.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectInference = reject;
        }),
    );
    const input = { dimensions, pixels: new Uint8ClampedArray(16) };
    const first = renderDocscanRgba(input, corners, 'enhanced-color', 0);
    await vi.waitFor(() => {
      expect(rejectInference).toBeTypeOf('function');
    });
    await expect(renderDocscanRgba(input, corners, 'original', 0)).rejects.toMatchObject({
      code: 'unavailable',
    });
    rejectInference?.(new Error('runtime'));
    await first;
  });
});
