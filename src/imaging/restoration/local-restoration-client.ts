import type { ImageAsset } from '../../domain/document';
import type { AppliedRestorationStage, RestorationWarning } from './restoration-types';

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
  restore(source: Blob, signal: AbortSignal): Promise<LocalRestorationResult>;
  dispose?(): void;
}

interface WorkerSuccess {
  readonly id: number;
  readonly kind: 'success';
  readonly result: LocalRestorationResult;
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
      readonly resolve: (value: LocalRestorationResult) => void;
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
    restore(source, signal) {
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
        pending.set(id, { resolve, reject, signal, abort });
        signal.addEventListener('abort', abort, { once: true });
        worker.postMessage({ operation: 'restore', id, source });
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
