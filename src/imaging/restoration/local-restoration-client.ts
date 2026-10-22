import type { ImageAsset, ImageDimensions } from '../../domain/document';
import type { AppliedRestorationStage, RestorationWarning } from './restoration-types';

export interface LocalRestorationAnalysis {
  readonly kind: 'analysis';
  readonly stages: readonly AppliedRestorationStage[];
  readonly classifierModel: string;
  readonly warnings: readonly RestorationWarning[];
  readonly protectColor: boolean;
}

export interface LocalRestorationResult {
  readonly route: 'local' | 'enhanced';
  readonly stages: readonly AppliedRestorationStage[];
  readonly classifierModel: string;
  readonly provider: string | null;
  readonly warnings: readonly RestorationWarning[];
  readonly image?: ImageAsset;
}

export interface LocalRestorationClient {
  warmup?(): void;
  analyze?(
    source: LocalRestorationSource,
    signal: AbortSignal,
    options?: Pick<LocalRestorationRequestOptions, 'analysisKey'>,
  ): Promise<LocalRestorationAnalysis>;
  restore(
    source: LocalRestorationSource,
    signal: AbortSignal,
    options?: LocalRestorationRequestOptions,
  ): Promise<LocalRestorationResult>;
  dispose?(): void;
}

export type LocalRestorationSource =
  | Blob
  | {
      readonly kind: 'rgba-frame';
      readonly dimensions: ImageDimensions;
      readonly pixels: Uint8ClampedArray<ArrayBuffer>;
    };

export interface LocalRestorationRequestOptions {
  readonly analysisKey?: string;
  readonly reuseAnalysis?: boolean;
}

interface WorkerSuccess {
  readonly id: number;
  readonly kind: 'success';
  readonly result: LocalRestorationResult | LocalRestorationAnalysis;
}
interface WorkerFailure {
  readonly id: number;
  readonly kind: 'failure';
  readonly code: string;
}
type WorkerResponse = WorkerSuccess | WorkerFailure;

function abortError(): Error {
  const error = new Error('Local restoration cancelled.');
  error.name = 'AbortError';
  return error;
}

export function createLocalRestorationClient(): LocalRestorationClient {
  const worker = new Worker(new URL('./local-restoration.worker.ts', import.meta.url), {
    type: 'module',
  });
  let sequence = 0;
  let closed = false;
  const pending = new Map<
    number,
    {
      readonly resolve: (value: LocalRestorationResult | LocalRestorationAnalysis) => void;
      readonly reject: (reason: Error) => void;
      readonly signal: AbortSignal;
      readonly abort: () => void;
    }
  >();

  const failAll = () => {
    for (const job of pending.values()) {
      job.signal.removeEventListener('abort', job.abort);
      job.reject(new Error('Local restoration worker failed.'));
    }
    pending.clear();
  };
  worker.addEventListener('error', failAll);
  worker.addEventListener('messageerror', failAll);
  worker.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
    const message = event.data;
    const job = pending.get(message.id);
    if (job === undefined) return;
    pending.delete(message.id);
    job.signal.removeEventListener('abort', job.abort);
    if (message.kind === 'success') job.resolve(message.result);
    else job.reject(new Error(`Local restoration failed: ${message.code}`));
  });

  return {
    warmup() {
      if (!closed) worker.postMessage({ operation: 'warmup' });
    },
    analyze(source, signal, options = {}) {
      if (closed) return Promise.reject(new Error('Local restoration worker is closed.'));
      if (signal.aborted) return Promise.reject(abortError());
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const abort = () => {
          const job = pending.get(id);
          if (job === undefined) return;
          pending.delete(id);
          worker.postMessage({ operation: 'cancel', id });
          reject(abortError());
        };
        pending.set(id, {
          resolve(value) {
            if ('kind' in value) resolve(value);
            else reject(new Error('Local restoration worker returned an invalid analysis.'));
          },
          reject,
          signal,
          abort,
        });
        signal.addEventListener('abort', abort, { once: true });
        const transfer = source instanceof Blob ? [] : [source.pixels.buffer];
        worker.postMessage({ operation: 'analyze', id, source, ...options }, transfer);
      });
    },
    restore(source, signal, options = {}) {
      if (closed) return Promise.reject(new Error('Local restoration worker is closed.'));
      if (signal.aborted) return Promise.reject(abortError());
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const abort = () => {
          const job = pending.get(id);
          if (job === undefined) return;
          pending.delete(id);
          worker.postMessage({ operation: 'cancel', id });
          reject(abortError());
        };
        pending.set(id, {
          resolve(value) {
            if ('route' in value) resolve(value);
            else reject(new Error('Local restoration worker returned an invalid result.'));
          },
          reject,
          signal,
          abort,
        });
        signal.addEventListener('abort', abort, { once: true });
        const transfer = source instanceof Blob ? [] : [source.pixels.buffer];
        worker.postMessage({ operation: 'restore', id, source, ...options }, transfer);
      });
    },
    dispose() {
      if (closed) return;
      closed = true;
      worker.terminate();
      failAll();
    },
  };
}
