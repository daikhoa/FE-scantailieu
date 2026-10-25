import type { DocumentCorners } from '../../domain/document';
import type { RgbaImage } from '../../imaging/rendering/perspective-warp';

interface WasmRaster {
  HEAPU8: Uint8Array<ArrayBuffer>;
  HEAPF64: Float64Array<ArrayBuffer>;
  _malloc(bytes: number): number;
  _free(pointer: number): void;
  _ds_wasm_process_owned(
    input: number,
    width: number,
    height: number,
    corners: number,
    filter: number,
  ): number;
  _ds_wasm_output(): number;
  _ds_wasm_width(): number;
  _ds_wasm_height(): number;
  _ds_wasm_release(): void;
}

export async function loadWasmRaster(assetBase: string) {
  // Public, versioned assets; lazy import keeps the scanner's normal startup untouched.
  // Pass config into the lazy chunk so it cannot import the worker entry back in WebKit.
  const path = `${assetBase}docscan.mjs`;
  const factory = (await import(/* @vite-ignore */ path)) as { default: () => Promise<WasmRaster> };
  const module = await factory.default();
  return {
    process(input: RgbaImage, corners: DocumentCorners, enhanced: boolean) {
      let pointer = 0;
      let points = 0;
      try {
        pointer = module._malloc(input.pixels.byteLength);
        points = module._malloc(8 * 8);
        if (!pointer || !points) throw new Error('out-of-memory');
        module.HEAPU8.set(input.pixels, pointer);
        module.HEAPF64.set(
          corners.flatMap((p) => [p.x, p.y]),
          points / 8,
        );
        const args = [
          pointer,
          input.dimensions.width,
          input.dimensions.height,
          points,
          enhanced ? 2 : 0,
        ] as const;
        const status = module._ds_wasm_process_owned(...args);
        if (status !== 0)
          throw new Error(
            status === 8
              ? 'out-of-memory'
              : status === 1 || status === 3
                ? 'invalid-input'
                : 'failed',
          );
        const dimensions = { width: module._ds_wasm_width(), height: module._ds_wasm_height() };
        const length = dimensions.width * dimensions.height * 4;
        if (
          dimensions.width < 1 ||
          dimensions.height < 1 ||
          Math.max(dimensions.width, dimensions.height) > 3000
        )
          throw new Error('failed');
        const output = module._ds_wasm_output();
        const pixels = new Uint8ClampedArray(length);
        pixels.set(module.HEAPU8.subarray(output, output + length));
        return { image: { dimensions, pixels }, reservedBytes: module.HEAPU8.buffer.byteLength };
      } finally {
        module._ds_wasm_release();
        if (points) module._free(points);
        if (pointer) module._free(pointer);
      }
    },
  };
}
