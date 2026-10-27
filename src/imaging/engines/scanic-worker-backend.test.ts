import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createScanicWorkerBackend } from './scanic-worker-backend';
import type { RgbaBackendInput } from './scanic-backend-contract';

class FakeWorker extends EventTarget {
  static instances: FakeWorker[] = [];
  readonly messages: { readonly message: unknown; readonly transfer: unknown }[] = [];
  readonly terminate = vi.fn();
  acknowledgeDisposal = true;

  constructor(
    readonly url: URL,
    readonly options: WorkerOptions,
  ) {
    super();
    FakeWorker.instances.push(this);
  }

  postMessage(message: unknown, transfer?: unknown) {
    this.messages.push({ message, transfer });
    if (
      this.acknowledgeDisposal &&
      typeof message === 'object' &&
      message !== null &&
      'operation' in message &&
      message.operation === 'dispose' &&
      'id' in message
    ) {
      queueMicrotask(() => {
        this.reply({ id: message.id, kind: 'success', output: null });
      });
    }
  }

  reply(data: unknown) {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }
}

function latestWorker(): FakeWorker {
  const worker = FakeWorker.instances.at(-1);
  if (worker === undefined) throw new Error('Expected a worker instance.');
  return worker;
}

const input: RgbaBackendInput = {
  dimensions: { width: 2, height: 2 },
  pixels: new Uint8ClampedArray(16),
};
const corners = [
  { x: 0, y: 0 },
  { x: 2, y: 0 },
  { x: 2, y: 2 },
  { x: 0, y: 2 },
] as const;

beforeEach(() => {
  FakeWorker.instances = [];
  vi.stubGlobal('Worker', FakeWorker);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Scanic isolated worker backend', () => {
  it('waits for child model cleanup before terminating a realm, and bounds an unresponsive shutdown', async () => {
    vi.useFakeTimers();
    const backend = createScanicWorkerBackend();
    const worker = latestWorker();
    worker.acknowledgeDisposal = false;
    const pending = backend.initialize();
    const cancelled = expect(pending).rejects.toMatchObject({ code: 'unavailable' });
    const disposing = backend.dispose();
    await cancelled;
    expect(worker.terminate).not.toHaveBeenCalled();
    const command = worker.messages.at(-1)?.message;
    expect(command).toMatchObject({ operation: 'dispose' });
    // A late render/init result must not complete retirement before cleanup is acknowledged.
    worker.reply({ id: 1, kind: 'success', output: null });
    expect(worker.terminate).not.toHaveBeenCalled();
    if (typeof command !== 'object' || command === null || !('id' in command))
      throw new Error('Missing shutdown');
    worker.reply({ id: command.id, kind: 'success', output: null });
    await disposing;
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    await backend.dispose();
    const stalled = createScanicWorkerBackend();
    const stalledWorker = latestWorker();
    stalledWorker.acknowledgeDisposal = false;
    const forced = stalled.dispose();
    await vi.advanceTimersByTimeAsync(1000);
    await forced;
    expect(stalledWorker.terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('sends encoded originals as Blob references without transferring a full source RGBA buffer', async () => {
    const backend = createScanicWorkerBackend();
    const worker = latestWorker();
    const initialized = backend.initialize();
    worker.reply({ id: 1, kind: 'success', output: null });
    await initialized;
    if (backend.warpAsset === undefined) throw new Error('Missing encoded image renderer.');
    const parameters = {
      asset: {
        blob: new Blob(['photo'], { type: 'image/jpeg' }),
        dimensions: { width: 8000, height: 6000 },
      },
      corners,
      rotation: 0 as const,
      filter: 'original' as const,
      maximumOutputLongSide: 3000,
    };
    const job = backend.warpAsset(parameters);
    expect(worker.messages[1]).toEqual({
      message: { id: 2, operation: 'warp-asset', ...parameters },
      transfer: undefined,
    });
    worker.reply({ id: 2, kind: 'success', output: input });
    await expect(job).resolves.toEqual(input);
    await backend.dispose();
  });

  it('reports unavailable without Worker support', () => {
    vi.stubGlobal('Worker', undefined);
    expect(createScanicWorkerBackend).toThrow(expect.objectContaining({ code: 'unavailable' }));
  });

  it('uses a local module worker and transfers backend-owned buffers', async () => {
    const backend = createScanicWorkerBackend();
    const worker = latestWorker();
    expect(worker.url.pathname).toMatch(/scanic-classical.worker.ts$/);
    expect(worker.options).toEqual({ type: 'module', name: 'scanic-ml-1.6.0' });
    const initialization = backend.initialize();
    worker.reply({ id: 1, kind: 'success', output: null });
    await initialization;
    const job = backend.detect(input);
    expect(worker.messages[1]).toEqual({
      message: { id: 2, operation: 'detect', input },
      transfer: [input.pixels.buffer],
    });
    const output = { success: false, confidence: null, corners: null };
    worker.reply({ id: 2, kind: 'success', output });
    await expect(job).resolves.toEqual(output);
    await backend.dispose();
  });

  it('requests a worker warp and accepts only a bounded RGBA reply', async () => {
    const backend = createScanicWorkerBackend();
    const worker = latestWorker();
    const initialization = backend.initialize();
    worker.reply({ id: 1, kind: 'success', output: null });
    await initialization;

    const job = backend.warp(input, corners, 90, 'ocr-color', 1600);
    expect(worker.messages[1]).toEqual({
      message: {
        id: 2,
        operation: 'warp',
        input,
        corners,
        rotation: 90,
        filter: 'ocr-color',
        maximumOutputLongSide: 1600,
      },
      transfer: [input.pixels.buffer],
    });
    const output: RgbaBackendInput = {
      dimensions: { width: 2, height: 2 },
      pixels: new Uint8ClampedArray(16).fill(7),
    };
    worker.reply({ id: 2, kind: 'success', output });
    await expect(job).resolves.toEqual(output);
    await backend.dispose();
  });

  it('terminates on a malformed warp reply instead of trusting worker allocation metadata', async () => {
    const backend = createScanicWorkerBackend();
    const worker = latestWorker();
    const initialization = backend.initialize();
    worker.reply({ id: 1, kind: 'success', output: null });
    await initialization;

    const job = backend.warp(input, corners, 0, 'original');
    worker.reply({
      id: 2,
      kind: 'success',
      output: { dimensions: { width: 2, height: 2 }, pixels: new Uint8ClampedArray(15) },
    });
    await expect(job).rejects.toMatchObject({ code: 'failed' });
    expect(worker.terminate).toHaveBeenCalledOnce();
    await backend.dispose();
  });

  it('terminates its worker and settles in-flight jobs once on dispose', async () => {
    const backend = createScanicWorkerBackend();
    const worker = latestWorker();
    const pending = backend.initialize();
    const rejected = expect(pending).rejects.toMatchObject({ code: 'unavailable' });
    await backend.dispose();
    await rejected;
    await backend.dispose();
    expect(worker.terminate).toHaveBeenCalledOnce();
    await expect(backend.detect(input)).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('has a bounded wait and releases the worker when it stops replying', async () => {
    vi.useFakeTimers();
    const backend = createScanicWorkerBackend();
    const worker = latestWorker();
    const pending = backend.initialize();
    const rejected = expect(pending).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(worker.terminate).toHaveBeenCalledOnce();
    await backend.dispose();
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    null,
    { id: 2, kind: 'success', output: null },
    { id: 1, kind: 'success' },
    { id: 1, kind: 'unknown' },
    { id: 1, kind: 'failure', code: 'private-message' },
  ])('rejects malformed worker replies without exposing them (%j)', async (reply) => {
    const backend = createScanicWorkerBackend();
    const worker = latestWorker();
    const job = backend.initialize();
    worker.reply(reply);
    await expect(job).rejects.toMatchObject({ code: 'failed' });
    expect(worker.terminate).toHaveBeenCalledOnce();
    await backend.dispose();
  });

  it.each(['error', 'messageerror'])('settles jobs on worker %s', async (eventName) => {
    const backend = createScanicWorkerBackend();
    const worker = latestWorker();
    const job = backend.initialize();
    worker.dispatchEvent(new Event(eventName));
    await expect(job).rejects.toMatchObject({ code: 'failed' });
    expect(worker.terminate).toHaveBeenCalledOnce();
    await backend.dispose();
  });

  it('rejects concurrent backend calls rather than replacing an active resolver', async () => {
    const backend = createScanicWorkerBackend();
    const first = backend.initialize();
    await expect(backend.detect(input)).rejects.toMatchObject({ code: 'unavailable' });
    latestWorker().reply({ id: 1, kind: 'success', output: null });
    await first;
    await backend.dispose();
  });
});
