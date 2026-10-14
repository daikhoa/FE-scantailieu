import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DocumentCorners, ImageDimensions } from '../../domain/document';
import type { DetectionResult, ScannerFrame } from '../../imaging/contracts/scanner-engine';
import {
  createDetectionScheduler,
  createDetectionSmoother,
  type DetectionEngine,
} from './detection-scheduler';

function deferred<T>() {
  let resolve: ((value: T) => void) | undefined;
  let reject: ((reason?: unknown) => void) | undefined;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return {
    promise,
    resolve(value: T) {
      if (resolve === undefined) throw new Error('Deferred was not initialized.');
      resolve(value);
    },
    reject(reason?: unknown) {
      if (reject === undefined) throw new Error('Deferred was not initialized.');
      reject(reason);
    },
  };
}

function frame(id: number, dimensions: ImageDimensions = { width: 1000, height: 1400 }) {
  const close = vi.fn();
  return {
    value: { id, dimensions, close } as ScannerFrame & { readonly id: number },
    close,
  };
}

function fullFrame(
  reason: 'no-document' | 'low-confidence' = 'no-document',
  dimensions: ImageDimensions = { width: 1000, height: 1400 },
): DetectionResult {
  return { kind: 'full-frame', dimensions, reason };
}

const BASE_CORNERS: DocumentCorners = [
  { x: 100, y: 120 },
  { x: 900, y: 130 },
  { x: 880, y: 1280 },
  { x: 120, y: 1270 },
];

function documentResult(
  offset = 0,
  dimensions: ImageDimensions = { width: 1000, height: 1400 },
): DetectionResult {
  return {
    kind: 'document',
    dimensions,
    confidence: 0.9,
    corners: BASE_CORNERS.map(({ x, y }) => ({
      x: x + offset,
      y: y + offset,
    })) as unknown as DocumentCorners,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('detection scheduler', () => {
  it('rejects a zero-delay interval that could create a hot capture loop', () => {
    expect(() =>
      createDetectionScheduler({
        engine: { detect: vi.fn() },
        onResult: vi.fn(),
        intervalMs: 0,
      }),
    ).toThrow(RangeError);
  });

  it('runs one detection at a time, replaces stale pending frames and rate limits starts', async () => {
    const first = deferred<DetectionResult>();
    const second = deferred<DetectionResult>();
    const detect = vi
      .fn<DetectionEngine['detect']>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const onResult = vi.fn();
    const scheduler = createDetectionScheduler({
      engine: { detect },
      intervalMs: 125,
      onResult,
    });
    const firstFrame = frame(1);
    const staleFrame = frame(2);
    const newestFrame = frame(3);

    scheduler.submit(firstFrame.value);
    scheduler.submit(staleFrame.value);
    scheduler.submit(newestFrame.value);

    expect(detect).toHaveBeenCalledTimes(1);
    expect(detect.mock.calls[0]?.[0]).toBe(firstFrame.value);
    expect(staleFrame.close).toHaveBeenCalledOnce();
    expect(newestFrame.close).not.toHaveBeenCalled();

    first.resolve(fullFrame());
    vi.runAllTicks();
    await Promise.resolve();

    expect(firstFrame.close).toHaveBeenCalledOnce();
    expect(onResult).toHaveBeenCalledWith(fullFrame());
    expect(detect).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(124);
    expect(detect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(detect).toHaveBeenCalledTimes(2);
    expect(detect.mock.calls[1]?.[0]).toBe(newestFrame.value);

    second.resolve(fullFrame('low-confidence'));
    vi.runAllTicks();
    await Promise.resolve();
    expect(newestFrame.close).toHaveBeenCalledOnce();
    expect(onResult).toHaveBeenLastCalledWith(fullFrame('low-confidence'));

    await scheduler.dispose();
  });

  it('aborts active work, closes pending and active frames, and suppresses cancellation errors', async () => {
    let activeSignal: AbortSignal | undefined;
    const detect = vi.fn<DetectionEngine['detect']>((_frame, signal) => {
      activeSignal = signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            const error = new Error('private abort reason');
            error.name = 'AbortError';
            reject(error);
          },
          { once: true },
        );
      });
    });
    const onError = vi.fn();
    const scheduler = createDetectionScheduler({ engine: { detect }, onResult: vi.fn(), onError });
    const active = frame(1);
    const pending = frame(2);

    scheduler.submit(active.value);
    scheduler.submit(pending.value);
    const disposal = scheduler.dispose();

    expect(activeSignal?.aborted).toBe(true);
    expect(pending.close).toHaveBeenCalledOnce();
    await disposal;
    expect(active.close).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  });

  it('closes failed frames and exposes only a safe failure code', async () => {
    const detect = vi.fn<DetectionEngine['detect']>(() =>
      Promise.reject(new Error('private engine stack and document path')),
    );
    const onError = vi.fn();
    const scheduler = createDetectionScheduler({ engine: { detect }, onResult: vi.fn(), onError });
    const failed = frame(1);

    scheduler.submit(failed.value);
    vi.runAllTicks();
    await Promise.resolve();

    expect(failed.close).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith({ code: 'failed' });
    await scheduler.dispose();
  });

  it('rejects frames submitted after disposal without retaining them', async () => {
    const detect = vi.fn<DetectionEngine['detect']>();
    const scheduler = createDetectionScheduler({ engine: { detect }, onResult: vi.fn() });
    await scheduler.dispose();
    const late = frame(1);

    scheduler.submit(late.value);

    expect(late.close).toHaveBeenCalledOnce();
    expect(detect).not.toHaveBeenCalled();
  });
});

describe('detection smoothing', () => {
  it('keeps the full frame until three similar document detections are stable', () => {
    const smoother = createDetectionSmoother({
      stableFrames: 3,
      maxCornerDriftRatio: 0.03,
      smoothingAlpha: 0.5,
    });

    expect(smoother.update(documentResult(0))).toMatchObject({
      kind: 'full-frame',
      reason: 'unstable-document',
    });
    expect(smoother.update(documentResult(4))).toMatchObject({
      kind: 'full-frame',
      reason: 'unstable-document',
    });
    const stable = smoother.update(documentResult(8));

    expect(stable.kind).toBe('document');
    if (stable.kind === 'document') {
      expect(stable.corners[0]).toEqual({ x: 105, y: 125 });
      expect(stable.confidence).toBeCloseTo(0.9);
    }
  });

  it('immediately returns to full-frame when a stable document jumps or disappears', () => {
    const smoother = createDetectionSmoother({ stableFrames: 2, maxCornerDriftRatio: 0.02 });
    smoother.update(documentResult(0));
    expect(smoother.update(documentResult(2)).kind).toBe('document');

    expect(smoother.update(documentResult(200))).toMatchObject({
      kind: 'full-frame',
      reason: 'unstable-document',
    });
    expect(smoother.update(fullFrame('low-confidence'))).toEqual(fullFrame('low-confidence'));
    expect(smoother.update(documentResult(0))).toMatchObject({
      kind: 'full-frame',
      reason: 'unstable-document',
    });
  });

  it('resets stability when frame dimensions change', () => {
    const smoother = createDetectionSmoother({ stableFrames: 2 });
    smoother.update(documentResult());
    const rotated = documentResult(0, { width: 1400, height: 1000 });

    expect(smoother.update(rotated)).toMatchObject({
      kind: 'full-frame',
      dimensions: { width: 1400, height: 1000 },
      reason: 'unstable-document',
    });
  });
});
