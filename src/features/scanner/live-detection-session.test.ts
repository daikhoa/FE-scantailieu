import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ScannerEngine, ScannerFrame } from '../../imaging/contracts/scanner-engine';
import type { VideoFrameSource } from './video-frame-source';
import { startLiveDetectionSession } from './live-detection-session';

function engineFixture() {
  const initialize = vi.fn<ScannerEngine['initialize']>(() => Promise.resolve());
  const detect = vi.fn<ScannerEngine['detect']>((frame) =>
    Promise.resolve({
      kind: 'document',
      dimensions: frame.dimensions,
      confidence: 0.9,
      corners: [
        { x: 10, y: 10 },
        { x: 90, y: 10 },
        { x: 90, y: 90 },
        { x: 10, y: 90 },
      ],
    }),
  );
  const dispose = vi.fn<ScannerEngine['dispose']>(() => Promise.resolve());
  const scanner: ScannerEngine = {
    lifecycle: { kind: 'uninitialized' },
    initialize,
    detect,
    render: vi.fn(() => Promise.reject(new Error('not used'))),
    dispose,
  };
  return { scanner, initialize, detect, dispose };
}

function frames() {
  const close = vi.fn();
  const capture = vi.fn(
    () => ({ dimensions: { width: 100, height: 100 }, close }) satisfies ScannerFrame,
  );
  const dispose = vi.fn();
  const source: VideoFrameSource = {
    capture,
    dispose,
  };
  return { source, close, capture, dispose };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('live Scanic detection session', () => {
  it('does not read and discard camera pixels while inference is busy', async () => {
    const engine = engineFixture();
    let finish: (() => void) | undefined;
    engine.detect.mockImplementation(
      (frame) =>
        new Promise((resolve) => {
          finish = () => {
            resolve({ kind: 'full-frame', dimensions: frame.dimensions, reason: 'no-document' });
          };
        }),
    );
    const fixture = frames();
    const session = startLiveDetectionSession({
      engineFactory: () => engine.scanner,
      source: fixture.source,
      video: {} as HTMLVideoElement,
      onResult: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(fixture.capture).toHaveBeenCalledOnce();
    finish?.();
    await vi.advanceTimersByTimeAsync(125);
    expect(fixture.capture).toHaveBeenCalledTimes(2);
    finish?.();
    await session.stop();
  });

  it('initializes once, samples bounded preview frames and publishes a stable quad', async () => {
    const engine = engineFixture();
    const fixture = frames();
    const onResult = vi.fn();
    const session = startLiveDetectionSession({
      engineFactory: () => engine.scanner,
      source: fixture.source,
      video: {} as HTMLVideoElement,
      onResult,
      stableFrames: 1,
      intervalMs: 125,
    });

    await vi.advanceTimersByTimeAsync(0);

    expect(engine.initialize).toHaveBeenCalledOnce();
    expect(fixture.capture).toHaveBeenCalledOnce();
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ kind: 'document' }));
    expect(fixture.close).toHaveBeenCalledOnce();

    await session.stop();
    expect(fixture.dispose).toHaveBeenCalledOnce();
    expect(engine.dispose).toHaveBeenCalledOnce();
  });

  it('sanitizes engine startup failure and still disposes every owned resource', async () => {
    const engine = engineFixture();
    engine.initialize.mockRejectedValueOnce(new Error('private wasm details'));
    const fixture = frames();
    const onError = vi.fn();
    const session = startLiveDetectionSession({
      engineFactory: () => engine.scanner,
      source: fixture.source,
      video: {} as HTMLVideoElement,
      onResult: vi.fn(),
      onError,
    });

    await vi.advanceTimersByTimeAsync(0);

    expect(onError).toHaveBeenCalledWith({ code: 'failed' });
    await session.stop();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(engine.initialize).toHaveBeenCalledOnce();
    expect(fixture.dispose).toHaveBeenCalledOnce();
    expect(engine.dispose).toHaveBeenCalledOnce();
  });

  it('replaces a failed engine and resumes live detection after a bounded delay', async () => {
    const failed = engineFixture();
    failed.detect.mockRejectedValueOnce(new Error('transient worker failure'));
    const recovered = engineFixture();
    const engineFactory = vi
      .fn<() => ScannerEngine>()
      .mockReturnValueOnce(failed.scanner)
      .mockReturnValueOnce(recovered.scanner);
    const fixture = frames();
    const onResult = vi.fn();
    const onError = vi.fn();
    const session = startLiveDetectionSession({
      engineFactory,
      source: fixture.source,
      video: {} as HTMLVideoElement,
      onResult,
      onError,
      stableFrames: 1,
      intervalMs: 10,
      retryDelayMs: 50,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledWith({ code: 'failed' });
    expect(failed.dispose).toHaveBeenCalledOnce();
    expect(engineFactory).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(49);
    expect(engineFactory).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(11);
    expect(engineFactory).toHaveBeenCalledTimes(2);
    expect(recovered.initialize).toHaveBeenCalledOnce();
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ kind: 'document' }));

    await session.stop();
    expect(recovered.dispose).toHaveBeenCalledOnce();
    expect(fixture.dispose).toHaveBeenCalledOnce();
  });

  it('force-disposes an engine when stopped during initialization', async () => {
    const engine = engineFixture();
    let rejectInitialization: ((error: Error) => void) | undefined;
    engine.initialize.mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectInitialization = reject;
        }),
    );
    engine.dispose.mockImplementation(() => {
      const error = new Error('cancelled');
      error.name = 'AbortError';
      rejectInitialization?.(error);
      return Promise.resolve();
    });
    const fixture = frames();
    const session = startLiveDetectionSession({
      engineFactory: () => engine.scanner,
      source: fixture.source,
      video: {} as HTMLVideoElement,
      onResult: vi.fn(),
    });

    await vi.advanceTimersByTimeAsync(0);
    const stopping = session.stop();
    await vi.advanceTimersByTimeAsync(0);
    const disposedBeforeManualRelease = engine.dispose.mock.calls.length === 1;
    if (!disposedBeforeManualRelease) {
      const error = new Error('test cleanup');
      error.name = 'AbortError';
      rejectInitialization?.(error);
    }
    await stopping;

    expect(disposedBeforeManualRelease).toBe(true);
    expect(engine.dispose).toHaveBeenCalledOnce();
    expect(fixture.dispose).toHaveBeenCalledOnce();
  });

  it('does not create a replacement when failed-engine cleanup is unsuccessful', async () => {
    const failed = engineFixture();
    failed.detect.mockRejectedValueOnce(new Error('transient worker failure'));
    failed.dispose.mockRejectedValueOnce(new Error('worker did not terminate'));
    const replacement = engineFixture();
    const engineFactory = vi
      .fn<() => ScannerEngine>()
      .mockReturnValueOnce(failed.scanner)
      .mockReturnValue(replacement.scanner);
    const fixture = frames();
    const session = startLiveDetectionSession({
      engineFactory,
      source: fixture.source,
      video: {} as HTMLVideoElement,
      onResult: vi.fn(),
      onError: vi.fn(),
      stableFrames: 1,
      intervalMs: 10,
      retryDelayMs: 50,
    });

    await vi.advanceTimersByTimeAsync(100);
    const factoryCallsBeforeStop = engineFactory.mock.calls.length;
    const stopped = session.stop();

    expect(factoryCallsBeforeStop).toBe(1);
    expect(replacement.initialize).not.toHaveBeenCalled();
    await expect(stopped).rejects.toThrow('Live detection cleanup failed.');
    expect(fixture.dispose).toHaveBeenCalledOnce();
  });

  it('rejects invalid scheduler configuration before creating an engine', async () => {
    const engineFactory = vi.fn(() => engineFixture().scanner);
    const fixture = frames();
    let session: ReturnType<typeof startLiveDetectionSession> | undefined;
    let failure: unknown;
    try {
      session = startLiveDetectionSession({
        engineFactory,
        source: fixture.source,
        video: {} as HTMLVideoElement,
        onResult: vi.fn(),
        intervalMs: -1,
      });
    } catch (error) {
      failure = error;
    }
    await vi.advanceTimersByTimeAsync(0);
    await session?.stop();

    expect(failure).toBeInstanceOf(RangeError);
    expect(engineFactory).not.toHaveBeenCalled();
  });

  it('stops automatic bootstrap retries after three consecutive failures', async () => {
    const fixture = frames();
    const engineFactory = vi.fn(() => {
      const engine = engineFixture();
      engine.initialize.mockRejectedValue(new Error('bootstrap failed'));
      return engine.scanner;
    });
    const session = startLiveDetectionSession({
      engineFactory,
      source: fixture.source,
      video: {} as HTMLVideoElement,
      onResult: vi.fn(),
      onError: vi.fn(),
      retryDelayMs: 50,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(engineFactory).toHaveBeenCalledTimes(3);
    expect(fixture.capture).not.toHaveBeenCalled();
    await session.stop();
    expect(fixture.dispose).toHaveBeenCalledOnce();
  });

  it('still recovers when an error observer throws', async () => {
    const failed = engineFixture();
    failed.detect.mockRejectedValueOnce(new Error('transient worker failure'));
    const recovered = engineFixture();
    const engineFactory = vi
      .fn<() => ScannerEngine>()
      .mockReturnValueOnce(failed.scanner)
      .mockReturnValueOnce(recovered.scanner);
    const fixture = frames();
    const onResult = vi.fn();
    const session = startLiveDetectionSession({
      engineFactory,
      source: fixture.source,
      video: {} as HTMLVideoElement,
      onResult,
      onError: () => {
        throw new Error('observer failure');
      },
      stableFrames: 1,
      intervalMs: 10,
      retryDelayMs: 50,
    });

    await vi.advanceTimersByTimeAsync(60);

    expect(engineFactory).toHaveBeenCalledTimes(2);
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ kind: 'document' }));
    await session.stop();
  });
});
