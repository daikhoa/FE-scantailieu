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
  it('initializes once, samples bounded preview frames and publishes a stable quad', async () => {
    const engine = engineFixture();
    const fixture = frames();
    const onResult = vi.fn();
    const session = startLiveDetectionSession({
      engine: engine.scanner,
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
      engine: engine.scanner,
      source: fixture.source,
      video: {} as HTMLVideoElement,
      onResult: vi.fn(),
      onError,
    });

    await vi.advanceTimersByTimeAsync(0);

    expect(onError).toHaveBeenCalledWith({ code: 'failed' });
    await session.stop();
    expect(fixture.dispose).toHaveBeenCalledOnce();
    expect(engine.dispose).toHaveBeenCalledOnce();
  });
});
