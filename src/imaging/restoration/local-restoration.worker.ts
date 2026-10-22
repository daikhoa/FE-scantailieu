/* eslint-disable @typescript-eslint/no-non-null-assertion -- Pixel and tensor indices are bounded by validated dimensions and loop limits. */
import * as ort from 'onnxruntime-web/webgpu';

import { createClassicalRestorationPlan } from './classical-restoration-plan';
import { decideRestorationPolicy, type DocumentDefectScores } from './restoration-policy';
import type { AppliedRestorationStage } from './restoration-types';
import type { LocalRestorationAnalysis, LocalRestorationSource } from './local-restoration-client';
import { isValidImageDimensions } from '../geometry/coordinates';
import { MAX_WORKING_IMAGE_PIXELS, MAX_WORKING_IMAGE_SIDE } from '../working-image-limits';

const CLASSIFIER_URL = '/models/local-restoration/document-defects.onnx';
const CLASSIFIER_MODEL = 'document-defects@cord-v2-bootstrap-2026-10-18';
const GPU_BUFFER_USAGE = { mapRead: 1, copySrc: 4, copyDst: 8, uniform: 64, storage: 128 } as const;
const LABELS = [
  'shadow',
  'curved',
  'blur',
  'moire',
  'finger',
  'lowContrast',
  'colorDocument',
] as const;
const ANALYSIS_CACHE_LIMIT = 24;
const cancelled = new Set<number>();
const workerScope = globalThis as unknown as {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<WorkerRequest>) => void): void;
};
let classifierPromise: Promise<ort.InferenceSession> | null = null;
let restorationQueue: Promise<void> = Promise.resolve();

interface RestoreRequest {
  readonly operation: 'restore';
  readonly id: number;
  readonly source: LocalRestorationSource;
  readonly analysisKey?: string;
  readonly reuseAnalysis?: boolean;
}
interface AnalyzeRequest {
  readonly operation: 'analyze';
  readonly id: number;
  readonly source: LocalRestorationSource;
  readonly analysisKey?: string;
}
type WorkerRequest =
  | RestoreRequest
  | AnalyzeRequest
  | { readonly operation: 'warmup' }
  | { readonly operation: 'cancel'; readonly id: number };

function providers(): ort.InferenceSession.ExecutionProviderConfig[] {
  return browserGpu() === undefined ? ['wasm'] : ['webgpu', 'wasm'];
}

function browserGpu(): GPU | undefined {
  return Reflect.get(navigator, 'gpu');
}

function classifier(): Promise<ort.InferenceSession> {
  classifierPromise ??= ort.InferenceSession.create(CLASSIFIER_URL, {
    executionProviders: providers(),
    graphOptimizationLevel: 'all',
  });
  return classifierPromise;
}

async function decode(source: LocalRestorationSource): Promise<ImageBitmap> {
  if (source instanceof Blob) return await createImageBitmap(source, { imageOrientation: 'none' });
  const { dimensions, pixels } = source;
  if (
    !isValidImageDimensions(dimensions) ||
    Math.max(dimensions.width, dimensions.height) > MAX_WORKING_IMAGE_SIDE ||
    dimensions.width * dimensions.height > MAX_WORKING_IMAGE_PIXELS ||
    pixels.byteLength !== dimensions.width * dimensions.height * 4
  ) {
    throw new Error('invalid-rgba-source');
  }
  const canvas = new OffscreenCanvas(dimensions.width, dimensions.height);
  const context = canvas.getContext('2d', { alpha: false });
  if (context === null) throw new Error('canvas-unavailable');
  context.putImageData(new ImageData(pixels, dimensions.width, dimensions.height), 0, 0);
  return await createImageBitmap(canvas);
}

function sampleCanvas(bitmap: ImageBitmap, width: number, height: number): OffscreenCanvas {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d', { alpha: false });
  if (context === null) throw new Error('canvas-unavailable');
  context.drawImage(bitmap, 0, 0, width, height);
  return canvas;
}

function classifierInput(bitmap: ImageBitmap): { tensor: ort.Tensor; pixels: Uint8ClampedArray } {
  const canvas = sampleCanvas(bitmap, 224, 224);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (context === null) throw new Error('canvas-unavailable');
  const pixels = context.getImageData(0, 0, 224, 224).data;
  const data = new Float32Array(3 * 224 * 224);
  const mean = [0.485, 0.456, 0.406];
  const deviation = [0.229, 0.224, 0.225];
  const plane = 224 * 224;
  for (let index = 0; index < plane; index++) {
    const offset = index * 4;
    for (let channel = 0; channel < 3; channel++) {
      data[channel * plane + index] =
        (pixels[offset + channel]! / 255 - mean[channel]!) / deviation[channel]!;
    }
  }
  return { tensor: new ort.Tensor('float32', data, [1, 3, 224, 224]), pixels };
}

function sigmoid(value: number): number {
  return 1 / (1 + Math.exp(-value));
}

function evidence(pixels: Uint8ClampedArray) {
  const cells = new Float32Array(64);
  let highlights = 0;
  let detail = 0;
  for (let y = 0; y < 224; y++) {
    for (let x = 0; x < 224; x++) {
      const offset = (y * 224 + x) * 4;
      const luminance =
        0.2126 * pixels[offset]! + 0.7152 * pixels[offset + 1]! + 0.0722 * pixels[offset + 2]!;
      cells[Math.min(7, Math.floor(y / 28)) * 8 + Math.min(7, Math.floor(x / 28))]! +=
        luminance / (28 * 28);
      if (luminance > 245) highlights++;
      if (x > 0) {
        const previous = offset - 4;
        const previousLuminance =
          0.2126 * pixels[previous]! +
          0.7152 * pixels[previous + 1]! +
          0.0722 * pixels[previous + 2]!;
        detail += Math.abs(luminance - previousLuminance);
      }
    }
  }
  const range = Math.max(...cells) - Math.min(...cells);
  const averageDetail = detail / (223 * 224);
  return {
    illuminationRange: range,
    highlightRatio: highlights / (224 * 224),
    detail:
      averageDetail < 6
        ? ('low' as const)
        : averageDetail < 12
          ? ('medium' as const)
          : ('high' as const),
  };
}

async function classify(bitmap: ImageBitmap) {
  const input = classifierInput(bitmap);
  const session = await classifier();
  const output = await session.run({ image: input.tensor });
  const logits = output.logits?.data;
  if (logits === undefined || logits.length < LABELS.length) throw new Error('classifier-output');
  const scores = {} as Record<(typeof LABELS)[number], number>;
  LABELS.forEach((label, index) => {
    scores[label] = sigmoid(Number(logits[index]));
  });
  return { scores: scores as DocumentDefectScores, evidence: evidence(input.pixels) };
}

type ClassificationAnalysis = Awaited<ReturnType<typeof classify>>;
const analysisCache = new Map<string, ClassificationAnalysis>();

function rememberAnalysis(key: string, analysis: ClassificationAnalysis): void {
  analysisCache.delete(key);
  analysisCache.set(key, analysis);
  const oldest = analysisCache.keys().next();
  if (analysisCache.size > ANALYSIS_CACHE_LIMIT && !oldest.done) analysisCache.delete(oldest.value);
}

async function analysisFor(
  request: { readonly analysisKey?: string; readonly reuseAnalysis?: boolean },
  bitmap: ImageBitmap,
): Promise<ClassificationAnalysis> {
  const key = request.analysisKey;
  if (key !== undefined && request.reuseAnalysis === true) {
    const cached = analysisCache.get(key);
    if (cached !== undefined) {
      rememberAnalysis(key, cached);
      return cached;
    }
  }
  const analysis = await classify(bitmap);
  if (key !== undefined) rememberAnalysis(key, analysis);
  return analysis;
}

function restorationPlan(analysis: ClassificationAnalysis): LocalRestorationAnalysis {
  const decision = decideRestorationPolicy(analysis);
  const plan = createClassicalRestorationPlan(decision, analysis.scores);
  return {
    kind: 'analysis',
    stages: plan.stages,
    classifierModel: CLASSIFIER_MODEL,
    warnings: plan.warnings,
    protectColor: plan.protectColor,
  };
}

async function analyze(request: AnalyzeRequest): Promise<void> {
  const sample = await decode(request.source);
  try {
    const analysis = await analysisFor(request, sample);
    if (cancelled.has(request.id)) return;
    workerScope.postMessage({
      id: request.id,
      kind: 'success',
      result: restorationPlan(analysis),
    });
  } finally {
    sample.close();
    cancelled.delete(request.id);
  }
}

function canvasAppearance(
  context: OffscreenCanvasRenderingContext2D,
  canvas: OffscreenCanvas,
  stages: readonly AppliedRestorationStage[],
  protectColor: boolean,
): void {
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  const data = image.data;
  let total = 0;
  for (let i = 0; i < data.length; i += 4)
    total += 0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!;
  const mean = total / (data.length / 4);
  const lift = stages.includes('deshadow') ? Math.max(0, 196 - mean) * 0.45 : 0;
  const contrast = stages.includes('appearance') ? 1.1 : 1.04;
  const reduceMoire = stages.includes('demoire');
  const sharpen = stages.includes('deblur') ? (reduceMoire ? 0.12 : 0.28) : 0;
  const spatialFilter = reduceMoire || sharpen > 0;
  const source = spatialFilter ? data.slice() : data;
  for (let i = 0; i < data.length; i += 4) {
    let left = i;
    let right = i;
    let up = i;
    let down = i;
    if (spatialFilter) {
      const pixel = i / 4;
      const x = pixel % canvas.width;
      const y = Math.floor(pixel / canvas.width);
      left = (y * canvas.width + Math.max(0, x - 1)) * 4;
      right = (y * canvas.width + Math.min(canvas.width - 1, x + 1)) * 4;
      up = (Math.max(0, y - 1) * canvas.width + x) * 4;
      down = (Math.min(canvas.height - 1, y + 1) * canvas.width + x) * 4;
    }
    for (let c = 0; c < 3; c++) {
      const center = source[i + c]!;
      let neighborhood = center;
      if (spatialFilter) {
        neighborhood =
          (source[left + c]! + source[right + c]! + source[up + c]! + source[down + c]!) / 4;
      }
      const denoised = reduceMoire ? center * 0.82 + neighborhood * 0.18 : center;
      const detailed = denoised + (denoised - neighborhood) * sharpen;
      data[i + c] = Math.max(0, Math.min(255, (detailed + lift - 128) * contrast + 128));
    }
    if (!protectColor) {
      const gray = 0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!;
      data[i] = data[i]! * 0.86 + gray * 0.14;
      data[i + 1] = data[i + 1]! * 0.86 + gray * 0.14;
      data[i + 2] = data[i + 2]! * 0.86 + gray * 0.14;
    }
  }
  context.putImageData(image, 0, 0);
}

async function webGpuAppearance(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  stages: readonly AppliedRestorationStage[],
  protectColor: boolean,
): Promise<Uint8ClampedArray> {
  const gpu = browserGpu();
  if (gpu === undefined) throw new Error('webgpu-unavailable');
  const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (adapter === null) throw new Error('webgpu-unavailable');
  const device = await adapter.requestDevice();
  const count = width * height;
  const packed = new Uint32Array(count);
  let luminance = 0;
  for (let i = 0; i < count; i++) {
    const offset = i * 4;
    const red = pixels[offset]!;
    const green = pixels[offset + 1]!;
    const blue = pixels[offset + 2]!;
    luminance += 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    packed[i] = red | (green << 8) | (blue << 16) | (255 << 24);
  }
  const parameters = new Float32Array([
    width,
    height,
    stages.includes('deshadow') ? Math.max(0, 196 - luminance / count) * 0.45 : 0,
    stages.includes('appearance') ? 1.1 : 1.04,
    protectColor ? 1 : 0,
    stages.includes('deblur') ? (stages.includes('demoire') ? 0.12 : 0.28) : 0,
    stages.includes('demoire') ? 0.18 : 0,
    0,
  ]);
  const byteLength = packed.byteLength;
  const input = device.createBuffer({
    size: byteLength,
    usage: GPU_BUFFER_USAGE.storage | GPU_BUFFER_USAGE.copyDst,
  });
  const output = device.createBuffer({
    size: byteLength,
    usage: GPU_BUFFER_USAGE.storage | GPU_BUFFER_USAGE.copySrc,
  });
  const readback = device.createBuffer({
    size: byteLength,
    usage: GPU_BUFFER_USAGE.copyDst | GPU_BUFFER_USAGE.mapRead,
  });
  const uniform = device.createBuffer({
    size: parameters.byteLength,
    usage: GPU_BUFFER_USAGE.uniform | GPU_BUFFER_USAGE.copyDst,
  });
  try {
    device.queue.writeBuffer(input, 0, packed);
    device.queue.writeBuffer(uniform, 0, parameters);
    const shader = device.createShaderModule({
      code: `
      struct Params { width: f32, height: f32, lift: f32, contrast: f32, protectColor: f32, sharpen: f32, denoise: f32, pad0: f32 }
      @group(0) @binding(0) var<storage, read> source: array<u32>;
      @group(0) @binding(1) var<storage, read_write> target: array<u32>;
      @group(0) @binding(2) var<uniform> params: Params;
      fn rgb(value: u32) -> vec3<f32> { return vec3<f32>(f32(value & 255u), f32((value >> 8u) & 255u), f32((value >> 16u) & 255u)); }
      fn pack(value: vec3<f32>) -> u32 {
        let c = vec3<u32>(clamp(value, vec3<f32>(0.0), vec3<f32>(255.0)) + vec3<f32>(0.5));
        return c.x | (c.y << 8u) | (c.z << 16u) | (255u << 24u);
      }
      @compute @workgroup_size(256)
      fn main(@builtin(global_invocation_id) id: vec3<u32>) {
        let width = u32(params.width);
        let height = u32(params.height);
        let count = width * height;
        let index = id.x;
        if (index >= count) { return; }
        let x = index % width;
        let y = index / width;
        let left = y * width + select(x, x - 1u, x > 0u);
        let right = y * width + select(x, x + 1u, x + 1u < width);
        let up = select(y, y - 1u, y > 0u) * width + x;
        let down = select(y, y + 1u, y + 1u < height) * width + x;
        let center = rgb(source[index]);
        let neighborhood = (rgb(source[left]) + rgb(source[right]) + rgb(source[up]) + rgb(source[down])) * 0.25;
        var color = mix(center, neighborhood, params.denoise);
        color = color + (color - neighborhood) * params.sharpen;
        color = (color + vec3<f32>(params.lift) - vec3<f32>(128.0)) * params.contrast + vec3<f32>(128.0);
        if (params.protectColor < 0.5) {
          let gray = dot(color, vec3<f32>(0.2126, 0.7152, 0.0722));
          color = mix(vec3<f32>(gray), color, 0.86);
        }
        target[index] = pack(color);
      }`,
    });
    const pipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: shader, entryPoint: 'main' },
    });
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: input } },
        { binding: 1, resource: { buffer: output } },
        { binding: 2, resource: { buffer: uniform } },
      ],
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(count / 256));
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, byteLength);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(1);
    const copy = new Uint32Array(readback.getMappedRange().slice(0));
    const result = new Uint8ClampedArray(copy.buffer);
    readback.unmap();
    return result;
  } finally {
    input.destroy();
    output.destroy();
    readback.destroy();
    uniform.destroy();
    device.destroy();
  }
}

async function enhance(
  bitmap: ImageBitmap,
  stages: readonly AppliedRestorationStage[],
  protectColor: boolean,
  outputDimensions: { readonly width: number; readonly height: number },
): Promise<{ blob: Blob; provider: string }> {
  // The classifier chooses a bounded classical chain; no restoration model is loaded here.
  const canvas = sampleCanvas(bitmap, outputDimensions.width, outputDimensions.height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (context === null) throw new Error('canvas-unavailable');
  let usedWebGpu = false;
  if (
    stages.includes('deshadow') ||
    stages.includes('appearance') ||
    stages.includes('demoire') ||
    stages.includes('deblur')
  ) {
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    try {
      const filtered = await webGpuAppearance(
        image.data,
        canvas.width,
        canvas.height,
        stages,
        protectColor,
      );
      const owned = new Uint8ClampedArray(filtered.length);
      owned.set(filtered);
      context.putImageData(new ImageData(owned, canvas.width, canvas.height), 0, 0);
      usedWebGpu = true;
    } catch {
      canvasAppearance(context, canvas, stages, protectColor);
    }
  }
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.96 });
  return {
    blob,
    provider: usedWebGpu ? 'browser-webgpu-classical@1' : 'browser-canvas-classical@1',
  };
}

async function restore(request: RestoreRequest) {
  const bitmap = await decode(request.source);
  const outputDimensions = { width: bitmap.width, height: bitmap.height };
  try {
    const analysis = await analysisFor(request, bitmap);
    if (cancelled.has(request.id)) return;
    const plan = restorationPlan(analysis);
    const { stages, warnings } = plan;
    if (stages.length === 0) {
      workerScope.postMessage({
        id: request.id,
        kind: 'success',
        result: {
          route: 'local',
          stages,
          classifierModel: CLASSIFIER_MODEL,
          provider: 'browser-ort',
          warnings,
        },
      });
      return;
    }
    const output = await enhance(bitmap, stages, plan.protectColor, outputDimensions);
    workerScope.postMessage({
      id: request.id,
      kind: 'success',
      result: {
        route: 'enhanced',
        stages,
        classifierModel: CLASSIFIER_MODEL,
        provider: output.provider,
        warnings,
        image: { blob: output.blob, dimensions: outputDimensions },
      },
    });
  } finally {
    bitmap.close();
    cancelled.delete(request.id);
  }
}

workerScope.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  if (request.operation === 'warmup') {
    void classifier().catch(() => undefined);
    return;
  }
  if (request.operation === 'cancel') {
    cancelled.add(request.id);
    return;
  }
  restorationQueue = restorationQueue
    .then(async () => {
      if (cancelled.has(request.id)) {
        cancelled.delete(request.id);
        return;
      }
      if (request.operation === 'analyze') await analyze(request);
      else await restore(request);
    })
    .catch((error: unknown) => {
      if (!cancelled.has(request.id))
        workerScope.postMessage({
          id: request.id,
          kind: 'failure',
          code: error instanceof Error ? error.message : 'failed',
        });
      cancelled.delete(request.id);
    });
});
