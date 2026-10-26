import {
  validateComparisonInput,
  COMPARISON_LABELS,
  COMPARISON_WASM_BASE,
  type ComparisonCommand,
  type ComparisonEngine,
  type ComparisonReply,
} from './comparison-contract';
import { decodeRasterBitmap } from '../../imaging/codecs/decode-raster-bitmap';
import { createBrowserRgbaCodec } from '../../imaging/codecs/browser-rgba-codec';
import {
  applyFinalAppearance,
  prepareEnhancedAppearance,
} from '../../imaging/restoration/enhanced-appearance';
import { warpPerspectiveRgba, type RgbaImage } from '../../imaging/rendering/perspective-warp';
import { warpPerspectiveRegions } from '../../imaging/rendering/region-perspective-warp';
import { validateQuad } from '../../imaging/geometry/quad';
import { MAX_ENCODED_INPUT_BYTES } from '../../imaging/original-image-limits';
import type { ImageAsset } from '../../domain/document';
import type { RgbaBackendInput } from '../../imaging/engines/scanic-backend-contract';
import { classifyComparisonError, type ComparisonStage } from './comparison-error';

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<ComparisonCommand>) => void) | null;
  postMessage(reply: ComparisonReply): void;
};
let engine: ComparisonEngine | null = null;
let wasm: Awaited<ReturnType<typeof import('./wasm-raster').loadWasmRaster>> | null = null;
let running = false;
let stage: ComparisonStage = 'initialize';
const signal = new AbortController().signal;

async function decode(asset: ImageAsset): Promise<RgbaImage> {
  const bitmap = await decodeRasterBitmap(asset.blob, { imageOrientation: 'none' }, signal);
  let surface: OffscreenCanvas | null = null;
  try {
    if (bitmap.width !== asset.dimensions.width || bitmap.height !== asset.dimensions.height)
      throw new Error('invalid-input');
    surface = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = surface.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('unavailable');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, bitmap.width, bitmap.height);
    context.drawImage(bitmap, 0, 0);
    return {
      dimensions: asset.dimensions,
      pixels: context.getImageData(0, 0, bitmap.width, bitmap.height).data,
    };
  } finally {
    bitmap.close();
    if (surface) {
      surface.width = 1;
      surface.height = 1;
    }
  }
}

async function handle(command: ComparisonCommand) {
  if (command.type === 'initialize') {
    if (engine !== null) throw new Error('invalid-state');
    if (!Object.hasOwn(COMPARISON_LABELS, command.engine)) throw new Error('invalid-input');
    engine = command.engine;
    if (engine !== 'web')
      wasm = await (await import('./wasm-raster')).loadWasmRaster(COMPARISON_WASM_BASE);
    scope.postMessage({ type: 'ready' });
    return;
  }
  if (engine === null || running) throw new Error('invalid-state');
  running = true;
  stage = 'validate';
  const { input } = command;
  validateComparisonInput(input);
  if (
    input.asset.blob.size > MAX_ENCODED_INPUT_BYTES ||
    !validateQuad(input.corners, input.asset.dimensions, 1).valid
  )
    throw new Error('invalid-input');
  const codec = createBrowserRgbaCodec();
  let image: ImageAsset | null = null;
  let enhancement: RgbaBackendInput['enhancement'];
  let enhancementFailure: RgbaBackendInput['enhancementFailure'];
  for (let repetition = 0; repetition < input.repetitions; repetition++) {
    const started = performance.now();
    stage = 'decode';
    const source = await decode(input.asset);
    const decoded = performance.now();
    let final: RgbaBackendInput;
    let reservedBytes: number | null = null;
    stage = 'process';
    if (engine !== 'web') {
      if (!wasm) throw new Error('unavailable');
      const result = wasm.process(source, input.corners, false);
      final = result.image;
      reservedBytes = result.reservedBytes;
      if (input.filter === 'enhanced-color') {
        const prepared = await prepareEnhancedAppearance(final);
        const rendered = wasm.enhance(final, prepared.plan.field);
        final = {
          ...rendered.image,
          enhancement: prepared.enhancement,
          ...(prepared.enhancementFailure
            ? { enhancementFailure: prepared.enhancementFailure }
            : {}),
        };
        reservedBytes = Math.max(reservedBytes, rendered.reservedBytes);
      } else final = await applyFinalAppearance(final, input.filter);
    } else {
      final =
        source.pixels.length <= 16_777_216 * 4 &&
        Math.max(source.dimensions.width, source.dimensions.height) <= 8192
          ? warpPerspectiveRgba(source, input.corners, 3000)
          : await warpPerspectiveRegions(
              source.dimensions,
              input.corners,
              (region) => {
                const pixels = new Uint8ClampedArray(region.width * region.height * 4);
                for (let y = 0; y < region.height; y++) {
                  const start = ((region.y + y) * source.dimensions.width + region.x) * 4;
                  pixels.set(
                    source.pixels.subarray(start, start + region.width * 4),
                    y * region.width * 4,
                  );
                }
                return { dimensions: region, pixels };
              },
              3000,
            );
      final = await applyFinalAppearance(final, input.filter);
    }
    const processed = performance.now();
    enhancement = final.enhancement;
    enhancementFailure = final.enhancementFailure;
    stage = 'encode';
    // The same lossless encoder on both paths isolates raster quality from JPEG differences.
    image = {
      blob: await codec.encode(final, { type: 'image/png' }, signal),
      dimensions: final.dimensions,
    };
    const encoded = performance.now();
    scope.postMessage({
      type: 'sample',
      sample: {
        decodeMs: decoded - started,
        processMs: processed - decoded,
        encodeMs: encoded - processed,
        totalMs: encoded - started,
        inputPixelBytes: source.pixels.byteLength,
        outputPixelBytes: final.pixels.byteLength,
        wasmReservedBytes: reservedBytes,
      },
    });
  }
  if (!image) throw new Error('failed');
  scope.postMessage({
    type: 'done',
    image,
    ...(enhancement ? { enhancement } : {}),
    ...(enhancementFailure ? { enhancementFailure } : {}),
  });
}

scope.onmessage = (event) => {
  void handle(event.data).catch((error: unknown) => {
    const failure = classifyComparisonError(error, stage);
    scope.postMessage({
      type: 'error',
      code: failure.code,
      stage: failure.stage,
    });
  });
};
