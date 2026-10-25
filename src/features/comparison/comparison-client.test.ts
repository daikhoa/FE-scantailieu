import { describe, expect, it, vi } from 'vitest';
import { runComparison } from './comparison-client';
import { median, validateComparisonInput, type ComparisonInput } from './comparison-contract';

const input: ComparisonInput = {
  asset: {
    blob: new Blob(['image'], { type: 'image/png' }),
    dimensions: { width: 10, height: 10 },
  },
  corners: [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ],
  filter: 'enhanced-color',
  repetitions: 1,
};
function fakeWorker() {
  const terminate = vi.fn();
  const worker = {
    postMessage: vi.fn(),
    terminate,
    onmessage: null,
    onerror: null,
    onmessageerror: null,
  } as unknown as Worker;
  return { worker, terminate };
}
describe('comparison measurement contract', () => {
  it('bounds repeated work and rejects oversized input without downsampling', () => {
    expect(() => {
      validateComparisonInput(input);
    }).not.toThrow();
    expect(() => {
      validateComparisonInput({ ...input, repetitions: 21 });
    }).toThrow();
    expect(() => {
      validateComparisonInput({
        ...input,
        asset: { ...input.asset, dimensions: { width: 9000, height: 9000 } },
      });
    }).toThrow();
  });
  it('reports unavailable median honestly and never mutates samples', () => {
    expect(median([])).toBeNull();
    const samples = [5, 1, 9, 3];
    expect(median(samples)).toBe(4);
    expect(samples).toEqual([5, 1, 9, 3]);
  });
  it('rejects an unknown OpenCV preset before creating a worker', async () => {
    const factory = vi.fn(() => fakeWorker().worker);
    await expect(
      runComparison(
        'opencv',
        { ...input, opencvPreset: 'unknown' as never },
        new AbortController().signal,
        vi.fn(),
        factory,
      ),
    ).rejects.toThrow('invalid-input');
    expect(factory).not.toHaveBeenCalled();
  });
  it('records OpenCV implementation and the actual preset in results', async () => {
    const { worker, terminate } = fakeWorker();
    const result = runComparison(
      'opencv',
      { ...input, opencvPreset: 'text' },
      new AbortController().signal,
      vi.fn(),
      () => worker,
    );
    worker.onmessage?.(new MessageEvent('message', { data: { type: 'ready' } }));
    worker.onmessage?.(new MessageEvent('message', { data: { type: 'sample', sample: {} } }));
    worker.onmessage?.(new MessageEvent('message', { data: { type: 'done', image: input.asset } }));
    await expect(result).resolves.toMatchObject({
      engine: 'opencv',
      implementation: 'opencv-adaptive-v2-wasm-v3',
      opencvPreset: 'text',
      filter: 'enhanced-color',
    });
    expect(terminate).toHaveBeenCalledOnce();
  });
  it('accepts a real 48 MP sensor size without silently resizing it', () => {
    expect(() => {
      validateComparisonInput({
        ...input,
        asset: { ...input.asset, dimensions: { width: 8064, height: 6048 } },
      });
    }).not.toThrow();
  });
  it('returns all measurements only after a successful worker completion', async () => {
    const { worker, terminate } = fakeWorker();
    const progress = vi.fn();
    const result = runComparison(
      'cpp',
      input,
      new AbortController().signal,
      progress,
      () => worker,
    );
    const sample = {
      decodeMs: 1,
      processMs: 2,
      encodeMs: 3,
      totalMs: 6,
      inputPixelBytes: 400,
      outputPixelBytes: 400,
      wasmReservedBytes: 16777216,
    };
    worker.onmessage?.(new MessageEvent('message', { data: { type: 'ready' } }));
    worker.onmessage?.(new MessageEvent('message', { data: { type: 'sample', sample } }));
    worker.onmessage?.(new MessageEvent('message', { data: { type: 'done', image: input.asset } }));
    await expect(result).resolves.toMatchObject({
      engine: 'cpp',
      samples: [sample],
      image: input.asset,
    });
    expect(progress).toHaveBeenCalledWith(1);
    expect(terminate).toHaveBeenCalledOnce();
  });
  it('cancels and terminates its worker, without returning a fallback result', async () => {
    const { worker, terminate } = fakeWorker();
    const controller = new AbortController();
    const result = runComparison('cpp', input, controller.signal, vi.fn(), () => worker);
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(terminate).toHaveBeenCalledOnce();
  });
  it('does not start an already cancelled operation', async () => {
    const factory = vi.fn(() => fakeWorker().worker);
    const controller = new AbortController();
    controller.abort();
    await expect(
      runComparison('cpp', input, controller.signal, vi.fn(), factory),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(factory).not.toHaveBeenCalled();
  });
  it('fails explicitly on a worker error and releases resources', async () => {
    const { worker, terminate } = fakeWorker();
    const result = runComparison('cpp', input, new AbortController().signal, vi.fn(), () => worker);
    worker.onerror?.(new Event('error') as ErrorEvent);
    await expect(result).rejects.toThrow('unavailable');
    expect(terminate).toHaveBeenCalledOnce();
  });
  it('only finishes with the promised sample count', async () => {
    const { worker } = fakeWorker();
    const result = runComparison('web', input, new AbortController().signal, vi.fn(), () => worker);
    worker.onmessage?.(new MessageEvent('message', { data: { type: 'ready' } }));
    worker.onmessage?.(new MessageEvent('message', { data: { type: 'done', image: input.asset } }));
    await expect(result).rejects.toThrow('failed');
  });
});
