import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLocalRestorationClient } from './local-restoration-client';

class FakeWorker {
  static latest: FakeWorker | null = null;
  readonly posted: unknown[] = [];
  readonly transfers: readonly Transferable[][] = [];
  readonly terminate = vi.fn();
  private readonly listeners = new Map<string, ((event: MessageEvent) => void)[]>();

  constructor() {
    FakeWorker.latest = this;
  }

  addEventListener(type: string, listener: EventListener): void {
    const current = this.listeners.get(type) ?? [];
    current.push(listener as (event: MessageEvent) => void);
    this.listeners.set(type, current);
  }

  postMessage(message: unknown, transfer: Transferable[] = []): void {
    this.posted.push(message);
    (this.transfers as Transferable[][]).push(transfer);
  }

  emit(message: unknown): void {
    for (const listener of this.listeners.get('message') ?? []) {
      listener({ data: message } as MessageEvent);
    }
  }

  emitWorkerError(): void {
    for (const listener of this.listeners.get('error') ?? []) {
      listener({} as MessageEvent);
    }
  }
}

describe('local restoration client', () => {
  afterEach(() => {
    FakeWorker.latest = null;
    vi.unstubAllGlobals();
  });

  it('warms the classifier and resolves a local worker result', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const client = createLocalRestorationClient();
    const worker = FakeWorker.latest;
    if (worker === null) throw new Error('Worker was not created.');
    client.warmup?.();
    const operation = client.restore(
      new Blob(['scan'], { type: 'image/jpeg' }),
      new AbortController().signal,
      { analysisKey: 'page-1', reuseAnalysis: true },
    );

    expect(worker.posted[0]).toEqual({ operation: 'warmup' });
    expect(worker.posted[1]).toMatchObject({
      operation: 'restore',
      id: 1,
      analysisKey: 'page-1',
      reuseAnalysis: true,
    });
    worker.emit({
      id: 1,
      kind: 'success',
      result: {
        route: 'local',
        stages: [],
        classifierModel: 'classifier@test',
        provider: 'browser-ort',
        warnings: [],
      },
    });

    await expect(operation).resolves.toMatchObject({ route: 'local' });
  });

  it('classifies an unfiltered rough crop transferred from the render worker', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const client = createLocalRestorationClient();
    const worker = FakeWorker.latest;
    if (worker === null) throw new Error('Worker was not created.');
    if (client.analyze === undefined) throw new Error('Analysis is unavailable.');
    const pixels = new Uint8ClampedArray(720 * 512 * 4);
    const source = {
      kind: 'rgba-frame' as const,
      dimensions: { width: 720, height: 512 },
      pixels,
    };

    const operation = client.analyze(source, new AbortController().signal, {
      analysisKey: 'page-1',
    });

    expect(worker.posted[0]).toEqual({
      operation: 'analyze',
      id: 1,
      source,
      analysisKey: 'page-1',
    });
    expect(worker.transfers[0]).toEqual([pixels.buffer]);
    worker.emit({
      id: 1,
      kind: 'success',
      result: {
        kind: 'analysis',
        stages: ['deshadow', 'appearance'],
        classifierModel: 'classifier@test',
        warnings: [],
        protectColor: false,
      },
    });

    await expect(operation).resolves.toMatchObject({
      kind: 'analysis',
      stages: ['deshadow', 'appearance'],
    });
  });

  it('cancels the worker job without exposing the abort reason', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const client = createLocalRestorationClient();
    const worker = FakeWorker.latest;
    if (worker === null) throw new Error('Worker was not created.');
    const controller = new AbortController();
    const operation = client.restore(new Blob(['scan'], { type: 'image/jpeg' }), controller.signal);

    controller.abort('private page data');

    await expect(operation).rejects.toMatchObject({
      name: 'AbortError',
      message: 'Local restoration cancelled.',
    });
    expect(worker.posted.at(-1)).toEqual({ operation: 'cancel', id: 1 });
  });

  it('transfers rendered RGBA pixels to restoration without a Blob decode round trip', () => {
    vi.stubGlobal('Worker', FakeWorker);
    const client = createLocalRestorationClient();
    const worker = FakeWorker.latest;
    if (worker === null) throw new Error('Worker was not created.');
    const pixels = new Uint8ClampedArray(4 * 3 * 2);

    void client.restore(
      { kind: 'rgba-frame', dimensions: { width: 3, height: 2 }, pixels },
      new AbortController().signal,
    );

    expect(worker.posted[0]).toMatchObject({
      operation: 'restore',
      source: { kind: 'rgba-frame', dimensions: { width: 3, height: 2 } },
    });
    expect(worker.transfers[0]).toEqual([pixels.buffer]);
  });

  it('removes abort listeners when the worker fails all pending jobs', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const client = createLocalRestorationClient();
    const worker = FakeWorker.latest;
    if (worker === null) throw new Error('Worker was not created.');
    const controller = new AbortController();
    const removeEventListener = vi.spyOn(controller.signal, 'removeEventListener');
    const operation = client.restore(new Blob(['scan'], { type: 'image/jpeg' }), controller.signal);

    worker.emitWorkerError();

    await expect(operation).rejects.toThrow('Local restoration worker failed.');
    expect(removeEventListener).toHaveBeenCalledWith('abort', expect.any(Function));
    const postedBeforeAbort = worker.posted.length;
    controller.abort();
    expect(worker.posted).toHaveLength(postedBeforeAbort);
  });
});
