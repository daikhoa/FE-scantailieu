import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { predictIllumination, disposeShadowRuntime } from './gcnet-runtime';
import type { ShadowField } from './shadow-field';
class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminate = vi.fn();
  postMessage =
    vi.fn<
      (
        message: { type: 'predict'; id: number; sample: ShadowField },
        transfer: Transferable[],
      ) => void
    >();
  constructor() {
    FakeWorker.instances.push(this);
  }
  reply(value: unknown) {
    this.onmessage?.(new MessageEvent('message', { data: value }));
  }
}
function workerAt(index: number) {
  const worker = FakeWorker.instances[index];
  if (!worker) throw new Error('Missing worker');
  return worker;
}
function requestAt(worker: FakeWorker, index = 0) {
  const request = worker.postMessage.mock.calls[index]?.[0];
  if (!request) throw new Error('Missing request');
  return request;
}
const sample = () => ({ width: 32, height: 32, data: new Float32Array(32 * 32 * 3).fill(0.5) });
beforeEach(() => {
  FakeWorker.instances = [];
  vi.stubGlobal('Worker', FakeWorker);
  vi.useFakeTimers();
});
afterEach(() => {
  disposeShadowRuntime();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe('isolated GCNet worker lifecycle', () => {
  it('reuses an isolated worker and keeps the caller sample intact', async () => {
    const input = sample(),
      p = predictIllumination(input),
      w = workerAt(0);
    expect(w.postMessage).toHaveBeenCalledOnce();
    const request = requestAt(w);
    expect(request.sample.data).not.toBe(input.data);
    w.reply({ type: 'result', id: request.id, field: sample() });
    expect((await p).data.length).toBe(3072);
    expect(input.data.byteLength).toBe(12288);
    const p2 = predictIllumination(input);
    const id = requestAt(w, 1).id;
    w.reply({ type: 'result', id, field: sample() });
    await p2;
    expect(FakeWorker.instances).toHaveLength(1);
  });
  it('drops a failed initialization so the next request creates a fresh runtime', async () => {
    const p = predictIllumination(sample()),
      w = workerAt(0);
    const failed = expect(p).rejects.toMatchObject({ code: 'runtime' });
    w.reply({ type: 'error', id: requestAt(w).id, code: 'runtime' });
    await failed;
    expect(w.terminate).toHaveBeenCalledOnce();
    const retry = predictIllumination(sample()),
      next = workerAt(1);
    next.reply({ type: 'result', id: requestAt(next).id, field: sample() });
    await expect(retry).resolves.toMatchObject({ width: 32 });
  });
  it('times out, terminates the failed worker and rejects corrupt fields without poisoning retries', async () => {
    const p = predictIllumination(sample()),
      w = workerAt(0);
    const failed = expect(p).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(60000);
    await failed;
    expect(w.terminate).toHaveBeenCalledOnce();
    const retry = predictIllumination(sample()),
      next = workerAt(1),
      field = sample();
    field.data[0] = NaN;
    const invalid = expect(retry).rejects.toMatchObject({ code: 'model-invalid' });
    next.reply({ type: 'result', id: requestAt(next).id, field });
    await invalid;
    expect(next.terminate).toHaveBeenCalledOnce();
  });
  it('rejects concurrent calls and settles pending work on disposal', async () => {
    const p = predictIllumination(sample());
    await expect(predictIllumination(sample())).rejects.toMatchObject({ code: 'busy' });
    const failed = expect(p).rejects.toMatchObject({ code: 'runtime' });
    disposeShadowRuntime();
    await failed;
  });
});
