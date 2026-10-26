import * as ort from 'onnxruntime-web/wasm';
import { SCANIC_ML_ASSET_BASE } from '../engines/scanic-ml-assets';
import type { ShadowField } from './shadow-field';

const MODEL_URL = '/models/shadow/gcnet-2eb69a0a.onnx';
const MODEL_BYTES = 6_078_861;
const MODEL_SHA256 = '2eb69a0aa882069f9f6d874511f019428d814d5f3edfa4881dbd6ca7d5c068f9';
// Reuse the exact pinned CPU binary already shipped for corner detection.
ort.env.wasm.wasmPaths = { wasm: `${SCANIC_ML_ASSET_BASE}ort-wasm-simd-threaded.wasm` };
ort.env.wasm.numThreads = 1;
ort.env.wasm.initTimeout = 15_000;
let session: Promise<ort.InferenceSession> | undefined;
let busy = false;

async function load(): Promise<ort.InferenceSession> {
  const response = await fetch(MODEL_URL, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error('shadow-model-unavailable');
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength !== MODEL_BYTES) throw new Error('shadow-model-invalid');
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (v) =>
    v.toString(16).padStart(2, '0'),
  ).join('');
  if (hash !== MODEL_SHA256) throw new Error('shadow-model-invalid');
  const model = await ort.InferenceSession.create(bytes, {
    executionProviders: ['wasm'],
    executionMode: 'sequential',
    graphOptimizationLevel: 'all',
    enableCpuMemArena: false,
    enableMemPattern: false,
  });
  if (
    model.inputNames.length !== 1 ||
    model.inputNames[0] !== 'input' ||
    model.outputNames.length !== 1 ||
    model.outputNames[0] !== 'output'
  ) {
    await model.release();
    throw new Error('shadow-model-invalid');
  }
  return model;
}

/** Owned worker/iframe lifetime bounds the session. Never run concurrent inferences. */
export async function predictIllumination(sample: ShadowField): Promise<ShadowField> {
  if (busy) throw new Error('shadow-model-busy');
  busy = true;
  let tensor: ort.Tensor | undefined;
  let output: ort.Tensor | undefined;
  try {
    session ??= load();
    const model = await session;
    tensor = new ort.Tensor('float32', sample.data, [1, 3, sample.height, sample.width]);
    const result = await model.run({ input: tensor });
    output = result.output;
    if (
      output?.type !== 'float32' ||
      output.dims.length !== 4 ||
      output.dims[0] !== 1 ||
      output.dims[1] !== 3 ||
      output.dims[2] !== sample.height ||
      output.dims[3] !== sample.width ||
      !(output.data instanceof Float32Array)
    )
      throw new Error('shadow-model-invalid');
    return { width: sample.width, height: sample.height, data: new Float32Array(output.data) };
  } finally {
    output?.dispose();
    tensor?.dispose();
    busy = false;
  }
}
