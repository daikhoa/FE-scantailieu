import frameModuleUrl from './scanic-frame.ts?worker&url';
import type { ClassicalBackend } from './scanic-backend-contract';
import { ScannerEngineError } from './scanner-engine-error';
import type { ScanicWorkerRequest, ScanicWorkerResponse } from './scanic-worker-backend';

/** Main-thread execution in an owned realm; removing it releases Scanic's global session cache. */
export function createScanicMainThreadBackend(): ClassicalBackend {
  if (typeof document === 'undefined' || typeof MessageChannel === 'undefined')
    throw new ScannerEngineError('unavailable');
  const frame = document.createElement('iframe');
  frame.hidden = true;
  frame.title = 'Local document processing';
  const url = new URL(frameModuleUrl, window.location.href);
  if (url.origin !== window.location.origin) throw new ScannerEngineError('unavailable');
  const channel = new MessageChannel();
  let disposed = false;
  let sequence = 0;
  let current: {
    id: number;
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  let readyReject: ((error: Error) => void) | undefined;
  let readyTimer: ReturnType<typeof setTimeout> | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    readyReject = reject;
    readyTimer = setTimeout(() => {
      reject(new ScannerEngineError('timeout'));
    }, 30_000);
    channel.port1.onmessage = (
      event: MessageEvent<ScanicWorkerResponse | { kind: 'connected' }>,
    ) => {
      if (event.data.kind === 'connected') {
        clearTimeout(readyTimer);
        resolve();
        return;
      }
      const response = event.data;
      if (response.id !== current?.id) return;
      const job = current;
      current = null;
      clearTimeout(job.timer);
      if (response.kind === 'success') job.resolve(response.output);
      else job.reject(new ScannerEngineError('failed'));
    };
    channel.port1.start();
  });
  // Attach the rejection handler before asynchronous iframe loading or caller cancellation.
  void ready.catch(() => undefined);
  frame.onload = () => {
    if (!disposed)
      frame.contentWindow?.postMessage('scanic-connect', window.location.origin, [channel.port2]);
  };
  frame.srcdoc = `<!doctype html><script type="module" src="${url.href}"></script>`;
  document.body.append(frame);

  async function request(
    message:
      | Omit<Extract<ScanicWorkerRequest, { operation: 'warp' }>, 'id'>
      | { operation: 'initialize' }
      | Omit<Extract<ScanicWorkerRequest, { operation: 'detect' }>, 'id'>,
  ): Promise<unknown> {
    await ready;
    if (disposed || current !== null) throw new ScannerEngineError('unavailable');
    const id = ++sequence;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        current = null;
        reject(new ScannerEngineError('timeout'));
      }, 30_000);
      current = { id, resolve, reject, timer };
      try {
        channel.port1.postMessage(
          { ...message, id },
          'input' in message ? [message.input.pixels.buffer] : [],
        );
      } catch {
        clearTimeout(timer);
        current = null;
        reject(new ScannerEngineError('failed'));
      }
    });
  }
  return {
    async initialize() {
      await request({ operation: 'initialize' });
    },
    detect(input) {
      return request({ operation: 'detect', input });
    },
    async warp(input, corners, rotation, filter, maximumOutputLongSide, analysis) {
      const output = await request({
        operation: 'warp',
        input,
        corners,
        rotation,
        filter,
        ...(maximumOutputLongSide === undefined ? {} : { maximumOutputLongSide }),
        ...(analysis === undefined ? {} : { analysis }),
      });
      if (
        typeof output !== 'object' ||
        output === null ||
        !('dimensions' in output) ||
        !('pixels' in output) ||
        !(output.pixels instanceof Uint8ClampedArray)
      )
        throw new ScannerEngineError('failed');
      return output as {
        dimensions: typeof input.dimensions;
        pixels: Uint8ClampedArray<ArrayBuffer>;
      };
    },
    dispose() {
      if (disposed) return Promise.resolve();
      disposed = true;
      clearTimeout(readyTimer);
      readyReject?.(new ScannerEngineError('unavailable'));
      if (current !== null) {
        clearTimeout(current.timer);
        current.reject(new ScannerEngineError('unavailable'));
        current = null;
      }
      frame.onload = null;
      channel.port1.close();
      channel.port2.close();
      frame.remove();
      return Promise.resolve();
    },
  };
}
