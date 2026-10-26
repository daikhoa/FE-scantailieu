import {
  validateComparisonInput,
  COMPARISON_LABELS,
  COMPARISON_IMPLEMENTATIONS,
  type ComparisonEngine,
  type ComparisonInput,
  type ComparisonReply,
  type ComparisonResult,
  type ComparisonSample,
} from './comparison-contract';
import { ComparisonError } from './comparison-error';

export async function runComparison(
  engine: ComparisonEngine,
  input: ComparisonInput,
  signal: AbortSignal,
  progress: (completed: number) => void,
  createWorker = () =>
    new Worker(new URL('./comparison.worker.ts', import.meta.url), {
      type: 'module',
      name: 'image-comparison',
    }),
): Promise<ComparisonResult> {
  if (signal.aborted) throw new DOMException('Đã dừng.', 'AbortError');
  validateComparisonInput(input);
  if (!Object.hasOwn(COMPARISON_LABELS, engine)) throw new Error('invalid-input');
  const start = performance.now();
  const worker = createWorker();
  return await new Promise((resolve, reject) => {
    let settled = false;
    let ready = false;
    let setupMs = 0;
    const samples: ComparisonSample[] = [];
    const finish = (error?: Error, result?: ComparisonResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      worker.terminate();
      if (result) resolve(result);
      else reject(error ?? new Error('failed'));
    };
    const abort = () => {
      finish(new DOMException('Đã dừng.', 'AbortError'));
    };
    const timer = setTimeout(() => {
      finish(new Error('timeout'));
    }, 180_000);
    signal.addEventListener('abort', abort, { once: true });
    worker.onerror = () => {
      finish(new ComparisonError('unavailable', ready ? 'process' : 'initialize'));
    };
    worker.onmessageerror = () => {
      finish(new Error('failed'));
    };
    worker.onmessage = (event: MessageEvent<ComparisonReply>) => {
      if (settled) return;
      const reply = event.data;
      if (reply.type === 'error') {
        finish(new ComparisonError(reply.code, reply.stage ?? (ready ? 'process' : 'initialize')));
        return;
      }
      if (reply.type === 'ready' && !ready) {
        ready = true;
        setupMs = performance.now() - start;
        try {
          worker.postMessage({ type: 'run', input });
        } catch {
          finish(new Error('failed'));
        }
      } else if (reply.type === 'sample' && ready && samples.length < input.repetitions) {
        samples.push(reply.sample);
        progress(samples.length);
      } else if (reply.type === 'done' && ready && samples.length === input.repetitions) {
        finish(undefined, {
          engine,
          setupMs,
          wallMs: performance.now() - start,
          samples,
          image: reply.image,
          ...(reply.enhancement ? { enhancement: reply.enhancement } : {}),
          ...(reply.enhancementFailure ? { enhancementFailure: reply.enhancementFailure } : {}),
          filter: input.filter,
          implementation:
            COMPARISON_IMPLEMENTATIONS[engine] +
            (input.filter === 'shadow-removal' ? '+gcnet-2eb69a0a-js-ort-field-v1' : ''),
        });
      } else finish(new Error('failed'));
    };
    try {
      worker.postMessage({ type: 'initialize', engine });
    } catch {
      finish(new Error('unavailable'));
    }
  });
}
