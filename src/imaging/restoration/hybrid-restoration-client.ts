import { importImage, type ImageImporter } from '../../features/camera/image-import';
import type { ImageAsset } from '../../domain/document';
import type { RestorationStage } from './restoration-policy';

const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const ALLOWED_STAGES = new Set<RestorationStage>([
  'finger-segmentation',
  'dewarp',
  'deshadow',
  'demoire',
  'deblur',
  'appearance',
]);
const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const IDENTITY_PATTERN = /^[A-Za-z0-9._/-]+@[A-Za-z0-9._+-]+$/;

export type HybridRestorationFailureCode =
  'invalid-endpoint' | 'invalid-input' | 'invalid-response' | 'unavailable' | 'timeout' | 'failed';

export class HybridRestorationError extends Error {
  override readonly name = 'HybridRestorationError';

  constructor(readonly code: HybridRestorationFailureCode) {
    super(`Hybrid restoration failed: ${code}`);
  }
}

export interface HybridRestorationResult {
  readonly route: 'local' | 'gpu';
  readonly stages: readonly RestorationStage[];
  readonly classifierModel: string;
  readonly provider: string | null;
  readonly image: ImageAsset;
}

export interface HybridRestorationClient {
  restore(source: Blob, signal: AbortSignal): Promise<HybridRestorationResult>;
}

interface HybridRestorationClientOptions {
  readonly endpoint: string;
  readonly fetcher?: typeof fetch;
  readonly importer?: ImageImporter;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

function abortError(code: 'timeout' | 'failed'): Error {
  if (code === 'timeout') return new HybridRestorationError('timeout');
  const error = new Error('Hybrid restoration cancelled.');
  error.name = 'AbortError';
  return error;
}

function validateEndpoint(value: string): string {
  let endpoint: URL;
  try {
    endpoint = new URL(value, globalThis.location.origin);
  } catch {
    throw new HybridRestorationError('invalid-endpoint');
  }
  const localhost = endpoint.hostname === 'localhost' || endpoint.hostname === '127.0.0.1';
  if (
    (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && localhost)) ||
    endpoint.username !== '' ||
    endpoint.password !== ''
  ) {
    throw new HybridRestorationError('invalid-endpoint');
  }
  return endpoint.toString();
}

function positiveInteger(value: number, code: HybridRestorationFailureCode): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new HybridRestorationError(code);
  return value;
}

function parseIdentity(headers: Headers, name: string, required: boolean): string | null {
  const value = headers.get(name);
  if (value === null && !required) return null;
  if (value === null || value.length > 128 || !IDENTITY_PATTERN.test(value)) {
    throw new HybridRestorationError('invalid-response');
  }
  return value;
}

function parseStages(value: string | null): readonly RestorationStage[] {
  if (value === null || value === '') return [];
  const stages = value.split(',');
  if (stages.some((stage) => !ALLOWED_STAGES.has(stage as RestorationStage))) {
    throw new HybridRestorationError('invalid-response');
  }
  if (new Set(stages).size !== stages.length) {
    throw new HybridRestorationError('invalid-response');
  }
  return stages as RestorationStage[];
}

async function boundedResponseBlob(response: Response, maximum: number): Promise<Blob> {
  const contentType = response.headers.get('Content-Type')?.split(';', 1)[0] ?? '';
  if (!ALLOWED_IMAGE_TYPES.has(contentType)) {
    throw new HybridRestorationError('invalid-response');
  }
  const declaredLength = response.headers.get('Content-Length');
  if (declaredLength !== null) {
    const value = Number(declaredLength);
    if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
      throw new HybridRestorationError('invalid-response');
    }
  }
  if (response.body === null) throw new HybridRestorationError('invalid-response');
  const reader = response.body.getReader();
  const chunks: ArrayBuffer[] = [];
  let total = 0;
  let streamComplete = false;
  try {
    while (!streamComplete) {
      const { done, value } = await reader.read();
      streamComplete = done;
      if (done) continue;
      total += value.byteLength;
      if (total > maximum) throw new HybridRestorationError('invalid-response');
      const copy = new Uint8Array(value.byteLength);
      copy.set(value);
      chunks.push(copy.buffer);
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) throw new HybridRestorationError('invalid-response');
  return new Blob(chunks, { type: contentType });
}

function linkedTimeout(
  signal: AbortSignal,
  timeoutMs: number,
): {
  readonly signal: AbortSignal;
  readonly timedOut: () => boolean;
  readonly dispose: () => void;
} {
  const controller = new AbortController();
  let timeout = false;
  const abort = () => {
    controller.abort();
  };
  if (signal.aborted) controller.abort();
  else signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => {
    timeout = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => timeout,
    dispose: () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    },
  };
}

export function createHybridRestorationClient(
  options: HybridRestorationClientOptions,
): HybridRestorationClient {
  const endpoint = validateEndpoint(options.endpoint);
  const fetcher = options.fetcher ?? fetch;
  const importer = options.importer ?? importImage;
  const timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 'invalid-endpoint');
  const maxResponseBytes = positiveInteger(
    options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    'invalid-endpoint',
  );
  return {
    async restore(source, signal) {
      if (
        !(source instanceof Blob) ||
        source.size <= 0 ||
        source.size > DEFAULT_MAX_RESPONSE_BYTES ||
        !ALLOWED_IMAGE_TYPES.has(source.type)
      ) {
        throw new HybridRestorationError('invalid-input');
      }
      const operation = linkedTimeout(signal, timeoutMs);
      try {
        const body = new FormData();
        body.append('image', source, 'scan');
        const response = await fetcher(endpoint, {
          method: 'POST',
          body,
          credentials: 'omit',
          redirect: 'error',
          signal: operation.signal,
        });
        if (!response.ok) {
          throw new HybridRestorationError(response.status === 503 ? 'unavailable' : 'failed');
        }
        const route = response.headers.get('X-Restoration-Route');
        if (route !== 'local' && route !== 'gpu') {
          throw new HybridRestorationError('invalid-response');
        }
        const stages = parseStages(response.headers.get('X-Restoration-Stages'));
        if ((route === 'local' && stages.length > 0) || (route === 'gpu' && stages.length === 0)) {
          throw new HybridRestorationError('invalid-response');
        }
        const classifierModel = parseIdentity(response.headers, 'X-Classifier-Model', true);
        const provider = parseIdentity(response.headers, 'X-Restoration-Provider', route === 'gpu');
        const restored = await boundedResponseBlob(response, maxResponseBytes);
        const imported = await importer(restored, operation.signal);
        return {
          route,
          stages,
          classifierModel: classifierModel ?? '',
          provider,
          image: imported.original,
        };
      } catch (error) {
        if (operation.signal.aborted) throw abortError(operation.timedOut() ? 'timeout' : 'failed');
        if (error instanceof HybridRestorationError) throw error;
        throw new HybridRestorationError('failed');
      } finally {
        operation.dispose();
      }
    },
  };
}
